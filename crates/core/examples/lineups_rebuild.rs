//! Rebuilds a library's grenade lineups (`lineups.json`, `lineups/<map>.json`) from its match
//! details, as the app does after an update changes the lineup rules.
//!   cargo run --release -p cs2hl-core --example lineups_rebuild -- <library>
fn main() -> anyhow::Result<()> {
    let lib = std::path::PathBuf::from(std::env::args().nth(1).expect("library"));
    let t = std::time::Instant::now();
    cs2hl_core::lineups::write(&lib)?;
    println!("lineups rebuilt in {:.1}s", t.elapsed().as_secs_f64());
    Ok(())
}
