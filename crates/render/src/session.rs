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
/// How far (game units) CS2's camera may be from the player's position before a part counts as
/// filmed from someone else's eyes.
const POV_TOLERANCE: f64 = 64.0;

/// One grenade lineup to film: the thrower's own view for a moment before the throw (where they
/// stand, aim and how they move), then a free camera following the grenade along its real flight
/// until it goes off, holding on it for a few seconds (the smoke blooming, the molotov spreading).
#[derive(Debug, Clone)]
pub struct LineupShot {
    /// The thrower's name in the demo (the camera locks on by name) and where they stand when the
    /// camera is checked (the clip's start minus the settle time).
    pub thrower: String,
    pub eye: Option<(f64, f64)>,
    pub throw_tick: i32,
    pub pop_tick: i32,
    /// The grenade's position every 4 ticks from the throw.
    pub path: Vec<[f64; 3]>,
    pub lead_s: f64,
    pub hold_s: f64,
}

/// The free camera rides the grenade's own path (open air: the grenade just flew through it), this
/// far behind it while it flies, a little above; when it goes off, it settles further back along
/// the path, which by construction can see where it landed.
const CHASE_DIST: f64 = 140.0;
const CHASE_UP: f64 = 18.0;
const HOLD_DIST: f64 = 260.0;
const HOLD_UP: f64 = 30.0;
/// Ticks after the release before the camera leaves the thrower (the grenade clears the hand).
const FOLLOW_DELAY_TICKS: f64 = 6.0;

impl LineupShot {
    /// The grenade at `tick` (interpolated along the path, held at the end).
    fn grenade_at(&self, tick: f64) -> [f64; 3] {
        let f = ((tick - self.throw_tick as f64) / 4.0).max(0.0);
        let i = (f.floor() as usize).min(self.path.len().saturating_sub(1));
        let j = (i + 1).min(self.path.len() - 1);
        let w = (f - f.floor()).min(1.0);
        let (a, b) = (self.path[i], self.path[j]);
        [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w, a[2] + (b[2] - a[2]) * w]
    }
    /// The point on the grenade's path at least `dist` units (straight line) behind where it is at
    /// `tick`, walking back along the path (the throw itself if it hasn't gone that far yet).
    fn point_back(&self, tick: f64, dist: f64) -> [f64; 3] {
        let g = self.grenade_at(tick);
        let mut t = tick;
        let start = self.throw_tick as f64;
        while t > start {
            t -= 1.0;
            let p = self.grenade_at(t);
            if ((p[0] - g[0]).powi(2) + (p[1] - g[1]).powi(2) + (p[2] - g[2]).powi(2)).sqrt() >= dist {
                return p;
            }
        }
        self.grenade_at(start)
    }
}

/// `spec_goto` arguments looking from `cam` at `target`: x y z pitch yaw.
fn look(cam: [f64; 3], target: [f64; 3]) -> String {
    let (dx, dy, dz) = (target[0] - cam[0], target[1] - cam[1], target[2] - cam[2]);
    let yaw = dy.atan2(dx).to_degrees();
    let pitch = -dz.atan2(dx.hypot(dy)).to_degrees();
    format!("spec_goto {:.1} {:.1} {:.1} {:.2} {:.2}", cam[0], cam[1], cam[2], pitch, yaw)
}

/// CS2's camera wasn't in the player's eyes, even after locking it again: the clip is skipped
/// rather than made from someone else's view.
#[derive(Debug)]
pub struct WrongPov;

impl std::fmt::Display for WrongPov {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("CS2's camera wasn't on you, so this clip was skipped")
    }
}
impl std::error::Error for WrongPov {}

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
    /// The player's name in the loaded demo (FACEIT nickname or Steam name): the camera follows
    /// them by name.
    pov_name: Mutex<String>,
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

