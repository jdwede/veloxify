//! Re-analyzes every match in a library from its demo (after highlight-rule changes), keeping
//! rendered clips, deletions and folders.
//!   cargo run --release -p cs2hl-core --example reanalyze -- <library> <my steamid64> [max per match]
use cs2hl_core::{details, highlights::Selectivity, ingest, library::ClipPolicy, library::Index, library::MatchEntry};
use std::path::Path;

fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let lib = std::path::PathBuf::from(args.next().expect("library"));
    let me: u64 = args.next().expect("steamid").parse()?;
    let cap: usize = args.next().map(|s| s.parse()).transpose()?.unwrap_or(10);
    let policy = ClipPolicy { also_clip: vec![], selectivity: Selectivity::SolidPlays, max_per_player: cap };
    let index: Index = serde_json::from_str(&std::fs::read_to_string(lib.join("index.json"))?)?;
    let before: usize = index.highlights.len();
    let t = std::time::Instant::now();
    let (mut done, mut missing) = (0, 0);
    for m in &index.matches {
        let entry: MatchEntry = serde_json::from_str(&std::fs::read_to_string(lib.join("matches").join(format!("{}.json", m.id)))?)?;
        let p = Path::new(&entry.demo_path);
        if !p.exists() {
            missing += 1;
            continue;
        }
        match ingest::add_demo(&lib, p, me, &policy, true) {
            Ok(_) => done += 1,
            Err(e) => println!("{}: {e:#}", m.id),
        }
    }
    let index = ingest::rebuild_index(&lib, me)?;
    details::write_benchmarks(&lib, Some(me))?;
    println!("re-analyzed {done} ({missing} without a demo) in {:.0}s; highlights {before} -> {}", t.elapsed().as_secs_f64(), index.highlights.len());
    Ok(())
}
