//! Rule-based highlight detection: groups a player's kills per round into moments, tags and scores
//! them, and produces tick ranges to render.

use crate::analysis::{is_enemy_kill, Analysis, Clutch};
use crate::model::{Match, TICKRATE};
use serde::Serialize;

/// Seconds of footage before the first kill and after the last kill of a segment.
const PRE_ROLL_S: f64 = 4.0;
const POST_ROLL_S: f64 = 3.0;
/// Kills further apart than this become separate segments of the same moment.
const SEGMENT_GAP_S: f64 = 12.0;
/// Moments scoring at least this are auto-selected.
pub const AUTO_THRESHOLD: f64 = 3.0;

const SNIPERS: &[&str] = &["awp", "ssg08", "scar20", "g3sg1"];

#[derive(Debug, Clone, Serialize)]
pub struct Segment {
    pub start_tick: i32,
    pub end_tick: i32,
}

#[derive(Debug, Clone, Serialize)]
pub struct Highlight {
    pub player: u64,
    /// Index into `Match::rounds`.
    pub round: usize,
    pub round_number: u32,
    pub score: f64,
    pub title: String,
    pub tags: Vec<String>,
    /// Indices into `Match::kills`.
    pub kills: Vec<usize>,
    pub segments: Vec<Segment>,
    pub duration_s: f64,
}

/// All candidate moments for `player`, best first. Callers filter with [`AUTO_THRESHOLD`].
pub fn detect(m: &Match, a: &Analysis, player: u64) -> Vec<Highlight> {
    let mut out = vec![];
    for (r, round) in m.rounds.iter().enumerate() {
        let kills: Vec<usize> = (0..m.kills.len())
            .filter(|&i| {
                let k = &m.kills[i];
                k.round == r && k.attacker == Some(player) && is_enemy_kill(m, k.attacker, k.victim)
            })
            .collect();
        let clutch: Option<&Clutch> = a.rounds[r].clutches.iter().find(|c| c.player == player && c.won);
        if kills.is_empty() && clutch.is_none() {
            continue;
        }

        let mut score = 0.0;
        let mut tags: Vec<String> = vec![];
        let tag = |t: &str, tags: &mut Vec<String>| {
            if !tags.iter().any(|x| x == t) {
                tags.push(t.to_string())
            }
        };

        let n = kills.len();
        score += n as f64;
        score += match n {
            2 => 1.0,
            3 => 2.0,
            4 => 4.0,
            n if n >= 5 => 8.0,
            _ => 0.0,
        };
        match n {
            2 => tag("2K", &mut tags),
            3 => tag("3K", &mut tags),
            4 => tag("4K", &mut tags),
            n if n >= 5 => tag("ACE", &mut tags),
            _ => {}
        }
        if let Some(c) = clutch {
            score += 2.0 + 1.5 * c.vs as f64;
            tag(&format!("1v{} clutch", c.vs), &mut tags);
        }
        if a.rounds[r].opening_kill.is_some_and(|ki| kills.contains(&ki)) {
            score += 0.3;
            tag("entry", &mut tags);
        }

        for (j, &ki) in kills.iter().enumerate() {
            let k = &m.kills[ki];
            if k.headshot {
                score += 0.2;
            }
            if k.penetrated > 0 {
                score += 1.5;
                tag("wallbang", &mut tags);
            }
            if k.noscope && SNIPERS.contains(&k.weapon.as_str()) {
                score += 1.5;
                tag("noscope", &mut tags);
            }
            if k.through_smoke {
                score += 1.5;
                tag("through smoke", &mut tags);
            }
            if k.attacker_blind {
                score += 1.0;
                tag("while blind", &mut tags);
            }
            if k.attacker_in_air {
                score += 1.0;
                tag("jumpshot", &mut tags);
            }
            if k.weapon.starts_with("knife") || k.weapon == "bayonet" {
                score += 3.0;
                tag("knife", &mut tags);
            }
            if k.weapon == "taser" {
                score += 2.0;
                tag("zeus", &mut tags);
            }
            if j > 0 && m.kills[kills[j - 1]].tick == k.tick {
                score += 1.5;
                tag("collateral", &mut tags);
            }
        }
        if n > 0 && kills.iter().all(|&ki| m.kills[ki].headshot) && n >= 2 {
            tag("all headshots", &mut tags);
        }

        // ---- Segments ----
        let pre = (PRE_ROLL_S * TICKRATE) as i32;
        let post = (POST_ROLL_S * TICKRATE) as i32;
        let gap = (SEGMENT_GAP_S * TICKRATE) as i32;
        let lo = round.live_tick;
        let hi = round.end_tick + (5.0 * TICKRATE) as i32;
        let mut segments: Vec<Segment> = vec![];
        for &ki in &kills {
            let t = m.kills[ki].tick;
            match segments.last_mut() {
                Some(s) if t - (s.end_tick - post) <= gap => s.end_tick = t + post,
                _ => segments.push(Segment { start_tick: t - pre, end_tick: t + post }),
            }
        }
        if let Some(c) = clutch {
            // Show the clutch from the moment it began through the round's end.
            let start = c.start_tick - (1.0 * TICKRATE) as i32;
            let end = round.end_tick + (2.0 * TICKRATE) as i32;
            if segments.is_empty() || segments[0].start_tick - start > gap {
                segments.insert(0, Segment { start_tick: start, end_tick: start + pre + post });
            } else {
                segments[0].start_tick = segments[0].start_tick.min(start);
            }
            let last = segments.last_mut().unwrap();
            if end - last.end_tick <= gap {
                last.end_tick = last.end_tick.max(end);
            }
        }
        for s in &mut segments {
            s.start_tick = s.start_tick.max(lo);
            s.end_tick = s.end_tick.min(hi);
        }
        // Merge any overlaps created by clamping/extension.
        segments.sort_by_key(|s| s.start_tick);
        let mut merged: Vec<Segment> = vec![];
        for s in segments {
            match merged.last_mut() {
                Some(p) if s.start_tick <= p.end_tick => p.end_tick = p.end_tick.max(s.end_tick),
                _ => merged.push(s),
            }
        }
        let duration_s = merged.iter().map(|s| (s.end_tick - s.start_tick) as f64 / TICKRATE).sum();

        let weapon = most_used_weapon(m, &kills);
        // Clutches lead the title; otherwise the multi-kill tag (always pushed first).
        let headline = tags
            .iter()
            .find(|t| t.ends_with("clutch"))
            .or(tags.first())
            .cloned()
            .unwrap_or_else(|| format!("{n}K"));
        let title = match weapon {
            Some(w) => format!("{headline} · {} · R{}", pretty_weapon(&w), round.number),
            None => format!("{headline} · R{}", round.number),
        };

        out.push(Highlight {
            player,
            round: r,
            round_number: round.number,
            score: (score * 10.0).round() / 10.0,
            title,
            tags,
            kills,
            segments: merged,
            duration_s,
        });
    }
    out.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap());
    out
}

