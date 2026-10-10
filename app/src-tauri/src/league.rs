//! The user's ESEA league team (FACEIT team leagues): season, division, record and placement,
//! roster, conference standings, every player's stats in the division and the team's league
//! matches. All from FACEIT's public endpoints (the ones faceit.com's league pages use); no login.
//! Cached in `league.json`.

use anyhow::{bail, Context, Result};
use cs2hl_core::faceit::Faceit;
use serde_json::{json, Value};
use std::path::Path;
use std::time::Duration;

/// Refreshed at most this often unless asked.
const MAX_AGE_S: i64 = 20 * 60;
/// FACEIT returns at most 100 per page; a conference has ~100-120 teams, a division ~600 players.
const PAGE: usize = 100;
const MAX_PAGES: usize = 8;

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(12))
        .user_agent(concat!("Veloxify/", env!("CARGO_PKG_VERSION")))
        .build()
}

fn get(agent: &ureq::Agent, url: &str) -> Result<Value> {
    let v: Value = agent.get(url).call().with_context(|| format!("FACEIT: {url}"))?.into_json()?;
    Ok(v.get("payload").cloned().unwrap_or(v))
}

/// FACEIT said "too many requests" and kept saying it: stop for now, carry on next time.
#[derive(Debug)]
struct Busy;
impl std::fmt::Display for Busy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("FACEIT is busy (too many requests); the rest is read next time")
    }
}
impl std::error::Error for Busy {}

/// Like `get`, waiting when FACEIT says "too many requests" (as long as it asks, else 10, 30,
/// then 60 seconds) before giving up with `Busy`.
fn get_patient(agent: &ureq::Agent, url: &str) -> Result<Value> {
    for backoff in [10u64, 30, 60, 0] {
        match agent.get(url).call() {
            Ok(r) => {
                let v: Value = r.into_json()?;
                return Ok(v.get("payload").cloned().unwrap_or(v));
            }
            Err(ureq::Error::Status(429, r)) => {
                if backoff == 0 {
                    break;
                }
                let wait = r.header("retry-after").and_then(|s| s.trim().parse::<u64>().ok()).unwrap_or(backoff).min(120);
                std::thread::sleep(Duration::from_secs(wait));
            }
            Err(e) => return Err(anyhow::Error::new(e).context(format!("FACEIT: {url}"))),
        }
    }
    Err(Busy.into())
}

/// A league game's competition, as FACEIT names it: "S59 NA Open9-10 East A - Regular Season".
pub fn is_league(competition: &str) -> bool {
    let c = competition.trim();
    let digits = c.strip_prefix('S').map(|r| r.chars().take_while(|ch| ch.is_ascii_digit()).count()).unwrap_or(0);
    digits > 0 && c.chars().nth(1 + digits) == Some(' ')
}

/// The league data, from the cache when it's fresh (or FACEIT can't be reached).
pub fn league(lib: &Path, force: bool) -> Result<Value> {
    let path = lib.join("league.json");
    let cached: Option<Value> = std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str(&t).ok());
    let now = chrono::Utc::now().timestamp();
    if let Some(c) = &cached {
        if !force && c.get("fetched_at").and_then(Value::as_i64).is_some_and(|t| now - t < MAX_AGE_S) {
            return Ok(c.clone());
        }
    }
    match fetch(lib) {
        Ok(v) => {
            let _ = std::fs::write(&path, serde_json::to_string(&v)?);
            Ok(v)
        }
        Err(e) => match cached {
            Some(mut c) => {
                c["stale"] = json!(e.to_string());
                Ok(c)
            }
            None => Err(e),
        },
    }
}

