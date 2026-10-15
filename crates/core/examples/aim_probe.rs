//! Rebuilds one player's aim stats for the matches Leetify also has (its per-match export), and
//! prints both side by side with the Leetify-style Aim rating, for tuning `sight` and `details`.
//!   VELOXIFY_CSGO=<game/csgo> cargo run --release -p cs2hl-core --example aim_probe -- <library> <steamid64> <leetify profile_matches.json> [limit]
//! Demo paths under VELOXIFY_PATH_FROM are read through VELOXIFY_PATH_TO (e.g. a UNC share).
use cs2hl_core::{analysis, demo_io, details, library::Index, library::MatchEntry, model};
use std::path::{Path, PathBuf};

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let lib = PathBuf::from(&args[0]);
    let me: u64 = args[1].parse()?;
    let leetify: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&args[2])?)?;
    let limit: usize = args.get(3).map(|s| s.parse()).transpose()?.unwrap_or(usize::MAX);
    let index: Index = serde_json::from_str(&std::fs::read_to_string(lib.join("index.json"))?)?;
    let me_s = me.to_string();
    let mut rows = vec![];
    for lm in leetify.as_array().unwrap() {
        if rows.len() >= limit {
            break;
        }
        let Some(st) = lm["stats"].as_array().unwrap().iter().find(|s| s["steam64_id"] == me_s.as_str()) else { continue };
        let my_team = st["initial_team_number"].as_i64().unwrap();
        let scores: Vec<(i64, i64)> = lm["team_scores"].as_array().unwrap().iter().map(|t| (t["team_number"].as_i64().unwrap(), t["score"].as_i64().unwrap())).collect();
        let mine = scores.iter().find(|t| t.0 == my_team).map(|t| t.1).unwrap_or(0) as u32;
        let theirs = scores.iter().find(|t| t.0 != my_team).map(|t| t.1).unwrap_or(0) as u32;
        let map = lm["map_name"].as_str().unwrap();
        let finished = chrono::DateTime::parse_from_rfc3339(lm["finished_at"].as_str().unwrap())?.timestamp();
        let Some(sum) = index.matches.iter().filter(|m| m.map == map && m.score_mine == mine && m.score_theirs == theirs && (m.played_ts + m.duration_s as i64 - finished).abs() < 3 * 3600).min_by_key(|m| (m.played_ts - finished).abs()) else { continue };
        let entry: MatchEntry = serde_json::from_str(&std::fs::read_to_string(lib.join("matches").join(format!("{}.json", sum.id)))?)?;
        let mut path = entry.demo_path.clone();
        if let (Ok(from), Ok(to)) = (std::env::var("VELOXIFY_PATH_FROM"), std::env::var("VELOXIFY_PATH_TO")) {
            if path.to_lowercase().starts_with(&from.to_lowercase()) {
                path = format!("{to}{}", &path[from.len()..]);
            }
        }
        if !Path::new(&path).exists() {
            continue;
        }
        let t = std::time::Instant::now();
        let demo = demo_io::read_demo(Path::new(&path))?;
        let m = model::load_match(&demo)?;
        let a = analysis::analyze(&m);
        let d = details::build(&demo, &m, &a, me)?;
        let Some(p) = d.players.iter().find(|p| p.steamid == me_s) else { continue };
        let a = &p.aim;
        let pct = |x: u32, y: u32| if y > 0 { x as f64 / y as f64 } else { f64::NAN };
        let ours = [pct(a.spotted_hits, a.spotted_shots), a.ttd_ms.unwrap_or(f64::NAN) / 1000.0, a.crosshair_deg.unwrap_or(f64::NAN), pct(a.head_hits, a.body_hits), pct(a.spray_hits, a.spray_shots), pct(a.strafe_good, a.strafe_shots)];
        let f = |k: &str| st[k].as_f64().unwrap_or(f64::NAN);
        let theirs = [f("accuracy_enemy_spotted"), f("reaction_time"), f("preaim"), f("accuracy_head"), f("spray_accuracy"), f("counter_strafing_shots_good_ratio")];
        println!(
            "{} {:<9} spot {:.0}/{:.0}%  ttd {:.0}/{:.0}  cp {:.1}/{:.1}  head {:.0}/{:.0}%  spray {:.0}/{:.0}%  cs {:.0}/{:.0}%  aim {:.0}/{:.0}  shots {}/{} spotted shots {}/{}  ({:.0}s)",
            &entry.played_at[..16], &map[3..],
            ours[0] * 100.0, theirs[0] * 100.0, ours[1] * 1000.0, theirs[1] * 1000.0, ours[2], theirs[2], ours[3] * 100.0, theirs[3] * 100.0,
            ours[4] * 100.0, theirs[4] * 100.0, ours[5] * 100.0, theirs[5] * 100.0, aim(&ours), aim(&theirs),
            a.shots, f("shots_fired"), a.spotted_shots, f("shots_fired_enemy_spotted"), t.elapsed().as_secs_f64()
        );
        rows.push((ours, theirs));
    }
    // Per stat: correlation and mean of ours vs Leetify's.
    let names = ["spotted acc", "time to damage", "crosshair", "head acc", "spray acc", "counter-strafe"];
    for (k, name) in names.iter().enumerate() {
        let pairs: Vec<(f64, f64)> = rows.iter().map(|(o, t)| (o[k], t[k])).filter(|(o, t)| o.is_finite() && t.is_finite()).collect();
        let n = pairs.len() as f64;
        let (mo, mt) = (pairs.iter().map(|p| p.0).sum::<f64>() / n, pairs.iter().map(|p| p.1).sum::<f64>() / n);
        let cov: f64 = pairs.iter().map(|p| (p.0 - mo) * (p.1 - mt)).sum();
        let (vo, vt): (f64, f64) = (pairs.iter().map(|p| (p.0 - mo).powi(2)).sum(), pairs.iter().map(|p| (p.1 - mt).powi(2)).sum());
        println!("{name:<15} n={n:.0} corr={:.2} ours={mo:.3} leetify={mt:.3}", cov / (vo * vt).sqrt());
    }
    let aims: Vec<(f64, f64)> = rows.iter().map(|(o, t)| (aim(o), aim(t))).collect();
    let rmse = (aims.iter().map(|(a, b)| (a - b).powi(2)).sum::<f64>() / aims.len() as f64).sqrt();
    println!("aim rating (Leetify formula on both): RMSE {rmse:.1} over {} matches", aims.len());
    Ok(())
}

/// Leetify-style Aim rating: 100 x Phi(mean z) of the six stats against Leetify's averages and
/// spreads (from public profile pages and the user's lobbies; see the research notes).
fn aim(s: &[f64; 6]) -> f64 {
    const MU: [f64; 6] = [0.33, 0.641, 10.19, 0.19, 0.34, 0.76];
    const SD: [f64; 6] = [0.0712, 0.1061, 3.1744, 0.0896, 0.1404, 0.0857];
    const LOWER: [bool; 6] = [false, true, true, false, false, false];
    let zs: Vec<f64> = (0..6).filter(|&k| s[k].is_finite()).map(|k| (s[k] - MU[k]) / SD[k] * if LOWER[k] { -1.0 } else { 1.0 }).collect();
    let z = zs.iter().sum::<f64>() / zs.len().max(1) as f64;
    100.0 * 0.5 * (1.0 + erf(z / std::f64::consts::SQRT_2))
}

fn erf(x: f64) -> f64 {
    // Abramowitz-Stegun 7.1.26.
    let t = 1.0 / (1.0 + 0.3275911 * x.abs());
    let y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * (-x * x).exp();
    if x >= 0.0 { y } else { -y }
}
