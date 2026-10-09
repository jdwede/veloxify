//! Getting FACEIT demos with one click.
//!
//! FACEIT only gives demos out after a Cloudflare Turnstile check in its own site (and to a
//! signed-in account if it asks for one), and Windows apps can't use your browser's FACEIT login.
//! So Veloxify has its own small FACEIT window, normally out of sight: Get demos opens each match
//! room there and, the way the FACEIT-to-Leetify extension does inside Chrome, asks FACEIT for the
//! demo link, lets FACEIT's own Turnstile check run, receives the signed download link and
//! downloads the demo. The window only shows when FACEIT needs you (sign in once, or Cloudflare
//! wants a box ticked). Nothing about the check is faked or solved: if Cloudflare says no, there's
//! no demo.
//!
//! Downloads come first; the worker analyzes them and captures clips once the whole run is done.

use crate::settings::data_dir;
use crate::worker::Job;
use crate::{system, AppState};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Emitter, Manager, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_notification::NotificationExt;

const LABEL: &str = "faceit";
/// Messages from the page come back as navigations to this host, which are cancelled.
const CONTROL_HOST: &str = "veloxify.invalid";
/// How long one match may take before it's skipped (waiting on Cloudflare included).
const PER_MATCH: Duration = Duration::from_secs(4 * 60);
/// No word from the page for this long: FACEIT may want you (a box to tick), so the window shows.
const STALL: Duration = Duration::from_secs(25);

#[derive(Clone, Serialize, Deserialize)]
pub struct Item {
    pub match_id: String,
    /// e.g. "Mirage 13-10 · Sun 4 Oct 23:00"
    pub label: String,
}

/// The demo queue, shown in the app's status banner.
#[derive(Default, Clone, Serialize)]
pub struct Queue {
    pub items: Vec<Item>,
    /// Matches done with (downloaded or not).
    pub pos: usize,
    /// Demo files downloaded.
    pub saved: usize,
    /// Matches whose demo couldn't be downloaded.
    pub failed: usize,
    /// Their match ids.
    pub skipped: Vec<String>,
    /// How far the current match's download is, 0 to 1.
    pub progress: f32,
    /// Waiting for CS2 to close.
    pub paused: bool,
    /// Something only you can do (sign in, tick FACEIT's box); empty otherwise.
    pub message: String,
    /// The message is "sign in": the FACEIT window offers Try again.
    pub login: bool,
    pub cancelled: bool,
    pub finished: bool,
    /// What's happening, for the log.
    #[serde(skip)]
    pub status: String,
    #[serde(skip)]
    pub run: u64,
}

/// Shared between the window callbacks and the queue thread.
#[derive(Default)]
pub struct Bridge {
    /// The match being fetched.
    pub current: Option<String>,
    pub tx: Option<Sender<Msg>>,
}

#[derive(Debug, Deserialize)]
pub struct Msg {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub urls: Vec<String>,
    #[serde(default)]
    pub error: Option<String>,
    /// "challenge": Cloudflare wants a click; "step:<what>": progress.
    #[serde(default)]
    pub note: Option<String>,
}

/// Veloxify's own demo folder (watched for new demos).
pub fn demos_dir() -> PathBuf {
    data_dir().join("demos")
}

/// Whether Get demos is still downloading (the worker holds off analyzing until it's done).
pub fn downloading(app: &AppHandle) -> bool {
    let q = app.state::<Arc<Mutex<Queue>>>();
    let q = q.lock().unwrap();
    !q.items.is_empty() && !q.finished
}

fn room_url(match_id: &str) -> Url {
    Url::parse(&format!("https://www.faceit.com/en/cs2/room/{match_id}")).expect("room url")
}

/// Sends the queue to the app and to the FACEIT window's banner.
fn publish(app: &AppHandle, q: &Queue) {
    let _ = app.emit("veloxify://demos", q.clone());
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.eval(&banner_js(q));
    }
}

fn update(app: &AppHandle, f: impl FnOnce(&mut Queue)) {
    let state = app.state::<Arc<Mutex<Queue>>>().inner().clone();
    let q = {
        let mut q = state.lock().unwrap();
        f(&mut q);
        q.clone()
    };
    publish(app, &q);
}

