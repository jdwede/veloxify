//! Per-match details for the match page's tabs (Leetify-style): aim, utility, activity, opening
//! duels, clutches, trades, the kill feed and rounds. Built from the demo when a match is
//! imported (or later, in the background, for older matches) and saved next to the match entry
//! as `matches/<id>.details.json`.
//!
//! Aim follows Leetify's published definitions. "Spotted" is CS2's own spotted-by state (which
//! players can see whom), sampled every other tick; an engagement is a stretch of time in which
//! a player had a given enemy spotted.

use crate::analysis::{is_enemy_kill, Analysis};
use crate::highlights::weapon_class;
use crate::model::{GrenadeKind, Match, Side, TeamId, TICKRATE};
use crate::raw::{self, Val};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

/// Bumped whenever what's in a details file changes, so older ones are rebuilt.
pub const VERSION: u32 = 2;

/// Spotted state is sampled every this many ticks.
const SPOT_STEP: i32 = 2;
/// Spotted gaps shorter than this (ticks) don't end an engagement.
const SPOT_GAP: i32 = 16;
/// Time to damage longer than this is a held angle ("trigger discipline"), not aim: excluded
/// (Leetify drops engagements over 1 s).
const TTD_MAX_MS: f64 = 1000.0;
/// A flash counts as flashing someone from 1.1 s of blindness (Leetify).
const FLASH_MIN_S: f32 = 1.1;
/// Kills that took longer than this from the first hit don't count for time to kill (Leetify).
const TTK_HURT_MAX_TICKS: i32 = (5.0 * TICKRATE) as i32;
/// A shot this long after the player's previous one starts with the recoil fully reset.
const RECOIL_RESET_TICKS: i32 = (0.5 * TICKRATE) as i32;
/// Shots closer together than this belong to the same spray.
const SPRAY_GAP_TICKS: i32 = (0.2 * TICKRATE) as i32;
/// Fully crouched (counter-strafing excludes these shots).
const CROUCHED: f64 = 0.9;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MatchDetails {
    pub version: u32,
    pub rounds: Vec<DRound>,
    pub kills: Vec<DKill>,
    pub clutches: Vec<DClutch>,
    pub players: Vec<DPlayer>,
    pub grenades: Vec<DGrenade>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DRound {
    pub number: u32,
    /// "mine" or "enemy" (relative to the library owner).
    pub winner: String,
    /// Side the winners played: "T" or "CT".
    pub winner_side: String,
    /// e.g. "t_killed", "bomb_exploded", "bomb_defused", "ct_killed", "target_saved".
    pub reason: String,
    /// Side the owner's team played.
    pub mine_side: String,
    pub score_mine: u32,
    pub score_theirs: u32,
    pub live_tick: i32,
    pub end_tick: i32,
    /// Bomb plant: (seconds into the round, site callout, planter).
    pub plant: Option<(f32, String, String)>,
    pub defused: bool,
    pub exploded: bool,
    /// Average equipment value per team when the first kill happened (or round start), $.
    pub equip_mine: u32,
    pub equip_theirs: u32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DKill {
    pub round: u32,
    /// Seconds into the round.
    pub t: f32,
    pub attacker: String,
    pub victim: String,
    pub assister: String,
    pub flash_assist: bool,
    pub weapon: String,
    pub headshot: bool,
    pub wallbang: bool,
    pub smoke: bool,
    pub noscope: bool,
    pub blind: bool,
    pub attacker_side: String,
    pub victim_side: String,
    pub attacker_xy: Option<[f32; 2]>,
    pub victim_xy: Option<[f32; 2]>,
    pub attacker_place: String,
    pub victim_place: String,
    /// The round's first kill.
    pub opening: bool,
    /// This kill avenged a teammate killed within 5 s.
    pub trade: bool,
    /// The victim's death was avenged within 5 s.
    pub traded: bool,
    /// A team kill (or suicide).
    pub team_kill: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DClutch {
    pub round: u32,
    pub player: String,
    pub side: String,
    pub vs: u32,
    pub kills: u32,
    /// "won", "lost" or "saved" (lost the round but survived).
    pub result: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DGrenade {
    pub round: u32,
    pub t: f32,
    pub player: String,
    pub kind: String,
    pub xy: [f32; 2],
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DPlayer {
    pub steamid: String,
    pub aim: Aim,
    pub utility: Utility,
    pub activity: Activity,
    /// The stats as the match page shows them (see [`STATS`]); missing when there's no sample.
    #[serde(default)]
    pub stats: std::collections::BTreeMap<String, f64>,
}

/// Every stat on the match page's Aim, Utility and Activity tabs: key, and whether lower is
/// better (for colors and ratings).
pub const STATS: &[(&str, bool)] = &[
    ("spotted_accuracy", false),
    ("ttd_ms", true),
    ("ttk_ms", true),
    ("crosshair_deg", true),
    ("head_accuracy", false),
    ("hs_kill_pct", false),
    ("first_bullet", false),
    ("spray_accuracy", false),
    ("counter_strafe", false),
    ("accuracy", false),
    ("accurate_movement", false),
    ("air_shot_pct", true),
    ("air_accuracy", false),
    ("nades_per_round", false),
    ("flash_assist_pct", false),
    ("enemies_per_flash", false),
    ("friends_per_flash", true),
    ("blind_time", false),
    ("he_damage_avg", false),
    ("he_team_damage_avg", true),
    ("unused_utility", true),
    ("damage", false),
    ("he_damage", false),
    ("molotov_damage", false),
    ("enemies_flashed", false),
    ("shots", false),
    ("wasted_magazine", true),
    ("rounds_survived_pct", false),
];

/// Minimum sample before a rate is shown (shots, engagements, grenades).
const MIN_SAMPLE: u32 = 5;

impl DPlayer {
    fn compute_stats(&mut self) {
        let (a, u, ac) = (&self.aim, &self.utility, &self.activity);
        let mut s = std::collections::BTreeMap::new();
        let mut rate = |k: &str, num: u32, den: u32, min: u32| {
            if den >= min && den > 0 {
                s.insert(k.to_string(), num as f64 * 100.0 / den as f64);
            }
        };
        rate("spotted_accuracy", a.spotted_hits, a.spotted_shots, MIN_SAMPLE);
        rate("head_accuracy", a.head_hits, a.body_hits, MIN_SAMPLE);
        rate("hs_kill_pct", a.hs_kills, a.kills, 1);
        rate("first_bullet", a.first_hits, a.first_shots, MIN_SAMPLE);
        rate("spray_accuracy", a.spray_hits, a.spray_shots, MIN_SAMPLE);
        rate("counter_strafe", a.strafe_good, a.strafe_shots, MIN_SAMPLE);
        rate("accuracy", a.hits, a.shots, MIN_SAMPLE);
        rate("accurate_movement", a.move_accurate, a.move_shots, MIN_SAMPLE);
        rate("air_shot_pct", a.air_shots, a.spotted_shots, MIN_SAMPLE);
        rate("air_accuracy", a.air_hits, a.air_shots, 3);
        rate("flash_assist_pct", u.flash_assists, u.flashes, 1);
        rate("wasted_magazine", ac.wasted_bullets, ac.magazine_bullets, 1);
        rate("rounds_survived_pct", ac.rounds_survived, ac.rounds, 1);
        for (k, v, n) in [("ttd_ms", a.ttd_ms, a.ttd_n), ("ttk_ms", a.ttk_ms, a.ttk_n), ("crosshair_deg", a.crosshair_deg, a.crosshair_n)] {
            if let (Some(v), true) = (v, n >= 3) {
                s.insert(k.into(), v);
            }
        }
        let per = |num: f64, den: u32| (den > 0).then(|| num / den as f64);
        let nades = u.flashes + u.smokes + u.hes + u.molotovs;
        let mut put = |k: &str, v: Option<f64>| {
            if let Some(v) = v {
                s.insert(k.to_string(), v);
            }
        };
        put("nades_per_round", per(nades as f64, u.rounds));
        put("enemies_per_flash", per(u.enemies_flashed as f64, u.flashes));
        put("friends_per_flash", per(u.friends_flashed as f64, u.flashes));
        put("blind_time", per(u.enemy_blind_time, u.enemies_flashed));
        put("he_damage_avg", per(u.he_damage as f64, u.hes));
        put("he_team_damage_avg", per(u.he_team_damage as f64, u.hes));
        put("unused_utility", per(u.unused_value as f64, u.deaths));
        put("damage", Some(ac.damage as f64));
        put("he_damage", Some(ac.he_damage as f64));
        put("molotov_damage", Some(ac.molotov_damage as f64));
        put("enemies_flashed", Some(ac.enemies_flashed as f64));
        put("shots", Some(ac.shots as f64));
        self.stats = s;
    }
}

/// Library benchmarks: per stat, the distribution over every player-match (quantiles every 5%,
/// mean, standard deviation), for the match page's Poor..Great colors and its ratings. Saved as
/// `benchmarks.json` in the library.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Benchmark {
    pub n: usize,
    pub mean: f64,
    pub sd: f64,
    pub quantiles: Vec<f64>,
    pub lower_is_better: bool,
}

/// Overall stats every analyzed match has (from the scoreboard rows), usable in custom ratings and
/// trends next to the details stats: key, lower is better.
pub const CORE_STATS: &[(&str, bool)] = &[
    ("rating3", false),
    ("rws", false),
    ("swing", false),
    ("adr", false),
    ("kast", false),
    ("kd", false),
    ("kpr", false),
    ("dpr", true),
    ("hs_pct", false),
    ("entry_success", false),
    ("entry_attempts", false),
    ("trade_kills_pr", false),
    ("traded_deaths_pct", false),
    ("multikill_pr", false),
    ("utility_damage_pr", false),
    ("flash_assists_pr", false),
    ("clutch_wins", false),
];

/// The core stats of one player row.
pub fn core_stats(p: &crate::library::PlayerRow) -> std::collections::BTreeMap<String, f64> {
    let (c, d) = (&p.counts, &p.derived);
    let rounds = c.rounds.max(1) as f64;
    let openings = c.opening_kills + c.opening_deaths;
    let mut s = std::collections::BTreeMap::new();
    let mut put = |k: &str, v: f64| {
        if v.is_finite() {
            s.insert(k.to_string(), v);
        }
    };
    put("rating3", if d.rating3 > 0.0 { d.rating3 } else { d.rating2 });
    put("rws", d.rws);
    put("swing", d.swing);
    put("adr", d.adr);
    put("kast", d.kast);
    put("kd", d.kd);
    put("kpr", d.kpr);
    put("dpr", d.dpr);
    put("hs_pct", d.hs_pct);
    if openings > 0 {
        put("entry_success", c.opening_kills as f64 * 100.0 / openings as f64);
    }
    put("entry_attempts", openings as f64 * 100.0 / rounds);
    put("trade_kills_pr", c.trade_kills as f64 / rounds);
    if c.deaths > 0 {
        put("traded_deaths_pct", c.traded_deaths as f64 * 100.0 / c.deaths as f64);
    }
    put("multikill_pr", c.multikill_rounds.iter().skip(2).sum::<u32>() as f64 / rounds);
    put("utility_damage_pr", c.utility_damage as f64 / rounds);
    put("flash_assists_pr", c.flash_assists as f64 / rounds);
    put("clutch_wins", c.clutches_won.iter().sum::<u32>() as f64);
    s
}

/// One of the owner's matches, for trends over time (`my_stats.json`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MyMatch {
    pub id: String,
    pub ts: i64,
    pub source: String,
    pub result: String,
    pub rounds: u32,
    pub stats: std::collections::BTreeMap<String, f64>,
}

/// Writes `benchmarks.json` (every stat's distribution over all player-matches) and, given the
/// owner, `my_stats.json` (their stats per match: core stats and details stats).
pub fn write_benchmarks(root: &std::path::Path, me: Option<u64>) -> Result<()> {
    let mut values: HashMap<&str, Vec<f64>> = HashMap::new();
    let mut mine: HashMap<String, std::collections::BTreeMap<String, f64>> = HashMap::new();
    let me_s = me.map(|m| m.to_string()).unwrap_or_default();
    for f in std::fs::read_dir(root.join("matches"))?.flatten() {
        let p = f.path();
        if !p.to_string_lossy().ends_with(".details.json") {
            continue;
        }
        let Ok(d) = serde_json::from_str::<MatchDetails>(&std::fs::read_to_string(&p)?) else { continue };
        for pl in &d.players {
            for (k, _) in STATS {
                if let Some(v) = pl.stats.get(*k) {
                    values.entry(k).or_default().push(*v);
                }
            }
            if pl.steamid == me_s {
                let id = p.file_name().unwrap().to_string_lossy().trim_end_matches(".details.json").to_string();
                mine.insert(id, pl.stats.clone());
            }
        }
    }
    let mut my_matches = vec![];
    for f in std::fs::read_dir(root.join("matches"))?.flatten() {
        let p = f.path();
        if !crate::library::is_entry_file(&p) {
            continue;
        }
        let Ok(e) = serde_json::from_str::<crate::library::MatchEntry>(&std::fs::read_to_string(&p)?) else { continue };
        for pl in &e.players {
            let core = core_stats(pl);
            for (k, _) in CORE_STATS {
                if let Some(v) = core.get(*k) {
                    values.entry(k).or_default().push(*v);
                }
            }
            if pl.steamid == me_s {
                let mut stats = core;
                stats.extend(mine.remove(&e.id).unwrap_or_default());
                my_matches.push(MyMatch { id: e.id.clone(), ts: e.played_ts, source: e.source.clone(), result: e.result.clone(), rounds: e.rounds, stats });
            }
        }
    }
    if me.is_some() {
        my_matches.sort_by_key(|m| m.ts);
        std::fs::write(root.join("my_stats.json"), serde_json::to_string(&my_matches)?)?;
    }
    let mut out = std::collections::BTreeMap::new();
    for (k, lower) in STATS.iter().chain(CORE_STATS) {
        let Some(mut v) = values.remove(k) else { continue };
        v.sort_by(|a, b| a.total_cmp(b));
        let n = v.len();
        let mean = v.iter().sum::<f64>() / n as f64;
        let sd = (v.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / n as f64).sqrt();
        let quantiles = (0..=20).map(|i| v[((i as f64 / 20.0) * (n - 1) as f64).round() as usize]).collect();
        out.insert(k.to_string(), Benchmark { n, mean, sd, quantiles, lower_is_better: *lower });
    }
    std::fs::write(root.join("benchmarks.json"), serde_json::to_string(&out)?)?;
    Ok(())
}

/// Raw counts and per-engagement samples summarized; the UI turns them into Leetify's stats.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Aim {
    /// Gun shots and the ones that hit an enemy.
    pub shots: u32,
    pub hits: u32,
    /// Shots fired while an enemy was spotted, and their hits (Spotted Accuracy).
    pub spotted_shots: u32,
    pub spotted_hits: u32,
    /// Hits on enemies (AWP excluded) and how many were in the head (Head Accuracy).
    pub body_hits: u32,
    pub head_hits: u32,
    pub kills: u32,
    pub hs_kills: u32,
    /// Average time from spotting an enemy to first damaging them, ms (Time to Damage).
    pub ttd_ms: Option<f64>,
    pub ttd_n: u32,
    /// Median time from spotting an enemy to killing them, ms (Time to Kill).
    pub ttk_ms: Option<f64>,
    pub ttk_n: u32,
    /// Median angle the crosshair moved from spotting an enemy to the first hit, degrees.
    pub crosshair_deg: Option<f64>,
    pub crosshair_n: u32,
    /// First shots after the recoil reset with an enemy spotted (no shotguns or snipers).
    pub first_shots: u32,
    pub first_hits: u32,
    /// Rifle shots in sprays (3+ shots) with an enemy spotted.
    pub spray_shots: u32,
    pub spray_hits: u32,
    /// Rifle shots with an enemy spotted (not fully crouched), and those below 34% speed.
    pub strafe_shots: u32,
    pub strafe_good: u32,
    /// Movement, any gun, enemy spotted: shots on the ground (not fully crouched) and those
    /// below 34% of the gun's max speed; shots fired in the air and their hits.
    #[serde(default)]
    pub move_shots: u32,
    #[serde(default)]
    pub move_accurate: u32,
    #[serde(default)]
    pub air_shots: u32,
    #[serde(default)]
    pub air_hits: u32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Utility {
    pub flashes: u32,
    pub smokes: u32,
    pub hes: u32,
    pub molotovs: u32,
    pub decoys: u32,
    pub flash_assists: u32,
    pub enemies_flashed: u32,
    pub friends_flashed: u32,
    /// Seconds enemies spent blinded by this player's flashes.
    pub enemy_blind_time: f64,
    pub he_damage: u32,
    pub he_team_damage: u32,
    pub molotov_damage: u32,
    /// Value of the grenades still held when this player died ($), and the deaths counted.
    pub unused_value: u32,
    pub deaths: u32,
    pub rounds: u32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Activity {
    pub damage: u32,
    pub he_damage: u32,
    pub molotov_damage: u32,
    pub enemies_flashed: u32,
    pub shots: u32,
    /// Reloads, and the bullets still in the magazine and its size summed over them (Wasted
    /// Magazine: how much of a magazine is left when reloading).
    pub reloads: u32,
    pub wasted_bullets: u32,
    pub magazine_bullets: u32,
    pub rounds: u32,
    pub rounds_survived: u32,
}

/// Magazine size of each gun.
fn magazine(w: &str) -> u32 {
    match w {
        "ak47" | "m4a1" | "aug" | "sg556" | "mac10" | "mp9" | "mp7" | "mp5sd" | "elite" => 30,
        "m4a1_silencer" | "glock" | "fiveseven" | "g3sg1" | "scar20" => 20,
        "famas" | "ump45" => 25,
        "galilar" => 35,
        "awp" | "mag7" => 5,
        "ssg08" => 10,
        "deagle" | "xm1014" | "sawedoff" => 7,
        "revolver" | "nova" => 8,
        "usp_silencer" | "cz75a" => 12,
        "hkp2000" | "p250" => 13,
        "tec9" => 18,
        "p90" => 50,
        "bizon" => 64,
        "m249" => 100,
        "negev" => 150,
        _ => 0,
    }
}

use crate::lowlights::max_speed;

fn is_gun(w: &str) -> bool {
    matches!(weapon_class(w), "rifle" | "awp" | "scout" | "auto" | "deagle" | "pistol" | "smg" | "shotgun" | "mg")
}

/// Value of a grenade in an inventory list (CS2's display names).
fn grenade_value(item: &str) -> u32 {
    let i = item.to_lowercase();
    if i.contains("flash") {
        200
    } else if i.contains("smoke") || i.contains("high explosive") || i.contains("he grenade") {
        300
    } else if i.contains("incendiary") {
        500
    } else if i.contains("molotov") {
        400
    } else if i.contains("decoy") {
        50
    } else {
        0
    }
}

fn side_str(s: Side) -> String {
    match s {
        Side::T => "T".into(),
        Side::CT => "CT".into(),
    }
}

fn sid(s: u64) -> String {
    s.to_string()
}

fn median(mut v: Vec<f64>) -> Option<f64> {
    if v.is_empty() {
        return None;
    }
    v.sort_by(|a, b| a.total_cmp(b));
    let n = v.len();
    Some(if n % 2 == 1 { v[n / 2] } else { (v[n / 2 - 1] + v[n / 2]) / 2.0 })
}

/// Angle between two view directions given as (pitch, yaw) in degrees.
fn view_angle(a: (f64, f64), b: (f64, f64)) -> f64 {
    let dir = |(p, y): (f64, f64)| {
        let (p, y) = (p.to_radians(), y.to_radians());
        (p.cos() * y.cos(), p.cos() * y.sin(), -p.sin())
    };
    let (u, v) = (dir(a), dir(b));
    (u.0 * v.0 + u.1 * v.1 + u.2 * v.2).clamp(-1.0, 1.0).acos().to_degrees()
}

/// Builds the details. `me` decides which team is "mine".
pub fn build(demo: &[u8], m: &Match, a: &Analysis, me: u64) -> Result<MatchDetails> {
    let my_team = m.team_of(me).unwrap_or(TeamId::A);
    let rel = |t: TeamId| if t == my_team { "mine".to_string() } else { "enemy".to_string() };
    let team = |s: u64| m.team_of(s);
    let enemies = |a: u64, b: u64| matches!((team(a), team(b)), (Some(x), Some(y)) if x != y);
    let secs = |r: usize, tick: i32| ((tick - m.rounds[r].live_tick) as f64 / TICKRATE).max(0.0) as f32;

    // ---- Rounds -------------------------------------------------------------------------------
    let mut rounds = vec![];
    let (mut sm, mut st) = (0, 0);
    for (r, round) in m.rounds.iter().enumerate() {
        let winner = round.winner_team();
        if winner == my_team {
            sm += 1
        } else {
            st += 1
        }
        let plant = m.bomb.iter().find(|b| b.round == r && !b.defused);
        let defused = m.bomb.iter().any(|b| b.round == r && b.defused);
        let exploded = m.explosions.iter().any(|t| *t >= round.live_tick && *t <= round.end_tick + (2.0 * TICKRATE) as i32);
        // Equipment: what each team had in the round's first kill (the only time it's known).
        let mut eq: HashMap<TeamId, Vec<u32>> = HashMap::new();
        for k in m.kills.iter().filter(|k| k.round == r) {
            if let (Some(at), Some(v)) = (k.attacker.and_then(team), k.attacker_equip_value) {
                eq.entry(at).or_default().push(v);
            }
            if let (Some(vt), Some(v)) = (team(k.victim), k.victim_equip_value) {
                eq.entry(vt).or_default().push(v);
            }
        }
        let avg = |t: TeamId| eq.get(&t).filter(|v| !v.is_empty()).map(|v| v.iter().sum::<u32>() / v.len() as u32).unwrap_or(0);
        let other = if my_team == TeamId::A { TeamId::B } else { TeamId::A };
        rounds.push(DRound {
            number: round.number,
            winner: rel(winner),
            winner_side: side_str(round.winner),
            reason: round.reason.clone(),
            mine_side: side_str(round.side_of(my_team)),
            score_mine: sm,
            score_theirs: st,
            live_tick: round.live_tick,
            end_tick: round.end_tick,
            plant: plant.map(|b| (secs(r, b.tick), b.place.clone(), sid(b.player))),
            defused,
            exploded,
            equip_mine: avg(my_team),
            equip_theirs: avg(other),
        });
    }

    // ---- Kills (with opening / trade flags) and clutches ----------------------------------------
    let mut kills = vec![];
    for (i, k) in m.kills.iter().enumerate() {
        let facts = &a.rounds[k.round];
        let enemy = is_enemy_kill(m, k.attacker, k.victim);
        kills.push(DKill {
            round: m.rounds[k.round].number,
            t: secs(k.round, k.tick),
            attacker: k.attacker.map(sid).unwrap_or_default(),
            victim: sid(k.victim),
            assister: k.assister.map(sid).unwrap_or_default(),
            flash_assist: k.flash_assist,
            weapon: k.weapon.trim_start_matches("weapon_").to_string(),
            headshot: k.headshot,
            wallbang: k.penetrated > 0,
            smoke: k.through_smoke,
            noscope: k.noscope,
            blind: k.attacker_blind,
            attacker_side: k.attacker.and_then(|s| m.side_in_round(s, k.round)).map(side_str).unwrap_or_default(),
            victim_side: m.side_in_round(k.victim, k.round).map(side_str).unwrap_or_default(),
            attacker_xy: k.attacker_xy,
            victim_xy: k.victim_xy,
            attacker_place: k.attacker_place.clone(),
            victim_place: k.victim_place.clone(),
            opening: facts.opening_kill == Some(i),
            trade: facts.trade_kills.contains(&i),
            traded: enemy && facts.traded.contains(&k.victim),
            team_kill: !enemy,
        });
    }
    let clutches = a
        .clutches()
        .map(|c| DClutch {
            round: m.rounds[c.round].number,
            player: sid(c.player),
            side: m.side_in_round(c.player, c.round).map(side_str).unwrap_or_default(),
            vs: c.vs,
            kills: c.kills,
            result: if c.won {
                "won".into()
            } else if a.rounds[c.round].died.contains(&c.player) {
                "lost".into()
            } else {
                "saved".into()
            },
        })
        .collect();
    let grenades = m
        .grenades
        .iter()
        .map(|g| DGrenade {
            round: m.rounds[g.round].number,
            t: secs(g.round, g.tick),
            player: sid(g.player),
            kind: match g.kind {
                GrenadeKind::He => "he",
                GrenadeKind::Flash => "flash",
                GrenadeKind::Smoke => "smoke",
                GrenadeKind::Molotov => "molotov",
            }
            .into(),
            xy: g.xy,
        })
        .collect();

    // ---- Spotted: who could see whom, every other tick of live play -----------------------------
    let mut spot_ticks: Vec<i32> = vec![];
    for r in &m.rounds {
        let start = r.live_tick - r.live_tick.rem_euclid(SPOT_STEP);
        spot_ticks.extend((start..=r.end_tick).step_by(SPOT_STEP as usize));
    }
    let spotted = raw::players_values(demo, &["approximate_spotted_by"], &spot_ticks)?;
    // seen[(observer, tick)] = enemies the observer had spotted then.
    let mut seen: HashMap<(u64, i32), Vec<u64>> = HashMap::new();
    for ((target, tick), vals) in &spotted {
        if let Some(Val::Ids(by)) = vals.get("approximate_spotted_by") {
            for &obs in by {
                if obs != *target && enemies(obs, *target) {
                    seen.entry((obs, *tick)).or_default().push(*target);
                }
            }
        }
    }
    drop(spotted);
    let spot_at = |obs: u64, tick: i32| seen.get(&(obs, tick - tick.rem_euclid(SPOT_STEP)));
    let has_spotted = |obs: u64, tick: i32| spot_at(obs, tick).is_some_and(|v| !v.is_empty());

    // Engagements: stretches in which `obs` had `target` spotted.
    let mut engagements: HashMap<(u64, u64), Vec<(i32, i32)>> = HashMap::new();
    {
        let mut open: HashMap<(u64, u64), (i32, i32)> = HashMap::new();
        for &tick in &spot_ticks {
            for p in &m.players {
                let now: &[u64] = seen.get(&(p.steamid, tick)).map(|v| v.as_slice()).unwrap_or(&[]);
                for &target in now {
                    let e = open.entry((p.steamid, target)).or_insert((tick, tick));
                    if tick - e.1 > SPOT_GAP {
                        engagements.entry((p.steamid, target)).or_default().push(*e);
                        *e = (tick, tick);
                    } else {
                        e.1 = tick;
                    }
                }
            }
        }
        for (k, e) in open {
            engagements.entry(k).or_default().push(e);
        }
        for v in engagements.values_mut() {
            v.sort();
        }
    }
    let engagement_at = |obs: u64, target: u64, tick: i32| -> Option<(i32, i32)> {
        engagements.get(&(obs, target))?.iter().rev().find(|(s, e)| *s <= tick && tick <= e + SPOT_GAP * 2).copied()
    };

    // ---- Shots and hits ---------------------------------------------------------------------------
    struct ShotInfo {
        tick: i32,
        weapon: String,
        hit: bool,
        first: bool,
        spray: bool,
    }
    let mut shots: HashMap<u64, Vec<ShotInfo>> = HashMap::new();
    for s in &m.shots {
        let w = s.weapon.trim_start_matches("weapon_");
        if is_gun(w) {
            shots.entry(s.player).or_default().push(ShotInfo { tick: s.tick, weapon: w.to_string(), hit: false, first: false, spray: false });
        }
    }
    for list in shots.values_mut() {
        list.sort_by_key(|s| s.tick);
        for i in 0..list.len() {
            list[i].first = i == 0 || list[i].tick - list[i - 1].tick >= RECOIL_RESET_TICKS;
        }
        // Sprays: runs of 3+ shots of the same gun, each within SPRAY_GAP of the last.
        let mut start = 0;
        for i in 1..=list.len() {
            let breaks = i == list.len() || list[i].tick - list[i - 1].tick > SPRAY_GAP_TICKS || list[i].weapon != list[i - 1].weapon;
            if breaks {
                if i - start >= 3 {
                    for s in &mut list[start..i] {
                        s.spray = true;
                    }
                }
                start = i;
            }
        }
    }
    // A hit belongs to the shooter's latest shot of that gun at most 2 ticks earlier.
    let mut first_hit: HashMap<(u64, u64, i32), i32> = HashMap::new(); // (obs, target, engagement start) -> tick
    for d in &m.damages {
        let Some(att) = d.attacker else { continue };
        let w = d.weapon.trim_start_matches("weapon_");
        if !is_gun(w) || !enemies(att, d.victim) {
            continue;
        }
        if let Some(list) = shots.get_mut(&att) {
            let i = list.partition_point(|s| s.tick <= d.tick);
            if let Some(s) = list[..i].iter_mut().rev().find(|s| s.weapon == w && d.tick - s.tick <= 2) {
                s.hit = true;
            }
        }
        if let Some((start, _)) = engagement_at(att, d.victim, d.tick) {
            first_hit.entry((att, d.victim, start)).and_modify(|t| *t = (*t).min(d.tick)).or_insert(d.tick);
        }
    }

    // ---- Per-tick state needed: view angles, speed and crouch, inventories, ammo -----------------
    let mut state_ticks: HashSet<i32> = HashSet::new();
    for (&(_, _, start), &hit) in &first_hit {
        state_ticks.insert(start);
        state_ticks.insert(hit);
    }
    for (p, list) in &shots {
        for s in list.iter().filter(|s| has_spotted(*p, s.tick)) {
            state_ticks.insert(s.tick);
            state_ticks.insert(s.tick - 1);
        }
    }
    for k in &m.kills {
        state_ticks.insert(k.tick - 2);
    }
    for r in &m.reloads {
        state_ticks.insert(r.tick);
    }
    let mut state_ticks: Vec<i32> = state_ticks.into_iter().filter(|t| *t > 0).collect();
    state_ticks.sort_unstable();
    let state =
        raw::players_values(demo, &["X", "Y", "pitch", "yaw", "duck_amount", "is_airborne", "inventory", "active_weapon_ammo"], &state_ticks)?;
    let num = |s: u64, t: i32, k: &str| match state.get(&(s, t)).and_then(|v| v.get(k)) {
        Some(Val::Num(x)) => Some(*x),
        _ => None,
    };
    let angles = |s: u64, t: i32| Some((num(s, t, "pitch")?, num(s, t, "yaw")?));

    // ---- Per player ----------------------------------------------------------------------------------
    let pistols_or_snipers = |w: &str| matches!(weapon_class(w), "shotgun" | "awp" | "scout" | "auto");
    let mut players = vec![];
    for p in &m.players {
        let s = p.steamid;
        let mut aim = Aim::default();
        let list: &[ShotInfo] = shots.get(&s).map(|v| v.as_slice()).unwrap_or(&[]);
        for sh in list {
            aim.shots += 1;
            aim.hits += sh.hit as u32;
            let spotted_now = has_spotted(s, sh.tick);
            if spotted_now {
                aim.spotted_shots += 1;
                aim.spotted_hits += sh.hit as u32;
                if sh.first && !pistols_or_snipers(&sh.weapon) {
                    aim.first_shots += 1;
                    aim.first_hits += sh.hit as u32;
                }
                let rifle = weapon_class(&sh.weapon) == "rifle";
                if rifle && sh.spray {
                    aim.spray_shots += 1;
                    aim.spray_hits += sh.hit as u32;
                }
                let pos = |t: i32| Some((num(s, t, "X")?, num(s, t, "Y")?));
                let airborne = num(s, sh.tick, "is_airborne").unwrap_or(0.0) > 0.5;
                if airborne {
                    aim.air_shots += 1;
                    aim.air_hits += sh.hit as u32;
                } else if let (Some(a0), Some(a1), duck) = (pos(sh.tick - 1), pos(sh.tick), num(s, sh.tick, "duck_amount").unwrap_or(0.0)) {
                    if duck < CROUCHED {
                        let accurate = (a1.0 - a0.0).hypot(a1.1 - a0.1) * TICKRATE < 0.34 * max_speed(&sh.weapon);
                        aim.move_shots += 1;
                        aim.move_accurate += accurate as u32;
                        if rifle {
                            aim.strafe_shots += 1;
                            aim.strafe_good += accurate as u32;
                        }
                    }
                }
            }
        }
        for d in m.damages.iter().filter(|d| d.attacker == Some(s) && enemies(s, d.victim)) {
            let w = d.weapon.trim_start_matches("weapon_");
            if is_gun(w) && w != "awp" {
                aim.body_hits += 1;
                aim.head_hits += (d.hitgroup == "head") as u32;
            }
        }
        let my_kills: Vec<_> = m.kills.iter().filter(|k| k.attacker == Some(s) && is_enemy_kill(m, Some(s), k.victim)).collect();
        aim.kills = my_kills.len() as u32;
        aim.hs_kills = my_kills.iter().filter(|k| k.headshot).count() as u32;
        // Time to damage and crosshair placement, per engagement with a hit.
        let mut ttd = vec![];
        let mut xhair = vec![];
        for (&(obs, target, start), &hit) in first_hit.iter().filter(|((o, _, _), _)| *o == s) {
            let _ = target;
            let ms = (hit - start) as f64 / TICKRATE * 1000.0;
            if ms <= TTD_MAX_MS {
                ttd.push(ms);
            }
            if let (Some(a0), Some(a1)) = (angles(obs, start), angles(obs, hit)) {
                xhair.push(view_angle(a0, a1));
            }
        }
        aim.ttd_n = ttd.len() as u32;
        aim.ttd_ms = (!ttd.is_empty()).then(|| ttd.iter().sum::<f64>() / ttd.len() as f64);
        aim.crosshair_n = xhair.len() as u32;
        aim.crosshair_deg = median(xhair);
        // Time to kill: spotted -> kill, unless the kill took over 5 s from the first hit.
        let mut ttk = vec![];
        for k in &my_kills {
            if let Some((start, _)) = engagement_at(s, k.victim, k.tick) {
                let hurt = first_hit.get(&(s, k.victim, start)).copied().unwrap_or(k.tick);
                if k.tick - hurt <= TTK_HURT_MAX_TICKS {
                    ttk.push((k.tick - start) as f64 / TICKRATE * 1000.0);
                }
            }
        }
        aim.ttk_n = ttk.len() as u32;
        aim.ttk_ms = median(ttk);

        // Utility.
        let mut util = Utility { rounds: m.rounds.len() as u32, ..Default::default() };
        for sh in m.shots.iter().filter(|x| x.player == s) {
            match sh.weapon.trim_start_matches("weapon_") {
                "flashbang" => util.flashes += 1,
                "smokegrenade" => util.smokes += 1,
                "hegrenade" => util.hes += 1,
                "molotov" | "incgrenade" => util.molotovs += 1,
                "decoy" => util.decoys += 1,
                _ => {}
            }
        }
        util.flash_assists = m.kills.iter().filter(|k| k.flash_assist && k.assister == Some(s) && is_enemy_kill(m, k.attacker, k.victim)).count() as u32;
        for b in m.blinds.iter().filter(|b| b.attacker == s && b.victim != s && b.duration >= FLASH_MIN_S) {
            if enemies(s, b.victim) {
                util.enemies_flashed += 1;
                util.enemy_blind_time += b.duration as f64;
            } else if team(b.victim) == team(s) {
                util.friends_flashed += 1;
            }
        }
        for d in m.damages.iter().filter(|d| d.attacker == Some(s) && d.victim != s) {
            let w = d.weapon.trim_start_matches("weapon_");
            let dmg = d.health_removed.max(0) as u32;
            match (w, enemies(s, d.victim)) {
                ("hegrenade", true) => util.he_damage += dmg,
                ("hegrenade", false) => util.he_team_damage += dmg,
                ("inferno" | "molotov" | "incgrenade", true) => util.molotov_damage += dmg,
                _ => {}
            }
        }
        for k in m.kills.iter().filter(|k| k.victim == s) {
            util.deaths += 1;
            if let Some(Val::Strs(items)) = state.get(&(s, k.tick - 2)).and_then(|v| v.get("inventory")) {
                util.unused_value += items.iter().map(|i| grenade_value(i)).sum::<u32>();
            }
        }

        // Activity.
        let mut act = Activity { rounds: m.rounds.len() as u32, ..Default::default() };
        for d in m.damages.iter().filter(|d| d.attacker == Some(s) && enemies(s, d.victim)) {
            act.damage += d.health_removed.max(0) as u32;
        }
        act.he_damage = util.he_damage;
        act.molotov_damage = util.molotov_damage;
        act.enemies_flashed = util.enemies_flashed;
        act.shots = aim.shots;
        for r in m.reloads.iter().filter(|r| r.player == s) {
            // The gun being reloaded: the last one this player fired.
            let i = list.partition_point(|x| x.tick <= r.tick);
            let Some(w) = list[..i].last().map(|x| x.weapon.as_str()) else { continue };
            let (size, left) = (magazine(w), num(s, r.tick, "active_weapon_ammo"));
            if let (true, Some(left)) = (size > 0, left) {
                act.reloads += 1;
                act.wasted_bullets += (left.max(0.0) as u32).min(size);
                act.magazine_bullets += size;
            }
        }
        act.rounds_survived = (0..m.rounds.len()).filter(|r| !a.rounds[*r].died.contains(&s)).count() as u32;

        let mut dp = DPlayer { steamid: sid(s), aim, utility: util, activity: act, stats: Default::default() };
        dp.compute_stats();
        players.push(dp);
    }

    Ok(MatchDetails { version: VERSION, rounds, kills, clutches, players, grenades })
}

/// Where a match's details live.
pub fn path(root: &std::path::Path, id: &str) -> std::path::PathBuf {
    root.join("matches").join(format!("{id}.details.json"))
}

/// Whether a match's details are missing or from an older version.
pub fn stale(root: &std::path::Path, id: &str) -> bool {
    #[derive(Deserialize)]
    struct V {
        #[serde(default)]
        version: u32,
    }
    std::fs::read_to_string(path(root, id))
        .ok()
        .and_then(|t| serde_json::from_str::<V>(&t).ok())
        .is_none_or(|v| v.version < VERSION)
}

/// Builds and saves a match's details.
pub fn write(root: &std::path::Path, id: &str, demo: &[u8], m: &Match, a: &Analysis, me: u64) -> Result<()> {
    let d = build(demo, m, a, me)?;
    std::fs::write(path(root, id), serde_json::to_string(&d)?)?;
    Ok(())
}
