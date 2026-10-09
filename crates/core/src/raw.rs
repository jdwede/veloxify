//! Thin wrapper over the vendored demoparser.

use ahash::AHashMap;
use anyhow::{anyhow, Result};
use parser::first_pass::parser_settings::{rm_user_friendly_names, ParserInputs};
use parser::first_pass::prop_controller::{ENTITY_ID_ID, GRENADE_TYPE_ID, GRENADE_X, GRENADE_Y, GRENADE_Z, STEAMID_ID, TICK_ID};
use parser::parse_demo::{DemoOutput, Parser, ParsingMode};
use parser::second_pass::parser_settings::create_huffman_lookup_table;
use parser::second_pass::variants::VarVec;
use std::collections::HashMap;

/// Player props attached to every event as `<prefix>_<prop>` (e.g. `attacker_team_num`).
/// Position and callout ("BombsiteA", "Palace") feed the match page's map views.
const EVENT_PLAYER_PROPS: &[&str] = &["team_num", "health", "current_equip_value", "is_alive", "X", "Y", "last_place_name"];
/// Non-player props attached to every event (rules/team entities).
const EVENT_OTHER_PROPS: &[&str] = &["total_rounds_played", "is_warmup_period", "is_freeze_period"];

/// CS2's own end-of-match scoreboard values, read from the player controllers.
pub const SCOREBOARD_PROPS: &[&str] = &[
    "kills_total",
    "deaths_total",
    "assists_total",
    "headshot_kills_total",
    "damage_total",
    "utility_damage_total",
    "enemies_flashed_total",
    "3k_rounds_total",
    "4k_rounds_total",
    "ace_rounds_total",
    "mvps",
    "score",
    "rank",
    "rank_if_win",
    "rank_if_loss",
    "CCSPlayerController.m_iCompetitiveRankType",
];

fn friendly_to_real(friendly: &[&str]) -> Result<(Vec<String>, AHashMap<String, String>)> {
    let friendly: Vec<String> = friendly.iter().map(|s| s.to_string()).collect();
    let real = rm_user_friendly_names(&friendly).map_err(|e| anyhow!("{e:?}"))?;
    let map = real.iter().cloned().zip(friendly).collect();
    Ok((real, map))
}

fn run(demo: &[u8], configure: impl FnOnce(&mut ParserInputs)) -> Result<DemoOutput> {
    let huf = create_huffman_lookup_table();
    let mut inputs = ParserInputs {
        wanted_player_props: vec![],
        wanted_events: vec![],
        real_name_to_og_name: AHashMap::default(),
        wanted_other_props: vec![],
        parse_ents: true,
        wanted_players: vec![],
        wanted_ticks: vec![],
        parse_projectiles: false,
        parse_grenades: false,
        only_header: false,
        list_props: false,
        only_convars: false,
        huffman_lookup_table: &huf,
        order_by_steamid: false,
        wanted_prop_states: AHashMap::default(),
        fallback_bytes: None,
    };
    configure(&mut inputs);
    Parser::new(inputs, ParsingMode::Normal)
        .parse_demo(demo)
        .map_err(|e| anyhow!("demo parse failed: {e:?}"))
}

/// Parses game events; `["all"]` returns every event type.
pub fn parse_events(demo: &[u8], events: &[&str]) -> Result<DemoOutput> {
    // The parser works on Valve's internal prop paths; map our friendly names to them and back.
    let (real_player, mut names) = friendly_to_real(EVENT_PLAYER_PROPS)?;
    let (real_other, other_names) = friendly_to_real(EVENT_OTHER_PROPS)?;
    names.extend(other_names);
    run(demo, |i| {
        i.wanted_player_props = real_player;
        i.wanted_other_props = real_other;
        i.real_name_to_og_name = names;
        i.wanted_events = events.iter().map(|s| s.to_string()).collect();
    })
}