fn fetch(lib: &Path) -> Result<Value> {
    let f = Faceit::load(lib).context("Your FACEIT account isn't known yet")?;
    if f.player_id.is_empty() {
        bail!("Your FACEIT account isn't known yet");
    }
    let Some(game) = f.matches.iter().find(|m| is_league(&m.competition)) else {
        return Ok(json!({ "fetched_at": chrono::Utc::now().timestamp(), "none": true }));
    };
    let agent = agent();
    // Your team: the faction of your newest league game with you on it.
    let room = get(&agent, &format!("https://api.faceit.com/match/v2/match/{}", game.match_id))?;
    let team_id = room["teams"]
        .as_object()
        .and_then(|teams| {
            teams.values().find(|t| t["roster"].as_array().is_some_and(|r| r.iter().any(|p| p["id"].as_str() == Some(f.player_id.as_str()))))
        })
        .and_then(|t| t["id"].as_str())
        .context("couldn't find your team in your last league match")?
        .to_string();
    let championship = room["entity"]["id"].as_str().unwrap_or_default().to_string();

    let current = get(&agent, &format!("https://api.faceit.com/team-leagues/v1/teams/{team_id}/profile/leagues/current"))?;
    let summary = get(&agent, &format!("https://api.faceit.com/team-leagues/v1/teams/{team_id}/profile/leagues/summary"))?;
    let league_id = current["league_id"].as_str().unwrap_or_default();
    let roster = summary
        .as_array()
        .and_then(|a| a.iter().find(|l| l["league_id"].as_str() == Some(league_id)))
        .map(|l| l["active_members"].clone())
        .unwrap_or(json!([]));
    let championship = current["championship_id"].as_str().filter(|c| !c.is_empty()).map(str::to_string).unwrap_or(championship);

    // Every team in your conference.
    let mut standings = vec![];
    if let Some(conf) = current["season_standing"]["conference_id"].as_str() {
        for page in 0..MAX_PAGES {
            let p = get(&agent, &format!("https://api.faceit.com/team-leagues/v2/standings?entityId={conf}&entityType=conference&offset={}&limit={PAGE}", page * PAGE))?;
            let rows = p["standings"].as_array().cloned().unwrap_or_default();
            let n = rows.len();
            standings.extend(rows);
            if n < PAGE {
                break;
            }
        }
    }
    // Every player's stats in the division (FACEIT's stat keys; labels below).
    let mut players = vec![];
    if !championship.is_empty() {
        for page in 0..MAX_PAGES {
            let p = get(&agent, &format!("https://api.faceit.com/stats/v1/competitions/{championship}/players?page={page}&size={PAGE}&sort=stats.m2,desc"))?;
            let rows = p["players"].as_array().cloned().unwrap_or_default();
            let n = rows.len();
            players.extend(rows);
            if n < PAGE {
                break;
            }
        }
    }
    let labels: Value = get(&agent, "https://api.faceit.com/stats/v1/stats/configuration/cs2")
        .ok()
        .and_then(|c| c["mapping"].as_object().cloned())
        .map(|m| m.into_iter().filter_map(|(k, v)| v["label"]["en"].as_str().map(|l| (k, json!(l)))).collect::<serde_json::Map<_, _>>().into())
        .unwrap_or(json!({}));
    // Your team's league matches, played and to come.
    let matches = |status: &str| -> Value {
        get(
            &agent,
            &format!(
                "https://api.faceit.com/team-leagues/v2/matches?championship_ids={championship}&entityId={team_id}&entityType=PREMADE_TEAM&status={status}&offset=0&limit=40"
            ),
        )
        .unwrap_or(json!([]))
    };
    let (finished, scheduled) = (matches("MATCH_STATUS_FINISHED"), matches("MATCH_STATUS_SCHEDULED"));
    let team = get(&agent, &format!("https://api.faceit.com/teams/v3/teams/{team_id}")).unwrap_or(json!({}));

    Ok(json!({
        "fetched_at": chrono::Utc::now().timestamp(),
        "team_id": team_id,
        "team": { "name": team["name"], "nickname": team["nickname"], "avatar": team["avatar"] },
        "championship_id": championship,
        "competition": game.competition,
        "league": { "id": league_id, "name": current["league_name"], "avatar": current["league_avatar_img"], "season": current["season_number"], "season_id": current["season_id"] },
        "standing": current["season_standing"],
        "roster": roster,
        "standings": standings,
        "players": players,
        "labels": labels,
        "finished": finished,
        "scheduled": scheduled,
    }))
}

/// To be ranked, a player needs this share of the games played so far this season.
const MIN_SHARE: f64 = 0.7;
/// The per-player numbers kept from FACEIT's match stats (summed over a player's maps).
const SUMS: &[(&str, &str)] = &[
    ("i6", "kills"),
    ("i7", "assists"),
    ("i8", "deaths"),
    ("i9", "mvps"),
    ("i13", "headshots"),
    ("i40", "k2"),
    ("i14", "k3"),
    ("i15", "k4"),
    ("i16", "k5"),
    ("i20", "damage"),
    ("i21", "entry_tries"),
    ("i22", "entry_wins"),
    ("i23", "v1_tries"),
    ("i24", "v1_wins"),
    ("i25", "v2_tries"),
    ("i26", "v2_wins"),
    ("i27", "flashed"),
    ("i30", "utility_damage"),
    ("i34", "clutch_kills"),
    ("i35", "first_kills"),
    ("i38", "pistol_kills"),
    ("i39", "sniper_kills"),
];

