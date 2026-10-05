//! Finds the user's FACEIT account from their Steam account and keeps `library/faceit.json`
//! current: level, ELO, lifetime stats and recent matches.
//!
//! Uses the public endpoints faceit.com's own profile pages read, so there is nothing to
//! connect: no API key and no login. An account is only accepted when the Steam ID linked to it
//! on FACEIT is the user's.

use anyhow::{bail, Context, Result};
use cs2hl_core::faceit::{Faceit, FaceitMatch, Lifetime};
use serde_json::Value;
use std::path::Path;
use std::time::Duration;

const API: &str = "https://api.faceit.com";
/// Match rooms read per refresh (start time, team ELO); older ones follow on later refreshes.
const ROOMS_PER_REFRESH: usize = 40;
/// Matches kept in `faceit.json`, newest first; each refresh adds to what's there.
const KEEP: usize = 300;

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(15))
        .user_agent(concat!("Veloxify/", env!("CARGO_PKG_VERSION")))
        .build()
}

fn get(agent: &ureq::Agent, url: &str) -> Result<Value> {
    Ok(agent.get(url).call()?.into_json()?)
}

/// FACEIT sends most numbers as strings.
fn num(v: &Value) -> f64 {
    v.as_str().and_then(|s| s.trim().parse().ok()).or_else(|| v.as_f64()).unwrap_or(0.0)
}

fn ts(v: &Value) -> i64 {
    v.as_str().and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok()).map(|d| d.timestamp()).unwrap_or(0)
}

fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

fn linked_to(user: &Value, steamid: u64) -> bool {
    let s = steamid.to_string();
    user["platforms"]["steam"]["id64"].as_str() == Some(s.as_str()) || user["games"]["cs2"]["game_id"].as_str() == Some(s.as_str())
}

/// The FACEIT account linked to `steamid`: the account found last time, else each candidate
/// nickname (names the user played under on FACEIT servers, their Steam name, ...).
fn find_user(agent: &ureq::Agent, steamid: u64, known_id: Option<&str>, candidates: &[String]) -> Result<Value> {
    if let Some(id) = known_id.filter(|s| !s.is_empty()) {
        if let Ok(v) = get(agent, &format!("{API}/users/v1/users/{id}")) {
            if linked_to(&v["payload"], steamid) {
                return Ok(v["payload"].clone());
            }
        }
    }
    for name in candidates.iter().filter(|n| !n.trim().is_empty()) {
        if let Ok(v) = get(agent, &format!("{API}/users/v1/nicknames/{}", encode(name.trim()))) {
            if linked_to(&v["payload"], steamid) {
                return Ok(v["payload"].clone());
            }
        }
    }
    bail!("No FACEIT account is linked to this Steam account")
}

fn parse_match(m: &Value) -> Option<FaceitMatch> {
    let match_id = m["matchId"].as_str()?.to_string();
    let won = m["i10"].as_str() == Some("1");
    // "13 / 16" lists the teams in FACEIT's order, not ours; the winner has the higher score.
    let mut score = m["i18"].as_str().unwrap_or("").split('/').map(|x| x.trim().parse::<u32>().unwrap_or(0));
    let (a, b) = (score.next().unwrap_or(0), score.next().unwrap_or(0));
    let (score_mine, score_theirs) = if won { (a.max(b), a.min(b)) } else { (a.min(b), a.max(b)) };
    Some(FaceitMatch {
        match_id,
        map_number: num(&m["matchRound"]).max(1.0) as u32,
        finished_ts: num(&m["date"]) as i64 / 1000,
        map: m["i1"].as_str().unwrap_or("").to_string(),
        score_mine,
        score_theirs,
        result: if won { "win" } else { "loss" }.into(),
        kills: num(&m["i6"]) as u32,
        assists: num(&m["i7"]) as u32,
        deaths: num(&m["i8"]) as u32,
        mvps: num(&m["i9"]) as u32,
        headshots: num(&m["i13"]) as u32,
        kd: num(&m["c2"]),
        kr: num(&m["c3"]),
        hs_pct: num(&m["c4"]),
        adr: num(&m["c10"]),
        elo: m["elo"].as_str().and_then(|s| s.parse().ok()),
        elo_delta: m["elo_delta"].as_str().and_then(|s| s.parse().ok()),
        ..Default::default()
    })
}

/// Start time, average team ELO and placement status from the match room.
fn read_room(fm: &mut FaceitMatch, room: &Value, player_id: &str) {
    if fm.map_number <= 1 {
        fm.started_ts = ts(&room["startedAt"]);
    }
    let teams = &room["teams"];
    let mine = ["faction1", "faction2"]
        .into_iter()
        .find(|f| teams[*f]["roster"].as_array().is_some_and(|r| r.iter().any(|p| p["id"].as_str() == Some(player_id))));
    if let Some(mine) = mine {
        fm.calibrating = teams[mine]["roster"]
            .as_array()
            .and_then(|r| r.iter().find(|p| p["id"].as_str() == Some(player_id)))
            .and_then(|p| p["calibratingActive"].as_bool())
            .unwrap_or(false);
        let theirs = if mine == "faction1" { "faction2" } else { "faction1" };
        let avg = |f: &str| {
            let elos: Vec<f64> = teams[f]["roster"].as_array()?.iter().map(|p| num(&p["elo"])).filter(|e| *e > 0.0).collect();
            (!elos.is_empty()).then(|| (elos.iter().sum::<f64>() / elos.len() as f64).round() as u32)
        };
        fm.team_elo = avg(mine);
        fm.enemy_elo = avg(theirs);
    }
}

