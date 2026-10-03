//! Rendering a library's pending highlights, best "hands" first.
//!
//! Three passes over the pending highlights: 3K+ first, then flashy or always-tier moments, then
//! the rest. Within a pass, highlights are grouped by match (matches ordered by their best hand)
//! and a demo is only reloaded when the next highlight comes from a different match. Each match
//! file is saved as soon as a clip is done, so the app shows clips as they finish and an
//! interrupted run loses nothing.

use crate::assemble::make_thumb;
use crate::profile::Profile;
use crate::session::{DemoIncompatible, Renderer};
use anyhow::{Context, Result};
use cs2hl_core::library::{HighlightEntry, Index, MatchEntry};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Instant;

pub enum Scope {
    LatestSession,
    All,
    Matches(Vec<String>),
}

pub enum Event {
    Plan { total: usize },
    Rendered { match_id: String, title: String, clip_s: f64, took_s: f64 },
    Failed { match_id: String, title: String, error: String },
    Done { rendered: usize, minutes: f64 },
    Log(String),
}

fn band(h: &HighlightEntry) -> u8 {
    if h.hand >= 300 {
        0
    } else if h.hand % 100 >= 25 || h.tier == 3 {
        1
    } else {
        2
    }
}

fn load(path: &Path) -> Result<MatchEntry> {
    Ok(serde_json::from_str(&std::fs::read_to_string(path)?)?)
}

fn save(path: &Path, m: &MatchEntry) -> Result<()> {
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(m)?)?;
    std::fs::rename(tmp, path)?;
    Ok(())
}

/// Highlight ids still to render in `scope`, in render order: (match id, highlight id).
pub fn plan(lib: &Path, scope: &Scope) -> Result<Vec<(String, String)>> {
    let index: Index = serde_json::from_str(&std::fs::read_to_string(lib.join("index.json")).context("library index")?)?;
    let ids: Vec<String> = match scope {
        Scope::Matches(ids) => ids.clone(),
        Scope::All => index.matches.iter().map(|m| m.id.clone()).collect(),
        Scope::LatestSession => index.days.last().and_then(|d| d.sessions.last()).map(|s| s.match_ids.clone()).unwrap_or_default(),
    };
    let mut pending: Vec<(String, HighlightEntry)> = vec![];
    for id in &ids {
        let m = load(&lib.join("matches").join(format!("{id}.json")))?;
        pending.extend(m.highlights.into_iter().filter(|h| h.clip.is_none() && h.render_error.is_none()).map(|h| (id.clone(), h)));
    }
    let mut order = vec![];
    for b in 0..3 {
        let mut groups: BTreeMap<&str, Vec<&HighlightEntry>> = BTreeMap::new();
        for (mid, h) in pending.iter().filter(|(_, h)| band(h) == b) {
            groups.entry(mid.as_str()).or_default().push(h);
        }
        let mut groups: Vec<_> = groups.into_iter().collect();
        groups.sort_by_key(|(_, hs)| std::cmp::Reverse(hs.iter().map(|h| h.hand).max().unwrap_or(0)));
        for (mid, mut hs) in groups {
            hs.sort_by_key(|h| std::cmp::Reverse(h.hand));
            order.extend(hs.into_iter().map(|h| (mid.to_string(), h.id.clone())));
        }
    }
    Ok(order)
}

/// Renders the planned highlights. `limit` caps how many clips this run makes.
pub fn render(lib: &Path, steamid64: u64, profile: Profile, work_dir: &Path, scope: Scope, limit: Option<usize>, on: &mut dyn FnMut(Event)) -> Result<usize> {
    let mut order = plan(lib, &scope)?;
    if let Some(n) = limit {
        order.truncate(n);
    }
    on(Event::Plan { total: order.len() });
    if order.is_empty() {
        return Ok(0);
    }
    let t0 = Instant::now();
    let (log_tx, log_rx) = std::sync::mpsc::channel::<String>();
    let renderer = Renderer::start(steamid64, profile, work_dir, Box::new(move |s| {
        let _ = log_tx.send(s.to_string());
    }))?;
    let drain = |on: &mut dyn FnMut(Event)| {
        while let Ok(s) = log_rx.try_recv() {
            on(Event::Log(s));
        }
    };
    drain(on);
    let demos = std::env::temp_dir().join(format!("veloxify-demos-{}", std::process::id()));
    std::fs::create_dir_all(&demos)?;
    let mut loaded: Option<String> = None;
    let mut broken: Vec<String> = vec![];
    let mut rendered = 0;
    for (mid, hid) in order {
        if broken.contains(&mid) {
            continue;
        }
        let path = lib.join("matches").join(format!("{mid}.json"));
        let mut m = load(&path)?;
        let Some(hi) = m.highlights.iter().position(|h| h.id == hid) else { continue };
        if loaded.as_deref() != Some(mid.as_str()) {
            let dem: PathBuf = demos.join(format!("{mid}.dem"));
            if !dem.exists() {
                std::fs::write(&dem, cs2hl_core::demo_io::read_demo(Path::new(&m.demo_path))?)?;
            }
            match renderer.load_demo(&dem) {
                Ok(()) => loaded = Some(mid.clone()),
                Err(e) if e.downcast_ref::<DemoIncompatible>().is_some() => {
                    for h in m.highlights.iter_mut().filter(|h| h.clip.is_none()) {
                        h.render_error = Some("Recorded on an older CS2 version; CS2 can no longer play this demo.".into());
                    }
                    save(&path, &m)?;
                    broken.push(mid.clone());
                    on(Event::Log(format!("skipping {}: demo from an older CS2 version", m.map)));
                    continue;
                }
                Err(e) => return Err(e),
            }
            drain(on);
        }
        let h = &mut m.highlights[hi];
        let rel = format!("clips/{}.mp4", h.id);
        let ts = Instant::now();
        let segments: Vec<(i32, i32)> = h.segments.clone();
        match renderer.record(&segments, &lib.join(&rel)) {
            Ok(()) => {
                let thumb = format!("clips/{}.jpg", h.id);
                if make_thumb(&lib.join(&rel), &lib.join(&thumb)).is_ok() {
                    h.thumb = Some(thumb);
                }
                h.clip = Some(rel);
                rendered += 1;
                on(Event::Rendered { match_id: mid.clone(), title: h.title.clone(), clip_s: h.duration_s, took_s: ts.elapsed().as_secs_f64() });
            }
            Err(e) => {
                h.render_error = Some(e.to_string());
                on(Event::Failed { match_id: mid.clone(), title: h.title.clone(), error: e.to_string() });
            }
        }
        save(&path, &m)?;
    }
    renderer.close();
    drain(on);
    let _ = std::fs::remove_dir_all(&demos);
    on(Event::Done { rendered, minutes: t0.elapsed().as_secs_f64() / 60.0 });
    Ok(rendered)
}
