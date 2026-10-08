//! Imports one demo into a library (as the app does), then refreshes the index and benchmarks.
//!   cargo run --release -p cs2hl-core --example import_demo -- <library> <my steamid64> <demo>
use cs2hl_core::{details, highlights::Selectivity, ingest, library::ClipPolicy};
use std::path::Path;

fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let lib = std::path::PathBuf::from(args.next().expect("library"));
    let me: u64 = args.next().expect("steamid").parse()?;
    let demo = args.next().expect("demo");
    let policy = ClipPolicy { also_clip: vec![], selectivity: Selectivity::SolidPlays, max_per_player: 10 };
    match ingest::add_demo(&lib, Path::new(&demo), me, &policy, true)? {
        ingest::Added::Added { id, map, score, result, .. } => println!("added {id}: {map} {}-{} {result}", score.0, score.1),
        ingest::Added::Cached { id } => println!("already there: {id}"),
        ingest::Added::Skipped { id, reason } => println!("skipped {id}: {reason}"),
    }
    ingest::rebuild_index(&lib, me)?;
    details::write_benchmarks(&lib, Some(me))?;
    Ok(())
}
