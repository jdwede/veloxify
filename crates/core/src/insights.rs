//! Match insights: every round of every match on a map, boiled down to what the Match Insights
//! and Playstyle pages ask questions of: where each player went (a path twice a second and the
//! callouts they passed through), what each team bought, the kills (with the duel's distance,
//! height and movement), damage, grenades, jumps and the bomb.
//!
//! Built from the saved details and 2D replay of each match (no demo needed) into
//! `matches/<id>.insight.json`, then gathered per map into `insights/<map>.json`. Only replays
//! with heights and callouts (details version 12 on) are used; older matches join once the
//! background re-read has rebuilt them.

use crate::details::{self, MatchDetails, Replay};
use crate::library::{Index, MatchEntry};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::path::Path;

/// Bumped whenever what's in an insight file changes, so they're rebuilt (from the saved files).
pub const VERSION: u32 = 6;

/// Paths keep a point every this many replay frames (8 a second): twice a second.
const PATH_EVERY: usize = 4;
/// Coordinates in paths are stored divided by this (units).
pub const PATH_UNIT: i32 = 4;
/// The place grid's cell size (units).
const CELL: i32 = 48;
/// A map's file keeps its newest this many matches (about 240 KB each), so the pages stay quick.
const MAX_MATCHES_PER_MAP: usize = 150;

/// One match's rounds, in the shape the pages read.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MatchInsight {
    pub version: u32,
    pub id: String,
    pub map: String,
    pub ts: i64,
    pub source: String,
    /// Index of the library owner in `players` (-1 if they weren't in it).
    pub me: i32,
    pub players: Vec<IPlayer>,
    pub places: Vec<String>,
    pub weapons: Vec<String>,
    pub rounds: Vec<IRound>,
    /// Labelled positions for the map's place grid: `[x, y, place]` (a sample of them).
    #[serde(default)]
    pub labels: Vec<[i32; 3]>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct IPlayer {
    pub sid: String,
    pub name: String,
    /// On the library owner's team.
    pub mine: bool,
    /// In the owner's party (FACEIT party, or played with often).
    #[serde(default)]
    pub party: bool,
}

/// Times are tenths of a second since the round went live.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct IRound {
    pub n: u32,
    /// Each player's side, `T` or `C`, in `players` order (`-` = not in the round).
    pub sides: String,
    /// Each player's equipment value once the round is live.
    pub equip: Vec<i32>,
    /// Round type of the T and the CT side: pistol, eco, force or full.
    pub kind: [String; 2],
    /// `T` or `C`.
    pub win: String,
    /// elim, bomb, defuse or time.
    pub why: String,
    /// Length of the round, live to end.
    pub end: i32,
    /// `[time, planter, site (0 = A, 1 = B), x, y]`.
    pub plant: Option<[i32; 5]>,
    pub defuse: Option<i32>,
    /// Each player's path: `x, y` pairs (divided by [`PATH_UNIT`]) twice a second from the start
    /// until they die.
    pub paths: Vec<Vec<i32>>,
    /// Each player's callouts as `place, time entered` pairs.
    pub areas: Vec<Vec<i32>>,
    /// When each player died (-1 = survived).
    pub death: Vec<i32>,
    /// `[time, attacker, victim, weapon, flags, ax, ay, vx, vy, height, distance, attacker
    /// speed, victim speed, victim's weapon]`; flags: 1 headshot, 2 opening kill, 4 a trade,
    /// 8 wallbang, 16 through smoke, 32 attacker in the air, 64 attacker blind, 128 no-scope;
    /// height is the attacker's above the victim's. Then the fight, which started with the first
    /// hit between the two (in the 3 s before the kill; the kill itself when it was the only one):
    /// 14, 15 how far (units) the attacker and the victim got from where they were in the half
    /// second before it (who peeked); 16, 17 how long (tenths) each was flashed from 1 s before it; 18, 19 their health
    /// as it started; 20, 21 utility on each before it ([`UTIL_MOLLY`] ...); 22 who hit first (0
    /// the attacker, 1 the victim); 23 how far (degrees) the victim's aim was from the attacker as
    /// it started, at best (over 60: caught off guard). Version 2 files have the first
    /// 14 only.
    pub kills: Vec<Vec<i32>>,
    /// `[time, attacker, victim, damage, weapon]` (-1 attacker = the world).
    pub hurts: Vec<[i32; 5]>,
    /// `[time, thrower, kind, from x, from y, to x, to y, tick]`; kind 0 smoke, 1 molotov,
    /// 2 flash, 3 HE, 4 decoy.
    pub nades: Vec<[i32; 8]>,
    /// `[time, player, x, y]`.
    pub jumps: Vec<[i32; 4]>,
    /// The first T into each bombsite: `[site (0 = A, 1 = B), entrant, time, killer (-1 = none
    /// within 3 s), checked, present]`; checked and present are bit masks of players (by index):
    /// the defenders within 1,800 units when they came in, and the ones they aimed at (within 18
    /// degrees) in their first 2 seconds there.
    #[serde(default)]
    pub entries: Vec<[i32; 6]>,
    /// Each player's main gun this round (index into `weapons`, -1 = none): the one they held most,
    /// a pistol only when they had nothing else.
    #[serde(default)]
    pub prim: Vec<i32>,
}

