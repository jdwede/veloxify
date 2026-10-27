//! Veloxify desktop app: tray icon, the library window, and the background worker.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// Writes a line to Veloxify's log (see `log.rs`), like `eprintln!`.
macro_rules! vlog {
    ($($t:tt)*) => { crate::log::line(format!($($t)*)) };
}

mod clips;
mod demos;
mod faceit;
mod league;
mod log;
mod mapicons;
mod players;
mod practice;
mod premier;
mod settings;
mod share;
mod system;
mod tracking;
mod updater;
mod viewer;
mod worker;

use serde::{Deserialize, Serialize};
use settings::{RenderOptions, Settings};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, State, WindowEvent};
use worker::{Job, Status, Worker};

struct AppState {
    settings: Arc<Mutex<Settings>>,
    status: Arc<Mutex<Status>>,
    jobs: Mutex<Sender<Job>>,
    abort: Arc<AtomicBool>,
}

#[tauri::command]
fn library_root(state: State<AppState>) -> String {
    state.settings.lock().unwrap().library_dir.display().to_string()
}

#[tauri::command]
fn get_status(state: State<AppState>) -> Status {
    state.status.lock().unwrap().clone()
}

#[tauri::command]
fn process_now(state: State<AppState>) {
    let _ = state.jobs.lock().unwrap().send(Job::Now);
}

fn sixty() -> u32 {
    60
}

/// Film now instead of waiting out the time after playing.
#[tauri::command]
fn film_now(state: State<AppState>) {
    let _ = state.jobs.lock().unwrap().send(Job::FilmNow);
}

#[tauri::command]
fn stop_rendering(state: State<AppState>) {
    state.abort.store(true, Ordering::SeqCst);
}

#[tauri::command]
fn render_matches(state: State<AppState>, ids: Vec<String>) {
    worker::asked();
    let _ = state.jobs.lock().unwrap().send(Job::Render(ids));
}

