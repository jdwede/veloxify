//! Per-round derived facts shared by stats and highlight detection: opening duels, trades,
//! survival and clutch situations.

use crate::model::{Match, TeamId, TICKRATE};
use serde::Serialize;
use std::collections::{HashMap, HashSet};

/// HLTV (Rating 3.0) and cs-demo-analyzer both use a 5 second trade window.
pub const TRADE_WINDOW_TICKS: i32 = (5.0 * TICKRATE) as i32;

#[derive(Debug, Clone, Serialize)]
pub struct Clutch {
    pub round: usize,
    pub player: u64,
    /// Enemies alive when the player became the last one alive on their team.
    pub vs: u32,
    pub start_tick: i32,
    pub won: bool,
    /// Enemy kills the clutcher got after the clutch started.
    pub kills: u32,
}

#[derive(Debug, Clone, Default)]
pub struct RoundFacts {
    /// Index into `Match::kills` of the first enemy kill of the round.
    pub opening_kill: Option<usize>,
    /// Kill indices that avenged a teammate within the trade window.
    pub trade_kills: HashSet<usize>,
    /// Players whose death was traded.
    pub traded: HashSet<u64>,
    pub died: HashSet<u64>,
    pub clutches: Vec<Clutch>,
}

#[derive(Debug, Clone)]
pub struct Analysis {
    pub rounds: Vec<RoundFacts>,
}

impl Analysis {
    pub fn clutches(&self) -> impl Iterator<Item = &Clutch> {
        self.rounds.iter().flat_map(|r| r.clutches.iter())
    }
}

/// True when `attacker` killed someone on the other team (excludes suicides, world and team kills).
pub fn is_enemy_kill(m: &Match, attacker: Option<u64>, victim: u64) -> bool {
    match attacker {
        Some(a) if a != victim => match (m.team_of(a), m.team_of(victim)) {
            (Some(ta), Some(tv)) => ta != tv,
            _ => false,
        },
        _ => false,
    }
}

pub fn analyze(m: &Match) -> Analysis {
    let mut rounds: Vec<RoundFacts> = vec![RoundFacts::default(); m.rounds.len()];
    let mut kills_by_round: Vec<Vec<usize>> = vec![vec![]; m.rounds.len()];
    for (i, k) in m.kills.iter().enumerate() {
        kills_by_round[k.round].push(i);
    }

    for (r, kill_idxs) in kills_by_round.iter().enumerate() {
        let facts = &mut rounds[r];
        let round = &m.rounds[r];
        let mut alive: HashMap<TeamId, HashSet<u64>> = HashMap::new();
        for p in &m.players {
            alive.entry(p.team).or_default().insert(p.steamid);
        }
        // Clutch candidates: (team, player, vs, start_tick, kills_before)
        let mut open_clutch: HashMap<TeamId, (u64, u32, i32)> = HashMap::new();
        let mut clutch_kills: HashMap<u64, u32> = HashMap::new();

        for (n, &ki) in kill_idxs.iter().enumerate() {
            let k = &m.kills[ki];
            let enemy_kill = is_enemy_kill(m, k.attacker, k.victim);
            if enemy_kill && facts.opening_kill.is_none() {
                facts.opening_kill = Some(ki);
            }
            // Trades: this kill avenges any teammate the victim killed within the window.
            if enemy_kill {
                let attacker = k.attacker.unwrap();
                for &prev in &kill_idxs[..n] {
                    let pk = &m.kills[prev];
                    if pk.attacker == Some(k.victim)
                        && k.tick - pk.tick <= TRADE_WINDOW_TICKS
                        && m.team_of(pk.victim) == m.team_of(attacker)
                        && pk.victim != attacker
                    {
                        facts.trade_kills.insert(ki);
                        facts.traded.insert(pk.victim);
                    }
                }
                if open_clutch.values().any(|(p, _, _)| *p == attacker) {
                    *clutch_kills.entry(attacker).or_default() += 1;
                }
            }
            facts.died.insert(k.victim);
            if let Some(t) = m.team_of(k.victim) {
                alive.entry(t).or_default().remove(&k.victim);
            }
            // Only deaths before the round is decided can create a clutch situation.
            if k.tick > round.end_tick {
                continue;
            }
            for team in [TeamId::A, TeamId::B] {
                let mine = alive.get(&team).map(|s| s.len()).unwrap_or(0);
                let other = team_other(team);
                let theirs = alive.get(&other).map(|s| s.len()).unwrap_or(0) as u32;
                if mine == 1 && theirs > 0 && !open_clutch.contains_key(&team) {
                    let p = *alive[&team].iter().next().unwrap();
                    open_clutch.insert(team, (p, theirs, k.tick));
                }
            }
        }

        for (team, (player, vs, start_tick)) in open_clutch {
            facts.clutches.push(Clutch {
                round: r,
                player,
                vs,
                start_tick,
                won: round.winner_team() == team,
                kills: clutch_kills.get(&player).copied().unwrap_or(0),
            });
        }
        facts.clutches.sort_by_key(|c| c.start_tick);
    }
    Analysis { rounds }
}

fn team_other(t: TeamId) -> TeamId {
    match t {
        TeamId::A => TeamId::B,
        TeamId::B => TeamId::A,
    }
}
