//! Player avatars (from Steam profiles) and FACEIT ranks (from FACEIT's match rosters) for the
//! match page and profile, cached in the library so each is fetched once (avatars refresh weekly).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

const AVATAR_MAX_AGE_S: i64 = 7 * 24 * 3600;
/// Fetched per call at most (a match page needs ten).
const MAX_FETCH: usize = 12;

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(10))
        .user_agent(concat!("Veloxify/", env!("CARGO_PKG_VERSION")))
        .build()
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

#[derive(Default, Serialize, Deserialize)]
struct AvatarCache {
    /// steamid -> (avatar url, "" when the profile has none or is private, fetched at)
    avatars: HashMap<String, (String, i64)>,
}

/// Steam avatar URLs (medium size) for these players; "" when unknown.
pub fn avatars(lib: &Path, ids: &[String]) -> HashMap<String, String> {
    let path = lib.join("avatars.json");
    let mut cache: AvatarCache = std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    let stale: Vec<&String> = ids
        .iter()
        .filter(|id| id.chars().all(|c| c.is_ascii_digit()) && cache.avatars.get(*id).is_none_or(|(_, at)| now() - at > AVATAR_MAX_AGE_S))
        .take(MAX_FETCH)
        .collect();
    if !stale.is_empty() {
        let agent = agent();
        for id in stale {
            // The public profile's XML view has the avatar; no API key needed.
            let url = format!("https://steamcommunity.com/profiles/{id}/?xml=1");
            let Ok(text) = agent.get(&url).call().and_then(|r| Ok(r.into_string()?)) else { continue };
            let avatar = text
                .split("<avatarMedium><![CDATA[")
                .nth(1)
                .and_then(|r| r.split("]]>").next())
                .filter(|u| u.starts_with("https://"))
                .unwrap_or("")
                .to_string();
            cache.avatars.insert(id.clone(), (avatar, now()));
        }
        let _ = std::fs::write(&path, serde_json::to_string(&cache).unwrap_or_default());
    }
    ids.iter().map(|id| (id.clone(), cache.avatars.get(id).map(|(u, _)| u.clone()).unwrap_or_default())).collect()
}

#[derive(Clone, Default, Serialize, Deserialize)]
pub struct FaceitPlayer {
    pub nickname: String,
    pub elo: u32,
    pub level: u32,
    pub party: String,
}

/// FACEIT ELO and level of everyone in a FACEIT match (as FACEIT's room shows them), by steamid.
pub fn faceit_roster(lib: &Path, match_id: &str) -> HashMap<String, FaceitPlayer> {
    let path = lib.join("faceit_rosters.json");
    let mut cache: HashMap<String, HashMap<String, FaceitPlayer>> =
        std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    if let Some(r) = cache.get(match_id) {
        return r.clone();
    }
    if !match_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return HashMap::new();
    }
    let url = format!("https://api.faceit.com/match/v2/match/{match_id}");
    let Ok(v) = agent().get(&url).call().and_then(|r| Ok(r.into_json::<serde_json::Value>()?)) else { return HashMap::new() };
    let mut out = HashMap::new();
    for faction in ["faction1", "faction2"] {
        for p in v["payload"]["teams"][faction]["roster"].as_array().into_iter().flatten() {
            let Some(sid) = p["gameId"].as_str().filter(|s| !s.is_empty()) else { continue };
            out.insert(
                sid.to_string(),
                FaceitPlayer {
                    nickname: p["nickname"].as_str().unwrap_or("").into(),
                    elo: p["elo"].as_u64().unwrap_or(0) as u32,
                    level: p["gameSkillLevel"].as_u64().unwrap_or(0) as u32,
                    party: p["partyId"].as_str().unwrap_or("").into(),
                },
            );
        }
    }
    if !out.is_empty() {
        cache.insert(match_id.to_string(), out.clone());
        let _ = std::fs::write(&path, serde_json::to_string(&cache).unwrap_or_default());
    }
    out
}