#[tauri::command]
fn show_in_folder(state: State<AppState>, rel: String) -> Result<(), String> {
    let lib = state.settings.lock().unwrap().library_dir.clone();
    let path = worker::library_file(&lib, &rel).ok_or("file not found")?;
    std::process::Command::new("explorer").arg(format!("/select,{}", path.display())).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

/// Puts the clip file itself on the clipboard (paste into Discord, Explorer, ...).
#[tauri::command]
fn copy_file(state: State<AppState>, rel: String) -> Result<(), String> {
    let lib = state.settings.lock().unwrap().library_dir.clone();
    let path = worker::library_file(&lib, &rel).ok_or("file not found")?;
    share::to_clipboard(&path)
}

#[derive(Serialize)]
struct SharedView {
    mb: f64,
    height: u32,
}

/// A copy of the clip that fits Discord's upload limit (`limit_mb`), with the Veloxify mark, on the
/// clipboard: paste it into Discord. Not while you're playing (it'd cost you frames) or while
/// Veloxify films (the filming would stutter): "playing" / "filming" then.
#[tauri::command]
async fn copy_for_discord(state: State<'_, AppState>, rel: String, limit_mb: u32) -> Result<SharedView, String> {
    if state.status.lock().unwrap().state == "rendering" {
        return Err("filming".into());
    }
    if system::cs2_running() {
        return Err("playing".into());
    }
    let lib = state.settings.lock().unwrap().library_dir.clone();
    let path = worker::library_file(&lib, &rel).ok_or("file not found")?;
    let shared = tauri::async_runtime::spawn_blocking(move || share::discord_copy(&path, limit_mb.clamp(8, 500)))
        .await
        .map_err(|e| e.to_string())??;
    share::to_clipboard(&shared.path)?;
    Ok(SharedView { mb: shared.bytes as f64 / 1e6, height: shared.height })
}

/// Filming stopped for something (sharing a clip): carry on with it now.
#[tauri::command]
fn resume_filming(state: State<AppState>) {
    let _ = state.jobs.lock().unwrap().send(Job::Resume);
}

#[derive(Serialize)]
struct SettingsView {
    settings: Settings,
    /// The account logged in to Steam right now (used when no account is pinned in settings).
    /// As text: a SteamID64 is too big for a JavaScript number (it would show rounded).
    detected_steamid: Option<String>,
    steam_name: Option<String>,
    render: RenderOptions,
    clips: usize,
    clip_bytes: u64,
    version: &'static str,
}

fn clip_usage(lib: &std::path::Path) -> (usize, u64) {
    std::fs::read_dir(lib.join("clips"))
        .map(|d| {
            d.flatten()
                .filter(|e| e.path().extension().is_some_and(|x| x == "mp4"))
                .fold((0, 0), |(n, b), e| (n + 1, b + e.metadata().map(|m| m.len()).unwrap_or(0)))
        })
        .unwrap_or((0, 0))
}

#[tauri::command]
fn get_settings(state: State<AppState>) -> SettingsView {
    let s = state.settings.lock().unwrap().clone();
    let (clips, clip_bytes) = clip_usage(&s.library_dir);
    SettingsView {
        render: RenderOptions::load(&s.profile),
        detected_steamid: s.steamid64.or_else(system::active_steam_user).map(|id| id.to_string()),
        steam_name: system::steam_persona_name(),
        clips,
        clip_bytes,
        version: env!("CARGO_PKG_VERSION"),
        settings: s,
    }
}

#[derive(Deserialize)]
struct SettingsUpdate {
    watch_dirs: Vec<PathBuf>,
    auto_render: bool,
    #[serde(default)]
    auto_lowlights: bool,
    #[serde(default = "yes")]
    auto_lineups: bool,
    #[serde(default = "yes")]
    premier_auto: bool,
    #[serde(default = "sixty")]
    film_wait_min: u32,
    faceit_enabled: bool,
    faceit_nickname: String,
    selectivity: String,
    max_per_match: usize,
    start_with_windows: bool,
    #[serde(default)]
    max_clips_gb: f64,
    #[serde(default)]
    max_demos_gb: f64,
    #[serde(default)]
    highlight_kinds: Option<Vec<String>>,
    #[serde(default)]
    clutch_min: Option<u32>,
    #[serde(default)]
    skip_eco: Option<bool>,
    #[serde(default)]
    lowlights_per_match: Option<usize>,
    #[serde(default)]
    lineups_per_map: Option<usize>,
    #[serde(default)]
    lineup_kinds: Option<Vec<String>>,
    #[serde(default)]
    lineup_categories: Option<Vec<String>>,
    render: RenderOptions,
}

#[tauri::command]
fn save_settings(app: tauri::AppHandle, state: State<AppState>, update: SettingsUpdate) -> Result<(), String> {
    let mut s = state.settings.lock().unwrap();
    let rules_before = serde_json::to_string(&s.highlight_rules()).unwrap_or_default();
    if s.start_with_windows != update.start_with_windows {
        system::set_start_with_windows(update.start_with_windows)?;
    }
    let faceit_changed = s.faceit_enabled != update.faceit_enabled || s.faceit_nickname.trim() != update.faceit_nickname.trim();
    s.watch_dirs = update.watch_dirs;
    s.auto_render = update.auto_render;
    s.auto_lowlights = update.auto_lowlights;
    s.auto_lineups = update.auto_lineups;
    let premier_on = !s.premier_auto && update.premier_auto;
    s.premier_auto = update.premier_auto;
    s.film_wait_min = update.film_wait_min.min(24 * 60);
    s.faceit_enabled = update.faceit_enabled;
    s.faceit_nickname = update.faceit_nickname.trim().to_string();
    s.selectivity = update.selectivity;
    s.max_per_match = update.max_per_match.clamp(1, 20);
    s.start_with_windows = update.start_with_windows;
    s.max_clips_gb = update.max_clips_gb.max(0.0);
    s.max_demos_gb = update.max_demos_gb.max(0.0);
    const HIGHLIGHT_KINDS: [&str; 11] = ["ace", "4k", "3k", "2k", "clutch", "ninja", "rare", "precision", "flick", "special", "defuse"];
    if let Some(k) = update.highlight_kinds {
        s.highlight_kinds = k.into_iter().filter(|x| HIGHLIGHT_KINDS.contains(&x.as_str())).collect();
    }
    if let Some(n) = update.clutch_min {
        s.clutch_min = n.clamp(1, 5);
    }
    if let Some(b) = update.skip_eco {
        s.skip_eco = b;
    }
    if let Some(n) = update.lowlights_per_match {
        s.lowlights_per_match = n.min(10);
    }
    if let Some(n) = update.lineups_per_map {
        s.lineups_per_map = n.clamp(1, 200);
    }
    if let Some(k) = update.lineup_kinds {
        s.lineup_kinds = k.into_iter().filter(|x| ["smoke", "molotov", "flash", "he"].contains(&x.as_str())).collect();
    }
    if let Some(c) = update.lineup_categories {
        s.lineup_categories = c.into_iter().filter(|x| x == "instant" || x == "set").collect();
    }
    s.save();
    // What counts as a highlight changed: every match's moments are sorted again (a few seconds,
    // in the background), and the app hears when that's done.
    if serde_json::to_string(&s.highlight_rules()).unwrap_or_default() != rules_before {
        let (lib, policy) = (s.library_dir.clone(), s.clip_policy());
        let me = s.steamid64.or_else(system::active_steam_user);
        std::thread::spawn(move || {
            use tauri::Emitter;
            match cs2hl_core::library::reselect(&lib, &policy) {
                Ok(n) => {
                    vlog!("highlight settings changed: {n} matches sorted again");
                    if let Some(me) = me {
                        let _ = cs2hl_core::ingest::rebuild_index(&lib, me);
                    }
                    let _ = app.emit("veloxify://library", ());
                }
                Err(e) => vlog!("highlight settings changed: {e:#}"),
            }
        });
    }
    update.render.save(&s.profile).map_err(|e| e.to_string())?;
    if faceit_changed && s.faceit_enabled {
        let _ = state.jobs.lock().unwrap().send(Job::Faceit);
    }
    if premier_on {
        let _ = state.jobs.lock().unwrap().send(Job::Premier);
    }
    Ok(())
}

#[tauri::command]
async fn pick_folder(app: tauri::AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    app.dialog().file().blocking_pick_folder().and_then(|p| p.into_path().ok()).map(|p| p.display().to_string())
}

/// What the match's 3D replay has and still needs.
#[tauri::command]
fn viewer_state(state: State<AppState>, id: String) -> Result<viewer::State, String> {
    let lib = state.settings.lock().unwrap().library_dir.clone();
    viewer::state(&lib, &id).map_err(|e| format!("{e:#}"))
}

/// Makes what the 3D replay needs (asked for in the app): the tool once, the map once, the match's
/// movement. Progress comes as `veloxify://viewer` events. Not while Veloxify is filming.
#[tauri::command]
async fn viewer_prepare(app: tauri::AppHandle, state: State<'_, AppState>, id: String) -> Result<(), String> {
    use tauri::Emitter;
    if state.status.lock().unwrap().state == "rendering" {
        return Err("Veloxify is filming: the 3D replay can be prepared when it's done (or stop filming at the top right)".into());
    }
    let lib = state.settings.lock().unwrap().library_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        viewer::prepare(&lib, &id, &|what, done| {
            let _ = app.emit("veloxify://viewer", serde_json::json!({ "id": id, "what": what, "done": done }));
        })
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("{e:#}"))
}

