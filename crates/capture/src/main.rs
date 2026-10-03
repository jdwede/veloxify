//! Records one window (by exact title) to an H.264 MP4 using Windows Graphics Capture, which
//! reads the window's own surface: other windows covering it don't end up in the recording.
//! Encoding goes through Media Foundation's hardware encoder (NVENC on NVIDIA GPUs).
//!
//! usage: cs2hl-capture <window title> <out.mp4> <seconds> [bitrate_mbps=20] [fps=60]
//!
//! Prints `CAPTURE_STARTED` on the first frame and `CAPTURE_DONE <frames>` when finished.

use std::io::Write;
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

struct Job {
    out: String,
    seconds: f64,
    bitrate: u32,
    fps: u32,
    width: u32,
    height: u32,
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
        let started = *self.started.get_or_insert_with(|| {
            println!("CAPTURE_STARTED");
            let _ = std::io::stdout().flush();
            Instant::now()
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
    let args: Vec<String> = std::env::args().skip(1).collect();
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
    };
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
    Recorder::start(settings).map_err(|e| anyhow::anyhow!("capture failed: {e}"))?;
    Ok(())
}
