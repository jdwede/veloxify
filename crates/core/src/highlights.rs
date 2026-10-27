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
pub const ECO_EQUIP_VALUE: u32 = 2000;

/// A kill on a player who'd saved (under $2,000 of equipment) while you had better gear. Pistol
/// rounds and kills from a lesser (or equal) buy don't count: those were fair fights.
pub fn eco_kill(k: &Kill, pistol_round: bool) -> bool {
    let saved = k.victim_equip_value.is_some_and(|v| v < ECO_EQUIP_VALUE);
    let outgunned = matches!((k.attacker_equip_value, k.victim_equip_value), (Some(a), Some(v)) if a <= v);
    !pistol_round && saved && !outgunned
}
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

/// What a moment counts as, in the words the Settings page uses (a moment can be several):
/// "ace", "4k", "3k", "2k" (a 2K in a fair fight), "clutch", "ninja" (ninja defuse), "rare"
/// (noscope, knife, jumping or grenade-impact kill), "precision" (Deagle, R8 or Scout multi-kill),
/// "flick" (reaction flick), "special" (one kill through a wall or smoke, while flashed, with a Zeus
/// or an HE) and "defuse". From a moment's tags and kill counts, so stored moments can be sorted
/// again when the settings change.
pub fn kinds_of(tags: &[String], kills: u32, eco_kills: u32) -> Vec<&'static str> {
    let has = |t: &str| tags.iter().any(|x| x == t);
    let mut out = vec![];
    match kills {
        0 | 1 => {}
        2 if kills - eco_kills.min(kills) >= 2 => out.push("2k"),
        2 => {}
        3 => out.push("3k"),
        4 => out.push("4k"),
        _ => out.push("ace"),
    }
    if tags.iter().any(|t| t.ends_with(" clutch") && t.starts_with("1v")) {
        out.push("clutch");
    }
    if has("ninja defuse") {
        out.push("ninja");
    }
    if has("defuse") {
        out.push("defuse");
    }
    if ["noscope", "knife kill", "grenade impact kill", "jumping kill"].iter().any(|t| has(t)) {
        out.push("rare");
    }
    if tags.iter().any(|t| t.ends_with(" multi-kill")) {
        out.push("precision");
    }
    if has("reaction flick") {
        out.push("flick");
    }
    if kills == 1 && ["wallbang", "through smoke", "while flashed", "zeus", "HE kill"].iter().any(|t| has(t)) {
        out.push("special");
    }
    out
}

/// Kinds always kept whatever the per-match cap (the rest are the best ones up to it).
pub const DEFINITIVE_KINDS: [&str; 7] = ["ace", "4k", "3k", "clutch", "ninja", "rare", "precision"];

/// The kinds each of the old three levels (Settings' quick choices) stands for.
pub fn preset_kinds(sel: Selectivity) -> Vec<String> {
    let mut k: Vec<&str> = DEFINITIVE_KINDS.to_vec();
    if sel != Selectivity::HighlightsOnly {
        k.extend(["2k", "flick"]);
    }
    if sel == Selectivity::Everything {
        k.extend(["special", "defuse"]);
    }
    k.into_iter().map(String::from).collect()
}

/// What the user counts as a highlight (Settings).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HighlightRules {
    /// Kinds that make a moment a highlight (see [`kinds_of`]).
    pub kinds: Vec<String>,
    /// Clutches count from 1 vs this many.
    pub clutch_min: u32,
    /// Leave out moments where most kills were on players who'd saved (aces and clutches stay).
    pub skip_eco: bool,
    /// The most moments kept from one match besides the definitive ones ([`DEFINITIVE_KINDS`]).
    pub cap: usize,
}

impl Default for HighlightRules {
    fn default() -> Self {
        Self { kinds: preset_kinds(Selectivity::SolidPlays), clutch_min: 1, skip_eco: false, cap: MAX_PER_PLAYER }
    }
}

