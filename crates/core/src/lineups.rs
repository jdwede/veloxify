//! Grenade lineups across the whole library (`lineups.json`): the lineups thrown in every match,
//! the same one thrown again grouped and counted. Two kinds count:
//! - instant smokes: a smoke thrown in the first moments of the round from where the thrower
//!   spawned (usually a jump throw, often with a tap of W), one or two per spawn spot;
//! - set lineups: any grenade thrown after lining up (standing still with the aim held, or running
//!   from a standstill into a jump throw) and thrown again from the same spot to the same place.
//!
//! Grenades thrown on the move aren't lineups and are left out, as is anything thrown only once.
//! Each lineup gets a name ("Instant Smoke #1", "Set Molotov #4"), the spawn spot it starts from
//! (instant smokes), how it's thrown, and one throw to film as its video.

use crate::details::DThrow;
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::path::Path;

/// Instant smoke: thrown within this many seconds of the round going live, from within this many
/// units of where the thrower spawned.
const INSTANT_S: f32 = 2.5;
const SPAWN_NEAR: f32 = 100.0;
/// Same lineup: thrown from within this many units (the same spawn spot, for instant smokes) and
/// landing within this many. A slightly different aim from the same spot to the same place is the
/// same lineup.
const SAME_SPOT: f32 = 48.0;
const SAME_HEIGHT: f32 = 40.0;
const SAME_LANDING: f32 = 200.0;
/// Lined up: stood still this long (a jump throw from a standstill, this long) with the aim held
/// within this many degrees, and thrown at least this far.
const LINED_STILL_S: f32 = 0.5;
const LINED_JUMP_STILL_S: f32 = 0.2;
const LINED_AIM: f32 = 1.0;
const MIN_FLIGHT: f32 = 250.0;
/// Bumped when the rules above change: `lineups.json` from older rules is rebuilt.
pub const VERSION: u32 = 2;
/// Spawn spots closer than this are one spot.
const SPAWN_RADIUS: f32 = 48.0;
/// Example throws kept per lineup.
const EXAMPLES: usize = 8;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Lineups {
    pub maps: BTreeMap<String, MapLineups>,
    /// Which lineup each throw belongs to: "<match id>@<tick>" -> lineup id (for a match's own
    /// Lineups tab to show the lineup's video).
    #[serde(default)]
    pub by_throw: BTreeMap<String, String>,
}

/// `lineups.json`: each map's totals (the Grenades page's map list); the lineups themselves are in
/// `lineups/<map>.json` (a [`MapLineups`] each), loaded when a map is opened.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LineupsIndex {
    #[serde(default)]
    pub version: u32,
    pub maps: BTreeMap<String, MapSummary>,
}

