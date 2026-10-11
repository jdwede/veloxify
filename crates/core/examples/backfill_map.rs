//! Rebuilds one map's outdated match details (and 2D replays), newest first, then the match
//! insights: for trying the insights pages without waiting for the app's background re-read.
//!   cargo run --release -p cs2hl-core --example backfill_map -- <library> <my steamid64> <map> [limit]
use cs2hl_core::{analysis, demo_io, details, insights, library::Index, library::MatchEntry, model};
use std::path::Path;

fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let lib = std::path::PathBuf::from(args.next().expect("library"));
    let me: u64 = args.next().expect("steamid").parse()?;
    let map = args.next().expect("map");
    let limit: usize = args.next().map(|s| s.parse()).transpose()?.unwrap_or(usize::MAX);
    let index: Index = serde_json::from_str(&std::fs::read_to_string(lib.join("index.json"))?)?;
    let mut ms: Vec<_> = index.matches.iter().filter(|m| m.map == map && details::stale(&lib, &m.id)).collect();
    ms.sort_by_key(|m| std::cmp::Reverse(m.played_ts));
    let t = std::time::Instant::now();
    let mut n = 0;
    for m in ms.into_iter().take(limit) {
        let entry: MatchEntry = serde_json::from_str(&std::fs::read_to_string(lib.join("matches").join(format!("{}.json", m.id)))?)?;
        let p = Path::new(&entry.demo_path);
        if !p.exists() {
            println!("skip {} (demo gone)", m.id);
            continue;
        }
        let demo = demo_io::read_demo(p)?;
        let mm = model::load_match(&demo)?;
        let a = analysis::analyze(&mm);
        details::write(&lib, &m.id, &demo, &mm, &a, me)?;
        n += 1;
        println!("{n} {} ({:.0}s)", m.id, t.elapsed().as_secs_f64());
    }
    let built = insights::update(&lib, std::time::Duration::from_secs(600))?;
    println!("rebuilt {n} matches, {built} insights in {:.0}s", t.elapsed().as_secs_f64());
    Ok(())
}
