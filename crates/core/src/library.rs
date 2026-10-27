//! The match library: what the UI reads. One JSON file per match plus an `index.json` with the
//! calendar (days → sessions → matches) and per-day, per-player aggregates.
//!
//! Steam IDs are written as strings because JavaScript numbers can't hold a u64 exactly.

use crate::analysis::Analysis;
use crate::highlights::{self, Highlight};
use crate::lowlights::{self, Lowlight};
use crate::model::{Match, Source, TeamId, TICKRATE};
use crate::stats::{Counts, Derived, PlayerStats};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};

/// Which moments become clips: who gets them, and what counts as a highlight (with how many per
/// match).
#[derive(Debug, Clone, Default)]
pub struct ClipPolicy {
    /// Players besides you whose highlights are also detected (opt-in; empty by default).
    pub also_clip: Vec<u64>,
    pub rules: highlights::HighlightRules,
}

/// A new session starts after a break this long: about a night's sleep, not the date (a late
/// session from 11 PM to 4 AM is one session; a long dinner break doesn't split one).
pub const SESSION_GAP_S: i64 = 6 * 3600;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlayerRow {
    pub steamid: String,
    pub name: String,
    /// "mine" or "enemy", relative to the library owner.
    pub side: String,
    pub party: bool,
    pub counts: Counts,
    pub derived: Derived,
    /// The same counts restricted to T-side and CT-side rounds.
    #[serde(default)]
    pub t: Counts,
    #[serde(default)]
    pub ct: Counts,
    /// Rating 3.0 est. on each side.
    #[serde(default)]
    pub t_rating3: f64,
    #[serde(default)]
    pub ct_rating3: f64,
    /// Competitive rank from CS2's scoreboard: `rank_type` 11 is Premier (rating), and
    /// `rank_after` the rating after this match when CS2 reported it.
    #[serde(default)]
    pub rank: i64,
    #[serde(default)]
    pub rank_type: i64,
    #[serde(default)]
    pub rank_after: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HighlightEntry {
    pub id: String,
    pub player: String,
    pub round: u32,
    /// 3 = always a highlight, 2 = when it matters, 1 = filler.
    #[serde(default)]
    pub tier: u8,
    /// Render priority ("poker hand"): kills x100 + flashiness.
    #[serde(default)]
    pub hand: u32,
    pub score: f64,
    pub title: String,
    pub tags: Vec<String>,
    pub duration_s: f64,
    pub segments: Vec<(i32, i32)>,
    /// Path relative to the library root once rendered.
    pub clip: Option<String>,
    /// Preview frame (JPEG) next to the clip, once rendered.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thumb: Option<String>,
    /// Why rendering failed (e.g. the demo is from an older CS2 version), if it did.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub render_error: Option<String>,
    /// The clip was recorded without sound (no silent audio device for CS2 then).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub no_audio: bool,
    #[serde(flatten)]
    pub details: HighlightDetails,
}

/// What a highlight is made of, for presets and filters (pistol rounds, one-deags, AWP, clutches,
/// rifle multi-kills, entries).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct HighlightDetails {
    pub kills: u32,
    pub headshots: u32,
    /// Kill weapons (CS2 names, e.g. `ak47`), most used first.
    pub weapons: Vec<String>,
    /// Family of the most used weapon (see `highlights::weapon_class`).
    pub weapon_class: String,
    pub pistol_round: bool,
    /// Includes the round's opening kill.
    pub entry: bool,
    /// 1vN clutch won (0 if not a clutch).
    pub clutch_vs: u32,
    pub eco_kills: u32,
}

/// A match entry file in `matches/` (`<id>.json`, not `<id>.details.json`).
pub fn is_entry_file(p: &std::path::Path) -> bool {
    let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    // `<id>.json`: match ids have no dots, the files kept beside them do (`.details.json`,
    // `.insight.json`, `.replay.json.gz`).
    name.strip_suffix(".json").is_some_and(|stem| !stem.is_empty() && !stem.contains('.'))
}

