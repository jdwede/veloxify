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
    /// How many times the lineup had been thrown when it couldn't be filmed: it's tried again
    /// once there are more throws of it.
    #[serde(default)]
    pub count: usize,
    /// It couldn't be filmed because every throw of it is in a demo CS2 can't play any more.
    #[serde(default)]
    pub too_old: bool,
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
        .filter(|l| done.get(&l.id).is_none_or(|c| c.clip.is_none() && (ids.is_some() || c.error.is_none() || l.count > c.count)))
        .collect();
    todo.sort_by(|a, b| b.count.cmp(&a.count).then(b.matches.cmp(&a.matches)));
    todo
}

/// Seconds of the thrower's own view before the throw.
const LINEUP_LEAD_S: f64 = 2.5;

/// The tick the camera is checked at (before the settle time that precedes the clip): where the
/// thrower must be standing then.
fn lineup_check_tick(throw_tick: i32) -> i32 {
    throw_tick - (LINEUP_LEAD_S * TICKRATE) as i32 - (SETTLE_S * TICKRATE) as i32
}

/// Matches whose demos this CS2 can't play (recorded on an older version), never tried again.
fn load_unplayable(lib: &Path) -> std::collections::BTreeSet<String> {
    std::fs::read_to_string(lib.join("unplayable_demos.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn save_unplayable(lib: &Path, set: &std::collections::BTreeSet<String>) {
    let _ = std::fs::write(lib.join("unplayable_demos.json"), serde_json::to_string(set).unwrap_or_default());
}

/// Films lineup videos (`lineups/<id>.mp4`): the thrower's view, then the grenade followed until
/// it goes off. Each lineup is filmed from its newest throw CS2 can play; if that doesn't work
/// (an old demo, the camera not on the thrower), from the next one.
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
    use crate::session::{LineupShot, WrongPov};
    let todo = plan_lineups(lib, ids.as_deref());
    let entry_of = |mid: &str| -> Option<MatchEntry> { load(&lib.join("matches").join(format!("{mid}.json"))).ok() };
    let mut unplayable = load_unplayable(lib);
    let mut clips = load_lineup_clips(lib);
    // Each lineup's throws to try, newest first: demo on disk, not known to be unplayable.
    struct Job {
        id: String,
        title: String,
        kind: String,
        count: usize,
        tries: Vec<cs2hl_core::lineups::Occurrence>,
    }
    // A CS2 update stops older demos playing: anything as old as a demo known not to play is skipped.
    let mut played_at: HashMap<String, Option<i64>> = HashMap::new();
    let mut when = |mid: &str| -> Option<i64> {
        *played_at.entry(mid.to_string()).or_insert_with(|| entry_of(mid).filter(|e| Path::new(&e.demo_path).exists()).map(|e| e.played_ts))
    };
    let mut cutoff = unplayable.iter().filter_map(|m| entry_of(m).map(|e| e.played_ts)).max().unwrap_or(i64::MIN);
    let mut jobs: Vec<Job> = vec![];
    for l in &todo {
        let mut tries: Vec<cs2hl_core::lineups::Occurrence> = vec![];
        for o in std::iter::once(&l.video).chain(l.examples.iter()) {
            if o.tick <= 0 || unplayable.contains(&o.match_id) || tries.iter().any(|t| t.match_id == o.match_id && t.tick == o.tick) {
                continue;
            }
            if when(&o.match_id).is_some_and(|ts| ts > cutoff) {
                tries.push(o.clone());
            }
        }
        if tries.is_empty() {
            clips.insert(
                l.id.clone(),
                LineupClip { error: Some("Every throw of it is in a demo from an older CS2 version, which CS2 can't play any more.".into()), count: l.count, too_old: true, ..Default::default() },
            );
            continue;
        }
        jobs.push(Job { id: l.id.clone(), title: l.name.clone(), kind: l.kind.clone(), count: l.count, tries });
    }
    save_lineup_clips(lib, &clips)?;
    // Loading a demo takes about a minute, filming a lineup about half that: go match by match,
    // each time the playable match with the most lineups still to film (newest on ties), filming
    // all of them from it. Only among the most thrown lineups, so those get their videos first,
    // whatever the map.
    let mut remaining: Vec<Job> = jobs.into_iter().take(limit * 3).collect();
    let mut jobs: Vec<Job> = vec![];
    while jobs.len() < limit && !remaining.is_empty() {
        let mut serves: HashMap<String, usize> = HashMap::new();
        for j in &remaining {
            let mut seen: Vec<&str> = j.tries.iter().map(|t| t.match_id.as_str()).collect();
            seen.sort_unstable();
            seen.dedup();
            for m in seen {
                *serves.entry(m.to_string()).or_default() += 1;
            }
        }
        let Some(best) = serves.iter().max_by_key(|(m, n)| (**n, when(m).unwrap_or(0))).map(|(m, _)| m.clone()) else { break };
        let (take, rest): (Vec<Job>, Vec<Job>) = remaining.into_iter().partition(|j| j.tries.iter().any(|t| t.match_id == best));
        remaining = rest;
        for mut j in take {
            if jobs.len() >= limit {
                break;
            }
            // That match first, then the others (newest first) if it doesn't work out.
            j.tries.sort_by_key(|t| (t.match_id != best, std::cmp::Reverse(when(&t.match_id).unwrap_or(0))));
            jobs.push(j);
        }
    }
    on(Event::Plan { total: jobs.len() });
    if jobs.is_empty() {
        return Ok(0);
    }
    let t0 = Instant::now();
    let (log_tx, log_rx) = std::sync::mpsc::channel::<String>();
    let start = |abort: Arc<AtomicBool>| -> Result<Renderer> {
        let tx = log_tx.clone();
        Renderer::start(
            steamid64,
            profile.clone(),
            work_dir,
            abort,
            Box::new(move |s| {
                let _ = tx.send(s.to_string());
            }),
        )
    };
    let mut renderer = match start(abort.clone()) {
        Ok(r) => Some(r),
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
    // Where each thrower stands when their clip starts, for this demo's lineups (one pass).
    let mut eyes: HashMap<(u64, i32), (f64, f64)> = HashMap::new();
    // Demos that failed to load this run (not necessarily too old: tried again another time).
    let mut failed_loads: std::collections::HashSet<String> = Default::default();
    let (mut rendered, mut stopped) = (0, false);
    // Every throw this run may film: (match, player, tick).
    let all_tries: Vec<(String, String, i32)> = jobs.iter().flat_map(|j| j.tries.iter()).map(|t| (t.match_id.clone(), t.player.clone(), t.tick)).collect();
    // Pass by pass: each lineup's next throw to try, the loaded demo's first. A lineup that fails
    // is tried from its next throw in a later pass, so a failure doesn't make CS2 swap demos back
    // and forth.
    let mut queue: Vec<(Job, usize, String)> = jobs.into_iter().map(|j| (j, 0, String::new())).collect();
    'passes: for _pass in 0..4 {
    if queue.is_empty() {
        break;
    }
    queue.sort_by(|a, b| {
        let (ma, mb) = (a.0.tries[a.1].match_id.as_str(), b.0.tries[b.1].match_id.as_str());
        (Some(ma) != loaded.as_deref()).cmp(&(Some(mb) != loaded.as_deref())).then(ma.cmp(mb))
    });
    let mut next: Vec<(Job, usize, String)> = vec![];
    'jobs: for (job, idx, mut last_error) in std::mem::take(&mut queue) {
        for o in job.tries.iter().skip(idx).take(1) {
            if unplayable.contains(&o.match_id) || failed_loads.contains(&o.match_id) || when(&o.match_id).is_none_or(|ts| ts <= cutoff) {
                continue;
            }
            if abort.load(std::sync::atomic::Ordering::SeqCst) {
                stopped = true;
                break 'passes;
            }
            // The session can be gone after a demo CS2 couldn't load: start a fresh one.
            if renderer.is_none() {
                match start(abort.clone()) {
                    Ok(r) => renderer = Some(r),
                    Err(e) if e.downcast_ref::<Aborted>().is_some() => {
                        stopped = true;
                        break 'passes;
                    }
                    Err(e) => return Err(e),
                }
                loaded = None;
            }
            let r = renderer.as_ref().unwrap();
            if loaded.as_deref() != Some(o.match_id.as_str()) {
                let Some(m) = entry_of(&o.match_id) else { continue };
                let dem = demos.join(format!("{}.dem", o.match_id));
                bytes = match cs2hl_core::demo_io::read_demo(Path::new(&m.demo_path)) {
                    Ok(b) => b,
                    Err(e) => {
                        last_error = e.to_string();
                        failed_loads.insert(o.match_id.clone());
                        continue;
                    }
                };
                std::fs::write(&dem, &bytes)?;
                // The camera follows each grenade's recorded path: rebuild details from before
                // paths were timed exactly.
                if cs2hl_core::details::stale(lib, &o.match_id) {
                    let built = cs2hl_core::model::load_match(&bytes).and_then(|mm| {
                        let a = cs2hl_core::analysis::analyze(&mm);
                        cs2hl_core::details::write(lib, &o.match_id, &bytes, &mm, &a, steamid64)
                    });
                    if let Err(e) = built {
                        on(Event::Log(format!("{}: match details: {e:#}", o.match_id)));
                    }
                }
                throws = std::fs::read_to_string(cs2hl_core::details::path(lib, &o.match_id))
                    .ok()
                    .and_then(|t| serde_json::from_str::<cs2hl_core::details::MatchDetails>(&t).ok())
                    .map(|d| d.throws)
                    .unwrap_or_default();
                names = m.players.iter().map(|p| (p.steamid.clone(), p.name.clone())).collect();
                let want: Vec<(u64, i32)> = all_tries
                    .iter()
                    .filter(|(mid, _, _)| *mid == o.match_id)
                    .map(|(_, player, tick)| (player.parse().unwrap_or(0), lineup_check_tick(*tick)))
                    .collect();
                let mut sids: Vec<u64> = want.iter().map(|w| w.0).collect();
                sids.sort_unstable();
                sids.dedup();
                let mut ticks: Vec<i32> = want.iter().map(|w| w.1).collect();
                ticks.sort_unstable();
                ticks.dedup();
                eyes = cs2hl_core::raw::players_series(&bytes, &sids, &["X", "Y"], &ticks)
                    .map(|p| p.into_iter().filter_map(|(k, v)| Some((k, (*v.get("X")?, *v.get("Y")?)))).collect())
                    .unwrap_or_default();
                let first = names.get(&o.player).cloned().unwrap_or_default();
                match r.load_demo(&dem, &first) {
                    Ok(()) => loaded = Some(o.match_id.clone()),
                    Err(e) if e.downcast_ref::<Aborted>().is_some() => {
                        stopped = true;
                        break 'passes;
                    }
                    Err(e) => {
                        if e.downcast_ref::<DemoIncompatible>().is_some() {
                            unplayable.insert(o.match_id.clone());
                            save_unplayable(lib, &unplayable);
                            // Older demos than this one won't play either.
                            cutoff = cutoff.max(when(&o.match_id).unwrap_or(i64::MIN));
                            last_error = "Recorded on an older CS2 version; CS2 can no longer play this demo.".into();
                        } else {
                            failed_loads.insert(o.match_id.clone());
                            last_error = e.to_string();
                        }
                        on(Event::Log(format!("{}: {last_error}; restarting CS2", o.match_id)));
                        // A failed load can leave CS2 stuck: start over with a fresh session.
                        if let Some(r) = renderer.take() {
                            r.close();
                        }
                        loaded = None;
                        continue;
                    }
                }
                drain(on);
            }
            let Some(t) = throws.iter().find(|t| t.tick == o.tick && t.player == o.player) else { continue };
            // The demo sometimes loses a grenade mid-air: without its whole flight the camera
            // can't follow it.
            if !t.path.last().is_some_and(|p| (p[0] as f32 - t.to[0]).hypot(p[1] as f32 - t.to[1]) < 150.0) {
                last_error = "This demo didn't record the grenade's whole flight.".into();
                continue;
            }
            let lead = LINEUP_LEAD_S;
            let hold = match job.kind.as_str() {
                "smoke" => 4.5,
                "molotov" => 3.5,
                _ => 2.0,
            };
            let sid: u64 = o.player.parse().unwrap_or(0);
            let eye = eyes.get(&(sid, lineup_check_tick(o.tick))).copied();
            let shot = LineupShot {
                thrower: names.get(&o.player).cloned().unwrap_or_default(),
                eye,
                throw_tick: o.tick,
                pop_tick: o.pop_tick.max(o.tick + 32),
                path: t.path.iter().map(|p| [p[0] as f64, p[1] as f64, p[2] as f64]).collect(),
                lead_s: lead,
                hold_s: hold,
            };
            let rel = format!("lineups/{}.mp4", job.id);
            let ts = Instant::now();
            match r.record_lineup(&shot, &lib.join(&rel)) {
                Ok(()) => {
                    // The thumbnail: the thrower lined up, just before the throw.
                    let thumb = format!("lineups/{}.jpg", job.id);
                    let thumb = make_thumb_at(&lib.join(&rel), &lib.join(&thumb), lead - 0.3).is_ok().then_some(thumb);
                    clips.insert(job.id.clone(), LineupClip { clip: Some(rel), thumb, match_id: o.match_id.clone(), tick: o.tick, ..Default::default() });
                    save_lineup_clips(lib, &clips)?;
                    rendered += 1;
                    on(Event::Rendered { match_id: o.match_id.clone(), title: job.title.clone(), clip_s: lead + hold, took_s: ts.elapsed().as_secs_f64() });
                    drain(on);
                    continue 'jobs;
                }
                Err(e) if e.downcast_ref::<Aborted>().is_some() => {
                    stopped = true;
                    break 'passes;
                }
                Err(e) => {
                    last_error = if e.downcast_ref::<WrongPov>().is_some() { "CS2's camera wouldn't stay on the thrower.".into() } else { e.to_string() };
                    on(Event::Log(format!("{} from {}: {last_error}; trying another throw", job.title, o.match_id)));
                }
            }
        }
        if idx + 1 < job.tries.len().min(4) {
            next.push((job, idx + 1, last_error));
            continue;
        }
        clips.insert(job.id.clone(), LineupClip { error: Some(if last_error.is_empty() { "Couldn't film it.".into() } else { last_error.clone() }), count: job.count, ..Default::default() });
        save_lineup_clips(lib, &clips)?;
        on(Event::Failed { match_id: String::new(), title: job.title.clone(), error: last_error });
        drain(on);
    }
    queue = next;
    }
    let wants_cs2 = renderer.as_ref().is_some_and(|r| r.wants_cs2());
    if let Some(r) = renderer.take() {
        r.close();
    }
    drain(on);
    let _ = std::fs::remove_dir_all(&demos);
    if stopped {
        on(Event::Stopped { rendered, wants_cs2 });
    } else {
        on(Event::Done { rendered, minutes: t0.elapsed().as_secs_f64() / 60.0 });
    }
    Ok(rendered)
}