/// Opens the match's demo in CS2 (the user clicked Watch in CS2). Returns the console command to
/// paste when CS2 is already open.
#[tauri::command]
async fn watch_in_cs2(state: State<'_, AppState>, id: String) -> Result<Option<String>, String> {
    if state.status.lock().unwrap().state == "rendering" {
        return Err("Veloxify is filming in CS2 right now: stop it first (top right), then watch".into());
    }
    let lib = state.settings.lock().unwrap().library_dir.clone();
    tauri::async_runtime::spawn_blocking(move || viewer::watch_in_cs2(&lib, &id)).await.map_err(|e| e.to_string())?.map_err(|e| format!("{e:#}"))
}

/// The newest release when it's newer than this Veloxify (checked at start, then every 6 hours).
static UPDATE: Mutex<Option<updater::Update>> = Mutex::new(None);

#[tauri::command]
fn get_update() -> Option<updater::Update> {
    UPDATE.lock().unwrap().clone()
}

/// Settings' "Check for updates".
#[tauri::command]
async fn check_update() -> Result<Option<updater::Update>, String> {
    let u = tauri::async_runtime::spawn_blocking(updater::check).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
    *UPDATE.lock().unwrap() = u.clone();
    Ok(u)
}

/// One click: download the new installer, let whatever's running finish, then install quietly
/// (Veloxify closes and the installer reopens it). Never while filming or getting demos.
#[tauri::command]
async fn install_update(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    use tauri::Emitter;
    let u = UPDATE.lock().unwrap().clone().ok_or("No update to install")?;
    if state.status.lock().unwrap().state == "rendering" {
        return Err("Veloxify is filming: stop it first (click the status at the top right), then update".into());
    }
    if demos::downloading(&app) {
        return Err("Veloxify is getting FACEIT demos: update when that's done".into());
    }
    updater::set_updating(true);
    let status = state.status.clone();
    let abort = state.abort.clone();
    let res = tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<()> {
        let path = updater::download(&u, |done, total| {
            let _ = app.emit("veloxify://update-progress", (done, total));
        })?;
        // Something already under way (reading a match) finishes first; filming never gets cut off.
        let t = std::time::Instant::now();
        while matches!(status.lock().unwrap().state.as_str(), "importing" | "rendering") {
            if t.elapsed() > std::time::Duration::from_secs(600) {
                anyhow::bail!("Veloxify is still busy: try again when it's done");
            }
            std::thread::sleep(std::time::Duration::from_secs(1));
        }
        if status.lock().unwrap().state == "rendering" || demos::downloading(&app) {
            anyhow::bail!("Veloxify got busy: try again when it's done");
        }
        vlog!("updating to {}", u.version);
        updater::run_installer(&path)?;
        abort.store(true, Ordering::SeqCst);
        app.exit(0);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|r| r.map_err(|e| format!("{e:#}")));
    if res.is_err() {
        updater::set_updating(false);
    }
    res
}

/// Looks the FACEIT account up again right away (not after whatever the background work is
/// doing) and tells the app how it went; the match list follows on the next background pass.
#[tauri::command]
fn refresh_faceit(app: tauri::AppHandle, state: State<AppState>) {
    let settings = state.settings.lock().unwrap().clone();
    let jobs = state.jobs.lock().unwrap().clone();
    std::thread::spawn(move || refresh_faceit_now(&app, &settings, &jobs));
}

pub fn refresh_faceit_now(app: &tauri::AppHandle, settings: &Settings, jobs: &Sender<Job>) {
    use tauri::Emitter;
    let error = match settings.steamid64.or_else(system::active_steam_user) {
        Some(me) => worker::refresh_faceit(settings, me, false, true).1,
        None => Some("Log in to Steam first: Veloxify finds your FACEIT account from your Steam account".into()),
    };
    let _ = jobs.send(Job::Faceit);
    let _ = app.emit("veloxify://library", ());
    let _ = app.emit("veloxify://faceit", serde_json::json!({ "error": error }));
}

