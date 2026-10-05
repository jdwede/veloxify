//! HLTV-style player statistics.
//!
//! Everything is first counted per player per round, then summed into the match total and the
//! T-side and CT-side splits. Stats are kept as raw counts ([`Counts`]) so a day, session or
//! profile window is the sum of its matches; rates and ratings are always derived from summed
//! counts, never averaged per match.

use crate::analysis::{is_enemy_kill, Analysis};
use crate::model::{Match, Side, TeamId};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ops::AddAssign;

const UTILITY_WEAPONS: &[&str] = &["hegrenade", "inferno", "molotov", "incgrenade"];
/// Weapons that aren't guns, for shot/hit accuracy.
const NOT_GUNS: &[&str] = &["knife", "bayonet", "taser", "hegrenade", "flashbang", "smokegrenade", "molotov", "incgrenade", "decoy", "inferno", "c4", "world", "planted_c4"];

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Counts {
    pub matches: u32,
    pub wins: u32,
    pub rounds: u32,
    pub rounds_won: u32,
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
    pub survived_rounds: u32,
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
    /// Gun shots fired and gun hits on enemies (aim).
    pub shots: u32,
    pub hits: u32,
    pub head_hits: u32,
    /// Grenades thrown (utility).
    pub flashes_thrown: u32,
    pub smokes_thrown: u32,
    pub hes_thrown: u32,
    pub molotovs_thrown: u32,
    pub decoys_thrown: u32,
    /// Seconds enemies spent blinded by this player's flashes.
    pub blind_time: f64,
    /// Teammates flashed (self-flashes excluded).
    pub team_flashed: u32,
    pub he_damage: i64,
    pub he_team_damage: i64,
    /// Sum of per-round RWS points (0-100 in won rounds, 0 in lost rounds).
    pub rws_points: f64,
}

impl AddAssign<&Counts> for Counts {
    fn add_assign(&mut self, o: &Counts) {
        self.matches += o.matches;
        self.wins += o.wins;
        self.rounds += o.rounds;
        self.rounds_won += o.rounds_won;
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
        self.survived_rounds += o.survived_rounds;
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
        self.shots += o.shots;
        self.hits += o.hits;
        self.head_hits += o.head_hits;
        self.flashes_thrown += o.flashes_thrown;
        self.smokes_thrown += o.smokes_thrown;
        self.hes_thrown += o.hes_thrown;
        self.molotovs_thrown += o.molotovs_thrown;
        self.decoys_thrown += o.decoys_thrown;
        self.blind_time += o.blind_time;
        self.team_flashed += o.team_flashed;
        self.he_damage += o.he_damage;
        self.he_team_damage += o.he_team_damage;
        self.rws_points += o.rws_points;
    }
}

/// Rates and ratings derived from [`Counts`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
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
    /// ESEA Round Win Share: average points per round (won rounds share 100 by damage).
    pub rws: f64,
    /// Gun hits on enemies / gun shots (0-100).
    pub accuracy: f64,
    /// Head hits / gun hits on enemies (0-100).
    pub head_accuracy: f64,
}

impl Default for Derived {
    fn default() -> Self {
        Counts::default().derived()
    }
}

fn pct(n: f64, d: f64) -> f64 {
    if d > 0.0 {
        100.0 * n / d
    } else {
        0.0
    }
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
            hs_pct: pct(self.headshot_kills as f64, self.kills as f64),
            kd: self.kills as f64 / (self.deaths.max(1)) as f64,
            rating1,
            rating2,
            impact,
            rws: self.rws_points / r,
            accuracy: pct(self.hits as f64, self.shots as f64).min(100.0),
            head_accuracy: pct(self.head_hits as f64, self.hits as f64),
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
    /// The same stats restricted to rounds played on each side.
    pub t: Counts,
    pub ct: Counts,
}

fn gun(weapon: &str) -> bool {
    let w = weapon.trim_start_matches("weapon_");
    !w.is_empty() && !NOT_GUNS.iter().any(|n| w.starts_with(n))
}

