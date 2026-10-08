//! Lowlights: misses you got punished for. A lowlight is a death right after you missed:
//!
//! - **Missed back**: you shot at an enemy facing away from you (any gun), he survived, turned
//!   and killed you.
//! - **AWP / Scout whiff**: a sniper shot that hit no one, then you died within 3 seconds.
//! - **Spray whiff** (rifles, SMGs, MGs, shotguns, autos): a spray of 5+ bullets with 0-1 hits on
//!   the enemy who then killed you.
//! - **Pistol whiff**: 3+ pistol shots (2+ with a Deagle or R8) with no hits on your killer.
//!
//! Each gets a diagnosis from per-tick data at every shot: your speed against the speed below
//! which that gun is accurate (counter-strafing), jumping, and where your crosshair plus recoil
//! pointed relative to his head (aim and spray control), so you know what to work on.

use crate::analysis::{is_enemy_kill, pistol_rounds};
use crate::highlights::{is_critical_round, pretty_weapon, weapon_class};
use crate::model::{Match, TICKRATE};
use crate::raw;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Most lowlights kept per match (worst first).
pub const MAX_PER_MATCH: usize = 5;
/// How long before your death your shots count toward a lowlight.
const WINDOW_S: f64 = 3.0;
/// Shots further apart than this belong to different sprays.
const SPRAY_GAP_S: f64 = 0.6;
/// Source units are inches.
const CM_PER_UNIT: f64 = 2.54;
/// Per-tick props for the diagnosis. Speed comes from position changes between consecutive ticks
/// (every tick of each window is read), not the parser's velocity, which spans the previous rows
/// returned rather than the previous tick.
const TICK_PROPS: &[&str] = &["X", "Y", "Z", "pitch", "yaw", "is_airborne", "duck_amount", "aim_punch_angle", "is_scoped", "buttons"];
/// The whiff trace starts this long before the first shot.
const TRACE_LEAD_TICKS: i32 = 64;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ShotInfo {
    /// Seconds before your death.
    pub t: f64,
    pub weapon: String,
    /// Bullet number within the spray (1-based).
    pub bullet: u32,
    pub hit: bool,
    /// Horizontal speed (units/s) and the speed below which this gun is accurate.
    pub speed: Option<f64>,
    pub accurate_speed: f64,
    pub airborne: bool,
    /// Where crosshair + recoil pointed, relative to his head at his distance, in cm:
    /// x > 0 is right of his head, y > 0 above it.
    pub off_x_cm: Option<f64>,
    pub off_y_cm: Option<f64>,
    pub on_head: bool,
    pub on_body: bool,
    /// "hit", "unscoped" (sniper fired before scoping in), "quickscope" (on him, but fired before
    /// the zoom settled), "moving", "jumping", "aim", "high"
    /// (didn't pull down), "low" (pulled too far), "drift" (sideways), "spread" (on target, missed
    /// anyway), or "" without tick data.
    pub verdict: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Lowlight {
    pub id: String,
    /// Round number (1-based) and index into the match's rounds.
    pub round: u32,
    pub round_index: usize,
    /// "back", "awp", "scout", "spray", "pistol"
    pub kind: String,
    pub title: String,
    pub weapon: String,
    pub weapon_class: String,
    pub killer: String,
    pub killer_name: String,
    pub distance_m: Option<f64>,
    pub shots: u32,
    pub hits: u32,
    /// Main reason: "late_stop", "moved_mid_spray", "moving", "jumping", "spray", "aim",
    /// "unlucky", or "unknown" without tick data.
    pub reason: String,
    /// Plain-English diagnosis.
    pub verdict: String,
    pub movement_ok: Option<bool>,
    pub aim_ok: Option<bool>,
    pub tags: Vec<String>,
    /// Worst first.
    pub severity: f64,
    pub pistol_round: bool,
    pub critical: bool,
    pub death_tick: i32,
    pub segments: Vec<(i32, i32)>,
    pub duration_s: f64,
    pub shot_details: Vec<ShotInfo>,
    /// Tick by tick from a second before the first shot to the death, for the whiff analyzer.
    pub trace: Option<Trace>,
    /// Rendered on demand.
    pub clip: Option<String>,
    pub thumb: Option<String>,
    pub render_error: Option<String>,
}

/// Your aim and movement every tick of a whiff (64 per second), against the player who killed you.
/// Positions are relative to his head at his distance, in cm (x right, y up), like `ShotInfo`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Trace {
    pub start_tick: i32,
    /// Where your crosshair was (where you looked).
    pub look: Vec<[f32; 2]>,
    /// Where bullets would go (crosshair plus recoil).
    pub aim: Vec<[f32; 2]>,
    /// Horizontal speed, units/s.
    pub speed: Vec<f32>,
    /// Keys held: 1 W, 2 S, 4 A, 8 D, 16 jump, 32 crouch, 64 fire, 128 walk.
    pub keys: Vec<u8>,
    /// In the air.
    pub air: Vec<u8>,
    /// Your view angles (yaw, pitch) and the recoil punch (yaw, pitch), degrees: your mouse
    /// movement against the gun's recoil, independent of where he moved.
    pub view: Vec<[f32; 2]>,
    pub punch: Vec<[f32; 2]>,
    /// The gun's accurate speed (34% of its max), units/s.
    pub accurate_speed: f32,
    /// His head and body size at his distance, cm: half-width and how far below the head his feet are.
    pub body_bottom_cm: f32,
}