/// Shows the FACEIT window because FACEIT needs you. Never takes focus from a running CS2.
fn show_window(app: &AppHandle, focus: bool) {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.show();
        let _ = w.unminimize();
        if focus && !system::cs2_running() {
            let _ = w.set_focus();
        }
    }
}

/// The FACEIT window, created hidden if needed. Must be called off the main thread (window
/// creation in a main-thread command deadlocks on Windows).
fn window(app: &AppHandle, url: Url) -> tauri::Result<tauri::WebviewWindow> {
    if let Some(w) = app.get_webview_window(LABEL) {
        w.navigate(url)?;
        return Ok(w);
    }
    let nav_app = app.clone();
    WebviewWindowBuilder::new(app, LABEL, WebviewUrl::External(url))
        .title("Veloxify · FACEIT")
        .inner_size(1100.0, 780.0)
        .center()
        .visible(false)
        .focused(false)
        .on_page_load(|w, payload| {
            if payload.event() != PageLoadEvent::Finished {
                return;
            }
            let app = w.app_handle().clone();
            let q = app.state::<Arc<Mutex<Queue>>>().lock().unwrap().clone();
            let _ = w.eval(&banner_js(&q));
            // In the room of the match being fetched: run the grab. Every page load, because the
            // first one is usually Cloudflare's "Just a moment" page (the script skips that one
            // and never runs twice on the same page).
            let id = app.state::<Arc<Mutex<Bridge>>>().lock().unwrap().current.clone();
            if let Some(id) = id {
                if payload.url().path().contains(&format!("/room/{id}")) {
                    let _ = w.eval(&GRAB_JS.replace("__ID__", &id));
                }
            }
        })
        .on_navigation(move |url| {
            if url.host_str() != Some(CONTROL_HOST) {
                return true;
            }
            let d = url.query_pairs().find(|(k, _)| k == "d").map(|(_, v)| v.into_owned()).unwrap_or_default();
            let bridge = nav_app.state::<Arc<Mutex<Bridge>>>().inner().clone();
            let tx = bridge.lock().unwrap().tx.clone();
            match url.path() {
                "/msg" => {
                    if let (Some(tx), Ok(m)) = (tx, serde_json::from_str::<Msg>(&d)) {
                        let _ = tx.send(m);
                    }
                }
                "/retry" | "/cancel" => {
                    let action = url.path().trim_start_matches('/').to_string();
                    let app = nav_app.clone();
                    std::thread::spawn(move || control(&app, &action));
                }
                _ => {}
            }
            false
        })
        .on_new_window(|_, _| NewWindowResponse::Allow) // "Sign in with Steam/Google" pop-ups
        .build()
}

/// Opens the FACEIT window (to sign in, or to see what FACEIT wants during Get demos).
pub fn sign_in(app: &AppHandle) -> tauri::Result<()> {
    if app.get_webview_window(LABEL).is_none() {
        window(app, Url::parse("https://www.faceit.com/en").unwrap())?;
    }
    show_window(app, true);
    Ok(())
}

/// Starts fetching these matches' demos (replacing any run in progress).
pub fn start(app: &AppHandle, items: Vec<Item>) {
    if items.is_empty() {
        return;
    }
    let state = app.state::<Arc<Mutex<Queue>>>().inner().clone();
    let run = {
        let mut q = state.lock().unwrap();
        let run = q.run + 1;
        *q = Queue { items, run, status: "Starting".into(), ..Default::default() };
        run
    };
    update(app, |_| {});
    let app = app.clone();
    std::thread::spawn(move || process(app, run));
}

/// "cancel" the run, or "retry" the current match (after signing in).
pub fn control(app: &AppHandle, action: &str) {
    let action = if action == "stop" { "cancel" } else { action };
    if action == "cancel" {
        update(app, |q| {
            q.cancelled = true;
            q.message.clear();
        });
    }
    let tx = app.state::<Arc<Mutex<Bridge>>>().lock().unwrap().tx.clone();
    if let Some(tx) = tx {
        let _ = tx.send(Msg { id: String::new(), urls: vec![], error: Some(format!("control:{action}")), note: None });
    }
}

