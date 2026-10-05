//! Getting FACEIT demos with one click each.
//!
//! FACEIT only gives demos to a signed-in account, and asks Cloudflare Turnstile to confirm a
//! person clicked the download, so Veloxify doesn't fetch them on its own. Instead it opens the
//! match room in its own FACEIT window (you sign in there yourself, once; the session persists like
//! a browser's and Veloxify never sees your password), you click FACEIT's download button, and
//! Veloxify saves the file to its demo folder, imports it, and moves on to the next match that's
//! missing its demo.

use crate::settings::data_dir;
use crate::worker::Job;
use crate::AppState;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::webview::{DownloadEvent, NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_notification::NotificationExt;

const LABEL: &str = "faceit";
/// Links in the banner Veloxify adds to the page; intercepted, never loaded.
const CONTROL_HOST: &str = "veloxify.invalid";

#[derive(Clone)]
pub struct Item {
    pub match_id: String,
    /// e.g. "Mirage · Sun 4 Oct 23:00"
    pub label: String,
}

/// Matches waiting for their demo in the FACEIT window, in order.
#[derive(Default)]
pub struct Queue {
    items: Vec<Item>,
    pos: usize,
    saved: usize,
}

pub fn demos_dir() -> PathBuf {
    data_dir().join("demos")
}

fn room_url(match_id: &str) -> Url {
    Url::parse(&format!("https://www.faceit.com/en/cs2/room/{match_id}")).expect("room url")
}

fn is_demo(url: &Url) -> bool {
    let path = url.path().to_ascii_lowercase();
    [".dem", ".dem.zst", ".dem.gz", ".dem.bz2"].iter().any(|x| path.ends_with(x))
}

/// Opens the FACEIT window on the first of `items` (or FACEIT's home page to sign in).
pub fn start(app: &AppHandle, items: Vec<Item>) -> tauri::Result<()> {
    let url = items.first().map(|i| room_url(&i.match_id)).unwrap_or_else(|| Url::parse("https://www.faceit.com/en").unwrap());
    *app.state::<Mutex<Queue>>().lock().unwrap() = Queue { items, pos: 0, saved: 0 };
    if let Some(w) = app.get_webview_window(LABEL) {
        w.navigate(url)?;
        w.show()?;
        w.unminimize()?;
        return w.set_focus();
    }
    build(app, url)
}

fn build(app: &AppHandle, url: Url) -> tauri::Result<()> {
    let (nav_app, dl_app, popup_app) = (app.clone(), app.clone(), app.clone());
    WebviewWindowBuilder::new(app, LABEL, WebviewUrl::External(url))
        .title("Veloxify · FACEIT demos")
        .inner_size(1280.0, 880.0)
        .center()
        .on_page_load(|window, payload| {
            if payload.event() == PageLoadEvent::Finished {
                let js = banner_js(&window.app_handle().state::<Mutex<Queue>>().lock().unwrap());
                let _ = window.eval(&js);
            }
        })
        .on_navigation(move |url| {
            if url.host_str() != Some(CONTROL_HOST) {
                return true;
            }
            let app = nav_app.clone();
            match url.path() {
                "/skip" => {
                    std::thread::spawn(move || advance(&app, false));
                }
                _ => {
                    std::thread::spawn(move || stop(&app));
                }
            }
            false
        })
        .on_new_window(move |url, _| {
            // A demo link opened in a new tab: download it in this window instead.
            if is_demo(&url) {
                let app = popup_app.clone();
                std::thread::spawn(move || {
                    if let Some(w) = app.get_webview_window(LABEL) {
                        let _ = w.navigate(url);
                    }
                });
                return NewWindowResponse::Deny;
            }
            NewWindowResponse::Allow // e.g. "Sign in with Steam"
        })
        .on_download(move |_webview, event| {
            match event {
                DownloadEvent::Requested { url, destination } => {
                    let current = {
                        let q = dl_app.state::<Mutex<Queue>>();
                        let q = q.lock().unwrap();
                        q.items.get(q.pos).map(|i| i.match_id.clone())
                    };
                    let name = url
                        .path_segments()
                        .and_then(|mut s| s.next_back().map(str::to_string))
                        .filter(|n| n.contains(".dem"))
                        .or_else(|| current.map(|id| format!("{id}-1-1.dem.zst")))
                        .unwrap_or_else(|| "faceit-demo.dem.zst".into());
                    let _ = std::fs::create_dir_all(demos_dir());
                    *destination = demos_dir().join(name);
                }
                DownloadEvent::Finished { success, .. } => {
                    let app = dl_app.clone();
                    if success {
                        // Import right away (the worker waits if CS2 is open).
                        let _ = app.state::<AppState>().jobs.lock().unwrap().send(Job::Now);
                        std::thread::spawn(move || advance(&app, true));
                    } else if let Some(w) = app.get_webview_window(LABEL) {
                        let _ = w.eval(&message_js("The download didn't finish. Click download again, or Skip."));
                    }
                }
                _ => {}
            }
            true
        })
        .build()?;
    Ok(())
}

/// Next match in the queue, or done.
fn advance(app: &AppHandle, saved: bool) {
    let next = {
        let q = app.state::<Mutex<Queue>>();
        let mut q = q.lock().unwrap();
        if saved {
            q.saved += 1;
        }
        q.pos += 1;
        q.items.get(q.pos).map(|i| room_url(&i.match_id))
    };
    match next {
        Some(url) => {
            if let Some(w) = app.get_webview_window(LABEL) {
                let _ = w.navigate(url);
            }
        }
        None => finish(app),
    }
}

fn finish(app: &AppHandle) {
    let saved = app.state::<Mutex<Queue>>().lock().unwrap().saved;
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.close();
    }
    if saved > 0 {
        let _ = app
            .notification()
            .builder()
            .title("Demos saved")
            .body(format!("{saved} demo{} saved. Veloxify is analyzing them now.", if saved == 1 { "" } else { "s" }))
            .show();
    }
}