/// Fetches the account and recent matches and saves `faceit.json`. Returns whether anything
/// the library shows changed (new matches, ELO, times).
///
/// `light` is the refresh that runs while CS2 is open, so a session's finished matches show up
/// between games: only the newest few matches and their rooms (two or three small requests);
/// lifetime stats and older rooms wait for the next full refresh.
pub fn refresh(root: &Path, steamid: u64, candidates: &[String], light: bool) -> Result<(Faceit, bool)> {
    let agent = agent();
    let old = Faceit::load(root).filter(|f| f.steamid == steamid.to_string());
    let user = find_user(&agent, steamid, old.as_ref().map(|f| f.player_id.as_str()), candidates)?;
    let id = user["id"].as_str().context("FACEIT player id")?.to_string();
    let cs2 = &user["games"]["cs2"];

    let lifetime = match old.as_ref().filter(|_| light) {
        Some(o) => o.lifetime.clone(),
        None => {
            let life = get(&agent, &format!("{API}/stats/v1/stats/users/{id}/games/cs2"))?;
            let l = &life["lifetime"];
            Lifetime {
                matches: num(&l["m1"]) as u32,
                wins: num(&l["m2"]) as u32,
                win_rate: num(&l["k6"]),
                kd: num(&l["k5"]),
                hs_pct: num(&l["k8"]),
                longest_win_streak: num(&l["s2"]) as u32,
                current_win_streak: num(&l["s1"]) as u32,
            }
        }
    };

    let size = if light { 10 } else { 100 };
    let list = get(&agent, &format!("{API}/stats/v1/stats/time/users/{id}/games/cs2?page=0&size={size}"))?;
    let mut matches: Vec<FaceitMatch> = list.as_array().into_iter().flatten().filter_map(parse_match).collect();
    // What earlier refreshes learned from match rooms is kept, so each room is read only once.
    for fm in matches.iter_mut() {
        if let Some(prev) = old.as_ref().and_then(|o| o.matches.iter().find(|p| p.match_id == fm.match_id && p.map_number == fm.map_number)) {
            if prev.detailed {
                fm.started_ts = prev.started_ts;
                fm.team_elo = prev.team_elo;
                fm.enemy_elo = prev.enemy_elo;
                fm.calibrating = prev.calibrating;
                fm.detailed = true;
            }
        }
    }
    // Older matches from earlier refreshes stay.
    let fetched = matches.len();
    for p in old.iter().flat_map(|o| o.matches.iter()) {
        if !matches.iter().any(|m| m.match_id == p.match_id && m.map_number == p.map_number) {
            matches.push(p.clone());
        }
    }
    matches.sort_by_key(|m| std::cmp::Reverse(m.finished_ts));
    matches.truncate(KEEP);

    let (window, budget) = if light { (fetched, 5) } else { (matches.len(), ROOMS_PER_REFRESH) };
    let mut read = 0;
    for i in 0..window.min(matches.len()) {
        if matches[i].detailed || read >= budget {
            continue;
        }
        let Ok(room) = get(&agent, &format!("{API}/match/v2/match/{}", matches[i].match_id)) else { break };
        read_room(&mut matches[i], &room["payload"], &id);
        matches[i].detailed = true;
        read += 1;
        std::thread::sleep(Duration::from_millis(150));
    }
    // Later maps of a series start when the previous map finished.
    for i in 0..matches.len() {
        if matches[i].map_number > 1 && matches[i].started_ts == 0 {
            let prev = matches.iter().find(|p| p.match_id == matches[i].match_id && p.map_number == matches[i].map_number - 1).map(|p| p.finished_ts);
            matches[i].started_ts = prev.unwrap_or(0);
        }
    }

    let f = Faceit {
        fetched_at: chrono::Utc::now().timestamp(),
        steamid: steamid.to_string(),
        player_id: id,
        nickname: user["nickname"].as_str().unwrap_or("").into(),
        avatar: user["avatar"].as_str().unwrap_or("").into(),
        country: user["country"].as_str().unwrap_or("").into(),
        region: cs2["region"].as_str().unwrap_or("").into(),
        level: num(&cs2["skill_level"]) as u32,
        elo: num(&cs2["faceit_elo"]) as u32,
        lifetime,
        matches,
        error: None,
    };
    let changed = old.as_ref().map_or(true, |o| {
        serde_json::to_string(&o.matches).ok() != serde_json::to_string(&f.matches).ok() || o.elo != f.elo || o.level != f.level
    });
    f.save(root)?;
    Ok((f, changed))
}