fn stopped(app: &AppHandle, run: u64) -> bool {
    let q = app.state::<Arc<Mutex<Queue>>>();
    let q = q.lock().unwrap();
    q.run != run || q.cancelled || q.pos >= q.items.len()
}

/// CS2 is open for you to play (not Veloxify's own hidden CS2 capturing clips).
fn playing(app: &AppHandle) -> bool {
    system::cs2_running() && app.state::<AppState>().status.lock().unwrap().state != "rendering"
}

fn process(app: AppHandle, run: u64) {
    let (tx, rx) = channel::<Msg>();
    let bridge = app.state::<Arc<Mutex<Bridge>>>().inner().clone();
    bridge.lock().unwrap().tx = Some(tx);
    loop {
        if stopped(&app, run) {
            break;
        }
        // Never while you play: close the FACEIT window and wait.
        if playing(&app) {
            if let Some(w) = app.get_webview_window(LABEL) {
                let _ = w.close();
            }
            update(&app, |q| {
                q.paused = true;
                q.message.clear();
                q.status = "Waiting for CS2 to close".into();
            });
            std::thread::sleep(Duration::from_secs(5));
            continue;
        }
        let item = {
            let q = app.state::<Arc<Mutex<Queue>>>();
            let q = q.lock().unwrap();
            q.items[q.pos].clone()
        };
        match fetch_one(&app, &rx, &item, run) {
            Outcome::Saved(n) => update(&app, |q| {
                q.saved += n;
                q.pos += 1;
                q.progress = 0.0;
                q.message.clear();
                q.login = false;
            }),
            Outcome::Skip(why) => {
                eprintln!("demo {}: {why}", item.match_id);
                update(&app, |q| {
                    q.failed += 1;
                    q.skipped.push(item.match_id.clone());
                    q.pos += 1;
                    q.progress = 0.0;
                    q.message.clear();
                    q.login = false;
                })
            }
            Outcome::Stop => break,
        }
    }
    // A newer run took over: leave the window and the queue to it.
    if app.state::<Arc<Mutex<Queue>>>().lock().unwrap().run != run {
        return;
    }
    bridge.lock().unwrap().current = None;
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.close();
    }
    update(&app, |q| {
        q.finished = true;
        q.paused = false;
        q.message.clear();
        q.status = "Done".into();
    });
    // Now analyze everything that came in, then capture clips.
    let _ = app.state::<AppState>().jobs.lock().unwrap().send(Job::Now);
    let q = app.state::<Arc<Mutex<Queue>>>().lock().unwrap().clone();
    if q.saved > 0 {
        let failed = if q.failed > 0 { format!(" {} weren't available on FACEIT.", q.failed) } else { String::new() };
        let _ = app
            .notification()
            .builder()
            .title("Demos downloaded")
            .body(format!("{} demo{} downloaded; Veloxify is analyzing them now.{failed}", q.saved, if q.saved == 1 { "" } else { "s" }))
            .show();
    }
}

enum Outcome {
    Saved(usize),
    Skip(String),
    Stop,
}

