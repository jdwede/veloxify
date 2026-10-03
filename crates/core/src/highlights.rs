//! Highlight detection. A player's round becomes a candidate moment if they got kills, won a
//! clutch or defused; rules then decide its tier (whether it's a highlight) and a score (how it
//! ranks). The rules follow how experienced players judge CS2 highlights:
//!
//! - Always (tier 3): any 3K/4K/ACE (eco kills included), any won clutch (including a T-side
//!   win after the clutcher dies and the bomb explodes), ninja defuses, noscopes, knife kills,
//!   grenade-impact kills, jumping/falling kills, and 2+ kills with a Deagle, R8 or Scout.
//! - When it matters (tier 2): a 2K that includes the round's opening kill in a won round, a 2K
//!   in a critical round (late and close, match point, or overtime), and a "caught off guard"
//!   reaction flick (the victim damaged you first and you snapped onto them). Kills against eco
//!   players don't count toward a 2K.
//! - Filler (tier 1): any other 2K, single kills with something special (wallbang, smoke, HE,
//!   Zeus), normal defuses.
//! - A plain single kill is never a highlight.

use crate::analysis::{is_enemy_kill, Analysis, Clutch};
use crate::model::{Kill, Match, TeamId, TICKRATE};
use crate::raw;
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Seconds of footage before the first kill and after the last kill of a segment.
const PRE_ROLL_S: f64 = 4.0;
const POST_ROLL_S: f64 = 3.0;
/// Kills further apart than this become separate segments of the same moment.
const SEGMENT_GAP_S: f64 = 12.0;
/// Victims with less equipment than this (outside pistol rounds) are on an eco or light buy.
const ECO_EQUIP_VALUE: u32 = 2000;
/// Your equipment value at which a round counts as a gun round.
const GUN_ROUND_EQUIP_VALUE: u32 = 3500;
/// Reaction flick: the fastest view swing over any ~200 ms span...
const FLICK_SPAN_TICKS: i32 = 13;
/// ...within this long before the kill (the snap lands a few shots before the kill registers)...
const FLICK_LOOKBACK_TICKS: i32 = 40; // ~600 ms
/// ...of at least this many degrees...
const FLICK_MIN_DEG: f64 = 45.0;
/// ...after the victim damaged you within this window.
const CAUGHT_OFF_GUARD_TICKS: i32 = (2.5 * TICKRATE) as i32;
/// Default cap on non-definitive moments per player per match (tier-3 moments are always kept).
pub const MAX_PER_PLAYER: usize = 6;

const SNIPERS: &[&str] = &["awp", "ssg08", "scar20", "g3sg1"];
const PRECISION: &[&str] = &["deagle", "revolver", "ssg08"];
const IMPACT_NADES: &[&str] = &["flashbang", "smokegrenade", "decoy", "molotov", "incgrenade"];

/// How picky auto-selection is, mirroring Allstar's Autocapture levels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Selectivity {
    /// Tier 1+: also plain 2Ks and single special kills.
    Everything,
    /// Tier 2+: definitive moments plus 2Ks that mattered and reaction flicks. Default.
    SolidPlays,
    /// Tier 3 only: definitive moments.
    HighlightsOnly,
}

impl Selectivity {
    pub fn min_tier(self) -> u8 {
        match self {
            Selectivity::Everything => 1,
            Selectivity::SolidPlays => 2,
            Selectivity::HighlightsOnly => 3,
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s.to_ascii_lowercase().replace(['-', '_', ' '], "").as_str() {
            "everything" => Some(Self::Everything),
            "solidplays" | "solid" => Some(Self::SolidPlays),
            "highlightsonly" | "highlights" => Some(Self::HighlightsOnly),
            _ => None,
        }
    }
}

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
    /// 3 = always a highlight, 2 = when it matters, 1 = filler, 0 = not a highlight.
    pub tier: u8,
    /// Ranking score within and across tiers.
    pub score: f64,
    /// "Poker hand" strength for render priority: kills first (x100), then flashiness (0-99).
    /// An ACE beats any 4K, a 4K beats any 3K; within a kill count the flashier moment wins.
    pub hand: u32,
    pub title: String,
    pub tags: Vec<String>,
    /// Indices into `Match::kills`.
    pub kills: Vec<usize>,
    pub segments: Vec<Segment>,
    pub duration_s: f64,
}

