//! Getting FACEIT demos with one click each, in your own browser.
//!
//! FACEIT only gives demos to a signed-in account and asks Cloudflare Turnstile to confirm a
//! person clicked the download, so Veloxify doesn't fetch them by itself. Instead it opens each
//! match room in your default browser (where you're already signed in), you click FACEIT's
//! download, and Veloxify spots the file in your Downloads folder (or any watched folder) by its
//! match id, analyzes it, and opens the next match that's missing its demo. It never touches your
//! browser's logins or cookies.

use crate::settings::Settings;
use crate::worker::Job;
use crate::AppState;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

/// Give up waiting for one demo after this long (you closed the tab, or the demo is gone).
const WAIT_PER_DEMO: Duration = Duration::from_secs(10 * 60);

#[derive(Clone, Serialize)]
pub struct Item {
    pub match_id: String,
    /// e.g. "Mirage 13-10 · Sun 4 Oct 23:00"
    pub label: String,
}

/// Matches waiting for their demo, in order; shown in the app as a banner.
#[derive(Default, Clone, Serialize)]
pub struct Queue {
    pub items: Vec<Item>,
    pub pos: usize,
    pub saved: usize,
    /// Bumped on every new run so an old watcher thread stops.
    #[serde(skip)]
    pub run: u64,
}

/// Veloxify's own demo folder (also watched for new demos).
pub fn demos_dir() -> PathBuf {
    crate::settings::data_dir().join("demos")
}

fn room_url(match_id: &str) -> String {
    format!("https://www.faceit.com/en/cs2/room/{match_id}")
}

fn open_in_browser(url: &str) {
    let _ = std::process::Command::new("rundll32").args(["url.dll,FileProtocolHandler", url]).spawn();
}

/// A finished demo file for this match in the watched folders (FACEIT names demos
/// `1-<match uuid>-<map>-1.dem.zst`).
fn demo_file(dirs: &[PathBuf], match_id: &str) -> Option<(PathBuf, u64)> {
    let key = match_id.to_ascii_lowercase();
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(dir) else { continue };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_ascii_lowercase();
            if name.contains(&key) && [".dem", ".dem.zst", ".dem.gz", ".dem.bz2"].iter().any(|x| name.ends_with(x)) {
                if let Ok(m) = e.metadata() {
                    return Some((e.path(), m.len()));
                }
            }
        }
    }
    None
}

fn emit(app: &AppHandle, q: &Queue) {
    let _ = app.emit("veloxify://demos", q.clone());
}

/// Starts (or restarts) the queue: opens the first room and watches for each download.
pub fn start(app: &AppHandle, items: Vec<Item>, settings: &Settings) {
    let dirs = settings.watch_dirs.clone();
    // Matches whose demo is already on disk don't need a room opened.
    let items: Vec<Item> = items.into_iter().filter(|i| demo_file(&dirs, i.match_id.trim_start_matches("1-")).is_none()).collect();
    let state = app.state::<Arc<Mutex<Queue>>>().inner().clone();
    let run = {
        let mut q = state.lock().unwrap();
        let run = q.run + 1;
        *q = Queue { items, pos: 0, saved: 0, run };
        emit(app, &q);
        run
    };
    let app = app.clone();
    std::thread::spawn(move || watch(app, state, dirs, run));
}

/// Skip the current match, or stop.
pub fn control(app: &AppHandle, action: &str) {
    let state = app.state::<Arc<Mutex<Queue>>>().inner().clone();
    let mut q = state.lock().unwrap();
    match action {
        "skip" => {
            q.pos += 1;
            if let Some(next) = q.items.get(q.pos) {
                open_in_browser(&room_url(&next.match_id));
            }
        }
        _ => {
            let n = q.items.len();
            q.pos = n;
        }
    }
    emit(app, &q);
}

fn watch(app: AppHandle, state: Arc<Mutex<Queue>>, dirs: Vec<PathBuf>, run: u64) {
    let mut opened: Option<(usize, Instant)> = None;
    let mut last_size: Option<u64> = None;
    loop {
        std::thread::sleep(Duration::from_secs(2));
        let (pos, item) = {
            let q = state.lock().unwrap();
            if q.run != run {
                return; // a newer run took over
            }
            (q.pos, q.items.get(q.pos).cloned())
        };
        let Some(item) = item else {
            finish(&app, &state);
            return;
        };
        if opened.map(|(p, _)| p) != Some(pos) {
            open_in_browser(&room_url(&item.match_id));
            opened = Some((pos, Instant::now()));
            last_size = None;
            continue;
        }
        if let Some((_, size)) = demo_file(&dirs, item.match_id.trim_start_matches("1-")) {
            // Downloaded once its size stops changing.
            if last_size == Some(size) && size > 0 {
                let mut q = state.lock().unwrap();
                if q.run != run || q.pos != pos {
                    continue;
                }
                q.saved += 1;
                q.pos += 1;
                emit(&app, &q);
                drop(q);
                let _ = app.state::<AppState>().jobs.lock().unwrap().send(Job::Now);
                continue;
            }
            last_size = Some(size);
        } else if opened.is_some_and(|(_, t)| t.elapsed() > WAIT_PER_DEMO) {
            // Waited long enough: move on.
            let mut q = state.lock().unwrap();
            if q.run == run && q.pos == pos {
                q.pos += 1;
                emit(&app, &q);
            }
        }
    }
}

fn finish(app: &AppHandle, state: &Arc<Mutex<Queue>>) {
    let saved = state.lock().unwrap().saved;
    if saved > 0 {
        let _ = app
            .notification()
            .builder()
            .title("Demos downloaded")
            .body(format!("{saved} demo{} found in Downloads. Veloxify is analyzing them now.", if saved == 1 { "" } else { "s" }))
            .show();
    }
}