fn fetch_one(app: &AppHandle, rx: &Receiver<Msg>, item: &Item, run: u64) -> Outcome {
    while rx.try_recv().is_ok() {} // drop anything stale
    app.state::<Arc<Mutex<Bridge>>>().lock().unwrap().current = Some(item.match_id.clone());
    update(app, |q| {
        q.paused = false;
        q.progress = 0.0;
        q.status = "Opening the match on FACEIT".into();
    });
    if let Err(e) = window(app, room_url(&item.match_id)) {
        return Outcome::Skip(e.to_string());
    }
    let started = Instant::now();
    let mut heard = Instant::now();
    loop {
        if stopped(app, run) {
            return Outcome::Stop;
        }
        let msg = match rx.recv_timeout(Duration::from_secs(2)) {
            Ok(m) => m,
            Err(RecvTimeoutError::Timeout) => {
                let Some(w) = app.get_webview_window(LABEL) else {
                    // You closed the FACEIT window: that's a cancel.
                    control(app, "cancel");
                    return Outcome::Stop;
                };
                if started.elapsed() > PER_MATCH {
                    return Outcome::Skip("timed out".into());
                }
                if heard.elapsed() > STALL && !w.is_visible().unwrap_or(true) {
                    show_window(app, false);
                    update(app, |q| q.message = "FACEIT is taking a while. If the FACEIT window shows a box to tick, tick it.".into());
                }
                continue;
            }
            Err(RecvTimeoutError::Disconnected) => return Outcome::Stop,
        };
        // A late message from an earlier match's page.
        if !msg.id.is_empty() && msg.id != item.match_id {
            continue;
        }
        heard = Instant::now();
        match (msg.error.as_deref(), msg.note.as_deref()) {
            (Some("control:cancel"), _) => return Outcome::Stop,
            (Some("control:retry"), _) => {
                // Signed in: load the room again and retry.
                let _ = window(app, room_url(&item.match_id));
                update(app, |q| {
                    q.message.clear();
                    q.login = false;
                    q.status = "Opening the match on FACEIT".into();
                });
                continue;
            }
            (_, Some("challenge")) => {
                show_window(app, true);
                update(app, |q| q.message = "FACEIT wants a quick check: tick the box in the FACEIT window.".into());
                continue;
            }
            (None, Some(step)) if step.starts_with("step:") => {
                update(app, |q| {
                    q.message.clear();
                    q.status = step.trim_start_matches("step:").to_string();
                });
                continue;
            }
            (Some("login"), _) => {
                show_window(app, true);
                update(app, |q| {
                    q.login = true;
                    q.message = "FACEIT wants you to sign in (just once): sign in in the FACEIT window, then press Try again there.".into();
                });
                continue;
            }
            (Some(e), _) => return Outcome::Skip(e.to_string()),
            (None, _) if msg.id == item.match_id => {
                let mut n = 0;
                for (i, url) in msg.urls.iter().enumerate() {
                    match download(app, url, &item.match_id, i, msg.urls.len(), run) {
                        Ok(()) => n += 1,
                        Err(e) => eprintln!("demo download {}: {e}", item.match_id),
                    }
                    if stopped(app, run) {
                        return Outcome::Stop;
                    }
                }
                return if n > 0 { Outcome::Saved(n) } else { Outcome::Skip("download failed".into()) };
            }
            _ => continue,
        }
    }
}

/// Downloads a signed demo link into Veloxify's demo folder, reporting progress. Cancelling
/// deletes the half-downloaded file.
fn download(app: &AppHandle, url: &str, match_id: &str, map: usize, maps: usize, run: u64) -> anyhow::Result<()> {
    let parsed = Url::parse(url)?;
    let name = parsed
        .path_segments()
        .and_then(|mut s| s.next_back().map(str::to_string))
        .filter(|n| n.contains(".dem"))
        .unwrap_or_else(|| format!("{match_id}-{}-1.dem.zst", map + 1));
    let dir = demos_dir();
    std::fs::create_dir_all(&dir)?;
    let dest = dir.join(&name);
    let part = dir.join(format!("{name}.part"));
    let resp = ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(20)).build().get(url).call()?;
    let total: u64 = resp.header("Content-Length").and_then(|v| v.parse().ok()).unwrap_or(0);
    let mut reader = resp.into_reader();
    let mut file = std::fs::File::create(&part)?;
    let mut buf = vec![0u8; 1 << 20];
    let (mut done, mut last) = (0u64, Instant::now());
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n])?;
        done += n as u64;
        if last.elapsed() > Duration::from_millis(400) {
            last = Instant::now();
            if stopped(app, run) {
                drop(file);
                let _ = std::fs::remove_file(&part);
                anyhow::bail!("cancelled");
            }
            let frac = if total > 0 { done as f32 / total as f32 } else { 0.5 };
            update(app, |q| {
                q.progress = (map as f32 + frac.min(1.0)) / maps as f32;
                q.status = "Downloading".into();
            });
        }
    }
    drop(file);
    std::fs::rename(&part, &dest)?;
    Ok(())
}

/// Veloxify's banner at the bottom of the FACEIT window: progress, and what FACEIT wants if
/// anything. Updated in place as the queue moves.
fn banner_js(q: &Queue) -> String {
    let total = q.items.len();
    let state = serde_json::json!({
        "active": total > 0 && !q.finished && !q.cancelled,
        "done": q.pos.min(total),
        "total": total,
        "frac": if total > 0 { (q.pos as f32 + q.progress) / total as f32 } else { 0.0 },
        "message": q.message,
        "login": q.login,
    });
    BANNER_JS.replace("__STATE__", &state.to_string())
}