/// Opens a faceit.com page (match room, profile) in the default browser. Only FACEIT paths.
#[tauri::command]
fn open_faceit(path: String) -> Result<(), String> {
    if !path.chars().all(|c| c.is_ascii_alphanumeric() || "-/_".contains(c)) {
        return Err("not a FACEIT page".into());
    }
    let url = format!("https://www.faceit.com/{}", path.trim_start_matches('/'));
    std::process::Command::new("rundll32").args(["url.dll,FileProtocolHandler", &url]).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

/// Downloads these matches' demos (newest first as given) through Veloxify's FACEIT window; see
/// `demos`. Starts a background run and returns right away.
#[tauri::command]
fn get_demos(app: tauri::AppHandle, state: State<AppState>, match_ids: Vec<String>) -> Result<(), String> {
    let settings = state.settings.lock().unwrap().clone();
    let lib = settings.library_dir.clone();
    let mut seen = std::collections::HashSet::new();
    let faceit = cs2hl_core::faceit::Faceit::load(&lib);
    let items: Vec<demos::Item> = match_ids
        .into_iter()
        .filter(|id| id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') && seen.insert(id.clone()))
        .map(|id| {
            let label = faceit
                .as_ref()
                .and_then(|f| f.matches.iter().find(|m| m.match_id == id))
                .map(|m| {
                    let when = chrono::DateTime::from_timestamp(if m.started_ts > 0 { m.started_ts } else { m.finished_ts }, 0)
                        .map(|d| d.with_timezone(&chrono::Local).format("%a %-d %b %H:%M").to_string())
                        .unwrap_or_default();
                    format!("{} {}-{} · {when}", m.map.trim_start_matches("de_"), m.score_mine, m.score_theirs)
                })
                .unwrap_or_else(|| id.clone());
            demos::Item { match_id: id, label }
        })
        .collect();
    let _ = settings;
    // Demos already downloaded (by a run that was cut short, or whose import failed) only need
    // importing: again, even if the importer looked at them before.
    let have: Vec<String> = std::fs::read_dir(demos::demos_dir())
        .map(|d| d.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| !n.ends_with(".part")).collect())
        .unwrap_or_default();
    let (had, items): (Vec<demos::Item>, Vec<demos::Item>) =
        items.into_iter().partition(|i: &demos::Item| have.iter().any(|n| n.starts_with(&format!("{}-", i.match_id))));
    if !had.is_empty() {
        let files: Vec<String> = have.iter().filter(|n| had.iter().any(|i| n.starts_with(&format!("{}-", i.match_id)))).cloned().collect();
        let _ = state.jobs.lock().unwrap().send(Job::Import(files));
    }
    demos::start(&app, items);
    Ok(())
}

/// Opens Veloxify's FACEIT window to sign in (once). Async: creating a window from a main-thread
/// command deadlocks on Windows.
#[tauri::command]
async fn faceit_sign_in(app: tauri::AppHandle) -> Result<(), String> {
    demos::sign_in(&app).map_err(|e| e.to_string())
}

/// The demo queue: "cancel", or "retry" the current match (after signing in to FACEIT).
#[tauri::command]
fn demo_queue(app: tauri::AppHandle, action: String) {
    demos::control(&app, &action);
}

#[tauri::command]
fn demo_queue_state(app: tauri::AppHandle) -> demos::Queue {
    app.state::<std::sync::Arc<std::sync::Mutex<demos::Queue>>>().lock().unwrap().clone()
}

fn library_and_me(state: &State<AppState>) -> (std::path::PathBuf, Option<u64>) {
    let s = state.settings.lock().unwrap();
    (s.library_dir.clone(), s.steamid64.or_else(system::active_steam_user))
}

/// Rebuild the index (when clips changed) and tell the window.
fn library_changed(app: &tauri::AppHandle, lib: &std::path::Path, me: Option<u64>, rebuild: bool) {
    if rebuild {
        if let Some(me) = me {
            let _ = cs2hl_core::ingest::rebuild_index(lib, me);
        }
    }
    use tauri::Emitter;
    let _ = app.emit("veloxify://library", ());
}

/// Renders these clips as soon as CS2 is free: [[match id, clip id], ...].
#[tauri::command]
fn render_clips(state: State<AppState>, items: Vec<(String, String)>) {
    worker::asked();
    let _ = state.jobs.lock().unwrap().send(Job::RenderClips(items));
}

/// Saves the user's names for map areas and lineups (`callouts.json` in the library).
#[tauri::command]
fn save_callouts(state: State<AppState>, callouts: serde_json::Value) -> Result<(), String> {
    let lib = state.settings.lock().unwrap().library_dir.clone();
    std::fs::write(lib.join("callouts.json"), serde_json::to_string_pretty(&callouts).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

/// Saves the user's notes and tags for their sessions (`session_notes.json` in the library).
#[tauri::command]
fn save_session_notes(state: State<AppState>, notes: serde_json::Value) -> Result<(), String> {
    let lib = state.settings.lock().unwrap().library_dir.clone();
    std::fs::write(lib.join("session_notes.json"), serde_json::to_string_pretty(&notes).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

/// Saves the user's favorite crosshairs (`crosshair_favorites.json` in the library).
#[tauri::command]
fn save_crosshair_favorites(state: State<AppState>, favorites: serde_json::Value) -> Result<(), String> {
    let lib = state.settings.lock().unwrap().library_dir.clone();
    std::fs::write(lib.join("crosshair_favorites.json"), serde_json::to_string_pretty(&favorites).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

/// Puts a crosshair in the user's CS2 settings (their saved console variables), for the next time
/// they start CS2. Only while CS2 is closed (it writes its settings when it quits); the file is
/// backed up the first time.
#[tauri::command]
fn apply_crosshair(state: State<AppState>, code: String) -> Result<(), String> {
    let c = cs2hl_core::crosshair::decode(&code).ok_or("That isn't a crosshair code Veloxify can read.")?;
    if system::cs2_running() {
        return Err("CS2 is open (or Veloxify is filming in it). Close it and try again, or copy the code and import it in CS2's crosshair settings.".into());
    }
    let me = state.settings.lock().unwrap().steamid64.or_else(system::active_steam_user).ok_or("Couldn't find your Steam account.")?;
    let dir = cs2hl_render::steam::user_cfg_dir(me);
    let file = dir.join("cs2_user_convars_0_slot0.vcfg");
    let text = std::fs::read_to_string(&file).map_err(|e| format!("Couldn't read your CS2 settings ({e}). Start CS2 once so it makes them."))?;
    let backup = dir.join("cs2_user_convars_0_slot0.vcfg.veloxify-backup");
    if !backup.exists() {
        std::fs::write(&backup, &text).map_err(|e| e.to_string())?;
    }
    let out = cs2hl_core::crosshair::set_in_vcfg(&text, &cs2hl_core::crosshair::convars(&c));
    std::fs::write(&file, out).map_err(|e| e.to_string())?;
    vlog!("crosshair {code} put in {}", file.display());
    Ok(())
}

/// The silent output device CS2's sound is recorded through, if this PC has one.
#[tauri::command]
fn silent_audio_device(state: State<AppState>) -> Option<String> {
    let profile = cs2hl_render::profile::Profile::load(&state.settings.lock().unwrap().profile).ok();
    let preferred = profile.map(|p| p.audio.silent_device).unwrap_or_default();
    cs2hl_render::session::silent_device(&preferred).map(|(_, name)| name)
}

/// Records the clips that have no sound again (with sound, now that there's a silent device).
#[tauri::command]
fn rerender_silent_clips(app: tauri::AppHandle, state: State<AppState>) -> usize {
    let (lib, me) = library_and_me(&state);
    let Some(id) = me else { return 0 };
    let items = cs2hl_render::batch::reset_silent_clips(&lib, id);
    let n = items.len();
    if n > 0 {
        library_changed(&app, &lib, me, true);
        worker::asked();
        let _ = state.jobs.lock().unwrap().send(Job::RenderClips(items));
    }
    n
}

#[tauri::command]
fn delete_clips(app: tauri::AppHandle, state: State<AppState>, ids: Vec<String>) -> Result<usize, String> {
    let (lib, me) = library_and_me(&state);
    let n = clips::delete(&lib, &ids).map_err(|e| e.to_string())?;
    library_changed(&app, &lib, me, true);
    Ok(n)
}

#[tauri::command]
fn create_folder(app: tauri::AppHandle, state: State<AppState>, name: String, items: Vec<String>) -> Result<String, String> {
    let (lib, me) = library_and_me(&state);
    let f = clips::create_folder(&lib, &name).map_err(|e| e.to_string())?;
    if !items.is_empty() {
        let id = f.id.clone();
        clips::update_folders(&lib, |fs| {
            if let Some(f) = fs.iter_mut().find(|f| f.id == id) {
                f.items.extend(items);
            }
        })
        .map_err(|e| e.to_string())?;
    }
    library_changed(&app, &lib, me, false);
    Ok(f.id)
}

/// Folder edits: rename (`name`), delete (`delete`), add or remove clips.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn edit_folder(
    app: tauri::AppHandle,
    state: State<AppState>,
    id: String,
    name: Option<String>,
    delete: Option<bool>,
    add: Option<Vec<String>>,
    remove: Option<Vec<String>>,
) -> Result<(), String> {
    let (lib, me) = library_and_me(&state);
    clips::update_folders(&lib, |fs| {
        if delete == Some(true) {
            fs.retain(|f| f.id != id);
            return;
        }
        if let Some(f) = fs.iter_mut().find(|f| f.id == id) {
            if let Some(n) = name.filter(|n| !n.trim().is_empty()) {
                f.name = n.trim().to_string();
            }
            for i in add.unwrap_or_default() {
                if !f.items.contains(&i) {
                    f.items.push(i);
                }
            }
            let remove = remove.unwrap_or_default();
            f.items.retain(|i| !remove.contains(i));
        }
    })
    .map_err(|e| e.to_string())?;
    library_changed(&app, &lib, me, false);
    Ok(())
}

/// Copies a folder's clips to Videos\Veloxify\<folder> and opens it.
#[tauri::command]
fn export_folder(state: State<AppState>, id: String) -> Result<(String, usize), String> {
    let (lib, _) = library_and_me(&state);
    let (dest, n) = clips::export_folder(&lib, &id).map_err(|e| e.to_string())?;
    let _ = std::process::Command::new("explorer").arg(&dest).spawn();
    Ok((dest.display().to_string(), n))
}

#[tauri::command]
fn storage_usage(state: State<AppState>) -> clips::Usage {
    let (lib, _) = library_and_me(&state);
    clips::usage(&lib)
}

/// Applies the storage limits now. Returns (clips removed, demos removed).
#[tauri::command]
fn clean_up_storage(app: tauri::AppHandle, state: State<AppState>) -> (usize, usize) {
    let settings = state.settings.lock().unwrap().clone();
    let me = settings.steamid64.or_else(system::active_steam_user);
    let r = clips::enforce(&settings);
    library_changed(&app, &settings.library_dir, me, r.0 + r.1 > 0);
    r
}

/// Starts CS2 on a practice preset. If Veloxify is rendering, it stops first and hands CS2 back.
/// If CS2 is already open (you're playing), nothing is launched: the console commands come back
/// so you can paste them.
#[tauri::command]
async fn launch_practice(app: tauri::AppHandle, launch: practice::Launch) -> Result<serde_json::Value, String> {
    let (args, console) = practice::plan(&launch)?;
    let state = app.state::<AppState>();
    if state.status.lock().unwrap().state == "rendering" {
        state.abort.store(true, Ordering::SeqCst);
        for _ in 0..60 {
            std::thread::sleep(std::time::Duration::from_millis(500));
            if state.status.lock().unwrap().state != "rendering" && !system::cs2_running() {
                break;
            }
        }
    }
    if system::cs2_running() {
        return Ok(serde_json::json!({ "launched": false, "console": console }));
    }
    practice::start(&args)?;
    let lib = state.settings.lock().unwrap().library_dir.clone();
    tracking::log_practice(&lib, &launch.kind, &launch.target, &launch.mode);
    Ok(serde_json::json!({ "launched": true, "console": console }))
}

/// Opens a practice website (only the ones the Practice tab links to) in the default browser.
#[tauri::command]
fn open_link(url: String) -> Result<(), String> {
    const ALLOWED: &[&str] = &["https://warmupserver.net/"];
    // Steam profiles: https://steamcommunity.com/profiles/<steamid64>
    let steam_profile = url
        .strip_prefix("https://steamcommunity.com/profiles/")
        .is_some_and(|id| !id.is_empty() && id.len() <= 20 && id.chars().all(|c| c.is_ascii_digit()));
    // The Ko-fi page (Settings → Support Veloxify).
    let kofi = url.strip_prefix("https://ko-fi.com/").is_some_and(|p| !p.is_empty() && p.len() <= 40 && p.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'));
    if !ALLOWED.iter().any(|a| url == *a) && !steam_profile && !kofi {
        return Err("not a link Veloxify opens".into());
    }
    std::process::Command::new("rundll32").args(["url.dll,FileProtocolHandler", &url]).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

/// Steam avatar URLs for these players (cached; fetched off the UI thread).
#[tauri::command]
async fn player_avatars(state: State<'_, AppState>, ids: Vec<String>) -> Result<std::collections::HashMap<String, String>, String> {
    let lib = state.settings.lock().unwrap().library_dir.clone();
    tauri::async_runtime::spawn_blocking(move || players::avatars(&lib, &ids)).await.map_err(|e| e.to_string())
}

fn yes() -> bool {
    true
}

/// Film these grenade lineups' videos now.
#[tauri::command]
fn render_lineups(state: State<AppState>, ids: Vec<String>) {
    worker::asked();
    let _ = state.jobs.lock().unwrap().send(Job::RenderLineups(ids));
}

/// Lineup videos made so far (by lineup id).
/// Which lineups get videos on their own (with these settings, or the saved ones), and how many of
/// them are filmed so far.
#[tauri::command]
fn lineup_plan_info(state: State<AppState>, plan: Option<cs2hl_render::batch::LineupPlan>) -> serde_json::Value {
    let (lib, saved) = {
        let s = state.settings.lock().unwrap();
        (s.library_dir.clone(), s.lineup_plan())
    };
    let plan = plan.unwrap_or(saved);
    let chosen = cs2hl_render::batch::chosen_lineups(&lib, &plan);
    let clips = cs2hl_render::batch::load_lineup_clips(&lib);
    let ids: Vec<&String> = chosen.values().flatten().map(|l| &l.id).collect();
    let filmed = ids.iter().filter(|id| clips.get(id.as_str()).is_some_and(|c| c.clip.is_some())).count();
    serde_json::json!({ "chosen": ids, "filmed": filmed, "maps": chosen.len() })
}

#[tauri::command]
fn lineup_clips(state: State<AppState>) -> std::collections::BTreeMap<String, cs2hl_render::batch::LineupClip> {
    cs2hl_render::batch::load_lineup_clips(&state.settings.lock().unwrap().library_dir)
}

/// Saves a debug report (versions, where Steam and CS2 are, settings, the library's state, the
/// recent log) to the Desktop and shows it in Explorer. Returns where it went.
#[tauri::command]
fn save_debug_log(app: tauri::AppHandle, state: State<AppState>) -> Result<String, String> {
    let settings = state.settings.lock().unwrap().clone();
    let status = state.status.lock().unwrap().clone();
    let report = log::report(&app.package_info().version.to_string(), &settings, &status);
    let dir = app.path().desktop_dir().ok().filter(|d| d.is_dir()).unwrap_or_else(settings::data_dir);
    let path = dir.join(format!("Veloxify debug log {}.txt", chrono::Local::now().format("%Y-%m-%d %H%M")));
    std::fs::write(&path, report).map_err(|e| e.to_string())?;
    let _ = std::process::Command::new("explorer.exe").arg(format!("/select,{}", path.display())).spawn();
    Ok(path.display().to_string())
}

/// Your ESEA league team: season, division, record, roster, standings, division stats, matches.
#[tauri::command]
async fn league_info(state: State<'_, AppState>, force: bool) -> Result<serde_json::Value, String> {
    let lib = state.settings.lock().unwrap().library_dir.clone();
    tauri::async_runtime::spawn_blocking(move || league::league(&lib, force)).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())
}

/// Every player in your league conference this season (FACEIT's per-match stats, cached).
#[tauri::command]
async fn league_division(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let lib = state.settings.lock().unwrap().library_dir.clone();
    tauri::async_runtime::spawn_blocking(move || league::division(&lib)).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())
}

/// Another league team, scouted from FACEIT (profile, seasons, league matches with map votes and
/// stats, players' recent form). Takes a minute the first time.
#[tauri::command]
async fn league_scout(state: State<'_, AppState>, team_id: String) -> Result<serde_json::Value, String> {
    let lib = state.settings.lock().unwrap().library_dir.clone();
    tauri::async_runtime::spawn_blocking(move || league::scout(&lib, &team_id)).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())
}

/// The scouted team's setups and strategies from their downloaded demos (each read once).
#[tauri::command]
async fn scout_demos(state: State<'_, AppState>, team_id: String) -> Result<serde_json::Value, String> {
    let lib = state.settings.lock().unwrap().library_dir.clone();
    let demos = demos::demos_dir();
    tauri::async_runtime::spawn_blocking(move || league::scout_demos(&lib, &team_id, &demos)).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())
}

/// Everyone's FACEIT ELO and level in a FACEIT match (cached).
#[tauri::command]
async fn faceit_roster(state: State<'_, AppState>, match_id: String) -> Result<std::collections::HashMap<String, players::FaceitPlayer>, String> {
    let lib = state.settings.lock().unwrap().library_dir.clone();
    tauri::async_runtime::spawn_blocking(move || players::faceit_roster(&lib, &match_id)).await.map_err(|e| e.to_string())
}

#[tauri::command]
fn save_practice(state: State<AppState>, presets: Vec<serde_json::Value>) {
    let mut s = state.settings.lock().unwrap();
    s.practice = presets;
    s.save();
}

#[tauri::command]
fn open_library(state: State<AppState>) -> Result<(), String> {
    let lib = state.settings.lock().unwrap().library_dir.clone();
    std::process::Command::new("explorer").arg(lib).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn main() {
    // `veloxify --extract-radars de_mirage de_dust2 ...`: write the radars into the library and
    // report what happened (for troubleshooting), without starting the app.
    let args: Vec<String> = std::env::args().collect();
    // `veloxify --premier-matches <out.json>`: the short-lived helper that asks Valve for your
    // recent matchmaking matches (see premier.rs).
    if let Some(i) = args.iter().position(|a| a == "--premier-matches") {
        let out = args.get(i + 1).map(PathBuf::from).unwrap_or_else(|| std::env::temp_dir().join("veloxify-premier.json"));
        std::process::exit(premier::helper_main(&out));
    }
    // `veloxify --scout <team id> <out.json>`: the scouting report's data for a league team (for
    // troubleshooting), without starting the app.
    if let Some(i) = args.iter().position(|a| a == "--scout") {
        let lib = Settings::load().library_dir;
        let out = args.get(i + 2).map(PathBuf::from).unwrap_or_else(|| std::env::temp_dir().join("veloxify-scout.json"));
        let result = league::scout(&lib, args.get(i + 1).map(String::as_str).unwrap_or_default());
        let _ = std::fs::write(&out, match result {
            Ok(v) => serde_json::to_string_pretty(&v).unwrap_or_default(),
            Err(e) => format!("{{\"error\": {:?}}}", e.to_string()),
        });
        return;
    }
    // Prepares a match's 3D replay without the window (testing): the log goes in maps3d/.
    if let Some(i) = args.iter().position(|a| a == "--prepare-3d") {
        let lib = Settings::load().library_dir;
        let _ = std::fs::create_dir_all(lib.join("maps3d"));
        let t0 = std::time::Instant::now();
        let log = std::sync::Mutex::new(String::new());
        let result = viewer::prepare(&lib, args.get(i + 1).map(String::as_str).unwrap_or(""), &|what, done| {
            log.lock().unwrap().push_str(&format!("{:>6.1}s {what} {done:.2}\n", t0.elapsed().as_secs_f64()));
        });
        let text = format!("{}{result:?} after {:.1}s\n", log.lock().unwrap(), t0.elapsed().as_secs_f64());
        let _ = std::fs::write(lib.join("maps3d").join("prepare.log"), text);
        return;
    }
    if let Some(i) = args.iter().position(|a| a == "--extract-radars") {
        let lib = Settings::load().library_dir;
        let maps: Vec<String> = args[i + 1..].to_vec();
        let result = mapicons::extract_radars(&lib, &maps);
        let _ = std::fs::write(lib.join("radars").join("extract.log"), format!("{result:?}
"));
        return;
    }
    // Line of sight in the aim stats comes from CS2's own map files.
    if let Ok(csgo) = cs2hl_render::steam::cs2_csgo_dir() {
        cs2hl_core::mapgeo::set_csgo_dir(csgo);
    }
    let settings = Arc::new(Mutex::new(Settings::load()));
    let status = Arc::new(Mutex::new(Status { state: "idle".into(), message: "Starting".into(), ..Default::default() }));
    let (tx, rx) = std::sync::mpsc::channel();
    let (s2, st2) = (settings.clone(), status.clone());
    let abort = Arc::new(AtomicBool::new(false));
    let abort_menu = abort.clone();
    let abort_worker = abort.clone();

    tauri::Builder::default()
        // One Veloxify at a time (two would process the same library): opening it again just
        // brings up the running one.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(std::sync::Arc::new(std::sync::Mutex::new(demos::Queue::default())))
        .manage(std::sync::Arc::new(std::sync::Mutex::new(demos::Bridge::default())))
        .manage(AppState { settings: settings.clone(), status: status.clone(), jobs: Mutex::new(tx.clone()), abort: abort.clone() })
        .invoke_handler(tauri::generate_handler![
            library_root,
            get_status,
            process_now,
            stop_rendering,
            render_matches,
            copy_for_discord,
            resume_filming,
            show_in_folder,
            copy_file,
            get_settings,
            save_settings,
            pick_folder,
            refresh_faceit,
            get_update,
            check_update,
            viewer_state,
            viewer_prepare,
            watch_in_cs2,
            install_update,
            open_faceit,
            open_library,
            get_demos,
            demo_queue,
            demo_queue_state,
            faceit_sign_in,
            render_clips,
            delete_clips,
            create_folder,
            edit_folder,
            export_folder,
            storage_usage,
            clean_up_storage,
            launch_practice,
            player_avatars,
            faceit_roster,
            league_info,
            render_lineups,
            lineup_clips,
            lineup_plan_info,
            save_practice,
            open_link,
            save_debug_log,
            league_division,
            league_scout,
            film_now,
            scout_demos,
            silent_audio_device,
            rerender_silent_clips,
            save_callouts,
            save_crosshair_favorites,
            apply_crosshair,
            save_session_notes
        ])
        .setup(move |app| {
            // Clips, thumbnails and match data are served from the library folder only.
            let lib = settings.lock().unwrap().library_dir.clone();
            app.asset_protocol_scope().allow_directory(&lib, true)?;
            // The ffmpeg installed with Veloxify (clips are assembled with it); else one on PATH.
            if let Ok(dir) = app.path().resource_dir() {
                let ff = dir.join("ffmpeg").join("ffmpeg.exe");
                if ff.exists() {
                    cs2hl_render::assemble::use_ffmpeg(ff);
                }
            }
            // "Start with Windows" points at this copy (e.g. after installing over a dev build).
            if settings.lock().unwrap().start_with_windows {
                let _ = system::set_start_with_windows(true);
            }
            // Started with Windows: stay in the tray until opened.
            if !std::env::args().any(|a| a == "--hidden") {
                show_main(app.handle());
            }

            let open = MenuItem::with_id(app, "open", "Open Veloxify", true, None::<&str>)?;
            let now = MenuItem::with_id(app, "now", "Process now", true, None::<&str>)?;
            let stop = MenuItem::with_id(app, "stop", "Stop rendering (hand CS2 back)", false, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &now, &stop, &quit])?;
            let tx_menu = tx.clone();
            TrayIconBuilder::with_id("tray")
                .icon(app.default_window_icon().cloned().expect("app icon"))
                .tooltip("Veloxify")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, e| match e.id.as_ref() {
                    "open" => show_main(app),
                    "now" => {
                        let _ = tx_menu.send(Job::Now);
                    }
                    "stop" => abort_menu.store(true, Ordering::SeqCst),
                    "quit" => {
                        // Quitting mid-render still hands CS2 back with the user's settings.
                        abort_menu.store(true, Ordering::SeqCst);
                        app.exit(0)
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, e| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;

            // New releases: shortly after start, then every 6 hours (one small request).
            let app_updates = app.handle().clone();
            std::thread::Builder::new().name("veloxify-updates".into()).spawn(move || {
                use tauri::Emitter;
                std::thread::sleep(std::time::Duration::from_secs(20));
                loop {
                    if let Ok(u) = updater::check() {
                        *UPDATE.lock().unwrap() = u.clone();
                        if let Some(u) = u {
                            let _ = app_updates.emit("veloxify://update", u);
                        }
                    }
                    std::thread::sleep(std::time::Duration::from_secs(6 * 3600));
                }
            })?;

            let worker = Worker::new(app.handle().clone(), s2.clone(), st2.clone(), abort_worker.clone(), Some(stop.clone()));
            std::thread::Builder::new().name("veloxify-worker".into()).spawn(move || worker.run(rx))?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the main window keeps Veloxify running in the tray (other windows, like
            // the FACEIT one, really close; its sign-in stays saved).
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Veloxify");
}