/// Utility on a player before a fight: an enemy molotov landed by them (within 7 s before).
pub const UTIL_MOLLY: i32 = 1;
/// They took HE or fire damage from an enemy (within 4 s before).
pub const UTIL_NADE_DAMAGE: i32 = 2;
/// Flashed by an enemy (half a second or more, from 1 s before the fight).
pub const UTIL_FLASHED: i32 = 4;
/// Flashed by a teammate.
pub const UTIL_TEAM_FLASHED: i32 = 8;

/// Who started a fight (a kill row): 1 the attacker peeked (moved into a still victim), 2 the
/// victim peeked, 3 both were moving, 0 both were still; -1 unknown (an older file). Moving is
/// getting [`PEEK_MOVED`] units or more from where they were in the half second before the first
/// hit.
pub fn peek_of(k: &[i32]) -> i32 {
    if k.len() < FIGHT_LEN {
        return -1;
    }
    match (k[14] >= PEEK_MOVED, k[15] >= PEEK_MOVED) {
        (true, false) => 1,
        (false, true) => 2,
        (true, true) => 3,
        (false, false) => 0,
    }
}

/// A kill row's length with the fight.
pub const FIGHT_LEN: usize = 24;
/// Got this far (units) from where they were in the half second before a fight's first hit:
/// peeking, not holding still (a rifle swing covers about 100 units in that time).
pub const PEEK_MOVED: i32 = 45;

/// The victim was looking elsewhere (their aim more than 60 degrees from the attacker) as the fight
/// started: caught off guard, not a duel lost.
pub fn caught_off_guard(k: &[i32]) -> bool {
    k.len() >= FIGHT_LEN && k[23] > 60
}

/// Everything for one map: the pages load this.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MapInsights {
    pub version: u32,
    pub map: String,
    pub path_unit: i32,
    pub places: Vec<String>,
    pub weapons: Vec<String>,
    pub matches: Vec<IMatch>,
    pub rounds: Vec<MapRound>,
    /// Which callout each spot on the map belongs to.
    pub grid: PlaceGrid,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct IMatch {
    pub id: String,
    pub ts: i64,
    pub source: String,
    pub me: i32,
    pub players: Vec<IPlayer>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MapRound {
    /// Index into `matches`.
    pub m: usize,
    #[serde(flatten)]
    pub round: IRound,
}

/// Callout per grid cell (`-1` = none), rows from `y0` up, cells `cell` units wide.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PlaceGrid {
    pub cell: i32,
    pub x0: i32,
    pub y0: i32,
    pub w: i32,
    pub h: i32,
    pub data: Vec<i16>,
}

fn path(root: &Path, id: &str) -> std::path::PathBuf {
    root.join("matches").join(format!("{id}.insight.json"))
}

/// Pistol, eco, force or full, from a side's average equipment value. Pistol rounds are each
/// half's first (not overtime's, which start with money).
fn round_kind(pistol: bool, avg: f64) -> String {
    if pistol {
        "pistol"
    } else if avg < 1600.0 {
        "eco"
    } else if avg < 3900.0 {
        "force"
    } else {
        "full"
    }
    .into()
}

fn site_of(place: &str) -> Option<i32> {
    match place {
        p if p.ends_with('A') && p.contains("Bombsite") => Some(0),
        p if p.ends_with('B') && p.contains("Bombsite") => Some(1),
        _ => None,
    }
}

const NADE_KINDS: &[&str] = &["smoke", "molotov", "flash", "he", "decoy"];