#[cfg(test)]
mod entry_file_tests {
    #[test]
    fn only_match_entries() {
        let is = |n: &str| super::is_entry_file(std::path::Path::new(n));
        assert!(is("faceit-0a6ac30a-21ed-44c5-a86e-0226c370861e-m1.json"));
        assert!(!is("faceit-0a6ac30a-21ed-44c5-a86e-0226c370861e-m1.details.json"));
        assert!(!is("faceit-0a6ac30a-21ed-44c5-a86e-0226c370861e-m1.insight.json"));
        assert!(!is("faceit-0a6ac30a-21ed-44c5-a86e-0226c370861e-m1.replay.json.gz"));
        assert!(!is("faceit-0a6ac30a-21ed-44c5-a86e-0226c370861e-m1.details.json.tmp"));
    }
}

/// Bumped when what makes a highlight (or its clip) changes: 1 = one taps tagged, kills after the
/// round ended inside the clip.
pub const HIGHLIGHT_RULES: u32 = 2;

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
    /// The other moments found (they don't count as highlights with the current settings): kept
    /// so a change in Settings can sort them again without reading the demo.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub candidates: Vec<HighlightEntry>,
    /// Misses you were punished for (see `lowlights`), worst first.
    #[serde(default)]
    pub lowlights: Vec<Lowlight>,
    /// The play of the match, by anyone (see `highlights::play_of_the_match`): filmed from that
    /// player's view. When it's one of yours it has the same id as that highlight (one clip).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub potm: Option<HighlightEntry>,
    /// The highlight rules ([`HIGHLIGHT_RULES`]) this match was analyzed with: older ones are
    /// analyzed again in the background after an update changes them.
    #[serde(default)]
    pub rules: u32,
    /// FACEIT competition (e.g. a matchmaking queue or an ESEA league season), from FACEIT.
    #[serde(default)]
    pub competition: Option<String>,
    /// Who queued with you, from FACEIT's match room (SteamID64s), when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub faceit_party: Option<Vec<String>>,
    /// FACEIT ELO after this match and its change, once known from FACEIT.
    #[serde(default)]
    pub elo: Option<u32>,
    #[serde(default)]
    pub elo_delta: Option<i32>,
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
    /// Every highlight in the library, for the Highlights browser (newest first).
    #[serde(default)]
    pub highlights: Vec<HighlightRef>,
    /// Every lowlight in the library (newest first).
    #[serde(default)]
    pub lowlights: Vec<LowlightRef>,
    /// Profile for each window (last 10/30/50/all matches) and source (all/faceit/valve).
    #[serde(default)]
    pub profiles: Vec<crate::profile::Profile>,
    /// Latest Premier rating seen in a Premier demo, with when.
    #[serde(default)]
    pub premier: Option<(i64, String)>,
}

/// A highlight plus the match context the Highlights browser sorts and filters on.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HighlightRef {
    pub id: String,
    pub match_id: String,
    pub player: String,
    pub player_name: String,
    pub title: String,
    pub tags: Vec<String>,
    pub tier: u8,
    pub hand: u32,
    pub score: f64,
    pub round: u32,
    pub duration_s: f64,
    pub clip: Option<String>,
    pub thumb: Option<String>,
    pub render_error: Option<String>,
    #[serde(default)]
    pub no_audio: bool,
    pub map: String,
    pub source: String,
    pub result: String,
    pub score_mine: u32,
    pub score_theirs: u32,
    pub played_at: String,
    pub played_ts: i64,
    #[serde(flatten)]
    pub details: HighlightDetails,
    /// "FACEIT", "Premier" or e.g. "ESEA S60" (see `source_label`).
    #[serde(default)]
    pub source_label: String,
}

/// A lowlight with its match context, for the Lowlights tab (per-shot details stay in the match).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LowlightRef {
    pub id: String,
    pub match_id: String,
    pub kind: String,
    pub title: String,
    pub weapon: String,
    pub weapon_class: String,
    pub reason: String,
    pub verdict: String,
    pub tags: Vec<String>,
    pub severity: f64,
    pub round: u32,
    pub killer_name: String,
    pub shots: u32,
    pub hits: u32,
    pub pistol_round: bool,
    pub duration_s: f64,
    pub clip: Option<String>,
    pub thumb: Option<String>,
    #[serde(default)]
    pub no_audio: bool,
    pub map: String,
    pub source: String,
    pub source_label: String,
    pub result: String,
    pub score_mine: u32,
    pub score_theirs: u32,
    pub played_at: String,
    pub played_ts: i64,
}