/// Running speed of each gun (units/s); a gun is accurate below 34% of it.
pub(crate) fn max_speed(w: &str) -> f64 {
    match w {
        "ak47" | "galilar" => 215.0,
        "m4a1" | "m4a1_silencer" | "mag7" => 225.0,
        "famas" | "aug" | "mp7" | "nova" | "revolver" => 220.0,
        "sg556" | "sawedoff" => 210.0,
        "awp" => 200.0,
        "ssg08" | "deagle" | "ump45" | "p90" => 230.0,
        "g3sg1" | "scar20" | "xm1014" => 215.0,
        "mp5sd" => 235.0,
        "m249" => 195.0,
        "negev" => 150.0,
        _ => 240.0, // pistols and most SMGs
    }
}

fn label(kind: &str, class: &str) -> String {
    match kind {
        "back" => "Missed back".into(),
        "awp" => "AWP whiff".into(),
        "scout" => "Scout whiff".into(),
        "pistol" if class == "deagle" => "Deagle whiff".into(),
        "pistol" => "Pistol whiff".into(),
        _ => match class {
            "rifle" => "Rifle spray whiff".into(),
            "smg" => "SMG spray whiff".into(),
            "mg" => "MG spray whiff".into(),
            "shotgun" => "Shotgun whiff".into(),
            "auto" => "Auto-sniper whiff".into(),
            _ => "Spray whiff".into(),
        },
    }
}

fn reason_label(r: &str) -> &'static str {
    match r {
        "late_stop" => "Late counter-strafe",
        "moved_mid_spray" => "Moved mid-spray",
        "moving" => "Shooting on the move",
        "jumping" => "Jump shot",
        "unscoped" => "Shot before scoping",
        "quickscope" => "Scope not settled",
        "spray" => "Spray control",
        "aim" => "Aim",
        "unlucky" => "Unlucky",
        _ => "Missed",
    }
}

fn gun(w: &str) -> bool {
    !matches!(weapon_class(w), "grenade" | "knife" | "zeus" | "other")
}