/// Picks the moments to keep: every tier-3 moment, plus the best others up to `cap` in total.
pub fn select(mut all: Vec<Highlight>, sel: Selectivity, cap: usize) -> Vec<Highlight> {
    all.retain(|h| h.tier >= sel.min_tier());
    all.sort_by(|a, b| b.tier.cmp(&a.tier).then(b.score.partial_cmp(&a.score).unwrap()));
    let definitive = all.iter().filter(|h| h.tier == 3).count();
    all.truncate(definitive.max(cap));
    all.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap());
    all
}

/// Fastest ~200 ms view-angle swing (degrees) in the ~600 ms before each of `player`'s kills where
/// the victim had damaged them shortly before. Keyed by index into `Match::kills`. Needs a small
/// extra parse of just those ticks.
pub fn reaction_flicks(demo: &[u8], m: &Match, player: u64) -> Result<HashMap<usize, f64>> {
    let candidates: Vec<usize> = (0..m.kills.len())
        .filter(|&i| {
            let k = &m.kills[i];
            k.attacker == Some(player)
                && is_enemy_kill(m, k.attacker, k.victim)
                && m.damages.iter().any(|d| {
                    d.attacker == Some(k.victim) && d.victim == player && d.tick <= k.tick && k.tick - d.tick <= CAUGHT_OFF_GUARD_TICKS
                })
        })
        .collect();
    if candidates.is_empty() {
        return Ok(HashMap::new());
    }
    let mut ticks: Vec<i32> = candidates
        .iter()
        .flat_map(|&i| (m.kills[i].tick - FLICK_LOOKBACK_TICKS - FLICK_SPAN_TICKS)..=m.kills[i].tick)
        .collect();
    ticks.sort_unstable();
    ticks.dedup();
    let series = raw::player_series(demo, player, &["yaw", "pitch"], &ticks)?;
    let at: HashMap<i32, (f64, f64)> = series
        .into_iter()
        .filter_map(|(t, v)| Some((t, (*v.get("yaw")?, *v.get("pitch")?))))
        .collect();
    let dist = |(y0, p0): (f64, f64), (y1, p1): (f64, f64)| {
        let dy = ((y1 - y0 + 540.0).rem_euclid(360.0)) - 180.0;
        (dy * dy + (p1 - p0) * (p1 - p0)).sqrt()
    };
    let mut out = HashMap::new();
    for i in candidates {
        let kt = m.kills[i].tick;
        let swing = (kt - FLICK_LOOKBACK_TICKS..=kt)
            .filter_map(|t| Some((*at.get(&t)?, *at.get(&(t - FLICK_SPAN_TICKS))?)))
            .map(|(now, before)| dist(before, now))
            .fold(0.0, f64::max);
        out.insert(i, swing);
    }
    Ok(out)
}

struct RoundContext {
    mine_before: u32,
    theirs_before: u32,
    pistol: bool,
    critical: bool,
    won: bool,
}

fn round_context(m: &Match, r: usize, my_team: TeamId) -> RoundContext {
    let (mut mine, mut theirs) = (0u32, 0u32);
    for round in &m.rounds[..r] {
        if round.winner_team() == my_team {
            mine += 1
        } else {
            theirs += 1
        }
    }
    let n = m.rounds[r].number;
    let overtime = n > 24;
    // MR12: 13 wins, so 12 is match point. Critical: late and close (10-10 or later, within one),
    // the enemy on match point (must-win), or our match point while they're still in it (10+).
    let late_close = mine >= 10 && theirs >= 10 && mine.abs_diff(theirs) <= 1;
    let must_win = theirs == 12;
    let tense_match_point = mine == 12 && theirs >= 10;
    RoundContext {
        mine_before: mine,
        theirs_before: theirs,
        pistol: n == 1 || n == 13,
        critical: overtime || late_close || must_win || tense_match_point,
        won: m.rounds[r].winner_team() == my_team,
    }
}

