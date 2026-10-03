//! Records one window (by exact title) to an H.264 MP4 using Windows Graphics Capture, which
//! reads the window's own surface: other windows covering it don't end up in the recording.
//! Encoding goes through Media Foundation's hardware encoder (NVENC on NVIDIA GPUs).
//!
//! usage: cs2hl-capture <window title> <out.mp4> <seconds> [bitrate_mbps=20] [fps=60] [--audio-pid <pid>]
//!
//! Prints `CAPTURE_STARTED` on the first frame and `CAPTURE_DONE <frames>` when finished. With
//! `--audio-pid`, that process's audio is recorded to `<out>.wav` at the same time, and
//! `AUDIO_OFFSET <seconds>` reports how far the audio started ahead of the first video frame.

use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{bail, Context as _, Result};
use windows_capture::capture::{Context, GraphicsCaptureApiHandler};
use windows_capture::encoder::{
    AudioSettingsBuilder, ContainerSettingsBuilder, VideoEncoder, VideoSettingsBuilder, VideoSettingsSubType,
};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings, MinimumUpdateIntervalSettings,
    SecondaryWindowSettings, Settings,
};
use windows_capture::window::Window;

mod audio;

struct Job {
    out: String,
    seconds: f64,
    bitrate: u32,
    fps: u32,
    width: u32,
    height: u32,
    first_frame: Arc<Mutex<Option<Instant>>>,
}

struct Recorder {
    job: Job,
    encoder: Option<VideoEncoder>,
    started: Option<Instant>,
    frames: u64,
}

impl GraphicsCaptureApiHandler for Recorder {
    type Flags = Job;
    type Error = Box<dyn std::error::Error + Send + Sync>;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        let job = ctx.flags;
        let video = VideoSettingsBuilder::new(job.width, job.height)
            .sub_type(VideoSettingsSubType::H264)
            .bitrate(job.bitrate)
            .frame_rate(job.fps);
        let encoder = VideoEncoder::new(
            video,
            AudioSettingsBuilder::default().disabled(true),
            ContainerSettingsBuilder::default(),
            &job.out,
        )?;
        Ok(Self { job, encoder: Some(encoder), started: None, frames: 0 })
    }

    fn on_frame_arrived(&mut self, frame: &mut Frame, control: InternalCaptureControl) -> Result<(), Self::Error> {
        if frame.width() != self.job.width || frame.height() != self.job.height {
            return Err(format!(
                "window is {}x{}, expected {}x{}",
                frame.width(),
                frame.height(),
                self.job.width,
                self.job.height
            )
            .into());
        }
        let first_frame = self.job.first_frame.clone();
        let started = *self.started.get_or_insert_with(|| {
            let now = Instant::now();
            *first_frame.lock().unwrap() = Some(now);
            println!("CAPTURE_STARTED");
            let _ = std::io::stdout().flush();
            now
        });
        if let Some(enc) = self.encoder.as_mut() {
            enc.send_frame(frame)?;
            self.frames += 1;
        }
        if started.elapsed().as_secs_f64() >= self.job.seconds {
            if let Some(enc) = self.encoder.take() {
                enc.finish()?;
            }
            println!("CAPTURE_DONE {}", self.frames);
            control.stop();
        }
        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        if let Some(enc) = self.encoder.take() {
            enc.finish()?;
        }
        println!("CAPTURE_DONE {} (window closed)", self.frames);
        Ok(())
    }
}

