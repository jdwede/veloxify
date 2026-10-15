//! Turning recorded segments into the final clip with FFmpeg: trim the settle lead-in, join
//! segments with cuts or crossfades, align and loudness-normalise CS2's audio, hide Steam's FPS
//! counter, and encode on the GPU. Also thumbnails.

use crate::profile::{Audio, Output};
use anyhow::{bail, Context, Result};
use std::path::Path;
use std::process::Command;

/// Seconds recorded before each segment so the game settles after seeking; trimmed off.
pub const SETTLE_S: f64 = 1.0;
/// Steam's in-game FPS counter box (green text on black) at 1080p.
const FPS_BOX: (u32, u32) = (56, 15);

pub struct Part {
    pub video: String,
    pub seconds: f64,
    pub audio: Option<String>,
    pub audio_offset_s: f64,
}

static FFMPEG: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

/// Uses this ffmpeg (the copy installed with Veloxify) instead of one on PATH.
pub fn use_ffmpeg(path: std::path::PathBuf) {
    let _ = FFMPEG.set(path);
}

fn ffmpeg_exe() -> std::ffi::OsString {
    FFMPEG.get().map(|p| p.as_os_str().to_owned()).unwrap_or_else(|| "ffmpeg".into())
}

fn ffmpeg() -> Command {
    let mut c = Command::new(ffmpeg_exe());
    c.args(["-hide_banner", "-loglevel", "error", "-y"]);
    hide_console(&mut c);
    c
}

/// A lineup video with more of it frozen than this is thrown away: CS2 stopped drawing (see
/// [`frozen_share`]). Its camera mostly moves, but a smoke that has finished blooming holds still
/// for the last seconds (about 27%).
pub const FROZEN_MAX: f64 = 0.45;
// A slideshow measures 90% and up; an AWP holding an angle for a few seconds can reach 58%.
pub const FROZEN_MAX_CLIP: f64 = 0.6;

/// A recording came out frozen (CS2 stopped drawing): `.0` is the frozen share.
#[derive(Debug)]
pub struct Frozen(pub f64);
impl std::fmt::Display for Frozen {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "CS2 stopped drawing while it was recorded ({:.0}% frozen)", self.0 * 100.0)
    }
}
impl std::error::Error for Frozen {}

/// How much of a video is frozen (the picture not changing for half a second or more), 0 to 1: CS2
/// stops drawing when the screen goes to sleep, and the recording then repeats one frame. `None`
/// if ffmpeg couldn't read it.
pub fn frozen_share(video: &Path) -> Option<f64> {
    frozen_share_with(video, 2.0)
}

/// [`frozen_share`], with one still stretch counting only from `still_s` seconds: a flashbang
/// whites the picture out for a couple of seconds where it pops, which is still footage of it.
pub fn frozen_share_with(video: &Path, still_s: f64) -> Option<f64> {
    let mut c = Command::new(ffmpeg_exe());
    c.args(["-hide_banner", "-nostats", "-threads", "2", "-i"]).arg(video);
    c.args(["-vf", "scale=320:-2,freezedetect=n=-50dB:d=0.5", "-an", "-f", "null", "-"]);
    hide_console(&mut c);
    let out = c.output().ok()?;
    let log = String::from_utf8_lossy(&out.stderr);
    let secs = |s: &str| -> Option<f64> {
        let mut t = 0.0;
        for part in s.split(':') {
            t = t * 60.0 + part.trim().parse::<f64>().ok()?;
        }
        Some(t)
    };
    let total = log.lines().find_map(|l| l.trim().strip_prefix("Duration: ")).and_then(|d| secs(d.split(',').next()?))?;
    let value = |key: &str| -> Vec<f64> { log.lines().filter_map(|l| l.split(key).nth(1)).filter_map(|v| v.trim().parse().ok()).collect() };
    let (starts, ends) = (value("freeze_start:"), value("freeze_end:"));
    let spans: Vec<(f64, f64)> = starts.iter().enumerate().map(|(i, &s)| (s, ends.get(i).copied().unwrap_or(total))).collect();
    (total > 0.0).then(|| (counted_freeze(&spans, still_s) / total).clamp(0.0, 1.0))
}