/// All candidate moments for `player`, best first. `flicks` comes from [`reaction_flicks`] (pass
/// an empty map to skip flick detection). Use [`select`] to apply a selectivity level and cap.
pub fn detect(m: &Match, a: &Analysis, player: u64, flicks: &HashMap<usize, f64>) -> Vec<Highlight> {
    let Some(my_team) = m.team_of(player) else { return vec![] };
    let mut out = vec![];
    for (r, round) in m.rounds.iter().enumerate() {
        let kills: Vec<usize> = (0..m.kills.len())
            .filter(|&i| {
                let k = &m.kills[i];
                k.round == r && k.attacker == Some(player) && is_enemy_kill(m, k.attacker, k.victim)
            })
            .collect();
        let clutch: Option<&Clutch> = a.rounds[r].clutches.iter().find(|c| c.player == player && c.won);
        let defuse = m.bomb.iter().find(|b| b.round == r && b.player == player && b.defused);
        if kills.is_empty() && clutch.is_none() && defuse.is_none() {
            continue;
        }
        let ctx = round_context(m, r, my_team);
        let ks: Vec<&Kill> = kills.iter().map(|&i| &m.kills[i]).collect();
        let n = ks.len();
        let is_eco_kill = |k: &Kill| !ctx.pistol && k.victim_equip_value.is_some_and(|v| v < ECO_EQUIP_VALUE);
        let real_kills = ks.iter().filter(|k| !is_eco_kill(k)).count();
        let gun_round = ks.iter().any(|k| k.attacker_equip_value.is_some_and(|v| v >= GUN_ROUND_EQUIP_VALUE));
        let opening = a.rounds[r].opening_kill.is_some_and(|ki| kills.contains(&ki));

        let mut tier = 0u8;
        let mut score = 0.0;
        let mut tags: Vec<String> = vec![];
        let tag = |t: String, tags: &mut Vec<String>| {
            if !tags.contains(&t) {
                tags.push(t)
            }
        };

        // Kills: eco kills are worth half.
        score += ks.iter().map(|k| if is_eco_kill(k) { 0.5 } else { 1.0 } + if k.headshot { 0.2 } else { 0.0 }).sum::<f64>();
        match n {
            0 | 1 => {}
            2 => tag("2K".into(), &mut tags),
            3 => tag("3K".into(), &mut tags),
            4 => tag("4K".into(), &mut tags),
            _ => tag("ACE".into(), &mut tags),
        }
        if n >= 3 {
            tier = 3;
            score += match n {
                3 => 3.0,
                4 => 6.0,
                _ => 10.0,
            };
        }

        if let Some(c) = clutch {
            tier = 3;
            score += 3.0 + 2.0 * c.vs as f64;
            tag(format!("1v{} clutch", c.vs), &mut tags);
        }
        if let Some(d) = defuse {
            let enemies = m.players.iter().filter(|p| p.team != my_team).count();
            let enemy_deaths = m
                .kills
                .iter()
                .filter(|k| k.round == r && k.tick <= d.tick && m.team_of(k.victim).is_some_and(|t| t != my_team))
                .count();
            if enemy_deaths < enemies {
                tier = 3;
                score += 5.0;
                tag("ninja defuse".into(), &mut tags);
            } else {
                tier = tier.max(1);
                score += 0.5;
                tag("defuse".into(), &mut tags);
            }
        }

        // Rare kills are always highlights.
        for (j, k) in ks.iter().enumerate() {
            let rare = if k.noscope && SNIPERS.contains(&k.weapon.as_str()) {
                Some("noscope")
            } else if k.weapon.starts_with("knife") || k.weapon == "bayonet" {
                Some("knife kill")
            } else if IMPACT_NADES.contains(&k.weapon.as_str()) {
                Some("grenade impact kill")
            } else if k.attacker_in_air {
                Some("jumping kill")
            } else {
                None
            };
            if let Some(t) = rare {
                tier = 3;
                score += 3.0;
                tag(t.into(), &mut tags);
            }
            if j > 0 && ks[j - 1].tick == k.tick {
                score += 1.5;
                tag("collateral".into(), &mut tags);
            }
            if k.penetrated > 0 {
                score += 1.0;
                tag("wallbang".into(), &mut tags);
            }
            if k.through_smoke {
                score += 1.0;
                tag("through smoke".into(), &mut tags);
            }
            if k.attacker_blind {
                score += 1.0;
                tag("while flashed".into(), &mut tags);
            }
            if k.weapon == "taser" {
                score += 1.0;
                tag("zeus".into(), &mut tags);
            }
            if k.weapon == "hegrenade" {
                score += 1.0;
                tag("HE kill".into(), &mut tags);
            }
        }

        // Multi-kills with precision weapons.
        for w in PRECISION {
            let wk: Vec<&&Kill> = ks.iter().filter(|k| k.weapon == *w).collect();
            if wk.len() >= 2 {
                tier = 3;
                score += 2.0;
                tag(format!("{} multi-kill", pretty_weapon(w)), &mut tags);
                if *w == "ssg08" {
                    // Scout rounds with a lot of damage rank higher.
                    let dmg: i32 = m.damages.iter().filter(|d| d.round == r && d.attacker == Some(player) && d.weapon == "ssg08").map(|d| d.health_removed).sum();
                    score += (dmg as f64 / 100.0).min(3.0);
                }
            }
        }

        // 2Ks that mattered.
        if n == 2 && real_kills >= 2 {
            tier = tier.max(1);
            if opening && ctx.won {
                tier = tier.max(2);
                score += 2.0;
                tag("entry 2K".into(), &mut tags);
            }
            if ctx.critical {
                tier = tier.max(2);
                score += 2.0;
            }
        }
        // Reaction flicks: caught off guard, hit first, snapped onto the enemy.
        for &ki in &kills {
            if let Some(&deg) = flicks.get(&ki) {
                if deg >= FLICK_MIN_DEG {
                    tier = tier.max(2);
                    score += 1.5 + (deg / 90.0).min(2.0);
                    tag("reaction flick".into(), &mut tags);
                }
            }
        }
        // Single kills with something special are filler.
        if n == 1 && tier == 0 && !tags.is_empty() {
            tier = 1;
        }

        if gun_round && !ctx.pistol {
            score += 0.5;
        }
        if ctx.critical {
            score *= 1.2;
            tag(format!("critical round {}-{}", ctx.mine_before, ctx.theirs_before), &mut tags);
        }
        if tier == 0 {
            continue;
        }

        // ---- Segments ----
        let pre = (PRE_ROLL_S * TICKRATE) as i32;
        let post = (POST_ROLL_S * TICKRATE) as i32;
        let gap = (SEGMENT_GAP_S * TICKRATE) as i32;
        let lo = round.live_tick;
        let hi = round.end_tick + (5.0 * TICKRATE) as i32;
        let mut segments: Vec<Segment> = vec![];
        for k in &ks {
            match segments.last_mut() {
                Some(s) if k.tick - (s.end_tick - post) <= gap => s.end_tick = k.tick + post,
                _ => segments.push(Segment { start_tick: k.tick - pre, end_tick: k.tick + post }),
            }
        }
        if let Some(c) = clutch {
            // Show the clutch from the moment it began through the round's end.
            let start = c.start_tick - TICKRATE as i32;
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
        if let Some(d) = defuse {
            // Show the defuse (up to 10 s without a kit) unless a kill segment already covers it.
            let (start, end) = (d.tick - (8.0 * TICKRATE) as i32, d.tick + (2.0 * TICKRATE) as i32);
            if !segments.iter().any(|s| s.start_tick <= d.tick && d.tick <= s.end_tick) {
                match segments.last_mut() {
                    Some(last) if start - last.end_tick <= gap => last.end_tick = last.end_tick.max(end),
                    _ => segments.push(Segment { start_tick: start, end_tick: end }),
                }
            }
        }
        for s in &mut segments {
            s.start_tick = s.start_tick.max(lo);
            s.end_tick = s.end_tick.min(hi);
        }
        segments.sort_by_key(|s| s.start_tick);
        let mut merged: Vec<Segment> = vec![];
        for s in segments {
            match merged.last_mut() {
                Some(p) if s.start_tick <= p.end_tick => p.end_tick = p.end_tick.max(s.end_tick),
                _ => merged.push(s),
            }
        }
        let duration_s = merged.iter().map(|s| (s.end_tick - s.start_tick) as f64 / TICKRATE).sum();

        out.push(Highlight {
            player,
            round: r,
            round_number: round.number,
            tier,
            score: (score * 10.0).round() / 10.0,
            hand: hand(n, &ks, &tags, clutch),
            title: title(&tags, n, most_used_weapon(m, &kills), round.number),
            tags,
            kills,
            segments: merged,
            duration_s,
        });
    }
    out.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap());
    out
}

