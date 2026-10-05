//! HLTV-style player statistics.
//!
//! Everything is first counted per player per round, then summed into the match total and the
//! T-side and CT-side splits. Stats are kept as raw counts ([`Counts`]) so a day, session or
//! profile window is the sum of its matches; rates and ratings are always derived from summed
//! counts, never averaged per match.

use crate::analysis::{is_enemy_kill, Analysis};
use crate::model::{Kill, Match, Side, TeamId};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
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
    /// Rating 3.0 inputs: eco-adjusted kill and death points, eco-adjusted damage, multi-kill
    /// points and Round Swing (sum of win-probability changes, 0.20 = 20%).
    pub e_kills: f64,
    pub e_deaths: f64,
    pub e_damage: f64,
    pub multi_points: f64,
    pub swing: f64,
    /// Kills in pistol rounds, and kills on players with under $2,000 of equipment outside them.
    pub pistol_kills: u32,
    pub eco_kills: u32,
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
        self.e_kills += o.e_kills;
        self.e_deaths += o.e_deaths;
        self.e_damage += o.e_damage;
        self.multi_points += o.multi_points;
        self.swing += o.swing;
        self.pistol_kills += o.pistol_kills;
        self.eco_kills += o.eco_kills;
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
    /// Rating 3.0 est.: HLTV's current rating, rebuilt from its published parts (see `R3`).
    pub rating3: f64,
    /// Round Swing per round, in percent (+1.5 = +1.5% win probability per round).
    pub swing: f64,
    /// Rating 3.0 sub-ratings (1.00 = average): kills, damage, survival, KAST, multi-kills, swing.
    pub r3_parts: [f64; 6],
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

/// Averages behind Rating 3.0 est.: the average player in this library's FACEIT and Premier
/// lobbies, so 1.00 means average for the lobbies you play in. Per round: eco-adjusted kill and
/// death points, eco-adjusted damage, KAST share and multi-kill points; `swing_scale` is the
/// Round Swing per round that counts as +1.00 on the swing sub-rating.
pub struct R3Avg {
    pub kpr: f64,
    pub dpr: f64,
    pub adr: f64,
    pub kast: f64,
    pub multi: f64,
    pub swing_scale: f64,
}
pub const R3: R3Avg = R3Avg { kpr: 0.660, dpr: 0.663, adr: 75.4, kast: 0.723, multi: 0.249, swing_scale: 0.149 };
/// HLTV's Rating 3.0 weights (Oct 2025): kills, damage, survival, KAST, multi-kills, Round Swing.
const R3_WEIGHTS: [f64; 6] = [0.25, 0.15, 0.15, 0.08, 0.04, 0.33];
/// Points for rounds with 0..5 kills (the multi-kill sub-rating counts 2K and up).
const MULTI_POINTS: [f64; 6] = [0.0, 0.0, 1.0, 2.2, 3.6, 5.2];

/// HLTV's published CS2 duel win rates on T side (Rating 3.0 article), in percent. Rows: T
/// equipment, columns: CT equipment, both $4700+, $3550-4700, $2700-3550, $1700-2700,
/// $1000-1700, $0-1000.
const DUEL_T_WIN: [[f64; 6]; 6] = [
    [49.8, 55.5, 57.8, 60.9, 66.3, 74.0],
    [39.6, 48.0, 51.1, 56.2, 61.3, 74.8],
    [34.9, 43.8, 48.4, 53.9, 59.0, 76.1],
    [33.3, 38.8, 41.9, 48.2, 55.7, 74.0],
    [30.3, 35.1, 38.4, 41.2, 48.0, 65.0],
    [22.4, 20.5, 21.7, 20.0, 26.6, 48.6],
];

fn equip_bin(v: u32) -> usize {
    match v {
        4700.. => 0,
        3550.. => 1,
        2700.. => 2,
        1700.. => 3,
        1000.. => 4,
        _ => 5,
    }
}

/// Chance that a player on `side` with `own` equipment wins a duel against `other` equipment.
fn duel_p(side: Option<Side>, own: Option<u32>, other: Option<u32>) -> f64 {
    let (o, x) = (equip_bin(own.unwrap_or(4700)), equip_bin(other.unwrap_or(4700)));
    match side {
        Some(Side::T) => DUEL_T_WIN[o][x] / 100.0,
        Some(Side::CT) => 1.0 - DUEL_T_WIN[x][o] / 100.0,
        None => 0.5,
    }
}

