//! Veloxify desktop app: tray icon, the library window, and the background worker.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod clips;
mod demos;
mod faceit;
mod mapicons;
mod practice;
mod settings;
mod system;
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

#[tauri::command]
fn stop_rendering(state: State<AppState>) {
    state.abort.store(true, Ordering::SeqCst);
}

#[tauri::command]
fn render_matches(state: State<AppState>, ids: Vec<String>) {
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
    let mut c = std::process::Command::new("powershell");
    c.args(["-NoProfile", "-Command", &format!("Set-Clipboard -LiteralPath '{}'", path.display().to_string().replace('\'', "''"))]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    let out = c.output().map_err(|e| e.to_string())?;
    out.status.success().then_some(()).ok_or_else(|| String::from_utf8_lossy(&out.stderr).into_owned())
}

#[derive(Serialize)]
struct SettingsView {
    settings: Settings,
    /// The account logged in to Steam right now (used when no account is pinned in settings).
    detected_steamid: Option<u64>,
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
        detected_steamid: system::active_steam_user(),
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
    faceit_enabled: bool,
    faceit_nickname: String,
    selectivity: String,
    max_per_match: usize,
    start_with_windows: bool,
    #[serde(default)]
    max_clips_gb: f64,
    #[serde(default)]
    max_demos_gb: f64,
    render: RenderOptions,
}

#[tauri::command]
fn save_settings(state: State<AppState>, update: SettingsUpdate) -> Result<(), String> {
    let mut s = state.settings.lock().unwrap();
    if s.start_with_windows != update.start_with_windows {
        system::set_start_with_windows(update.start_with_windows)?;
    }
    let faceit_changed = s.faceit_enabled != update.faceit_enabled || s.faceit_nickname.trim() != update.faceit_nickname.trim();
    s.watch_dirs = update.watch_dirs;
    s.auto_render = update.auto_render;
    s.faceit_enabled = update.faceit_enabled;
    s.faceit_nickname = update.faceit_nickname.trim().to_string();
    s.selectivity = update.selectivity;
    s.max_per_match = update.max_per_match.clamp(1, 20);
    s.start_with_windows = update.start_with_windows;
    s.max_clips_gb = update.max_clips_gb.max(0.0);
    s.max_demos_gb = update.max_demos_gb.max(0.0);
    s.save();
    update.render.save(&s.profile).map_err(|e| e.to_string())?;
    if faceit_changed && s.faceit_enabled {
        let _ = state.jobs.lock().unwrap().send(Job::Faceit);
    }
    Ok(())
}

#[tauri::command]
async fn pick_folder(app: tauri::AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    app.dialog().file().blocking_pick_folder().and_then(|p| p.into_path().ok()).map(|p| p.display().to_string())
}

#[tauri::command]
fn refresh_faceit(state: State<AppState>) {
    let _ = state.jobs.lock().unwrap().send(Job::Faceit);
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
    // Demos already downloaded (e.g. by a run that was cut short) only need importing.
    let have: Vec<String> = std::fs::read_dir(demos::demos_dir())
        .map(|d| d.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| !n.ends_with(".part")).collect())
        .unwrap_or_default();
    let (had, items): (Vec<demos::Item>, Vec<demos::Item>) =
        items.into_iter().partition(|i: &demos::Item| have.iter().any(|n| n.starts_with(&format!("{}-", i.match_id))));
    if !had.is_empty() {
        let _ = state.jobs.lock().unwrap().send(Job::Now);
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
    let _ = state.jobs.lock().unwrap().send(Job::RenderClips(items));
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
    Ok(serde_json::json!({ "launched": true, "console": console }))
}

/// Opens a practice website (only the ones the Practice tab links to) in the default browser.
#[tauri::command]
fn open_link(url: String) -> Result<(), String> {
    const ALLOWED: &[&str] = &["https://warmupserver.net/"];
    if !ALLOWED.iter().any(|a| url == *a) {
        return Err("not a Veloxify practice link".into());
    }
    std::process::Command::new("rundll32").args(["url.dll,FileProtocolHandler", &url]).spawn().map_err(|e| e.to_string())?;
    Ok(())
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
    let settings = Arc::new(Mutex::new(Settings::load()));
    let status = Arc::new(Mutex::new(Status { state: "idle".into(), message: "Starting".into(), ..Default::default() }));
    let (tx, rx) = std::sync::mpsc::channel();
    let (s2, st2) = (settings.clone(), status.clone());
    let abort = Arc::new(AtomicBool::new(false));
    let abort_menu = abort.clone();
    let abort_worker = abort.clone();

    tauri::Builder::default()
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
            show_in_folder,
            copy_file,
            get_settings,
            save_settings,
            pick_folder,
            refresh_faceit,
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
            save_practice,
            open_link
        ])
        .setup(move |app| {
            // Clips, thumbnails and match data are served from the library folder only.
            let lib = settings.lock().unwrap().library_dir.clone();
            app.asset_protocol_scope().allow_directory(&lib, true)?;
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