/// Where a match was played, as shown on tags and filters: "Premier", "FACEIT", or the FACEIT
/// league and season (e.g. "ESEA S60") when the competition is an ESEA league.
pub fn source_label(source: &str, competition: Option<&str>) -> String {
    match source {
        "valve" => "Premier".into(),
        "faceit" => match competition.filter(|c| c.to_ascii_uppercase().contains("ESEA")) {
            Some(c) => {
                let digits = |s: &str| s.chars().take_while(|ch| ch.is_ascii_digit()).collect::<String>();
                let season = c.split_whitespace().zip(c.split_whitespace().skip(1)).find_map(|(a, b)| {
                    if a.eq_ignore_ascii_case("season") {
                        Some(digits(b))
                    } else {
                        None
                    }
                });
                let season = season.or_else(|| {
                    c.split(|ch: char| !ch.is_ascii_alphanumeric()).find_map(|w| {
                        let d = w.strip_prefix('S').or_else(|| w.strip_prefix('s')).map(digits).filter(|d| !d.is_empty());
                        d
                    })
                });
                match season.filter(|s| !s.is_empty()) {
                    Some(s) => format!("ESEA S{s}"),
                    None => "ESEA".into(),
                }
            }
            None => "FACEIT".into(),
        },
        _ => "Other".into(),
    }
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
    #[serde(default)]
    pub lowlight_count: u32,
    #[serde(default)]
    pub source_label: String,
    #[serde(default)]
    pub competition: Option<String>,
    /// The owner's line from the scoreboard, so match lists don't need every match file.
    #[serde(default)]
    pub line: Option<Line>,
    /// You plus your party on your team (1 = solo .. 5 = full stack).
    #[serde(default)]
    pub party_size: u32,
    /// FACEIT: ELO after the match, its change, and the level that ELO is.
    #[serde(default)]
    pub elo: Option<u32>,
    #[serde(default)]
    pub elo_delta: Option<i32>,
    #[serde(default)]
    pub level: Option<u32>,
    /// Premier: rating after the match (or before it, when CS2 didn't report the result) and
    /// the change.
    #[serde(default)]
    pub premier: Option<i64>,
    #[serde(default)]
    pub premier_delta: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Line {
    pub kills: u32,
    pub assists: u32,
    pub deaths: u32,
    pub adr: f64,
    pub kast: f64,
    pub rws: f64,
    pub rating2: f64,
    /// Rating 3.0 est. and Round Swing (% per round).
    #[serde(default)]
    pub rating3: f64,
    #[serde(default)]
    pub swing: f64,
    /// The rest of the match's line, for the match history's optional columns.
    #[serde(default)]
    pub rounds: u32,
    #[serde(default)]
    pub rating1: f64,
    #[serde(default)]
    pub hs_pct: f64,
    #[serde(default)]
    pub kpr: f64,
    #[serde(default)]
    pub kd: f64,
    #[serde(default)]
    pub mvps: u32,
    /// Rounds with exactly n kills (index 0 unused).
    #[serde(default)]
    pub multi: [u32; 6],
    #[serde(default)]
    pub opening_kills: u32,
    #[serde(default)]
    pub opening_deaths: u32,
    #[serde(default)]
    pub trade_kills: u32,
    #[serde(default)]
    pub damage: i64,
    #[serde(default)]
    pub utility_damage: i64,
    #[serde(default)]
    pub enemies_flashed: u32,
    #[serde(default)]
    pub flash_assists: u32,
    #[serde(default)]
    pub clutches: u32,
    #[serde(default)]
    pub clutches_won: u32,
    /// Gun hits / shots, percent.
    #[serde(default)]
    pub accuracy: f64,
}

/// Builds the library entry for one match from the perspective of `me`. `played_ts` comes from
/// the source (FACEIT/Valve match time) or, failing that, the demo file's timestamp.
/// Highlights are detected for `me` only, plus anyone in `policy.also_clip` (opt-in per player);
/// everyone else gets stats only. With `demo`, reaction flicks are detected too (extra parse).
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
    demo: Option<&[u8]>,
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
            t: s.t.clone(),
            ct: s.ct.clone(),
            t_rating3: s.t.derived().rating3,
            ct_rating3: s.ct.derived().rating3,
            rank: m.scoreboard.get(&s.steamid).map(|r| r.rank).unwrap_or(0),
            rank_type: m.scoreboard.get(&s.steamid).map(|r| r.rank_type).unwrap_or(0),
            rank_after: m
                .scoreboard
                .get(&s.steamid)
                .map(|r| {
                    let won = (s.team == my_team) == (result == "win") && result != "tie";
                    let after = if won { r.rank_if_win } else { r.rank_if_loss };
                    if after > 0 { after } else { r.rank }
                })
                .unwrap_or(0),
        })
        .collect();
    // Every moment found, sorted into highlights (what Settings counts as one) and the rest.
    let (mut hls, mut candidates): (Vec<HighlightEntry>, Vec<HighlightEntry>) = (vec![], vec![]);
    for p in m.players.iter().filter(|p| p.steamid == me || policy.also_clip.contains(&p.steamid)) {
        let flicks = demo.and_then(|d| highlights::reaction_flicks(d, m, p.steamid).ok()).unwrap_or_default();
        let all: Vec<HighlightEntry> = highlights::detect(m, a, p.steamid, &flicks).iter().map(|h| highlight_entry(id, h, m, a)).collect();
        let (keep, rest) = split_highlights(all, &policy.rules);
        hls.extend(keep);
        candidates.extend(rest);
    }
    let lls: Vec<Lowlight> = lowlights::detect(m, me, demo)
        .into_iter()
        .map(|mut l| {
            l.id = format!("{id}-ll-r{}", l.round);
            l
        })
        .collect();
    hls.sort_by(|x, y| y.score.partial_cmp(&x.score).unwrap());
    let potm = highlights::play_of_the_match(m, a).map(|h| highlight_entry(id, &h, m, a));
    let duration_ticks = m.rounds.last().map(|r| r.end_tick).unwrap_or(0) - m.rounds.first().map(|r| r.live_tick).unwrap_or(0);
    Some(MatchEntry {
        rules: HIGHLIGHT_RULES,
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
        candidates,
        lowlights: lls,
        potm,
        competition: None,
        faceit_party: None,
        elo: None,
        elo_delta: None,
    })
}

