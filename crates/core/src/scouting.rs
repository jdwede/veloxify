//! Scouting a team from their demos: how they set up on CT and where they go on T, round by round
//! (pistol, eco, force and full-buy rounds), for the ESEA scout's strategies section.

use crate::{analysis, details, model, raw};
use anyhow::{bail, Result};
use serde_json::{json, Value};
use std::collections::HashMap;

/// When a round's setup is read: this long after the round went live (players are in position, the
/// first fights haven't started).
const SETUP_AT_S: f32 = 20.0;
/// A position this close to a bombsite (as a share of the distance between the two sites) is on it.
const ON_SITE: f32 = 0.42;
/// Farther than this from both sites (same share) is a push toward the other team's side.
const PUSHED: f32 = 0.9;
/// The team's average equipment value per player (at the start of the round) up to which it's an
/// eco, then a force buy; above, a full buy.
const ECO_MAX: u32 = 1600;
const FORCE_MAX: u32 = 3500;
/// A plant this early is a rush or fast hit.
const FAST_PLANT_S: f32 = 35.0;

/// Bumped when what's computed changes (cached results are read again).
pub const VERSION: u32 = 1;

/// The team's rounds in one demo (`team`: its players' SteamID64s; the team is whichever side has
/// most of them).
pub fn team_rounds(demo: &[u8], team: &[u64]) -> Result<Value> {
    let m = model::load_match(demo)?;
    let ours: Vec<u64> = m.players.iter().map(|p| p.steamid).filter(|s| team.contains(s)).collect();
    let Some(&me) = ours.first() else { bail!("none of the team's players are in this demo") };
    let a = analysis::analyze(&m);
    let d = details::build(demo, &m, &a, me)?;
    let my_team = m.team_of(me);
    let mates: Vec<u64> = m.players.iter().filter(|p| Some(p.team) == my_team).map(|p| p.steamid).collect();
    let names: HashMap<u64, String> = m.players.iter().map(|p| (p.steamid, p.name.clone())).collect();
    // The bombsites' centres, from where this demo's fights on them happened.
    let mut sums: HashMap<&str, (f32, f32, u32)> = HashMap::new();
    for k in &d.kills {
        for (xy, place) in [(k.attacker_xy, &k.attacker_place), (k.victim_xy, &k.victim_place)] {
            if let (Some(xy), "BombsiteA" | "BombsiteB") = (xy, place.as_str()) {
                let e = sums.entry(if place == "BombsiteA" { "A" } else { "B" }).or_insert((0.0, 0.0, 0));
                e.0 += xy[0];
                e.1 += xy[1];
                e.2 += 1;
            }
        }
    }
    let site = |k: &str| sums.get(k).filter(|s| s.2 > 0).map(|s| [s.0 / s.2 as f32, s.1 / s.2 as f32]);
    let (site_a, site_b) = (site("A"), site("B"));
    // Everyone's position and place a set time into each round.
    let at: Vec<i32> = d.rounds.iter().map(|r| r.live_tick + (SETUP_AT_S * 64.0) as i32).collect();
    let table = raw::players_table(demo, &mates, &["X", "Y", "health"], &at)?;
    let places = raw::players_values(demo, &["last_place_name"], &at).unwrap_or_default();
    let pistols = analysis::pistol_rounds(&m);
    let zone = |xy: [f32; 2], place: &str| -> &'static str {
        match place {
            "BombsiteA" => return "A",
            "BombsiteB" => return "B",
            _ => {}
        }
        let (Some(a), Some(b)) = (site_a, site_b) else { return "Mid" };
        let dist = |p: [f32; 2]| ((xy[0] - p[0]).powi(2) + (xy[1] - p[1]).powi(2)).sqrt();
        let ab = dist_xy(a, b).max(1.0);
        let (da, db) = (dist(a), dist(b));
        if da < ON_SITE * ab && da <= db {
            "A"
        } else if db < ON_SITE * ab {
            "B"
        } else {
            "Mid"
        }
    };
    let mut rounds = vec![];
    for (i, r) in d.rounds.iter().enumerate() {
        let tick = at[i];
        let buy = if pistols.contains(&i) {
            "pistol"
        } else if r.equip_mine <= ECO_MAX {
            "eco"
        } else if r.equip_mine <= FORCE_MAX {
            "force"
        } else {
            "full"
        };
        let mut spots = vec![];
        let mut pushed = 0;
        for &p in &mates {
            let Some(row) = table.get(&p).and_then(|rows| rows.iter().find(|(t, _)| *t == tick)) else { continue };
            let v = row.1;
            if !(v[2] > 0.0) {
                continue;
            }
            let xy = [v[0], v[1]];
            let place = match places.get(&(p, tick)).and_then(|m| m.get("last_place_name")) {
                Some(raw::Val::Strs(s)) => s.first().cloned().unwrap_or_default(),
                _ => String::new(),
            };
            let z = zone(xy, &place);
            if let (Some(a), Some(b)) = (site_a, site_b) {
                let ab = dist_xy(a, b).max(1.0);
                if z == "Mid" && dist_xy(xy, a) > PUSHED * ab && dist_xy(xy, b) > PUSHED * ab {
                    pushed += 1;
                }
            }
            spots.push(json!({ "player": names.get(&p), "zone": z, "place": place }));
        }
        let count = |z: &str| spots.iter().filter(|s| s["zone"] == z).count();
        let plant = r.plant.as_ref().map(|(t, place, _)| json!({ "t": t, "site": if place.ends_with('A') { "A" } else if place.ends_with('B') { "B" } else { "?" } }));
        rounds.push(json!({
            "number": r.number,
            "side": r.mine_side,
            "buy": buy,
            "won": r.winner == "mine",
            "setup": { "A": count("A"), "Mid": count("Mid"), "B": count("B") },
            "pushed": pushed,
            "spots": spots,
            "plant": plant,
            "fast": r.plant.as_ref().is_some_and(|(t, _, _)| *t <= FAST_PLANT_S),
        }));
    }
    let (us, them) = d.rounds.last().map(|r| (r.score_mine, r.score_theirs)).unwrap_or((0, 0));
    Ok(json!({ "version": VERSION, "map": m.map, "score": [us, them], "rounds": rounds, "sites": { "A": site_a, "B": site_b } }))
}

fn dist_xy(a: [f32; 2], b: [f32; 2]) -> f32 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2)).sqrt()
}