/// Builds one match's insight from its saved files. None when the replay has no heights or
/// callouts yet (older than details version 12).
pub fn build(entry: &MatchEntry, d: &MatchDetails, r: &Replay, me: &str) -> Option<MatchInsight> {
    if r.stride < 7 || r.rounds.is_empty() {
        return None;
    }
    let st = r.stride;
    let np = r.players.len();
    let idx: HashMap<&str, i32> = r.players.iter().enumerate().map(|(i, s)| (s.as_str(), i as i32)).collect();
    let pi = |s: &str| idx.get(s).copied().unwrap_or(-1);
    let rows: HashMap<&str, &crate::library::PlayerRow> = entry.players.iter().map(|p| (p.steamid.as_str(), p)).collect();
    let players: Vec<IPlayer> = r
        .players
        .iter()
        .map(|s| {
            let row = rows.get(s.as_str());
            IPlayer {
                sid: s.clone(),
                name: row.map(|p| p.name.clone()).unwrap_or_default(),
                mine: row.is_some_and(|p| p.side == "mine"),
                party: row.is_some_and(|p| p.party) || s == me,
            }
        })
        .collect();
    let tick_rate = 64.0;
    let mut weapons = r.weapons.clone();
    let mut rounds = vec![];
    let mut labels = vec![];
    let mut prev_sides = String::new();
    for rr in &r.rounds {
        let Some(dr) = d.rounds.iter().find(|x| x.number == rr.number) else { continue };
        // Frames are every `step` ticks from `start`; the round went live at `live_tick`.
        let live_off = ((dr.live_tick - rr.start) as f64 / r.step as f64).round().max(0.0) as usize;
        let end_frame = live_off + ((dr.end_tick - dr.live_tick).max(0) as f64 / r.step as f64) as usize;
        let frames = &rr.frames[live_off.min(rr.frames.len())..(end_frame + 1).min(rr.frames.len())];
        let tenth = |frame: usize| ((frame * r.step as usize) as f64 / tick_rate * 10.0).round() as i32;
        let side_of = |p: usize| -> char {
            match dr.players.iter().find(|x| x.steamid == r.players[p]).map(|x| x.side.as_str()) {
                Some("T") => 'T',
                Some("CT") => 'C',
                _ => '-',
            }
        };
        let sides: String = (0..np).map(side_of).collect();
        // A half's first round: most players switched sides since the last one.
        let switched = prev_sides.len() == sides.len()
            && prev_sides.bytes().zip(sides.bytes()).filter(|&(a, b)| a != b'-' && b != b'-' && a != b).count() >= 3;
        let pistol = rr.number == 1 || (switched && rr.number <= 16);
        prev_sides = sides.clone();
        let equip: Vec<i32> = if rr.equip.len() == np { rr.equip.clone() } else { vec![0; np] };
        let avg = |side: char| {
            let v: Vec<i32> = (0..np).filter(|&p| sides.as_bytes()[p] as char == side).map(|p| equip[p]).collect();
            if v.is_empty() {
                0.0
            } else {
                v.iter().sum::<i32>() as f64 / v.len() as f64
            }
        };
        let kind = [round_kind(pistol, avg('T')), round_kind(pistol, avg('C'))];

        let at = |f: usize, p: usize, k: usize| frames.get(f).and_then(|fr| fr.get(p * st + k)).copied().unwrap_or(0);
        let alive = |f: usize, p: usize| at(f, p, 3) > 0;
        let mut paths = vec![vec![]; np];
        let mut areas = vec![vec![]; np];
        let mut death = vec![-1; np];
        let mut jumps = vec![];
        for p in 0..np {
            let mut last_place = -2;
            let mut was_alive = false;
            for f in 0..frames.len() {
                if !alive(f, p) {
                    if was_alive && death[p] < 0 {
                        death[p] = tenth(f);
                    }
                    if was_alive {
                        break;
                    }
                    continue;
                }
                let (x, y) = (at(f, p, 0), at(f, p, 1));
                if !was_alive {
                    // Paths are read by time from the round's start: someone who shows up late
                    // (joined mid-round) stands where they appear until then.
                    for _ in 0..f.div_ceil(PATH_EVERY) {
                        paths[p].push((x as f64 / PATH_UNIT as f64).round() as i32);
                        paths[p].push((y as f64 / PATH_UNIT as f64).round() as i32);
                    }
                }
                was_alive = true;
                if f % PATH_EVERY == 0 {
                    paths[p].push((x as f64 / PATH_UNIT as f64).round() as i32);
                    paths[p].push((y as f64 / PATH_UNIT as f64).round() as i32);
                }
                let place = at(f, p, 6);
                if place != last_place {
                    areas[p].push(place);
                    areas[p].push(tenth(f));
                    last_place = place;
                }
                if f % 32 == 0 && place >= 0 {
                    labels.push([x, y, place]);
                }
                // A jump: the highest point of a rise and fall within about half a second
                // either way (stairs and ramps rise or fall steadily instead).
                if f >= 3 && f + 3 < frames.len() && alive(f + 3, p) && alive(f - 3, p) {
                    let z = at(f, p, 5);
                    let around = (at(f - 3, p, 5) + at(f + 3, p, 5)) / 2;
                    let peak = (f - 2..=f + 2).all(|g| at(g, p, 5) <= z) && at(f - 1, p, 5) < z;
                    if peak && z - around > 24 {
                        jumps.push([tenth(f), p as i32, x, y]);
                    }
                }
            }
        }
        // Speed (units a second) over the quarter second before a frame.
        let speed = |f: usize, p: usize| -> i32 {
            if f < 2 {
                return 0;
            }
            let (x0, y0, x1, y1) = (at(f - 2, p, 0), at(f - 2, p, 1), at(f, p, 0), at(f, p, 1));
            (((x1 - x0) as f64).hypot((y1 - y0) as f64) * tick_rate / (2.0 * r.step as f64)).round() as i32
        };
        let frame_of = |t: f32| ((t as f64 * tick_rate / r.step as f64).round().max(0.0) as usize).min(frames.len().saturating_sub(1));
        let live_ticks = dr.live_tick - rr.start;
        let hurts: Vec<[i32; 5]> = rr
            .hurts
            .iter()
            .map(|h| [(((h[0] - live_ticks) as f64 / tick_rate) * 10.0).round() as i32, h[1], h[2], h[3], h[4]])
            .filter(|h| h[0] >= 0)
            .collect();
        // For the fights: flashes, molotovs and grenade damage this round.
        let blinds: Vec<(i32, i32, i32, f32)> = d
            .blinds
            .iter()
            .filter(|b| b.round == rr.number)
            .map(|b| (pi(&b.player), pi(&b.by), (b.t * 10.0).round() as i32, b.secs))
            .collect();
        let mollies: Vec<(i32, i32, i32, i32)> = d
            .grenades
            .iter()
            .filter(|g| g.round == rr.number && g.kind == "molotov")
            .map(|g| ((g.t * 10.0).round() as i32, pi(&g.player), g.xy[0] as i32, g.xy[1] as i32))
            .collect();
        let nade_weapon = |w: i32| usize::try_from(w).ok().and_then(|i| r.weapons.get(i)).is_some_and(|n| matches!(n.as_str(), "hegrenade" | "inferno" | "molotov" | "incgrenade"));
        let enemies = |p: usize, q: i32| {
            let b = sides.as_bytes();
            usize::try_from(q).ok().and_then(|q| b.get(q)).is_some_and(|&s| s != b'-' && b[p] != b'-' && s != b[p])
        };
        let util = |p: usize, t0: i32, kt: i32| -> i32 {
            let mut bits = 0;
            for &(t, by, x, y) in &mollies {
                if t >= t0 - 70 && t <= kt && enemies(p, by) {
                    let fg = frame_of(t as f32 / 10.0);
                    if alive(fg, p) && ((at(fg, p, 0) - x) as f64).hypot((at(fg, p, 1) - y) as f64) < 260.0 {
                        bits |= UTIL_MOLLY;
                    }
                }
            }
            if hurts.iter().any(|h| h[2] == p as i32 && h[0] >= t0 - 40 && h[0] <= kt && enemies(p, h[1]) && nade_weapon(h[4])) {
                bits |= UTIL_NADE_DAMAGE;
            }
            for &(who, by, t, secs) in &blinds {
                let end = t + (secs * 10.0).round() as i32;
                if who == p as i32 && secs >= 0.5 && t <= kt && end >= t0 - 10 && by != who {
                    bits |= if enemies(p, by) { UTIL_FLASHED } else { UTIL_TEAM_FLASHED };
                }
            }
            bits
        };
        // How far (degrees) p's aim is from q.
        let off = |fr: usize, p: usize, q: usize| -> i32 {
            let (x, y, tx, ty) = (at(fr, p, 0), at(fr, p, 1), at(fr, q, 0), at(fr, q, 1));
            let want = ((ty - y) as f64).atan2((tx - x) as f64).to_degrees();
            ((want - at(fr, p, 2) as f64 + 540.0).rem_euclid(360.0) - 180.0).abs().round() as i32
        };
        let mut kills = vec![];
        for k in d.kills.iter().filter(|k| k.round == rr.number && !k.team_kill) {
            let row = (|| {
                let v = pi(&k.victim);
                if v < 0 {
                    return None;
                }
                let a = pi(&k.attacker);
                let f = frame_of(k.t);
                let (vx, vy) = k.victim_xy.map(|p| (p[0] as i32, p[1] as i32)).unwrap_or((at(f.saturating_sub(1), v as usize, 0), at(f.saturating_sub(1), v as usize, 1)));
                let (ax, ay) = k.attacker_xy.map(|p| (p[0] as i32, p[1] as i32)).unwrap_or((0, 0));
                let (height, dist, aspd) = if a >= 0 {
                    let fa = f.min(frames.len().saturating_sub(1));
                    let dz = at(fa, a as usize, 5) - at(f.saturating_sub(1), v as usize, 5);
                    (dz, ((ax - vx) as f64).hypot((ay - vy) as f64).round() as i32, speed(fa, a as usize))
                } else {
                    (0, 0, 0)
                };
                let flags = k.headshot as i32
                    | (k.opening as i32) << 1
                    | (k.trade as i32) << 2
                    | (k.wallbang as i32) << 3
                    | (k.smoke as i32) << 4
                    | (k.blind as i32) << 6
                    | (k.noscope as i32) << 7;
                let base = [(k.t * 10.0).round() as i32, a, v, -1, flags, ax, ay, vx, vy, height, dist, aspd, speed(f.saturating_sub(1), v as usize), at(f.saturating_sub(1), v as usize, 4)];
                // The fight: from the first hit between the two (in the 3 s before the kill).
                let mut fight = [0, 0, 0, 0, 0, 0, 0, 0, -1, 180];
                if a >= 0 {
                    let (au, vu) = (a as usize, v as usize);
                    let kt = base[0];
                    let first = hurts
                        .iter()
                        .filter(|h| h[0] >= kt - 30 && h[0] <= kt && ((h[1] == a && h[2] == v) || (h[1] == v && h[2] == a)) && !nade_weapon(h[4]))
                        .min_by_key(|h| h[0]);
                    let t0 = first.map_or(kt, |h| h[0]);
                    let f0 = frame_of(t0 as f32 / 10.0);
                    // How far each got from where they were, from 0.625 to 0.125 s before it (a
                    // swing out of cover, not strafing back and forth while holding).
                    let moved = |p: usize| -> i32 {
                        let to = f0.saturating_sub(1);
                        let Some(from) = (f0.saturating_sub(5)..=to).find(|&g| alive(g, p)) else { return 0 };
                        if !alive(to, p) {
                            return 0;
                        }
                        ((at(to, p, 0) - at(from, p, 0)) as f64).hypot((at(to, p, 1) - at(from, p, 1)) as f64).round() as i32
                    };
                    let blind = |p: i32| blinds.iter().filter(|b| b.0 == p).map(|&(_, _, t, secs)| ((t + (secs * 10.0).round() as i32).min(kt) - t.max(t0 - 10)).max(0)).max().unwrap_or(0);
                    fight[0] = moved(au);
                    fight[1] = moved(vu);
                    fight[2] = blind(a);
                    fight[3] = blind(v);
                    fight[4] = at(f0.saturating_sub(1), au, 3);
                    fight[5] = at(f0.saturating_sub(1), vu, 3);
                    fight[6] = util(au, t0, kt);
                    fight[7] = util(vu, t0, kt);
                    fight[8] = first.map_or(0, |h| if h[1] == a { 0 } else { 1 });
                    // Where the victim was looking as it started (from half a second before to a
                    // quarter second after; the closest they got to looking at the attacker).
                    fight[9] = (f0.saturating_sub(4)..=(f0 + 2).min(f.saturating_sub(1)).max(f0.saturating_sub(4)))
                        .filter(|&g| alive(g, vu))
                        .map(|g| off(g, vu, au))
                        .min()
                        .unwrap_or(180);
                }
                Some([&base[..], &fight[..]].concat())
            })();
            if let Some(mut row) = row {
                let name = weapon_file(&k.weapon);
                row[3] = match weapons.iter().position(|x| *x == name) {
                    Some(i) => i as i32,
                    None => {
                        weapons.push(name);
                        weapons.len() as i32 - 1
                    }
                };
                kills.push(row);
            }
        }
        let nades = d
            .throws
            .iter()
            .filter(|t| t.round == rr.number)
            .filter_map(|t| {
                let p = pi(&t.player);
                let kind = NADE_KINDS.iter().position(|k| *k == t.kind)? as i32;
                Some([(t.t * 10.0).round() as i32, p, kind, t.from[0] as i32, t.from[1] as i32, t.to[0] as i32, t.to[1] as i32, t.tick])
            })
            .collect();
        let plant = dr.plant.as_ref().and_then(|(t, place, planter)| {
            let p = pi(planter);
            let site = site_of(place).unwrap_or(-1);
            if p < 0 {
                return None;
            }
            let f = frame_of(*t);
            Some([(t * 10.0).round() as i32, p, site, at(f, p as usize, 0), at(f, p as usize, 1)])
        });
        let why = if dr.defused {
            "defuse"
        } else if dr.exploded {
            "bomb"
        } else if dr.reason.to_lowercase().contains("time") || dr.reason.to_lowercase().contains("saved") {
            "time"
        } else {
            "elim"
        };
        // The first T into each site: who they looked at coming in, and who killed them.
        let mut entries = vec![];
        for (site, name) in [(0, "BombsiteA"), (1, "BombsiteB")] {
            let Some(site_pl) = r.places.iter().position(|p| p == name).map(|i| i as i32) else { continue };
            let mut first: Option<(usize, usize)> = None; // (frame, player)
            for p in (0..np).filter(|&p| sides.as_bytes()[p] == b'T') {
                if let Some(f) = (0..frames.len()).find(|&f| alive(f, p) && at(f, p, 6) == site_pl) {
                    if first.is_none_or(|(g, _)| f < g) {
                        first = Some((f, p));
                    }
                }
            }
            let Some((fe, e)) = first else { continue };
            if fe < 8 {
                continue; // spawned there
            }
            let (ex, ey) = (at(fe, e, 0), at(fe, e, 1));
            let (mut present, mut checked) = (0i32, 0i32);
            for c in (0..np).filter(|&c| sides.as_bytes()[c] == b'C' && alive(fe, c)) {
                let (cx, cy) = (at(fe, c, 0), at(fe, c, 1));
                if ((cx - ex) as f64).hypot((cy - ey) as f64) > 1800.0 {
                    continue;
                }
                present |= 1 << c;
                let looked = (fe..(fe + 16).min(frames.len())).take_while(|&f| alive(f, e)).any(|f| {
                    let (x, y) = (at(f, e, 0), at(f, e, 1));
                    let (tx, ty) = (at(f, c, 0), at(f, c, 1));
                    let want = ((ty - y) as f64).atan2((tx - x) as f64).to_degrees();
                    let diff = (want - at(f, e, 2) as f64 + 540.0).rem_euclid(360.0) - 180.0;
                    diff.abs() < 18.0
                });
                if looked {
                    checked |= 1 << c;
                }
            }
            let t_entry = tenth(fe);
            let killer = kills.iter().find(|k| k[2] == e as i32 && k[0] >= t_entry - 5 && k[0] <= t_entry + 30).map_or(-1, |k| k[1]);
            entries.push([site, e as i32, t_entry, killer, checked, present]);
        }
        // Each player's main gun: the one held most, a pistol only when they had nothing else.
        let gun_class = |w: i32| usize::try_from(w).ok().and_then(|i| r.weapons.get(i)).map_or("other", |n| weapon_class(n));
        let prim: Vec<i32> = (0..np)
            .map(|p| {
                let mut held: HashMap<i32, u32> = HashMap::new();
                for f in (0..frames.len()).filter(|&f| alive(f, p)) {
                    let w = at(f, p, 4);
                    if gun_class(w) != "other" {
                        *held.entry(w).or_default() += 1;
                    }
                }
                let best = |pistol: bool| held.iter().filter(|(&w, &n)| (gun_class(w) == "pistol") == pistol && n >= 8).max_by_key(|(&w, &n)| (n, -w)).map(|(&w, _)| w);
                best(false).or_else(|| best(true)).unwrap_or(-1)
            })
            .collect();
        // When the bomb was defused: the round ends then.
        let defuse = dr.defused.then(|| (((dr.end_tick - dr.live_tick) as f64 / tick_rate) * 10.0).round() as i32);
        rounds.push(IRound {
            n: rr.number,
            sides,
            equip,
            kind,
            win: if dr.winner_side == "T" { "T".into() } else { "C".into() },
            why: why.into(),
            end: (((dr.end_tick - dr.live_tick) as f64 / tick_rate) * 10.0).round() as i32,
            plant,
            defuse,
            paths,
            areas,
            death,
            kills,
            hurts,
            nades,
            jumps,
            entries,
            prim,
        });
    }
    Some(MatchInsight {
        version: VERSION,
        id: entry.id.clone(),
        map: entry.map.clone(),
        ts: entry.played_ts,
        source: entry.source.clone(),
        me: pi(me),
        players,
        places: r.places.clone(),
        weapons,
        rounds,
        labels,
    })
}

