//! Who could see whom, from the map's geometry ([`crate::mapgeo`]): a ray from a player's eyes to
//! points on the enemy's body that no wall, floor or prop blocks. Leetify-style "spotted" (from
//! positions, not CS2's radar flag, which lags and lingers).

use crate::mapgeo::{Geometry, V3};
use crate::model::Match;
use crate::raw;
use anyhow::Result;
use std::collections::HashMap;

/// Eye height standing (CS2: 64.06), and how much crouching lowers it (to 46.04).
const EYE: f32 = 64.0;
const EYE_CROUCH_DROP: f32 = 18.0;
/// Farther than this, nobody counts as seen (no map has fights at this range).
const MAX_RANGE: f32 = 5000.0;

/// How sight is judged. The defaults match Leetify's numbers best (tested on 29 matches against its
/// per-match stats): an enemy counts once any corner of their box is in sight and on screen.
#[derive(Debug, Clone, Copy)]
pub struct Options {
    /// Only enemies within this many degrees of where the observer is looking count (None: any).
    pub fov_deg: Option<f32>,
    /// Points on the enemy's body that must be visible: the box's 8 corners (true), or head,
    /// chest, stomach and both shoulders (false).
    pub corners: bool,
}

impl Default for Options {
    fn default() -> Self {
        Options { fov_deg: Some(DEFAULT_FOV), corners: true }
    }
}

/// Half the horizontal field of view of a 16:9 screen at CS2's FOV 90 (106 degrees wide).
const DEFAULT_FOV: f32 = 53.0;

/// Props read per tick, in this order.
const PROPS: [&str; 7] = ["X", "Y", "Z", "yaw", "pitch", "duck_amount", "health"];

/// For each (observer, tick) in `ticks`, the enemies they could see.
pub fn seen(demo: &[u8], m: &Match, geo: &Geometry, ticks: &[i32], opts: Options) -> Result<HashMap<(u64, i32), Vec<u64>>> {
    let sids: Vec<u64> = m.players.iter().map(|p| p.steamid).collect();
    let table = raw::players_table(demo, &sids, &PROPS, ticks)?;
    // tick -> (player, pose) of everyone alive then.
    let mut at: HashMap<i32, Vec<(u64, [f32; 8])>> = HashMap::new();
    for (sid, rows) in &table {
        for (tick, v) in rows {
            if v[6] > 0.0 && v[0].is_finite() && v[1].is_finite() && v[2].is_finite() {
                at.entry(*tick).or_default().push((*sid, *v));
            }
        }
    }
    let team: HashMap<u64, _> = m.players.iter().map(|p| (p.steamid, p.team)).collect();
    let mut out: HashMap<(u64, i32), Vec<u64>> = HashMap::new();
    let cos_fov = opts.fov_deg.map(|f| f.to_radians().cos());
    for (tick, alive) in &at {
        for (obs, o) in alive {
            let eye: V3 = [o[0], o[1], o[2] + EYE - EYE_CROUCH_DROP * o[5].clamp(0.0, 1.0)];
            let (yaw, pitch) = (o[3].to_radians(), o[4].to_radians());
            let look = [pitch.cos() * yaw.cos(), pitch.cos() * yaw.sin(), -pitch.sin()];
            for (target, t) in alive {
                if obs == target || team.get(obs) == team.get(target) {
                    continue;
                }
                let d = [t[0] - eye[0], t[1] - eye[1], t[2] + 40.0 - eye[2]];
                let dist = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
                if dist > MAX_RANGE || dist < 1.0 {
                    continue;
                }
                if let Some(c) = cos_fov {
                    if (d[0] * look[0] + d[1] * look[1] + d[2] * look[2]) / dist < c {
                        continue;
                    }
                }
                if visible(geo, eye, t, opts.corners) {
                    out.entry((*obs, *tick)).or_default().push(*target);
                }
            }
        }
    }
    Ok(out)
}

/// Whether any of the target's body points can be seen from `eye`.
fn visible(geo: &Geometry, eye: V3, t: &[f32; 8], corners: bool) -> bool {
    let (x, y, z) = (t[0], t[1], t[2]);
    let crouch = t[5].clamp(0.0, 1.0);
    let top = 70.0 - 16.0 * crouch;
    if corners {
        for &(dx, dy) in &[(-14.0, -14.0), (14.0, -14.0), (-14.0, 14.0), (14.0, 14.0)] {
            for &dz in &[4.0, top] {
                if geo.clear(eye, [x + dx, y + dy, z + dz]) {
                    return true;
                }
            }
        }
        return false;
    }
    // Head, chest and stomach on the body's axis, and the shoulders (across the line of sight).
    let head = 64.0 - 18.0 * crouch;
    let (dx, dy) = (x - eye[0], y - eye[1]);
    let len = (dx * dx + dy * dy).sqrt().max(1.0);
    let (sx, sy) = (-dy / len * 13.0, dx / len * 13.0);
    let points: [V3; 5] = [
        [x, y, z + head],
        [x, y, z + head - 18.0],
        [x, y, z + head - 32.0],
        [x + sx, y + sy, z + head - 12.0],
        [x - sx, y - sy, z + head - 12.0],
    ];
    points.iter().any(|&p| geo.clear(eye, p))
}