/// Whether `lineups.json` was built with today's rules.
pub fn current(root: &Path) -> bool {
    std::fs::read_to_string(root.join("lineups.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<LineupsIndex>(&t).ok())
        .is_some_and(|i| i.version >= VERSION)
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MapSummary {
    pub counts: BTreeMap<String, usize>,
    pub throws: usize,
    pub matches: usize,
    pub lineups: usize,
    /// How many of the lineups are instant smokes (the rest are set lineups).
    #[serde(default)]
    pub instant: usize,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MapLineups {
    /// Lineups (groups) per grenade kind, and throws seen in total.
    pub counts: BTreeMap<String, usize>,
    pub throws: usize,
    pub matches: usize,
    /// Spawn spots per side: [x, y] by number (Spawn #1 is the first).
    pub spawns: BTreeMap<String, Vec<[f32; 2]>>,
    pub lineups: Vec<Lineup>,
    /// Which lineup each of this map's throws belongs to: "<match id>@<tick>" -> lineup id.
    #[serde(default)]
    pub by_throw: BTreeMap<String, String>,
}

/// Every map's lineups (from `lineups/<map>.json`).
pub fn load(root: &Path) -> Lineups {
    let index: LineupsIndex = std::fs::read_to_string(root.join("lineups.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    let mut out = Lineups::default();
    for map in index.maps.keys() {
        if let Some(m) = std::fs::read_to_string(root.join("lineups").join(format!("{map}.json"))).ok().and_then(|t| serde_json::from_str::<MapLineups>(&t).ok()) {
            out.maps.insert(map.clone(), m);
        }
    }
    out
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Lineup {
    /// Stable id (the video's file name).
    pub id: String,
    /// "Instant Smoke #1", "Set Molotov #4", ...
    pub name: String,
    /// "smoke", "molotov", "flash", "he".
    pub kind: String,
    /// "instant" (smokes from spawn) or "set".
    pub category: String,
    pub side: String,
    /// Times thrown, in how many matches, by how many players.
    pub count: usize,
    pub matches: usize,
    pub throwers: usize,
    /// Spawn spot number (instants), the callouts thrown from and landing at.
    pub spawn: Option<usize>,
    pub from_place: String,
    pub to_place: String,
    /// Where to stand and aim (the representative throw), where it lands, and its flight.
    pub from: [f32; 3],
    pub pitch: f32,
    pub yaw: f32,
    pub to: [f32; 2],
    pub path: Vec<[i32; 3]>,
    /// How it's thrown: the most common tag and every tag with its count.
    pub technique: String,
    pub tags: BTreeMap<String, usize>,
    pub click: String,
    /// Average seconds into the round.
    pub t: f32,
    /// The throw to render as this lineup's video, and examples.
    pub video: Occurrence,
    pub examples: Vec<Occurrence>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Occurrence {
    pub match_id: String,
    pub round: u32,
    pub t: f32,
    pub tick: i32,
    pub pop_tick: i32,
    pub player: String,
    pub name: String,
}

/// How a throw was thrown, in words.
pub fn technique_tag(t: &DThrow) -> String {
    let w = t.keys & 1 != 0;
    match t.technique.as_str() {
        "jump" if t.speed > 200.0 => "Running jump throw".into(),
        "jump" if w || t.speed > 60.0 => "Jump throw + W".into(),
        "jump" => "Jump throw".into(),
        "crouch" => "Crouch throw".into(),
        "walk" if t.keys & 128 != 0 => "Walk + throw".into(),
        "walk" | "run" if w => "Run + throw (W)".into(),
        "walk" | "run" => "Moving throw".into(),
        _ => "Standing throw".into(),
    }
}

/// A smoke thrown in the first moments of the round from where the thrower spawned.
fn instant(t: &DThrow) -> bool {
    t.kind == "smoke" && t.t < INSTANT_S && t.spawn.is_some_and(|s| (t.from[0] - s[0]).hypot(t.from[1] - s[1]) < SPAWN_NEAR)
}

/// Lined up before throwing: stood still with the aim held, or ran from a standstill into a jump
/// throw with the aim held. Not a grenade thrown on the move.
fn lined(t: &DThrow) -> bool {
    if t.aim_moved_deg >= LINED_AIM {
        return false;
    }
    match t.technique.as_str() {
        "run" | "walk" => false,
        "jump" if t.speed > 200.0 => t.still_s > 0.0,
        "jump" => t.still_s >= LINED_JUMP_STILL_S,
        _ => t.still_s >= LINED_STILL_S,
    }
}

fn flight(t: &DThrow) -> f32 {
    (t.to[0] - t.from[0]).hypot(t.to[1] - t.from[1])
}

#[derive(Deserialize)]
struct EntryLite {
    id: String,
    map: String,
    #[serde(default)]
    played_ts: i64,
    #[serde(default)]
    players: Vec<PlayerLite>,
}

#[derive(Deserialize)]
struct PlayerLite {
    steamid: String,
    name: String,
}

#[derive(Deserialize)]
struct DetailsLite {
    #[serde(default)]
    throws: Vec<DThrow>,
    #[serde(default)]
    kills: Vec<KillLite>,
}

#[derive(Deserialize)]
struct KillLite {
    #[serde(default)]
    attacker_xy: Option<[f32; 2]>,
    #[serde(default)]
    victim_xy: Option<[f32; 2]>,
    #[serde(default)]
    attacker_place: String,
    #[serde(default)]
    victim_place: String,
}

struct Group<'a> {
    kind: String,
    side: String,
    instant: bool,
    /// Where it's thrown from (the spawn spot, for instant smokes) and where it lands, averaged
    /// over the throws so far.
    at: [f32; 3],
    to: [f32; 2],
    members: Vec<(&'a str, &'a DThrow)>,
}

/// Builds `lineups.json` from every match's details in the library.
pub fn write(root: &Path) -> Result<()> {
    let dir = root.join("matches");
    // Each match's map and player names, then its throws and callout points.
    let mut entries: HashMap<String, EntryLite> = HashMap::new();
    let mut details: Vec<(String, DetailsLite)> = vec![];
    for f in std::fs::read_dir(&dir)?.flatten() {
        let p = f.path();
        let name = p.file_name().unwrap_or_default().to_string_lossy().to_string();
        if let Some(id) = name.strip_suffix(".details.json") {
            if let Ok(d) = serde_json::from_str::<DetailsLite>(&std::fs::read_to_string(&p)?) {
                details.push((id.to_string(), d));
            }
        } else if crate::library::is_entry_file(&p) {
            if let Ok(e) = serde_json::from_str::<EntryLite>(&std::fs::read_to_string(&p)?) {
                entries.insert(e.id.clone(), e);
            }
        }
    }
    let mut by_map: BTreeMap<String, Vec<(&str, &DThrow)>> = BTreeMap::new();
    let mut places: HashMap<String, Vec<([f32; 2], &str)>> = HashMap::new();
    let mut matches_on: HashMap<String, usize> = HashMap::new();
    for (id, d) in &details {
        let Some(e) = entries.get(id) else { continue };
        *matches_on.entry(e.map.clone()).or_default() += 1;
        by_map.entry(e.map.clone()).or_default().extend(d.throws.iter().map(|t| (id.as_str(), t)));
        let pl = places.entry(e.map.clone()).or_default();
        for k in &d.kills {
            if let Some(xy) = k.attacker_xy.filter(|_| !k.attacker_place.is_empty()) {
                pl.push((xy, k.attacker_place.as_str()));
            }
            if let Some(xy) = k.victim_xy.filter(|_| !k.victim_place.is_empty()) {
                pl.push((xy, k.victim_place.as_str()));
            }
        }
    }
    let name_of = |match_id: &str, sid: &str| -> String {
        entries.get(match_id).and_then(|e| e.players.iter().find(|p| p.steamid == sid)).map(|p| p.name.clone()).unwrap_or_default()
    };

    let mut out = Lineups::default();
    for (map, throws) in &by_map {
        // Group the same lineup.
        let mut groups: Vec<Group> = vec![];
        let mut sorted = throws.clone();
        sorted.sort_by(|a, b| a.0.cmp(b.0).then(a.1.round.cmp(&b.1.round)).then(a.1.t.total_cmp(&b.1.t)));
        for (mid, t) in sorted {
            let is_instant = instant(t);
            if !is_instant && !(lined(t) && flight(t) > MIN_FLIGHT) {
                continue;
            }
            let at = match (is_instant, t.spawn) {
                (true, Some(s)) => [s[0], s[1], t.from[2]],
                _ => t.from,
            };
            let found = groups.iter_mut().find(|g| {
                g.instant == is_instant
                    && g.kind == t.kind
                    && g.side == t.side
                    && (g.at[0] - at[0]).hypot(g.at[1] - at[1]) < SAME_SPOT
                    && (g.at[2] - at[2]).abs() < SAME_HEIGHT
                    && (g.to[0] - t.to[0]).hypot(g.to[1] - t.to[1]) < SAME_LANDING
            });
            match found {
                Some(g) => {
                    let n = g.members.len() as f32;
                    for i in 0..3 {
                        g.at[i] = (g.at[i] * n + at[i]) / (n + 1.0);
                    }
                    for i in 0..2 {
                        g.to[i] = (g.to[i] * n + t.to[i]) / (n + 1.0);
                    }
                    g.members.push((mid, t));
                }
                None => groups.push(Group { kind: t.kind.clone(), side: t.side.clone(), instant: is_instant, at, to: t.to, members: vec![(mid, t)] }),
            }
        }
        // Spawn spots per side, from where throwers stood when rounds went live.
        let mut spawns: BTreeMap<String, Vec<([f32; 2], usize)>> = BTreeMap::new();
        for (_, t) in throws {
            let Some(s) = t.spawn else { continue };
            let list = spawns.entry(t.side.clone()).or_default();
            match list.iter_mut().find(|(p, _)| (p[0] - s[0]).hypot(p[1] - s[1]) < SPAWN_RADIUS) {
                Some((p, n)) => {
                    p[0] = (p[0] * *n as f32 + s[0]) / (*n as f32 + 1.0);
                    p[1] = (p[1] * *n as f32 + s[1]) / (*n as f32 + 1.0);
                    *n += 1;
                }
                None => list.push((s, 1)),
            }
        }
        // Real spawn spots are where many rounds start; numbered left to right, top to bottom.
        let mut spots: BTreeMap<String, Vec<[f32; 2]>> = BTreeMap::new();
        for (side, list) in &spawns {
            let mut keep: Vec<[f32; 2]> = list.iter().filter(|(_, n)| *n >= 3).map(|(p, _)| [p[0].round(), p[1].round()]).collect();
            keep.sort_by(|a, b| (b[1] / 64.0).round().total_cmp(&(a[1] / 64.0).round()).then(a[0].total_cmp(&b[0])));
            spots.insert(side.clone(), keep);
        }
        let spot_of = |side: &str, s: Option<[f32; 2]>| -> Option<usize> {
            let s = s?;
            spots.get(side)?.iter().position(|p| (p[0] - s[0]).hypot(p[1] - s[1]) < SPAWN_RADIUS).map(|i| i + 1)
        };
        let place_near = |xy: [f32; 2]| -> String {
            places
                .get(map)
                .and_then(|pl| pl.iter().map(|(p, n)| ((p[0] - xy[0]).hypot(p[1] - xy[1]), *n)).filter(|(d, _)| *d < 600.0).min_by(|a, b| a.0.total_cmp(&b.0)))
                .map(|(_, n)| n.to_string())
                .unwrap_or_default()
        };

        let mut lineups: Vec<Lineup> = vec![];
        let mut used_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
        for g in &groups {
            let n = g.members.len();
            // A lineup is thrown again: in at least two different rounds.
            let mut rounds: Vec<(&str, u32)> = g.members.iter().map(|(m, t)| (*m, t.round)).collect();
            rounds.sort_unstable();
            rounds.dedup();
            if rounds.len() < 2 {
                continue;
            }
            let category = if g.instant { "instant" } else { "set" };
            let mut tags: BTreeMap<String, usize> = BTreeMap::new();
            for (_, t) in &g.members {
                *tags.entry(technique_tag(t)).or_default() += 1;
            }
            let technique = tags.iter().max_by_key(|(_, c)| **c).map(|(k, _)| k.clone()).unwrap_or_default();
            let mut clicks: BTreeMap<&str, usize> = BTreeMap::new();
            for (_, t) in &g.members {
                *clicks.entry(t.click.as_str()).or_default() += 1;
            }
            let click = clicks.iter().max_by_key(|(_, c)| **c).map(|(k, _)| k.to_string()).unwrap_or_default();
            // The video and the examples: newest matches first (their demos are still on disk and
            // CS2 can still play them; old demos stop playing after CS2 updates).
            let mean = |f: &dyn Fn(&DThrow) -> f32| g.members.iter().map(|(_, t)| f(t)).sum::<f32>() / n as f32;
            let played = |mid: &str| entries.get(mid).map_or(0, |e| e.played_ts);
            let mut newest: Vec<(&str, &DThrow)> = g.members.clone();
            newest.sort_by_key(|(mid, t)| (std::cmp::Reverse(played(mid)), t.round, t.tick));
            let rep = newest.iter().find(|(_, t)| t.tick > 0 && t.path.len() > 1).or(newest.first()).copied().unwrap();
            let occ = |(mid, t): (&str, &DThrow)| Occurrence {
                match_id: mid.to_string(),
                round: t.round,
                t: t.t,
                tick: t.tick,
                pop_tick: t.pop_tick,
                player: t.player.clone(),
                name: name_of(mid, &t.player),
            };
            let r = rep.1;
            let mut matches: Vec<&str> = g.members.iter().map(|(m, _)| *m).collect();
            matches.sort_unstable();
            matches.dedup();
            let mut throwers: Vec<&str> = g.members.iter().map(|(_, t)| t.player.as_str()).collect();
            throwers.sort_unstable();
            throwers.dedup();
            // Named after its first throw (the earliest played), so new matches don't rename it.
            let first = g.members.iter().min_by_key(|(mid, t)| (played(mid), *mid, t.tick)).map(|(_, t)| *t).unwrap_or(r);
            let mut id = format!(
                "{map}-{}-{}-{}-{}-{}-{}",
                g.kind,
                g.side,
                (first.from[0] / 16.0).round() as i32,
                (first.from[1] / 16.0).round() as i32,
                first.pitch.round() as i32,
                first.yaw.round() as i32
            );
            while !used_ids.insert(id.clone()) {
                id.push('b');
            }
            for (mid, t) in &g.members {
                out.by_throw.insert(format!("{mid}@{}", t.tick), id.clone());
            }
            lineups.push(Lineup {
                id,
                name: String::new(),
                kind: g.kind.clone(),
                category: category.into(),
                side: g.side.clone(),
                count: n,
                matches: matches.len(),
                throwers: throwers.len(),
                spawn: if g.instant { spot_of(&g.side, Some([g.at[0], g.at[1]])) } else { None },
                from_place: r.from_place.clone(),
                to_place: place_near(r.to),
                from: r.from,
                pitch: r.pitch,
                yaw: r.yaw,
                to: r.to,
                // Every other point (8 ticks apart) is plenty to draw it.
                path: r.path.iter().step_by(2).chain(r.path.last()).copied().collect(),
                technique,
                tags,
                click,
                t: mean(&|t| t.t),
                video: occ(rep),
                examples: newest.iter().take(EXAMPLES).map(|m| occ(*m)).collect(),
            });
        }
        // Names: the most thrown first within each category and kind.
        lineups.sort_by(|a, b| b.count.cmp(&a.count).then(b.matches.cmp(&a.matches)).then(a.id.cmp(&b.id)));
        let mut rank: HashMap<(String, String), usize> = HashMap::new();
        for l in lineups.iter_mut() {
            let n = rank.entry((l.category.clone(), l.kind.clone())).or_default();
            *n += 1;
            let kind = match l.kind.as_str() {
                "smoke" => "Smoke",
                "molotov" => "Molotov",
                "flash" => "Flash",
                _ => "HE",
            };
            let cat = if l.category == "instant" { "Instant" } else { "Set" };
            l.name = format!("{cat} {kind} #{n}");
        }
        let mut counts: BTreeMap<String, usize> = BTreeMap::new();
        for l in &lineups {
            *counts.entry(l.kind.clone()).or_default() += 1;
        }
        let ids: std::collections::HashSet<&str> = lineups.iter().map(|l| l.id.as_str()).collect();
        let by_throw: BTreeMap<String, String> = out.by_throw.iter().filter(|(_, id)| ids.contains(id.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect();
        out.maps.insert(
            map.clone(),
            MapLineups { counts, throws: throws.len(), matches: matches_on.get(map).copied().unwrap_or(0), spawns: spots, lineups, by_throw },
        );
    }
    // A small index for the map list, and a file per map.
    let dir = root.join("lineups");
    std::fs::create_dir_all(&dir)?;
    let mut index = LineupsIndex { version: VERSION, ..Default::default() };
    for (map, m) in &out.maps {
        index.maps.insert(
            map.clone(),
            MapSummary {
                counts: m.counts.clone(),
                throws: m.throws,
                matches: m.matches,
                lineups: m.lineups.len(),
                instant: m.lineups.iter().filter(|l| l.category == "instant").count(),
            },
        );
        std::fs::write(dir.join(format!("{map}.json")), serde_json::to_string(m)?)?;
    }
    std::fs::write(root.join("lineups.json"), serde_json::to_string(&index)?)?;
    Ok(())
}