fn most_used_weapon(m: &Match, kills: &[usize]) -> Option<String> {
    let mut counts: Vec<(String, usize)> = vec![];
    for &ki in kills {
        let w = &m.kills[ki].weapon;
        match counts.iter_mut().find(|(n, _)| n == w) {
            Some((_, c)) => *c += 1,
            None => counts.push((w.clone(), 1)),
        }
    }
    counts.into_iter().max_by_key(|(_, c)| *c).map(|(w, _)| w)
}

pub fn pretty_weapon(w: &str) -> String {
    match w {
        "ak47" => "AK-47".into(),
        "m4a1" => "M4A4".into(),
        "m4a1_silencer" => "M4A1-S".into(),
        "awp" => "AWP".into(),
        "ssg08" => "Scout".into(),
        "deagle" => "Deagle".into(),
        "usp_silencer" => "USP-S".into(),
        "glock" => "Glock".into(),
        "hkp2000" => "P2000".into(),
        "p250" => "P250".into(),
        "fiveseven" => "Five-SeveN".into(),
        "tec9" => "Tec-9".into(),
        "cz75a" => "CZ75".into(),
        "revolver" => "R8".into(),
        "elite" => "Dualies".into(),
        "galilar" => "Galil".into(),
        "famas" => "FAMAS".into(),
        "sg556" => "SG 553".into(),
        "aug" => "AUG".into(),
        "mac10" => "MAC-10".into(),
        "mp9" => "MP9".into(),
        "mp7" => "MP7".into(),
        "mp5sd" => "MP5".into(),
        "ump45" => "UMP".into(),
        "p90" => "P90".into(),
        "bizon" => "Bizon".into(),
        "nova" => "Nova".into(),
        "xm1014" => "XM1014".into(),
        "mag7" => "MAG-7".into(),
        "sawedoff" => "Sawed-Off".into(),
        "m249" => "M249".into(),
        "negev" => "Negev".into(),
        "hegrenade" => "HE".into(),
        "inferno" | "molotov" | "incgrenade" => "Molotov".into(),
        "taser" => "Zeus".into(),
        w if w.starts_with("knife") || w == "bayonet" => "Knife".into(),
        other => other.to_string(),
    }
}
