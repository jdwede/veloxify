//! The background worker: idle while CS2 runs; once it's closed, import new demos and render the
//! latest session's highlights (best first), then notify.

use crate::settings::{data_dir, Seen, Settings};
use crate::{faceit, mapicons, system};
use cs2hl_core::faceit::Faceit;
use cs2hl_core::ingest::{self, Added};
use cs2hl_core::library::{Index, MatchEntry};
use cs2hl_render::batch::{self, Event, Scope};
use cs2hl_render::profile::Profile;
use serde::Serialize;
use std::cell::Cell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::image::Image;
use tauri::menu::MenuItem;
use tauri::{AppHandle, Emitter, Wry};
use tauri_plugin_notification::NotificationExt;

const DEMO_EXTS: &[&str] = &[".dem", ".dem.gz", ".dem.zst", ".dem.bz2"];
/// How often to look for new demos while idle.
const POLL: Duration = Duration::from_secs(30);
/// How often to refresh FACEIT level, ELO and matches while idle (also right after CS2 closes).
const FACEIT_EVERY: Duration = Duration::from_secs(15 * 60);
/// While CS2 is open: a light refresh (newest matches only) so a session's finished matches show
/// up between games.
const FACEIT_WHILE_PLAYING: Duration = Duration::from_secs(2 * 60);

pub enum Job {
    /// Check for new demos and render now instead of waiting for the next poll.
    Now,
    /// Render these matches' pending highlights (e.g. an older day opened in the app).
    Render(Vec<String>),
    /// Refresh FACEIT data now (settings changed).
    Faceit,
    /// Render these clips now (match id, highlight or lowlight id): Watch on a lowlight, or a
    /// clip removed for space.
    RenderClips(Vec<(String, String)>),
    /// Import these demos (file names in Veloxify's demos folder) again even though they were
    /// looked at before: Get demos found them downloaded but not in the library.
    Import(Vec<String>),
    /// Film these grenade lineups' videos now (lineup ids).
    RenderLineups(Vec<String>),
}

/// What a render run makes.
enum Batch {
    Clips(Scope),
    /// Lineup videos: these, or the most thrown still without one.
    Lineups(Option<Vec<String>>),
}

/// Lineup videos filmed per automatic run (about 15 s each).
const LINEUPS_PER_RUN: usize = 30;

/// An import that fails with an error (not a skip) is tried again on later passes, up to this
/// many times, before the demo is left alone.
const IMPORT_TRIES: u32 = 3;

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
    /// Imports that failed this run: demo key -> attempts.
    failed: HashMap<String, u32>,
    /// Set by "Stop rendering" (tray/window); the render stops at the next safe point.
    pub abort: Arc<AtomicBool>,
    stop_item: Option<MenuItem<Wry>>,
    /// Which of `TRAY_ICONS` the tray shows now.
    tray_icon: Cell<Option<usize>>,
}

/// The tray icon tells at a glance what CS2 is up to: green = CS2 closed (Veloxify is free to
/// work), red = Veloxify has CS2 open, clipping, plain = you're playing (Veloxify waits).
const TRAY_ICONS: [&[u8]; 3] = [
    include_bytes!("../icons/tray-ready.png"),
    include_bytes!("../icons/tray-clipping.png"),
    include_bytes!("../icons/tray-playing.png"),
];

impl Worker {
    pub fn new(app: AppHandle, settings: Arc<Mutex<Settings>>, status: Arc<Mutex<Status>>, abort: Arc<AtomicBool>, stop_item: Option<MenuItem<Wry>>) -> Self {
        Self { app, settings, status, seen: Seen::load(), failed: HashMap::new(), abort, stop_item, tray_icon: Cell::new(None) }
    }

