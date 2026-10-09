//! After a free-camera shot, which commands put CS2's demo camera back in a player's eyes?
//!   cargo run --release -p cs2hl-render --example specmode_probe -- <steamid64> <profile.json> <library> <match id>
//! Puts the camera in free-cam mode, then tries each way of returning to a thrower's eyes and
//! prints how far the camera ended up from them.

use anyhow::Result;
use cs2hl_core::{demo_io, raw};
use cs2hl_render::profile::Profile;
use cs2hl_render::session::Renderer;
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
    let entry: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(lib.join("matches").join(format!("{id}.json")))?)?;
    let details: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(lib.join("matches").join(format!("{id}.details.json")))?)?;
    let name_of = |sid: &str| entry["players"].as_array().and_then(|ps| ps.iter().find(|p| p["steamid"] == sid)).and_then(|p| p["name"].as_str()).unwrap_or("").to_string();
    // A few throws by different players.
    let mut picks: Vec<(String, i32)> = vec![];
    for t in details["throws"].as_array().unwrap() {
        let p = t["player"].as_str().unwrap().to_string();
        if !picks.iter().any(|(q, _)| *q == p) && t["t"].as_f64().unwrap_or(0.0) > 8.0 {
            picks.push((p, t["tick"].as_i64().unwrap() as i32));
        }
        if picks.len() == 4 {
            break;
        }
    }
    let bytes = demo_io::read_demo(Path::new(entry["demo_path"].as_str().unwrap()))?;
    let sids: Vec<u64> = picks.iter().map(|(p, _)| p.parse().unwrap()).collect();
    let ticks: Vec<i32> = picks.iter().map(|(_, t)| t - 160).collect();
    let pos = raw::players_series(&bytes, &sids, &["X", "Y"], &ticks)?;
    let work = std::env::temp_dir().join("veloxify-specmode-probe");
    std::fs::create_dir_all(&work)?;
    let dem = work.join("probe.dem");
    std::fs::write(&dem, &bytes)?;
    let r = Renderer::start(me, profile, &work, Arc::new(AtomicBool::new(false)), Box::new(|s| eprintln!("  [cs2] {s}")))?;
    let result = (|| -> Result<()> {
        r.load_demo(&dem, &name_of(&picks[0].0))?;
        let vc = r.console();
        let camera = || -> Option<(f64, f64)> {
            let since = vc.mark();
            vc.send("getpos");
            let l = vc.wait_for("setpos", Duration::from_secs(2), since)?;
            let n: Vec<f64> = l.split(|c: char| c.is_whitespace() || c == ';').filter_map(|w| w.parse().ok()).collect();
            (n.len() >= 2).then(|| (n[0], n[1]))
        };
        let strategies: [(&str, &[&str]); 5] = [
            ("spec_player only", &["spec_player \"{n}\""]),
            ("spec_mode 1 + spec_player", &["spec_mode 1", "spec_player \"{n}\""]),
            ("spec_mode 2 + spec_player", &["spec_mode 2", "spec_player \"{n}\""]),
            ("spec_player + spec_mode 1", &["spec_player \"{n}\"", "spec_mode 1"]),
            ("spec_player + spec_mode 2", &["spec_player \"{n}\"", "spec_mode 2"]),
        ];
        for (sname, cmds) in strategies {
            for (p, tick) in &picks {
                let start = tick - 160;
                vc.send("demo_pause");
                vc.send(&format!("demo_gototick {start}"));
                std::thread::sleep(Duration::from_millis(1500));
                // As a lineup shot leaves it: free camera somewhere else.
                vc.send("spec_mode 4");
                vc.send("spec_goto 0 0 500 45 0");
                std::thread::sleep(Duration::from_millis(400));
                let name = name_of(p);
                for c in cmds {
                    vc.send(&c.replace("{n}", &name));
                    std::thread::sleep(Duration::from_millis(250));
                }
                std::thread::sleep(Duration::from_millis(800));
                let want = pos.get(&(p.parse().unwrap(), start)).map(|v| (v["X"], v["Y"]));
                let got = camera();
                let off = match (want, got) {
                    (Some(w), Some(g)) => format!("{:.0} units off", (w.0 - g.0).hypot(w.1 - g.1)),
                    _ => "no answer".into(),
                };
                println!("{sname:<28} {name:<16} {off}");
            }
        }
        Ok(())
    })();
    r.close();
    result
}
