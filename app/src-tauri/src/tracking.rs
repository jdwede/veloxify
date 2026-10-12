//! What the user played with, for the Sessions page's "what we noticed": their CS2 settings
//! (resolution, display mode, graphics, sensitivity) and mouse, recorded when they close CS2
//! after playing (`settings_log.json`, a new entry only when something changed), and the practice
//! they start from Veloxify (`practice_log.json`).

use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Setup {
    /// "2560x1440"
    pub resolution: String,
    /// "16:9", "4:3", "16:10"
    pub aspect: String,
    /// "fullscreen", "windowed" or "borderless"
    pub display: String,
    pub refresh_hz: u32,
    /// The graphics settings, condensed ("shadows low, MSAA 2x, ...").
    pub graphics: String,
    pub sensitivity: String,
    pub zoom_sensitivity: String,
    /// The mice plugged in (their product names).
    pub mice: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetupEntry {
    pub ts: i64,
    #[serde(flatten)]
    pub setup: Setup,
}

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// `"key"  "value"` pairs of a CS2 config file.
fn kv(text: &str) -> std::collections::HashMap<String, String> {
    text.lines()
        .filter_map(|l| {
            let mut parts = l.split('"').filter(|p| !p.trim().is_empty());
            Some((parts.next()?.to_string(), parts.next()?.to_string()))
        })
        .collect()
}

/// The user's setup now: their own video settings (not a render's), sensitivity and mice.
pub fn current(steamid64: u64) -> Option<Setup> {
    let dir = cs2hl_render::steam::user_cfg_dir(steamid64);
    // During (or after a cut-short) render the user's own file waits as `.veloxify-orig`.
    let video = std::fs::read_to_string(dir.join("cs2_video.txt.veloxify-orig")).or_else(|_| std::fs::read_to_string(dir.join("cs2_video.txt"))).ok()?;
    let v = kv(&video);
    let user = kv(&std::fs::read_to_string(dir.join("cs2_user_convars_0_slot0.vcfg")).unwrap_or_default());
    let get = |k: &str| v.get(k).cloned().unwrap_or_default();
    let (w, h) = (get("setting.defaultres"), get("setting.defaultresheight"));
    let aspect = match get("setting.aspectratiomode").as_str() {
        "0" => "4:3",
        "2" => "16:10",
        _ => "16:9",
    };
    let display = match (get("setting.fullscreen").as_str(), get("setting.nowindowborder").as_str()) {
        ("1", _) => "fullscreen",
        (_, "1") => "borderless",
        _ => "windowed",
    };
    let hz = get("setting.refreshrate_numerator").parse::<f64>().ok().zip(get("setting.refreshrate_denominator").parse::<f64>().ok()).map_or(0, |(n, d)| (n / d.max(1.0)).round() as u32);
    let level = |k: &str, names: &[&str]| get(k).parse::<usize>().ok().and_then(|i| names.get(i).copied()).unwrap_or("?").to_string();
    let graphics = format!(
        "shadows {}, textures {}, effects {}, MSAA {}x, shaders {}",
        level("setting.videocfg_shadow_quality", &["low", "medium", "high", "very high"]),
        level("setting.videocfg_texture_detail", &["low", "medium", "high"]),
        level("setting.videocfg_particle_detail", &["low", "medium", "high", "very high"]),
        get("setting.msaa_samples").parse::<u32>().unwrap_or(0),
        level("setting.shaderquality", &["low", "high"]),
    );
    Some(Setup {
        resolution: if w.is_empty() { String::new() } else { format!("{w}x{h}") },
        aspect: aspect.into(),
        display: display.into(),
        refresh_hz: hz,
        graphics,
        sensitivity: user.get("sensitivity").cloned().unwrap_or_default(),
        zoom_sensitivity: user.get("zoom_sensitivity_ratio").cloned().unwrap_or_else(|| "1".into()),
        mice: crate::system::mice(),
    })
}

/// Records the setup if it changed since the last entry. Returns whether it did.
pub fn record(lib: &Path, steamid64: u64) -> bool {
    let Some(setup) = current(steamid64) else { return false };
    let file = lib.join("settings_log.json");
    let mut log: Vec<SetupEntry> = std::fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    if log.last().is_some_and(|l| l.setup == setup) {
        return false;
    }
    log.push(SetupEntry { ts: now(), setup });
    std::fs::write(&file, serde_json::to_string_pretty(&log).unwrap_or_default()).is_ok()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PracticeEntry {
    pub ts: i64,
    pub kind: String,
    pub target: String,
    pub mode: String,
}

/// Notes a practice launch from the Practice tab.
pub fn log_practice(lib: &Path, kind: &str, target: &str, mode: &str) {
    let file = lib.join("practice_log.json");
    let mut log: Vec<PracticeEntry> = std::fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    log.push(PracticeEntry { ts: now(), kind: kind.into(), target: target.into(), mode: mode.into() });
    let _ = std::fs::write(&file, serde_json::to_string_pretty(&log).unwrap_or_default());
}