/// Reads integer player props at the given ticks. Returns, per steamid, the values from the
/// latest requested tick at which that player had data.
pub fn player_props_at(demo: &[u8], props: &[&str], ticks: &[i32]) -> Result<HashMap<u64, HashMap<String, i64>>> {
    let (real, names) = friendly_to_real(props)?;
    let out = run(demo, |i| {
        i.wanted_player_props = real;
        i.real_name_to_og_name = names;
        i.wanted_ticks = ticks.to_vec();
    })?;
    let ids: Vec<(u32, String)> = out
        .prop_controller
        .prop_infos
        .iter()
        .filter(|p| props.contains(&p.prop_friendly_name.as_str()))
        .map(|p| (p.id, p.prop_friendly_name.clone()))
        .collect();

    let (Some(VarVec::U64(steamids)), Some(VarVec::I32(row_ticks))) = (
        out.df.get(&STEAMID_ID).and_then(|c| c.data.as_ref()),
        out.df.get(&TICK_ID).and_then(|c| c.data.as_ref()),
    ) else {
        return Ok(HashMap::new());
    };

    let mut best: HashMap<u64, (i32, usize)> = HashMap::new();
    for (row, (sid, tick)) in steamids.iter().zip(row_ticks).enumerate() {
        if let (Some(sid), Some(tick)) = (sid, tick) {
            let e = best.entry(*sid).or_insert((*tick, row));
            if *tick >= e.0 {
                *e = (*tick, row);
            }
        }
    }
    let mut result = HashMap::new();
    for (sid, (_, row)) in best {
        let mut vals = HashMap::new();
        for (id, name) in &ids {
            if let Some(v) = out.df.get(id).and_then(|c| c.data.as_ref()).and_then(|d| int_at(d, row)) {
                vals.insert(name.clone(), v);
            }
        }
        result.insert(sid, vals);
    }
    Ok(result)
}

fn int_at(v: &VarVec, row: usize) -> Option<i64> {
    match v {
        VarVec::I32(x) => x.get(row).copied().flatten().map(|v| v as i64),
        VarVec::U32(x) => x.get(row).copied().flatten().map(|v| v as i64),
        VarVec::U64(x) => x.get(row).copied().flatten().map(|v| v as i64),
        _ => None,
    }
}

/// Reads numeric props for one player at the given ticks, returned in tick order.
pub fn player_series(demo: &[u8], steamid: u64, props: &[&str], ticks: &[i32]) -> Result<Vec<(i32, HashMap<String, f64>)>> {
    let (real, names) = friendly_to_real(props)?;
    let out = run(demo, |i| {
        i.wanted_player_props = real;
        i.real_name_to_og_name = names;
        i.wanted_ticks = ticks.to_vec();
        i.wanted_players = vec![steamid];
    })?;
    let ids: Vec<(u32, String)> = out
        .prop_controller
        .prop_infos
        .iter()
        .filter(|p| props.contains(&p.prop_friendly_name.as_str()))
        .map(|p| (p.id, p.prop_friendly_name.clone()))
        .collect();
    let (Some(VarVec::U64(steamids)), Some(VarVec::I32(row_ticks))) = (
        out.df.get(&STEAMID_ID).and_then(|c| c.data.as_ref()),
        out.df.get(&TICK_ID).and_then(|c| c.data.as_ref()),
    ) else {
        return Ok(vec![]);
    };
    let mut rows = vec![];
    for (row, (sid, tick)) in steamids.iter().zip(row_ticks).enumerate() {
        if *sid != Some(steamid) {
            continue;
        }
        let Some(tick) = tick else { continue };
        let mut vals = HashMap::new();
        for (id, name) in &ids {
            if let Some(v) = out.df.get(id).and_then(|c| c.data.as_ref()).and_then(|d| num_at(d, row)) {
                vals.insert(name.clone(), v);
            }
        }
        rows.push((*tick, vals));
    }
    rows.sort_by_key(|(t, _)| *t);
    Ok(rows)
}