/// One player's moments split by the user's rules: (highlights, the rest).
pub fn split_highlights(all: Vec<HighlightEntry>, rules: &highlights::HighlightRules) -> (Vec<HighlightEntry>, Vec<HighlightEntry>) {
    highlights::split_by_rules(all, rules, |h| (h.score, h.tags.as_slice(), h.details.kills, h.details.eco_kills, h.details.clutch_vs))
}

/// Sorts every match's moments again after the highlight settings changed: what counts now moves
/// into the highlights, what doesn't moves out (a moment already filmed always stays). Returns how
/// many matches changed. Matches read before moments were all kept can only lose highlights here.
pub fn reselect(root: &std::path::Path, policy: &ClipPolicy) -> anyhow::Result<usize> {
    let mut changed = 0;
    for f in std::fs::read_dir(root.join("matches"))?.flatten() {
        let path = f.path();
        if !is_entry_file(&path) {
            continue;
        }
        let Ok(mut e) = std::fs::read_to_string(&path).map_err(anyhow::Error::from).and_then(|t| Ok(serde_json::from_str::<MatchEntry>(&t)?)) else { continue };
        let before: Vec<String> = e.highlights.iter().map(|h| h.id.clone()).collect();
        let mut pool: Vec<HighlightEntry> = std::mem::take(&mut e.highlights);
        pool.append(&mut e.candidates);
        let mut players: Vec<String> = pool.iter().map(|h| h.player.clone()).collect();
        players.sort();
        players.dedup();
        for p in players {
            let (mine, rest): (Vec<HighlightEntry>, Vec<HighlightEntry>) = pool.into_iter().partition(|h| h.player == p);
            pool = rest;
            let (filmed, open): (Vec<HighlightEntry>, Vec<HighlightEntry>) = mine.into_iter().partition(|h| h.clip.is_some());
            let (keep, others) = split_highlights(open, &policy.rules);
            e.highlights.extend(filmed);
            e.highlights.extend(keep);
            e.candidates.extend(others);
        }
        e.highlights.sort_by(|x, y| y.score.total_cmp(&x.score));
        let after: Vec<String> = e.highlights.iter().map(|h| h.id.clone()).collect();
        if after != before {
            let tmp = path.with_extension("json.tmp");
            std::fs::write(&tmp, serde_json::to_string_pretty(&e)?)?;
            std::fs::rename(tmp, &path)?;
            changed += 1;
        }
    }
    Ok(changed)
}