/// The replay's weapon file name for a kill's weapon ("ak47", "awp", ...).
fn weapon_file(w: &str) -> String {
    w.trim_start_matches("weapon_").to_lowercase()
}

/// Brings every match's insight up to date (from its details and replay) and rebuilds the per-map
/// files when any changed. `budget` caps the time spent (the rest waits for the next call).
/// Returns how many matches were (re)built.
pub fn update(root: &Path, budget: std::time::Duration) -> Result<usize> {
    let started = std::time::Instant::now();
    let index: Index = serde_json::from_str(&std::fs::read_to_string(root.join("index.json"))?)?;
    let mut built = 0;
    for m in &index.matches {
        if started.elapsed() > budget {
            break;
        }
        if current(root, &m.id) || details::stale(root, &m.id) {
            continue;
        }
        let entry: Option<MatchEntry> = std::fs::read_to_string(root.join("matches").join(format!("{}.json", m.id))).ok().and_then(|t| serde_json::from_str(&t).ok());
        let (Some(entry), Some(d), Some(r)) = (entry, details::load(root, &m.id), details::load_replay(root, &m.id)) else { continue };
        if let Some(ins) = build(&entry, &d, &r, &index.me) {
            let tmp = path(root, &m.id).with_extension("json.tmp");
            std::fs::write(&tmp, serde_json::to_string(&ins)?)?;
            std::fs::rename(tmp, path(root, &m.id))?;
            built += 1;
        }
    }
    let maps_missing = !root.join("insights").join("index.json").exists() || !root.join("insights").join("me.json").exists();
    if built > 0 || maps_missing {
        write_maps(root, &index)?;
    }
    Ok(built)
}

