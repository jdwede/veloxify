//! FACEIT data for the library owner (account, level, ELO, recent matches), kept in
//! `library/faceit.json`. The desktop app fetches it; this module holds the data and how it maps
//! onto library matches (real match times, ELO per match).

use serde::{Deserialize, Serialize};
use std::path::Path;

pub const FILE: &str = "faceit.json";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Faceit {
    /// Unix seconds.
    pub fetched_at: i64,
    /// The SteamID64 this account was matched to (FACEIT's linked Steam account).
    pub steamid: String,
    pub player_id: String,
    pub nickname: String,
    pub avatar: String,
    pub country: String,
    pub region: String,
    pub level: u32,
    pub elo: u32,
    pub lifetime: Lifetime,
    /// Newest first.
    pub matches: Vec<FaceitMatch>,
    /// Why there is no account data (e.g. no FACEIT account linked to this Steam account).
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Lifetime {
    pub matches: u32,
    pub wins: u32,
    /// Percent.
    pub win_rate: f64,
    pub kd: f64,
    pub hs_pct: f64,
    pub longest_win_streak: u32,
    pub current_win_streak: u32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct FaceitMatch {
    /// FACEIT match id, e.g. `1-293aaa2c-0eb3-4534-a853-607971984b10`.
    pub match_id: String,
    /// Map number within the match (1 for a best-of-one).
    pub map_number: u32,
    /// Unix seconds. `started_ts` comes from the match room and is 0 until it has been fetched.
    pub started_ts: i64,
    pub finished_ts: i64,
    pub map: String,
    pub score_mine: u32,
    pub score_theirs: u32,
    pub result: String,
    pub kills: u32,
    pub assists: u32,
    pub deaths: u32,
    pub headshots: u32,
    pub mvps: u32,
    pub adr: f64,
    pub kd: f64,
    pub kr: f64,
    pub hs_pct: f64,
    /// ELO after this match and the change it brought (FACEIT leaves these out for placement
    /// matches and some others, e.g. league games).
    pub elo: Option<u32>,
    pub elo_delta: Option<i32>,
    /// Average ELO of each team, from the match room.
    pub team_elo: Option<u32>,
    pub enemy_elo: Option<u32>,
    /// A placement match of a new season: FACEIT shows no ELO until placements are done.
    pub calibrating: bool,
    /// Whether the match room was read (start time, team ELO, placement).
    pub detailed: bool,
}

impl FaceitMatch {
    /// The id this match's demo gets in the library (see `library::demo_id`).
    pub fn library_id(&self) -> String {
        format!("faceit-{}-m{}", self.match_id.strip_prefix("1-").unwrap_or(&self.match_id), self.map_number.max(1))
    }

    /// When the map started; without the match room, estimated from the finish time.
    pub fn started(&self, duration_s: u32) -> i64 {
        if self.started_ts > 0 {
            self.started_ts
        } else {
            self.finished_ts - duration_s as i64
        }
    }
}

/// FACEIT CS2 skill level for an ELO.
pub fn level_for(elo: u32) -> u32 {
    match elo {
        0..=500 => 1,
        501..=750 => 2,
        751..=900 => 3,
        901..=1050 => 4,
        1051..=1200 => 5,
        1201..=1350 => 6,
        1351..=1530 => 7,
        1531..=1750 => 8,
        1751..=2000 => 9,
        _ => 10,
    }
}

impl Faceit {
    pub fn load(root: &Path) -> Option<Self> {
        serde_json::from_str(&std::fs::read_to_string(root.join(FILE)).ok()?).ok()
    }

    pub fn save(&self, root: &Path) -> std::io::Result<()> {
        let tmp = root.join(format!("{FILE}.tmp"));
        std::fs::write(&tmp, serde_json::to_string_pretty(self).unwrap_or_default())?;
        std::fs::rename(tmp, root.join(FILE))
    }

    pub fn find(&self, library_id: &str) -> Option<&FaceitMatch> {
        self.matches.iter().find(|m| m.library_id() == library_id)
    }
}