fn num_at(v: &VarVec, row: usize) -> Option<f64> {
    match v {
        VarVec::F32(x) => x.get(row).copied().flatten().map(|v| v as f64),
        VarVec::Bool(x) => x.get(row).copied().flatten().map(|v| v as u8 as f64),
        _ => int_at(v, row).map(|v| v as f64),
    }
}

/// A player prop value: a number, a list of steamids (`approximate_spotted_by`) or a list of
/// strings (`inventory`).
#[derive(Debug, Clone)]
pub enum Val {
    Num(f64),
    Ids(Vec<u64>),
    Strs(Vec<String>),
}

/// Props for every player at the given ticks: (steamid, tick) -> prop -> value.
pub fn players_values(demo: &[u8], props: &[&str], ticks: &[i32]) -> Result<HashMap<(u64, i32), HashMap<String, Val>>> {
    let (real, names) = friendly_to_real(props)?;
    let out = run(demo, |i| {
        i.wanted_player_props = real;
        i.real_name_to_og_name = names;
        i.wanted_ticks = ticks.to_vec();
    })?;
    let ids: Vec<(u32, String)> = out
        .prop_controller
        .prop_infos
        .iter()
        .filter(|p| props.contains(&p.prop_friendly_name.as_str()))
        .map(|p| (p.id, p.prop_friendly_name.clone()))
        .collect();
    let (Some(VarVec::U64(sids)), Some(VarVec::I32(row_ticks))) = (
        out.df.get(&STEAMID_ID).and_then(|c| c.data.as_ref()),
        out.df.get(&TICK_ID).and_then(|c| c.data.as_ref()),
    ) else {
        return Ok(HashMap::new());
    };
    let mut result: HashMap<(u64, i32), HashMap<String, Val>> = HashMap::new();
    for (row, (sid, tick)) in sids.iter().zip(row_ticks).enumerate() {
        let (Some(sid), Some(tick)) = (sid, tick) else { continue };
        let mut vals = HashMap::new();
        for (id, name) in &ids {
            let Some(data) = out.df.get(id).and_then(|c| c.data.as_ref()) else { continue };
            // Vector props (e.g. `aim_punch_angle`) come back as `<name>_0`, `<name>_1`, `<name>_2`.
            let parts: Option<Vec<f32>> = match data {
                VarVec::XYZVec(x) => x.get(row).and_then(|v| v.map(|v| v.to_vec())),
                VarVec::XYVec(x) => x.get(row).and_then(|v| v.map(|v| v.to_vec())),
                _ => None,
            };
            if let Some(parts) = parts {
                for (i, c) in parts.iter().enumerate() {
                    vals.insert(format!("{name}_{i}"), Val::Num(*c as f64));
                }
                continue;
            }
            let v = match data {
                VarVec::U64Vec(x) => x.get(row).map(|v| Val::Ids(v.clone())),
                VarVec::StringVec(x) => x.get(row).map(|v| Val::Strs(v.clone())),
                VarVec::String(x) => x.get(row).and_then(|v| v.clone()).map(|s| Val::Strs(vec![s])),
                _ => num_at(data, row).map(Val::Num),
            };
            if let Some(v) = v {
                vals.insert(name.clone(), v);
            }
        }
        result.insert((*sid, *tick), vals);
    }
    Ok(result)
}

