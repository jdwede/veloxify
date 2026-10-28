//! Rendering a library's pending highlights, best "hands" first.
//!
//! Highlights are filmed a match at a time (each demo loaded once: a load takes about 11 s),
//! matches with the best moments first and each match's best moments first. Each match file is
//! saved as soon as a clip is done, so the app shows clips as they finish and an interrupted run
//! loses nothing.

use crate::assemble::{make_thumb, make_thumb_at, SETTLE_S};
use crate::profile::Profile;
use crate::session::{Aborted, DemoCrashed, DemoIncompatible, Renderer};
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
    let segments = m.highlights.iter().flat_map(|h| h.segments.iter()).chain(m.lowlights.iter().flat_map(|l| l.segments.iter())).chain(m.potm.iter().flat_map(|p| p.segments.iter()));
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
    /// This run makes `total`; `more` are waiting for later runs (lineup videos go in batches).
    Plan { total: usize, more: usize },
    /// Recording this one now.
    Filming { title: String },
    Rendered { match_id: String, title: String, clip_s: f64, took_s: f64 },
    Failed { match_id: String, title: String, error: String },
    Done { rendered: usize, minutes: f64 },
    /// Stopped early; `wants_cs2` when it was because someone opened CS2 (hand it back).
    Stopped { rendered: usize, wants_cs2: bool },
    Log(String),
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
    retry_crashing_demos(lib);
    let curation = cs2hl_core::curation::Curation::load(lib);
    if let Scope::Items(items) = scope {
        let mut out = vec![];
        for (mid, id) in items {
            let Ok(m) = load(&lib.join("matches").join(format!("{mid}.json"))) else { continue };
            // Asked for by name: worth another try after a failure (but not on a demo CS2 can no
            // longer play, or one that crashes CS2 until CS2 updates).
            let retry = |e: &Option<String>| e.as_deref().is_none_or(|e| !e.contains("older CS2 version") && e != CRASHES_CS2);
            let pending = m.highlights.iter().any(|h| &h.id == id && h.clip.is_none() && retry(&h.render_error))
                || m.lowlights.iter().any(|l| &l.id == id && l.clip.is_none() && retry(&l.render_error))
                || m.potm.as_ref().is_some_and(|p| &p.id == id && p.clip.is_none() && retry(&p.render_error));
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
    // Each match's play of the match (when it isn't one of yours), after all your highlights.
    let mut potms: Vec<(String, String)> = vec![];
    for id in &ids {
        let m = load(&lib.join("matches").join(format!("{id}.json")))?;
        if let Some(p) = &m.potm {
            if p.clip.is_none() && p.render_error.is_none() && !m.highlights.iter().any(|h| h.id == p.id) {
                potms.push((id.clone(), p.id.clone()));
            }
        }
        pending.extend(
            m.highlights.into_iter().filter(|h| h.clip.is_none() && h.render_error.is_none() && curation.auto_render(&h.id)).map(|h| (id.clone(), h)),
        );
    }
    // A match at a time (one demo load each), the match with the best moment first.
    let mut groups: BTreeMap<&str, Vec<&HighlightEntry>> = BTreeMap::new();
    for (mid, h) in &pending {
        groups.entry(mid.as_str()).or_default().push(h);
    }
    let mut groups: Vec<_> = groups.into_iter().collect();
    groups.sort_by_key(|(_, hs)| std::cmp::Reverse(hs.iter().map(|h| h.hand).max().unwrap_or(0)));
    let mut order = vec![];
    for (mid, mut hs) in groups {
        hs.sort_by_key(|h| std::cmp::Reverse(h.hand));
        order.extend(hs.into_iter().map(|h| (mid.to_string(), h.id.clone())));
        // The match's play of the match right after its own highlights (the demo is loaded).
        if let Some(i) = potms.iter().position(|(m, _)| m == mid) {
            order.push(potms.remove(i));
        }
    }
    order.extend(potms);
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
    on(Event::Plan { total: order.len(), more: 0 });
    if order.is_empty() {
        return Ok(0);
    }
    crate::session::set_preview(Some(lib.join(PREVIEW_FILE)));
    let _clear_preview = ClearPreview;
    let t0 = Instant::now();
    let (log_tx, log_rx) = std::sync::mpsc::channel::<String>();
    let started = Renderer::start(steamid64, profile, work_dir, abort, Box::new(move |s| {
        let _ = log_tx.send(s.to_string());
    }));
    let mut renderer = match started {
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
    // Where the play of the match's player is (when it isn't you), the same way.
    let mut pov_at: HashMap<i32, (f64, f64, f64)> = HashMap::new();
    let mut broken: Vec<String> = vec![];
    let mut rendered = 0;
    let mut stopped = false;
    // Frozen recordings in a row: CS2 isn't drawing (monitor off...), so stop rather than go on.
    let mut frozen_streak = 0;
    let mut not_drawing = false;
    // CS2 crashes in a row.
    let mut crashes = 0;
    // Demos set aside in a row for crashing CS2 as it opens them.
    let mut crashed_demos = 0;
    // CS2 can't play demos from before its last update that changed how demos are recorded (it
    // says so, or stops with an error box): a match as old as one known not to play is skipped.
    let mut unplayable = load_unplayable(lib);
    let played = |mid: &str| load(&lib.join("matches").join(format!("{mid}.json"))).map(|m| m.played_ts).unwrap_or(i64::MIN);
    let mut cutoff = unplayable.iter().map(|m| played(m)).max().unwrap_or(i64::MIN);
    let mut still_clips = load_still_clips(lib);
    const TOO_OLD: &str = "Recorded on an older CS2 version; CS2 can no longer play this demo.";
    for (mid, hid) in order {
        if broken.contains(&mid) {
            continue;
        }
        let path = lib.join("matches").join(format!("{mid}.json"));
        let mut m = load(&path)?;
        if unplayable.contains(&mid) || m.played_ts <= cutoff {
            for h in m.highlights.iter_mut().filter(|h| h.clip.is_none()) {
                h.render_error = Some(TOO_OLD.into());
            }
            for l in m.lowlights.iter_mut().filter(|l| l.clip.is_none()) {
                l.render_error = Some(TOO_OLD.into());
            }
            if let Some(p) = m.potm.as_mut().filter(|p| p.clip.is_none()) {
                p.render_error = Some(TOO_OLD.into());
            }
            save(&path, &m)?;
            broken.push(mid.clone());
            on(Event::Log(format!("skipping {}: demo from an older CS2 version", m.map)));
            continue;
        }
        // A highlight, a lowlight rendered on request, or the play of the match (anyone's).
        let hi = m.highlights.iter().position(|h| h.id == hid);
        let li = m.lowlights.iter().position(|l| l.id == hid);
        let pi = hi.is_none() && li.is_none() && m.potm.as_ref().is_some_and(|p| p.id == hid);
        if hi.is_none() && li.is_none() && !pi {
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
            pov_at = match m.potm.as_ref() {
                Some(p) if p.player != steamid64.to_string() => sample_me(&bytes, p.player.parse().unwrap_or(0), &m),
                _ => HashMap::new(),
            };
            drop(bytes);
            let me_name = m.players.iter().find(|p| p.steamid == steamid64.to_string()).map(|p| p.name.clone()).unwrap_or_default();
            // CS2 crashing as it opens a demo: once more on a fresh CS2, in case it was chance.
            let mut opened = renderer.load_demo(&dem, &me_name);
            if opened.as_ref().is_err_and(|e| e.is::<DemoCrashed>()) {
                drain(on);
                on(Event::Log(format!("CS2 crashed opening the {} demo; trying it once more", m.map)));
                renderer.relaunch_if_closed()?;
                opened = renderer.load_demo(&dem, &me_name);
            }
            match opened {
                Ok(()) => {
                    loaded = Some(mid.clone());
                    crashed_demos = 0;
                }
                Err(e) if e.downcast_ref::<Aborted>().is_some() => {
                    stopped = true;
                    break;
                }
                Err(e) if e.downcast_ref::<DemoIncompatible>().is_some() => {
                    for h in m.highlights.iter_mut().filter(|h| h.clip.is_none()) {
                        h.render_error = Some(TOO_OLD.into());
                    }
                    for l in m.lowlights.iter_mut().filter(|l| l.clip.is_none()) {
                        l.render_error = Some(TOO_OLD.into());
                    }
                    if let Some(p) = m.potm.as_mut().filter(|p| p.clip.is_none()) {
                        p.render_error = Some(TOO_OLD.into());
                    }
                    save(&path, &m)?;
                    broken.push(mid.clone());
                    unplayable.insert(mid.clone());
                    save_unplayable(lib, &unplayable);
                    cutoff = cutoff.max(m.played_ts);
                    loaded = None;
                    on(Event::Log(format!("skipping {}: demo from an older CS2 version", m.map)));
                    // CS2 may have stopped on it: start it again for the next match.
                    renderer.relaunch_if_closed()?;
                    drain(on);
                    continue;
                }
                Err(e) if e.is::<DemoCrashed>() => {
                    // Set aside until CS2's next update (it may fix it); the other matches go on.
                    for h in m.highlights.iter_mut().filter(|h| h.clip.is_none()) {
                        h.render_error = Some(CRASHES_CS2.into());
                    }
                    for l in m.lowlights.iter_mut().filter(|l| l.clip.is_none()) {
                        l.render_error = Some(CRASHES_CS2.into());
                    }
                    if let Some(p) = m.potm.as_mut().filter(|p| p.clip.is_none()) {
                        p.render_error = Some(CRASHES_CS2.into());
                    }
                    save(&path, &m)?;
                    note_crashing_demo(lib, &mid);
                    broken.push(mid.clone());
                    loaded = None;
                    drain(on);
                    on(Event::Log(format!("skipping {}: CS2 crashes every time it opens this demo", m.map)));
                    // Demo after demo crashing is more likely CS2 itself: stop for now.
                    crashed_demos += 1;
                    if crashed_demos >= 3 {
                        return Err(crate::session::Cs2Crashed(String::new()).into());
                    }
                    renderer.relaunch_if_closed()?;
                    drain(on);
                    continue;
                }
                Err(e) => {
                    // What CS2 printed before it failed.
                    drain(on);
                    return Err(e);
                }
            }
            drain(on);
        }
        let (segments, title, duration) = match (hi, li, m.potm.as_ref()) {
            (Some(i), _, _) => (m.highlights[i].segments.clone(), m.highlights[i].title.clone(), m.highlights[i].duration_s),
            (None, Some(i), _) => (m.lowlights[i].segments.clone(), m.lowlights[i].title.clone(), m.lowlights[i].duration_s),
            (None, None, Some(p)) => (p.segments.clone(), format!("Play of the match: {}", p.title), p.duration_s),
            _ => unreachable!(),
        };
        // Whose view: yours, or the play of the match's player's.
        let who = if pi { m.potm.as_ref().map(|p| p.player.clone()).unwrap_or_default() } else { steamid64.to_string() };
        renderer.set_pov(&m.players.iter().find(|p| p.steamid == who).map(|p| p.name.clone()).unwrap_or_default());
        let life = if pi && who != steamid64.to_string() { &pov_at } else { &me_at };
        let rel = format!("clips/{hid}.mp4");
        let ts = Instant::now();
        // Only while they're alive: after a death, CS2's camera follows someone else.
        let segments = if life.is_empty() { segments } else { trim_to_life(&segments, life) };
        let eyes = |t: i32| life.get(&t).map(|p| (p.0, p.1));
        on(Event::Filming { title: title.clone() });
        let recorded = if segments.is_empty() {
            Err(anyhow::anyhow!("the player wasn't alive for this moment"))
        } else {
            renderer.record(&segments, &lib.join(&rel), &eyes)
        };
        // A frozen recording (CS2 stopped drawing, e.g. the screen went to sleep) isn't kept,
        // unless it came out just as still last time: then the moment itself holds still.
        let recorded = recorded.and_then(|()| match crate::assemble::frozen_share(&lib.join(&rel)) {
            Some(f) if f > crate::assemble::FROZEN_MAX_CLIP && !still_clips.get(&hid).is_some_and(|&was| (was - f).abs() < 0.05) => {
                still_clips.insert(hid.clone(), f);
                save_still_clips(lib, &still_clips);
                let _ = std::fs::remove_file(lib.join(&rel));
                Err(crate::assemble::Frozen(f).into())
            }
            _ => Ok(()),
        });
        if recorded.is_ok() && still_clips.remove(&hid).is_some() {
            save_still_clips(lib, &still_clips);
        }
        // Nor what a failed one left behind (ffmpeg writes part of the file before failing).
        if recorded.is_err() {
            let _ = std::fs::remove_file(lib.join(&rel));
        }
        match recorded {
            Ok(()) => {
                let thumb = format!("clips/{hid}.jpg");
                let thumb = make_thumb(&lib.join(&rel), &lib.join(&thumb)).is_ok().then_some(thumb);
                let no_audio = !renderer.records_audio();
                match (hi, li) {
                    (Some(i), _) => {
                        m.highlights[i].clip = Some(rel);
                        m.highlights[i].thumb = thumb;
                        m.highlights[i].no_audio = no_audio;
                    }
                    (None, Some(i)) => {
                        m.lowlights[i].clip = Some(rel);
                        m.lowlights[i].thumb = thumb;
                        m.lowlights[i].no_audio = no_audio;
                    }
                    _ => {
                        if let Some(p) = m.potm.as_mut().filter(|_| pi) {
                            p.clip = Some(rel);
                            p.thumb = thumb;
                            p.no_audio = no_audio;
                        }
                    }
                }
                // A retry that worked: the earlier failure no longer applies.
                match (hi, li) {
                    (Some(i), _) => m.highlights[i].render_error = None,
                    (None, Some(i)) => m.lowlights[i].render_error = None,
                    _ => {
                        if let Some(p) = m.potm.as_mut().filter(|_| pi) {
                            p.render_error = None;
                        }
                    }
                }
                // Rendered again on request: no longer "removed for space".
                let mut curation = cs2hl_core::curation::Curation::load(lib);
                if curation.evicted.remove(&hid) {
                    let _ = curation.save(lib);
                }
                rendered += 1;
                frozen_streak = 0;
                crashes = 0;
                on(Event::Rendered { match_id: mid.clone(), title, clip_s: duration, took_s: ts.elapsed().as_secs_f64() });
            }
            Err(e) if e.downcast_ref::<Aborted>().is_some() => {
                stopped = true;
                break;
            }
            Err(e) if e.downcast_ref::<crate::assemble::Frozen>().is_some() => {
                // Not a failure of this clip: it's recorded again next time.
                on(Event::Log(format!("{title}: {e}")));
                frozen_streak += 1;
                if frozen_streak >= 2 {
                    not_drawing = true;
                    break;
                }
            }
            Err(e) => {
                let crashed = e.downcast_ref::<crate::session::Cs2Crashed>();
                // CS2 closing by itself isn't this clip's fault: it's tried again another time.
                let silent = crashed.is_some_and(|c| c.0.is_empty());
                match (hi, li) {
                    _ if silent => {}
                    (Some(i), _) => m.highlights[i].render_error = Some(e.to_string()),
                    (None, Some(i)) => m.lowlights[i].render_error = Some(e.to_string()),
                    _ => {
                        if let Some(p) = m.potm.as_mut().filter(|_| pi) {
                            p.render_error = Some(e.to_string());
                        }
                    }
                }
                on(Event::Failed { match_id: mid.clone(), title, error: e.to_string() });
                if crashed.is_some() {
                    // Twice in a row: CS2 isn't going to film right now (the worker waits).
                    crashes += 1;
                    if crashes >= 2 {
                        save(&path, &m)?;
                        return Err(e);
                    }
                    loaded = None;
                    renderer.relaunch_if_closed()?;
                }
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
    if not_drawing {
        return Err(crate::session::NotDrawing.into());
    }
    if stopped {
        on(Event::Stopped { rendered, wants_cs2 });
    } else {
        on(Event::Done { rendered, minutes: t0.elapsed().as_secs_f64() / 60.0 });
    }
    Ok(rendered)
}

/// Whether an MP4 has a sound track: its track list (moov) is at the start of clips Veloxify
/// makes (or the end of other MP4s), so only those parts are read. `None` if it can't be read.
pub fn has_audio(path: &Path) -> Option<bool> {
    use std::io::{Read, Seek, SeekFrom};
    const PART: u64 = 1 << 20;
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let mut buf = vec![];
    f.by_ref().take(PART).read_to_end(&mut buf).ok()?;
    if len > PART {
        f.seek(SeekFrom::Start(len.saturating_sub(PART).max(PART))).ok()?;
        f.read_to_end(&mut buf).ok()?;
    }
    // A track's handler box: "hdlr", 8 more bytes, then its type ("soun" for sound).
    Some(buf.windows(16).any(|w| &w[..4] == b"hdlr" && &w[12..16] == b"soun"))
}

/// Marks clips recorded without sound (`no_audio`), checking each clip file once (the ones
/// checked are kept in `clip_audio_checked.json`). Returns how many it marked.
pub fn mark_silent_clips(lib: &Path, steamid64: u64) -> usize {
    let checked_path = lib.join("clip_audio_checked.json");
    let mut checked: std::collections::BTreeSet<String> =
        std::fs::read_to_string(&checked_path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    let Ok(index) = std::fs::read_to_string(lib.join("index.json")).map_err(anyhow::Error::from).and_then(|t| Ok(serde_json::from_str::<Index>(&t)?)) else {
        return 0;
    };
    let before = checked.len();
    let mut marked = 0;
    for summary in &index.matches {
        let path = lib.join("matches").join(format!("{}.json", summary.id));
        let Ok(mut m) = load(&path) else { continue };
        let mut changed = false;
        let mut check = |clip: &Option<String>, no_audio: &mut bool| {
            let Some(rel) = clip else { return };
            if *no_audio || !checked.insert(rel.clone()) {
                return;
            }
            if has_audio(&lib.join(rel)) == Some(false) {
                *no_audio = true;
                changed = true;
                marked += 1;
            }
        };
        for h in m.highlights.iter_mut() {
            check(&h.clip, &mut h.no_audio);
        }
        for l in m.lowlights.iter_mut() {
            check(&l.clip, &mut l.no_audio);
        }
        if changed {
            let _ = save(&path, &m);
        }
    }
    if checked.len() != before {
        let _ = std::fs::write(&checked_path, serde_json::to_string(&checked).unwrap_or_default());
    }
    if marked > 0 {
        let _ = cs2hl_core::ingest::rebuild_index(lib, steamid64);
    }
    marked
}

/// The clips recorded without sound, made ready to record again (their clip is cleared; the new
/// one replaces the file). Returns them, to queue for rendering.
pub fn reset_silent_clips(lib: &Path, steamid64: u64) -> Vec<(String, String)> {
    let mut items = vec![];
    let Ok(index) = std::fs::read_to_string(lib.join("index.json")).map_err(anyhow::Error::from).and_then(|t| Ok(serde_json::from_str::<Index>(&t)?)) else {
        return items;
    };
    for summary in &index.matches {
        let path = lib.join("matches").join(format!("{}.json", summary.id));
        let Ok(mut m) = load(&path) else { continue };
        let mut changed = false;
        for h in m.highlights.iter_mut().filter(|h| h.no_audio && h.clip.is_some()) {
            h.clip = None;
            h.no_audio = false;
            items.push((summary.id.clone(), h.id.clone()));
            changed = true;
        }
        for l in m.lowlights.iter_mut().filter(|l| l.no_audio && l.clip.is_some()) {
            l.clip = None;
            l.no_audio = false;
            items.push((summary.id.clone(), l.id.clone()));
            changed = true;
        }
        if changed {
            let _ = save(&path, &m);
        }
    }
    if !items.is_empty() {
        let _ = cs2hl_core::ingest::rebuild_index(lib, steamid64);
    }
    items
}

/// The live picture of what's being recorded, in the library (the app shows it in its banner).
pub const PREVIEW_FILE: &str = "capture_preview.bmp";

/// Removes the live picture when a batch ends, however it ends.
struct ClearPreview;
impl Drop for ClearPreview {
    fn drop(&mut self) {
        crate::session::set_preview(None);
    }
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
    /// The thrower's view the moment it's thrown, full size: the exact lineup.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aim: Option<String>,
    /// How much of the grenade's flight stutters in the video (see `assemble::stutter_share`),
    /// once checked; a choppy one is filmed again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stutter: Option<f64>,
    /// Times it was filmed again for stuttering.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub refilms: u32,
}

fn is_zero(n: &u32) -> bool {
    *n == 0
}

/// Which lineups get videos on their own (Settings): the most thrown on each map, up to
/// `per_map`, of these grenades ("smoke", "molotov", "flash", "he") and these kinds of lineup
/// ("instant", "set").
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct LineupPlan {
    pub per_map: usize,
    pub kinds: Vec<String>,
    pub categories: Vec<String>,
}

impl Default for LineupPlan {
    fn default() -> Self {
        Self {
            per_map: 30,
            kinds: ["smoke", "molotov", "flash", "he"].map(String::from).to_vec(),
            categories: ["instant", "set"].map(String::from).to_vec(),
        }
    }
}

/// The same lineup grouped twice (thrown from nearly the same spot, with nearly the same aim, to
/// nearly the same place): it's filmed once.
fn near_copy(a: &cs2hl_core::lineups::Lineup, b: &cs2hl_core::lineups::Lineup) -> bool {
    let yaw = ((a.yaw - b.yaw + 540.0).rem_euclid(360.0) - 180.0).abs();
    a.kind == b.kind
        && a.side == b.side
        && (a.from[0] - b.from[0]).hypot(a.from[1] - b.from[1]) < 64.0
        && (a.pitch - b.pitch).abs() < 2.5
        && yaw < 2.5
        && (a.to[0] - b.to[0]).hypot(a.to[1] - b.to[1]) < 150.0
}

/// The lineups that get videos on their own, by map, most thrown first (see [`LineupPlan`]).
pub fn chosen_lineups(lib: &Path, plan: &LineupPlan) -> BTreeMap<String, Vec<cs2hl_core::lineups::Lineup>> {
    let all = cs2hl_core::lineups::load(lib);
    let mut out = BTreeMap::new();
    for (map, m) in all.maps {
        let mut ls: Vec<cs2hl_core::lineups::Lineup> = m
            .lineups
            .into_iter()
            .filter(|l| l.count >= LINEUP_AUTO_MIN_THROWS && plan.kinds.contains(&l.kind) && plan.categories.contains(&l.category))
            .collect();
        ls.sort_by(|a, b| b.count.cmp(&a.count).then(b.matches.cmp(&a.matches)).then(a.id.cmp(&b.id)));
        let mut chosen: Vec<cs2hl_core::lineups::Lineup> = vec![];
        for l in ls {
            if chosen.len() >= plan.per_map {
                break;
            }
            if !chosen.iter().any(|c| near_copy(c, &l)) {
                chosen.push(l);
            }
        }
        out.insert(map, chosen);
    }
    out
}

/// A lineup video whose grenade flight stutters more than this is filmed again (once).
pub const STUTTER_MAX: f64 = 0.08;

/// After the lineups are rebuilt: a video whose lineup id is gone moves to the lineup its throw
/// belongs to now (if that one has no video yet); videos of lineups that no longer exist are
/// deleted, and so are notes about lineups that no longer exist. Returns how many videos moved.
pub fn migrate_lineup_clips(lib: &Path) -> Result<usize> {
    let all = cs2hl_core::lineups::load(lib);
    let mut clips = load_lineup_clips(lib);
    let ids: std::collections::HashSet<&str> = all.maps.values().flat_map(|m| m.lineups.iter().map(|l| l.id.as_str())).collect();
    if ids.is_empty() {
        return Ok(0);
    }
    // Notes on why a lineup couldn't be filmed are checked again once its throws change.
    let counts: HashMap<&str, usize> = all.maps.values().flat_map(|m| m.lineups.iter().map(|l| (l.id.as_str(), l.count))).collect();
    let recheck: Vec<String> = clips.iter().filter(|(k, c)| c.clip.is_none() && counts.get(k.as_str()).is_some_and(|n| *n != c.count)).map(|(k, _)| k.clone()).collect();
    // A video is never thrown away to be filmed again (a "more common" crosshair placement comes
    // and goes as matches are added): it stays, or moves with its lineup.
    let stale: Vec<String> = clips.keys().filter(|k| !ids.contains(k.as_str())).cloned().collect();
    if stale.is_empty() && recheck.is_empty() {
        return Ok(0);
    }
    for k in recheck {
        clips.remove(&k);
    }
    let mut moved = 0;
    for old in stale {
        let Some(c) = clips.remove(&old) else { continue };
        let Some(rel) = c.clip.clone() else { continue };
        let key = format!("{}@{}", c.match_id, c.tick);
        let free = |n: &str| !clips.get(n).is_some_and(|x| x.clip.is_some());
        // Its filmed throw's lineup now; else the lineup thrown from the same spot with the same
        // aim (an id is the map, grenade, side, spot and aim of the lineup's first throw).
        let new = all
            .maps
            .values()
            .find_map(|m| m.by_throw.get(&key))
            .filter(|n| free(n))
            .cloned()
            .or_else(|| {
                let (map, kind, side, at) = parse_lineup_id(&old)?;
                let m = all.maps.get(&map)?;
                m.lineups
                    .iter()
                    .filter(|l| l.kind == kind && l.side == side && free(&l.id))
                    .map(|l| {
                        let yaw = ((l.yaw - at[3] + 540.0).rem_euclid(360.0) - 180.0).abs();
                        ((l.from[0] - at[0]).hypot(l.from[1] - at[1]), (l.pitch - at[2]).abs(), yaw, &l.id)
                    })
                    .filter(|&(d, p, y, _)| d < 64.0 && p < 2.5 && y < 2.5)
                    .min_by(|a, b| (a.0 + 20.0 * (a.1 + a.2)).total_cmp(&(b.0 + 20.0 * (b.1 + b.2))))
                    .map(|(_, _, _, id)| id.clone())
            });
        match new {
            Some(new) => {
                let clip = format!("lineups/{new}.mp4");
                std::fs::rename(lib.join(&rel), lib.join(&clip))?;
                let thumb = c.thumb.as_ref().and_then(|t| {
                    let to = format!("lineups/{new}.jpg");
                    std::fs::rename(lib.join(t), lib.join(&to)).ok().map(|_| to)
                });
                clips.insert(new, LineupClip { clip: Some(clip), thumb, ..c });
                moved += 1;
            }
            // Its lineup is gone (thrown differently now, or a miss): the video is kept aside under
            // its old id, and comes back if the lineup does.
            None => {
                clips.insert(old, c);
            }
        }
    }
    save_lineup_clips(lib, &clips)?;
    Ok(moved)
}

/// A lineup id's parts: map, grenade, side, and the first throw's spot and aim `[x, y, pitch, yaw]`
/// (`de_mirage-smoke-T--84--65--45--20`; a trailing `b` tells same-id lineups apart).
fn parse_lineup_id(id: &str) -> Option<(String, String, String, [f32; 4])> {
    let mut parts = id.trim_end_matches('b').split('-');
    let (map, kind, side) = (parts.next()?.to_string(), parts.next()?.to_string(), parts.next()?.to_string());
    let (mut nums, mut neg) = (vec![], false);
    for p in parts {
        if p.is_empty() {
            neg = true;
            continue;
        }
        let v: f32 = p.parse().ok()?;
        nums.push(if neg { -v } else { v });
        neg = false;
    }
    (nums.len() == 4).then(|| (map, kind, side, [nums[0] * 16.0, nums[1] * 16.0, nums[2], nums[3]]))
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

/// Lineups filmed on their own are thrown at least this many times (twice can be chance); any
/// other films when asked for ("Film this lineup now").
pub const LINEUP_AUTO_MIN_THROWS: usize = 3;

/// Whether a lineup still needs its video: none yet (and none that failed, unless it's been thrown
/// more since or it's asked for), or one that stutters and hasn't been filmed again yet.
fn needs_video(l: &cs2hl_core::lineups::Lineup, c: Option<&LineupClip>, asked: bool) -> bool {
    match c {
        None => true,
        Some(c) if c.clip.is_some() => c.stutter.is_some_and(|s| s > STUTTER_MAX) && c.refilms == 0,
        Some(c) => asked || c.error.is_none() || l.count > c.count,
    }
}

/// Lineups still to film: the ones asked for (`ids`), or the ones chosen to get videos on their
/// own (see [`chosen_lineups`]), each map's most thrown first, a map's #1 before any map's #2.
pub fn plan_lineups(lib: &Path, ids: Option<&[String]>, plan: &LineupPlan) -> Vec<cs2hl_core::lineups::Lineup> {
    let done = load_lineup_clips(lib);
    if let Some(ids) = ids {
        let mut todo: Vec<cs2hl_core::lineups::Lineup> = cs2hl_core::lineups::load(lib)
            .maps
            .into_values()
            .flat_map(|m| m.lineups)
            .filter(|l| ids.contains(&l.id) && needs_video(l, done.get(&l.id), true))
            .collect();
        todo.sort_by(|a, b| b.count.cmp(&a.count).then(b.matches.cmp(&a.matches)));
        return todo;
    }
    let per_map: Vec<Vec<cs2hl_core::lineups::Lineup>> = chosen_lineups(lib, plan).into_values().collect();
    let deepest = per_map.iter().map(Vec::len).max().unwrap_or(0);
    let mut todo = vec![];
    for rank in 0..deepest {
        for list in &per_map {
            if let Some(l) = list.get(rank).filter(|l| needs_video(l, done.get(&l.id), false)) {
                todo.push(l.clone());
            }
        }
    }
    todo
}

/// Seconds of the thrower's own view before the throw.
const LINEUP_LEAD_S: f64 = 2.5;

/// Lineup videos made before their picture and stutter check existed get them: the full-size
/// still of the throw, and how much of the flight stutters (a choppy one is filmed again, once).
/// Works for up to `budget`; returns how many were checked and whether more are left.
pub fn check_lineup_videos(lib: &Path, budget: std::time::Duration) -> (usize, bool) {
    let mut clips = load_lineup_clips(lib);
    let todo: Vec<String> = clips.iter().filter(|(_, c)| c.clip.is_some() && (c.aim.is_none() || c.stutter.is_none())).map(|(k, _)| k.clone()).collect();
    if todo.is_empty() {
        return (0, false);
    }
    // Each video's flight time, from its throw.
    let all = cs2hl_core::lineups::load(lib);
    let pop_of = |mid: &str, tick: i32| -> Option<i32> {
        all.maps.values().flat_map(|m| m.lineups.iter()).flat_map(|l| std::iter::once(&l.video).chain(&l.examples)).find(|o| o.match_id == mid && o.tick == tick).map(|o| o.pop_tick)
    };
    let started = Instant::now();
    let mut done = 0;
    for id in &todo {
        if started.elapsed() > budget {
            break;
        }
        let Some(c) = clips.get_mut(id) else { continue };
        let Some(rel) = c.clip.clone() else { continue };
        let video = lib.join(&rel);
        if !video.exists() {
            continue;
        }
        if c.aim.is_none() {
            let aim = format!("lineups/{id}-aim.jpg");
            if crate::assemble::make_still(&video, &lib.join(&aim), LINEUP_LEAD_S - 0.1).is_ok() {
                c.aim = Some(aim);
            }
        }
        if c.stutter.is_none() {
            let flight = pop_of(&c.match_id, c.tick).map_or(2.0, |p| (p - c.tick).max(32) as f64 / TICKRATE);
            // Not measurable (a still flight): counted as smooth, so it isn't checked again.
            c.stutter = Some(crate::assemble::stutter_share(&video, LINEUP_LEAD_S + 0.25, LINEUP_LEAD_S + flight).unwrap_or(0.0));
        }
        done += 1;
    }
    let _ = save_lineup_clips(lib, &clips);
    (done, done < todo.len())
}

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

/// Why a clip whose demo crashes CS2 as it opens isn't filmed.
const CRASHES_CS2: &str = "CS2 crashes every time it opens this demo (a CS2 bug since its 22 October update, with some FACEIT demos). Veloxify tries again after CS2's next update.";

/// Matches whose demo crashed CS2 as it opened, and the CS2 version that did it
/// (`crashing_demos.json`).
#[derive(serde::Serialize, serde::Deserialize, Default)]
struct CrashingDemos {
    build: String,
    matches: std::collections::BTreeSet<String>,
}

fn note_crashing_demo(lib: &Path, mid: &str) {
    let file = lib.join("crashing_demos.json");
    let mut c: CrashingDemos = std::fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    c.build = crate::steam::cs2_build().unwrap_or_default();
    c.matches.insert(mid.to_string());
    let _ = std::fs::write(file, serde_json::to_string(&c).unwrap_or_default());
}

/// Once CS2 has updated, the demos that crashed it get another try.
fn retry_crashing_demos(lib: &Path) {
    let file = lib.join("crashing_demos.json");
    let Some(c) = std::fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str::<CrashingDemos>(&t).ok()) else { return };
    let Some(now) = crate::steam::cs2_build() else { return };
    if now == c.build {
        return;
    }
    for mid in &c.matches {
        let path = lib.join("matches").join(format!("{mid}.json"));
        let Ok(mut m) = load(&path) else { continue };
        let crashed = |e: &mut Option<String>| {
            if e.as_deref() == Some(CRASHES_CS2) {
                *e = None;
            }
        };
        m.highlights.iter_mut().for_each(|h| crashed(&mut h.render_error));
        m.lowlights.iter_mut().for_each(|l| crashed(&mut l.render_error));
        if let Some(p) = m.potm.as_mut() {
            crashed(&mut p.render_error);
        }
        let _ = save(&path, &m);
    }
    let _ = std::fs::remove_file(file);
}

/// Demos CS2 couldn't load for a lineup video (not known to be too old): match -> runs it failed.
/// After [`LOAD_TRIES`] runs it's left alone: each try costs a CS2 restart.
fn load_failures(lib: &Path) -> BTreeMap<String, u32> {
    std::fs::read_to_string(lib.join("demo_load_failures.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn save_load_failures(lib: &Path, m: &BTreeMap<String, u32>) {
    let _ = std::fs::write(lib.join("demo_load_failures.json"), serde_json::to_string(m).unwrap_or_default());
}

const LOAD_TRIES: u32 = 2;

/// Clips that came out mostly still: clip id -> the still share. The same share again means the
/// moment itself holds still (an AWP holding an angle), not CS2 stopping, and the clip is kept.
fn load_still_clips(lib: &Path) -> BTreeMap<String, f64> {
    std::fs::read_to_string(lib.join("still_clips.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn save_still_clips(lib: &Path, m: &BTreeMap<String, f64>) {
    let _ = std::fs::write(lib.join("still_clips.json"), serde_json::to_string(m).unwrap_or_default());
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
    plan: &LineupPlan,
    limit: usize,
    abort: Arc<AtomicBool>,
    on: &mut dyn FnMut(Event),
) -> Result<usize> {
    use crate::session::{LineupShot, WrongPov};
    let todo = plan_lineups(lib, ids.as_deref(), plan);
    let entry_of = |mid: &str| -> Option<MatchEntry> { load(&lib.join("matches").join(format!("{mid}.json"))).ok() };
    let mut unplayable = load_unplayable(lib);
    let mut load_failed = load_failures(lib);
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
        let mut wont_load = false;
        for o in std::iter::once(&l.video).chain(l.examples.iter()) {
            if o.tick <= 0 || unplayable.contains(&o.match_id) || tries.iter().any(|t| t.match_id == o.match_id && t.tick == o.tick) {
                continue;
            }
            if load_failed.get(&o.match_id).is_some_and(|&n| n >= LOAD_TRIES) {
                wont_load = true;
                continue;
            }
            if when(&o.match_id).is_some_and(|ts| ts > cutoff) {
                tries.push(o.clone());
            }
        }
        if tries.is_empty() && wont_load {
            clips.insert(l.id.clone(), LineupClip { error: Some("CS2 couldn't load the demos it was thrown in.".into()), count: l.count, ..Default::default() });
            continue;
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
    // This run's share of the list (most important first), filmed a demo at a time: each lineup
    // from a demo as many of the others were thrown in too (a load takes about 11 s), newer demos
    // first; its other throws stay as fallbacks.
    let waiting = jobs.len();
    let mut jobs: Vec<Job> = jobs.into_iter().take(limit).collect();
    {
        let mut left: Vec<usize> = (0..jobs.len()).collect();
        let mut order: Vec<usize> = vec![];
        while !left.is_empty() {
            let mut cover: HashMap<String, (usize, i64)> = HashMap::new();
            for &j in &left {
                let mut seen: Vec<&str> = vec![];
                for t in jobs[j].tries.iter().take(4) {
                    if !seen.contains(&t.match_id.as_str()) {
                        seen.push(t.match_id.as_str());
                        let e = cover.entry(t.match_id.clone()).or_insert((0, when(&t.match_id).unwrap_or(0)));
                        e.0 += 1;
                    }
                }
            }
            let Some(best) = cover.into_iter().max_by(|a, b| a.1 .0.cmp(&b.1 .0).then(a.1 .1.cmp(&b.1 .1))).map(|(m, _)| m) else {
                order.append(&mut left);
                break;
            };
            left.retain(|&j| {
                let Some(k) = jobs[j].tries.iter().take(4).position(|t| t.match_id == best) else { return true };
                let t = jobs[j].tries.remove(k);
                jobs[j].tries.insert(0, t);
                order.push(j);
                false
            });
        }
        let mut slots: Vec<Option<Job>> = jobs.into_iter().map(Some).collect();
        jobs = order.into_iter().filter_map(|j| slots[j].take()).collect();
    }
    on(Event::Plan { total: jobs.len(), more: waiting - jobs.len() });
    if jobs.is_empty() {
        return Ok(0);
    }
    crate::session::set_preview(Some(lib.join(PREVIEW_FILE)));
    let _clear_preview = ClearPreview;
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
    // Pass by pass, in list order: each lineup's next throw to try. A lineup that fails is tried
    // from its next throw in a later pass, so none is left out because one throw didn't work.
    let mut queue: Vec<(Job, usize, String)> = jobs.into_iter().map(|j| (j, 0, String::new())).collect();
    let mut frozen_streak = 0;
    let mut not_drawing = false;
    // CS2 crashes in a row: twice and CS2 isn't going to film right now (the worker waits).
    let mut crashes = 0;
    'passes: for _pass in 0..4 {
    if queue.is_empty() {
        break;
    }
    let mut next: Vec<(Job, usize, String)> = vec![];
    'jobs: for (mut job, idx, mut last_error) in std::mem::take(&mut queue) {
        // Thrown in the demo CS2 already has loaded too: film it from that one (no reload).
        if let Some(k) = job.tries.iter().skip(idx).position(|t| Some(t.match_id.as_str()) == loaded.as_deref()) {
            job.tries.swap(idx, idx + k);
        }
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
                    Ok(()) => {
                        loaded = Some(o.match_id.clone());
                        if load_failed.remove(&o.match_id).is_some() {
                            save_load_failures(lib, &load_failed);
                        }
                    }
                    Err(e) if e.downcast_ref::<Aborted>().is_some() => {
                        stopped = true;
                        break 'passes;
                    }
                    Err(e) => {
                        if e.downcast_ref::<crate::session::Cs2Crashed>().is_some() {
                            crashes += 1;
                            if crashes >= 2 {
                                return Err(e);
                            }
                        }
                        if e.downcast_ref::<DemoIncompatible>().is_some() {
                            unplayable.insert(o.match_id.clone());
                            save_unplayable(lib, &unplayable);
                            // Older demos than this one won't play either.
                            cutoff = cutoff.max(when(&o.match_id).unwrap_or(i64::MIN));
                            last_error = "Recorded on an older CS2 version; CS2 can no longer play this demo.".into();
                        } else {
                            failed_loads.insert(o.match_id.clone());
                            *load_failed.entry(o.match_id.clone()).or_default() += 1;
                            save_load_failures(lib, &load_failed);
                            last_error = if e.is::<DemoCrashed>() { "CS2 crashes when it opens this demo.".into() } else { e.to_string() };
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
            on(Event::Filming { title: job.title.clone() });
            // A flash's white-out where it pops is still footage of it, not CS2 stopping.
            let still_s = if job.kind == "flash" { 4.0 } else { 2.0 };
            // Filmed into a new file: a video already there (one that stutters) stays until this
            // one is better.
            let new = lib.join(format!("lineups/{}.new.mp4", job.id));
            let flight = (shot.pop_tick - shot.throw_tick).max(1) as f64 / TICKRATE;
            let mut stutter = None;
            let mut recorded = Err(anyhow::anyhow!("not filmed"));
            for attempt in 0..2 {
                recorded = r.record_lineup(&shot, &new).and_then(|()| match crate::assemble::frozen_share_with(&new, still_s) {
                    Some(f) if f > crate::assemble::FROZEN_MAX => {
                        let _ = std::fs::remove_file(&new);
                        Err(crate::assemble::Frozen(f).into())
                    }
                    _ => Ok(()),
                });
                if recorded.is_err() {
                    break;
                }
                // The camera chasing the grenade should glide: a choppy take is filmed once more.
                stutter = crate::assemble::stutter_share(&new, lead + 0.25, lead + flight);
                match stutter {
                    Some(st) if st > STUTTER_MAX && attempt == 0 => on(Event::Log(format!("{}: {:.0}% of the flight stutters; filming it again", job.title, st * 100.0))),
                    _ => break,
                }
            }
            let prev = clips.get(&job.id).cloned();
            // Filming again for stutter: the new take replaces the old only if it's smoother.
            let worse = recorded.is_ok() && prev.as_ref().is_some_and(|p| p.clip.is_some() && p.stutter.zip(stutter).is_some_and(|(old, now)| now >= old));
            if worse {
                let _ = std::fs::remove_file(&new);
            } else if recorded.is_ok() {
                std::fs::rename(&new, lib.join(&rel))?;
            }
            match recorded {
                Ok(()) if worse => {
                    if let Some(c) = clips.get_mut(&job.id) {
                        c.refilms += 1;
                    }
                    save_lineup_clips(lib, &clips)?;
                    rendered += 1;
                    on(Event::Rendered { match_id: o.match_id.clone(), title: job.title.clone(), clip_s: lead + hold, took_s: ts.elapsed().as_secs_f64() });
                    drain(on);
                    continue 'jobs;
                }
                Ok(()) => {
                    // The thumbnail: the thrower lined up, just before the throw; and the same moment
                    // full size, for the lineup's picture.
                    let thumb = format!("lineups/{}.jpg", job.id);
                    let thumb = make_thumb_at(&lib.join(&rel), &lib.join(&thumb), lead - 0.3).is_ok().then_some(thumb);
                    let aim = format!("lineups/{}-aim.jpg", job.id);
                    let aim = crate::assemble::make_still(&lib.join(&rel), &lib.join(&aim), lead - 0.1).is_ok().then_some(aim);
                    let refilms = prev.as_ref().filter(|p| p.clip.is_some()).map_or(0, |p| p.refilms + 1);
                    clips.insert(job.id.clone(), LineupClip { clip: Some(rel), thumb, aim, stutter, refilms, match_id: o.match_id.clone(), tick: o.tick, ..Default::default() });
                    save_lineup_clips(lib, &clips)?;
                    rendered += 1;
                    frozen_streak = 0;
                    crashes = 0;
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
                    if e.downcast_ref::<crate::session::Cs2Crashed>().is_some() {
                        crashes += 1;
                        if crashes >= 2 {
                            return Err(e);
                        }
                        if let Some(r) = renderer.take() {
                            r.close();
                        }
                        loaded = None;
                    }
                    if e.downcast_ref::<crate::assemble::Frozen>().is_some() {
                        frozen_streak += 1;
                        if frozen_streak >= 3 {
                            not_drawing = true;
                            break 'passes;
                        }
                    }
                }
            }
        }
        if idx + 1 < job.tries.len().min(4) {
            next.push((job, idx + 1, last_error));
            continue;
        }
        // A lineup with a video already (filmed again for stutter) keeps it.
        match clips.get_mut(&job.id).filter(|c| c.clip.is_some()) {
            Some(c) => c.refilms += 1,
            None => {
                clips.insert(job.id.clone(), LineupClip { error: Some(if last_error.is_empty() { "Couldn't film it.".into() } else { last_error.clone() }), count: job.count, ..Default::default() });
            }
        }
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
    if not_drawing {
        return Err(crate::session::NotDrawing.into());
    }
    if stopped {
        on(Event::Stopped { rendered, wants_cs2 });
    } else {
        on(Event::Done { rendered, minutes: t0.elapsed().as_secs_f64() / 60.0 });
    }
    Ok(rendered)
}
