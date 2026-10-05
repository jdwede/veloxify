//! App settings and state, stored in `%LOCALAPPDATA%\Veloxify`.

use cs2hl_core::highlights::{Selectivity, MAX_PER_PLAYER};
use cs2hl_core::library::ClipPolicy;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

const DEFAULT_PROFILE: &str = include_str!("../../../profiles/default.json");

pub fn data_dir() -> PathBuf {
    std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir).join("Veloxify")
}

fn d_true() -> bool {
    true
}
fn d_selectivity() -> String {
    "solid-plays".into()
}
fn d_max() -> usize {
    MAX_PER_PLAYER
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
    /// Look up the FACEIT account linked to the Steam account (level, ELO, match list).
    #[serde(default = "d_true")]
    pub faceit_enabled: bool,
    /// Only needed when the account can't be found from the Steam account and demos.
    #[serde(default)]
    pub faceit_nickname: String,
    /// "everything", "solid-plays" or "highlights-only".
    #[serde(default = "d_selectivity")]
    pub selectivity: String,
    #[serde(default = "d_max")]
    pub max_per_match: usize,
    /// Teammates whose highlights are also made (SteamID64s; off unless added).
    #[serde(default)]
    pub also_clip: Vec<u64>,
    #[serde(default)]
    pub start_with_windows: bool,
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
                Settings {
                    library_dir: dir.join("library"),
                    watch_dirs: watch,
                    steamid64: None,
                    auto_render: true,
                    profile: profile.clone(),
                    faceit_enabled: true,
                    faceit_nickname: String::new(),
                    selectivity: d_selectivity(),
                    max_per_match: d_max(),
                    also_clip: vec![],
                    start_with_windows: false,
                }
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

    pub fn clip_policy(&self) -> ClipPolicy {
        ClipPolicy {
            also_clip: self.also_clip.clone(),
            selectivity: Selectivity::parse(&self.selectivity).unwrap_or(Selectivity::SolidPlays),
            max_per_player: self.max_per_match.clamp(1, 20),
        }
    }
}

/// The render-profile options the Settings page offers. Everything else in the profile file
/// (and its comments) is left as it is.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenderOptions {
    /// Output height: 720, 1080 or 1440 (16:9).
    pub height: u32,
    pub fps: u32,
    /// "cut" or "fade" between the parts of a highlight.
    pub transition: String,
    pub hide_fps_counter: bool,
    /// Kill feed only (Allstar look) instead of the full spectator HUD.
    pub killfeed_only: bool,
    /// The recorded player's own crosshair instead of the profile's.
    pub own_crosshair: bool,
    pub xray: bool,
    pub audio: bool,
}

fn read_profile(path: &Path) -> Value {
    std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_else(|| serde_json::from_str(DEFAULT_PROFILE).unwrap())
}

impl RenderOptions {
    pub fn load(path: &Path) -> Self {
        let p = read_profile(path);
        let c = |k: &str| p["console"][k].as_str().unwrap_or("").to_string();
        RenderOptions {
            height: p["output"]["height"].as_u64().unwrap_or(1080) as u32,
            fps: p["output"]["fps"].as_u64().unwrap_or(60) as u32,
            transition: p["output"]["transition"].as_str().unwrap_or("cut").into(),
            hide_fps_counter: p["output"]["hide_fps_counter"].as_bool().unwrap_or(true),
            killfeed_only: c("cl_draw_only_deathnotices") != "0",
            own_crosshair: c("cl_show_observer_crosshair") == "2",
            xray: c("spec_show_xray") == "1",
            audio: p["audio"]["enabled"].as_bool().unwrap_or(true),
        }
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        let mut p = read_profile(path);
        let height = match self.height {
            720 | 1080 | 1440 => self.height,
            _ => 1080,
        };
        p["output"]["height"] = height.into();
        p["output"]["width"] = (height * 16 / 9).into();
        p["output"]["fps"] = (if self.fps == 30 { 30 } else { 60 }).into();
        p["output"]["transition"] = (if self.transition == "fade" { "fade" } else { "cut" }).into();
        p["output"]["hide_fps_counter"] = self.hide_fps_counter.into();
        p["console"]["cl_draw_only_deathnotices"] = (if self.killfeed_only { "1" } else { "0" }).into();
        p["console"]["cl_show_observer_crosshair"] = (if self.own_crosshair { "2" } else { "0" }).into();
        p["console"]["spec_show_xray"] = (if self.xray { "1" } else { "0" }).into();
        p["audio"]["enabled"] = self.audio.into();
        std::fs::write(path, serde_json::to_string_pretty(&p).unwrap_or_default())
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
