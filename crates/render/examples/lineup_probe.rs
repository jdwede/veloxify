//! Films one grenade lineup from a library match (checking CS2's free camera in demo playback).
//!
//!   cargo run --release -p cs2hl-render --example lineup_probe -- <steamid64> <profile.json> \
//!       <library> <match id> <throw index | smoke | molotov | flash | he> <out.mp4>
//!
//! Picks the throw (or the first set/instant one of that kind with a flight path), loads the demo
//! the way the renderer does, prints what CS2 says about its spectator commands, then films it.

use anyhow::{Context, Result};
use cs2hl_core::{demo_io, raw};
use cs2hl_render::profile::Profile;
use cs2hl_render::session::{LineupShot, Renderer};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let me: u64 = args[0].parse()?;
    let profile = Profile::load(Path::new(&args[1]))?;
    let lib = PathBuf::from(&args[2]);
    let id = &args[3];
    let pick = &args[4];
    let out = PathBuf::from(&args[5]);
    let entry: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(lib.join("matches").join(format!("{id}.json")))?)?;
    let details: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(lib.join("matches").join(format!("{id}.details.json")))?)?;
    let throws = details["throws"].as_array().context("no throws")?;
    let t = match pick.parse::<usize>() {
        Ok(i) => &throws[i],
        Err(_) => throws
            .iter()
            .find(|t| t["kind"] == pick.as_str() && t["path"].as_array().is_some_and(|p| p.len() > 4) && (t["set"] == true || t["t"].as_f64().unwrap_or(99.0) < 10.0))
            .context("no such throw")?,
    };
    let sid = t["player"].as_str().unwrap_or_default();
    let name = entry["players"].as_array().and_then(|ps| ps.iter().find(|p| p["steamid"] == sid)).and_then(|p| p["name"].as_str()).unwrap_or_default().to_string();
    let path: Vec<[f64; 3]> = t["path"].as_array().unwrap().iter().map(|p| [p[0].as_f64().unwrap(), p[1].as_f64().unwrap(), p[2].as_f64().unwrap()]).collect();
    let (tick, pop) = (t["tick"].as_i64().unwrap() as i32, t["pop_tick"].as_i64().unwrap() as i32);
    println!("{} {} by {name}: round {} at {:.1}s, ticks {tick}-{pop}, {} path points", t["kind"], t["technique"], t["round"], t["t"].as_f64().unwrap_or(0.0), path.len());

    let demo_path = entry["demo_path"].as_str().context("no demo")?;
    let bytes = demo_io::read_demo(Path::new(demo_path))?;
    let lead = 2.0;
    let start = tick - (lead * 64.0) as i32;
    let pos = raw::players_series(&bytes, &[sid.parse()?], &["X", "Y"], &[start])?;
    let eye = pos.get(&(sid.parse()?, start)).map(|p| (p["X"], p["Y"]));
    let work = std::env::temp_dir().join("veloxify-lineup-probe");
    std::fs::create_dir_all(&work)?;
    let dem = work.join("probe.dem");
    std::fs::write(&dem, &bytes)?;

    let r = Renderer::start(me, profile, &work, Arc::new(AtomicBool::new(false)), Box::new(|s| eprintln!("  [cs2] {s}")))?;
    let result = (|| -> Result<()> {
        r.load_demo(&dem, &name)?;
        let vc = r.console();
        for cmd in ["find spec_goto", "find spec_mode", "find freecam"] {
            let since = vc.mark();
            vc.send(cmd);
            std::thread::sleep(Duration::from_millis(900));
            println!("== {cmd}");
            for l in vc.lines_since(since).iter().take(14) {
                println!("   {l}");
            }
        }
        let shot = LineupShot { thrower: name.clone(), eye, throw_tick: tick, pop_tick: pop, path, lead_s: lead, hold_s: 3.0 };
        let t0 = std::time::Instant::now();
        r.record_lineup(&shot, &out)?;
        println!("filmed {} in {:.0}s", out.display(), t0.elapsed().as_secs_f64());
        Ok(())
    })();
    r.close();
    result
}