fn stop(app: &AppHandle) {
    let q = app.state::<Mutex<Queue>>();
    let n = q.lock().unwrap().items.len();
    q.lock().unwrap().pos = n;
    finish(app);
}

/// The banner Veloxify shows at the bottom of the FACEIT page.
fn banner_js(q: &Queue) -> String {
    let (text, controls) = match q.items.get(q.pos) {
        Some(item) => (
            format!(
                "Veloxify · demo {} of {} · {} — click Watch demo / download on this page. Not signed in? Sign in once (top right) first.",
                q.pos + 1,
                q.items.len(),
                item.label
            ),
            true,
        ),
        None => ("Veloxify · sign in to FACEIT here once. Your login stays in this window; Veloxify never sees your password.".into(), false),
    };
    BANNER_JS.replace("__TEXT__", &serde_json::to_string(&text).unwrap_or_default()).replace("__CONTROLS__", if controls { "true" } else { "false" })
}

fn message_js(text: &str) -> String {
    format!("(() => {{ const s = document.querySelector('#veloxify-banner span'); if (s) s.textContent = {}; }})()", serde_json::to_string(text).unwrap_or_default())
}

const BANNER_JS: &str = r#"(() => {
  const old = document.getElementById("veloxify-banner");
  if (old) old.remove();
  const d = document.createElement("div");
  d.id = "veloxify-banner";
  d.style.cssText = "position:fixed;z-index:2147483647;left:50%;bottom:18px;transform:translateX(-50%);max-width:min(900px,92vw);" +
    "background:#1e88c7;color:#fff;font:600 14px/1.35 'Segoe UI',system-ui,sans-serif;padding:10px 16px;border-radius:8px;" +
    "box-shadow:0 8px 28px rgba(0,0,0,.55);display:flex;gap:14px;align-items:center";
  const s = document.createElement("span");
  s.textContent = __TEXT__;
  d.appendChild(s);
  if (__CONTROLS__) {
    for (const [label, path] of [["Skip", "skip"], ["Stop", "stop"]]) {
      const a = document.createElement("a");
      a.href = "https://veloxify.invalid/" + path;
      a.textContent = label;
      a.style.cssText = "color:#fff;text-decoration:underline;white-space:nowrap";
      d.appendChild(a);
    }
  }
  document.documentElement.appendChild(d);
})()"#;