fn current(root: &Path, id: &str) -> bool {
    details::leading_version(&path(root, id)).is_some_and(|v| v >= VERSION)
}

/// The oldest insight file the pages can still show (until the background re-read rebuilds it).
const USABLE_VERSION: u32 = 2;

/// What the pages list: each map's matches and rounds (and how many matches wait for the
/// background re-read).
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct InsightsIndex {
    pub version: u32,
    pub maps: BTreeMap<String, MapCount>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct MapCount {
    pub matches: usize,
    pub rounds: usize,
    /// Matches on this map not in it yet (their replay is from before heights and callouts), or
    /// in it from an older read until the background re-read rebuilds them.
    pub waiting: usize,
}

/// The library owner's duels in one match (`insights/me.json`), for sessions and trends: won and
/// lost (`[won, lost]`) by their weapon, openings, afterplants, retakes, while moving, clutches.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MyDuels {
    pub ts: i64,
    pub rounds: u32,
    /// By weapon class: rifle, awp, scout, pistol, smg, heavy, other.
    pub by_weapon: BTreeMap<String, [u32; 2]>,
    pub opening: [u32; 2],
    /// Rounds lost after losing the opening duel / won after winning it.
    pub opening_lost_round_lost: u32,
    pub opening_won_round_won: u32,
    pub afterplant: [u32; 2],
    pub retake: [u32; 2],
    /// Shooting while running (over 130 units a second).
    pub moving: [u32; 2],
    pub long_range: [u32; 2],
    pub close_range: [u32; 2],
    /// Last one alive: `[won, attempts]`.
    pub clutch: [u32; 2],
    pub awp_kills: u32,
    pub awp_opening_kills: u32,
    pub multikill_rounds: u32,
    /// Fights you started by moving into a still enemy, and ones they started moving into you.
    #[serde(default)]
    pub peeked: [u32; 2],
    #[serde(default)]
    pub held: [u32; 2],
    /// Deaths to someone you never had on screen.
    #[serde(default)]
    pub caught: u32,
    /// Fights you were in flashed by an enemy.
    #[serde(default)]
    pub flashed: [u32; 2],
}