/// Round win probability for T. HLTV's model isn't public; this one weighs alive players
/// superlinearly, doubles T's strength once the bomb is down and weighs average equipment, tuned
/// to HLTV's published magnitudes: 5v5 is about 48% for T, an opening kill about +20%, and a full
/// buy against a full eco about 95%.
fn wp_t(t: u32, ct: u32, planted: bool, eq_t: f64, eq_ct: f64) -> f64 {
    if ct == 0 {
        return 1.0;
    }
    if t == 0 {
        return if planted { 0.2 } else { 0.0 };
    }
    let s_t = (t as f64).powf(3.5) * (eq_t + 1000.0).powf(2.5) * if planted { 2.0 } else { 1.0 };
    let s_ct = 1.083 * (ct as f64).powf(3.5) * (eq_ct + 1000.0).powf(2.5);
    s_t / (s_t + s_ct)
}

/// Round Swing (Rating 3.0): how much each player changed their team's chance to win each round;
/// zero-sum per round. A kill's change goes half to the killer and half to the teammates who
/// damaged the victim (by damage share), with a flash assist taking 15% and, on a trade, the
/// avenged teammate 20% (they drew the enemy out); the victim is charged the whole change (a team-killer instead of their victim). A plant credits the planter. What's
/// left when the round ends goes to the winners in HLTV's 1:2:1:1 split (clutcher, players with
/// kill swing, defuser, players alive) and is charged to losers still alive: saving counts as
/// losing the clutch.
fn round_swing(m: &Match, a: &Analysis, equip: &HashMap<(u64, usize), u32>) -> HashMap<(u64, usize), f64> {
    let mut out: HashMap<(u64, usize), f64> = HashMap::new();
    for (r, round) in m.rounds.iter().enumerate() {
        let side_of = |sid: u64| m.team_of(sid).map(|t| round.side_of(t));
        let team_eq = |side: Side| {
            let v: Vec<f64> =
                m.players.iter().filter(|p| round.side_of(p.team) == side).filter_map(|p| equip.get(&(p.steamid, r))).map(|v| *v as f64).collect();
            if v.is_empty() {
                4000.0
            } else {
                v.iter().sum::<f64>() / v.len() as f64
            }
        };
        let (eq_t, eq_ct) = (team_eq(Side::T), team_eq(Side::CT));
        let mut alive: HashSet<u64> = m.players.iter().map(|p| p.steamid).collect();
        let count = |alive: &HashSet<u64>, side: Side| alive.iter().filter(|s| side_of(**s) == Some(side)).count() as u32;
        let wp = |alive: &HashSet<u64>, planted: bool| wp_t(count(alive, Side::T), count(alive, Side::CT), planted, eq_t, eq_ct);
        let mut add = |sid: u64, v: f64| *out.entry((sid, r)).or_default() += v;
        let plant = m.bomb.iter().find(|b| b.round == r && !b.defused);
        let mut planted = false;
        let mut p_t = wp(&alive, false);
        let mut kill_swing: HashMap<u64, f64> = HashMap::new();
        let mut kills: Vec<(usize, &Kill)> = m.kills.iter().enumerate().filter(|(_, k)| k.round == r && k.tick <= round.end_tick).collect();
        kills.sort_by_key(|(_, k)| k.tick);
        let all_kills = kills.clone();
        let apply_plant = |planted: &mut bool, p_t: &mut f64, alive: &HashSet<u64>, add: &mut dyn FnMut(u64, f64)| {
            let Some(b) = plant else { return };
            *planted = true;
            let after = wp(alive, true);
            let d = after - *p_t;
            *p_t = after;
            add(b.player, d);
            let cts: Vec<u64> = alive.iter().copied().filter(|s| side_of(*s) == Some(Side::CT)).collect();
            for s in &cts {
                add(*s, -d / cts.len() as f64);
            }
        };
        for (ki, k) in kills {
            if !planted && plant.is_some_and(|b| b.tick <= k.tick) {
                apply_plant(&mut planted, &mut p_t, &alive, &mut add);
            }
            let Some(v_side) = side_of(k.victim) else { continue };
            if !alive.remove(&k.victim) {
                continue;
            }
            let after = wp(&alive, planted);
            // Change for the victim's team (negative).
            let d = if v_side == Side::T { after - p_t } else { p_t - after };
            p_t = after;
            let enemy_kill = is_enemy_kill(m, k.attacker, k.victim);
            match (enemy_kill, k.attacker) {
                (true, Some(killer)) => {
                    add(k.victim, d);
                    let gain = -d;
                    let flasher = k.assister.filter(|s| k.flash_assist && side_of(*s) != Some(v_side));
                    // On a trade, the teammate the victim had just killed.
                    let avenged = a.rounds[r].trade_kills.contains(&ki).then(|| {
                        all_kills
                            .iter()
                            .rev()
                            .find(|(_, x)| {
                                x.attacker == Some(k.victim) && x.tick <= k.tick && k.tick - x.tick <= crate::analysis::TRADE_WINDOW_TICKS && side_of(x.victim) != Some(v_side)
                            })
                            .map(|(_, x)| x.victim)
                    });
                    let avenged = avenged.flatten();
                    let mut pool = gain;
                    if let Some(f) = flasher {
                        add(f, gain * 0.15);
                        *kill_swing.entry(f).or_default() += gain * 0.15;
                        pool -= gain * 0.15;
                    }
                    if let Some(t) = avenged {
                        add(t, gain * 0.2);
                        pool -= gain * 0.2;
                    }
                    let mut dmg: HashMap<u64, f64> = HashMap::new();
                    for x in m.damages.iter().filter(|x| x.round == r && x.victim == k.victim && x.tick <= k.tick) {
                        if let Some(att) = x.attacker.filter(|s| side_of(*s).is_some_and(|sd| sd != v_side)) {
                            *dmg.entry(att).or_default() += x.health_removed as f64;
                        }
                    }
                    let total: f64 = dmg.values().sum();
                    let mut killer_share = pool * 0.5;
                    if total > 0.0 {
                        for (sid, dm) in &dmg {
                            let share = pool * 0.5 * dm / total;
                            if *sid == killer {
                                killer_share += share;
                            } else {
                                add(*sid, share);
                                *kill_swing.entry(*sid).or_default() += share;
                            }
                        }
                    } else {
                        killer_share = pool;
                    }
                    add(killer, killer_share);
                    *kill_swing.entry(killer).or_default() += killer_share;
                }
                _ => {
                    // Team kill, suicide or the world: charge whoever caused it; nobody earned it.
                    let charged = k.attacker.filter(|a| side_of(*a) == Some(v_side)).unwrap_or(k.victim);
                    add(charged, d);
                    let gainers: Vec<u64> = alive.iter().copied().filter(|s| side_of(*s).is_some_and(|sd| sd != v_side)).collect();
                    for s in &gainers {
                        add(*s, -d / gainers.len() as f64);
                    }
                }
            }
        }
        if !planted && plant.is_some_and(|b| b.tick <= round.end_tick) {
            apply_plant(&mut planted, &mut p_t, &alive, &mut add);
        }
        // Round end: the rest of the round goes to the winners.
        let w = round.winner;
        let rest = if w == Side::T { 1.0 - p_t } else { p_t };
        if rest > 1e-6 {
            let winners: Vec<u64> = m.players.iter().map(|p| p.steamid).filter(|s| side_of(*s) == Some(w)).collect();
            let clutcher = a.rounds[r].clutches.iter().find(|c| c.won && side_of(c.player) == Some(w)).map(|c| c.player);
            let defuser = (round.reason == "bomb_defused").then(|| m.bomb.iter().find(|b| b.round == r && b.defused).map(|b| b.player)).flatten();
            let swingers: Vec<(u64, f64)> = winners.iter().filter_map(|s| kill_swing.get(s).filter(|v| **v > 0.0).map(|v| (*s, *v))).collect();
            let alive_w: Vec<u64> = winners.iter().copied().filter(|s| alive.contains(s)).collect();
            let weight = clutcher.map_or(0.0, |_| 1.0)
                + if swingers.is_empty() { 0.0 } else { 2.0 }
                + defuser.map_or(0.0, |_| 1.0)
                + if alive_w.is_empty() { 0.0 } else { 1.0 };
            if weight > 0.0 {
                let unit = rest / weight;
                if let Some(c) = clutcher {
                    add(c, unit);
                }
                let sw: f64 = swingers.iter().map(|(_, v)| v).sum();
                for (s, v) in &swingers {
                    add(*s, 2.0 * unit * v / sw);
                }
                if let Some(d) = defuser {
                    add(d, unit);
                }
                for s in &alive_w {
                    add(*s, unit / alive_w.len() as f64);
                }
            } else if !winners.is_empty() {
                for s in &winners {
                    add(*s, rest / winners.len() as f64);
                }
            }
            let losers: Vec<u64> = m.players.iter().map(|p| p.steamid).filter(|s| side_of(*s).is_some_and(|sd| sd != w)).collect();
            let alive_l: Vec<u64> = losers.iter().copied().filter(|s| alive.contains(s)).collect();
            let charged = if alive_l.is_empty() { &losers } else { &alive_l };
            for s in charged {
                add(*s, -rest / charged.len() as f64);
            }
        }
    }
    out
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

        // Rating 3.0 est. (HLTV, 2025): six sub-ratings, each 1.00 for the average player, with
        // HLTV's published weights. Matches analyzed before 3.0 existed fall back to 2.0 est.
        let have_r3 = self.e_kills + self.e_deaths > 0.0 || self.kills + self.deaths == 0;
        let parts = [
            self.e_kills / r / R3.kpr,
            self.e_damage / r / R3.adr,
            (1.0 - self.e_deaths / r).max(0.0) / (1.0 - R3.dpr),
            kast / 100.0 / R3.kast,
            self.multi_points / r / R3.multi,
            1.0 + self.swing / r / R3.swing_scale,
        ];
        let rating3 = if have_r3 { parts.iter().zip(R3_WEIGHTS).map(|(p, w)| p * w).sum() } else { rating2 };

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
            rating3,
            swing: 100.0 * self.swing / r,
            r3_parts: parts,
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
    let pistols = crate::analysis::pistol_rounds(m);

    // Each player's equipment value per round, as CS2 reports it on kills they were part of.
    let mut equip: HashMap<(u64, usize), u32> = HashMap::new();
    for k in &m.kills {
        if let (Some(att), Some(v)) = (k.attacker, k.attacker_equip_value) {
            let e = equip.entry((att, k.round)).or_default();
            *e = (*e).max(v);
        }
        if let Some(v) = k.victim_equip_value {
            let e = equip.entry((k.victim, k.round)).or_default();
            *e = (*e).max(v);
        }
    }

    for (i, k) in m.kills.iter().enumerate() {
        // Matches CS2's scoreboard: nothing after the match has ended counts, and neither do
        // bomb-explosion deaths.
        if k.tick > match_end_tick {
            continue;
        }
        if k.weapon != "planted_c4" {
            pr.entry((k.victim, k.round)).or_default().deaths += 1;
            if !is_enemy_kill(m, k.attacker, k.victim) {
                pr.entry((k.victim, k.round)).or_default().e_deaths += 1.0;
            }
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
            // Eco-adjusted (Rating 3.0): a kill is worth 2 x (1 - the killer's chance to win that
            // duel) by HLTV's matrix, so an anti-eco kill counts about 0.5 and an even duel about
            // 1.0. Assisted kills count less, opening kills more; the victim is charged the same
            // points, less if their death was traded, more if it was the opening death.
            let facts = &a.rounds[k.round];
            let opening = facts.opening_kill == Some(i);
            let base = 2.0 * (1.0 - duel_p(m.side_in_round(attacker, k.round), k.attacker_equip_value, k.victim_equip_value));
            let assisted = k.assister.is_some_and(|s| m.team_of(s).is_some() && m.team_of(s) != m.team_of(k.victim));
            let c = pr.entry((attacker, k.round)).or_default();
            c.kills += 1;
            c.headshot_kills += k.headshot as u32;
            c.trade_kills += facts.trade_kills.contains(&i) as u32;
            c.e_kills += base * if assisted { 0.85 } else { 1.0 } * if opening { 1.1 } else { 1.0 };
            if pistols.contains(&k.round) {
                c.pistol_kills += 1;
            } else if k.victim_equip_value.is_some_and(|v| v < crate::highlights::ECO_EQUIP_VALUE) {
                c.eco_kills += 1;
            }
            if k.weapon != "planted_c4" {
                let v = pr.entry((k.victim, k.round)).or_default();
                v.e_deaths += base * if facts.traded.contains(&k.victim) { 0.75 } else { 1.0 } * if opening { 1.15 } else { 1.0 };
            }
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
        c.e_damage += d.health_removed as f64
            * 2.0
            * (1.0 - duel_p(m.side_in_round(attacker, d.round), equip.get(&(attacker, d.round)).copied(), equip.get(&(d.victim, d.round)).copied()));
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
            c.multi_points += MULTI_POINTS[kills.min(5) as usize];
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

    for ((sid, r), v) in round_swing(m, a, &equip) {
        pr.entry((sid, r)).or_default().swing += v;
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
    out.sort_by(|a, b| (a.team as u8).cmp(&(b.team as u8)).then(b.derived.rating3.total_cmp(&a.derived.rating3)));
    out
}
