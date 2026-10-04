//! The background worker: idle while CS2 runs; once it's closed, import new demos and render the
//! latest session's highlights (best first), then notify.

use crate::settings::{data_dir, Seen, Settings};
use crate::system;
use cs2hl_core::ingest::{self, Added};
use cs2hl_core::library::ClipPolicy;
use cs2hl_render::batch::{self, Event, Scope};
use cs2hl_render::profile::Profile;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::image::Image;
use tauri::menu::MenuItem;
use tauri::{AppHandle, Emitter, Wry};
use tauri_plugin_notification::NotificationExt;

const DEMO_EXTS: &[&str] = &[".dem", ".dem.gz", ".dem.zst", ".dem.bz2"];
/// How often to look for new demos while idle.
const POLL: Duration = Duration::from_secs(30);

pub enum Job {
    /// Check for new demos and render now instead of waiting for the next poll.
    Now,
    /// Render these matches' pending highlights (e.g. an older day opened in the app).
    Render(Vec<String>),
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct Status {
    /// "idle", "waiting" (CS2 running), "importing", "rendering", "error"
    pub state: String,
    pub message: String,
    pub done: usize,
    pub total: usize,
}

pub struct Worker {
    app: AppHandle,
    settings: Arc<Mutex<Settings>>,
    status: Arc<Mutex<Status>>,
    seen: Seen,
    /// Set by "Stop rendering" (tray/window); the render stops at the next safe point.
    pub abort: Arc<AtomicBool>,
    stop_item: Option<MenuItem<Wry>>,
}

const TRAY_IDLE: &[u8] = include_bytes!("../icons/tray-idle.png");
const TRAY_BUSY: &[u8] = include_bytes!("../icons/tray-busy.png");

impl Worker {
    pub fn new(app: AppHandle, settings: Arc<Mutex<Settings>>, status: Arc<Mutex<Status>>, abort: Arc<AtomicBool>, stop_item: Option<MenuItem<Wry>>) -> Self {
        Self { app, settings, status, seen: Seen::load(), abort, stop_item }
    }

    fn set(&self, state: &str, message: impl Into<String>, done: usize, total: usize) {
        let s = Status { state: state.into(), message: message.into(), done, total };
        let changed_state = self.status.lock().unwrap().state != s.state;
        *self.status.lock().unwrap() = s.clone();
        let _ = self.app.emit("veloxify://status", s.clone());
        // The tray shows at a glance when CS2 is in use by Veloxify.
        if let Some(tray) = self.app.tray_by_id("tray") {
            let busy = s.state == "rendering";
            let tip = match s.state.as_str() {
                "rendering" if s.total > 0 => format!("Veloxify: rendering highlights {}/{} (CS2 in use)", (s.done + 1).min(s.total), s.total),
                "rendering" => "Veloxify: starting CS2 to render highlights".to_string(),
                "importing" => format!("Veloxify: {}", s.message),
                "waiting" => "Veloxify: waiting for CS2 to close".to_string(),
                "error" => format!("Veloxify: {}", s.message),
                _ => "Veloxify: up to date".to_string(),
            };
            let _ = tray.set_tooltip(Some(tip));
            if changed_state {
                if let Ok(img) = Image::from_bytes(if busy { TRAY_BUSY } else { TRAY_IDLE }) {
                    let _ = tray.set_icon(Some(img));
                }
                if let Some(item) = &self.stop_item {
                    let _ = item.set_enabled(busy);
                }
            }
        }
    }

    fn notify(&self, title: &str, body: &str) {
        let _ = self.app.notification().builder().title(title).body(body).show();
    }

    fn library_changed(&self) {
        let _ = self.app.emit("veloxify://library", ());
    }

    pub fn run(mut self, jobs: Receiver<Job>) {
        let mut pending_render: Vec<String> = vec![];
        loop {
            if system::cs2_running() {
                // Never do anything while the user may be playing.
                self.set("waiting", "CS2 is running. Veloxify will process your games after you close it.", 0, 0);
                match jobs.recv_timeout(Duration::from_secs(20)) {
                    Ok(Job::Render(ids)) => pending_render.extend(ids),
                    Err(RecvTimeoutError::Disconnected) => return,
                    _ => {}
                }
                continue;
            }
            let settings = self.settings.lock().unwrap().clone();
            let Some(me) = settings.steamid64.or_else(system::active_steam_user) else {
                self.set("error", "Log in to Steam so Veloxify knows whose highlights to make.", 0, 0);
                if matches!(jobs.recv_timeout(POLL), Err(RecvTimeoutError::Disconnected)) {
                    return;
                }
                continue;
            };
            let imported = self.import(&settings, me);
            if settings.auto_render || !pending_render.is_empty() {
                let scope =
                    if pending_render.is_empty() { Scope::LatestSession } else { Scope::Matches(std::mem::take(&mut pending_render)) };
                self.render(&settings, me, scope);
            } else if imported {
                self.set("idle", "Up to date", 0, 0);
            }
            if self.status.lock().unwrap().state != "error" {
                self.set("idle", "Up to date", 0, 0);
            }
            match jobs.recv_timeout(POLL) {
                Ok(Job::Render(ids)) => pending_render.extend(ids),
                Err(RecvTimeoutError::Disconnected) => return,
                _ => {}
            }
        }
    }