/// Of the still stretches (half a second or more each) in a recording, the time that means CS2
/// wasn't drawing: a picture stuck for 2 seconds or more, or a slideshow (still stretches back to
/// back, the picture changing about once a second). One still moment between moving ones (a
/// scoped AWP holding an angle) doesn't count.
pub fn counted_freeze(spans: &[(f64, f64)], still_s: f64) -> f64 {
    let close = |a: f64, b: f64| b - a <= 0.25;
    spans
        .iter()
        .enumerate()
        .filter(|&(i, &(s, e))| {
            e - s >= still_s || (i > 0 && close(spans[i - 1].1, s)) || spans.get(i + 1).is_some_and(|n| close(e, n.0))
        })
        .map(|(_, &(s, e))| e - s)
        .sum()
}

#[cfg(test)]
mod freeze_tests {
    use super::counted_freeze;

    #[test]
    fn slideshow_counts_and_one_still_moment_does_not() {
        // A frame a second: still stretches back to back.
        let slideshow: Vec<(f64, f64)> = (0..5).map(|i| (i as f64 * 1.2 + 0.05, i as f64 * 1.2 + 1.2)).collect();
        assert!(counted_freeze(&slideshow, 2.0) > 5.0);
        // An AWP held still for 1.6 s between moving parts.
        assert_eq!(counted_freeze(&[(1.0, 2.6)], 2.0), 0.0);
        // Stuck for good.
        assert_eq!(counted_freeze(&[(0.5, 4.0)], 2.0), 3.5);
        // A flash whiting the picture out for 2.5 s is fine for a flash lineup.
        assert_eq!(counted_freeze(&[(3.0, 5.5)], 4.0), 0.0);
    }
}

#[cfg(windows)]
fn hide_console(c: &mut Command) {
    use std::os::windows::process::CommandExt;
    c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
}