pub fn weapon_class(w: &str) -> &'static str {
    match w {
        "ak47" | "m4a1" | "m4a1_silencer" | "famas" | "galilar" | "aug" | "sg556" => "rifle",
        "awp" => "awp",
        "ssg08" | "g3sg1" | "scar20" => "scout",
        "glock" | "usp_silencer" | "hkp2000" | "p250" | "fiveseven" | "tec9" | "cz75a" | "deagle" | "elite" | "revolver" => "pistol",
        "mp9" | "mac10" | "mp7" | "mp5sd" | "ump45" | "p90" | "bizon" => "smg",
        "nova" | "xm1014" | "sawedoff" | "mag7" | "m249" | "negev" => "heavy",
        _ => "other",
    }
}

fn my_duels(ins: &MatchInsight) -> Option<MyDuels> {
    let me = usize::try_from(ins.me).ok()?;
    let mut d = MyDuels { ts: ins.ts, rounds: ins.rounds.len() as u32, ..Default::default() };
    let weapon = |i: i32| usize::try_from(i).ok().and_then(|i| ins.weapons.get(i)).map_or("other", |w| weapon_class(w));
    for r in &ins.rounds {
        let sides = r.sides.as_bytes();
        let Some(&mine) = sides.get(me) else { continue };
        let my_kills = r.kills.iter().filter(|k| k[1] == me as i32).count();
        if my_kills >= 2 {
            d.multikill_rounds += 1;
        }
        for k in &r.kills {
            let (a, v) = (k[1], k[2]);
            let won = a == me as i32 && v >= 0 && sides.get(v as usize).is_some_and(|&s| s != mine);
            let lost = v == me as i32 && a >= 0 && sides.get(a as usize).is_some_and(|&s| s != mine);
            if !won && !lost {
                continue;
            }
            let i = if won { 0 } else { 1 };
            if caught_off_guard(k) {
                d.caught += lost as u32;
            } else {
                let peek = peek_of(k);
                if peek == if won { 1 } else { 2 } {
                    d.peeked[i] += 1;
                } else if peek == if won { 2 } else { 1 } {
                    d.held[i] += 1;
                }
            }
            if k.len() >= FIGHT_LEN && (if won { k[20] } else { k[21] }) & UTIL_FLASHED != 0 {
                d.flashed[i] += 1;
            }
            d.by_weapon.entry(weapon(if won { k[3] } else { k[13] }).to_string()).or_default()[i] += 1;
            if k[4] & 2 != 0 {
                d.opening[i] += 1;
                let round_won = r.win.as_bytes().first() == Some(&mine);
                if won && round_won {
                    d.opening_won_round_won += 1;
                }
                if lost && !round_won {
                    d.opening_lost_round_lost += 1;
                }
                if won && weapon(k[3]) == "awp" {
                    d.awp_opening_kills += 1;
                }
            }
            if won && weapon(k[3]) == "awp" {
                d.awp_kills += 1;
            }
            if let Some(p) = r.plant {
                if k[0] > p[0] {
                    if mine == b'T' {
                        d.afterplant[i] += 1;
                    } else {
                        d.retake[i] += 1;
                    }
                }
            }
            if (if won { k[11] } else { k[12] }) > 130 {
                d.moving[i] += 1;
            }
            if k[10] >= 1500 {
                d.long_range[i] += 1;
            } else if k[10] > 0 && k[10] < 600 {
                d.close_range[i] += 1;
            }
        }
        // A clutch: everyone else on the team died while the owner was alive.
        let death = |p: usize| if r.death[p] >= 0 { r.death[p] } else { i32::MAX };
        let mates: Vec<usize> = (0..sides.len()).filter(|&p| p != me && sides[p] == mine).collect();
        if !mates.is_empty() && mates.iter().all(|&p| death(p) < death(me)) {
            d.clutch[1] += 1;
            if r.win.as_bytes().first() == Some(&mine) {
                d.clutch[0] += 1;
            }
        }
    }
    Some(d)
}

