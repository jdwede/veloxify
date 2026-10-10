//! Rebuilds `lineups.json` and `lineups/<map>.json` for a library from its match details.
//!   cargo run --release -p cs2hl-core --example write_lineups -- <library>
fn main() -> anyhow::Result<()> {
    let lib = std::path::PathBuf::from(std::env::args().nth(1).expect("library"));
    let t = std::time::Instant::now();
    cs2hl_core::lineups::write(&lib)?;
    println!("lineups written in {:.1}s", t.elapsed().as_secs_f64());
    Ok(())
}