/// Puts the user's own video settings back when a render was cut short (Veloxify closed or
/// crashed mid-render) and CS2 is closed, so their next CS2 never starts with the render's
/// settings (windowed, 1080p, high quality). Returns whether anything was put back.
pub fn repair_cut_short_render(steamid64: u64) -> bool {
    if cs2_running() {
        return false;
    }
    Protector::new(steam::user_cfg_dir(steamid64), PathBuf::new()).restore_video().unwrap_or(false)
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
            pov_name: Mutex::new(String::new()),
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

    /// Stops rendering when a person clearly wants CS2: they bring its window forward twice
    /// within 15 seconds, each time right after real keyboard or mouse input. CS2 also comes
    /// forward by itself (loading a demo, or when another window closes) with nobody there, even
    /// overnight; then it's pushed back out of the way and the render carries on.
    fn watch_for_user(&self) {
        let (abort, wants, closed) = (self.abort.clone(), self.wants_cs2.clone(), self.closed.clone());
        std::thread::spawn(move || {
            // The last window other than CS2 that had the focus.
            let mut before = window::foreground();
            let mut asked_at: Option<Instant> = None;
            let mut was_forward = false;
            while !closed.load(Ordering::SeqCst) {
                let fg = window::foreground();
                let forward = window::cs2_window().is_some_and(|h| h == fg);
                if forward && !was_forward {
                    let person = window::idle_ms() < 2000;
                    eprintln!("veloxify: CS2 came forward (from {:?}; input {} ms ago)", window::title(before), window::idle_ms());
                    if person && asked_at.is_some_and(|t| t.elapsed() < Duration::from_secs(15)) {
                        wants.store(true, Ordering::SeqCst);
                        abort.store(true, Ordering::SeqCst);
                        return;
                    }
                    if person {
                        asked_at = Some(Instant::now());
                    }
                    window::park_offscreen();
                    if window::is_open(before) {
                        window::set_foreground(before);
                    } else {
                        window::focus_desktop();
                    }
                } else if !forward && !fg.is_invalid() {
                    before = fg;
                }
                was_forward = forward;
                std::thread::sleep(Duration::from_millis(250));
            }
        });
    }

    fn vc(&self) -> &VConsole {
        self.vc.as_ref().expect("renderer not started")
    }

    /// Puts CS2's camera in the player's eyes, by their name in the demo. (CS2 ignores
    /// `spec_lock_to_accountid` and `spec_player_by_accountid` in demos: the camera stays with
    /// CS2's auto-director, jumping between players. `spec_player "<name>"` works and holds
    /// through jumps; `record` still checks every part.)
    fn lock_pov(&self) {
        let name = self.pov_name.lock().unwrap().replace(['"', ';'], "");
        if !name.is_empty() {
            self.vc().send(&format!("spec_player \"{name}\""));
        }
    }

    /// Where CS2's camera is (x, y), from `getpos`.
    fn camera(&self) -> Option<(f64, f64)> {
        let vc = self.vc();
        let since = vc.mark();
        vc.send("getpos");
        let line = vc.wait_for("setpos", Duration::from_secs(2), since)?;
        let nums: Vec<f64> = line.split(|c: char| c.is_whitespace() || c == ';').filter_map(|w| w.parse().ok()).collect();
        (nums.len() >= 2).then(|| (nums[0], nums[1]))
    }

    /// CS2's console, for tools that probe a loaded demo (e.g. `examples/pov_probe.rs`).
    pub fn console(&self) -> &VConsole {
        self.vc()
    }

    fn revert_settings(&self) {
        if let Some(orig) = self.applied.lock().unwrap().take() {
            if self.vc().alive() {
                self.protector.revert_console(self.vc(), &orig);
            }
        }
    }

    /// Loads a demo; `player` is the recorded player's name in it.
    pub fn load_demo(&self, path: &Path, player: &str) -> Result<()> {
        *self.pov_name.lock().unwrap() = player.to_string();
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
        self.lock_pov();
        (self.log)(&format!("demo loaded in {:.0}s", t0.elapsed().as_secs_f64()));
        Ok(())
    }

    /// Records the tick ranges and assembles them into `out`. `eyes(tick)` is where the player
    /// is at a tick (from the demo): each part is checked to start in their eyes, never anyone
    /// else's; `None` when unknown.
    pub fn record(&self, segments: &[(i32, i32)], out: &Path, eyes: &dyn Fn(i32) -> Option<(f64, f64)>) -> Result<()> {
        let vc = self.vc();
        let o = &self.profile.output;
        let tmp = std::env::temp_dir().join(format!("veloxify-{}", std::process::id()));
        std::fs::create_dir_all(&tmp)?;
        let result = (|| -> Result<()> {
            let mut parts = vec![];
            for (i, &(start, end)) in segments.iter().enumerate() {
                self.check()?;
                vc.send("demo_pause");
                let at = start - (SETTLE_S * TICKRATE) as i32;
                vc.send(&format!("demo_gototick {at}"));
                self.pause(Duration::from_millis(1500))?; // anything still settling is trimmed
                // The player's own view, checked: never a clip from someone else's eyes.
                let mut on_you = false;
                for attempt in 0..3u64 {
                    self.lock_pov();
                    self.pause(Duration::from_millis(400 + 400 * attempt))?;
                    match (eyes(at), self.camera()) {
                        (None, _) => {
                            on_you = true; // nothing to check against: trust the lock
                            break;
                        }
                        (Some(want), Some(got)) => {
                            let off = (want.0 - got.0).hypot(want.1 - got.1);
                            if off <= POV_TOLERANCE {
                                on_you = true;
                                break;
                            }
                            (self.log)(&format!("camera {off:.0} units from you at tick {at}; locking it again"));
                        }
                        (Some(_), None) => (self.log)("CS2 didn't say where its camera is; locking it again"),
                    }
                }
                // A name CS2 can't take (all digits reads as a player number; some symbols): step
                // through the players until the camera is where you stand.
                if !on_you {
                    if let Some(want) = eyes(at) {
                        vc.send("spec_mode 2");
                        for _ in 0..12 {
                            vc.send("spec_next");
                            self.pause(Duration::from_millis(300))?;
                            if self.camera().is_some_and(|got| (want.0 - got.0).hypot(want.1 - got.1) <= POV_TOLERANCE) {
                                on_you = true;
                                break;
                            }
                        }
                    }
                }
                if !on_you {
                    return Err(WrongPov.into());
                }
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

    /// Films a grenade lineup (see [`LineupShot`]) into `out`.
    pub fn record_lineup(&self, shot: &LineupShot, out: &Path) -> Result<()> {
        if shot.path.len() < 2 {
            bail!("no flight path for this grenade");
        }
        let vc = self.vc();
        let o = &self.profile.output;
        let tmp = std::env::temp_dir().join(format!("veloxify-lineup-{}", std::process::id()));
        std::fs::create_dir_all(&tmp)?;
        let result = (|| -> Result<()> {
            self.check()?;
            *self.pov_name.lock().unwrap() = shot.thrower.clone();
            let start = shot.throw_tick - (shot.lead_s * TICKRATE) as i32;
            let at = start - (SETTLE_S * TICKRATE) as i32;
            vc.send("demo_pause");
            vc.send(&format!("demo_gototick {at}"));
            self.pause(Duration::from_millis(1500))?;
            // Back in a player's eyes (the last lineup left the free camera on).
            vc.send("spec_mode 2");
            let mut on_them = false;
            for attempt in 0..3u64 {
                self.lock_pov();
                self.pause(Duration::from_millis(400 + 400 * attempt))?;
                match (shot.eye, self.camera()) {
                    (None, _) => {
                        on_them = true;
                        break;
                    }
                    (Some(want), Some(got)) if (want.0 - got.0).hypot(want.1 - got.1) <= POV_TOLERANCE => {
                        on_them = true;
                        break;
                    }
                    _ => (self.log)(&format!("camera isn't on {} yet; locking it again", shot.thrower)),
                }
            }
            // A name CS2 can't take (all digits reads as a player number; some symbols): step
            // through the players until the camera is where the thrower stands.
            if !on_them {
                if let Some(want) = shot.eye {
                    vc.send("spec_mode 2");
                    for _ in 0..12 {
                        vc.send("spec_next");
                        self.pause(Duration::from_millis(300))?;
                        if self.camera().is_some_and(|got| (want.0 - got.0).hypot(want.1 - got.1) <= POV_TOLERANCE) {
                            on_them = true;
                            break;
                        }
                    }
                }
            }
            if !on_them {
                return Err(WrongPov.into());
            }
            let flight_s = (shot.pop_tick - shot.throw_tick).max(1) as f64 / TICKRATE;
            let seconds = SETTLE_S + shot.lead_s + flight_s + shot.hold_s;
            let video = tmp.join("lineup.mp4");
            let opts = CaptureOptions {
                window_title: window::TITLE.into(),
                out: video.display().to_string(),
                seconds,
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
            let t0 = Instant::now();
            // Drive the camera while the demo plays in real time: the thrower's eyes until the
            // grenade leaves the hand, then a free camera chasing it, then holding on where it
            // went off.
            let pop = shot.pop_tick as f64;
            let mut free = false;
            let mut chase_at_pop: Option<[f64; 3]> = None;
            while t0.elapsed().as_secs_f64() < seconds - 0.05 {
                if self.abort.load(Ordering::SeqCst) {
                    break;
                }
                let tick = at as f64 + t0.elapsed().as_secs_f64() * TICKRATE;
                if tick >= shot.throw_tick as f64 + FOLLOW_DELAY_TICKS {
                    if !free {
                        vc.send("spec_mode 4");
                        free = true;
                    }
                    let cmd = if tick < pop {
                        let g = shot.grenade_at(tick);
                        let b = shot.point_back(tick, CHASE_DIST);
                        let cam = [b[0], b[1], b[2] + CHASE_UP];
                        chase_at_pop = Some(cam);
                        look(cam, g)
                    } else {
                        // Ease back along the path over a second, looking at where it went off
                        // (a little above it, where a smoke fills).
                        let land = shot.grenade_at(pop);
                        let far = shot.point_back(pop, HOLD_DIST);
                        let goal = [far[0], far[1], far[2] + HOLD_UP];
                        let from = chase_at_pop.unwrap_or(goal);
                        let f = ((tick - pop) / TICKRATE).min(1.0);
                        let e = f * f * (3.0 - 2.0 * f);
                        let cam = [from[0] + (goal[0] - from[0]) * e, from[1] + (goal[1] - from[1]) * e, from[2] + (goal[2] - from[2]) * e];
                        look(cam, [land[0], land[1], land[2] + 30.0])
                    };
                    vc.send(&cmd);
                }
                std::thread::sleep(Duration::from_millis(15));
            }
            let outcome = capture.join().map_err(|_| anyhow!("capture thread panicked"))??;
            vc.send("demo_pause");
            self.check()?;
            if outcome.aborted {
                return Err(Aborted { wants_cs2: self.wants_cs2.load(Ordering::SeqCst) }.into());
            }
            let parts = vec![Part { video: opts.out, seconds: opts.seconds, audio: outcome.audio, audio_offset_s: outcome.audio_offset_s }];
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
            if self.vc().alive() {
                // The lock outlives CS2: don't leave your own spectating stuck on yourself.
                self.vc().send("spec_lock_to_accountid 0");
            }
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
