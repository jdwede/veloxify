//! One background CS2 session that renders any number of clips from any number of demos.
//!
//! CS2 runs as a borderless window parked off-screen, is controlled over VConsole and recorded with
//! Windows Graphics Capture. Nothing is typed into the game, it never needs focus, and its audio
//! goes to a device that plays to nothing while being recorded from the process directly.
//!
//! The session can be stopped at any moment (abort flag), and stops itself if anything brings the
//! hidden CS2 window forward (the user clicking Play in Steam, FACEIT's Connect): the user wants
//! to play, so CS2 is handed back immediately.
//!
//! CS2 saves the user's config (to disk and Steam Cloud) whenever it loads a demo, so render
//! settings are only ever applied while a demo is loaded and reverted before the next load and
//! before quitting. Even a forced close therefore leaves the user's own values saved.

use crate::assemble::{self, Part, SETTLE_S};
use crate::profile::{Audio, Profile};
use crate::protect::Protector;
use crate::steam;
use crate::vconsole::VConsole;
use crate::window;
use anyhow::{anyhow, bail, Context, Result};
use cs2hl_capture::{record_window, CaptureOptions};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const TICKRATE: f64 = 64.0;

/// CS2 refuses demos recorded on older game versions (network protocol changes).
#[derive(Debug)]
pub struct DemoIncompatible(pub PathBuf);

impl std::fmt::Display for DemoIncompatible {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} was recorded on an older CS2 version; CS2 can no longer play it", self.0.display())
    }
}
impl std::error::Error for DemoIncompatible {}

/// The session was stopped: by the user ("Stop rendering"), or because something brought CS2
/// forward (`wants_cs2`: the user is trying to play).
#[derive(Debug)]
pub struct Aborted {
    pub wants_cs2: bool,
}

impl std::fmt::Display for Aborted {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(if self.wants_cs2 { "stopped: CS2 was opened" } else { "stopped" })
    }
}
impl std::error::Error for Aborted {}

pub struct Renderer {
    profile: Profile,
    /// Console settings in apply order: audio routing first, background-audio unmute last.
    console: Vec<(String, String)>,
    protector: Protector,
    vc: Option<VConsole>,
    /// Originals of the console settings currently applied (only while a demo is loaded).
    applied: Mutex<Option<Vec<(String, String)>>>,
    pid: Option<u32>,
    audio: Option<Audio>,
    account_id: u64,
    abort: Arc<AtomicBool>,
    wants_cs2: Arc<AtomicBool>,
    closed: Arc<AtomicBool>,
    log: Box<dyn Fn(&str) + Send>,
}

