//! Runs the lineup-video batch the way the app does, printing every step with timestamps.
//!   cargo run --release -p cs2hl-render --example lineup_batch -- <steamid64> <profile.json> <library> <how many> [lineup ids,...]

use anyhow::Result;
use cs2hl_render::batch::{render_lineups, Event};
use cs2hl_render::profile::Profile;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Instant;

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let me: u64 = args[0].parse()?;
    let profile = Profile::load(Path::new(&args[1]))?;
    let lib = PathBuf::from(&args[2]);
    let n: usize = args[3].parse()?;
    let ids: Option<Vec<String>> = args.get(4).map(|s| s.split(',').map(String::from).collect());
    let work = std::env::temp_dir().join("veloxify-lineup-batch");
    std::fs::create_dir_all(&work)?;
    let t0 = Instant::now();
    let stamp = || format!("{:>6.1}s", t0.elapsed().as_secs_f64());
    let done = render_lineups(&lib, me, profile, &work, ids, n, Arc::new(AtomicBool::new(false)), &mut |e| match e {
        Event::Plan { total, more } => println!("{} plan: {total} ({more} more later)", stamp()),
        Event::Filming { title } => println!("{} filming {title}", stamp()),
        Event::Rendered { match_id, title, took_s, .. } => println!("{} RENDERED {title} ({match_id}) in {took_s:.0}s", stamp()),
        Event::Failed { title, error, .. } => println!("{} FAILED {title}: {error}", stamp()),
        Event::Done { rendered, .. } => println!("{} done: {rendered}", stamp()),
        Event::Stopped { rendered, .. } => println!("{} stopped: {rendered}", stamp()),
        Event::Log(s) => println!("{} {s}", stamp()),
    })?;
    println!("{} filmed {done}", stamp());
    Ok(())
}
