//! Keeping the user's CS2 settings exactly as they were.
//!
//! - `cs2_video.txt` is swapped for the render (CS2 lets it override `-windowed`) and restored
//!   after CS2 has exited; the original sits next to it as `.veloxify-orig` so a crashed run is
//!   repaired by the next one.
//! - Console settings the profile changes are read first and set back over the console before CS2
//!   quits, so CS2 only ever saves (and syncs to Steam Cloud) the user's own values. A journal of
//!   the originals survives crashes and is replayed on the next run.
//! - The whole cfg folder is backed up before anything is touched.

use crate::vconsole::VConsole;
use anyhow::{Context, Result};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub struct Protector {
    user_cfg: PathBuf,
    work_dir: PathBuf,
}

impl Protector {
    pub fn new(user_cfg: PathBuf, work_dir: PathBuf) -> Self {
        Self { user_cfg, work_dir }
    }

    fn video(&self) -> PathBuf {
        self.user_cfg.join("cs2_video.txt")
    }
    fn video_orig(&self) -> PathBuf {
        self.user_cfg.join("cs2_video.txt.veloxify-orig")
    }
    fn journal(&self) -> PathBuf {
        self.work_dir.join("cvar-journal.json")
    }

    pub fn backup_cfg(&self) -> Result<PathBuf> {
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_secs();
        let dest = self.work_dir.join("cfg-backups").join(stamp.to_string());
        std::fs::create_dir_all(&dest)?;
        for e in std::fs::read_dir(&self.user_cfg).with_context(|| format!("reading {}", self.user_cfg.display()))? {
            let e = e?;
            if e.file_type()?.is_file() {
                std::fs::copy(e.path(), dest.join(e.file_name()))?;
            }
        }
        // Keep only the 20 most recent backups.
        let mut all: Vec<_> = std::fs::read_dir(dest.parent().unwrap())?.flatten().map(|e| e.path()).collect();
        all.sort();
        for old in all.iter().take(all.len().saturating_sub(20)) {
            let _ = std::fs::remove_dir_all(old);
        }
        Ok(dest)
    }

    /// Writes the render's video settings (plus a borderless window of the output size).
    pub fn apply_video(&self, overrides: &BTreeMap<String, String>) -> Result<()> {
        if !self.video_orig().exists() {
            std::fs::copy(self.video(), self.video_orig())?;
        }
        let text = std::fs::read_to_string(self.video_orig())?;
        let mut out = String::with_capacity(text.len());
        let mut seen = std::collections::BTreeSet::new();
        for line in text.split_inclusive('\n') {
            let parts: Vec<&str> = line.split('"').collect();
            // `<indent>"key"<sep>"value"<eol>` -> parts: [indent, key, sep, value, eol]
            if parts.len() == 5 {
                if let Some(v) = overrides.get(parts[1]) {
                    out.push_str(&format!("{}\"{}\"{}\"{}\"{}", parts[0], parts[1], parts[2], v, parts[4]));
                    seen.insert(parts[1].to_string());
                    continue;
                }
            }
            out.push_str(line);
        }
        // Settings missing from the file go before the closing brace.
        let missing: String = overrides
            .iter()
            .filter(|(k, _)| !seen.contains(*k))
            .map(|(k, v)| format!("\t\"{k}\"\t\t\"{v}\"\n"))
            .collect();
        if !missing.is_empty() {
            if let Some(i) = out.rfind('}') {
                out.insert_str(i, &missing);
            }
        }
        std::fs::write(self.video(), out)?;
        Ok(())
    }

    /// Puts the user's own cs2_video.txt back (no-op when nothing was swapped).
    pub fn restore_video(&self) -> Result<bool> {
        if self.video_orig().exists() {
            std::fs::copy(self.video_orig(), self.video())?;
            std::fs::remove_file(self.video_orig())?;
            return Ok(true);
        }
        Ok(false)
    }

    /// Reads the current values of every setting about to change (keeping originals from a
    /// crashed run's journal), journals them, then applies `wanted`.
    pub fn apply_console(&self, vc: &VConsole, wanted: &BTreeMap<String, String>) -> Result<BTreeMap<String, String>> {
        let mut originals: BTreeMap<String, String> = std::fs::read_to_string(self.journal())
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        for name in wanted.keys() {
            if !originals.contains_key(name) {
                if let Some(v) = vc.read_cvar(name) {
                    originals.insert(name.clone(), v);
                }
            }
        }
        std::fs::create_dir_all(&self.work_dir)?;
        std::fs::write(self.journal(), serde_json::to_string_pretty(&originals)?)?;
        for (name, val) in wanted {
            vc.send(&format!("{name} \"{val}\"")); // quoted: values like device ids contain braces
        }
        Ok(originals)
    }

    pub fn revert_console(&self, vc: &VConsole, originals: &BTreeMap<String, String>) {
        for (name, val) in originals {
            vc.send(&format!("{name} \"{val}\""));
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
        let _ = std::fs::remove_file(self.journal());
    }

    pub fn has_pending_journal(&self) -> bool {
        self.journal().exists()
    }
}

pub fn path_display(p: &Path) -> String {
    p.display().to_string()
}