/// Gathers the per-match insights into `insights/<map>.json` (places and weapons renumbered to
/// one list per map) with the map's place grid.
fn write_maps(root: &Path, index: &Index) -> Result<()> {
    let dir = root.join("insights");
    std::fs::create_dir_all(&dir)?;
    let mut by_map: BTreeMap<String, MapInsights> = BTreeMap::new();
    let mut labels: BTreeMap<String, Vec<[i32; 3]>> = BTreeMap::new();
    let mut counts: BTreeMap<String, MapCount> = BTreeMap::new();
    let mut mine: BTreeMap<String, MyDuels> = BTreeMap::new();
    let mut newest: Vec<&crate::library::MatchSummary> = index.matches.iter().collect();
    newest.sort_by_key(|m| std::cmp::Reverse(m.played_ts));
    for m in newest {
        if by_map.get(&m.map).is_some_and(|o| o.matches.len() >= MAX_MATCHES_PER_MAP) {
            continue;
        }
        let version = details::leading_version(&path(root, &m.id)).unwrap_or(0);
        let ins: Option<MatchInsight> = (version >= USABLE_VERSION).then(|| std::fs::read_to_string(path(root, &m.id)).ok().and_then(|t| serde_json::from_str(&t).ok())).flatten();
        let Some(ins) = ins else {
            counts.entry(m.map.clone()).or_default().waiting += 1;
            continue;
        };
        if version < VERSION {
            // Shown as it is until it's rebuilt.
            counts.entry(m.map.clone()).or_default().waiting += 1;
        }
        if let Some(d) = my_duels(&ins) {
            mine.insert(ins.id.clone(), d);
        }
        let out = by_map.entry(ins.map.clone()).or_insert_with(|| MapInsights { version: VERSION, map: ins.map.clone(), path_unit: PATH_UNIT, ..Default::default() });
        let renumber = |list: &mut Vec<String>, names: &[String]| -> Vec<i32> {
            names
                .iter()
                .map(|n| match list.iter().position(|x| x == n) {
                    Some(i) => i as i32,
                    None => {
                        list.push(n.clone());
                        list.len() as i32 - 1
                    }
                })
                .collect()
        };
        let place_map = renumber(&mut out.places, &ins.places);
        let weapon_map = renumber(&mut out.weapons, &ins.weapons);
        let pl = |i: i32| if i >= 0 { place_map.get(i as usize).copied().unwrap_or(-1) } else { -1 };
        let wp = |i: i32| if i >= 0 { weapon_map.get(i as usize).copied().unwrap_or(-1) } else { -1 };
        let mi = out.matches.len();
        out.matches.push(IMatch { id: ins.id.clone(), ts: ins.ts, source: ins.source.clone(), me: ins.me, players: ins.players.clone() });
        let c = counts.entry(ins.map.clone()).or_default();
        c.matches += 1;
        c.rounds += ins.rounds.len();
        for mut r in ins.rounds {
            for a in r.areas.iter_mut() {
                for i in (0..a.len()).step_by(2) {
                    a[i] = pl(a[i]);
                }
            }
            for k in r.kills.iter_mut() {
                k[3] = wp(k[3]);
                k[13] = wp(k[13]);
            }
            for h in r.hurts.iter_mut() {
                h[4] = wp(h[4]);
            }
            for w in r.prim.iter_mut() {
                *w = wp(*w);
            }
            out.rounds.push(MapRound { m: mi, round: r });
        }
        labels.entry(ins.map.clone()).or_default().extend(ins.labels.iter().map(|l| [l[0], l[1], pl(l[2])]));
    }
    for (map, mut out) in by_map {
        out.grid = grid(labels.get(&map).map(Vec::as_slice).unwrap_or(&[]));
        // The grid alone, small, for the Grenades page (where players stand: a smoke landing
        // anywhere else is likely a miss).
        #[derive(Serialize)]
        struct GridFile<'a> {
            matches: usize,
            places: &'a [String],
            grid: &'a PlaceGrid,
        }
        std::fs::write(dir.join(format!("{map}.grid.json")), serde_json::to_string(&GridFile { matches: out.matches.len(), places: &out.places, grid: &out.grid })?)?;
        let tmp = dir.join(format!("{map}.json.tmp"));
        std::fs::write(&tmp, serde_json::to_string(&out)?)?;
        std::fs::rename(&tmp, dir.join(format!("{map}.json")))?;
    }
    let idx = InsightsIndex { version: VERSION, maps: counts };
    std::fs::write(dir.join("index.json"), serde_json::to_string(&idx)?)?;
    std::fs::write(dir.join("me.json"), serde_json::to_string(&serde_json::json!({ "version": VERSION, "matches": mine }))?)?;
    Ok(())
}

