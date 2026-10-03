//! App settings and state, stored in `%LOCALAPPDATA%\Veloxify`.

use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::path::PathBuf;

const DEFAULT_PROFILE: &str = include_str!("../../../profiles/default.json");

pub fn data_dir() -> PathBuf {
    std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir).join("Veloxify")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    /// Where matches, clips and the index live. `VELOXIFY_LIBRARY` overrides it (development).
    pub library_dir: PathBuf,
    /// Folders watched for new demos (browser downloads, CS2's replays folder).
    pub watch_dirs: Vec<PathBuf>,
    /// Whose highlights to make. Defaults to the account logged in to Steam.
    pub steamid64: Option<u64>,
    /// Render new sessions automatically once CS2 closes.
    pub auto_render: bool,
    pub profile: PathBuf,
}

impl Settings {
    pub fn load() -> Self {
        let dir = data_dir();
        let _ = std::fs::create_dir_all(&dir);
        let profile = dir.join("profile.json");
        if !profile.exists() {
            let _ = std::fs::write(&profile, DEFAULT_PROFILE);
        }
        let mut s: Settings = std::fs::read_to_string(dir.join("settings.json"))
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_else(|| {
                let home = std::env::var_os("USERPROFILE").map(PathBuf::from).unwrap_or_default();
                let mut watch = vec![home.join("Downloads")];
                if let Ok(csgo) = cs2hl_render::steam::cs2_csgo_dir() {
                    watch.push(csgo.join("replays"));
                }
                Settings { library_dir: dir.join("library"), watch_dirs: watch, steamid64: None, auto_render: true, profile: profile.clone() }
            });
        if let Some(lib) = std::env::var_os("VELOXIFY_LIBRARY") {
            s.library_dir = PathBuf::from(lib);
        }
        let _ = std::fs::create_dir_all(&s.library_dir);
        s.save();
        s
    }

    pub fn save(&self) {
        let _ = std::fs::write(data_dir().join("settings.json"), serde_json::to_string_pretty(self).unwrap_or_default());
    }
}

/// Demo files already looked at (added, skipped or failed), so they're never parsed twice.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Seen {
    pub files: BTreeSet<String>,
}

impl Seen {
    pub fn load() -> Self {
        std::fs::read_to_string(data_dir().join("seen.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    }
    pub fn save(&self) {
        let _ = std::fs::write(data_dir().join("seen.json"), serde_json::to_string(self).unwrap_or_default());
    }
}
