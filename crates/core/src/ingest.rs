//! Adding demos to a library on disk (`matches/<id>.json` + `index.json`).

use crate::library::{self, ClipPolicy, Index, MatchEntry};
use crate::{analysis, demo_io, model, stats};
use anyhow::Result;
use std::collections::HashMap;
use std::path::Path;
use std::time::Instant;

pub enum Added {
    Added { id: String, map: String, score: (u32, u32), result: String, seconds: f64 },
    /// Already in the library (and not refreshed).
    Cached { id: String },
    /// Not a usable match for this player (not in it, unparseable, ...).
    Skipped { id: String, reason: String },
}

/// Library id for a demo path.
pub fn id_for(path: &Path) -> String {
    library::demo_id(&path.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default())
}

/// Parses `path` and writes its match entry. With `refresh`, an existing entry is re-analyzed
/// (e.g. after rule changes) while keeping its rendered clips, thumbnails and match time.
/// Until a FACEIT/Valve match time is known, the demo file's timestamp stands in for it.
pub fn add_demo(root: &Path, path: &Path, me: u64, policy: &ClipPolicy, refresh: bool) -> Result<Added> {
    let id = id_for(path);
    let out = root.join("matches").join(format!("{id}.json"));
    std::fs::create_dir_all(out.parent().unwrap())?;
    let previous: Option<MatchEntry> = if out.exists() {
        if !refresh {
            return Ok(Added::Cached { id });
        }
        serde_json::from_str(&std::fs::read_to_string(&out)?).ok()
    } else {
        None
    };
    // Premier/Competitive demos carry their real match time; otherwise the file's time stands in
    // until FACEIT's time is known.
    let real_time = valve_match_time(path);
    let local: chrono::DateTime<chrono::Local> = match real_time.and_then(|t| chrono::DateTime::from_timestamp(t, 0)) {
        Some(t) => t.with_timezone(&chrono::Local),
        None => std::fs::metadata(path)?.modified()?.into(),
    };
    let t = Instant::now();
    let demo = demo_io::read_demo(path)?;
    let m = match model::load_match(&demo) {
        Ok(m) => m,
        Err(e) => return Ok(Added::Skipped { id, reason: e.to_string() }),
    };
    let a = analysis::analyze(&m);
    let st = stats::player_stats(&m, &a, true);
    let played_at = local.format("%Y-%m-%dT%H:%M:%S").to_string();
    let Some(mut entry) =
        library::match_entry(&id, &path.display().to_string(), local.timestamp(), &played_at, &m, &a, &st, me, policy, Some(&demo))
    else {
        return Ok(Added::Skipped { id, reason: format!("player {me} is not in this match") });
    };
    if let Some(prev) = previous {
        for h in entry.highlights.iter_mut() {
            if let Some(old) = prev.highlights.iter().find(|o| o.id == h.id) {
                h.clip = old.clip.clone();
                h.render_error = old.render_error.clone();
                h.thumb = old.thumb.clone();
            }
        }
        for l in entry.lowlights.iter_mut() {
            if let Some(old) = prev.lowlights.iter().find(|o| o.id == l.id) {
                l.clip = old.clip.clone();
                l.thumb = old.thumb.clone();
                l.render_error = old.render_error.clone();
            }
        }
        if real_time.is_none() {
            entry.played_ts = prev.played_ts;
            entry.played_at = prev.played_at.clone();
        }
    }
    std::fs::write(&out, serde_json::to_string_pretty(&entry)?)?;
    Ok(Added::Added {
        id,
        map: entry.map,
        score: (entry.score_mine, entry.score_theirs),
        result: entry.result,
        seconds: t.elapsed().as_secs_f64(),
    })
}

/// Rendered clips: (match id, clip id, played_ts, clip path, thumb path), highlights and lowlights.
fn rendered_clips(root: &Path) -> Result<Vec<(String, String, i64, String, Option<String>)>> {
    let mut out = vec![];
    for f in std::fs::read_dir(root.join("matches"))? {
        let f = f?.path();
        if !f.extension().is_some_and(|e| e == "json") {
            continue;
        }
        let m: MatchEntry = serde_json::from_str(&std::fs::read_to_string(&f)?)?;
        for h in &m.highlights {
            if let Some(c) = &h.clip {
                out.push((m.id.clone(), h.id.clone(), m.played_ts, c.clone(), h.thumb.clone()));
            }
        }
        for l in &m.lowlights {
            if let Some(c) = &l.clip {
                out.push((m.id.clone(), l.id.clone(), m.played_ts, c.clone(), l.thumb.clone()));
            }
        }
    }
    Ok(out)
}

/// Bytes used by rendered clips (and their thumbnails): (highlight clips, lowlight clips) as
/// (count, bytes).
pub fn clip_usage(root: &Path) -> Result<((u32, u64), (u32, u64))> {
    let (mut hl, mut ll) = ((0, 0), (0, 0));
    for (_, id, _, clip, thumb) in rendered_clips(root)? {
        let bytes = [Some(clip), thumb].into_iter().flatten().filter_map(|p| std::fs::metadata(root.join(p)).ok()).map(|m| m.len()).sum::<u64>();
        let slot = if id.contains("-ll-") { &mut ll } else { &mut hl };
        slot.0 += 1;
        slot.1 += bytes;
    }
    Ok((hl, ll))
}

