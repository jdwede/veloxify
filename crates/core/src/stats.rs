//! HLTV-style player statistics.
//!
//! Stats are kept as raw counts ([`Counts`]) so a day or session total is the sum of its matches;
//! rates and ratings are always derived from summed counts, never averaged per match.

use crate::analysis::{is_enemy_kill, Analysis};
use crate::model::{Match, TeamId};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ops::AddAssign;

const UTILITY_WEAPONS: &[&str] = &["hegrenade", "inferno", "molotov", "incgrenade"];

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Counts {
    pub matches: u32,
    pub wins: u32,
    pub rounds: u32,
    pub kills: u32,
    pub deaths: u32,
    /// All assists, including flash assists (one assist per kill, as on the CS2 scoreboard).
    pub assists: u32,
    pub flash_assists: u32,
    pub headshot_kills: u32,
    pub team_kills: u32,
    pub damage: i64,
    pub utility_damage: i64,
    pub enemies_flashed: u32,
    pub kast_rounds: u32,
    pub opening_kills: u32,
    pub opening_deaths: u32,
    pub trade_kills: u32,
    pub traded_deaths: u32,
    /// Index n = rounds with exactly n kills (index 0 unused).
    pub multikill_rounds: [u32; 6],
    /// Index n = 1vN clutches attempted / won (index 0 unused).
    pub clutches_attempted: [u32; 6],
    pub clutches_won: [u32; 6],
    pub bomb_plants: u32,
    pub bomb_defuses: u32,
    pub mvps: u32,
    pub score: u32,
}

impl AddAssign<&Counts> for Counts {
    fn add_assign(&mut self, o: &Counts) {
        self.matches += o.matches;
        self.wins += o.wins;
        self.rounds += o.rounds;
        self.kills += o.kills;
        self.deaths += o.deaths;
        self.assists += o.assists;
        self.flash_assists += o.flash_assists;
        self.headshot_kills += o.headshot_kills;
        self.team_kills += o.team_kills;
        self.damage += o.damage;
        self.utility_damage += o.utility_damage;
        self.enemies_flashed += o.enemies_flashed;
        self.kast_rounds += o.kast_rounds;
        self.opening_kills += o.opening_kills;
        self.opening_deaths += o.opening_deaths;
        self.trade_kills += o.trade_kills;
        self.traded_deaths += o.traded_deaths;
        for i in 0..6 {
            self.multikill_rounds[i] += o.multikill_rounds[i];
            self.clutches_attempted[i] += o.clutches_attempted[i];
            self.clutches_won[i] += o.clutches_won[i];
        }
        self.bomb_plants += o.bomb_plants;
        self.bomb_defuses += o.bomb_defuses;
        self.mvps += o.mvps;
        self.score += o.score;
    }
}

/// Rates and ratings derived from [`Counts`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Derived {
    pub kpr: f64,
    pub dpr: f64,
    pub apr: f64,
    pub adr: f64,
    /// Percent of rounds with a Kill, Assist, Survival or Trade (0-100).
    pub kast: f64,
    /// Headshot kills as percent of kills (0-100).
    pub hs_pct: f64,
    pub kd: f64,
    /// HLTV Rating 1.0 (exact public formula).
    pub rating1: f64,
    /// HLTV Rating 2.0 community approximation ("Rating 2.0 est.").
    pub rating2: f64,
    pub impact: f64,
}

