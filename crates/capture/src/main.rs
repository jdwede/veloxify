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
use std::time::Duration;

use anyhow::{bail, Context as _, Result};

use cs2hl_capture::{audio, record_window, CaptureOptions};

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
    let opts = CaptureOptions {
        window_title: args[0].clone(),
        out: args[1].clone(),
        seconds: args[2].parse()?,
        bitrate_mbps: args.get(3).map(|s| s.parse()).transpose()?.unwrap_or(20),
        fps: args.get(4).map(|s| s.parse()).transpose()?.unwrap_or(60),
        audio_pid,
        abort: None,
    };
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        if rx.recv().is_ok() {
            println!("CAPTURE_STARTED");
            let _ = std::io::stdout().flush();
        }
    });
    let outcome = record_window(&opts, Some(tx))?;
    println!("CAPTURE_DONE {}", outcome.frames);
    if outcome.audio.is_some() {
        println!("AUDIO_OFFSET {:.4}", outcome.audio_offset_s);
    }
    Ok(())
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
