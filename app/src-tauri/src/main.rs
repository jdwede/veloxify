//! Veloxify desktop app: tray icon, the library window, and the background worker.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod settings;
mod system;
mod worker;

use settings::Settings;
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

    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .manage(AppState { settings: settings.clone(), status: status.clone(), jobs: Mutex::new(tx.clone()) })
        .invoke_handler(tauri::generate_handler![library_root, get_status, process_now, render_matches, show_in_folder, copy_file])
        .setup(move |app| {
            // Clips, thumbnails and match data are served from the library folder only.
            let lib = settings.lock().unwrap().library_dir.clone();
            app.asset_protocol_scope().allow_directory(&lib, true)?;

            let open = MenuItem::with_id(app, "open", "Open Veloxify", true, None::<&str>)?;
            let now = MenuItem::with_id(app, "now", "Process now", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &now, &quit])?;
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
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, e| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;

            let worker = Worker::new(app.handle().clone(), s2.clone(), st2.clone());
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
