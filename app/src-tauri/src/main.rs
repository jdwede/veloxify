//! Veloxify desktop app: tray icon, the library window, and the background worker.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod faceit;
mod mapicons;
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
            open_library
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
            // Closing the window keeps Veloxify running in the tray.
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Veloxify");
}