    /// New demo files in the watched folders, newest first, skipping ones still downloading.
    fn new_demos(&self, settings: &Settings) -> Vec<(PathBuf, String)> {
        let mut found = vec![];
        for dir in &settings.watch_dirs {
            let Ok(entries) = std::fs::read_dir(dir) else { continue };
            for e in entries.flatten() {
                let p = e.path();
                let name = p.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
                if !DEMO_EXTS.iter().any(|x| name.ends_with(x)) {
                    continue;
                }
                let Ok(meta) = e.metadata() else { continue };
                if !meta.is_file() {
                    continue;
                }
                let mtime = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
                let key = format!("{}|{}|{}", p.display(), meta.len(), mtime);
                if !self.seen.files.contains(&key) {
                    found.push((p, key, mtime));
                }
            }
        }
        found.sort_by_key(|(_, _, m)| std::cmp::Reverse(*m));
        // A file whose size is still changing is mid-download.
        std::thread::sleep(Duration::from_secs(2));
        found
            .into_iter()
            .filter(|(p, key, _)| std::fs::metadata(p).map(|m| key.contains(&format!("|{}|", m.len()))).unwrap_or(false))
            .map(|(p, key, _)| (p, key))
            .collect()
    }

    fn import(&mut self, settings: &Settings, me: u64) -> bool {
        let demos = self.new_demos(settings);
        if demos.is_empty() {
            return false;
        }
        let policy = ClipPolicy::default();
        let total = demos.len();
        let mut added = 0;
        for (i, (path, key)) in demos.into_iter().enumerate() {
            if system::cs2_running() {
                break; // the user started playing: stop and pick up later
            }
            self.set("importing", format!("Reading match {} of {}", i + 1, total), i, total);
            match ingest::add_demo(&settings.library_dir, &path, me, &policy, false) {
                Ok(Added::Added { .. }) => added += 1,
                Ok(_) => {}
                Err(e) => eprintln!("import {}: {e}", path.display()),
            }
            self.seen.files.insert(key);
            self.seen.save();
            if added > 0 && (added % 5 == 0) {
                let _ = ingest::rebuild_index(&settings.library_dir, me);
                self.library_changed();
            }
        }
        if added > 0 {
            let _ = ingest::rebuild_index(&settings.library_dir, me);
            self.library_changed();
        }
        added > 0
    }

    fn render(&self, settings: &Settings, me: u64, scope: Scope) {
        let lib = settings.library_dir.clone();
        if !lib.join("index.json").exists() {
            return;
        }
        match batch::plan(&lib, &scope) {
            Ok(p) if p.is_empty() => return,
            Err(_) => return,
            _ => {}
        }
        let profile = match Profile::load(&settings.profile) {
            Ok(p) => p,
            Err(e) => {
                self.set("error", format!("Render profile: {e}"), 0, 0);
                return;
            }
        };
        let work = data_dir().join("work");
        self.abort.store(false, Ordering::SeqCst);
        let mut total = 0;
        let mut done = 0;
        let mut hand_back = false;
        let abort = self.abort.clone();
        let result = batch::render(&lib, me, profile, &work, scope, None, abort, &mut |e| match e {
            Event::Plan { total: t } => {
                total = t;
                self.set("rendering", format!("Rendering {t} highlights"), 0, t);
                self.notify(
                    "Rendering your highlights",
                    &format!(
                        "{t} clip{} from your session. CS2 runs hidden for a few minutes; opening CS2 or \"Stop rendering\" in the tray hands it back.",
                        if t == 1 { "" } else { "s" }
                    ),
                );
            }
            Event::Rendered { title, .. } => {
                done += 1;
                self.set("rendering", format!("Rendered {title}"), done, total);
                self.library_changed();
            }
            Event::Failed { title, error, .. } => {
                done += 1;
                eprintln!("render {title}: {error}");
                self.library_changed();
            }
            Event::Done { rendered, .. } => {
                if rendered > 0 {
                    self.notify("Your highlights are ready", &format!("{rendered} new highlight{} from your session", if rendered == 1 { "" } else { "s" }));
                }
            }
            Event::Stopped { rendered, wants_cs2 } => {
                hand_back = wants_cs2;
                let left = total.saturating_sub(rendered);
                self.notify(
                    if wants_cs2 { "CS2 is yours" } else { "Rendering stopped" },
                    &format!(
                        "{}{rendered} clip{} done; {left} more after your next game.",
                        if wants_cs2 { "Starting CS2 for you. " } else { "" },
                        if rendered == 1 { "" } else { "s" }
                    ),
                );
            }
            Event::Log(_) => {}
        });
        if hand_back {
            // Someone opened CS2 while it was busy rendering: give them a normal CS2.
            let _ = std::process::Command::new(cs2hl_render::steam::steam_exe()).args(["-applaunch", "730"]).spawn();
        }
        if let Err(e) = result {
            self.set("error", format!("Rendering stopped: {e}"), done, total);
        }
    }
}

pub fn library_file(lib: &Path, rel: &str) -> Option<PathBuf> {
    // Only files inside the library, addressed by their library-relative path.
    let p = lib.join(rel);
    let canon = p.canonicalize().ok()?;
    canon.starts_with(lib.canonicalize().ok()?).then_some(canon)
}
