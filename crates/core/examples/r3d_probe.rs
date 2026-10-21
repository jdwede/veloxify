//! Builds a match's 3D replay into a folder and prints how long it took and how big it is.
//!   cargo run --release -p cs2hl-core --example r3d_probe -- <demo> <out folder> <id>
use std::path::Path;

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let t0 = std::time::Instant::now();
    let demo = cs2hl_core::demo_io::read_demo(Path::new(&args[0]))?;
    let m = cs2hl_core::model::load_match(&demo)?;
    let t1 = t0.elapsed();
    let root = Path::new(&args[1]);
    std::fs::create_dir_all(root.join("matches"))?;
    cs2hl_core::replay3d::write(root, &args[2], &demo, &m)?;
    let size = std::fs::metadata(cs2hl_core::replay3d::path(root, &args[2]))?.len();
    println!("map {} rounds {} players {} | demo read {:.1}s, 3D replay {:.1}s, {:.1} MB, current {}", m.map, m.rounds.len(), m.players.len(), t1.as_secs_f64(), (t0.elapsed() - t1).as_secs_f64(), size as f64 / 1e6, cs2hl_core::replay3d::current(root, &args[2]));
    Ok(())
}
