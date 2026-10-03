//! Window recording for highlight renders.
//!
//! [`record_window`] records one window (by exact title) to an H.264 MP4 with Windows Graphics
//! Capture, which reads the window's own surface, so other windows covering it never end up in the
//! recording. Encoding goes through Media Foundation's hardware encoder (NVENC on NVIDIA GPUs).
//! Optionally one process's audio is recorded alongside (see [`audio`]).

pub mod audio;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context as _, Result};
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

#[derive(Debug, Clone)]
pub struct CaptureOptions {
    pub window_title: String,
    pub out: String,
    pub seconds: f64,
    pub bitrate_mbps: u32,
    pub fps: u32,
    /// Also record this process's audio to `<out>.wav`.
    pub audio_pid: Option<u32>,
}

#[derive(Debug, Clone)]
pub struct CaptureOutcome {
    pub frames: u64,
    /// Path of the recorded audio, if any.
    pub audio: Option<String>,
    /// How long the audio started before the first video frame (trim this much off the audio).
    pub audio_offset_s: f64,
}

struct Job {
    out: String,
    seconds: f64,
    bitrate: u32,
    fps: u32,
    width: u32,
    height: u32,
    first_frame: Arc<Mutex<Option<Instant>>>,
    frames: Arc<Mutex<u64>>,
    started: Option<Sender<()>>,
}

struct Recorder {
    job: Job,
    encoder: Option<VideoEncoder>,
    started: Option<Instant>,
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
        let encoder =
            VideoEncoder::new(video, AudioSettingsBuilder::default().disabled(true), ContainerSettingsBuilder::default(), &job.out)?;
        Ok(Self { job, encoder: Some(encoder), started: None })
    }

    fn on_frame_arrived(&mut self, frame: &mut Frame, control: InternalCaptureControl) -> Result<(), Self::Error> {
        if frame.width() != self.job.width || frame.height() != self.job.height {
            return Err(format!("window is {}x{}, expected {}x{}", frame.width(), frame.height(), self.job.width, self.job.height).into());
        }
        if self.started.is_none() {
            let now = Instant::now();
            *self.job.first_frame.lock().unwrap() = Some(now);
            self.started = Some(now);
            if let Some(tx) = self.job.started.take() {
                let _ = tx.send(());
            }
        }
        if let Some(enc) = self.encoder.as_mut() {
            enc.send_frame(frame)?;
            *self.job.frames.lock().unwrap() += 1;
        }
        if self.started.unwrap().elapsed().as_secs_f64() >= self.job.seconds {
            if let Some(enc) = self.encoder.take() {
                enc.finish()?;
            }
            control.stop();
        }
        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        if let Some(enc) = self.encoder.take() {
            enc.finish()?;
        }
        Ok(())
    }
}

/// Records `opts.seconds` of the window. `started` fires on the first captured frame, so the
/// caller can start whatever should be recorded (e.g. resume demo playback). Blocks until done.
pub fn record_window(opts: &CaptureOptions, started: Option<Sender<()>>) -> Result<CaptureOutcome> {
    let window = Window::from_name(&opts.window_title).with_context(|| format!("no window titled {:?}", opts.window_title))?;
    let rect = window.rect().context("window rect")?;
    let first_frame = Arc::new(Mutex::new(None));
    let frames = Arc::new(Mutex::new(0u64));
    let job = Job {
        out: opts.out.clone(),
        seconds: opts.seconds,
        bitrate: opts.bitrate_mbps * 1_000_000,
        fps: opts.fps,
        width: (rect.right - rect.left) as u32,
        height: (rect.bottom - rect.top) as u32,
        first_frame: first_frame.clone(),
        frames: frames.clone(),
        started,
    };
    // Start audio first so it's already running when the first video frame arrives.
    let stop = Arc::new(AtomicBool::new(false));
    let audio_out = format!("{}.wav", opts.out);
    let audio_thread = opts.audio_pid.map(|pid| {
        let (stop, out) = (stop.clone(), audio_out.clone());
        std::thread::spawn(move || audio::record_process(pid, &out, stop))
    });
    let settings = Settings::new(
        window,
        CursorCaptureSettings::WithoutCursor,
        DrawBorderSettings::WithoutBorder,
        SecondaryWindowSettings::Default,
        // Cap delivery at the target frame rate; the game renders far faster.
        MinimumUpdateIntervalSettings::Custom(Duration::from_micros(1_000_000 / opts.fps.max(1) as u64)),
        DirtyRegionSettings::Default,
        ColorFormat::Bgra8,
        job,
    );
    let result = Recorder::start(settings).map_err(|e| anyhow::anyhow!("capture failed: {e}"));
    stop.store(true, Ordering::SeqCst);
    let mut outcome = CaptureOutcome { frames: *frames.lock().unwrap(), audio: None, audio_offset_s: 0.0 };
    if let Some(t) = audio_thread {
        let audio_started = t.join().map_err(|_| anyhow::anyhow!("audio thread panicked"))??;
        if let Some(video_started) = *first_frame.lock().unwrap() {
            outcome.audio_offset_s = video_started.saturating_duration_since(audio_started).as_secs_f64();
            outcome.audio = Some(audio_out);
        }
    }
    result.map(|_| outcome)
}
