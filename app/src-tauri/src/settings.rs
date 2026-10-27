//! App settings and state, stored in `%LOCALAPPDATA%\Veloxify`.

use cs2hl_core::highlights::{preset_kinds, HighlightRules, Selectivity, MAX_PER_PLAYER};
use cs2hl_core::library::ClipPolicy;
use cs2hl_render::batch::LineupPlan;
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
fn d_film_wait() -> u32 {
    60
}
fn d_max() -> usize {
    MAX_PER_PLAYER
}
fn d_one() -> u32 {
    1
}
fn d_lowlights() -> usize {
    3
}
fn d_lineups_per_map() -> usize {
    LineupPlan::default().per_map
}
fn d_lineup_kinds() -> Vec<String> {
    LineupPlan::default().kinds
}
fn d_lineup_categories() -> Vec<String> {
    LineupPlan::default().categories
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
    /// Also render the worst deaths (lowlights) of the latest session, after the highlights.
    #[serde(default = "d_true")]
    pub auto_lowlights: bool,
    /// Film grenade lineup videos (the most thrown first) after the highlights.
    #[serde(default = "d_true")]
    pub auto_lineups: bool,
    /// Download new Premier and Competitive demos from Valve after you close CS2 (no need to
    /// download them in CS2's Watch tab).
    #[serde(default = "d_true")]
    pub premier_auto: bool,
    /// Minutes after CS2 was last open before Veloxify films or checks for Premier matches on its
    /// own (you may only be between games); 0: right away.
    #[serde(default = "d_film_wait")]
    pub film_wait_min: u32,
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
    /// What counts as a highlight (see `highlights::kinds_of`); empty: the `selectivity` level's.
    #[serde(default)]
    pub highlight_kinds: Vec<String>,
    /// Clutches count from 1 vs this many.
    #[serde(default = "d_one")]
    pub clutch_min: u32,
    /// Leave out moments where most kills were on players who'd saved.
    #[serde(default)]
    pub skip_eco: bool,
    /// Lowlights filmed automatically per match of the latest session (the worst ones).
    #[serde(default = "d_lowlights")]
    pub lowlights_per_match: usize,
    /// Grenade lineup videos filmed automatically: the most thrown on each map, up to this many.
    #[serde(default = "d_lineups_per_map")]
    pub lineups_per_map: usize,
    /// Which grenades ("smoke", "molotov", "flash", "he") and lineups ("instant", "set") those are.
    #[serde(default = "d_lineup_kinds")]
    pub lineup_kinds: Vec<String>,
    #[serde(default = "d_lineup_categories")]
    pub lineup_categories: Vec<String>,
    /// Teammates whose highlights are also made (SteamID64s; off unless added).
    #[serde(default)]
    pub also_clip: Vec<u64>,
    #[serde(default)]
    pub start_with_windows: bool,
    /// Storage limits in GB (0 = no limit): rendered clips (oldest not in a folder go first) and
    /// demos in Veloxify's own folder.
    #[serde(default)]
    pub max_clips_gb: f64,
    #[serde(default)]
    pub max_demos_gb: f64,
    /// Your own Practice presets (as the Practice tab saves them).
    #[serde(default)]
    pub practice: Vec<serde_json::Value>,
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
                    auto_lowlights: true,
                    auto_lineups: true,
                    premier_auto: true,
                    film_wait_min: d_film_wait(),
                    profile: profile.clone(),
                    faceit_enabled: true,
                    faceit_nickname: String::new(),
                    selectivity: d_selectivity(),
                    max_per_match: d_max(),
                    highlight_kinds: vec![],
                    clutch_min: 1,
                    skip_eco: false,
                    lowlights_per_match: d_lowlights(),
                    lineups_per_map: d_lineups_per_map(),
                    lineup_kinds: d_lineup_kinds(),
                    lineup_categories: d_lineup_categories(),
                    also_clip: vec![],
                    start_with_windows: false,
                    max_clips_gb: 0.0,
                    max_demos_gb: 0.0,
                    practice: vec![],
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

    /// What counts as a highlight: the kinds chosen in Settings (or the old level's).
    pub fn highlight_rules(&self) -> HighlightRules {
        let kinds = if self.highlight_kinds.is_empty() { preset_kinds(Selectivity::parse(&self.selectivity).unwrap_or(Selectivity::SolidPlays)) } else { self.highlight_kinds.clone() };
        HighlightRules { kinds, clutch_min: self.clutch_min.clamp(1, 5), skip_eco: self.skip_eco, cap: self.max_per_match.clamp(1, 20) }
    }

    pub fn clip_policy(&self) -> ClipPolicy {
        ClipPolicy { also_clip: self.also_clip.clone(), rules: self.highlight_rules() }
    }

    /// Which lineups get videos on their own.
    pub fn lineup_plan(&self) -> LineupPlan {
        LineupPlan { per_map: self.lineups_per_map.clamp(1, 200), kinds: self.lineup_kinds.clone(), categories: self.lineup_categories.clone() }
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
    /// Kill feed only (Allstar look) instead of the full spectator HUD.
    pub killfeed_only: bool,
    /// The recorded player's own crosshair instead of the profile's.
    pub own_crosshair: bool,
    /// A crosshair share code to record with instead (empty = the clean default).
    #[serde(default)]
    pub crosshair: String,
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
            killfeed_only: c("cl_draw_only_deathnotices") != "0",
            own_crosshair: c("cl_show_observer_crosshair") == "2",
            crosshair: c("_crosshair_code"),
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
        // Steam's in-game FPS counter is drawn into CS2's picture, so recordings catch it: cover it
        // where it's found (only a corner with the counter in it is covered).
        p["output"]["hide_fps_counter"] = true.into();
        p["console"]["cl_draw_only_deathnotices"] = (if self.killfeed_only { "1" } else { "0" }).into();
        p["console"]["cl_show_observer_crosshair"] = (if self.own_crosshair { "2" } else { "0" }).into();
        // The crosshair recordings use, in CS2's pixel variables: a chosen code, else the clean
        // default. (Never the CS:GO-era ones: see LEGACY_CVARS.)
        let chosen = cs2hl_core::crosshair::decode(&self.crosshair);
        p["console"]["_crosshair_code"] = (if chosen.is_some() { self.crosshair.trim() } else { "" }).into();
        for (k, v) in cs2hl_core::crosshair::convars(chosen.as_ref().unwrap_or(&cs2hl_core::crosshair::CLEAN)) {
            p["console"][k] = v.into();
        }
        if let Some(console) = p["console"].as_object_mut() {
            console.retain(|k, _| !cs2hl_core::crosshair::LEGACY_CVARS.contains(&k.as_str()));
        }
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