/// The callout of each cell: the one players were in most there.
fn grid(labels: &[[i32; 3]]) -> PlaceGrid {
    if labels.is_empty() {
        return PlaceGrid { cell: CELL, ..Default::default() };
    }
    let (mut x0, mut y0, mut x1, mut y1) = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);
    for l in labels {
        x0 = x0.min(l[0]);
        y0 = y0.min(l[1]);
        x1 = x1.max(l[0]);
        y1 = y1.max(l[1]);
    }
    let (x0, y0) = (x0.div_euclid(CELL) * CELL, y0.div_euclid(CELL) * CELL);
    let w = (x1 - x0) / CELL + 1;
    let h = (y1 - y0) / CELL + 1;
    let mut votes: HashMap<(i32, i32), HashMap<i32, u32>> = HashMap::new();
    for l in labels.iter().filter(|l| l[2] >= 0) {
        *votes.entry(((l[0] - x0) / CELL, (l[1] - y0) / CELL)).or_default().entry(l[2]).or_default() += 1;
    }
    let mut data = vec![-1i16; (w * h) as usize];
    for ((cx, cy), v) in votes {
        if let Some((&place, _)) = v.iter().max_by_key(|(_, n)| **n) {
            data[(cy * w + cx) as usize] = place as i16;
        }
    }
    PlaceGrid { cell: CELL, x0, y0, w, h, data }
}