impl HighlightRules {
    /// Whether a moment with these tags counts, and whether it's one always kept.
    pub fn judge(&self, tags: &[String], kills: u32, eco_kills: u32, clutch_vs: u32) -> (bool, bool) {
        let kinds = kinds_of(tags, kills, eco_kills);
        let on = |k: &str| self.kinds.iter().any(|x| x == k) && (k != "clutch" || clutch_vs >= self.clutch_min);
        let hits: Vec<&str> = kinds.into_iter().filter(|k| on(k)).collect();
        if hits.is_empty() {
            return (false, false);
        }
        if self.skip_eco && tags.iter().any(|t| t == "vs eco") && !hits.iter().any(|k| *k == "ace" || *k == "clutch") {
            return (false, false);
        }
        (true, hits.iter().any(|k| DEFINITIVE_KINDS.contains(k)))
    }
}

/// Splits moments into the ones kept (the definitive kinds, then the best others up to the cap)
/// and the rest, each best first. `info` gives a moment's (score, tags, kills, eco kills, clutch vs).
pub fn split_by_rules<T>(all: Vec<T>, rules: &HighlightRules, info: impl Fn(&T) -> (f64, &[String], u32, u32, u32)) -> (Vec<T>, Vec<T>) {
    let mut judged: Vec<(bool, bool, f64, T)> = all
        .into_iter()
        .map(|h| {
            let (score, tags, kills, eco, clutch) = info(&h);
            let (ok, definitive) = rules.judge(tags, kills, eco, clutch);
            (ok, definitive, score, h)
        })
        .collect();
    judged.sort_by(|a, b| b.1.cmp(&a.1).then(b.2.total_cmp(&a.2)));
    let definitive = judged.iter().filter(|j| j.0 && j.1).count();
    let room = definitive.max(rules.cap);
    let (mut keep, mut rest) = (vec![], vec![]);
    for (ok, _, score, h) in judged {
        if ok && keep.len() < room {
            keep.push((score, h));
        } else {
            rest.push((score, h));
        }
    }
    keep.sort_by(|a, b| b.0.total_cmp(&a.0));
    rest.sort_by(|a, b| b.0.total_cmp(&a.0));
    (keep.into_iter().map(|x| x.1).collect(), rest.into_iter().map(|x| x.1).collect())
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

/// Overtime, late and close (10-10 or later, within one), the enemy on match point, or our match
/// point while they're still in it (10+).
pub fn is_critical_round(m: &Match, r: usize, team: TeamId) -> bool {
    round_context(m, r, team).critical
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
        pistol: crate::analysis::pistol_rounds(m).contains(&r),
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
        let is_eco_kill = |k: &Kill| eco_kill(k, ctx.pistol);
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

        // 2Ks in a fair fight (gun round, pistol round, or from a lesser buy) are solid plays.
        if n == 2 && real_kills >= 2 {
            tier = tier.max(2);
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
        // One taps: tagged (and worth a little more), but not a highlight on their own.
        for k in &ks {
            if one_tap(m, k, player) {
                score += 0.75;
                tag("one tap".into(), &mut tags);
            }
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
        // Up to 5 s after the round ends, or past a kill in the seconds after it (before the next
        // round starts), with a moment after it.
        let last_kill = ks.iter().map(|k| k.tick).max().unwrap_or(round.end_tick);
        let hi = (round.end_tick + (5.0 * TICKRATE) as i32).max(last_kill + (1.5 * TICKRATE) as i32);
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
        let title = title(&tags, n, most_used_weapon(m, &kills), round.number);
        // Most of the kills on players who'd saved: marked so they're easy to spot or hide.
        if n > 0 && ks.iter().filter(|k| is_eco_kill(k)).count() * 2 >= n {
            tag("vs eco".into(), &mut tags);
        }

        out.push(Highlight {
            player,
            round: r,
            round_number: round.number,
            tier,
            score: (score * 10.0).round() / 10.0,
            hand: hand(n, &ks, &tags, clutch),
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

/// The least montage score ([`montage_score`]) a play of the match needs: a clean 3K on a gun round,
/// a 1v2 clutch with both kills, or a rare kill in a multi-kill. Below it the match has none.
pub const POTM_MIN: f64 = 30.0;

/// The play of the match, by anyone in it: the flashiest moment, the one for a montage. Every
/// player's moments are found (without the reaction-flick parse, so it's the same for all) and
/// ranked by [`montage_score`].
pub fn play_of_the_match(m: &Match, a: &Analysis) -> Option<Highlight> {
    let no_flicks = HashMap::new();
    m.players
        .iter()
        .flat_map(|p| detect(m, a, p.steamid, &no_flicks))
        .map(|h| (montage_score(m, a, &h), h))
        .filter(|(s, _)| *s >= POTM_MIN)
        .max_by(|x, y| x.0.partial_cmp(&y.0).unwrap())
        .map(|(_, h)| h)
}

/// How much a moment belongs in a montage: big multi-kills and big clutches first; kills on
/// players who'd saved count for little unless they were blindingly fast; a pistol-round
/// multi-kill, a fast spree, noscopes, collaterals, jumping and knife kills, wallbangs and ninja
/// defuses add to it.
pub fn montage_score(m: &Match, a: &Analysis, h: &Highlight) -> f64 {
    let ks: Vec<&Kill> = h.kills.iter().map(|&i| &m.kills[i]).collect();
    let n = ks.len();
    let pistol = crate::analysis::pistol_rounds(m).contains(&h.round);
    let ecos = ks.iter().filter(|k| eco_kill(k, pistol)).count();
    let mut s = match n {
        0 => 0.0,
        1 => 4.0,
        2 => 12.0,
        3 => 35.0,
        4 => 60.0,
        _ => 100.0,
    };
    // Seconds between kills, on average: an ACE in 5 seconds is a different thing from one over
    // the whole round.
    let gap = if n >= 2 {
        let (first, last) = (ks.iter().map(|k| k.tick).min().unwrap(), ks.iter().map(|k| k.tick).max().unwrap());
        (last - first) as f64 / TICKRATE / (n - 1) as f64
    } else {
        f64::MAX
    };
    let blitz = n >= 3 && gap <= 0.8;
    if n >= 3 {
        s *= if gap <= 0.8 { 1.45 } else if gap <= 2.0 { 1.25 } else if gap <= 4.0 { 1.1 } else { 1.0 };
    }
    // Kills on saved players: a quarter of the value (half for a blitz).
    if n > 0 && ecos > 0 {
        let share = ecos as f64 / n as f64;
        s *= 1.0 - share * if blitz { 0.5 } else { 0.75 };
    }
    if let Some(c) = a.rounds[h.round].clutches.iter().find(|c| c.player == h.player && c.won) {
        s += [0.0, 6.0, 18.0, 38.0, 65.0, 95.0][(c.vs as usize).min(5)];
    }
    if pistol && n - ecos >= 2 {
        s *= 1.25;
    }
    for (j, k) in ks.iter().enumerate() {
        if (k.noscope && SNIPERS.contains(&k.weapon.as_str())) || k.weapon.starts_with("knife") || k.weapon == "bayonet" || k.attacker_in_air || IMPACT_NADES.contains(&k.weapon.as_str()) {
            s += 10.0;
        }
        if j > 0 && ks[j - 1].tick == k.tick {
            s += 8.0;
        }
        s += 3.0 * ((k.penetrated > 0) as u8 + k.through_smoke as u8 + k.attacker_blind as u8) as f64;
        s += if k.headshot { 0.5 } else { 0.0 };
    }
    if h.tags.iter().any(|t| t == "ninja defuse") {
        s += 15.0;
    }
    if h.tags.iter().any(|t| t.starts_with("critical round")) {
        s *= 1.1;
    }
    // A multi-kill in a round the team still lost is less of a moment.
    if m.team_of(h.player).is_some_and(|t| m.rounds[h.round].winner_team() != t) {
        s *= 0.85;
    }
    s
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
/// A one tap: a single bullet to the head that killed from 80+ health, with a rifle or a pistol,
/// not in the middle of a spray (no other shot in the 0.2 s before it, no earlier hit on them).
fn one_tap(m: &Match, k: &Kill, player: u64) -> bool {
    if !k.headshot || !matches!(weapon_class(&k.weapon), "rifle" | "pistol" | "deagle") {
        return false;
    }
    let hits: Vec<_> = m.damages.iter().filter(|d| d.attacker == Some(player) && d.victim == k.victim && d.tick <= k.tick && d.tick >= k.tick - 3 * TICKRATE as i32).collect();
    let [hit] = hits.as_slice() else { return false };
    if hit.tick != k.tick || hit.hitgroup != "head" || hit.health_removed < 80 {
        return false;
    }
    !m.shots.iter().any(|s| s.player == player && s.tick < k.tick && s.tick >= k.tick - (0.2 * TICKRATE) as i32)
}

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

/// Weapon family, for filters and lowlight kinds: rifle, awp, scout, auto (auto-snipers),
/// deagle (Deagle/R8), pistol, smg, shotgun, mg, knife, grenade, zeus.
pub fn weapon_class(w: &str) -> &'static str {
    match w.trim_start_matches("weapon_") {
        "ak47" | "m4a1" | "m4a1_silencer" | "galilar" | "famas" | "sg556" | "aug" => "rifle",
        "awp" => "awp",
        "ssg08" => "scout",
        "g3sg1" | "scar20" => "auto",
        "deagle" | "revolver" => "deagle",
        "glock" | "usp_silencer" | "hkp2000" | "p250" | "fiveseven" | "tec9" | "cz75a" | "elite" => "pistol",
        "mac10" | "mp9" | "mp7" | "mp5sd" | "ump45" | "p90" | "bizon" => "smg",
        "nova" | "xm1014" | "mag7" | "sawedoff" => "shotgun",
        "m249" | "negev" => "mg",
        "hegrenade" | "flashbang" | "smokegrenade" | "decoy" | "inferno" | "molotov" | "incgrenade" => "grenade",
        "taser" => "zeus",
        w if w.starts_with("knife") || w == "bayonet" => "knife",
        _ => "other",
    }
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

#[cfg(test)]
mod rules_tests {
    use super::*;

    fn tags(t: &[&str]) -> Vec<String> {
        t.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn kinds_from_tags() {
        assert_eq!(kinds_of(&tags(&["3K", "1v2 clutch"]), 3, 0), vec!["3k", "clutch"]);
        // A 2K on players who'd saved isn't a fair 2K.
        assert!(kinds_of(&tags(&["2K"]), 2, 1).is_empty());
        assert_eq!(kinds_of(&tags(&["2K", "reaction flick"]), 2, 0), vec!["2k", "flick"]);
        assert_eq!(kinds_of(&tags(&["wallbang"]), 1, 0), vec!["special"]);
        assert_eq!(kinds_of(&tags(&["Deagle multi-kill", "2K"]), 2, 0), vec!["2k", "precision"]);
    }

    #[test]
    fn rules_pick_and_cap() {
        let rules = HighlightRules { kinds: tags(&["3k", "clutch"]), clutch_min: 2, skip_eco: false, cap: 1 };
        assert_eq!(rules.judge(&tags(&["1v1 clutch"]), 1, 0, 1), (false, false));
        assert_eq!(rules.judge(&tags(&["1v2 clutch"]), 1, 0, 2), (true, true));
        assert_eq!(rules.judge(&tags(&["2K"]), 2, 0, 0), (false, false));
        let eco = HighlightRules { skip_eco: true, ..rules.clone() };
        assert_eq!(eco.judge(&tags(&["3K", "vs eco"]), 3, 2, 0), (false, false));
        // Definitive moments are all kept; others only up to the cap.
        let solid = HighlightRules { kinds: preset_kinds(Selectivity::SolidPlays), clutch_min: 1, skip_eco: false, cap: 1 };
        let all = vec![(5.0, tags(&["2K"]), 2u32), (4.0, tags(&["2K"]), 2), (3.0, tags(&["3K"]), 3), (2.0, tags(&["4K"]), 4)];
        let (keep, rest) = split_by_rules(all, &solid, |h| (h.0, h.1.as_slice(), h.2, 0, 0));
        assert_eq!(keep.iter().map(|h| h.0).collect::<Vec<_>>(), vec![3.0, 2.0]);
        assert_eq!(rest.len(), 2);
    }
}
