//! Adding demos to a library on disk (`matches/<id>.json` + `index.json`).

use crate::library::{self, ClipPolicy, Index, MatchEntry};
use crate::{analysis, demo_io, model, stats};
use anyhow::Result;
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
    let local: chrono::DateTime<chrono::Local> = std::fs::metadata(path)?.modified()?.into();
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
        entry.played_ts = prev.played_ts;
        entry.played_at = prev.played_at.clone();
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