/// Numeric props for several players at the given ticks: (steamid, tick) -> prop -> value.
/// Vector props (e.g. `aim_punch_angle`) come back as `<name>_0`, `<name>_1`, `<name>_2`.
pub fn players_series(demo: &[u8], steamids: &[u64], props: &[&str], ticks: &[i32]) -> Result<HashMap<(u64, i32), HashMap<String, f64>>> {
    let (real, names) = friendly_to_real(props)?;
    let out = run(demo, |i| {
        i.wanted_player_props = real;
        i.real_name_to_og_name = names;
        i.wanted_ticks = ticks.to_vec();
        i.wanted_players = steamids.to_vec();
    })?;
    let ids: Vec<(u32, String)> = out
        .prop_controller
        .prop_infos
        .iter()
        .filter(|p| props.contains(&p.prop_friendly_name.as_str()))
        .map(|p| (p.id, p.prop_friendly_name.clone()))
        .collect();
    let (Some(VarVec::U64(sids)), Some(VarVec::I32(row_ticks))) = (
        out.df.get(&STEAMID_ID).and_then(|c| c.data.as_ref()),
        out.df.get(&TICK_ID).and_then(|c| c.data.as_ref()),
    ) else {
        return Ok(HashMap::new());
    };
    let mut result = HashMap::new();
    for (row, (sid, tick)) in sids.iter().zip(row_ticks).enumerate() {
        let (Some(sid), Some(tick)) = (sid, tick) else { continue };
        if !steamids.contains(sid) {
            continue;
        }
        let mut vals = HashMap::new();
        for (id, name) in &ids {
            let Some(data) = out.df.get(id).and_then(|c| c.data.as_ref()) else { continue };
            match data {
                VarVec::XYZVec(x) => {
                    if let Some(Some(v)) = x.get(row) {
                        for (i, c) in v.iter().enumerate() {
                            vals.insert(format!("{name}_{i}"), *c as f64);
                        }
                    }
                }
                VarVec::XYVec(x) => {
                    if let Some(Some(v)) = x.get(row) {
                        for (i, c) in v.iter().enumerate() {
                            vals.insert(format!("{name}_{i}"), *c as f64);
                        }
                    }
                }
                _ => {
                    if let Some(v) = num_at(data, row) {
                        vals.insert(name.clone(), v);
                    }
                }
            }
        }
        result.insert((*sid, *tick), vals);
    }
    Ok(result)
}

/// A thrown grenade's position at a tick: which projectile (entity), whose, its class
/// (`CSmokeGrenadeProjectile`, `CMolotovProjectile`, `CFlashbangProjectile`, `CHEGrenadeProjectile`,
/// `CDecoyProjectile`) and where it is.
#[derive(Debug, Clone)]
pub struct ProjectilePoint {
    pub tick: i32,
    pub entity: i32,
    pub steamid: u64,
    pub class: String,
    pub xyz: [f32; 3],
}

/// Every grenade in flight at the given ticks.
pub fn projectiles(demo: &[u8], ticks: &[i32]) -> Result<Vec<ProjectilePoint>> {
    let out = run(demo, |i| {
        i.parse_projectiles = true;
        i.wanted_ticks = ticks.to_vec();
    })?;
    let col = |id: u32| out.df.get(&id).and_then(|c| c.data.as_ref());
    let (Some(VarVec::I32(t)), Some(VarVec::I32(e)), Some(VarVec::U64(s)), Some(VarVec::String(c)), Some(VarVec::F32(x)), Some(VarVec::F32(y)), Some(VarVec::F32(z))) =
        (col(TICK_ID), col(ENTITY_ID_ID), col(STEAMID_ID), col(GRENADE_TYPE_ID), col(GRENADE_X), col(GRENADE_Y), col(GRENADE_Z))
    else {
        return Ok(vec![]);
    };
    let mut points = vec![];
    for row in 0..t.len() {
        let (Some(Some(tick)), Some(Some(entity)), Some(Some(steamid)), Some(Some(class)), Some(Some(x)), Some(Some(y)), Some(Some(z))) =
            (t.get(row), e.get(row), s.get(row), c.get(row), x.get(row), y.get(row), z.get(row))
        else {
            continue;
        };
        points.push(ProjectilePoint { tick: *tick, entity: *entity, steamid: *steamid, class: class.clone(), xyz: [*x, *y, *z] });
    }
    Ok(points)
}