/// Every player in your conference this season, from each league match's FACEIT stats (cached
/// in `league_matches.json`: finished matches never change, so each is fetched once): totals,
/// K/R, ADR, HLTV Rating 1.0, and whether they've played enough games to be ranked.
pub fn division(lib: &Path) -> Result<Value> {
    let lg = league(lib, false)?;
    let championship = lg["championship_id"].as_str().unwrap_or_default().to_string();
    if championship.is_empty() {
        bail!("no league season found");
    }
    let standings = lg["standings"].as_array().cloned().unwrap_or_default();
    let teams: Vec<String> = standings.iter().filter_map(|t| t["premade_team_id"].as_str().map(String::from)).collect();
    let path = lib.join("league_matches.json");
    let mut cache: Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .filter(|c| c["championship"].as_str() == Some(championship.as_str()))
        .unwrap_or_else(|| json!({ "championship": championship, "teams": {}, "stats": {} }));
    let agent = agent();
    let now = chrono::Utc::now().timestamp();
    // FACEIT allows a request every so often: keep well under it.
    let pause = || std::thread::sleep(Duration::from_millis(1000));
    let mut changed = false;
    let mut busy = false;
    // Each team's finished league matches, read again once the standings say it played more.
    let played_by: std::collections::HashMap<&str, usize> =
        standings.iter().filter_map(|t| Some((t["premade_team_id"].as_str()?, t["matches"].as_u64().unwrap_or(0) as usize))).collect();
    for t in &teams {
        let known = cache["teams"][t]["matches"].as_array().map(|a| a.len());
        if known.is_some_and(|k| k >= played_by.get(t.as_str()).copied().unwrap_or(0)) {
            continue;
        }
        let url = format!(
            "https://api.faceit.com/team-leagues/v2/matches?championship_ids={championship}&entityId={t}&entityType=PREMADE_TEAM&status=MATCH_STATUS_FINISHED&offset=0&limit=40"
        );
        match get_patient(&agent, &url) {
            Ok(v) => {
                // Each match lists both teams: the opponent's games are known too.
                let items = v.as_array().or_else(|| v["items"].as_array()).cloned().unwrap_or_default();
                for m in &items {
                    let Some(id) = m["id"].as_str() else { continue };
                    let sides: Vec<String> = m["factions"].as_array().into_iter().flatten().filter_map(|f| f["premade_team_id"].as_str().map(String::from)).collect();
                    for side in sides.iter().chain(std::iter::once(t)) {
                        if cache["teams"][side.as_str()].is_null() {
                            cache["teams"][side.as_str()] = json!({ "matches": [] });
                        }
                        let list = cache["teams"][side.as_str()]["matches"].as_array_mut().expect("matches is a list");
                        if !list.iter().any(|x| x.as_str() == Some(id)) {
                            list.push(json!(id));
                        }
                    }
                }
                cache["teams"][t.as_str()]["checked"] = json!(now);
                changed = true;
            }
            Err(e) if e.downcast_ref::<Busy>().is_some() => {
                busy = true;
                break;
            }
            Err(_) => {}
        }
        pause();
    }
    // Each match's stats, once.
    let ids: std::collections::BTreeSet<String> = cache["teams"]
        .as_object()
        .into_iter()
        .flat_map(|o| o.values())
        .flat_map(|t| t["matches"].as_array().cloned().unwrap_or_default())
        .filter_map(|v| v.as_str().map(String::from))
        .collect();
    for id in &ids {
        if busy || cache["stats"].get(id).is_some() {
            continue;
        }
        match get_patient(&agent, &format!("https://api.faceit.com/stats/v1/stats/matches/{id}")) {
            Ok(v) if v.as_array().is_some_and(|maps| !maps.is_empty()) => {
                cache["stats"][id.as_str()] = slim(&v);
                changed = true;
            }
            Err(e) if e.downcast_ref::<Busy>().is_some() => busy = true,
            _ => {}
        }
        pause();
    }
    if changed {
        let _ = std::fs::write(&path, serde_json::to_string(&cache)?);
    }

    // Games played so far this season: the typical team's count.
    let mut played: Vec<i64> = standings.iter().filter_map(|t| t["matches"].as_i64()).filter(|n| *n > 0).collect();
    played.sort_unstable();
    let season_games = played.get(played.len() / 2).copied().unwrap_or(0);
    let min_games = ((season_games as f64 * MIN_SHARE).ceil() as i64).max(1);

    struct P {
        nickname: String,
        team: String,
        matches: std::collections::BTreeSet<String>,
        maps: u32,
        rounds: f64,
        sums: std::collections::HashMap<&'static str, f64>,
    }
    let mut players: std::collections::BTreeMap<String, P> = Default::default();
    let n = |v: &Value| v.as_str().and_then(|s| s.parse::<f64>().ok()).or_else(|| v.as_f64()).unwrap_or(0.0);
    for (mid, maps) in cache["stats"].as_object().into_iter().flatten() {
        for m in maps.as_array().into_iter().flatten() {
            let rounds = n(&m["rounds"]);
            for team in m["teams"].as_array().into_iter().flatten() {
                for pl in team["players"].as_array().into_iter().flatten() {
                    let Some(id) = pl["playerId"].as_str() else { continue };
                    let p = players.entry(id.to_string()).or_insert_with(|| P {
                        nickname: String::new(),
                        team: String::new(),
                        matches: Default::default(),
                        maps: 0,
                        rounds: 0.0,
                        sums: Default::default(),
                    });
                    p.nickname = pl["nickname"].as_str().unwrap_or_default().to_string();
                    p.team = team["name"].as_str().unwrap_or_default().to_string();
                    p.matches.insert(mid.clone());
                    p.maps += 1;
                    p.rounds += rounds;
                    for (k, name) in SUMS {
                        *p.sums.entry(name).or_default() += n(&pl[*k]);
                    }
                }
            }
        }
    }
    let out: Vec<Value> = players
        .into_iter()
        .filter(|(_, p)| p.rounds > 0.0)
        .map(|(id, p)| {
            let g = |k: &str| p.sums.get(k).copied().unwrap_or(0.0);
            let (k, d, r) = (g("kills"), g("deaths"), p.rounds);
            let (k2, k3, k4, k5) = (g("k2"), g("k3"), g("k4"), g("k5"));
            // HLTV Rating 1.0: kills, survival and multi-kill rounds per round against the averages.
            let k1 = (k - 2.0 * k2 - 3.0 * k3 - 4.0 * k4 - 5.0 * k5).max(0.0);
            let rating1 = (k / r / 0.679 + 0.7 * ((r - d).max(0.0) / r) / 0.317 + (k1 + 4.0 * k2 + 9.0 * k3 + 16.0 * k4 + 25.0 * k5) / r / 1.277) / 2.7;
            let games = p.matches.len() as i64;
            let mut v = json!({
                "id": id,
                "nickname": p.nickname,
                "team": p.team,
                "matches": games,
                "maps": p.maps,
                "rounds": r,
                "kr": k / r,
                "kd": k / d.max(1.0),
                "adr": g("damage") / r,
                "hs": if k > 0.0 { g("headshots") / k * 100.0 } else { 0.0 },
                "rating1": rating1,
                "multi": k3 + k4 + k5,
                "eligible": games >= min_games,
            });
            for (_, name) in SUMS {
                v[*name] = json!(g(name));
            }
            v
        })
        .collect();
    Ok(json!({
        "fetched_at": now,
        "season_games": season_games,
        "min_games": min_games,
        "min_share": MIN_SHARE,
        "matches_read": cache["stats"].as_object().map_or(0, |o| o.len()),
        "matches_known": ids.len(),
        "teams_read": teams
            .iter()
            .filter(|t| cache["teams"][t.as_str()]["matches"].as_array().map_or(0, |a| a.len()) >= played_by.get(t.as_str()).copied().unwrap_or(0))
            .count(),
        "teams": teams.len(),
        "busy": busy,
        "players": out,
    }))
}

/// A match's stats, only what the division table uses: per map, its rounds, and each team's name
/// and players' numbers.
fn slim(v: &Value) -> Value {
    let maps: Vec<Value> = v
        .as_array()
        .into_iter()
        .flatten()
        .map(|m| {
            let teams: Vec<Value> = m["teams"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|t| {
                    let players: Vec<Value> = t["players"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(|p| {
                            let mut o = serde_json::Map::new();
                            for k in ["playerId", "nickname"].into_iter().chain(SUMS.iter().map(|(k, _)| *k)) {
                                if let Some(x) = p.get(k) {
                                    o.insert(k.to_string(), x.clone());
                                }
                            }
                            Value::Object(o)
                        })
                        .collect();
                    json!({ "name": t["i5"], "id": t["teamId"], "players": players })
                })
                .collect();
            json!({ "rounds": m["i12"], "map": m["i1"], "teams": teams })
        })
        .collect();
    Value::Array(maps)
}

#[cfg(test)]
mod tests {
    #[test]
    fn league_names() {
        assert!(super::is_league("S59 NA Open9-10 East A - Regular Season"));
        assert!(!super::is_league("North America 5V5 Queue"));
        assert!(!super::is_league("Super Match"));
    }
}