impl Counts {
    pub fn derived(&self) -> Derived {
        let r = self.rounds.max(1) as f64;
        let kpr = self.kills as f64 / r;
        let dpr = self.deaths as f64 / r;
        let apr = self.assists as f64 / r;
        let adr = self.damage as f64 / r;
        let kast = 100.0 * self.kast_rounds as f64 / r;

        // Rating 1.0 (HLTV, 2010): published formula and averages.
        let kill_rating = kpr / 0.679;
        let survival_rating = ((r - self.deaths as f64) / r) / 0.317;
        let mk = &self.multikill_rounds;
        let multi = (mk[1] + 4 * mk[2] + 9 * mk[3] + 16 * mk[4] + 25 * mk[5]) as f64 / r;
        let rating1 = (kill_rating + 0.7 * survival_rating + multi / 1.277) / 2.7;

        // Rating 2.0: community regression (dave, flashed.gg 2021), fitted on HLTV career totals.
        let impact = 2.13 * kpr + 0.42 * apr - 0.41;
        let rating2 = 0.0073 * kast + 0.3591 * kpr - 0.5329 * dpr + 0.2372 * impact + 0.0032 * adr + 0.1587;

        Derived {
            kpr,
            dpr,
            apr,
            adr,
            kast,
            hs_pct: if self.kills > 0 { 100.0 * self.headshot_kills as f64 / self.kills as f64 } else { 0.0 },
            kd: self.kills as f64 / (self.deaths.max(1)) as f64,
            rating1,
            rating2,
            impact,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct PlayerStats {
    pub steamid: u64,
    pub name: String,
    pub team: TeamId,
    pub counts: Counts,
    pub derived: Derived,
}

/// Computes stats for every player. With `use_scoreboard`, the K/A/D, damage and other counters
/// CS2 shows on its own scoreboard override the event-derived counts, so totals always match
/// what the player saw in game (Valve's rules for edge cases like bomb deaths aren't public).
pub fn player_stats(m: &Match, a: &Analysis, use_scoreboard: bool) -> Vec<PlayerStats> {
    let mut by: HashMap<u64, Counts> = m.players.iter().map(|p| (p.steamid, Counts::default())).collect();
    let rounds = m.rounds.len() as u32;
    for p in &m.players {
        let c = by.get_mut(&p.steamid).unwrap();
        c.matches = 1;
        c.rounds = rounds;
        let won = if p.team == TeamId::A { m.score_a > m.score_b } else { m.score_b > m.score_a };
        c.wins = won as u32;
    }

    let mut kills_in_round: HashMap<(u64, usize), u32> = HashMap::new();
    let mut assisted_in_round: HashMap<(u64, usize), bool> = HashMap::new();
    let match_end_tick = m.rounds.last().map(|r| r.end_tick).unwrap_or(i32::MAX);
    for (i, k) in m.kills.iter().enumerate() {
        // Matches CS2's scoreboard: nothing after the match has ended counts, and neither do
        // bomb-explosion deaths.
        if k.tick > match_end_tick {
            continue;
        }
        if k.weapon != "planted_c4" {
            if let Some(c) = by.get_mut(&k.victim) {
                c.deaths += 1;
            }
        }
        // CS2 credits an assist to an enemy of the victim even when a teammate of the victim got
        // the final blow (team kill).
        if let Some(assister) = k.assister.filter(|s| m.team_of(*s).is_some() && m.team_of(*s) != m.team_of(k.victim)) {
            if let Some(ca) = by.get_mut(&assister) {
                ca.assists += 1;
                ca.flash_assists += k.flash_assist as u32;
                assisted_in_round.insert((assister, k.round), true);
            }
        }
        let Some(attacker) = k.attacker else { continue };
        if is_enemy_kill(m, k.attacker, k.victim) {
            let c = by.get_mut(&attacker).unwrap();
            c.kills += 1;
            c.headshot_kills += k.headshot as u32;
            if a.rounds[k.round].trade_kills.contains(&i) {
                c.trade_kills += 1;
            }
            *kills_in_round.entry((attacker, k.round)).or_default() += 1;
        } else if attacker != k.victim && m.team_of(attacker).is_some() {
            if let Some(c) = by.get_mut(&attacker) {
                c.team_kills += 1;
            }
        }
    }

    for d in &m.damages {
        let Some(attacker) = d.attacker else { continue };
        if !is_enemy_kill(m, Some(attacker), d.victim) {
            continue; // self and team damage don't count toward ADR
        }
        if let Some(c) = by.get_mut(&attacker) {
            c.damage += d.health_removed as i64;
            if UTILITY_WEAPONS.contains(&d.weapon.as_str()) {
                c.utility_damage += d.health_removed as i64;
            }
        }
    }

    for b in &m.blinds {
        if is_enemy_kill(m, Some(b.attacker), b.victim) {
            if let Some(c) = by.get_mut(&b.attacker) {
                c.enemies_flashed += 1;
            }
        }
    }

    for b in &m.bomb {
        if let Some(c) = by.get_mut(&b.player) {
            if b.defused {
                c.bomb_defuses += 1
            } else {
                c.bomb_plants += 1
            }
        }
    }

    for (r, facts) in a.rounds.iter().enumerate() {
        if let Some(ki) = facts.opening_kill {
            let k = &m.kills[ki];
            if let Some(c) = k.attacker.and_then(|s| by.get_mut(&s)) {
                c.opening_kills += 1;
            }
            if let Some(c) = by.get_mut(&k.victim) {
                c.opening_deaths += 1;
            }
        }
        for p in &m.players {
            let sid = p.steamid;
            let kills = kills_in_round.get(&(sid, r)).copied().unwrap_or(0);
            let assisted = assisted_in_round.contains_key(&(sid, r));
            let survived = !facts.died.contains(&sid);
            let traded = facts.traded.contains(&sid);
            let c = by.get_mut(&sid).unwrap();
            c.multikill_rounds[kills.min(5) as usize] += (kills > 0) as u32;
            c.kast_rounds += (kills > 0 || assisted || survived || traded) as u32;
            c.traded_deaths += traded as u32;
        }
        for cl in &facts.clutches {
            if let Some(c) = by.get_mut(&cl.player) {
                let vs = cl.vs.min(5) as usize;
                c.clutches_attempted[vs] += 1;
                c.clutches_won[vs] += cl.won as u32;
            }
        }
    }

    for (sid, row) in &m.scoreboard {
        if let Some(c) = by.get_mut(sid) {
            c.mvps = row.mvps as u32;
            c.score = row.score as u32;
            if use_scoreboard {
                c.kills = row.kills as u32;
                c.deaths = row.deaths as u32;
                c.assists = row.assists as u32;
                c.damage = row.damage;
                c.utility_damage = row.utility_damage;
                c.enemies_flashed = row.enemies_flashed as u32;
            }
        }
    }

    let mut out: Vec<PlayerStats> = m
        .players
        .iter()
        .map(|p| {
            let counts = by.remove(&p.steamid).unwrap();
            let derived = counts.derived();
            PlayerStats { steamid: p.steamid, name: p.name.clone(), team: p.team, counts, derived }
        })
        .collect();
    out.sort_by(|a, b| {
        (a.team as u8).cmp(&(b.team as u8)).then(b.derived.rating2.partial_cmp(&a.derived.rating2).unwrap())
    });
    out
}