fn highlight_entry(match_id: &str, h: &Highlight, m: &Match, a: &Analysis) -> HighlightEntry {
    let kills: Vec<&crate::model::Kill> = h.kills.iter().map(|&i| &m.kills[i]).collect();
    let mut weapons: Vec<(String, usize)> = vec![];
    for k in &kills {
        match weapons.iter_mut().find(|(w, _)| *w == k.weapon) {
            Some((_, n)) => *n += 1,
            None => weapons.push((k.weapon.clone(), 1)),
        }
    }
    weapons.sort_by(|x, y| y.1.cmp(&x.1));
    let pistol_round = crate::analysis::pistol_rounds(m).contains(&h.round);
    let details = HighlightDetails {
        kills: kills.len() as u32,
        headshots: kills.iter().filter(|k| k.headshot).count() as u32,
        weapon_class: weapons.first().map(|(w, _)| highlights::weapon_class(w).to_string()).unwrap_or_default(),
        weapons: weapons.into_iter().map(|(w, _)| w).collect(),
        pistol_round,
        entry: a.rounds[h.round].opening_kill.is_some_and(|ki| h.kills.contains(&ki)),
        clutch_vs: a.rounds[h.round].clutches.iter().find(|c| c.player == h.player && c.won).map(|c| c.vs).unwrap_or(0),
        eco_kills: kills.iter().filter(|k| highlights::eco_kill(k, pistol_round)).count() as u32,
    };
    HighlightEntry {
        details,
        id: format!("{match_id}-{}-r{}", h.player, h.round_number),
        player: h.player.to_string(),
        round: h.round_number,
        tier: h.tier,
        hand: h.hand,
        score: h.score,
        title: h.title.clone(),
        tags: h.tags.clone(),
        duration_s: h.duration_s,
        segments: h.segments.iter().map(|s| (s.start_tick, s.end_tick)).collect(),
        clip: None,
        thumb: None,
        render_error: None,
        no_audio: false,
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

    // Party: in a FACEIT match, whoever FACEIT says queued with you. Otherwise (Premier, or FACEIT
    // not read yet), teammates on your side in at least two matches of the session that FACEIT
    // doesn't say were randoms.
    for sess in &sessions {
        let mut together: HashMap<String, u32> = HashMap::new();
        let mut randoms: HashSet<String> = HashSet::new();
        for &i in sess {
            for p in matches[i].players.iter().filter(|p| p.side == "mine" && p.steamid != me_s) {
                *together.entry(p.steamid.clone()).or_default() += 1;
                if matches[i].faceit_party.as_ref().is_some_and(|party| !party.contains(&p.steamid)) {
                    randoms.insert(p.steamid.clone());
                }
            }
        }
        for &i in sess {
            let party = matches[i].faceit_party.clone();
            for p in matches[i].players.iter_mut() {
                p.party = p.side == "mine"
                    && p.steamid != me_s
                    && match &party {
                        Some(party) => party.contains(&p.steamid),
                        None => together.get(&p.steamid).copied().unwrap_or(0) >= 2 && !randoms.contains(&p.steamid),
                    };
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
            lowlight_count: m.lowlights.len() as u32,
            source_label: source_label(&m.source, m.competition.as_deref()),
            competition: m.competition.clone(),
            elo: m.elo,
            elo_delta: m.elo_delta,
            level: m.elo.map(crate::faceit::level_for),
            premier: m.players.iter().find(|p| p.steamid == me_s && p.rank_type == 11 && p.rank > 0).map(|p| {
                if p.rank_after > 0 {
                    p.rank_after
                } else {
                    p.rank
                }
            }),
            premier_delta: m
                .players
                .iter()
                .find(|p| p.steamid == me_s && p.rank_type == 11 && p.rank > 0 && p.rank_after > 0)
                .map(|p| p.rank_after - p.rank),
            party_size: (1 + m.players.iter().filter(|p| p.steamid != me_s && p.side == "mine" && p.party).count() as u32).min(5),
            line: m.players.iter().find(|p| p.steamid == me_s).map(|p| Line {
                kills: p.counts.kills,
                assists: p.counts.assists,
                deaths: p.counts.deaths,
                adr: p.derived.adr,
                kast: p.derived.kast,
                rws: p.derived.rws,
                rating2: p.derived.rating2,
                rating3: p.derived.rating3,
                swing: p.derived.swing,
                rounds: p.counts.rounds,
                rating1: p.derived.rating1,
                hs_pct: p.derived.hs_pct,
                kpr: p.derived.kpr,
                kd: p.derived.kd,
                mvps: p.counts.mvps,
                multi: p.counts.multikill_rounds,
                opening_kills: p.counts.opening_kills,
                opening_deaths: p.counts.opening_deaths,
                trade_kills: p.counts.trade_kills,
                damage: p.counts.damage,
                utility_damage: p.counts.utility_damage,
                enemies_flashed: p.counts.enemies_flashed,
                flash_assists: p.counts.flash_assists,
                clutches: p.counts.clutches_attempted[1..].iter().sum(),
                clutches_won: p.counts.clutches_won[1..].iter().sum(),
                accuracy: p.derived.accuracy,
            }),
        })
        .collect();
    let mut highlights: Vec<HighlightRef> = matches
        .iter()
        .flat_map(|m| {
            m.highlights.iter().map(move |h| HighlightRef {
                id: h.id.clone(),
                match_id: m.id.clone(),
                player: h.player.clone(),
                player_name: m.players.iter().find(|p| p.steamid == h.player).map(|p| p.name.clone()).unwrap_or_default(),
                title: h.title.clone(),
                tags: h.tags.clone(),
                tier: h.tier,
                hand: h.hand,
                score: h.score,
                round: h.round,
                duration_s: h.duration_s,
                clip: h.clip.clone(),
                thumb: h.thumb.clone(),
                render_error: h.render_error.clone(),
                no_audio: h.no_audio,
                map: m.map.clone(),
                source: m.source.clone(),
                result: m.result.clone(),
                score_mine: m.score_mine,
                score_theirs: m.score_theirs,
                played_at: m.played_at.clone(),
                played_ts: m.played_ts,
                details: h.details.clone(),
                source_label: source_label(&m.source, m.competition.as_deref()),
            })
        })
        .collect();
    highlights.sort_by_key(|h| std::cmp::Reverse((h.played_ts, h.hand)));
    let mut lowlight_refs: Vec<LowlightRef> = matches
        .iter()
        .flat_map(|m| {
            m.lowlights.iter().map(move |l| LowlightRef {
                id: l.id.clone(),
                match_id: m.id.clone(),
                kind: l.kind.clone(),
                title: l.title.clone(),
                weapon: l.weapon.clone(),
                weapon_class: l.weapon_class.clone(),
                reason: l.reason.clone(),
                verdict: l.verdict.clone(),
                tags: l.tags.clone(),
                severity: l.severity,
                round: l.round,
                killer_name: l.killer_name.clone(),
                shots: l.shots,
                hits: l.hits,
                pistol_round: l.pistol_round,
                duration_s: l.duration_s,
                clip: l.clip.clone(),
                thumb: l.thumb.clone(),
                no_audio: l.no_audio,
                map: m.map.clone(),
                source: m.source.clone(),
                source_label: source_label(&m.source, m.competition.as_deref()),
                result: m.result.clone(),
                score_mine: m.score_mine,
                score_theirs: m.score_theirs,
                played_at: m.played_at.clone(),
                played_ts: m.played_ts,
            })
        })
        .collect();
    lowlight_refs.sort_by_key(|l| std::cmp::Reverse(l.played_ts));
    let mut profiles = vec![];
    for last in [10, 30, 50, 0] {
        for source in ["all", "faceit", "valve"] {
            profiles.extend(crate::profile::build(&me_s, matches, last, source));
        }
    }
    let premier = matches.iter().rev().find_map(|m| {
        let row = m.players.iter().find(|p| p.steamid == me_s)?;
        (m.source == "valve" && row.rank_type == 11 && row.rank_after > 0).then(|| (row.rank_after, m.played_at.clone()))
    });
    Index { me: me_s, me_name, days, matches: summaries, highlights, lowlights: lowlight_refs, profiles, premier }
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
