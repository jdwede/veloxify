//! Rendering a library's pending highlights, best "hands" first.
//!
//! Three passes over the pending highlights: 3K+ first, then flashy or always-tier moments, then
//! the rest. Within a pass, highlights are grouped by match (matches ordered by their best hand)
//! and a demo is only reloaded when the next highlight comes from a different match. Each match
//! file is saved as soon as a clip is done, so the app shows clips as they finish and an
//! interrupted run loses nothing.

use crate::assemble::{make_thumb, make_thumb_at, SETTLE_S};
use crate::profile::Profile;
use crate::session::{Aborted, DemoIncompatible, Renderer};
use anyhow::{Context, Result};
use cs2hl_core::library::{HighlightEntry, Index, MatchEntry};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Instant;

/// Ticks between samples of the player's health when trimming parts.
const LIFE_STEP: i32 = 8;
const TICKRATE: f64 = 64.0;

/// The player's position and health at the ticks this match's clips need: where CS2's camera
/// must be (their eyes), and when a part has to end (once they die, CS2's camera moves on to
/// someone else). Empty if the demo can't be read.
fn sample_me(demo: &[u8], me: u64, m: &MatchEntry) -> HashMap<i32, (f64, f64, f64)> {
    let settle = (SETTLE_S * TICKRATE) as i32;
    let segments = m.highlights.iter().flat_map(|h| h.segments.iter()).chain(m.lowlights.iter().flat_map(|l| l.segments.iter()));
    let mut ticks: Vec<i32> = segments.flat_map(|&(s, e)| std::iter::once(s - settle).chain((s..=e).step_by(LIFE_STEP as usize))).collect();
    ticks.sort_unstable();
    ticks.dedup();
    let Ok(data) = cs2hl_core::raw::players_series(demo, &[me], &["X", "Y", "health"], &ticks) else { return HashMap::new() };
    data.into_iter()
        .filter_map(|((_, t), v)| Some((t, (*v.get("X")?, *v.get("Y")?, v.get("health").copied().unwrap_or(100.0)))))
        .collect()
}

/// Ends each part a moment after the player dies (and drops parts that would start after it).
fn trim_to_life(segments: &[(i32, i32)], me: &HashMap<i32, (f64, f64, f64)>) -> Vec<(i32, i32)> {
    segments
        .iter()
        .filter_map(|&(s, e)| {
            let death = (s..=e).step_by(LIFE_STEP as usize).find(|t| me.get(t).is_some_and(|p| p.2 <= 0.0));
            let e = death.map_or(e, |d| e.min(d + 16));
            (e - s >= 32).then_some((s, e))
        })
        .collect()
}

pub enum Scope {
    LatestSession,
    All,
    Matches(Vec<String>),
    /// Exactly these clips (match id, highlight or lowlight id), in this order: on-demand renders
    /// such as Watch on a lowlight or a clip removed for space.
    Items(Vec<(String, String)>),
}