/// Removes the oldest rendered clips (never ones in a folder) until clips use at most
/// `max_bytes`. Removed moments stay in the library and can be rendered again on request.
/// Returns how many clips were removed.
pub fn enforce_clip_limit(root: &Path, max_bytes: u64) -> Result<usize> {
    let mut clips = rendered_clips(root)?;
    let size = |c: &(String, String, i64, String, Option<String>)| {
        [Some(c.3.clone()), c.4.clone()].into_iter().flatten().filter_map(|p| std::fs::metadata(root.join(p)).ok()).map(|m| m.len()).sum::<u64>()
    };
    let mut total: u64 = clips.iter().map(size).sum();
    if total <= max_bytes {
        return Ok(0);
    }
    let mut curation = crate::curation::Curation::load(root);
    clips.sort_by_key(|c| c.2);
    let mut removed: Vec<(String, String)> = vec![];
    for c in &clips {
        if total <= max_bytes {
            break;
        }
        if curation.protected(&c.1) {
            continue;
        }
        total = total.saturating_sub(size(c));
        let _ = std::fs::remove_file(root.join(&c.3));
        if let Some(t) = &c.4 {
            let _ = std::fs::remove_file(root.join(t));
        }
        curation.evicted.insert(c.1.clone());
        removed.push((c.0.clone(), c.1.clone()));
    }
    // Clear the clip paths in the affected match files.
    let mut by_match: HashMap<String, Vec<String>> = HashMap::new();
    for (mid, id) in &removed {
        by_match.entry(mid.clone()).or_default().push(id.clone());
    }
    for (mid, ids) in by_match {
        let path = root.join("matches").join(format!("{mid}.json"));
        let mut m: MatchEntry = serde_json::from_str(&std::fs::read_to_string(&path)?)?;
        for h in m.highlights.iter_mut().filter(|h| ids.contains(&h.id)) {
            h.clip = None;
            h.thumb = None;
        }
        for l in m.lowlights.iter_mut().filter(|l| ids.contains(&l.id)) {
            l.clip = None;
            l.thumb = None;
        }
        std::fs::write(&path, serde_json::to_string_pretty(&m)?)?;
    }
    curation.save(root)?;
    Ok(removed.len())
}

/// When a Valve (Premier/Competitive) match was played. CS2 saves `<demo>.info` next to the
/// demos it downloads: a protobuf (CDataGCCStrike15_v2_MatchInfo) whose field 2 is the match time
/// in Unix seconds.
pub fn valve_match_time(path: &Path) -> Option<i64> {
    let info = std::fs::read(format!("{}.info", path.display())).ok()?;
    fn varint(b: &[u8], i: &mut usize) -> Option<u64> {
        let (mut r, mut shift) = (0u64, 0);
        loop {
            let x = *b.get(*i)?;
            *i += 1;
            r |= ((x & 0x7f) as u64) << shift;
            if x < 0x80 {
                return Some(r);
            }
            shift += 7;
            if shift > 63 {
                return None;
            }
        }
    }
    let mut i = 0;
    while i < info.len() {
        let tag = varint(&info, &mut i)?;
        match (tag >> 3, tag & 7) {
            (2, 0) => return varint(&info, &mut i).map(|v| v as i64).filter(|v| *v > 1_000_000_000),
            (_, 0) => {
                varint(&info, &mut i)?;
            }
            (_, 2) => {
                let len = varint(&info, &mut i)? as usize;
                i += len;
            }
            (_, 1) => i += 8,
            (_, 5) => i += 4,
            _ => return None,
        }
    }
    None
}

/// Local time as the library writes it (RFC 3339 without offset).
pub fn local_time(ts: i64) -> String {
    chrono::DateTime::from_timestamp(ts, 0)
        .map(|d| d.with_timezone(&chrono::Local).format("%Y-%m-%dT%H:%M:%S").to_string())
        .unwrap_or_default()
}

/// Rebuilds `index.json` from every match file, writing back per-session party flags.
pub fn rebuild_index(root: &Path, me: u64) -> Result<Index> {
    let dir = root.join("matches");
    std::fs::create_dir_all(&dir)?;
    let mut all: Vec<MatchEntry> = vec![];
    for f in std::fs::read_dir(&dir)? {
        let f = f?.path();
        if f.extension().is_some_and(|e| e == "json") {
            all.push(serde_json::from_str(&std::fs::read_to_string(&f)?)?);
        }
    }
    // Highlights and lowlights you deleted stay deleted, even after re-analysis.
    let curation = crate::curation::Curation::load(root);
    for m in all.iter_mut() {
        m.highlights.retain(|h| !curation.deleted.contains(&h.id));
        m.lowlights.retain(|l| !curation.deleted.contains(&l.id));
    }
    // Rates and ratings always come from the raw counts with the current formulas.
    for m in all.iter_mut() {
        for p in m.players.iter_mut() {
            p.derived = p.counts.derived();
            p.t_rating3 = p.t.derived().rating3;
            p.ct_rating3 = p.ct.derived().rating3;
        }
    }
    // FACEIT knows when each match really started (demo files only carry the download time)
    // and the ELO it brought.
    if let Some(f) = crate::faceit::Faceit::load(root) {
        for m in all.iter_mut() {
            if let Some(fm) = f.find(&m.id) {
                if fm.finished_ts > 0 {
                    m.played_ts = fm.started(m.duration_s);
                    m.played_at = local_time(m.played_ts);
                }
                m.elo = fm.elo;
                m.elo_delta = fm.elo_delta;
                if !fm.competition.is_empty() {
                    m.competition = Some(fm.competition.clone());
                }
            }
        }
    }
    let index = library::build_index(me, &mut all, |ts| {
        chrono::DateTime::from_timestamp(ts, 0)
            .map(|d| d.with_timezone(&chrono::Local).format("%Y-%m-%d").to_string())
            .unwrap_or_default()
    });
    for m in &all {
        std::fs::write(dir.join(format!("{}.json", m.id)), serde_json::to_string_pretty(m)?)?;
    }
    std::fs::write(root.join("index.json"), serde_json::to_string_pretty(&index)?)?;
    Ok(index)
}
