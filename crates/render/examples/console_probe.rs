//! Runs console commands in a hidden CS2 (optionally on an offline map) and prints what CS2 says
//! back to each, for finding out what CS2's console can do.
//!   cargo run --release -p cs2hl-render --example console_probe -- <steamid64> <profile.json> <map|-> "<cmd>" "<cmd>" ...
//! A command `sleep <ms>` waits instead.

use anyhow::Result;
use cs2hl_render::profile::Profile;
use cs2hl_render::session::Renderer;
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::thread::sleep;
use std::time::Duration;

fn main() -> Result<()> {
    let a: Vec<String> = std::env::args().skip(1).collect();
    let me: u64 = a[0].parse()?;
    let profile = Profile::load(Path::new(&a[1]))?;
    let map = &a[2];
    let work = std::env::temp_dir().join("veloxify-console-probe");
    std::fs::create_dir_all(&work)?;
    let r = Renderer::start(me, profile, &work, Arc::new(AtomicBool::new(false)), Box::new(|s| eprintln!("  [cs2] {s}")))?;
    let result = (|| -> Result<()> {
        let vc = r.console();
        if map != "-" {
            let since = vc.mark();
            vc.send(&format!("map {map}"));
            println!("map: {:?}", vc.wait_for_any(&["Signon traffic"], Duration::from_secs(180), since).is_some());
            sleep(Duration::from_secs(3));
        }
        for c in &a[3..] {
            if let Some(ms) = c.strip_prefix("sleep ") {
                sleep(Duration::from_millis(ms.parse()?));
                continue;
            }
            let since = vc.mark();
            vc.send(c);
            sleep(Duration::from_millis(700));
            println!("> {c}");
            for l in vc.lines_since(since) {
                if !l.contains("animgraph") && !l.contains("OnPreResetRound") {
                    println!("  {l}");
                }
            }
        }
        Ok(())
    })();
    r.close();
    result
}