/// Computes stats for every player. With `use_scoreboard`, the K/A/D, damage and other counters
/// CS2 shows on its own scoreboard override the event-derived match totals, so they always match
/// what the player saw in game (Valve's rules for edge cases like bomb deaths aren't public).
pub fn player_stats(m: &Match, a: &Analysis, use_scoreboard: bool) -> Vec<PlayerStats> {
    let mut pr: HashMap<(u64, usize), Counts> = HashMap::new();
    let match_end_tick = m.rounds.last().map(|r| r.end_tick).unwrap_or(i32::MAX);

    for (i, k) in m.kills.iter().enumerate() {
        // Matches CS2's scoreboard: nothing after the match has ended counts, and neither do
        // bomb-explosion deaths.
        if k.tick > match_end_tick {
            continue;
        }
        if k.weapon != "planted_c4" {
            pr.entry((k.victim, k.round)).or_default().deaths += 1;
        }
        // CS2 credits an assist to an enemy of the victim even when a teammate of the victim got
        // the final blow (team kill).
        if let Some(assister) = k.assister.filter(|s| m.team_of(*s).is_some() && m.team_of(*s) != m.team_of(k.victim)) {
            let c = pr.entry((assister, k.round)).or_default();
            c.assists += 1;
            c.flash_assists += k.flash_assist as u32;
        }
        let Some(attacker) = k.attacker else { continue };
        if is_enemy_kill(m, k.attacker, k.victim) {
            let c = pr.entry((attacker, k.round)).or_default();
            c.kills += 1;
            c.headshot_kills += k.headshot as u32;
            c.trade_kills += a.rounds[k.round].trade_kills.contains(&i) as u32;
        } else if attacker != k.victim && m.team_of(attacker).is_some() {
            pr.entry((attacker, k.round)).or_default().team_kills += 1;
        }
    }

    // Enemy damage per player per round, for RWS.
    let mut round_damage: HashMap<(u64, usize), i64> = HashMap::new();
    for d in &m.damages {
        let Some(attacker) = d.attacker else { continue };
        if attacker == d.victim {
            continue;
        }
        let enemy = is_enemy_kill(m, Some(attacker), d.victim);
        let c = pr.entry((attacker, d.round)).or_default();
        if !enemy {
            if d.weapon == "hegrenade" && m.team_of(attacker).is_some() {
                c.he_team_damage += d.health_removed as i64;
            }
            continue; // team damage doesn't count toward ADR
        }
        c.damage += d.health_removed as i64;
        *round_damage.entry((attacker, d.round)).or_default() += d.health_removed as i64;
        if UTILITY_WEAPONS.contains(&d.weapon.as_str()) {
            c.utility_damage += d.health_removed as i64;
        }
        if d.weapon == "hegrenade" {
            c.he_damage += d.health_removed as i64;
        }
        if gun(&d.weapon) {
            c.hits += 1;
            c.head_hits += (d.hitgroup == "head") as u32;
        }
    }

    for b in &m.blinds {
        if b.attacker == b.victim {
            continue;
        }
        let c = pr.entry((b.attacker, b.round)).or_default();
        if is_enemy_kill(m, Some(b.attacker), b.victim) {
            c.enemies_flashed += 1;
            c.blind_time += b.duration as f64;
        } else if m.team_of(b.attacker).is_some() && m.team_of(b.attacker) == m.team_of(b.victim) {
            c.team_flashed += 1;
        }
    }

    for s in &m.shots {
        let c = pr.entry((s.player, s.round)).or_default();
        match s.weapon.trim_start_matches("weapon_") {
            "flashbang" => c.flashes_thrown += 1,
            "smokegrenade" => c.smokes_thrown += 1,
            "hegrenade" => c.hes_thrown += 1,
            "molotov" | "incgrenade" => c.molotovs_thrown += 1,
            "decoy" => c.decoys_thrown += 1,
            w if gun(w) => c.shots += 1,
            _ => {}
        }
    }

    for b in &m.bomb {
        let c = pr.entry((b.player, b.round)).or_default();
        if b.defused {
            c.bomb_defuses += 1
        } else {
            c.bomb_plants += 1
        }
    }

    for (r, facts) in a.rounds.iter().enumerate() {
        let round = &m.rounds[r];
        if let Some(ki) = facts.opening_kill {
            let k = &m.kills[ki];
            if let Some(att) = k.attacker {
                pr.entry((att, r)).or_default().opening_kills += 1;
            }
            pr.entry((k.victim, r)).or_default().opening_deaths += 1;
        }
        let winners = round.winner_team();
        // RWS: the winning team shares 100 points by damage dealt; on bomb wins 30 go to the
        // planter (exploded) or defuser (defused) and the rest is shared by damage.
        let bomb_player = match round.reason.as_str() {
            "bomb_exploded" => m.bomb.iter().find(|b| b.round == r && !b.defused).map(|b| b.player),
            "bomb_defused" => m.bomb.iter().find(|b| b.round == r && b.defused).map(|b| b.player),
            _ => None,
        };
        let team_players: Vec<u64> = m.players.iter().filter(|p| p.team == winners).map(|p| p.steamid).collect();
        let team_damage: i64 = team_players.iter().map(|s| round_damage.get(&(*s, r)).copied().unwrap_or(0)).sum();
        let pool = if bomb_player.is_some() { 70.0 } else { 100.0 };

        for p in &m.players {
            let sid = p.steamid;
            let c = pr.entry((sid, r)).or_default();
            c.rounds = 1;
            let won = p.team == winners;
            c.rounds_won = won as u32;
            let kills = c.kills;
            let survived = !facts.died.contains(&sid);
            let traded = facts.traded.contains(&sid);
            c.multikill_rounds[kills.min(5) as usize] += (kills > 0) as u32;
            c.kast_rounds += (kills > 0 || c.assists > 0 || survived || traded) as u32;
            c.survived_rounds += survived as u32;
            c.traded_deaths += traded as u32;
            if won {
                let dmg = round_damage.get(&(sid, r)).copied().unwrap_or(0) as f64;
                c.rws_points += if team_damage > 0 {
                    pool * dmg / team_damage as f64
                } else {
                    pool / team_players.len().max(1) as f64
                };
                if bomb_player == Some(sid) {
                    c.rws_points += 30.0;
                }
            }
        }
        for cl in &facts.clutches {
            let c = pr.entry((cl.player, r)).or_default();
            let vs = cl.vs.min(5) as usize;
            c.clutches_attempted[vs] += 1;
            c.clutches_won[vs] += cl.won as u32;
        }
    }

    let mut out = vec![];
    for p in &m.players {
        let (mut total, mut t, mut ct) = (Counts::default(), Counts::default(), Counts::default());
        for (r, round) in m.rounds.iter().enumerate() {
            let Some(c) = pr.get(&(p.steamid, r)) else { continue };
            total += c;
            if round.side_of(p.team) == Side::T {
                t += c
            } else {
                ct += c
            }
        }
        total.matches = 1;
        let won = if p.team == TeamId::A { m.score_a > m.score_b } else { m.score_b > m.score_a };
        total.wins = won as u32;
        if let Some(row) = m.scoreboard.get(&p.steamid) {
            total.mvps = row.mvps as u32;
            total.score = row.score as u32;
            if use_scoreboard {
                total.kills = row.kills as u32;
                total.deaths = row.deaths as u32;
                total.assists = row.assists as u32;
                total.damage = row.damage;
                total.utility_damage = row.utility_damage;
                total.enemies_flashed = row.enemies_flashed as u32;
            }
        }
        let derived = total.derived();
        out.push(PlayerStats { steamid: p.steamid, name: p.name.clone(), team: p.team, counts: total, derived, t, ct });
    }
    out.sort_by(|a, b| (a.team as u8).cmp(&(b.team as u8)).then(b.derived.rating2.partial_cmp(&a.derived.rating2).unwrap()));
    out
}