pub enum Event {
    Plan { total: usize },
    Rendered { match_id: String, title: String, clip_s: f64, took_s: f64 },
    Failed { match_id: String, title: String, error: String },
    Done { rendered: usize, minutes: f64 },
    /// Stopped early; `wants_cs2` when it was because someone opened CS2 (hand it back).
    Stopped { rendered: usize, wants_cs2: bool },
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
    let curation = cs2hl_core::curation::Curation::load(lib);
    if let Scope::Items(items) = scope {
        let mut out = vec![];
        for (mid, id) in items {
            let Ok(m) = load(&lib.join("matches").join(format!("{mid}.json"))) else { continue };
            let pending = m.highlights.iter().any(|h| &h.id == id && h.clip.is_none() && h.render_error.is_none())
                || m.lowlights.iter().any(|l| &l.id == id && l.clip.is_none() && l.render_error.is_none());
            if pending && !curation.deleted.contains(id) {
                out.push((mid.clone(), id.clone()));
            }
        }
        return Ok(out);
    }
    let index: Index = serde_json::from_str(&std::fs::read_to_string(lib.join("index.json")).context("library index")?)?;
    let ids: Vec<String> = match scope {
        Scope::Matches(ids) => ids.clone(),
        Scope::All => index.matches.iter().map(|m| m.id.clone()).collect(),
        Scope::LatestSession => index.days.last().and_then(|d| d.sessions.last()).map(|s| s.match_ids.clone()).unwrap_or_default(),
        Scope::Items(_) => unreachable!(),
    };
    let mut pending: Vec<(String, HighlightEntry)> = vec![];
    for id in &ids {
        let m = load(&lib.join("matches").join(format!("{id}.json")))?;
        pending.extend(
            m.highlights.into_iter().filter(|h| h.clip.is_none() && h.render_error.is_none() && curation.auto_render(&h.id)).map(|h| (id.clone(), h)),
        );
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

/// Renders the planned highlights. `limit` caps how many clips this run makes; setting `abort`
/// stops at the next safe point (settings restored, CS2 closed, nothing marked as failed).
pub fn render(
    lib: &Path,
    steamid64: u64,
    profile: Profile,
    work_dir: &Path,
    scope: Scope,
    limit: Option<usize>,
    abort: Arc<AtomicBool>,
    on: &mut dyn FnMut(Event),
) -> Result<usize> {
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
    let started = Renderer::start(steamid64, profile, work_dir, abort, Box::new(move |s| {
        let _ = log_tx.send(s.to_string());
    }));
    let renderer = match started {
        Ok(r) => r,
        Err(e) if e.downcast_ref::<Aborted>().is_some() => {
            let wants_cs2 = e.downcast_ref::<Aborted>().unwrap().wants_cs2;
            on(Event::Stopped { rendered: 0, wants_cs2 });
            return Ok(0);
        }
        Err(e) => return Err(e),
    };
    let drain = |on: &mut dyn FnMut(Event)| {
        while let Ok(s) = log_rx.try_recv() {
            on(Event::Log(s));
        }
    };
    drain(on);
    let demos = std::env::temp_dir().join(format!("veloxify-demos-{}", std::process::id()));
    std::fs::create_dir_all(&demos)?;
    let mut loaded: Option<String> = None;
    let mut me_at: HashMap<i32, (f64, f64, f64)> = HashMap::new();
    let mut broken: Vec<String> = vec![];
    let mut rendered = 0;
    let mut stopped = false;
    for (mid, hid) in order {
        if broken.contains(&mid) {
            continue;
        }
        let path = lib.join("matches").join(format!("{mid}.json"));
        let mut m = load(&path)?;
        // A highlight, or a lowlight rendered on request.
        let hi = m.highlights.iter().position(|h| h.id == hid);
        let li = m.lowlights.iter().position(|l| l.id == hid);
        if hi.is_none() && li.is_none() {
            continue;
        }
        if loaded.as_deref() != Some(mid.as_str()) {
            let dem: PathBuf = demos.join(format!("{mid}.dem"));
            let bytes = if dem.exists() {
                std::fs::read(&dem)?
            } else {
                let b = cs2hl_core::demo_io::read_demo(Path::new(&m.demo_path))?;
                std::fs::write(&dem, &b)?;
                b
            };
            me_at = sample_me(&bytes, steamid64, &m);
            drop(bytes);
            let me_name = m.players.iter().find(|p| p.steamid == steamid64.to_string()).map(|p| p.name.clone()).unwrap_or_default();
            match renderer.load_demo(&dem, &me_name) {
                Ok(()) => loaded = Some(mid.clone()),
                Err(e) if e.downcast_ref::<Aborted>().is_some() => {
                    stopped = true;
                    break;
                }
                Err(e) if e.downcast_ref::<DemoIncompatible>().is_some() => {
                    let why = "Recorded on an older CS2 version; CS2 can no longer play this demo.";
                    for h in m.highlights.iter_mut().filter(|h| h.clip.is_none()) {
                        h.render_error = Some(why.into());
                    }
                    for l in m.lowlights.iter_mut().filter(|l| l.clip.is_none()) {
                        l.render_error = Some(why.into());
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
        let (segments, title, duration) = match (hi, li) {
            (Some(i), _) => (m.highlights[i].segments.clone(), m.highlights[i].title.clone(), m.highlights[i].duration_s),
            (None, Some(i)) => (m.lowlights[i].segments.clone(), m.lowlights[i].title.clone(), m.lowlights[i].duration_s),
            _ => unreachable!(),
        };
        let rel = format!("clips/{hid}.mp4");
        let ts = Instant::now();
        // Only while you're alive: after you die, CS2's camera follows someone else.
        let segments = if me_at.is_empty() { segments } else { trim_to_life(&segments, &me_at) };
        let eyes = |t: i32| me_at.get(&t).map(|p| (p.0, p.1));
        let recorded = if segments.is_empty() {
            Err(anyhow::anyhow!("you weren't alive for this moment"))
        } else {
            renderer.record(&segments, &lib.join(&rel), &eyes)
        };
        match recorded {
            Ok(()) => {
                let thumb = format!("clips/{hid}.jpg");
                let thumb = make_thumb(&lib.join(&rel), &lib.join(&thumb)).is_ok().then_some(thumb);
                match (hi, li) {
                    (Some(i), _) => {
                        m.highlights[i].clip = Some(rel);
                        m.highlights[i].thumb = thumb;
                    }
                    (None, Some(i)) => {
                        m.lowlights[i].clip = Some(rel);
                        m.lowlights[i].thumb = thumb;
                    }
                    _ => {}
                }
                // Rendered again on request: no longer "removed for space".
                let mut curation = cs2hl_core::curation::Curation::load(lib);
                if curation.evicted.remove(&hid) {
                    let _ = curation.save(lib);
                }
                rendered += 1;
                on(Event::Rendered { match_id: mid.clone(), title, clip_s: duration, took_s: ts.elapsed().as_secs_f64() });
            }
            Err(e) if e.downcast_ref::<Aborted>().is_some() => {
                stopped = true;
                break;
            }
            Err(e) => {
                match (hi, li) {
                    (Some(i), _) => m.highlights[i].render_error = Some(e.to_string()),
                    (None, Some(i)) => m.lowlights[i].render_error = Some(e.to_string()),
                    _ => {}
                }
                on(Event::Failed { match_id: mid.clone(), title, error: e.to_string() });
            }
        }
        save(&path, &m)?;
        // Keep index.json (and so the Highlights tab) current as each clip finishes.
        let _ = cs2hl_core::ingest::rebuild_index(lib, steamid64);
    }
    let wants_cs2 = renderer.wants_cs2();
    renderer.close();
    drain(on);
    let _ = std::fs::remove_dir_all(&demos);
    if stopped {
        on(Event::Stopped { rendered, wants_cs2 });
    } else {
        on(Event::Done { rendered, minutes: t0.elapsed().as_secs_f64() / 60.0 });
    }
    Ok(rendered)
}

/// A rendered lineup video (`lineup_clips.json`, by lineup id).
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct LineupClip {
    pub clip: Option<String>,
    pub thumb: Option<String>,
    pub error: Option<String>,
    /// Which throw it shows.
    #[serde(default)]
    pub match_id: String,
    #[serde(default)]
    pub tick: i32,
}

pub fn load_lineup_clips(lib: &Path) -> BTreeMap<String, LineupClip> {
    std::fs::read_to_string(lib.join("lineup_clips.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn save_lineup_clips(lib: &Path, clips: &BTreeMap<String, LineupClip>) -> Result<()> {
    let tmp = lib.join("lineup_clips.json.tmp");
    std::fs::write(&tmp, serde_json::to_string(clips)?)?;
    std::fs::rename(tmp, lib.join("lineup_clips.json"))?;
    Ok(())
}

/// Lineups still without a video, most thrown first: the ones asked for (`ids`), or every
/// instant and set lineup (and on-the-move ones thrown 3+ times).
pub fn plan_lineups(lib: &Path, ids: Option<&[String]>) -> Vec<cs2hl_core::lineups::Lineup> {
    let all = cs2hl_core::lineups::load(lib);
    let done = load_lineup_clips(lib);
    let mut todo: Vec<cs2hl_core::lineups::Lineup> = all
        .maps
        .into_values()
        .flat_map(|m| m.lineups)
        .filter(|l| match ids {
            Some(ids) => ids.contains(&l.id),
            None => l.category != "fly" || l.count >= 3,
        })
        .filter(|l| done.get(&l.id).is_none_or(|c| c.clip.is_none() && (ids.is_some() || c.error.is_none())))
        .collect();
    todo.sort_by(|a, b| b.count.cmp(&a.count).then(b.matches.cmp(&a.matches)));
    todo
}

/// Films lineup videos (`lineups/<id>.mp4`): the thrower's view, then the grenade followed until
/// it goes off. Each lineup is filmed from one of its throws whose demo is still on disk.
#[allow(clippy::too_many_arguments)]
pub fn render_lineups(
    lib: &Path,
    steamid64: u64,
    profile: Profile,
    work_dir: &Path,
    ids: Option<Vec<String>>,
    limit: usize,
    abort: Arc<AtomicBool>,
    on: &mut dyn FnMut(Event),
) -> Result<usize> {
    use crate::session::LineupShot;
    let mut todo = plan_lineups(lib, ids.as_deref());
    todo.truncate(limit);
    // Pick each lineup's throw to film (a demo on disk), then film them a demo at a time.
    struct Job {
        id: String,
        title: String,
        kind: String,
        match_id: String,
        tick: i32,
        pop_tick: i32,
        player: String,
    }
    let entry_of = |mid: &str| -> Option<MatchEntry> { load(&lib.join("matches").join(format!("{mid}.json"))).ok() };
    let mut jobs: Vec<Job> = vec![];
    let mut clips = load_lineup_clips(lib);
    for l in &todo {
        let mut options = std::iter::once(&l.video).chain(l.examples.iter());
        let pick = options.find(|o| o.tick > 0 && entry_of(&o.match_id).is_some_and(|e| Path::new(&e.demo_path).exists()));
        match pick {
            Some(o) => jobs.push(Job { id: l.id.clone(), title: l.name.clone(), kind: l.kind.clone(), match_id: o.match_id.clone(), tick: o.tick, pop_tick: o.pop_tick, player: o.player.clone() }),
            None => {
                clips.insert(l.id.clone(), LineupClip { error: Some("None of this lineup's demos are still on disk.".into()), ..Default::default() });
            }
        }
    }
    save_lineup_clips(lib, &clips)?;
    jobs.sort_by(|a, b| a.match_id.cmp(&b.match_id));
    on(Event::Plan { total: jobs.len() });
    if jobs.is_empty() {
        return Ok(0);
    }
    let t0 = Instant::now();
    let (log_tx, log_rx) = std::sync::mpsc::channel::<String>();
    let started = Renderer::start(
        steamid64,
        profile,
        work_dir,
        abort,
        Box::new(move |s| {
            let _ = log_tx.send(s.to_string());
        }),
    );
    let renderer = match started {
        Ok(r) => r,
        Err(e) if e.downcast_ref::<Aborted>().is_some() => {
            on(Event::Stopped { rendered: 0, wants_cs2: e.downcast_ref::<Aborted>().unwrap().wants_cs2 });
            return Ok(0);
        }
        Err(e) => return Err(e),
    };
    let drain = |on: &mut dyn FnMut(Event)| {
        while let Ok(s) = log_rx.try_recv() {
            on(Event::Log(s));
        }
    };
    let demos = std::env::temp_dir().join(format!("veloxify-lineup-demos-{}", std::process::id()));
    std::fs::create_dir_all(&demos)?;
    let mut loaded: Option<String> = None;
    let mut bytes: Vec<u8> = vec![];
    let mut throws: Vec<cs2hl_core::details::DThrow> = vec![];
    let mut names: HashMap<String, String> = HashMap::new();
    let (mut rendered, mut stopped) = (0, false);
    for job in jobs {
        if loaded.as_deref() != Some(job.match_id.as_str()) {
            let Some(m) = entry_of(&job.match_id) else { continue };
            let dem = demos.join(format!("{}.dem", job.match_id));
            bytes = cs2hl_core::demo_io::read_demo(Path::new(&m.demo_path))?;
            std::fs::write(&dem, &bytes)?;
            throws = std::fs::read_to_string(cs2hl_core::details::path(lib, &job.match_id))
                .ok()
                .and_then(|t| serde_json::from_str::<cs2hl_core::details::MatchDetails>(&t).ok())
                .map(|d| d.throws)
                .unwrap_or_default();
            names = m.players.iter().map(|p| (p.steamid.clone(), p.name.clone())).collect();
            let first = names.get(&job.player).cloned().unwrap_or_default();
            match renderer.load_demo(&dem, &first) {
                Ok(()) => loaded = Some(job.match_id.clone()),
                Err(e) if e.downcast_ref::<Aborted>().is_some() => {
                    stopped = true;
                    break;
                }
                Err(e) => {
                    clips.insert(job.id.clone(), LineupClip { error: Some(e.to_string()), match_id: job.match_id.clone(), tick: job.tick, ..Default::default() });
                    save_lineup_clips(lib, &clips)?;
                    continue;
                }
            }
            drain(on);
        }
        let Some(t) = throws.iter().find(|t| t.tick == job.tick && t.player == job.player) else { continue };
        // Long enough before the throw to see the thrower line it up and move into it; long enough
        // after to see it work (a smoke blooms over a couple of seconds).
        let lead = 2.5;
        let hold = match job.kind.as_str() {
            "smoke" => 4.5,
            "molotov" => 3.5,
            _ => 2.0,
        };
        let start = job.tick - (lead * TICKRATE) as i32;
        let sid: u64 = job.player.parse().unwrap_or(0);
        let eye = cs2hl_core::raw::players_series(&bytes, &[sid], &["X", "Y"], &[start]).ok().and_then(|p| p.get(&(sid, start)).map(|v| (v["X"], v["Y"])));
        let shot = LineupShot {
            thrower: names.get(&job.player).cloned().unwrap_or_default(),
            eye,
            throw_tick: job.tick,
            pop_tick: job.pop_tick.max(job.tick + 32),
            path: t.path.iter().map(|p| [p[0] as f64, p[1] as f64, p[2] as f64]).collect(),
            lead_s: lead,
            hold_s: hold,
        };
        let rel = format!("lineups/{}.mp4", job.id);
        let ts = Instant::now();
        match renderer.record_lineup(&shot, &lib.join(&rel)) {
            Ok(()) => {
                // The thumbnail: the thrower lined up, just before the throw.
                let thumb = format!("lineups/{}.jpg", job.id);
                let thumb = make_thumb_at(&lib.join(&rel), &lib.join(&thumb), lead - 0.3).is_ok().then_some(thumb);
                clips.insert(job.id.clone(), LineupClip { clip: Some(rel), thumb, error: None, match_id: job.match_id.clone(), tick: job.tick });
                rendered += 1;
                on(Event::Rendered { match_id: job.match_id.clone(), title: job.title.clone(), clip_s: 7.0, took_s: ts.elapsed().as_secs_f64() });
            }
            Err(e) if e.downcast_ref::<Aborted>().is_some() => {
                stopped = true;
                break;
            }
            Err(e) => {
                clips.insert(job.id.clone(), LineupClip { error: Some(e.to_string()), match_id: job.match_id.clone(), tick: job.tick, ..Default::default() });
                on(Event::Failed { match_id: job.match_id.clone(), title: job.title.clone(), error: e.to_string() });
            }
        }
        save_lineup_clips(lib, &clips)?;
        drain(on);
    }
    let wants_cs2 = renderer.wants_cs2();
    renderer.close();
    drain(on);
    let _ = std::fs::remove_dir_all(&demos);
    if stopped {
        on(Event::Stopped { rendered, wants_cs2 });
    } else {
        on(Event::Done { rendered, minutes: t0.elapsed().as_secs_f64() / 60.0 });
    }
    Ok(rendered)
}