const BANNER_JS: &str = r#"((s) => {
  let d = document.getElementById("veloxify-banner");
  if (!d) {
    d = document.createElement("div");
    d.id = "veloxify-banner";
    d.style.cssText = "position:fixed;z-index:2147483646;left:50%;bottom:16px;transform:translateX(-50%);width:min(620px,94vw);" +
      "background:#1e88c7;color:#fff;font:700 15px/1.35 'Segoe UI',system-ui,sans-serif;padding:12px 16px;border-radius:8px;" +
      "box-shadow:0 8px 28px rgba(0,0,0,.55)";
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:16px;align-items:center";
    const t = document.createElement("span");
    t.dataset.t = "";
    t.style.flex = "1";
    row.appendChild(t);
    for (const [label, path] of [["Try again", "retry"], ["Cancel", "cancel"]]) {
      const a = document.createElement("a");
      a.href = "https://veloxify.invalid/" + path;
      a.dataset.a = path;
      a.textContent = label;
      a.style.cssText = "color:#fff;text-decoration:underline;white-space:nowrap;font-weight:600";
      row.appendChild(a);
    }
    const bar = document.createElement("div");
    bar.style.cssText = "height:6px;border-radius:3px;background:rgba(255,255,255,.25);margin-top:10px;overflow:hidden";
    const fill = document.createElement("i");
    fill.dataset.f = "";
    fill.style.cssText = "display:block;height:100%;background:#fff;width:0;transition:width .4s";
    bar.appendChild(fill);
    const m = document.createElement("div");
    m.dataset.m = "";
    m.style.cssText = "margin-top:10px;font-weight:500;font-size:13.5px";
    d.append(row, bar, m);
    document.documentElement.appendChild(d);
  }
  const t = d.querySelector("[data-t]"), bar = d.querySelector("[data-f]").parentNode, m = d.querySelector("[data-m]");
  if (!s.active) {
    // Signed in once FACEIT's page is up and shows no "Log in" / "Sign up" button.
    const signedIn = () => {
      const shown = [...document.querySelectorAll("a,button")].filter((e) => e.offsetParent && !d.contains(e));
      if (document.readyState !== "complete" || shown.length < 8) return false;
      return !shown.some((e) => /^(log ?in|sign ?in|sign ?up|register|join faceit)$/i.test((e.innerText || "").trim()));
    };
    const hint = () => {
      t.textContent = signedIn()
        ? "Veloxify · You're signed in to FACEIT. You can close this window."
        : "Veloxify · sign in to FACEIT here (top right). You can close this window when you're done.";
    };
    d.dataset.idle = "1";
    hint();
    clearInterval(window.__veloxifyHint);
    window.__veloxifyHint = setInterval(() => d.dataset.idle === "1" && hint(), 2000);
    bar.style.display = m.style.display = "none";
    d.querySelectorAll("[data-a]").forEach((a) => (a.style.display = "none"));
    return;
  }
  d.dataset.idle = "0";
  t.textContent = `Veloxify · ${s.done}/${s.total} demos downloaded`;
  bar.style.display = "";
  d.querySelector("[data-f]").style.width = (s.frac * 100).toFixed(1) + "%";
  m.textContent = s.message;
  m.style.display = s.message ? "" : "none";
  d.querySelector('[data-a="retry"]').style.display = s.login ? "" : "none";
  d.querySelector('[data-a="cancel"]').style.display = "";
})(__STATE__)"#;

