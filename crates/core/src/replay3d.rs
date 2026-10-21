//! Everyone's movement and aim through each round, 32 times a second, for the 3D replay
//! (`matches/<id>.r3d.gz`). The 2D replay (8 a second) has the rest: weapons, health changes,
//! places; the match details have the kills.
//!
//! File (gzip): `VR3D`, u32 version, u32 header length, the header (JSON), then for each round
//! (header order) and each player (header order) `n` samples of 8 little-endian i16:
//! x, y, z (game units), yaw × 50, pitch × 100 (degrees; pitch positive = looking down),
//! duck × 1000, health (0 = dead or not there), flags (1 = scoped in).
//! Each round in the header also lists its shots and reloads (tick, player number).
//! After all that, for each round and player, `hud_n` samples (every `HUD_STEP` ticks from the
//! round's start) of 5 i16: ammo in the gun, ammo left besides, armor, helmet (0/1), money.

use crate::model::{Match, TICKRATE};
use crate::raw;
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};

/// Bumped when the file changes; older files are built again.
pub const VERSION: u32 = 2;
/// A sample every this many ticks (32 a second).
pub const STEP: i32 = 2;
/// Numbers per sample.
pub const STRIDE: usize = 8;
/// The HUD's numbers (ammo, armor, money) every this many ticks (8 a second).
pub const HUD_STEP: i32 = 8;
const HUD_PROPS: [&str; 5] = ["active_weapon_ammo", "total_ammo_left", "armor_value", "has_helmet", "balance"];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Header {
    pub version: u32,
    pub map: String,
    pub tickrate: f64,
    pub step: i32,
    /// Numbers per sample.
    pub stride: usize,
    pub hud_step: i32,
    pub hud_stride: usize,
    /// SteamID64s (as text), the same order as the 2D replay's players.
    pub players: Vec<String>,
    pub names: Vec<String>,
    pub rounds: Vec<RoundSpan>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoundSpan {
    pub number: u32,
    /// First sample's tick (a multiple of `step`); samples run `n` × `step` ticks from here.
    pub start: i32,
    pub n: usize,
    /// HUD samples, every `hud_step` ticks from `start`.
    pub hud_n: usize,
    /// Every gun shot this round: (tick, player number in `players`). Grenade throws aren't in it.
    pub shots: Vec<(i32, u8)>,
    /// Reloads started: (tick, player number).
    pub reloads: Vec<(i32, u8)>,
}

pub fn path(root: &Path, id: &str) -> PathBuf {
    root.join("matches").join(format!("{id}.r3d.gz"))
}

/// Whether the match's 3D replay is there and current.
pub fn current(root: &Path, id: &str) -> bool {
    let Ok(f) = std::fs::File::open(path(root, id)) else { return false };
    let mut head = [0u8; 8];
    use std::io::Read;
    flate2::read::GzDecoder::new(f).read_exact(&mut head).is_ok() && &head[..4] == b"VR3D" && u32::from_le_bytes([head[4], head[5], head[6], head[7]]) == VERSION
}

/// Reads the demo again for the 3D replay and saves it.
pub fn write(root: &Path, id: &str, demo: &[u8], m: &Match) -> Result<()> {
    let spans: Vec<(u32, i32, i32)> = m
        .rounds
        .iter()
        .map(|r| {
            // From a few seconds before the round goes live (the end of the buy time) to 3 s after it ends.
            let start = (r.live_tick - (3.0 * TICKRATE) as i32).max(0);
            (r.number, start - start.rem_euclid(STEP), r.end_tick + (3.0 * TICKRATE) as i32)
        })
        .collect();
    let mut ticks = vec![];
    for &(_, a, b) in &spans {
        ticks.extend((a..=b).step_by(STEP as usize));
    }
    let sids: Vec<u64> = m.players.iter().map(|p| p.steamid).collect();
    let table = raw::players_table(demo, &sids, &["X", "Y", "Z", "yaw", "pitch", "duck_amount", "health", "is_scoped"], &ticks)?;
    let hud_ticks: Vec<i32> = ticks.iter().copied().filter(|t| t.rem_euclid(HUD_STEP) == 0).collect();
    let hud = raw::players_table(demo, &sids, &HUD_PROPS, &hud_ticks)?;
    let who = |sid: u64| sids.iter().position(|s| *s == sid).map(|i| i as u8);
    let within = |tick: i32, a: i32, b: i32| tick >= a && tick <= b;
    let header = Header {
        version: VERSION,
        map: m.map.clone(),
        tickrate: TICKRATE,
        step: STEP,
        stride: STRIDE,
        hud_step: HUD_STEP,
        hud_stride: HUD_PROPS.len(),
        players: sids.iter().map(|s| s.to_string()).collect(),
        names: m.players.iter().map(|p| p.name.clone()).collect(),
        rounds: spans
            .iter()
            .map(|&(number, a, b)| RoundSpan {
                number,
                start: a,
                n: ((b - a) / STEP + 1) as usize,
                hud_n: ((b - a) / HUD_STEP + 1) as usize,
                shots: m
                    .shots
                    .iter()
                    .filter(|s| within(s.tick, a, b) && !is_grenade(&s.weapon))
                    .filter_map(|s| Some((s.tick, who(s.player)?)))
                    .collect(),
                reloads: m.reloads.iter().filter(|r| within(r.tick, a, b)).filter_map(|r| Some((r.tick, who(r.player)?))).collect(),
            })
            .collect(),
    };
    let mut body: Vec<u8> = Vec::with_capacity(ticks.len() * sids.len() * STRIDE * 2);
    for (span, round) in spans.iter().zip(&header.rounds) {
        for sid in &sids {
            let rows = table.get(sid).map(|v| v.as_slice()).unwrap_or(&[]);
            // Rows come in tick order: walk them alongside the samples.
            let mut i = rows.partition_point(|(t, _)| *t < span.1);
            let mut last: Option<[f32; 8]> = None;
            for k in 0..round.n {
                let tick = span.1 + k as i32 * STEP;
                while i < rows.len() && rows[i].0 < tick {
                    i += 1;
                }
                if i < rows.len() && rows[i].0 == tick {
                    last = Some(rows[i].1);
                }
                let v = match last {
                    // Not in the demo at this tick (disconnected, not spawned yet): there, but dead.
                    Some(v) if rows.get(i).is_some_and(|r| r.0 == tick) => v,
                    Some(mut v) => {
                        v[6] = 0.0;
                        v
                    }
                    None => [0.0; 8],
                };
                let q = |x: f32| if x.is_finite() { x.round().clamp(-32768.0, 32767.0) as i16 } else { 0 };
                let flags = i16::from(v[7] > 0.5);
                for n in [q(v[0]), q(v[1]), q(v[2]), q(wrap(v[3]) * 50.0), q(v[4] * 100.0), q(v[5] * 1000.0), q(v[6]), flags] {
                    body.extend_from_slice(&n.to_le_bytes());
                }
            }
        }
    }
    // The HUD's numbers: each sample the latest reading at or before its tick.
    for (span, round) in spans.iter().zip(&header.rounds) {
        for sid in &sids {
            let rows = hud.get(sid).map(|v| v.as_slice()).unwrap_or(&[]);
            let mut i = 0;
            let mut last = [0i16; 5];
            for k in 0..round.hud_n {
                let tick = span.1 + k as i32 * HUD_STEP;
                while i < rows.len() && rows[i].0 <= tick {
                    for (c, v) in rows[i].1.iter().take(5).enumerate() {
                        if v.is_finite() {
                            last[c] = v.round().clamp(-32768.0, 32767.0) as i16;
                        }
                    }
                    i += 1;
                }
                for n in last {
                    body.extend_from_slice(&n.to_le_bytes());
                }
            }
        }
    }
    let head = serde_json::to_vec(&header)?;
    let dest = path(root, id);
    let tmp = dest.with_extension("gz.tmp");
    let mut gz = flate2::write::GzEncoder::new(std::fs::File::create(&tmp)?, flate2::Compression::default());
    gz.write_all(b"VR3D")?;
    gz.write_all(&VERSION.to_le_bytes())?;
    gz.write_all(&(head.len() as u32).to_le_bytes())?;
    gz.write_all(&head)?;
    gz.write_all(&body)?;
    gz.finish()?;
    std::fs::rename(tmp, dest)?;
    Ok(())
}

/// Grenades, the bomb and the knife fire too (`weapon_fire`); only guns make a muzzle flash.
fn is_grenade(weapon: &str) -> bool {
    let w = weapon.trim_start_matches("weapon_");
    matches!(w, "smokegrenade" | "flashbang" | "hegrenade" | "molotov" | "incgrenade" | "decoy" | "c4" | "taser") || w.starts_with("knife") || w == "bayonet"
}

/// Yaw into -180..180.
fn wrap(yaw: f32) -> f32 {
    let y = (yaw + 180.0).rem_euclid(360.0) - 180.0;
    if y.is_finite() {
        y
    } else {
        0.0
    }
}