fn main() -> Result<()> {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let audio_pid: Option<u32> = match args.iter().position(|a| a == "--audio-pid") {
        Some(i) => {
            let pid = args.get(i + 1).context("--audio-pid <pid>")?.parse()?;
            args.drain(i..i + 2);
            Some(pid)
        }
        None => None,
    };
    if args.first().map(String::as_str) == Some("audio") {
        return audio_cmd(&args[1..]);
    }
    if args.first().map(String::as_str) == Some("devices") {
        for (id, name) in audio::output_devices()? {
            println!("{id}	{name}");
        }
        return Ok(());
    }
    if args.first().map(String::as_str) == Some("where") {
        let pid: u32 = args.get(1).context("where <pid>")?.parse()?;
        for (d, peak) in audio::process_devices(pid, 1500)? {
            println!("{peak:.3}  {d}");
        }
        return Ok(());
    }
    if args.first().map(String::as_str) == Some("mute") {
        let pid: u32 = args.get(1).context("mute <pid> <on|off>")?.parse()?;
        let on = args.get(2).map(String::as_str) != Some("off");
        println!("sessions changed: {}", audio::set_process_mute(pid, on)?);
        return Ok(());
    }
    if args.len() < 3 {
        bail!("usage: cs2hl-capture <window title> <out.mp4> <seconds> [bitrate_mbps=20] [fps=60]");
    }
    let window = Window::from_name(&args[0]).with_context(|| format!("no window titled {:?}", args[0]))?;
    let rect = window.rect().context("window rect")?;
    let fps: u32 = args.get(4).map(|s| s.parse()).transpose()?.unwrap_or(60);
    let job = Job {
        out: args[1].clone(),
        seconds: args[2].parse()?,
        bitrate: args.get(3).map(|s| s.parse::<u32>()).transpose()?.unwrap_or(20) * 1_000_000,
        fps,
        width: (rect.right - rect.left) as u32,
        height: (rect.bottom - rect.top) as u32,
        first_frame: Arc::new(Mutex::new(None)),
    };
    let first_frame = job.first_frame.clone();
    // Start audio first so it's already running when the first video frame arrives.
    let stop = Arc::new(AtomicBool::new(false));
    let audio_out = format!("{}.wav", args[1]);
    let audio_thread = audio_pid.map(|pid| {
        let (stop, out) = (stop.clone(), audio_out.clone());
        std::thread::spawn(move || audio::record_process(pid, &out, stop))
    });
    let settings = Settings::new(
        window,
        CursorCaptureSettings::WithoutCursor,
        DrawBorderSettings::WithoutBorder,
        SecondaryWindowSettings::Default,
        // Cap delivery at the target frame rate; the game renders far faster.
        MinimumUpdateIntervalSettings::Custom(Duration::from_micros(1_000_000 / fps as u64)),
        DirtyRegionSettings::Default,
        ColorFormat::Bgra8,
        job,
    );
    let result = Recorder::start(settings).map_err(|e| anyhow::anyhow!("capture failed: {e}"));
    stop.store(true, Ordering::SeqCst);
    if let Some(t) = audio_thread {
        let audio_started = t.join().map_err(|_| anyhow::anyhow!("audio thread panicked"))??;
        if let Some(video_started) = *first_frame.lock().unwrap() {
            let offset = video_started.saturating_duration_since(audio_started).as_secs_f64();
            println!("AUDIO_OFFSET {offset:.4}");
        }
    }
    result
}

/// `audio <pid> <out.wav> <seconds> [mute]`: records one process's audio, optionally muting it
/// in the volume mixer for the duration (restored afterwards).
fn audio_cmd(args: &[String]) -> Result<()> {
    let pid: u32 = args.first().context("audio <pid> <out.wav> <seconds> [mute]")?.parse()?;
    let out = args.get(1).context("out.wav")?.clone();
    let seconds: f64 = args.get(2).context("seconds")?.parse()?;
    let mute = args.get(3).map(String::as_str) == Some("mute");
    if mute {
        println!("muted sessions: {}", audio::set_process_mute(pid, true)?);
    }
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let s2 = stop.clone();
    let h = std::thread::spawn(move || audio::record_process(pid, &out, s2));
    std::thread::sleep(Duration::from_secs_f64(seconds));
    stop.store(true, std::sync::atomic::Ordering::SeqCst);
    let res = h.join().map_err(|_| anyhow::anyhow!("audio thread panicked"))?;
    if mute {
        println!("unmuted sessions: {}", audio::set_process_mute(pid, false)?);
    }
    res?;
    println!("AUDIO_DONE");
    Ok(())
}