/// Runs in the match room (like the FACEIT-to-Leetify extension): match details, FACEIT's own
/// Turnstile check for "download demos", then the signed download link for each map. Reports
/// back by navigating to veloxify.invalid (cancelled by the app).
const GRAB_JS: &str = r#"(async () => {
  const id = "__ID__";
  // Cloudflare's "Just a moment" page comes first; the app runs this again on the real room.
  if (window._cf_chl_opt || /just a moment/i.test(document.title)) return;
  if (window.__veloxifyGrab === id) return;
  window.__veloxifyGrab = id;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // One message at a time: each is a (cancelled) navigation, and a second one too soon replaces the first.
  let chain = Promise.resolve();
  const send = (o) => (chain = chain.then(async () => {
    location.href = "https://veloxify.invalid/msg?d=" + encodeURIComponent(JSON.stringify(o));
    await sleep(400);
  }));
  const step = (s) => send({ id, note: "step:" + s });

  // FACEIT's Turnstile site key, from FACEIT's own scripts (cached in this window).
  const KEY = /"(0x4AAA[a-zA-Z0-9]{18})"/;
  const findKey = async () => {
    for (const s of document.scripts) {
      const m = KEY.exec(s.textContent || "");
      if (m) return m[1];
    }
    const faceit = (u) => { try { return /(^|\.)faceit(-cdn)?\.(com|net)$/.test(new URL(u).hostname); } catch (e) { return false; } };
    const urls = [...new Set([...[...document.scripts].map((s) => s.src), ...performance.getEntriesByType("resource").map((e) => e.name)])]
      .filter((u) => u && /\.m?js(\?|$)/.test(u) && faceit(u))
      .slice(0, 600);
    for (let i = 0; i < urls.length; i += 8) {
      const texts = await Promise.all(urls.slice(i, i + 8).map((u) => fetch(u).then((r) => (r.ok ? r.text() : ""), () => "")));
      for (const t of texts) {
        const m = KEY.exec(t);
        if (m) return m[1];
      }
    }
    return null;
  };

  try {
    await step("Reading the match");
    const det = await fetch(`https://www.faceit.com/api/match/v2/match/${id}`);
    if (!det.ok) return send({ id, error: `match details ${det.status}` });
    const urls = (await det.json()).payload?.demoURLs || [];
    if (!urls.length) return send({ id, error: "no demo for this match (yet, or any more)" });

    let key = localStorage.getItem("veloxify.turnstileKey");
    if (!key) {
      await step("Finding FACEIT's download check");
      // The room's scripts may still be loading: look again a few times.
      for (let i = 0; i < 4 && !key; i++) {
        if (i) await sleep(3000);
        key = await findKey();
      }
      if (!key) return send({ id, error: "couldn't find FACEIT's download check (FACEIT may have changed its site)" });
      localStorage.setItem("veloxify.turnstileKey", key);
    }
    for (let i = 0; i < 50 && !window.turnstile; i++) {
      if (i === 0 && !document.querySelector('script[src*="challenges.cloudflare.com/turnstile"]')) {
        const s = document.createElement("script");
        s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
        document.head.appendChild(s);
      }
      await sleep(200);
    }
    if (!window.turnstile) return send({ id, error: "FACEIT's check didn't load" });

    const box = document.createElement("div");
    box.style.cssText = "position:fixed;z-index:2147483647;right:20px;bottom:80px";
    document.body.appendChild(box);
    let asked = false;
    const token = () => new Promise((resolve, reject) => {
      const holder = document.createElement("div");
      box.appendChild(holder);
      const fail = (why) => () => { holder.remove(); reject(new Error(why)); };
      window.turnstile.render(holder, {
        sitekey: key,
        action: "matchroomFinished_downloadDemos",
        appearance: "interaction-only",
        callback: (t) => { holder.remove(); resolve(t); },
        "error-callback": fail("FACEIT's check failed"),
        "timeout-callback": fail("FACEIT's check timed out"),
        "before-interactive-callback": () => { if (!asked) { asked = true; send({ id, note: "challenge" }); } },
      });
    });
    const out = [];
    for (const [i, url] of urls.entries()) {
      await step(urls.length > 1 ? `FACEIT's download check (map ${i + 1} of ${urls.length})` : "FACEIT's download check");
      const t = await token();
      const r = await fetch("https://www.faceit.com/api/download/v2/demos/download-url", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resource_url: url, captcha_token: t }),
      });
      if (r.status === 401 || r.status === 403) {
        window.__veloxifyGrab = null; // after signing in, Continue runs it again
        return send({ id, error: "login" });
      }
      if (!r.ok) return send({ id, error: `demo link ${r.status}` });
      const link = (await r.json()).payload?.download_url;
      if (link) out.push(link);
    }
    send({ id, urls: out });
  } catch (e) {
    send({ id, error: String((e && e.message) || e) });
  }
})()"#;
