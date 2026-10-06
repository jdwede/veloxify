//! Whose eyes is the demo camera in? Loads demos in CS2 the way the renderer does and, while the
//! demo plays, compares CS2's camera position (`getpos`) with every player's position in the demo.
//!
//!   cargo run --release -p cs2hl-render --example pov_probe -- <steamid64> <profile.json> \
//!       <demo.dem[.zst]>:<start>-<end>[,<start>-<end>...] ... [--relock]
//!
//! `--relock` clears the lock before setting it again (the fix under test).

use anyhow::{Context, Result};
use cs2hl_core::{demo_io, raw};
use cs2hl_render::profile::Profile;
use cs2hl_render::session::Renderer;
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::{Duration, Instant};

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let relock = args.iter().any(|a| a == "--relock");
    // --strategies=<name>: try several ways of pointing the camera at the player instead.
    let strategies = args.iter().find_map(|a| a.strip_prefix("--strategies=")).map(str::to_string);
    let args: Vec<&String> = args.iter().filter(|a| !a.starts_with("--")).collect();
    let me: u64 = args[0].parse()?;
    let account = me - 76561197960265728;
    let profile = Profile::load(Path::new(args[1]))?;
    let work = std::env::temp_dir().join("veloxify-pov-probe");
    std::fs::create_dir_all(&work)?;
    let r = Renderer::start(me, profile, &work, Arc::new(AtomicBool::new(false)), Box::new(|s| eprintln!("  [cs2] {s}")))?;
    let result = (|| -> Result<()> {
        for spec in &args[2..] {
            let (path, ranges) = spec.rsplit_once(':').context("<demo>:<start>-<end>")?;
            let ranges: Vec<(i32, i32)> = ranges
                .split(',')
                .map(|r| {
                    let (a, b) = r.split_once('-').unwrap();
                    (a.parse().unwrap(), b.parse().unwrap())
                })
                .collect();
            let bytes = demo_io::read_demo(Path::new(path))?;
            let dem = work.join("probe.dem");
            std::fs::write(&dem, &bytes)?;
            // Everyone's position every 4 ticks over the ranges (plus the settle time before).
            let mut ticks: Vec<i32> = ranges.iter().flat_map(|&(a, b)| ((a - 200)..=(b + 64)).step_by(4)).collect();
            ticks.extend(ranges.iter().map(|&(a, _)| a - 64));
            ticks.sort();
            ticks.dedup();
            let names: HashMap<u64, String> = {
                let ev = raw::player_props_at(&bytes, &["team_num"], &[ranges[0].0])?;
                ev.keys().map(|k| (*k, k.to_string())).collect()
            };
            let sids: Vec<u64> = names.keys().copied().collect();
            let pos = raw::players_series(&bytes, &sids, &["X", "Y", "Z"], &ticks)?;
            println!("== {} ({} players)", Path::new(path).file_name().unwrap().to_string_lossy(), sids.len());
            r.load_demo(&dem, strategies.as_deref().unwrap_or(""))?;
            let vc = r.console();
            if let Some(name) = &strategies {
                // Where the camera is (nearest player, distance) at `tick`.
                let nearest = |tick: i32| -> String {
                    let since = vc.mark();
                    vc.send("getpos");
                    let l = vc.wait_for("setpos", Duration::from_secs(2), since).unwrap_or_default();
                    let n: Vec<f64> = l.split(|c: char| c == ' ' || c == ';').filter_map(|w| w.parse().ok()).collect();
                    if n.len() < 2 {
                        return "no answer".into();
                    }
                    let mut best: Option<(f64, u64)> = None;
                    for &sid in &sids {
                        for t in ((tick - 48)..=(tick + 48)).step_by(4) {
                            if let Some(p) = pos.get(&(sid, t)) {
                                let d = (p["X"] - n[0]).hypot(p["Y"] - n[1]);
                                if best.is_none_or(|b| d < b.0) {
                                    best = Some((d, sid));
                                }
                            }
                        }
                    }
                    match best {
                        Some((d, sid)) if sid == me => format!("ME({d:.0})"),
                        Some((d, sid)) => format!("other:{}({d:.0})", sid % 100000),
                        None => "?".into(),
                    }
                };
                let (start, _) = ranges[0];
                let at = start - 64;
                let tries: Vec<(&str, Vec<String>)> = vec![
                    ("plain lock", vec![format!("spec_lock_to_accountid {account}")]),
                    ("clear+lock", vec!["spec_lock_to_accountid 0".into(), format!("spec_lock_to_accountid {account}")]),
                    ("spec_player_by_accountid", vec!["spec_lock_to_accountid 0".into(), format!("spec_player_by_accountid {account}")]),
                    ("spec_player name", vec!["spec_lock_to_accountid 0".into(), format!("spec_player \"{name}\"")]),
                    ("by_accountid+lock", vec!["spec_lock_to_accountid 0".into(), format!("spec_player_by_accountid {account}"), format!("spec_lock_to_accountid {account}")]),
                    ("name+lock", vec!["spec_lock_to_accountid 0".into(), format!("spec_player \"{name}\""), format!("spec_lock_to_accountid {account}")]),
                ];
                for (label, cmds) in &tries {
                    vc.send("demo_pause");
                    vc.send(&format!("demo_gototick {at}"));
                    std::thread::sleep(Duration::from_millis(1500));
                    let before = nearest(at);
                    let since = vc.mark();
                    for c in cmds {
                        vc.send(c);
                        std::thread::sleep(Duration::from_millis(200));
                    }
                    std::thread::sleep(Duration::from_millis(500));
                    let replies: Vec<String> = vc.lines_since(since).into_iter().filter(|l| !l.trim().is_empty()).take(3).collect();
                    let paused = nearest(at);
                    vc.send("demo_resume");
                    std::thread::sleep(Duration::from_millis(2000));
                    vc.send("demo_pause");
                    let playing = nearest(at + 128);
                    std::thread::sleep(Duration::from_millis(300));
                    let after_jump = {
                        vc.send(&format!("demo_gototick {}", at + 320));
                        std::thread::sleep(Duration::from_millis(1500));
                        nearest(at + 320)
                    };
                    println!("  {label:<26} before={before:<16} paused={paused:<16} playing={playing:<16} next-jump={after_jump:<16} console={replies:?}");
                }
                continue;
            }
            for &(start, end) in &ranges {
                // As Renderer::record does it.
                vc.send("demo_pause");
                vc.send(&format!("demo_gototick {}", start - 64));
                std::thread::sleep(Duration::from_millis(1500));
                if relock {
                    vc.send("spec_lock_to_accountid 0");
                    std::thread::sleep(Duration::from_millis(100));
                }
                vc.send(&format!("spec_lock_to_accountid {account}"));
                std::thread::sleep(Duration::from_millis(300));
                // Paused at the jump target: where's the camera?
                let since = vc.mark();
                vc.send("getpos");
                let paused = vc.wait_for("setpos", Duration::from_secs(2), since).unwrap_or_default();
                let nums: Vec<f64> = paused.split(|c: char| c == ' ' || c == ';').filter_map(|w| w.parse().ok()).collect();
                let mut near: Vec<(f64, u64)> = sids
                    .iter()
                    .filter_map(|&sid| pos.get(&(sid, start - 64)).map(|p| (p["X"] - nums.first().copied().unwrap_or(0.0)).hypot(p["Y"] - nums.get(1).copied().unwrap_or(0.0))).map(|d| (d, sid)))
                    .collect();
                near.sort_by(|a, b| a.0.total_cmp(&b.0));
                println!("  paused at {}: {} nearest={:?}", start - 64, paused.trim(), near.first().map(|(d, s)| (if *s == me { "ME".to_string() } else { s.to_string() }, *d as i64)));
                vc.send("demo_resume");
                let t0 = Instant::now();
                let secs = (end - start + 64) as f64 / 64.0;
                let mut line = format!("  {start}-{end}:");
                while t0.elapsed().as_secs_f64() < secs {
                    std::thread::sleep(Duration::from_millis(1000));
                    let est = start - 64 + (t0.elapsed().as_secs_f64() * 64.0) as i32;
                    let since = vc.mark();
                    vc.send("getpos");
                    let Some(l) = vc.wait_for("setpos", Duration::from_secs(2), since) else { continue };
                    let nums: Vec<f64> = l.split(|c: char| c == ' ' || c == ';').filter_map(|w| w.parse().ok()).collect();
                    if nums.len() < 3 {
                        continue;
                    }
                    // Nearest player to the camera within ±0.75 s of the estimated tick.
                    let mut best: Option<(f64, u64)> = None;
                    for &sid in &sids {
                        for t in ((est - 48)..=(est + 48)).step_by(4) {
                            if let Some(p) = pos.get(&(sid, t)) {
                                let d = (p["X"] - nums[0]).hypot(p["Y"] - nums[1]);
                                if best.is_none_or(|b| d < b.0) {
                                    best = Some((d, sid));
                                }
                            }
                        }
                    }
                    match best {
                        Some((d, sid)) if sid == me => line += &format!(" ME({d:.0})"),
                        Some((d, sid)) => line += &format!(" other:{}({d:.0})", sid % 100000),
                        None => line += " ?",
                    }
                }
                vc.send("demo_pause");
                println!("{line}");
            }
        }
        Ok(())
    })();
    r.close();
    result
}
