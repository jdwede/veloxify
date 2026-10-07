//! Normalized match data built from a demo's game events.
//!
//! Everything downstream (stats, highlights, UI) works off [`Match`], never raw parser output.

use crate::raw;
use anyhow::{bail, Result};
use parser::second_pass::game_events::{EventField, GameEvent};
use parser::second_pass::variants::Variant;
use serde::Serialize;
use std::collections::HashMap;

/// CS2 servers (Valve and FACEIT) run at 64 ticks per second.
pub const TICKRATE: f64 = 64.0;

const EVENTS: &[&str] = &[
    "begin_new_match",
    "round_freeze_end",
    "round_end",
    "player_death",
    "player_hurt",
    "player_blind",
    "bomb_planted",
    "bomb_defused",
    "bomb_exploded",
    "hegrenade_detonate",
    "flashbang_detonate",
    "smokegrenade_detonate",
    "inferno_startburn",
    "player_disconnect",
    "weapon_fire",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
pub enum Side {
    T,
    CT,
}

impl Side {
    fn from_team_num(n: i64) -> Option<Side> {
        match n {
            2 => Some(Side::T),
            3 => Some(Side::CT),
            _ => None,
        }
    }
    pub fn other(self) -> Side {
        match self {
            Side::T => Side::CT,
            Side::CT => Side::T,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum Source {
    Faceit,
    Valve,
    Unknown,
}

/// The two rosters. `A` is whichever team started the match on T.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
pub enum TeamId {
    A,
    B,
}

#[derive(Debug, Clone, Serialize)]
pub struct Player {
    pub steamid: u64,
    pub name: String,
    pub team: TeamId,
}

#[derive(Debug, Clone, Serialize)]
pub struct Round {
    /// 1-based round number within the real match (knife and warmup rounds excluded).
    pub number: u32,
    /// Tick at which freeze time ended (round goes live).
    pub live_tick: i32,
    pub end_tick: i32,
    pub winner: Side,
    pub reason: String,
    /// Which side team A played this round.
    pub team_a_side: Side,
}

impl Round {
    pub fn side_of(&self, team: TeamId) -> Side {
        match team {
            TeamId::A => self.team_a_side,
            TeamId::B => self.team_a_side.other(),
        }
    }
    pub fn winner_team(&self) -> TeamId {
        if self.winner == self.team_a_side {
            TeamId::A
        } else {
            TeamId::B
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Kill {
    pub tick: i32,
    /// Index into `Match::rounds`.
    pub round: usize,
    pub attacker: Option<u64>,
    pub victim: u64,
    pub assister: Option<u64>,
    pub flash_assist: bool,
    pub weapon: String,
    pub headshot: bool,
    /// Number of surfaces the bullet went through (wallbang when > 0).
    pub penetrated: i32,
    pub noscope: bool,
    pub through_smoke: bool,
    pub attacker_blind: bool,
    pub attacker_in_air: bool,
    pub distance: f32,
    pub attacker_equip_value: Option<u32>,
    pub victim_equip_value: Option<u32>,
    /// Where each stood (map units) and the callout CS2 shows for it ("BombsiteA", "Palace").
    pub attacker_xy: Option<[f32; 2]>,
    pub victim_xy: Option<[f32; 2]>,
    pub attacker_place: String,
    pub victim_place: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Damage {
    pub tick: i32,
    pub round: usize,
    pub attacker: Option<u64>,
    pub victim: u64,
    /// Health actually removed (capped at the victim's remaining health).
    pub health_removed: i32,
    pub weapon: String,
    /// "head", "chest", "stomach", "left_arm", ... ("generic" for utility/fall damage).
    #[serde(default)]
    pub hitgroup: String,
}

/// A weapon being fired: gun shots, and grenade throws (weapon names like `weapon_smokegrenade`).
#[derive(Debug, Clone, Serialize)]
pub struct Shot {
    pub tick: i32,
    pub round: usize,
    pub player: u64,
    pub weapon: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Blind {
    pub tick: i32,
    pub round: usize,
    pub attacker: u64,
    pub victim: u64,
    pub duration: f32,
}

#[derive(Debug, Clone, Serialize)]
pub struct BombEvent {
    pub tick: i32,
    pub round: usize,
    pub player: u64,
    pub defused: bool,
    /// The planter's or defuser's callout, e.g. "BombsiteA".
    pub place: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum GrenadeKind {
    He,
    Flash,
    Smoke,
    Molotov,
}

/// Where a grenade went off (a molotov: where it started burning).
#[derive(Debug, Clone, Serialize)]
pub struct Grenade {
    pub tick: i32,
    pub round: usize,
    pub player: u64,
    pub kind: GrenadeKind,
    pub xy: [f32; 2],
}

/// CS2's own end-of-match scoreboard row for a player (authoritative for MVPs, score, and the
/// counters whose exact rules Valve doesn't publish, like enemies flashed).
#[derive(Debug, Clone, Default, Serialize)]
pub struct ScoreboardRow {
    pub kills: i64,
    pub deaths: i64,
    pub assists: i64,
    pub damage: i64,
    pub utility_damage: i64,
    pub enemies_flashed: i64,
    pub mvps: i64,
    pub score: i64,
    /// Competitive rank shown on the scoreboard (Premier rating when `rank_type` is 11).
    pub rank: i64,
    pub rank_type: i64,
    pub rank_if_win: i64,
    pub rank_if_loss: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Match {
    pub map: String,
    pub server_name: String,
    pub source: Source,
    pub players: Vec<Player>,
    pub rounds: Vec<Round>,
    pub kills: Vec<Kill>,
    pub damages: Vec<Damage>,
    pub blinds: Vec<Blind>,
    pub bomb: Vec<BombEvent>,
    /// Ticks at which the bomb exploded.
    pub explosions: Vec<i32>,
    pub grenades: Vec<Grenade>,
    pub shots: Vec<Shot>,
    pub score_a: u32,
    pub score_b: u32,
    pub scoreboard: HashMap<u64, ScoreboardRow>,
}

impl Match {
    pub fn player(&self, steamid: u64) -> Option<&Player> {
        self.players.iter().find(|p| p.steamid == steamid)
    }
    pub fn team_of(&self, steamid: u64) -> Option<TeamId> {
        self.player(steamid).map(|p| p.team)
    }
    pub fn side_in_round(&self, steamid: u64, round: usize) -> Option<Side> {
        self.team_of(steamid).map(|t| self.rounds[round].side_of(t))
    }
    pub fn ticks_to_secs(ticks: i32) -> f64 {
        ticks as f64 / TICKRATE
    }
}

/// Parses a demo and builds the normalized match.
pub fn load_match(demo: &[u8]) -> Result<Match> {
    let out = raw::parse_events(demo, EVENTS)?;
    let header = out.header.clone().unwrap_or_default();
    let map = header.get("map_name").cloned().unwrap_or_default();
    let server_name = header.get("server_name").cloned().unwrap_or_default();
    let source = if server_name.to_ascii_lowercase().contains("faceit") {
        Source::Faceit
    } else if server_name.starts_with("Valve") {
        Source::Valve
    } else {
        Source::Unknown
    };

    let mut events: Vec<&GameEvent> = out.game_events.iter().collect();
    events.sort_by_key(|e| e.tick);

    // ---- Rounds -------------------------------------------------------------------------------
    // FACEIT plays a knife round and restarts the game; servers can also restore backups after a
    // tech pause. `total_rounds_played` after each round_end tells us where a round belongs, so a
    // value of k truncates the list to k-1 rounds before appending (restart => k == 1).
    struct RawRound {
        live_tick: i32,
        end_tick: i32,
        winner: Side,
        reason: String,
    }
    let mut rounds_raw: Vec<RawRound> = vec![];
    let mut last_freeze_end: Option<i32> = None;
    for e in &events {
        match e.name.as_str() {
            "round_freeze_end" => last_freeze_end = Some(e.tick),
            "round_end" => {
                if get_bool(e, "is_warmup_period") == Some(true) {
                    continue;
                }
                let winner = match get_str(e, "winner") {
                    Some("T") => Side::T,
                    Some("CT") => Side::CT,
                    _ => continue, // draws / no winner (e.g. game commencing)
                };
                let Some(live_tick) = last_freeze_end else { continue };
                let played = get_int(e, "total_rounds_played").unwrap_or(rounds_raw.len() as i64 + 1);
                let keep = (played.max(1) - 1) as usize;
                rounds_raw.truncate(keep.min(rounds_raw.len()));
                rounds_raw.push(RawRound {
                    live_tick,
                    end_tick: e.tick,
                    winner,
                    reason: get_str(e, "reason").unwrap_or("").to_string(),
                });
            }
            _ => {}
        }
    }
    if rounds_raw.is_empty() {
        bail!("no completed rounds found in demo");
    }
    // Round r spans [live_tick(r), end_tick(r) + post-round time) so exit frags stay in r. The cap
    // also drops events from rounds that were discarded by a backup restore.
    const POST_ROUND_TICKS: i32 = (8.0 * TICKRATE) as i32;
    let window_of = |tick: i32, rr: &[RawRound]| -> Option<usize> {
        let idx = rr.partition_point(|r| r.live_tick <= tick);
        let r = idx.checked_sub(1)?;
        (tick <= rr[r].end_tick + POST_ROUND_TICKS).then_some(r)
    };

    // ---- Sides per round ------------------------------------------------------------------------
    // Observe each player's team_num in each round from any event they appear in.
    let mut observed: Vec<HashMap<u64, Side>> = vec![HashMap::new(); rounds_raw.len()];
    for e in &events {
        if e.tick < rounds_raw[0].live_tick {
            continue;
        }
        let Some(r) = window_of(e.tick, &rounds_raw) else { continue };
        for prefix in ["user", "attacker"] {
            if let (Some(sid), Some(side)) = (
                get_steamid(e, &format!("{prefix}_steamid")),
                get_int(e, &format!("{prefix}_team_num")).and_then(Side::from_team_num),
            ) {
                observed[r].entry(sid).or_insert(side);
            }
        }
    }

    // Team A = players seen on T in the first round that has observations.
    let first_obs = observed.iter().find(|o| !o.is_empty()).cloned().unwrap_or_default();
    let mut team: HashMap<u64, TeamId> = first_obs
        .iter()
        .map(|(sid, side)| (*sid, if *side == Side::T { TeamId::A } else { TeamId::B }))
        .collect();
    let mut team_a_sides = Vec::with_capacity(rounds_raw.len());
    let mut prev_a_side = Side::T;
    for obs in &observed {
        // Majority vote among known players (team B votes count inverted).
        let (mut t, mut ct) = (0, 0);
        for (sid, side) in obs {
            if let Some(tm) = team.get(sid) {
                let a_side = if *tm == TeamId::A { *side } else { side.other() };
                if a_side == Side::T {
                    t += 1
                } else {
                    ct += 1
                }
            }
        }
        let a_side = if t == 0 && ct == 0 {
            prev_a_side
        } else if t >= ct {
            Side::T
        } else {
            Side::CT
        };
        // Late joiners: assign by the side they were seen on.
        for (sid, side) in obs {
            team.entry(*sid).or_insert(if *side == a_side { TeamId::A } else { TeamId::B });
        }
        team_a_sides.push(a_side);
        prev_a_side = a_side;
    }

    let rounds: Vec<Round> = rounds_raw
        .iter()
        .enumerate()
        .map(|(i, r)| Round {
            number: i as u32 + 1,
            live_tick: r.live_tick,
            end_tick: r.end_tick,
            winner: r.winner,
            reason: r.reason.clone(),
            team_a_side: team_a_sides[i],
        })
        .collect();

    // ---- Players --------------------------------------------------------------------------------
    let mut names: HashMap<u64, String> = HashMap::new();
    for md in out.player_md.iter().chain(out.roster.iter()) {
        if let (Some(sid), Some(name)) = (md.steamid, &md.name) {
            names.entry(sid).or_insert_with(|| name.clone());
        }
    }
    for e in &events {
        for prefix in ["user", "attacker"] {
            if let (Some(sid), Some(name)) =
                (get_steamid(e, &format!("{prefix}_steamid")), get_str(e, &format!("{prefix}_name")))
            {
                names.entry(sid).or_insert_with(|| name.to_string());
            }
        }
    }
    let mut players: Vec<Player> = team
        .iter()
        .map(|(sid, tm)| Player {
            steamid: *sid,
            name: names.get(sid).cloned().unwrap_or_else(|| sid.to_string()),
            team: *tm,
        })
        .collect();
    players.sort_by(|a, b| (a.team as u8, &a.name).cmp(&(b.team as u8, &b.name)));

    // ---- Combat events --------------------------------------------------------------------------
    let match_start = rounds[0].live_tick;
    let mut kills = vec![];
    let mut damages = vec![];
    let mut blinds = vec![];
    let mut bomb = vec![];
    let mut explosions = vec![];
    let mut grenades = vec![];
    let mut shots = vec![];
    // Health tracking so damage is capped at what the victim actually had.
    let mut health: HashMap<u64, i32> = HashMap::new();
    let mut health_round = usize::MAX;
    for e in &events {
        if e.tick < match_start {
            continue;
        }
        let Some(round) = window_of(e.tick, &rounds_raw) else { continue };
        if round != health_round {
            health.clear();
            health_round = round;
        }
        match e.name.as_str() {
            "player_death" => {
                let Some(victim) = get_steamid(e, "user_steamid") else { continue };
                kills.push(Kill {
                    tick: e.tick,
                    round,
                    attacker: get_steamid(e, "attacker_steamid"),
                    victim,
                    assister: get_steamid(e, "assister_steamid"),
                    flash_assist: get_bool(e, "assistedflash").unwrap_or(false),
                    weapon: get_str(e, "weapon").unwrap_or("").to_string(),
                    headshot: get_bool(e, "headshot").unwrap_or(false),
                    penetrated: get_int(e, "penetrated").unwrap_or(0) as i32,
                    noscope: get_bool(e, "noscope").unwrap_or(false),
                    through_smoke: get_bool(e, "thrusmoke").unwrap_or(false),
                    attacker_blind: get_bool(e, "attackerblind").unwrap_or(false),
                    attacker_in_air: get_bool(e, "attackerinair").unwrap_or(false),
                    distance: get_float(e, "distance").unwrap_or(0.0),
                    attacker_equip_value: get_int(e, "attacker_current_equip_value").map(|v| v as u32),
                    victim_equip_value: get_int(e, "user_current_equip_value").map(|v| v as u32),
                    attacker_xy: get_xy(e, "attacker"),
                    victim_xy: get_xy(e, "user"),
                    attacker_place: get_str(e, "attacker_last_place_name").unwrap_or("").to_string(),
                    victim_place: get_str(e, "user_last_place_name").unwrap_or("").to_string(),
                });
            }
            "player_hurt" => {
                let Some(victim) = get_steamid(e, "user_steamid") else { continue };
                let after = get_int(e, "health").unwrap_or(0) as i32;
                let before = *health.get(&victim).unwrap_or(&100);
                let dmg = get_int(e, "dmg_health").unwrap_or(0) as i32;
                let removed = (before - after).clamp(0, dmg.max(0));
                health.insert(victim, after);
                damages.push(Damage {
                    tick: e.tick,
                    round,
                    attacker: get_steamid(e, "attacker_steamid"),
                    victim,
                    health_removed: removed,
                    weapon: get_str(e, "weapon").unwrap_or("").to_string(),
                    hitgroup: get_str(e, "hitgroup").unwrap_or("").to_string(),
                });
            }
            "player_blind" => {
                if let (Some(attacker), Some(victim)) =
                    (get_steamid(e, "attacker_steamid"), get_steamid(e, "user_steamid"))
                {
                    blinds.push(Blind {
                        tick: e.tick,
                        round,
                        attacker,
                        victim,
                        duration: get_float(e, "blind_duration").unwrap_or(0.0),
                    });
                }
            }
            "weapon_fire" => {
                if let Some(player) = get_steamid(e, "user_steamid") {
                    shots.push(Shot { tick: e.tick, round, player, weapon: get_str(e, "weapon").unwrap_or("").to_string() });
                }
            }
            "bomb_planted" | "bomb_defused" => {
                if let Some(player) = get_steamid(e, "user_steamid") {
                    let place = get_str(e, "user_last_place_name").unwrap_or("").to_string();
                    bomb.push(BombEvent { tick: e.tick, round, player, defused: e.name == "bomb_defused", place });
                }
            }
            "bomb_exploded" => explosions.push(e.tick),
            "hegrenade_detonate" | "flashbang_detonate" | "smokegrenade_detonate" | "inferno_startburn" => {
                let kind = match e.name.as_str() {
                    "hegrenade_detonate" => GrenadeKind::He,
                    "flashbang_detonate" => GrenadeKind::Flash,
                    "smokegrenade_detonate" => GrenadeKind::Smoke,
                    _ => GrenadeKind::Molotov,
                };
                if let (Some(player), Some(x), Some(y)) = (get_steamid(e, "user_steamid"), get_float(e, "x"), get_float(e, "y")) {
                    grenades.push(Grenade { tick: e.tick, round, player, kind, xy: [x, y] });
                }
            }
            _ => {}
        }
    }

    let score_a = rounds.iter().filter(|r| r.winner_team() == TeamId::A).count() as u32;
    let score_b = rounds.len() as u32 - score_a;
    let end = rounds.last().map(|r| r.end_tick).unwrap_or(0);
    let sb = raw::player_props_at(demo, raw::SCOREBOARD_PROPS, &[end, end + 32, end + 64, end + 128])?;
    let scoreboard = sb
        .into_iter()
        .filter(|(sid, _)| team.contains_key(sid))
        .map(|(sid, v)| {
            let g = |k: &str| v.get(k).copied().unwrap_or(0);
            let row = ScoreboardRow {
                kills: g("kills_total"),
                deaths: g("deaths_total"),
                assists: g("assists_total"),
                damage: g("damage_total"),
                utility_damage: g("utility_damage_total"),
                enemies_flashed: g("enemies_flashed_total"),
                mvps: g("mvps"),
                score: g("score"),
                rank: g("rank"),
                rank_type: g("CCSPlayerController.m_iCompetitiveRankType"),
                rank_if_win: g("rank_if_win"),
                rank_if_loss: g("rank_if_loss"),
            };
            (sid, row)
        })
        .collect();

    Ok(Match { map, server_name, source, players, rounds, kills, damages, blinds, bomb, explosions, grenades, shots, score_a, score_b, scoreboard })
}

// ---- Event field helpers --------------------------------------------------------------------------

fn field<'a>(e: &'a GameEvent, name: &str) -> Option<&'a Variant> {
    e.fields.iter().find(|f: &&EventField| f.name == name).and_then(|f| f.data.as_ref())
}

fn get_str<'a>(e: &'a GameEvent, name: &str) -> Option<&'a str> {
    match field(e, name)? {
        Variant::String(s) => Some(s.as_str()),
        _ => None,
    }
}

fn get_bool(e: &GameEvent, name: &str) -> Option<bool> {
    match field(e, name)? {
        Variant::Bool(b) => Some(*b),
        _ => None,
    }
}

fn get_int(e: &GameEvent, name: &str) -> Option<i64> {
    match field(e, name)? {
        Variant::I32(v) => Some(*v as i64),
        Variant::U32(v) => Some(*v as i64),
        Variant::U64(v) => Some(*v as i64),
        Variant::Bool(b) => Some(*b as i64),
        _ => None,
    }
}

fn get_float(e: &GameEvent, name: &str) -> Option<f32> {
    match field(e, name)? {
        Variant::F32(v) => Some(*v),
        _ => None,
    }
}

/// `<prefix>_X`, `<prefix>_Y` (e.g. "attacker", "user").
fn get_xy(e: &GameEvent, prefix: &str) -> Option<[f32; 2]> {
    Some([get_float(e, &format!("{prefix}_X"))?, get_float(e, &format!("{prefix}_Y"))?])
}

fn get_steamid(e: &GameEvent, name: &str) -> Option<u64> {
    match field(e, name)? {
        Variant::String(s) => s.parse().ok().filter(|v| *v != 0),
        Variant::U64(v) => Some(*v).filter(|v| *v != 0),
        _ => None,
    }
}