pub fn cs2_pid() -> Option<u32> {
    let mut c = Command::new("tasklist");
    c.args(["/FI", "IMAGENAME eq cs2.exe", "/FO", "CSV", "/NH"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    let out = String::from_utf8_lossy(&c.output().ok()?.stdout).to_string();
    out.lines().find(|l| l.starts_with("\"cs2.exe\"")).and_then(|l| l.split("\",\"").nth(1)).and_then(|p| p.parse().ok())
}

pub fn cs2_running() -> bool {
    cs2_pid().is_some()
}

impl Renderer {
    /// Applies the video settings and starts CS2 in the background. Fails if CS2 is already
    /// running. Setting `abort` stops the session at the next safe point.
    pub fn start(steamid64: u64, profile: Profile, work_dir: &Path, abort: Arc<AtomicBool>, log: Box<dyn Fn(&str) + Send>) -> Result<Self> {
        if cs2_running() {
            bail!("CS2 is running; renders only happen while it's closed");
        }
        crate::dpi_aware();
        // Order matters: send audio to the silent device before letting CS2 play while unfocused
        // (and undo in reverse), so nothing can reach the user's speakers in between.
        let mut console: Vec<(String, String)> = vec![];
        let mut audio = None;
        if profile.audio.enabled {
            let silent = cs2hl_capture::audio::output_devices()?
                .into_iter()
                .find(|(_, name)| name.to_lowercase().contains(&profile.audio.silent_device.to_lowercase()));
            match silent {
                Some((id, _)) => {
                    console.push(("sound_device_override".into(), id));
                    console.push(("volume".into(), profile.audio.game_volume.to_string()));
                    audio = Some(profile.audio.clone());
                }
                None => log(&format!("no '{}' output device; rendering without audio", profile.audio.silent_device)),
            }
        }
        console.extend(profile.console.iter().map(|(k, v)| (k.clone(), v.clone())));
        if audio.is_some() {
            console.push(("snd_mute_losefocus".into(), "0".into()));
        }
        let protector = Protector::new(steam::user_cfg_dir(steamid64), work_dir.to_path_buf());
        protector.restore_video()?; // a previous run may have crashed
        protector.backup_cfg()?;
        let mut video = profile.video.clone();
        let o = &profile.output;
        for (k, v) in [
            ("setting.fullscreen", "0".to_string()),
            ("setting.coop_fullscreen", "0".into()),
            ("setting.nowindowborder", "1".into()),
            ("setting.defaultres", o.width.to_string()),
            ("setting.defaultresheight", o.height.to_string()),
        ] {
            video.insert(k.into(), v);
        }
        protector.apply_video(&video)?;
        let mut r = Self {
            profile,
            console,
            protector,
            vc: None,
            applied: Mutex::new(None),
            pid: None,
            audio,
            account_id: steam::account_id(steamid64),
            abort,
            wants_cs2: Arc::new(AtomicBool::new(false)),
            closed: Arc::new(AtomicBool::new(false)),
            log,
        };
        if let Err(e) = r.launch() {
            r.close_inner();
            return Err(e);
        }
        Ok(r)
    }

    fn check(&self) -> Result<()> {
        if self.abort.load(Ordering::SeqCst) {
            return Err(Aborted { wants_cs2: self.wants_cs2.load(Ordering::SeqCst) }.into());
        }
        Ok(())
    }

    /// Sleeps, waking early (with an error) if the session is stopped.
    fn pause(&self, d: Duration) -> Result<()> {
        let end = Instant::now() + d;
        while Instant::now() < end {
            self.check()?;
            std::thread::sleep(Duration::from_millis(50).min(end.saturating_duration_since(Instant::now())));
        }
        self.check()
    }

    /// Waits for a console line, checking for a stop every 200 ms.
    fn wait_any(&self, needles: &[&str], timeout: Duration, since: usize) -> Result<Option<String>> {
        let end = Instant::now() + timeout;
        while Instant::now() < end {
            self.check()?;
            if let Some(l) = self.vc().wait_for_any(needles, Duration::from_millis(200), since) {
                return Ok(Some(l));
            }
        }
        Ok(None)
    }

    fn launch(&mut self) -> Result<()> {
        let o = &self.profile.output;
        let prev = window::foreground();
        (self.log)("launching CS2 in the background");
        let t0 = Instant::now();
        let mut c = Command::new(steam::steam_exe());
        c.args(["-applaunch", "730", "-insecure", "-novid", "-windowed", "-noborder"]);
        c.args(["-w", &o.width.to_string(), "-h", &o.height.to_string()]);
        c.args(["+demo_ui_mode", "0"]); // must be off before any demo plays; not a saved setting
        c.spawn().context("starting Steam")?;
        self.vc = Some(VConsole::connect(Duration::from_secs(120))?);
        while window::cs2_window().is_none() && t0.elapsed() < Duration::from_secs(60) {
            self.pause(Duration::from_millis(100))?;
        }
        window::park_offscreen();
        if window::cs2_window() == Some(window::foreground()) {
            window::set_foreground(prev);
        }
        self.wait_any(&["OnSwitchLoopModeFinished"], Duration::from_secs(120), 0)?.ok_or_else(|| anyhow!("CS2 main menu never loaded"))?;
        self.pause(Duration::from_secs(2))?;
        window::park_offscreen();
        if window::cs2_window() == Some(window::foreground()) {
            window::set_foreground(prev);
        }
        self.pid = if self.audio.is_some() { cs2_pid() } else { None };
        self.watch_for_user();
        (self.log)(&format!("CS2 ready in {:.0}s", t0.elapsed().as_secs_f64()));
        Ok(())
    }

    /// From here on, CS2 becoming the foreground window means someone wants to use it (Play in
    /// Steam, FACEIT's Connect): stop rendering and hand it back.
    fn watch_for_user(&self) {
        let (abort, wants, closed) = (self.abort.clone(), self.wants_cs2.clone(), self.closed.clone());
        std::thread::spawn(move || {
            while !closed.load(Ordering::SeqCst) {
                if let Some(h) = window::cs2_window() {
                    if h == window::foreground() {
                        wants.store(true, Ordering::SeqCst);
                        abort.store(true, Ordering::SeqCst);
                        return;
                    }
                }
                std::thread::sleep(Duration::from_millis(250));
            }
        });
    }

    fn vc(&self) -> &VConsole {
        self.vc.as_ref().expect("renderer not started")
    }

    fn revert_settings(&self) {
        if let Some(orig) = self.applied.lock().unwrap().take() {
            if self.vc().alive() {
                self.protector.revert_console(self.vc(), &orig);
            }
        }
    }

    pub fn load_demo(&self, path: &Path) -> Result<()> {
        self.check()?;
        // CS2 saves the config when a demo loads: make sure it saves the user's own values.
        self.revert_settings();
        let vc = self.vc();
        let t0 = Instant::now();
        let since = vc.mark();
        vc.send(&format!("playdemo \"{}\"", path.display()));
        self.wait_any(&["Requesting playback"], Duration::from_secs(60), since)?.ok_or_else(|| anyhow!("CS2 didn't start demo playback"))?;
        if self.wait_any(&["REPLAY_INCOMPATIBLE"], Duration::from_secs(8), since)?.is_some() {
            return Err(DemoIncompatible(path.to_path_buf()).into());
        }
        // Ready once the demo is in game: loading from the menu prints SIGNONSTATE_FULL, switching
        // from one demo to another doesn't but does print its first full snapshot.
        self.wait_any(&["playing demo from"], Duration::from_secs(120), since)?.ok_or_else(|| anyhow!("demo never started loading"))?;
        self.wait_any(&["SIGNONSTATE_FULL", "received full update"], Duration::from_secs(180), since)?
            .ok_or_else(|| anyhow!("demo never finished loading"))?;
        vc.send("demo_pause");
        window::park_offscreen();
        self.pause(Duration::from_secs(1))?;
        *self.applied.lock().unwrap() = Some(self.protector.apply_console(vc, &self.console)?);
        vc.send(&format!("spec_lock_to_accountid {}", self.account_id));
        (self.log)(&format!("demo loaded in {:.0}s", t0.elapsed().as_secs_f64()));
        Ok(())
    }

    /// Records the tick ranges and assembles them into `out`.
    pub fn record(&self, segments: &[(i32, i32)], out: &Path) -> Result<()> {
        let vc = self.vc();
        let o = &self.profile.output;
        let tmp = std::env::temp_dir().join(format!("veloxify-{}", std::process::id()));
        std::fs::create_dir_all(&tmp)?;
        let result = (|| -> Result<()> {
            let mut parts = vec![];
            for (i, &(start, end)) in segments.iter().enumerate() {
                self.check()?;
                vc.send("demo_pause");
                vc.send(&format!("demo_gototick {}", start - (SETTLE_S * TICKRATE) as i32));
                self.pause(Duration::from_millis(1500))?; // anything still settling is trimmed
                vc.send(&format!("spec_lock_to_accountid {}", self.account_id));
                self.pause(Duration::from_millis(300))?;
                let video = tmp.join(format!("part{i}.mp4"));
                let opts = CaptureOptions {
                    window_title: window::TITLE.into(),
                    out: video.display().to_string(),
                    seconds: (end - start) as f64 / TICKRATE + SETTLE_S,
                    bitrate_mbps: o.capture_bitrate_mbps,
                    fps: o.fps,
                    audio_pid: self.pid,
                    abort: Some(self.abort.clone()),
                };
                let (tx, rx) = std::sync::mpsc::channel();
                let o2 = opts.clone();
                let capture = std::thread::spawn(move || record_window(&o2, Some(tx)));
                if rx.recv_timeout(Duration::from_secs(10)).is_err() {
                    let res = capture.join().map_err(|_| anyhow!("capture thread panicked"))?;
                    self.check()?;
                    bail!("capture never started: {:?}", res.err());
                }
                vc.send("demo_resume");
                let outcome = capture.join().map_err(|_| anyhow!("capture thread panicked"))??;
                vc.send("demo_pause");
                self.check()?;
                if outcome.aborted {
                    return Err(Aborted { wants_cs2: self.wants_cs2.load(Ordering::SeqCst) }.into());
                }
                parts.push(Part { video: opts.out, seconds: opts.seconds, audio: outcome.audio, audio_offset_s: outcome.audio_offset_s });
            }
            if let Some(dir) = out.parent() {
                std::fs::create_dir_all(dir)?;
            }
            assemble::assemble(&parts, out, o, self.audio.as_ref())
        })();
        let _ = std::fs::remove_dir_all(&tmp);
        result
    }

    /// Whether the session was stopped because someone tried to use CS2.
    pub fn wants_cs2(&self) -> bool {
        self.wants_cs2.load(Ordering::SeqCst)
    }

    /// Puts the user's settings back and closes CS2.
    pub fn close(mut self) {
        self.close_inner();
    }

    fn close_inner(&mut self) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        let urgent = self.abort.load(Ordering::SeqCst);
        if self.vc.is_some() {
            if let Some(orig) = self.applied.lock().unwrap().take() {
                if self.vc().alive() {
                    self.protector.revert_console(self.vc(), &orig);
                    (self.log)(&format!("put back {} console settings", orig.len()));
                }
            }
            if self.vc().alive() {
                self.vc().send("quit");
            }
        }
        // Stopping for the user: don't make them wait on a slow shutdown.
        let deadline = Instant::now() + Duration::from_secs(if urgent { 8 } else { 60 });
        while cs2_running() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(250));
        }
        if cs2_running() {
            (self.log)("CS2 didn't exit; force-closing it (your saved settings are already your own)");
            let mut c = Command::new("taskkill");
            c.args(["/F", "/IM", "cs2.exe"]);
            let _ = c.output();
            let wait = Instant::now() + Duration::from_secs(5);
            while cs2_running() && Instant::now() < wait {
                std::thread::sleep(Duration::from_millis(200));
            }
        }
        if let Ok(true) = self.protector.restore_video() {
            (self.log)("restored your cs2_video.txt");
        }
    }
}

impl Drop for Renderer {
    fn drop(&mut self) {
        self.close_inner();
    }
}
