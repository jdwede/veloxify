//! The player profile: totals, ratings and 0-100 skill scores over a window of recent matches.
//!
//! Skill scores compare you with the players in your own lobbies over the same matches: 50 is the
//! average player you actually play against, so the competition is built in. Each score combines
//! a few component stats; every component becomes a percentile-like value Φ(z) from the lobby's
//! per-match mean and spread, and the score is their average (×100).
//!
//! Utility follows Leetify's published method (Oct 2025): quantity is grenades per round against
//! an expected 3, scaled ^(2/3); quality is the normal CDF of z-scored flash and HE effectiveness;
//! the score is the geometric mean of the two.

use crate::library::MatchEntry;
use crate::stats::{Counts, Derived};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Component {
    pub key: String,
    pub name: String,
    /// 0-100; 50 = average player in your lobbies.
    pub score: f64,
    /// The headline value shown next to the bar (e.g. "62% won").
    pub value: String,
    /// The same headline stat for the average lobby player.
    pub lobby: String,
    /// Breakdown rows: (label, yours, lobby average).
    pub details: Vec<(String, String, String)>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FormPoint {
    pub match_id: String,
    pub played_at: String,
    pub map: String,
    pub result: String,
    pub rating2: f64,
    #[serde(default)]
    pub rating3: f64,
    pub adr: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Profile {
    /// Number of most recent matches (0 = all).
    pub last: usize,
    /// "all", "faceit" or "valve".
    pub source: String,
    pub matches: u32,
    pub wins: u32,
    pub win_rate: f64,
    pub counts: Counts,
    pub derived: Derived,
    pub t: Derived,
    pub ct: Derived,
    pub components: Vec<Component>,
    /// Share of matches played solo, in a 2-4 stack, and as a 5 stack (0-1).
    pub solo: f64,
    pub stack_2_4: f64,
    pub stack_5: f64,
    /// Oldest to newest.
    pub form: Vec<FormPoint>,
}

/// Standard normal CDF (Abramowitz–Stegun 7.1.26, |error| < 1.5e-7).
fn phi(z: f64) -> f64 {
    let t = 1.0 / (1.0 + 0.3275911 * z.abs() / std::f64::consts::SQRT_2);
    let y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t
        * (-(z * z) / 2.0).exp();
    if z >= 0.0 {
        0.5 * (1.0 + y)
    } else {
        0.5 * (1.0 - y)
    }
}

/// A stat computed from counts, with the minimum sample needed for it to mean anything.
struct Metric {
    f: fn(&Counts) -> Option<f64>,
}

fn ratio(n: f64, d: f64, min_d: f64) -> Option<f64> {
    (d >= min_d).then(|| n / d)
}

/// z-score of `mine` against the lobby samples of the same metric.
fn z(m: &Metric, mine: &Counts, lobby: &[&Counts]) -> Option<(f64, f64, f64)> {
    let you = (m.f)(mine)?;
    let xs: Vec<f64> = lobby.iter().filter_map(|c| (m.f)(c)).collect();
    if xs.len() < 5 {
        return None;
    }
    let mean = xs.iter().sum::<f64>() / xs.len() as f64;
    let sd = (xs.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / xs.len() as f64).sqrt().max(1e-9);
    Some(((you - mean) / sd, you, mean))
}

fn mean(v: &[f64]) -> f64 {
    if v.is_empty() {
        50.0
    } else {
        v.iter().sum::<f64>() / v.len() as f64
    }
}

fn pctf(x: f64) -> String {
    format!("{:.1}%", 100.0 * x)
}

fn component(key: &str, name: &str, mine: &Counts, lobby: &[&Counts], parts: &[(&str, Metric, bool, fn(f64) -> String)]) -> Component {
    let mut scores = vec![];
    let mut details = vec![];
    for (label, m, higher_better, fmt) in parts {
        if let Some((zz, you, avg)) = z(m, mine, lobby) {
            scores.push(100.0 * phi(if *higher_better { zz } else { -zz }));
            details.push((label.to_string(), fmt(you), fmt(avg)));
        }
    }
    let (value, lobby_v) = details.first().map(|d| (d.1.clone(), d.2.clone())).unwrap_or_default();
    Component { key: key.into(), name: name.into(), score: mean(&scores).round(), value, lobby: lobby_v, details }
}

fn utility(mine: &Counts, lobby: &[&Counts]) -> Component {
    let nades = |c: &Counts| (c.flashes_thrown + c.smokes_thrown + c.hes_thrown + c.molotovs_thrown) as f64;
    let npr = |c: &Counts| ratio(nades(c), c.rounds as f64, 10.0);
    // Quantity: grenades per round against an expected 3, scaled ^(2/3), capped at 100.
    let quantity = npr(mine).map(|x| (100.0 * (x / 3.0).powf(2.0 / 3.0)).min(100.0)).unwrap_or(0.0);
    let parts: [(&str, Metric, bool, fn(f64) -> String); 6] = [
        ("Flash assists per flash", Metric { f: |c| ratio(c.flash_assists as f64, c.flashes_thrown as f64, 3.0) }, true, pctf),
        ("Enemies flashed per flash", Metric { f: |c| ratio(c.enemies_flashed as f64, c.flashes_thrown as f64, 3.0) }, true, |x| format!("{x:.2}")),
        ("Blind time per flash", Metric { f: |c| ratio(c.blind_time, c.flashes_thrown as f64, 3.0) }, true, |x| format!("{x:.2}s")),
        ("HE damage per HE", Metric { f: |c| ratio(c.he_damage as f64, c.hes_thrown as f64, 2.0) }, true, |x| format!("{x:.1}")),
        ("Teammates flashed per flash", Metric { f: |c| ratio(c.team_flashed as f64, c.flashes_thrown as f64, 3.0) }, false, |x| format!("{x:.2}")),
        ("Team HE damage per HE", Metric { f: |c| ratio(c.he_team_damage as f64, c.hes_thrown as f64, 2.0) }, false, |x| format!("{x:.1}")),
    ];
    let mut zs = vec![];
    let mut details = vec![];
    let lobby_npr: Vec<f64> = lobby.iter().filter_map(|c| npr(c)).collect();
    details.push(("Grenades per round".into(), format!("{:.2}", npr(mine).unwrap_or(0.0)), format!("{:.2}", mean_or(&lobby_npr))));
    for (label, m, higher, fmt) in &parts {
        if let Some((zz, you, avg)) = z(m, mine, lobby) {
            zs.push(if *higher { zz } else { -zz });
            details.push((label.to_string(), fmt(you), fmt(avg)));
        }
    }
    let quality = if zs.is_empty() { 50.0 } else { 100.0 * phi(zs.iter().sum::<f64>() / zs.len() as f64) };
    let score = (quantity * quality).sqrt().round();
    Component {
        key: "utility".into(),
        name: "Utility".into(),
        score,
        value: format!("{:.2} nades/round", npr(mine).unwrap_or(0.0)),
        lobby: format!("{:.2}", mean_or(&lobby_npr)),
        details,
    }
}

fn mean_or(v: &[f64]) -> f64 {
    if v.is_empty() {
        0.0
    } else {
        v.iter().sum::<f64>() / v.len() as f64
    }
}

fn clutch(mine: &Counts, lobby: &[&Counts]) -> Component {
    // Lobby win rate per 1vX, pooled; your expected wins from the clutches you were in.
    let mut details = vec![];
    let (mut expected, mut var, mut won, mut att) = (0.0, 0.0, 0u32, 0u32);
    for x in 1..=5 {
        let la: u32 = lobby.iter().map(|c| c.clutches_attempted[x]).sum();
        let lw: u32 = lobby.iter().map(|c| c.clutches_won[x]).sum();
        let p = if la > 0 { lw as f64 / la as f64 } else { 0.0 };
        let (a, w) = (mine.clutches_attempted[x], mine.clutches_won[x]);
        expected += a as f64 * p;
        var += a as f64 * p * (1.0 - p);
        won += w;
        att += a;
        if a > 0 || la > 0 {
            details.push((format!("1v{x} won"), format!("{w}/{a}"), if la > 0 { pctf(p) } else { "–".into() }));
        }
    }
    let diff = won as f64 - expected;
    let score = if var > 0.0 { (100.0 * phi(diff / var.sqrt())).round() } else { 50.0 };
    Component {
        key: "clutch".into(),
        name: "Clutching".into(),
        score,
        value: format!("{diff:+.1} wins"),
        lobby: "±0".into(),
        details: [vec![("Clutches won".into(), format!("{won}/{att}"), format!("{expected:.1} expected"))], details].concat(),
    }
}

/// Builds the profile for `me` over the newest `last` matches (0 = all) from `source`.
/// `matches` must be oldest-to-newest. Casual/unknown sources are never included.
pub fn build(me: &str, matches: &[MatchEntry], last: usize, source: &str) -> Option<Profile> {
    let pool: Vec<&MatchEntry> = matches
        .iter()
        .filter(|m| m.source == "faceit" || m.source == "valve")
        .filter(|m| source == "all" || m.source == source)
        .collect();
    let window: Vec<&MatchEntry> = if last > 0 && pool.len() > last { pool[pool.len() - last..].to_vec() } else { pool };
    if window.is_empty() {
        return None;
    }
    let (mut total, mut t, mut ct) = (Counts::default(), Counts::default(), Counts::default());
    let mut lobby: Vec<&Counts> = vec![];
    let (mut solo, mut s24, mut s5) = (0usize, 0usize, 0usize);
    let mut form = vec![];
    for m in &window {
        let Some(row) = m.players.iter().find(|p| p.steamid == me) else { continue };
        total += &row.counts;
        t += &row.t;
        ct += &row.ct;
        lobby.extend(m.players.iter().filter(|p| p.steamid != me && p.counts.rounds >= 10).map(|p| &p.counts));
        match m.players.iter().filter(|p| p.side == "mine" && p.party && p.steamid != me).count() {
            0 => solo += 1,
            4.. => s5 += 1,
            _ => s24 += 1,
        }
        form.push(FormPoint {
            match_id: m.id.clone(),
            played_at: m.played_at.clone(),
            map: m.map.clone(),
            result: m.result.clone(),
            rating2: row.derived.rating2,
            rating3: row.derived.rating3,
            adr: row.derived.adr,
        });
    }
    let n = window.len() as f64;
    let aim = component(
        "aim",
        "Aim",
        &total,
        &lobby,
        &[
            ("Accuracy", Metric { f: |c| ratio(c.hits as f64, c.shots as f64, 30.0).map(|x| x.min(1.0)) }, true, pctf),
            ("Head accuracy", Metric { f: |c| ratio(c.head_hits as f64, c.hits as f64, 10.0) }, true, pctf),
            ("Headshot kills", Metric { f: |c| ratio(c.headshot_kills as f64, c.kills as f64, 3.0) }, true, pctf),
        ],
    );
    let positioning = component(
        "positioning",
        "Positioning",
        &total,
        &lobby,
        &[
            ("Deaths traded", Metric { f: |c| ratio(c.traded_deaths as f64, c.deaths as f64, 5.0) }, true, pctf),
            ("Died first", Metric { f: |c| ratio(c.opening_deaths as f64, c.rounds as f64, 10.0) }, false, pctf),
            ("Survived rounds", Metric { f: |c| ratio(c.survived_rounds as f64, c.rounds as f64, 10.0) }, true, pctf),
        ],
    );
    let opening = component(
        "opening",
        "Opening duels",
        &total,
        &lobby,
        &[
            ("Opening duels won", Metric { f: |c| ratio(c.opening_kills as f64, (c.opening_kills + c.opening_deaths) as f64, 3.0) }, true, pctf),
            ("Opening duels per round", Metric { f: |c| ratio((c.opening_kills + c.opening_deaths) as f64, c.rounds as f64, 10.0) }, true, |x| format!("{x:.2}")),
        ],
    );
    Some(Profile {
        last,
        source: source.into(),
        matches: total.matches,
        wins: total.wins,
        win_rate: if total.matches > 0 { total.wins as f64 / total.matches as f64 } else { 0.0 },
        derived: total.derived(),
        t: t.derived(),
        ct: ct.derived(),
        counts: total.clone(),
        components: vec![aim, utility(&total, &lobby), positioning, opening, clutch(&total, &lobby)],
        solo: solo as f64 / n,
        stack_2_4: s24 as f64 / n,
        stack_5: s5 as f64 / n,
        form,
    })
}