/// Lowlights for `me`, worst first (at most [`MAX_PER_MATCH`]). With `demo`, an extra pass reads
/// per-tick aim and movement for you and every enemy around each death: each bullet is matched
/// to the enemy your crosshair was on, so only shots at your killer count, and each gets a
/// diagnosis. Without it, every shot is assumed to be at your killer, missed backs can't be
/// found and the reason is "unknown".
pub fn detect(m: &Match, me: u64, demo: Option<&[u8]>) -> Vec<Lowlight> {
    let Some(my_team) = m.team_of(me) else { return vec![] };
    let pistols = pistol_rounds(m);
    let window = (WINDOW_S * TICKRATE) as i32;
    let gap = (SPRAY_GAP_S * TICKRATE) as i32;

    // Every death to an enemy right after you fired, with your last spray before it.
    struct Death {
        round: usize,
        tick: i32,
        killer: u64,
        weapon: String,
        /// Shot tick and who it hit, if anyone.
        burst: Vec<(i32, Option<u64>)>,
    }
    let mut deaths: Vec<Death> = vec![];
    for k in &m.kills {
        let Some(killer) = k.attacker else { continue };
        if k.victim != me || !is_enemy_kill(m, k.attacker, k.victim) || k.tick > m.rounds[k.round].end_tick {
            continue;
        }
        let mut shots: Vec<(i32, String)> = m
            .shots
            .iter()
            .filter(|s| s.player == me && s.round == k.round && s.tick <= k.tick && s.tick > k.tick - window && gun(&s.weapon))
            .map(|s| (s.tick, s.weapon.trim_start_matches("weapon_").to_string()))
            .collect();
        if shots.is_empty() {
            continue;
        }
        shots.sort();
        let mut start = shots.len() - 1;
        while start > 0 && shots[start].0 - shots[start - 1].0 <= gap {
            start -= 1;
        }
        let burst: Vec<(i32, Option<u64>)> = shots[start..]
            .iter()
            .map(|(t, _)| {
                let hit = m.damages.iter().find(|d| d.attacker == Some(me) && d.tick >= *t && d.tick <= *t + 2 && gun(&d.weapon)).map(|d| d.victim);
                (*t, hit)
            })
            .collect();
        deaths.push(Death { round: k.round, tick: k.tick, killer, weapon: shots.last().unwrap().1.clone(), burst });
    }
    if deaths.is_empty() {
        return vec![];
    }

    // Per-tick aim and movement for you and every enemy around those deaths (one extra pass).
    let enemies: Vec<u64> = m.players.iter().filter(|p| p.team != my_team).map(|p| p.steamid).collect();
    let data = demo.and_then(|d| {
        let mut ticks: Vec<i32> = vec![];
        for x in &deaths {
            let first = x.burst[0].0;
            ticks.extend(first - TRACE_LEAD_TICKS..=x.tick);
            ticks.extend(x.burst.iter().map(|(t, _)| *t));
        }
        ticks.sort();
        ticks.dedup();
        let mut players = enemies.clone();
        players.push(me);
        raw::players_series(d, &players, TICK_PROPS, &ticks).ok()
    });
    let at = |sid: u64, tick: i32| -> Option<&HashMap<String, f64>> {
        let data = data.as_ref()?;
        (0..3).find_map(|d| data.get(&(sid, tick - d)).filter(|v| v.contains_key("X")))
    };
    let g = |p: &HashMap<String, f64>, k: &str| p.get(k).copied().unwrap_or(0.0);
    // Horizontal speed (units/s) from the position change since the previous tick.
    let speed = |sid: u64, tick: i32| -> Option<f64> {
        let d = data.as_ref()?;
        let (a, b) = (d.get(&(sid, tick))?, d.get(&(sid, tick - 1))?);
        Some((g(a, "X") - g(b, "X")).hypot(g(a, "Y") - g(b, "Y")) * TICKRATE)
    };
    // Where your crosshair + recoil pointed relative to `target`'s head: (x right, y up) in
    // units at his distance, the angle off in degrees, distance, and how far below the head his
    // feet are.
    let aim_at = |mp: &HashMap<String, f64>, tp: &HashMap<String, f64>| {
        let eye = (g(mp, "X"), g(mp, "Y"), g(mp, "Z") + 64.0 - 18.0 * g(mp, "duck_amount"));
        let head = (g(tp, "X"), g(tp, "Y"), g(tp, "Z") + 62.0 - 18.0 * g(tp, "duck_amount"));
        let (dx, dy, dz) = (head.0 - eye.0, head.1 - eye.1, head.2 - eye.2);
        let dh = dx.hypot(dy).max(1.0);
        let t_yaw = dy.atan2(dx).to_degrees();
        let t_pitch = -dz.atan2(dh).to_degrees();
        // Bullets go where you look plus twice the recoil punch.
        let a_yaw = g(mp, "yaw") + 2.0 * g(mp, "aim_punch_angle_1");
        let a_pitch = g(mp, "pitch") + 2.0 * g(mp, "aim_punch_angle_0");
        let x = -dh * norm180(a_yaw - t_yaw).to_radians().tan(); // yaw grows to the left
        let y = -dh * (a_pitch - t_pitch).to_radians().tan(); // pitch grows downward
        let dist = dh.hypot(dz);
        (x, y, (x.hypot(y) / dist).atan().to_degrees(), dist, head.2 - g(tp, "Z") - 2.0)
    };

    let mut out = vec![];
    for d in deaths {
        let round = &m.rounds[d.round];
        let class = weapon_class(&d.weapon).to_string();
        let accurate = max_speed(&d.weapon) * 0.34;
        let alive = |e: u64, tick: i32| !m.kills.iter().any(|k| k.round == d.round && k.victim == e && k.tick < tick);
        let mut shots: Vec<ShotInfo> = vec![];
        let mut first_at_killer: Option<i32> = None;
        for (i, (tick, hit_victim)) in d.burst.iter().enumerate() {
            let mut s = ShotInfo {
                t: (d.tick - tick) as f64 / TICKRATE,
                weapon: d.weapon.clone(),
                bullet: i as u32 + 1,
                hit: *hit_victim == Some(d.killer),
                accurate_speed: accurate,
                ..Default::default()
            };
            let at_killer = match at(me, *tick) {
                None => data.is_none(), // no tick data: assume every shot was at him
                Some(mp) => {
                    s.speed = speed(me, *tick).or_else(|| speed(me, *tick - 1));
                    s.airborne = g(mp, "is_airborne") > 0.5;
                    // Snipers drop out of scope as they fire, so look at the ticks just before.
                    let scoped_before = (1..=3).filter_map(|d| data.as_ref()?.get(&(me, *tick - d))?.get("is_scoped").copied()).any(|v| v > 0.5);
                    let sniper = matches!(class.as_str(), "awp" | "scout" | "auto");
                    let unscoped = sniper && !scoped_before;
                    // How long you'd been scoped in: under ~0.15 s the zoom hasn't settled.
                    let scoped_for = (1..=40)
                        .take_while(|d| data.as_ref().and_then(|x| x.get(&(me, *tick - d))).and_then(|v| v.get("is_scoped")).is_some_and(|v| *v > 0.5))
                        .count();
                    let quickscope = sniper && scoped_before && (scoped_for as f64) < 0.15 * TICKRATE;
                    // The enemy your crosshair was on: the closest one to your aim, within 25°.
                    let target = enemies
                        .iter()
                        .filter(|e| alive(**e, *tick))
                        .filter_map(|e| at(*e, *tick).map(|tp| (*e, aim_at(mp, tp))))
                        .min_by(|a, b| a.1 .2.total_cmp(&b.1 .2))
                        .filter(|(_, a)| a.2 <= 25.0);
                    match target {
                        Some((sid, (x, y, _, _, body_bottom))) if sid == d.killer => {
                            s.on_head = x.abs() <= 5.0 && y.abs() <= 5.0;
                            s.on_body = x.abs() <= 11.0 && y <= 5.0 && y >= -body_bottom;
                            s.off_x_cm = Some(x * CM_PER_UNIT);
                            s.off_y_cm = Some(y * CM_PER_UNIT);
                            let speed = s.speed.unwrap_or(0.0);
                            s.verdict = if s.hit {
                                "hit"
                            } else if unscoped {
                                "unscoped"
                            } else if quickscope && s.on_body {
                                "quickscope"
                            } else if s.airborne {
                                "jumping"
                            } else if speed > accurate {
                                "moving"
                            } else if s.on_body {
                                "spread"
                            } else if s.bullet >= 3 && y > 5.0 && y.abs() >= x.abs() {
                                "high"
                            } else if s.bullet >= 3 && y < -body_bottom {
                                "low"
                            } else if s.bullet >= 3 && x.abs() > 11.0 {
                                "drift"
                            } else {
                                "aim"
                            }
                            .into();
                            true
                        }
                        _ => false,
                    }
                }
            };
            if at_killer {
                first_at_killer.get_or_insert(*tick);
                shots.push(s);
            }
        }
        let Some(first) = first_at_killer else { continue };
        let k_shots = shots.len();
        let k_hits = shots.iter().filter(|s| s.hit).count();
        // Missed back: he was facing away from you when you started shooting at him.
        let mut distance = None;
        let mut back = false;
        if let (Some(mp), Some(kp)) = (at(me, first), at(d.killer, first)) {
            let (dx, dy) = (g(mp, "X") - g(kp, "X"), g(mp, "Y") - g(kp, "Y"));
            distance = Some(dx.hypot(dy).hypot(g(mp, "Z") - g(kp, "Z")) * CM_PER_UNIT / 100.0);
            back = norm180(g(kp, "yaw") - dy.atan2(dx).to_degrees()).abs() > 90.0;
        }
        let kind = if back {
            "back"
        } else {
            match class.as_str() {
                "awp" | "scout" if shots.iter().any(|s| !s.hit) => class.as_str(),
                "rifle" | "smg" | "mg" | "shotgun" | "auto" if k_shots >= 5 && k_hits <= 1 => "spray",
                "pistol" if k_shots >= 3 && k_hits == 0 => "pistol",
                "deagle" if k_shots >= 2 && k_hits == 0 => "pistol",
                _ => continue,
            }
        }
        .to_string();

        let (reason, verdict, movement_ok, aim_ok) = diagnose(&kind, &shots);
        let pistol_round = pistols.contains(&d.round);
        let critical = is_critical_round(m, d.round, my_team);
        let killer_name = m.player(d.killer).map(|p| p.name.clone()).unwrap_or_default();
        let base = match kind.as_str() {
            "back" => 4.0,
            "awp" | "scout" => 3.0,
            "spray" => 2.5,
            _ => 2.0,
        };
        let close = distance.is_some_and(|x| x < 5.0);
        let severity = base + 0.1 * (k_shots - k_hits) as f64 + if critical { 1.0 } else { 0.0 } + if close { 0.5 } else { 0.0 };
        let kind_label = label(&kind, &class);
        let mut tags = vec![kind_label.clone(), pretty_weapon(&d.weapon), reason_label(&reason).to_string()];
        if pistol_round {
            tags.push("Pistol round".into());
        }
        if critical {
            tags.push("Critical round".into());
        }
        if close {
            tags.push("Close range".into());
        }
        let start = (first - (2.5 * TICKRATE) as i32).max(round.live_tick);
        let end = d.tick + (1.5 * TICKRATE) as i32;
        // The whiff trace: every tick against the killer, from just before the first shot.
        let trace = (|| {
            let t0 = first - TRACE_LEAD_TICKS;
            let mut tr = Trace { start_tick: t0, accurate_speed: accurate as f32, ..Default::default() };
            let round1 = |v: f64| ((v * 10.0).round() / 10.0) as f32;
            for tick in t0..=d.tick {
                let (Some(mp), Some(kp)) = (at(me, tick), at(d.killer, tick)) else {
                    // Keep the timeline even: repeat the last values when a tick is missing.
                    let last = (tr.look.last().copied(), tr.aim.last().copied(), tr.speed.last().copied(), tr.keys.last().copied(), tr.air.last().copied());
                    if let (Some(l), Some(a), Some(s), Some(k), Some(r)) = last {
                        tr.look.push(l);
                        tr.aim.push(a);
                        tr.speed.push(s);
                        tr.keys.push(k);
                        tr.air.push(r);
                        let (v, p) = (*tr.view.last().unwrap_or(&[0.0, 0.0]), *tr.punch.last().unwrap_or(&[0.0, 0.0]));
                        tr.view.push(v);
                        tr.punch.push(p);
                        continue;
                    }
                    return None;
                };
                let (ax, ay, _, _, body_bottom) = aim_at(mp, kp);
                // Where you looked = the aim without twice the recoil punch.
                let mut look_p = mp.clone();
                look_p.insert("aim_punch_angle_0".into(), 0.0);
                look_p.insert("aim_punch_angle_1".into(), 0.0);
                let (lx, ly, _, _, _) = aim_at(&look_p, kp);
                tr.look.push([round1(lx * CM_PER_UNIT), round1(ly * CM_PER_UNIT)]);
                tr.aim.push([round1(ax * CM_PER_UNIT), round1(ay * CM_PER_UNIT)]);
                tr.speed.push(round1(speed(me, tick).unwrap_or(0.0)));
                let b = g(mp, "buttons") as u64;
                let key = |bit: u64, out: u8| if b & bit != 0 { out } else { 0 };
                tr.keys.push(key(1 << 3, 1) | key(1 << 4, 2) | key(1 << 9, 4) | key(1 << 10, 8) | key(1 << 1, 16) | key(1 << 2, 32) | key(1 << 0, 64) | key(1 << 16, 128));
                tr.air.push((g(mp, "is_airborne") > 0.5) as u8);
                let r2 = |v: f64| ((v * 100.0).round() / 100.0) as f32;
                tr.view.push([r2(g(mp, "yaw")), r2(g(mp, "pitch"))]);
                tr.punch.push([r2(g(mp, "aim_punch_angle_1")), r2(g(mp, "aim_punch_angle_0"))]);
                tr.body_bottom_cm = round1(body_bottom * CM_PER_UNIT);
            }
            Some(tr)
        })();
        out.push(Lowlight {
            round: round.number,
            round_index: d.round,
            title: format!("{kind_label} · {} · R{}", pretty_weapon(&d.weapon), round.number),
            kind,
            weapon: d.weapon.clone(),
            weapon_class: class,
            killer: d.killer.to_string(),
            killer_name,
            distance_m: distance,
            shots: k_shots as u32,
            hits: k_hits as u32,
            reason,
            verdict,
            movement_ok,
            aim_ok,
            tags,
            severity,
            pistol_round,
            critical,
            death_tick: d.tick,
            segments: vec![(start, end)],
            duration_s: (end - start) as f64 / TICKRATE,
            shot_details: shots,
            trace,
            ..Default::default()
        });
    }
    out.sort_by(|a, b| b.severity.total_cmp(&a.severity));
    out.truncate(MAX_PER_MATCH);
    out
}

