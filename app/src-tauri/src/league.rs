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

#[cfg(test)]
mod tests {
    #[test]
    fn league_names() {
        assert!(super::is_league("S59 NA Open9-10 East A - Regular Season"));
        assert!(!super::is_league("North America 5V5 Queue"));
        assert!(!super::is_league("Super Match"));
    }
}