/// Kill count x100 plus a flashiness kicker (capped at 99).
fn hand(n: usize, ks: &[&Kill], tags: &[String], clutch: Option<&Clutch>) -> u32 {
    let has = |t: &str| tags.iter().any(|x| x.contains(t));
    let mut flash = 0u32;
    for k in ks {
        if (k.noscope && SNIPERS.contains(&k.weapon.as_str()))
            || k.weapon.starts_with("knife")
            || k.weapon == "bayonet"
            || IMPACT_NADES.contains(&k.weapon.as_str())
            || k.attacker_in_air
        {
            flash += 30;
        }
        flash += 10 * (k.penetrated > 0) as u32 + 10 * k.through_smoke as u32 + 10 * k.attacker_blind as u32;
        flash += k.headshot as u32;
    }
    if has("collateral") {
        flash += 20;
    }
    if let Some(c) = clutch {
        flash += 15 + 5 * c.vs;
    }
    if has("ninja defuse") {
        flash += 25;
    }
    if has("multi-kill") {
        flash += 15;
    }
    if has("reaction flick") {
        flash += 15;
    }
    if has("critical round") {
        flash += 10;
    }
    if has("entry 2K") {
        flash += 5;
    }
    n as u32 * 100 + flash.min(99)
}

/// Headline priority: ACE > 4K > clutch > ninja defuse > rare kill > 3K > precision multi-kill >
/// entry/critical 2K > flick > anything else.
fn title(tags: &[String], n: usize, weapon: Option<String>, round_number: u32) -> String {
    const ORDER: &[&str] = &[
        "ACE", "4K", "clutch", "ninja defuse", "noscope", "knife kill", "grenade impact kill", "jumping kill", "3K",
        "multi-kill", "entry 2K", "critical round ", "reaction flick", "2K",
    ];
    let headline = ORDER
        .iter()
        .find_map(|key| tags.iter().find(|t| t.contains(key)))
        .or(tags.first())
        .cloned()
        .unwrap_or_else(|| format!("{n}K"));
    match weapon {
        Some(w) => format!("{headline} · {} · R{round_number}", pretty_weapon(&w)),
        None => format!("{headline} · R{round_number}"),
    }
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
        "flashbang" => "Flash".into(),
        "smokegrenade" => "Smoke".into(),
        "decoy" => "Decoy".into(),
        "inferno" | "molotov" | "incgrenade" => "Molotov".into(),
        "taser" => "Zeus".into(),
        w if w.starts_with("knife") || w == "bayonet" => "Knife".into(),
        other => other.to_string(),
    }
}
