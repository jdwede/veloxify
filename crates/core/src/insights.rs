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
pub const VERSION: u32 = 1;

/// Paths keep a point every this many replay frames (8 a second): twice a second.
const PATH_EVERY: usize = 4;
/// Coordinates in paths are stored divided by this (units).
pub const PATH_UNIT: i32 = 4;
/// The place grid's cell size (units).
const CELL: i32 = 48;

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
    /// height is the attacker's above the victim's.
    pub kills: Vec<[i32; 14]>,
    /// `[time, attacker, victim, damage, weapon]` (-1 attacker = the world).
    pub hurts: Vec<[i32; 5]>,
    /// `[time, thrower, kind, from x, from y, to x, to y, tick]`; kind 0 smoke, 1 molotov,
    /// 2 flash, 3 HE, 4 decoy.
    pub nades: Vec<[i32; 8]>,
    /// `[time, player, x, y]`.
    pub jumps: Vec<[i32; 4]>,
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
                Some([(k.t * 10.0).round() as i32, a, v, -1, flags, ax, ay, vx, vy, height, dist, aspd, speed(f.saturating_sub(1), v as usize), at(f.saturating_sub(1), v as usize, 4)])
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
        let live_ticks = dr.live_tick - rr.start;
        let hurts = rr
            .hurts
            .iter()
            .map(|h| [(((h[0] - live_ticks) as f64 / tick_rate) * 10.0).round() as i32, h[1], h[2], h[3], h[4]])
            .filter(|h| h[0] >= 0)
            .collect();
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
            std::fs::write(path(root, &m.id), serde_json::to_string(&ins)?)?;
            built += 1;
        }
    }
    let maps_missing = !root.join("insights").join("index.json").exists();
    if built > 0 || maps_missing {
        write_maps(root, &index)?;
    }
    Ok(built)
}

fn current(root: &Path, id: &str) -> bool {
    details::leading_version(&path(root, id)).is_some_and(|v| v >= VERSION)
}

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
    /// Matches on this map not in it yet (their replay is from before heights and callouts).
    pub waiting: usize,
}

/// Gathers the per-match insights into `insights/<map>.json` (places and weapons renumbered to
/// one list per map) with the map's place grid.
fn write_maps(root: &Path, index: &Index) -> Result<()> {
    let dir = root.join("insights");
    std::fs::create_dir_all(&dir)?;
    let mut by_map: BTreeMap<String, MapInsights> = BTreeMap::new();
    let mut labels: BTreeMap<String, Vec<[i32; 3]>> = BTreeMap::new();
    let mut counts: BTreeMap<String, MapCount> = BTreeMap::new();
    for m in &index.matches {
        let ins: Option<MatchInsight> = current(root, &m.id).then(|| std::fs::read_to_string(path(root, &m.id)).ok().and_then(|t| serde_json::from_str(&t).ok())).flatten();
        let Some(ins) = ins else {
            counts.entry(m.map.clone()).or_default().waiting += 1;
            continue;
        };
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
            out.rounds.push(MapRound { m: mi, round: r });
        }
        labels.entry(ins.map.clone()).or_default().extend(ins.labels.iter().map(|l| [l[0], l[1], pl(l[2])]));
    }
    for (map, mut out) in by_map {
        out.grid = grid(labels.get(&map).map(Vec::as_slice).unwrap_or(&[]));
        let tmp = dir.join(format!("{map}.json.tmp"));
        std::fs::write(&tmp, serde_json::to_string(&out)?)?;
        std::fs::rename(&tmp, dir.join(format!("{map}.json")))?;
    }
    let idx = InsightsIndex { version: VERSION, maps: counts };
    std::fs::write(dir.join("index.json"), serde_json::to_string(&idx)?)?;
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
