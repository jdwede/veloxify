//! Render profiles (see `profiles/default.json`): output format, CS2 video settings, console
//! settings (HUD, crosshair, x-ray, ...) and audio. Keys starting with `_` are comments.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Profile {
    pub output: Output,
    #[serde(default)]
    pub video: BTreeMap<String, String>,
    #[serde(default)]
    pub console: BTreeMap<String, String>,
    #[serde(default)]
    pub audio: Audio,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Output {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    #[serde(default = "d_capture_bitrate")]
    pub capture_bitrate_mbps: u32,
    #[serde(default = "d_crf")]
    pub final_crf: u32,
    #[serde(default = "d_max_bitrate")]
    pub max_bitrate_mbps: u32,
    #[serde(default = "d_encoder")]
    pub final_encoder: String,
    /// "cut" or "fade" between segments of a moment.
    #[serde(default = "d_transition")]
    pub transition: String,
    #[serde(default = "d_transition_s")]
    pub transition_seconds: f64,
    #[serde(default = "d_true")]
    pub hide_fps_counter: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Audio {
    #[serde(default = "d_true")]
    pub enabled: bool,
    /// Output device (by name) CS2 plays to during renders; it should play to nothing.
    #[serde(default = "d_silent")]
    pub silent_device: String,
    #[serde(default = "d_volume")]
    pub game_volume: f64,
    #[serde(default = "d_lufs")]
    pub loudness_lufs: f64,
    #[serde(default = "d_abitrate")]
    pub bitrate_kbps: u32,
}

impl Default for Audio {
    fn default() -> Self {
        Self {
            enabled: true,
            silent_device: d_silent(),
            game_volume: d_volume(),
            loudness_lufs: d_lufs(),
            bitrate_kbps: d_abitrate(),
        }
    }
}

fn d_capture_bitrate() -> u32 {
    40
}
fn d_crf() -> u32 {
    23
}
fn d_max_bitrate() -> u32 {
    12
}
fn d_encoder() -> String {
    "nvenc".into()
}
fn d_transition() -> String {
    "cut".into()
}
fn d_transition_s() -> f64 {
    0.35
}
fn d_true() -> bool {
    true
}
fn d_silent() -> String {
    "Steam Streaming Speakers".into()
}
fn d_volume() -> f64 {
    0.6
}
fn d_lufs() -> f64 {
    -18.0
}
fn d_abitrate() -> u32 {
    192
}

impl Profile {
    pub fn load(path: &Path) -> Result<Self> {
        let mut p: Profile = serde_json::from_str(&std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?)
            .with_context(|| format!("parsing {}", path.display()))?;
        p.video.retain(|k, _| !k.starts_with('_'));
        p.console.retain(|k, _| !k.starts_with('_'));
        // CS2's crosshair is in pixels since September 2026: a profile from before sets the old
        // variables, which CS2 converts in ways that can't be put back. Use the pixel ones instead
        // (the clean default unless the profile already has them).
        p.console.retain(|k, _| !cs2hl_core::crosshair::LEGACY_CVARS.contains(&k.as_str()));
        if !p.console.contains_key("cl_crosshair_length") {
            for (k, v) in cs2hl_core::crosshair::convars(&cs2hl_core::crosshair::CLEAN) {
                p.console.insert(k.to_string(), v);
            }
        }
        Ok(p)
    }
}