    fn set(&self, state: &str, message: impl Into<String>, done: usize, total: usize) {
        let s = Status { state: state.into(), message: message.into(), done, total };
        let changed_state = self.status.lock().unwrap().state != s.state;
        *self.status.lock().unwrap() = s.clone();
        let _ = self.app.emit("veloxify://status", s.clone());
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
            let icon = match s.state.as_str() {
                "rendering" => 1,
                "waiting" => 2,
                _ => 0,
            };
            if self.tray_icon.get() != Some(icon) {
                if let Ok(img) = Image::from_bytes(TRAY_ICONS[icon]) {
                    let _ = tray.set_icon(Some(img));
                    self.tray_icon.set(Some(icon));
                }
            }
            if changed_state {
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
        let mut pending_clips: Vec<(String, String)> = vec![];
        let mut pending_lineups: Vec<String> = vec![];
        let mut last_faceit: Option<Instant> = None;
        let mut icons_checked = false;
        let mut was_playing = false;
        // FACEIT data the index hasn't caught up with (changed while CS2 was open). Starts true so
        // the index is rebuilt once per launch, e.g. after an update changed how it's built.
        let mut faceit_dirty = true;
        // Right tray color from the start (the first import can take a while).
        self.set(if system::cs2_running() { "waiting" } else { "idle" }, "Starting", 0, 0);
        loop {
            if system::cs2_running() {
                // Nothing heavy while the user may be playing: no demo parsing, rendering or
                // re-indexing. Only FACEIT's newest matches, so finished games show between games.
                was_playing = true;
                self.set("waiting", "CS2 is running. Finished matches show up as you play; demos and clips are processed after you close CS2.", 0, 0);
                let settings = self.settings.lock().unwrap().clone();
                if settings.faceit_enabled && last_faceit.map_or(true, |t| t.elapsed() > FACEIT_WHILE_PLAYING) {
                    if let Some(me) = settings.steamid64.or_else(system::active_steam_user) {
                        if self.refresh_faceit(&settings, me, true) {
                            faceit_dirty = true;
                            self.library_changed();
                        }
                    }
                    last_faceit = Some(Instant::now());
                }
                match jobs.recv_timeout(Duration::from_secs(20)) {
                    Ok(Job::Render(ids)) => pending_render.extend(ids),
                    Ok(Job::RenderClips(items)) => pending_clips.extend(items),
                    Ok(Job::Faceit) => last_faceit = None,
                    Ok(Job::Import(files)) => self.forget(&files),
                    Ok(Job::RenderLineups(ids)) => pending_lineups.extend(ids),
                    Err(RecvTimeoutError::Disconnected) => return,
                    _ => {}
                }
                continue;
            }
            // Get demos first, processing after: the demo queue sends Job::Now when it's done.
            if crate::demos::downloading(&self.app) {
                match jobs.recv_timeout(Duration::from_secs(5)) {
                    Ok(Job::Render(ids)) => pending_render.extend(ids),
                    Ok(Job::RenderClips(items)) => pending_clips.extend(items),
                    Ok(Job::Faceit) => last_faceit = None,
                    Ok(Job::Import(files)) => self.forget(&files),
                    Ok(Job::RenderLineups(ids)) => pending_lineups.extend(ids),
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
            // Steam is back (e.g. after logging out and in again): that message no longer applies.
            if self.status.lock().unwrap().message.starts_with("Log in to Steam") {
                self.set("idle", "Up to date", 0, 0);
            }
            // CS2 is closed and nothing's rendering: if a render was cut short, put the user's
            // own video settings back before they next start CS2.
            if cs2hl_render::session::repair_cut_short_render(me) {
                eprintln!("put back your CS2 video settings after a render was cut short");
            }
            let imported = self.import(&settings, me);
            if imported || !settings.library_dir.join("my_stats.json").exists() {
                let _ = cs2hl_core::details::write_benchmarks(&settings.library_dir, Some(me));
                let _ = batch::migrate_lineup_clips(&settings.library_dir);
            } else if !cs2hl_core::lineups::current(&settings.library_dir) {
                // The lineup rules changed in an update: regroup the throws already analyzed.
                let _ = cs2hl_core::lineups::write(&settings.library_dir);
                let _ = batch::migrate_lineup_clips(&settings.library_dir);
            }
            // Get demos started meanwhile: finish downloading before analyzing or rendering more.
            if crate::demos::downloading(&self.app) {
                continue;
            }
            if !icons_checked || imported {
                self.map_icons(&settings);
                icons_checked = true;
            }
            if settings.faceit_enabled && (was_playing || imported || last_faceit.map_or(true, |t| t.elapsed() > FACEIT_EVERY)) {
                // Real match times and ELO go into the index (and so the calendar and sessions).
                if self.refresh_faceit(&settings, me, false) || faceit_dirty {
                    let _ = ingest::rebuild_index(&settings.library_dir, me);
                    self.library_changed();
                    faceit_dirty = false;
                }
                last_faceit = Some(Instant::now());
            }
            was_playing = false;
            // Clips and lineup videos you asked for come first.
            if !pending_clips.is_empty() {
                self.render(&settings, me, Scope::Items(std::mem::take(&mut pending_clips)));
            }
            if !pending_lineups.is_empty() && !system::cs2_running() {
                self.render_lineups(&settings, me, Some(std::mem::take(&mut pending_lineups)));
            }
            if settings.auto_render || !pending_render.is_empty() {
                let scope =
                    if pending_render.is_empty() { Scope::LatestSession } else { Scope::Matches(std::mem::take(&mut pending_render)) };
                self.render(&settings, me, scope);
                // Then the latest session's worst deaths, for the whiff analyzer.
                if settings.auto_render && settings.auto_lowlights && !system::cs2_running() {
                    let items = latest_lowlights(&settings.library_dir, LOWLIGHTS_PER_MATCH);
                    if !items.is_empty() {
                        self.render(&settings, me, Scope::Items(items));
                    }
                }
                // Then grenade lineup videos, the most thrown first, a batch at a time.
                if settings.auto_render && settings.auto_lineups && !system::cs2_running() {
                    self.render_lineups(&settings, me, None);
                }
            } else if imported {
                self.set("idle", "Up to date", 0, 0);
            }
            // Storage limits (Settings): oldest clips not in a folder, oldest saved demos.
            let (clips, demos) = crate::clips::enforce(&settings);
            if clips + demos > 0 {
                let _ = ingest::rebuild_index(&settings.library_dir, me);
                self.library_changed();
            }
            // Older matches: their match-page details (aim, utility, ...), a minute at a time.
            if self.backfill_details(&settings, me) {
                self.library_changed();
            }
            if self.status.lock().unwrap().state != "error" {
                self.set("idle", "Up to date", 0, 0);
            }
            match jobs.recv_timeout(POLL) {
                Ok(Job::Render(ids)) => pending_render.extend(ids),
                Ok(Job::RenderClips(items)) => pending_clips.extend(items),
                Ok(Job::Faceit) => last_faceit = None,
                Ok(Job::Import(files)) => self.forget(&files),
                Ok(Job::RenderLineups(ids)) => pending_lineups.extend(ids),
                Err(RecvTimeoutError::Disconnected) => return,
                _ => {}
            }
        }
    }

    /// Builds missing (or outdated) match-page details for matches whose demo is still on disk,
    /// newest first, for up to a minute; stops when CS2 opens or Get demos starts. Returns whether
    /// any were built (benchmarks are refreshed then).
    fn backfill_details(&self, settings: &Settings, me: u64) -> bool {
        let lib = &settings.library_dir;
        let Ok(index) = std::fs::read_to_string(lib.join("index.json")).map_err(anyhow::Error::from).and_then(|t| Ok(serde_json::from_str::<Index>(&t)?))
        else {
            return false;
        };
        let mut todo: Vec<(i64, String)> = index
            .matches
            .iter()
            .filter(|m| cs2hl_core::details::stale(lib, &m.id))
            .map(|m| (m.played_ts, m.id.clone()))
            .collect();
        todo.sort_by_key(|(ts, _)| std::cmp::Reverse(*ts));
        let total = todo.len();
        let started = Instant::now();
        let mut built = 0;
        for (i, (_, id)) in todo.into_iter().enumerate() {
            if started.elapsed() > Duration::from_secs(60) || system::cs2_running() || crate::demos::downloading(&self.app) {
                break;
            }
            let Some(entry) = std::fs::read_to_string(lib.join("matches").join(format!("{id}.json")))
                .ok()
                .and_then(|t| serde_json::from_str::<MatchEntry>(&t).ok())
            else {
                continue;
            };
            let demo_path = Path::new(&entry.demo_path);
            if !demo_path.exists() {
                continue; // the demo was deleted (storage limit): nothing to build from
            }
            self.set("details", format!("Match details {} of {total}", i + 1), i, total);
            let result = cs2hl_core::demo_io::read_demo(demo_path).and_then(|demo| {
                let m = cs2hl_core::model::load_match(&demo)?;
                let a = cs2hl_core::analysis::analyze(&m);
                cs2hl_core::details::write(lib, &id, &demo, &m, &a, me)
            });
            match result {
                Ok(()) => built += 1,
                Err(e) => eprintln!("details {id}: {e:#}"),
            }
        }
        if built > 0 {
            let _ = cs2hl_core::details::write_benchmarks(lib, Some(me));
            let _ = batch::migrate_lineup_clips(lib);
        }
        built > 0
    }

    /// Names the user may go by on FACEIT: the one set in Settings, the names they played under
    /// in FACEIT demos (FACEIT servers use the FACEIT nickname), and their Steam name.
    fn faceit_names(&self, settings: &Settings, me: u64) -> Vec<String> {
        let lib = &settings.library_dir;
        let mut names = vec![settings.faceit_nickname.trim().to_string()];
        let index: Option<Index> = std::fs::read_to_string(lib.join("index.json")).ok().and_then(|t| serde_json::from_str(&t).ok());
        if let Some(index) = index {
            let me_s = me.to_string();
            for m in index.matches.iter().rev().filter(|m| m.source == "faceit").take(10) {
                let entry: Option<MatchEntry> =
                    std::fs::read_to_string(lib.join("matches").join(format!("{}.json", m.id))).ok().and_then(|t| serde_json::from_str(&t).ok());
                if let Some(p) = entry.as_ref().and_then(|e| e.players.iter().find(|p| p.steamid == me_s)) {
                    names.push(p.name.clone());
                }
            }
            names.push(index.me_name);
        }
        names.extend(system::steam_persona_name());
        let mut seen = std::collections::HashSet::new();
        names.retain(|n| !n.trim().is_empty() && seen.insert(n.to_lowercase()));
        names
    }

    /// Refreshes `faceit.json`; returns whether it changed. Light refreshes (while CS2 is open)
    /// skip reading the library for nickname hints once the account is known.
    fn refresh_faceit(&self, settings: &Settings, me: u64, light: bool) -> bool {
        let lib = &settings.library_dir;
        let known = Faceit::load(lib).is_some_and(|f| f.steamid == me.to_string() && !f.player_id.is_empty());
        let names = if light && known { vec![settings.faceit_nickname.clone()] } else { self.faceit_names(settings, me) };
        match faceit::refresh(lib, me, &names, light) {
            Ok((_, changed)) => changed,
            Err(e) => {
                eprintln!("faceit: {e:#}");
                // Keep what we had through network hiccups; otherwise tell the app why it's empty.
                let same = Faceit::load(lib).is_some_and(|f| f.steamid == me.to_string() && f.error.as_deref() == Some(e.to_string().as_str()));
                if known || same {
                    return false;
                }
                let f = Faceit { steamid: me.to_string(), fetched_at: chrono::Utc::now().timestamp(), error: Some(e.to_string()), ..Default::default() };
                let _ = f.save(lib);
                true
            }
        }
    }

    fn map_icons(&self, settings: &Settings) {
        let lib = &settings.library_dir;
        let mut maps: Vec<String> = std::fs::read_to_string(lib.join("index.json"))
            .ok()
            .and_then(|t| serde_json::from_str::<Index>(&t).ok())
            .map(|i| i.matches.into_iter().map(|m| m.map).collect())
            .unwrap_or_default();
        maps.extend(Faceit::load(lib).into_iter().flat_map(|f| f.matches.into_iter().map(|m| m.map)));
        maps.sort();
        maps.dedup();
        mapicons::ensure(lib, &maps);
        mapicons::ensure_weapons(lib);
        mapicons::ensure_radars(lib, &maps);
        mapicons::ensure_shots(lib, &maps);
    }

    /// New demo files in the watched folders, newest first, skipping ones still downloading.
    fn new_demos(&self, settings: &Settings) -> Vec<(PathBuf, String)> {
        let mut found = vec![];
        // Demos saved from Veloxify's FACEIT window land in its own folder.
        for dir in settings.watch_dirs.iter().cloned().chain([crate::demos::demos_dir()]) {
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

    /// Lets these demo files (names in the demos folder) be imported again.
    fn forget(&mut self, files: &[String]) {
        let before = self.seen.files.len();
        self.seen.files.retain(|k| {
            let path = k.split('|').next().unwrap_or_default();
            let name = Path::new(path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            !files.contains(&name)
        });
        self.failed.retain(|k, _| !files.iter().any(|f| k.contains(f.as_str())));
        if self.seen.files.len() != before {
            self.seen.save();
        }
    }

    fn import(&mut self, settings: &Settings, me: u64) -> bool {
        let demos = self.new_demos(settings);
        if demos.is_empty() {
            return false;
        }
        let policy = settings.clip_policy();
        let total = demos.len();
        let mut added = 0;
        for (i, (path, key)) in demos.into_iter().enumerate() {
            if system::cs2_running() || crate::demos::downloading(&self.app) {
                break; // the user started playing, or Get demos: stop and pick up later
            }
            self.set("importing", format!("Analyzing match {} of {}", i + 1, total), i, total);
            match ingest::add_demo(&settings.library_dir, &path, me, &policy, false) {
                Ok(Added::Added { .. }) => added += 1,
                Ok(Added::Skipped { reason, .. }) => log_import(&path, &format!("skipped: {reason}")),
                Ok(Added::Cached { .. }) => {}
                Err(e) => {
                    // Often passing (a file busy for a moment): try again on a later pass.
                    let tries = self.failed.entry(key.clone()).or_default();
                    *tries += 1;
                    log_import(&path, &format!("failed (try {tries} of {IMPORT_TRIES}): {e:#}"));
                    if *tries < IMPORT_TRIES {
                        continue;
                    }
                }
            }
            self.failed.remove(&key);
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
        self.run_batch(settings, me, Batch::Clips(scope));
    }

    fn render_lineups(&self, settings: &Settings, me: u64, ids: Option<Vec<String>>) {
        self.run_batch(settings, me, Batch::Lineups(ids));
    }

    fn run_batch(&self, settings: &Settings, me: u64, what: Batch) {
        let lib = settings.library_dir.clone();
        if !lib.join("index.json").exists() {
            return;
        }
        let empty = match &what {
            Batch::Clips(scope) => batch::plan(&lib, scope).map_or(true, |p| p.is_empty()),
            Batch::Lineups(ids) => batch::plan_lineups(&lib, ids.as_deref()).is_empty(),
        };
        if empty {
            return;
        }
        let lineups = matches!(what, Batch::Lineups(_));
        let noun = if lineups { "lineup videos" } else { "highlights" };
        let profile = match Profile::load(&settings.profile) {
            Ok(p) => p,
            Err(e) => {
                self.set("error", format!("Render profile: {e}"), 0, 0);
                return;
            }
        };
        // A FACEIT match found means you're about to need CS2: don't start, and stop if one comes
        // up while rendering (checked every 15 s), so CS2 is free before you hit Connect.
        let player_id = Faceit::load(&lib).map(|f| f.player_id).filter(|p| !p.is_empty());
        if let Some(pid) = &player_id {
            if faceit::in_match(pid) == Some(true) {
                self.set("waiting", "FACEIT match in progress; clips after it", 0, 0);
                return;
            }
        }
        let work = data_dir().join("work");
        self.abort.store(false, Ordering::SeqCst);
        let rendering = Arc::new(AtomicBool::new(true));
        let match_found = Arc::new(AtomicBool::new(false));
        if let Some(pid) = player_id {
            let (rendering, match_found, abort) = (rendering.clone(), match_found.clone(), self.abort.clone());
            std::thread::spawn(move || {
                while rendering.load(Ordering::SeqCst) {
                    if faceit::in_match(&pid) == Some(true) {
                        match_found.store(true, Ordering::SeqCst);
                        abort.store(true, Ordering::SeqCst);
                        return;
                    }
                    for _ in 0..15 {
                        if !rendering.load(Ordering::SeqCst) {
                            return;
                        }
                        std::thread::sleep(Duration::from_secs(1));
                    }
                }
            });
        }
        let mut total = 0;
        let mut done = 0;
        let abort = self.abort.clone();
        let mut on = |e: Event| match e {
            Event::Plan { total: t } => {
                total = t;
                self.set("rendering", format!("Rendering {t} {noun}"), 0, t);
                // Lineup videos run quietly after the highlights; highlights get a heads-up.
                if !lineups {
                    self.notify(
                        "Rendering your highlights",
                        &format!(
                            "{t} clip{} from your session. CS2 runs hidden for a few minutes; \"Stop rendering\" in the tray hands it back.",
                            if t == 1 { "" } else { "s" }
                        ),
                    );
                }
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
                if rendered > 0 && !lineups {
                    self.notify("Your highlights are ready", &format!("{rendered} new highlight{} from your session", if rendered == 1 { "" } else { "s" }));
                }
            }
            Event::Stopped { rendered, wants_cs2 } => {
                // Veloxify never starts CS2 for you (it could be left running with nobody there):
                // it closes its own and you start CS2 from Steam as usual.
                let left = total.saturating_sub(rendered);
                let wants_cs2 = wants_cs2 || match_found.load(Ordering::SeqCst);
                self.notify(
                    if match_found.load(Ordering::SeqCst) { "FACEIT match found: CS2 is free" } else if wants_cs2 { "CS2 is free" } else { "Rendering stopped" },
                    &format!(
                        "{}{rendered} clip{} done; {left} more after your next game.",
                        if wants_cs2 { "Veloxify closed its CS2; start CS2 from Steam. " } else { "" },
                        if rendered == 1 { "" } else { "s" }
                    ),
                );
            }
            Event::Log(_) => {}
        };
        let result = match what {
            Batch::Clips(scope) => batch::render(&lib, me, profile, &work, scope, None, abort, &mut on),
            Batch::Lineups(ids) => {
                let limit = if ids.is_some() { usize::MAX } else { LINEUPS_PER_RUN };
                batch::render_lineups(&lib, me, profile, &work, ids, limit, abort, &mut on)
            }
        };
        rendering.store(false, Ordering::SeqCst);
        if let Err(e) = result {
            self.set("error", format!("Rendering stopped: {e:#}"), done, total);
        }
    }
}

pub fn library_file(lib: &Path, rel: &str) -> Option<PathBuf> {
    // Only files inside the library, addressed by their library-relative path.
    let p = lib.join(rel);
    let canon = p.canonicalize().ok()?;
    canon.starts_with(lib.canonicalize().ok()?).then_some(canon)
}

/// Lowlights rendered automatically per match (the worst ones; the rest render on Watch).
const LOWLIGHTS_PER_MATCH: usize = 3;

/// The latest session's worst lowlights still without a clip: (match id, lowlight id).
fn latest_lowlights(lib: &Path, per_match: usize) -> Vec<(String, String)> {
    let Some(index) = std::fs::read_to_string(lib.join("index.json")).ok().and_then(|t| serde_json::from_str::<Index>(&t).ok()) else {
        return vec![];
    };
    let curation = cs2hl_core::curation::Curation::load(lib);
    let ids = index.days.last().and_then(|d| d.sessions.last()).map(|s| s.match_ids.clone()).unwrap_or_default();
    let mut out = vec![];
    for id in ids {
        let Some(m) = std::fs::read_to_string(lib.join("matches").join(format!("{id}.json"))).ok().and_then(|t| serde_json::from_str::<MatchEntry>(&t).ok())
        else {
            continue;
        };
        // Lowlights are stored worst first.
        out.extend(
            m.lowlights
                .iter()
                .filter(|l| !curation.deleted.contains(&l.id))
                .take(per_match)
                .filter(|l| l.clip.is_none() && l.render_error.is_none())
                .map(|l| (id.clone(), l.id.clone())),
        );
    }
    out
}

/// Why a demo wasn't imported, appended to `import.log` in the app's data folder.
fn log_import(path: &Path, what: &str) {
    use std::io::Write as _;
    eprintln!("import {}: {what}", path.display());
    let line = format!("{} {}: {what}\n", chrono::Local::now().format("%Y-%m-%d %H:%M:%S"), path.display());
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(data_dir().join("import.log")) {
        let _ = f.write_all(line.as_bytes());
    }
}
