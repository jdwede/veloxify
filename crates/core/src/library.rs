//! The match library: what the UI reads. One JSON file per match plus an `index.json` with the
//! calendar (days → sessions → matches) and per-day, per-player aggregates.
//!
//! Steam IDs are written as strings because JavaScript numbers can't hold a u64 exactly.

use crate::analysis::Analysis;
use crate::highlights::{self, Highlight};
use crate::model::{Match, Source, TeamId, TICKRATE};
use crate::stats::{Counts, Derived, PlayerStats};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};

/// Which moments become clips: who gets them, how picky selection is, and how many per match.
#[derive(Debug, Clone)]
pub struct ClipPolicy {
    /// Players besides you whose highlights are also detected (opt-in; empty by default).
    pub also_clip: Vec<u64>,
    pub selectivity: highlights::Selectivity,
    pub max_per_player: usize,
}

impl Default for ClipPolicy {
    fn default() -> Self {
        Self { also_clip: vec![], selectivity: highlights::Selectivity::SolidPlays, max_per_player: highlights::MAX_PER_PLAYER }
    }
}

/// Matches closer together than this belong to the same session.
pub const SESSION_GAP_S: i64 = 3 * 3600;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlayerRow {
    pub steamid: String,
    pub name: String,
    /// "mine" or "enemy", relative to the library owner.
    pub side: String,
    pub party: bool,
    pub counts: Counts,
    pub derived: Derived,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HighlightEntry {
    pub id: String,
    pub player: String,
    pub round: u32,
    pub score: f64,
    pub title: String,
    pub tags: Vec<String>,
    pub duration_s: f64,
    pub segments: Vec<(i32, i32)>,
    /// Path relative to the library root once rendered.
    pub clip: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MatchEntry {
    pub id: String,
    pub source: String,
    pub map: String,
    /// Local time, RFC 3339 without offset (e.g. `2026-10-03T00:54:00`).
    pub played_at: String,
    /// Unix seconds, for sorting and session grouping.
    pub played_ts: i64,
    pub duration_s: u32,
    pub rounds: u32,
    pub score_mine: u32,
    pub score_theirs: u32,
    pub result: String,
    pub demo_path: String,
    pub players: Vec<PlayerRow>,
    pub highlights: Vec<HighlightEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DayPlayer {
    pub steamid: String,
    pub name: String,
    pub is_me: bool,
    pub counts: Counts,
    pub derived: Derived,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub match_ids: Vec<String>,
    pub start: String,
    pub end: String,
    pub wins: u32,
    pub losses: u32,
    pub ties: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Day {
    /// `YYYY-MM-DD` of the session start (late-night sessions stay on the day they began).
    pub date: String,
    pub sessions: Vec<Session>,
    pub highlight_count: u32,
    /// You first, then party members, by matches played together.
    pub players: Vec<DayPlayer>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Index {
    pub me: String,
    pub me_name: String,
    pub days: Vec<Day>,
    /// Lightweight per-match summaries for the match lists (full data lives in matches/<id>.json).
    pub matches: Vec<MatchSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MatchSummary {
    pub id: String,
    pub source: String,
    pub map: String,
    pub played_at: String,
    pub played_ts: i64,
    pub duration_s: u32,
    pub score_mine: u32,
    pub score_theirs: u32,
    pub result: String,
    pub highlight_count: u32,
}

/// Builds the library entry for one match from the perspective of `me`. `played_ts` comes from
/// the source (FACEIT/Valve match time) or, failing that, the demo file's timestamp.
/// Highlights are detected for `me` only, plus anyone in `policy.also_clip` (opt-in per player);
/// everyone else gets stats only.
pub fn match_entry(
    id: &str,
    demo_path: &str,
    played_ts: i64,
    played_at: &str,
    m: &Match,
    a: &Analysis,
    stats: &[PlayerStats],
    me: u64,
    policy: &ClipPolicy,
) -> Option<MatchEntry> {
    let my_team = m.team_of(me)?;
    let (mine, theirs) = match my_team {
        TeamId::A => (m.score_a, m.score_b),
        TeamId::B => (m.score_b, m.score_a),
    };
    let result = match mine.cmp(&theirs) {
        std::cmp::Ordering::Greater => "win",
        std::cmp::Ordering::Less => "loss",
        std::cmp::Ordering::Equal => "tie",
    };
    let players = stats
        .iter()
        .map(|s| PlayerRow {
            steamid: s.steamid.to_string(),
            name: s.name.clone(),
            side: if s.team == my_team { "mine" } else { "enemy" }.into(),
            party: false, // filled in once sessions are known
            counts: s.counts.clone(),
            derived: s.derived.clone(),
        })
        .collect();
    let mut hls: Vec<HighlightEntry> = m
        .players
        .iter()
        .filter(|p| p.steamid == me || policy.also_clip.contains(&p.steamid))
        .flat_map(|p| {
            highlights::detect(m, a, p.steamid)
                .into_iter()
                .filter(|h| h.score >= policy.selectivity.threshold())
                .take(policy.max_per_player)
        })
        .map(|h| highlight_entry(id, &h))
        .collect();
    hls.sort_by(|x, y| y.score.partial_cmp(&x.score).unwrap());
    let duration_ticks = m.rounds.last().map(|r| r.end_tick).unwrap_or(0) - m.rounds.first().map(|r| r.live_tick).unwrap_or(0);
    Some(MatchEntry {
        id: id.to_string(),
        source: match m.source {
            Source::Faceit => "faceit",
            Source::Valve => "valve",
            Source::Unknown => "unknown",
        }
        .into(),
        map: m.map.clone(),
        played_at: played_at.to_string(),
        played_ts,
        duration_s: (duration_ticks as f64 / TICKRATE) as u32,
        rounds: m.rounds.len() as u32,
        score_mine: mine,
        score_theirs: theirs,
        result: result.into(),
        demo_path: demo_path.to_string(),
        players,
        highlights: hls,
    })
}

fn highlight_entry(match_id: &str, h: &Highlight) -> HighlightEntry {
    HighlightEntry {
        id: format!("{match_id}-{}-r{}", h.player, h.round_number),
        player: h.player.to_string(),
        round: h.round_number,
        score: h.score,
        title: h.title.clone(),
        tags: h.tags.clone(),
        duration_s: h.duration_s,
        segments: h.segments.iter().map(|s| (s.start_tick, s.end_tick)).collect(),
        clip: None,
    }
}

/// Groups matches into sessions and days, marks party members, and aggregates per-day stats.
/// `date_of` maps a unix timestamp to the local `YYYY-MM-DD`.
pub fn build_index(me: u64, matches: &mut [MatchEntry], date_of: impl Fn(i64) -> String) -> Index {
    matches.sort_by_key(|m| m.played_ts);
    let me_s = me.to_string();

    // Sessions: consecutive matches less than SESSION_GAP_S apart (gap measured from match end).
    let mut sessions: Vec<Vec<usize>> = vec![];
    let mut last_end = i64::MIN;
    for (i, m) in matches.iter().enumerate() {
        if sessions.is_empty() || m.played_ts - last_end > SESSION_GAP_S {
            sessions.push(vec![]);
        }
        sessions.last_mut().unwrap().push(i);
        last_end = m.played_ts + m.duration_s as i64;
    }

    // Party: teammates who were on my side in at least two matches of the same session.
    for sess in &sessions {
        let mut together: HashMap<String, u32> = HashMap::new();
        for &i in sess {
            for p in matches[i].players.iter().filter(|p| p.side == "mine" && p.steamid != me_s) {
                *together.entry(p.steamid.clone()).or_default() += 1;
            }
        }
        for &i in sess {
            for p in matches[i].players.iter_mut() {
                p.party = p.side == "mine" && together.get(&p.steamid).copied().unwrap_or(0) >= 2;
            }
        }
    }

    // Only opted-in players' highlights exist in the first place, so every one counts.
    let counted = |m: &MatchEntry| -> u32 { m.highlights.len() as u32 };

    // Days.
    let mut by_day: BTreeMap<String, Vec<&Vec<usize>>> = BTreeMap::new();
    for sess in &sessions {
        by_day.entry(date_of(matches[sess[0]].played_ts)).or_default().push(sess);
    }
    let days = by_day
        .into_iter()
        .map(|(date, sess_list)| {
            let mut agg: HashMap<String, (String, Counts, u32)> = HashMap::new();
            let mut highlight_count = 0;
            let sessions = sess_list
                .iter()
                .map(|sess| {
                    let (mut w, mut l, mut t) = (0, 0, 0);
                    for &i in sess.iter() {
                        let m = &matches[i];
                        match m.result.as_str() {
                            "win" => w += 1,
                            "loss" => l += 1,
                            _ => t += 1,
                        }
                        highlight_count += counted(m);
                        for p in m.players.iter().filter(|p| p.steamid == me_s || p.party) {
                            let e = agg.entry(p.steamid.clone()).or_insert((p.name.clone(), Counts::default(), 0));
                            e.1 += &p.counts;
                            e.2 += 1;
                        }
                    }
                    let first = &matches[sess[0]];
                    let last = &matches[*sess.last().unwrap()];
                    Session {
                        match_ids: sess.iter().map(|&i| matches[i].id.clone()).collect(),
                        start: first.played_at.clone(),
                        end: last.played_at.clone(),
                        wins: w,
                        losses: l,
                        ties: t,
                    }
                })
                .collect();
            let mut players: Vec<DayPlayer> = agg
                .into_iter()
                .map(|(sid, (name, counts, n))| {
                    let derived = counts.derived();
                    let is_me = sid == me_s;
                    (n, DayPlayer { steamid: sid, name, is_me, counts, derived })
                })
                .map(|(_, p)| p)
                .collect();
            players.sort_by(|a, b| b.is_me.cmp(&a.is_me).then(b.counts.matches.cmp(&a.counts.matches)));
            Day { date, sessions, highlight_count, players }
        })
        .collect();

    let me_name = matches
        .iter()
        .rev()
        .flat_map(|m| m.players.iter())
        .find(|p| p.steamid == me_s)
        .map(|p| p.name.clone())
        .unwrap_or_default();
    let summaries = matches
        .iter()
        .map(|m| MatchSummary {
            id: m.id.clone(),
            source: m.source.clone(),
            map: m.map.clone(),
            played_at: m.played_at.clone(),
            played_ts: m.played_ts,
            duration_s: m.duration_s,
            score_mine: m.score_mine,
            score_theirs: m.score_theirs,
            result: m.result.clone(),
            highlight_count: counted(m),
        })
        .collect();
    Index { me: me_s, me_name, days, matches: summaries }
}

/// Library id for a demo file: FACEIT `1-<uuid>-1-1.dem.zst` keeps `1-<uuid>-1` (match + map
/// number); Valve `match730_<id>_...` keeps the match id; anything else uses the file stem.
pub fn demo_id(file_name: &str) -> String {
    let stem = file_name.split('.').next().unwrap_or(file_name);
    if let Some(rest) = stem.strip_prefix("match730_") {
        return format!("valve-{}", rest.split('_').next().unwrap_or(rest));
    }
    let parts: Vec<&str> = stem.split('-').collect();
    // 1 + 5 uuid groups + map number + part number
    if parts.len() >= 8 && parts[0] == "1" {
        return format!("faceit-{}-m{}", parts[1..6].join("-"), parts[6]);
    }
    stem.to_string()
}
