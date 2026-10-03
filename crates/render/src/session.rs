//! One background CS2 session that renders any number of clips from any number of demos.
//!
//! CS2 runs as a borderless window parked off-screen, is controlled over VConsole and recorded with
//! Windows Graphics Capture. Nothing is typed into the game, it never needs focus, and its audio
//! goes to a device that plays to nothing while being recorded from the process directly.

use crate::assemble::{self, Part, SETTLE_S};
use crate::profile::{Audio, Profile};
use crate::protect::Protector;
use crate::steam;
use crate::vconsole::VConsole;
use crate::window;
use anyhow::{anyhow, bail, Context, Result};
use cs2hl_capture::{record_window, CaptureOptions};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
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

pub struct Renderer {
    profile: Profile,
    protector: Protector,
    vc: Option<VConsole>,
    originals: Option<BTreeMap<String, String>>,
    pid: Option<u32>,
    audio: Option<Audio>,
    account_id: u64,
    closed: bool,
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
    /// Applies the profile and starts CS2 in the background. Fails if CS2 is already running.
    pub fn start(steamid64: u64, mut profile: Profile, work_dir: &Path, log: Box<dyn Fn(&str) + Send>) -> Result<Self> {
        if cs2_running() {
            bail!("CS2 is running; renders only happen while it's closed");
        }
        crate::dpi_aware();
        let mut audio = None;
        if profile.audio.enabled {
            let silent = cs2hl_capture::audio::output_devices()?
                .into_iter()
                .find(|(_, name)| name.to_lowercase().contains(&profile.audio.silent_device.to_lowercase()));
            match silent {
                Some((id, _)) => {
                    profile.console.insert("sound_device_override".into(), id);
                    profile.console.insert("snd_mute_losefocus".into(), "0".into());
                    profile.console.insert("volume".into(), profile.audio.game_volume.to_string());
                    audio = Some(profile.audio.clone());
                }
                None => log(&format!("no '{}' output device; rendering without audio", profile.audio.silent_device)),
            }
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
            protector,
            vc: None,
            originals: None,
            pid: None,
            audio,
            account_id: steam::account_id(steamid64),
            closed: false,
            log,
        };
        if let Err(e) = r.launch() {
            r.close_inner();
            return Err(e);
        }
        Ok(r)
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
        let vc = VConsole::connect(Duration::from_secs(120))?;
        while window::cs2_window().is_none() && t0.elapsed() < Duration::from_secs(60) {
            std::thread::sleep(Duration::from_millis(100));
        }
        window::park_offscreen();
        if window::cs2_window() == Some(window::foreground()) {
            window::set_foreground(prev);
        }
        vc.wait_for("OnSwitchLoopModeFinished", Duration::from_secs(120), 0).ok_or_else(|| anyhow!("CS2 main menu never loaded"))?;
        std::thread::sleep(Duration::from_secs(2));
        window::park_offscreen();
        self.originals = Some(self.protector.apply_console(&vc, &self.profile.console)?);
        self.pid = if self.audio.is_some() { cs2_pid() } else { None };
        self.vc = Some(vc);
        (self.log)(&format!("CS2 ready in {:.0}s", t0.elapsed().as_secs_f64()));
        Ok(())
    }

    fn vc(&self) -> &VConsole {
        self.vc.as_ref().expect("renderer not started")
    }

    pub fn load_demo(&self, path: &Path) -> Result<()> {
        let vc = self.vc();
        let t0 = Instant::now();
        let since = vc.mark();
        vc.send(&format!("playdemo \"{}\"", path.display()));
        vc.wait_for("Requesting playback", Duration::from_secs(60), since).ok_or_else(|| anyhow!("CS2 didn't start demo playback"))?;
        if vc.wait_for("REPLAY_INCOMPATIBLE", Duration::from_secs(8), since).is_some() {
            return Err(DemoIncompatible(path.to_path_buf()).into());
        }
        // Ready once the demo is in game: loading from the menu prints SIGNONSTATE_FULL, switching
        // from one demo to another doesn't but does print its first full snapshot.
        vc.wait_for("playing demo from", Duration::from_secs(120), since).ok_or_else(|| anyhow!("demo never started loading"))?;
        vc.wait_for_any(&["SIGNONSTATE_FULL", "received full update"], Duration::from_secs(180), since)
            .ok_or_else(|| anyhow!("demo never finished loading"))?;
        vc.send("demo_pause");
        window::park_offscreen();
        std::thread::sleep(Duration::from_secs(1));
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
                vc.send("demo_pause");
                vc.send(&format!("demo_gototick {}", start - (SETTLE_S * TICKRATE) as i32));
                std::thread::sleep(Duration::from_millis(1500)); // anything still settling is trimmed
                vc.send(&format!("spec_lock_to_accountid {}", self.account_id));
                std::thread::sleep(Duration::from_millis(300));
                let video = tmp.join(format!("part{i}.mp4"));
                let opts = CaptureOptions {
                    window_title: window::TITLE.into(),
                    out: video.display().to_string(),
                    seconds: (end - start) as f64 / TICKRATE + SETTLE_S,
                    bitrate_mbps: o.capture_bitrate_mbps,
                    fps: o.fps,
                    audio_pid: self.pid,
                };
                let (tx, rx) = std::sync::mpsc::channel();
                let o2 = opts.clone();
                let capture = std::thread::spawn(move || record_window(&o2, Some(tx)));
                if rx.recv_timeout(Duration::from_secs(10)).is_err() {
                    let res = capture.join().map_err(|_| anyhow!("capture thread panicked"))?;
                    bail!("capture never started: {:?}", res.err());
                }
                vc.send("demo_resume");
                let outcome = capture.join().map_err(|_| anyhow!("capture thread panicked"))??;
                vc.send("demo_pause");
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

    /// Puts the user's settings back and closes CS2.
    pub fn close(mut self) {
        self.close_inner();
    }

    fn close_inner(&mut self) {
        if self.closed {
            return;
        }
        self.closed = true;
        if let Some(vc) = self.vc.as_ref().filter(|v| v.alive()) {
            if let Some(orig) = &self.originals {
                self.protector.revert_console(vc, orig);
                (self.log)(&format!("put back {} console settings", orig.len()));
            }
            vc.send("quit");
        }
        let deadline = Instant::now() + Duration::from_secs(60);
        while cs2_running() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(500));
        }
        if cs2_running() {
            (self.log)("CS2 didn't exit; force-closing it (no settings get written)");
            let mut c = Command::new("taskkill");
            c.args(["/F", "/IM", "cs2.exe"]);
            let _ = c.output();
            std::thread::sleep(Duration::from_secs(2));
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
