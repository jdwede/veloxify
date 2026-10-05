//! Managing clips: delete, folders (with export for montages), storage usage and limits.

use crate::settings::Settings;
use cs2hl_core::curation::{Curation, Folder};
use cs2hl_core::library::Index;
use serde::Serialize;
use std::path::{Path, PathBuf};

/// Clip id -> (clip path, thumbnail path, title), for highlights and lowlights in the index.
fn clip_files(lib: &Path) -> Vec<(String, Option<String>, Option<String>, String)> {
    let Some(index) = std::fs::read_to_string(lib.join("index.json")).ok().and_then(|t| serde_json::from_str::<Index>(&t).ok()) else {
        return vec![];
    };
    let mut out: Vec<_> = index.highlights.into_iter().map(|h| (h.id, h.clip, h.thumb, h.title)).collect();
    out.extend(index.lowlights.into_iter().map(|l| (l.id, l.clip, l.thumb, l.title)));
    out
}

/// Deletes clips (files and all) for good: they're never shown or rendered again.
pub fn delete(lib: &Path, ids: &[String]) -> std::io::Result<usize> {
    let mut curation = Curation::load(lib);
    let mut n = 0;
    for (id, clip, thumb, _) in clip_files(lib).into_iter().filter(|c| ids.contains(&c.0)) {
        for p in [clip, thumb].into_iter().flatten() {
            let _ = std::fs::remove_file(lib.join(p));
        }
        curation.deleted.insert(id.clone());
        curation.evicted.remove(&id);
        n += 1;
    }
    for f in curation.folders.iter_mut() {
        f.items.retain(|i| !ids.contains(i));
    }
    curation.save(lib)?;
    Ok(n)
}

pub fn create_folder(lib: &Path, name: &str) -> std::io::Result<Folder> {
    let mut curation = Curation::load(lib);
    let created = chrono::Utc::now().timestamp();
    let folder = Folder { id: format!("f{created}{}", curation.folders.len()), name: name.trim().to_string(), items: vec![], created };
    curation.folders.push(folder.clone());
    curation.save(lib)?;
    Ok(folder)
}

pub fn update_folders(lib: &Path, f: impl FnOnce(&mut Vec<Folder>)) -> std::io::Result<()> {
    let mut curation = Curation::load(lib);
    f(&mut curation.folders);
    curation.save(lib)
}

fn safe_name(s: &str) -> String {
    let s: String = s.chars().map(|c| if "<>:\"/\\|?*".contains(c) || c.is_control() { '-' } else { c }).collect();
    s.trim().trim_end_matches('.').chars().take(80).collect()
}

/// Copies a folder's rendered clips, in order, to `Videos\Veloxify\<folder>` for editing a
/// montage. Returns the destination and how many clips were copied (unrendered ones are skipped).
pub fn export_folder(lib: &Path, id: &str) -> std::io::Result<(PathBuf, usize)> {
    let curation = Curation::load(lib);
    let folder = curation.folders.iter().find(|f| f.id == id).ok_or_else(|| std::io::Error::other("no such folder"))?;
    let home = std::env::var_os("USERPROFILE").map(PathBuf::from).unwrap_or_default();
    let dest = home.join("Videos").join("Veloxify").join(safe_name(&folder.name));
    std::fs::create_dir_all(&dest)?;
    let files = clip_files(lib);
    let mut n = 0;
    for (i, item) in folder.items.iter().enumerate() {
        if let Some((_, Some(clip), _, title)) = files.iter().find(|c| &c.0 == item) {
            std::fs::copy(lib.join(clip), dest.join(format!("{:02} - {}.mp4", i + 1, safe_name(title))))?;
            n += 1;
        }
    }
    Ok((dest, n))
}

#[derive(Serialize, Default)]
pub struct Usage {
    pub highlight_clips: u32,
    pub highlight_bytes: u64,
    pub lowlight_clips: u32,
    pub lowlight_bytes: u64,
    /// Demo files Veloxify has imported (e.g. from Downloads).
    pub demos: u32,
    pub demo_bytes: u64,
    /// Match data, index and map emblems.
    pub data_bytes: u64,
}

fn dir_size(p: &Path) -> u64 {
    std::fs::read_dir(p)
        .map(|d| d.flatten().map(|e| e.metadata().map(|m| if m.is_dir() { dir_size(&e.path()) } else { m.len() }).unwrap_or(0)).sum())
        .unwrap_or(0)
}

/// Demo files Veloxify has imported (wherever they are, e.g. Downloads) plus any in its own
/// folder, oldest first: (path, bytes, modified).
fn own_demos(lib: &Path) -> Vec<(PathBuf, u64, std::time::SystemTime)> {
    let mut paths: Vec<PathBuf> = std::fs::read_dir(lib.join("matches"))
        .map(|d| {
            d.flatten()
                .filter_map(|e| std::fs::read_to_string(e.path()).ok())
                .filter_map(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
                .filter_map(|v| v["demo_path"].as_str().map(PathBuf::from))
                .collect()
        })
        .unwrap_or_default();
    if let Ok(d) = std::fs::read_dir(crate::demos::demos_dir()) {
        paths.extend(d.flatten().map(|e| e.path()).filter(|p| p.to_string_lossy().to_lowercase().contains(".dem")));
    }
    paths.sort();
    paths.dedup();
    let mut out: Vec<_> =
        paths.into_iter().filter_map(|p| std::fs::metadata(&p).ok().map(|m| (p, m.len(), m.modified().unwrap_or(std::time::UNIX_EPOCH)))).collect();
    out.sort_by_key(|(_, _, t)| *t);
    out
}

pub fn usage(lib: &Path) -> Usage {
    let ((hc, hb), (lc, lb)) = cs2hl_core::ingest::clip_usage(lib).unwrap_or_default();
    let demos = own_demos(lib);
    Usage {
        highlight_clips: hc,
        highlight_bytes: hb,
        lowlight_clips: lc,
        lowlight_bytes: lb,
        demos: demos.len() as u32,
        demo_bytes: demos.iter().map(|d| d.1).sum(),
        data_bytes: dir_size(&lib.join("matches")) + dir_size(&lib.join("maps")) + ["index.json", "faceit.json", "curation.json"].iter().filter_map(|f| std::fs::metadata(lib.join(f)).ok()).map(|m| m.len()).sum::<u64>(),
    }
}

/// Applies the storage limits in settings (0 = no limit): the oldest clips that aren't in a folder
/// and the oldest demos Veloxify has imported go first. Returns (clips removed, demos removed).
pub fn enforce(settings: &Settings) -> (usize, usize) {
    let gb = 1024.0 * 1024.0 * 1024.0;
    let clips = if settings.max_clips_gb > 0.0 {
        cs2hl_core::ingest::enforce_clip_limit(&settings.library_dir, (settings.max_clips_gb * gb) as u64).unwrap_or(0)
    } else {
        0
    };
    let mut demos = 0;
    if settings.max_demos_gb > 0.0 {
        let limit = (settings.max_demos_gb * gb) as u64;
        let files = own_demos(&settings.library_dir);
        let mut total: u64 = files.iter().map(|f| f.1).sum();
        // Never a demo from the last day: it may still be waiting to be analyzed or clipped.
        let recent = std::time::SystemTime::now() - std::time::Duration::from_secs(24 * 3600);
        for (path, bytes, modified) in files {
            if total <= limit {
                break;
            }
            if modified > recent {
                continue;
            }
            if std::fs::remove_file(&path).is_ok() {
                total = total.saturating_sub(bytes);
                demos += 1;
            }
        }
    }
    (clips, demos)
}
