//! Builds missing match-page details for a library's newest matches, then its benchmarks.
//!   cargo run --release -p cs2hl-core --example backfill_details -- <library> <my steamid64> [limit]
use cs2hl_core::{analysis, demo_io, details, library::Index, library::MatchEntry, model};
use std::path::Path;

fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let lib = std::path::PathBuf::from(args.next().expect("library"));
    let me: u64 = args.next().expect("steamid").parse()?;
    let limit: usize = args.next().map(|s| s.parse()).transpose()?.unwrap_or(usize::MAX);
    let index: Index = serde_json::from_str(&std::fs::read_to_string(lib.join("index.json"))?)?;
    let mut ms: Vec<_> = index.matches.iter().filter(|m| details::stale(&lib, &m.id)).collect();
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
    }
    details::write_benchmarks(&lib, Some(me))?;
    println!("built {n} in {:.0}s", t.elapsed().as_secs_f64());
    Ok(())
}