fn norm180(a: f64) -> f64 {
    let mut a = a % 360.0;
    if a > 180.0 {
        a -= 360.0
    }
    if a < -180.0 {
        a += 360.0
    }
    a
}

fn ms(ticks: f64) -> f64 {
    (ticks * 1000.0 / TICKRATE / 10.0).round() * 10.0
}

/// Main reason and a plain-English verdict: was it movement, aim/spray, both, or bad luck?
fn diagnose(kind: &str, shots: &[ShotInfo]) -> (String, String, Option<bool>, Option<bool>) {
    let known: Vec<&ShotInfo> = shots.iter().filter(|s| s.speed.is_some()).collect();
    if known.is_empty() {
        let misses = shots.iter().filter(|s| !s.hit).count();
        return ("unknown".into(), format!("Missed {misses} of {} shots, then died.", shots.len()), None, None);
    }
    if let Some(s) = known.iter().find(|s| s.verdict == "quickscope") {
        return (
            "quickscope".into(),
            format!("Bullet {}: on him, but you fired the moment you scoped in, before the zoom settled.", s.bullet),
            Some(true),
            Some(false),
        );
    }
    if let Some(s) = known.iter().find(|s| s.verdict == "unscoped") {
        return (
            "unscoped".into(),
            format!("Bullet {}: you fired before scoping in, so it had no-scope inaccuracy.", s.bullet),
            Some(true),
            Some(false),
        );
    }
    let n = known.len() as f64;
    let moving: Vec<&&ShotInfo> = known.iter().filter(|s| matches!(s.verdict.as_str(), "moving" | "jumping")).collect();
    let aim: Vec<&&ShotInfo> = known.iter().filter(|s| matches!(s.verdict.as_str(), "aim" | "high" | "low" | "drift")).collect();
    let still = known.iter().filter(|s| !matches!(s.verdict.as_str(), "moving" | "jumping")).count() as f64;
    let movement_bad = moving.len() as f64 >= (n / 2.0).ceil() || known[0].verdict == "moving" || known[0].verdict == "jumping";
    let aim_bad = still > 0.0 && aim.len() as f64 >= (still / 2.0).ceil();
    let speed0 = known[0].speed.unwrap_or(0.0);
    let acc = known[0].accurate_speed;

    // Movement story.
    let first_moving = known[0].verdict == "moving";
    let became_still = known.iter().position(|s| !matches!(s.verdict.as_str(), "moving" | "jumping"));
    let started_moving = known.iter().position(|s| matches!(s.verdict.as_str(), "moving" | "jumping"));
    let (move_reason, move_text) = if known.iter().any(|s| s.verdict == "jumping") {
        ("jumping", "You were in the air when you shot.".to_string())
    } else if first_moving && became_still.is_some_and(|i| (known[0].t - known[i].t) <= 0.35) {
        // Stopped soon after the first shot: a counter-strafe that came late. (Longer than that
        // is just shooting on the move.)
        let i = became_still.unwrap();
        let late = (known[0].t - known[i].t) * TICKRATE;
        ("late_stop", format!("You started shooting at {:.0} u/s, still moving (accurate below {:.0}); counter-strafe about {:.0} ms late.", speed0, acc, ms(late)))
    } else if !first_moving && started_moving.is_some() {
        let i = started_moving.unwrap();
        let s = known[i];
        ("moved_mid_spray", format!("Still for the first {} bullet{}, then you started moving on bullet {} ({:.0} u/s).", i, if i == 1 { "" } else { "s" }, s.bullet, s.speed.unwrap_or(0.0)))
    } else {
        ("moving", format!("You shot while moving the whole time ({:.0} u/s; accurate below {:.0}).", speed0, acc))
    };

    // Aim / spray story.
    let high = aim.iter().filter(|s| s.verdict == "high").count();
    let low = aim.iter().filter(|s| s.verdict == "low").count();
    let drift = aim.iter().filter(|s| s.verdict == "drift").count();
    let first_aim = known.iter().find(|s| matches!(s.verdict.as_str(), "aim" | "high" | "low" | "drift"));
    let where_ = |s: &ShotInfo| {
        let (x, y) = (s.off_x_cm.unwrap_or(0.0), s.off_y_cm.unwrap_or(0.0));
        let h = if x.abs() >= 3.0 { format!("{:.0} cm {}", x.abs(), if x > 0.0 { "right" } else { "left" }) } else { String::new() };
        let v = if y.abs() >= 3.0 { format!("{:.0} cm {}", y.abs(), if y > 0.0 { "above" } else { "below" }) } else { String::new() };
        match (h.is_empty(), v.is_empty()) {
            (false, false) => format!("{h} and {v} his head"),
            (false, true) => format!("{h} of his head"),
            (true, false) => format!("{v} his head"),
            _ => "on his head".into(),
        }
    };
    let (aim_reason, aim_text) = if kind == "spray" && (high + low + drift) * 2 >= aim.len().max(1) && (high + low + drift) > 0 {
        let what = if high >= low && high >= drift {
            let from = aim.iter().filter(|s| s.verdict == "high").map(|s| s.bullet).min().unwrap_or(0);
            format!("didn't pull down enough from bullet {from}; the spray went over his head")
        } else if low >= drift {
            "pulled down too far; the spray went under him".to_string()
        } else {
            "drifted sideways off him".to_string()
        };
        ("spray", format!("Your spray {what}."))
    } else if let Some(s) = first_aim {
        ("aim", format!("Bullet {}: your crosshair was {}.", s.bullet, where_(s)))
    } else {
        ("aim", "Your aim drifted off him.".to_string())
    };

    let spray_word = if kind == "spray" { "spray" } else { "aim" };
    match (movement_bad, aim_bad) {
        (true, false) => (move_reason.into(), format!("Good {spray_word}, bad movement. {move_text}"), Some(false), Some(true)),
        (false, true) => (aim_reason.into(), format!("Good movement, bad {spray_word}. {aim_text}"), Some(true), Some(false)),
        (true, true) => {
            let share = 100.0 * moving.len() as f64 / (moving.len() + aim.len()).max(1) as f64;
            let main = if share >= 50.0 { move_reason } else { aim_reason };
            (main.into(), format!("Both movement and {spray_word} ({:.0}% movement). {move_text} {aim_text}", share), Some(false), Some(false))
        }
        (false, false) => {
            let hits = known.iter().filter(|s| s.verdict == "hit").count();
            let on = known.iter().filter(|s| s.verdict == "spread").count() + hits;
            let hit_text = if hits > 0 { format!(", {hits} hit") } else { String::new() };
            (
                "unlucky".into(),
                format!("Stopped and on target ({on} of {} bullets on him{hit_text}); spread and armor did the rest. Nothing mechanical to fix here.", known.len()),
                Some(true),
                Some(true),
            )
        }
    }
}