fn run(mut c: Command) -> Result<Vec<u8>> {
    let out = c.output().context("running ffmpeg (is it installed and on PATH?)")?;
    if !out.status.success() {
        bail!("ffmpeg failed: {}", String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(out.stdout)
}

/// Which corner ("tl", "tr", "bl", "br") holds Steam's FPS counter, if any.
pub fn detect_fps_counter(video: &str, width: u32, height: u32) -> Option<&'static str> {
    let (bw, bh) = FPS_BOX;
    let corners = [("tl", 0, 0), ("tr", width - bw, 0), ("bl", 0, height - bh), ("br", width - bw, height - bh)];
    let mut best = (None, 0usize);
    for (name, x, y) in corners {
        let mut c = ffmpeg();
        c.args(["-ss", "0.5", "-i", video, "-frames:v", "1", "-vf", &format!("crop={bw}:{bh}:{x}:{y}")]);
        c.args(["-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
        let Ok(raw) = run(c) else { continue };
        let green = raw
            .chunks_exact(3)
            .filter(|p| p[1] > 150 && p[1] as i32 > p[0] as i32 + 60 && p[1] as i32 > p[2] as i32 + 60)
            .count();
        if green > best.1 {
            best = (Some(name), green);
        }
    }
    if best.1 >= 12 {
        best.0
    } else {
        None
    }
}

/// Covers the counter with a mirrored copy of the strip next to it (in RGB to avoid chroma
/// artifacts), which continues the surrounding image seamlessly at this size.
fn fps_mask(corner: &str, width: u32, height: u32) -> String {
    let (bw, bh) = FPS_BOX;
    let x = if corner.ends_with('l') { 0 } else { width - bw };
    let (src_y, dst_y) = if corner.starts_with('t') { (bh, 0) } else { (height - 2 * bh, height - bh) };
    format!(
        "format=gbrp,split=2[fm_a][fm_b];[fm_b]crop={bw}:{bh}:{x}:{src_y},vflip[fm_p];[fm_a][fm_p]overlay={x}:{dst_y},format=yuv420p"
    )
}

pub fn assemble(parts: &[Part], out: &Path, o: &Output, audio: Option<&Audio>) -> Result<()> {
    let with_audio = audio.is_some() && parts.iter().all(|p| p.audio.is_some());
    let mut inputs: Vec<String> = vec![];
    let mut chains = vec![];
    let mut input = 0;
    let lengths: Vec<f64> = parts.iter().map(|p| p.seconds - SETTLE_S).collect();
    for (i, p) in parts.iter().enumerate() {
        let len = lengths[i];
        inputs.extend(["-i".to_string(), p.video.clone()]);
        chains.push(format!(
            "[{input}:v]trim=start={SETTLE_S}:duration={len:.3},setpts=PTS-STARTPTS,fps={},format=yuv420p[v{i}]",
            o.fps
        ));
        input += 1;
        if with_audio {
            inputs.extend(["-i".to_string(), p.audio.clone().unwrap()]);
            let start = SETTLE_S + p.audio_offset_s;
            chains.push(format!(
                "[{input}:a]atrim=start={start:.4}:duration={len:.3},asetpts=PTS-STARTPTS,apad=whole_dur={len:.3}[a{i}]"
            ));
            input += 1;
        }
    }
    let n = parts.len();
    let mut graph = chains.join(";");
    let (mut vlast, mut alast) = ("[v0]".to_string(), "[a0]".to_string());
    if n > 1 && o.transition == "fade" {
        let d = o.transition_seconds;
        let mut offset = 0.0;
        for i in 1..n {
            offset += lengths[i - 1] - d;
            graph += &format!(";{vlast}[v{i}]xfade=transition=fade:duration={d}:offset={offset:.3}[xv{i}]");
            vlast = format!("[xv{i}]");
            if with_audio {
                graph += &format!(";{alast}[a{i}]acrossfade=d={d}[xa{i}]");
                alast = format!("[xa{i}]");
            }
        }
    } else if n > 1 {
        let pads: String = (0..n).map(|i| if with_audio { format!("[v{i}][a{i}]") } else { format!("[v{i}]") }).collect();
        graph += &format!(";{pads}concat=n={n}:v=1:a={}", with_audio as u8);
        graph += if with_audio { "[cv][ca]" } else { "[cv]" };
        vlast = "[cv]".into();
        alast = "[ca]".into();
    }
    if o.hide_fps_counter {
        if let Some(corner) = detect_fps_counter(&parts[0].video, o.width, o.height) {
            graph += &format!(";{vlast}{}[vmask]", fps_mask(corner, o.width, o.height));
            vlast = "[vmask]".into();
        }
    }
    let mut maps = vec!["-map".to_string(), vlast];
    let mut audio_codec: Vec<String> = vec![];
    if let (true, Some(a)) = (with_audio, audio) {
        // loudnorm turns a short, silent stretch into NaN (it measures over 3 s), which the AAC
        // encoder refuses: those samples become silence.
        const NAN_GUARD: &str = "aeval=exprs='if(isnan(val(0))+isinf(val(0)),0,val(0))|if(isnan(val(1))+isinf(val(1)),0,val(1))':c=same";
        graph += &format!(";{alast}loudnorm=I={}:TP=-1.5:LRA=11,{NAN_GUARD},aresample=48000[aout]", a.loudness_lufs);
        maps.extend(["-map".into(), "[aout]".into()]);
        audio_codec.extend(["-c:a".into(), "aac".into(), "-b:a".into(), format!("{}k", a.bitrate_kbps)]);
    } else {
        audio_codec.push("-an".into());
    }
    let encode = |nvenc: bool| -> Result<()> {
        let mut codec: Vec<String> = if nvenc {
            // GPU encode: seconds per clip instead of ~20 s of CPU, quality-targeted and capped.
            ["-c:v", "h264_nvenc", "-preset", "p6", "-tune", "hq", "-rc", "vbr", "-cq"].map(String::from).to_vec()
        } else {
            ["-c:v", "libx264", "-preset", "slow", "-crf"].map(String::from).to_vec()
        };
        codec.push(o.final_crf.to_string());
        if nvenc {
            codec.extend(["-b:v".into(), "0".into(), "-maxrate".into(), format!("{}M", o.max_bitrate_mbps)]);
            codec.extend(["-bufsize".into(), format!("{}M", 2 * o.max_bitrate_mbps), "-spatial-aq".into(), "1".into()]);
        }
        codec.extend(["-profile:v".into(), "high".into()]);
        codec.extend(audio_codec.iter().cloned());
        let mut c = ffmpeg();
        c.args(&inputs).args(["-filter_complex", &graph]).args(&maps).args(&codec).args(["-movflags", "+faststart"]).arg(out);
        run(c).map(|_| ())
    };
    // NVENC needs an NVIDIA GPU: anything else gets the CPU encoder.
    match encode(o.final_encoder == "nvenc") {
        Err(e) if o.final_encoder == "nvenc" => encode(false).map_err(|e2| anyhow::anyhow!("{e2} (GPU encoder: {e})")),
        r => r,
    }
}

/// Preview frame for a clip: by default just before the first kill (clips have 4 s pre-roll).
pub fn make_thumb(clip: &Path, thumb: &Path) -> Result<()> {
    make_thumb_at(clip, thumb, 3.7)
}

/// A video's length (seconds) and picture size, from ffmpeg's own "Duration: 00:00:21.00" and
/// "1920x1080" lines (no ffprobe needed).
pub fn probe_size(video: &Path) -> Result<(f64, u32, u32)> {
    let mut c = Command::new(ffmpeg_exe());
    c.args(["-hide_banner", "-i"]).arg(video);
    hide_console(&mut c);
    let info = String::from_utf8_lossy(&c.output()?.stderr).into_owned();
    let dur: f64 = info
        .split("Duration: ")
        .nth(1)
        .and_then(|d| d.split(',').next())
        .map(|hms| hms.trim().split(':').filter_map(|x| x.parse::<f64>().ok()).fold(0.0, |acc, x| acc * 60.0 + x))
        .unwrap_or(0.0);
    let (width, height) = info
        .lines()
        .find(|l| l.contains("Video:"))
        .and_then(|l| l.split([' ', ',']).find_map(|w| w.split_once('x').and_then(|(a, b)| a.parse::<u32>().ok().zip(b.parse::<u32>().ok()))))
        .unwrap_or((1920, 1080));
    Ok((dur, width, height))
}

/// A video's length (seconds) and picture height.
pub fn probe(video: &Path) -> Result<(f64, u32)> {
    probe_size(video).map(|(d, _, h)| (d, h))
}

/// Preview frame `at` seconds into a clip (or just before its end).
pub fn make_thumb_at(clip: &Path, thumb: &Path, at: f64) -> Result<()> {
    let (dur, _) = probe(clip)?;
    let t = at.min(dur - 0.5).max(0.0);
    let mut c = ffmpeg();
    c.args(["-ss", &format!("{t:.2}"), "-i"]).arg(clip);
    c.args(["-frames:v", "1", "-vf", "scale=640:-2", "-q:v", "3"]).arg(thumb);
    run(c)?;
    Ok(())
}

/// A copy made to share: its size and picture height.
#[derive(Debug, Clone, Copy)]
pub struct ShareCopy {
    pub bytes: u64,
    pub height: u32,
}

/// A copy of a clip that fits under `limit_bytes` (Discord's upload limit), with the Veloxify mark
/// in the bottom-right corner: `logo` (an image) and "veloxify" in `font`, both optional. The
/// bitrate is what fits (the picture goes down to 720 or 540 lines when that's too little for full
/// size); the GPU encoder when there is one (seconds), else the CPU in two passes (to land on the
/// size). Tried again smaller if it still comes out too big.
pub fn share_copy(src: &Path, dst: &Path, limit_bytes: u64, logo: Option<&Path>, font: Option<&Path>, work: &Path) -> Result<ShareCopy> {
    let (dur, src_w, src_h) = probe_size(src)?;
    if dur <= 0.0 {
        bail!("couldn't read the clip's length");
    }
    // Clips filmed before the FPS counter was covered still have it: covered here.
    let fps_cover = detect_fps_counter(&src.display().to_string(), src_w, src_h).map(|c| fps_mask(c, src_w, src_h));
    std::fs::create_dir_all(work)?;
    let mut budget = 0.92;
    for _ in 0..3 {
        // Kilobits a second: everything that fits, less the sound.
        let total = (limit_bytes as f64 * 8.0 / 1000.0 * budget / dur).min(40_000.0);
        let audio = if total > 3000.0 { 128.0 } else { 96.0 };
        let video = (total - audio).max(500.0);
        let h = if video >= 5500.0 { src_h.min(1080) } else if video >= 2800.0 { src_h.min(720) } else { src_h.min(540) };
        let fps = if video < 1500.0 { Some(30) } else { None };
        // The mark: a black rounded badge in the bottom-left corner, the logo then "veloxify".
        let fs = (h as f64 * 0.034).round().max(14.0) as u32;
        let lh = (fs as f64 * 1.25).round() as u32;
        let (px, py, gap) = ((fs as f64 * 0.42).round() as u32, (fs as f64 * 0.28).round() as u32, (fs as f64 * 0.32).round() as u32);
        let m = (h as f64 * 0.025).round() as u32;
        let rate = fps.map(|f| format!(",fps={f}")).unwrap_or_default();
        let scaled = match &fps_cover {
            Some(cover) => format!("[0:v]{cover}[cv];[cv]scale=-2:{h}{rate}[bg]"),
            None => format!("[0:v]scale=-2:{h}{rate}[bg]"),
        };
        let mark = |with_text: bool| -> String {
            // "veloxify" in Segoe UI Bold is about 3.6 times the font size wide.
            let text = with_text && font.is_some();
            let logo_w = if logo.is_some() { lh } else { 0 };
            let text_w = if text { (if logo.is_some() { gap } else { 0 }) + (fs as f64 * 3.62).round() as u32 } else { 0 };
            let w = px + logo_w + text_w + px;
            let bh = lh + 2 * py;
            let r = (bh as f64 * 0.32).round() as u32;
            // Rounded corners: a pixel is inside when it's within r of the inner rectangle.
            let mut g = format!(
                "{scaled};color=c=black:s={w}x{bh},format=rgba,geq=r='0':g='0':b='0':a='if(lte(hypot(max(0,max({r}-X,X-({w}-1-{r}))),max(0,max({r}-Y,Y-({bh}-1-{r})))),{r}),245,0)'[box]"
            );
            let mut last = "[box]".to_string();
            if logo.is_some() {
                g += &format!(";[1:v]scale=-1:{lh}[lg];{last}[lg]overlay={px}:{py}[b1]");
                last = "[b1]".into();
            }
            if text {
                let ff = font.unwrap().display().to_string().replace('\\', "/").replace(':', "\\:");
                let x = px + if logo.is_some() { lh + gap } else { 0 };
                g += &format!(";{last}drawtext=fontfile='{ff}':text='veloxify':fontsize={fs}:fontcolor=white:x={x}:y=(h-th)/2[b2]");
                last = "[b2]".into();
            }
            g + &format!(";[bg]{last}overlay={m}:H-h-{m}:shortest=1[vout]")
        };
        let encode = |graph: &str, nvenc: bool| -> Result<()> {
            let input = |c: &mut Command| {
                c.arg("-i").arg(src);
                if let Some(l) = logo {
                    c.arg("-i").arg(l);
                }
                c.args(["-filter_complex", graph, "-map", "[vout]", "-map", "0:a?"]);
            };
            let vb = format!("{}k", video.round());
            if nvenc {
                let mut c = ffmpeg();
                input(&mut c);
                c.args(["-c:v", "h264_nvenc", "-preset", "p6", "-rc", "cbr", "-b:v", &vb, "-maxrate", &vb, "-bufsize", &vb]);
                c.args(["-c:a", "aac", "-b:a", &format!("{}k", audio), "-movflags", "+faststart"]).arg(dst);
                return run(c).map(|_| ());
            }
            let log = work.join("pass");
            let mut c = ffmpeg();
            input(&mut c);
            c.args(["-c:v", "libx264", "-preset", "medium", "-b:v", &vb, "-pass", "1", "-passlogfile"]).arg(&log).args(["-an", "-f", "null", "NUL"]);
            run(c)?;
            let mut c = ffmpeg();
            input(&mut c);
            c.args(["-c:v", "libx264", "-preset", "medium", "-b:v", &vb, "-pass", "2", "-passlogfile"]).arg(&log);
            c.args(["-c:a", "aac", "-b:a", &format!("{}k", audio), "-movflags", "+faststart"]).arg(dst);
            run(c).map(|_| ())
        };
        // The GPU first; without the text if this ffmpeg can't draw it.
        let (full, plain) = (mark(true), mark(false));
        let done = encode(&full, true).or_else(|_| encode(&full, false)).or_else(|_| encode(&plain, true)).or_else(|_| encode(&plain, false));
        done?;
        let bytes = std::fs::metadata(dst)?.len();
        if bytes <= limit_bytes {
            return Ok(ShareCopy { bytes, height: h });
        }
        budget *= 0.85 * limit_bytes as f64 / bytes as f64;
    }
    bail!("couldn't get the clip under the size limit")
}
