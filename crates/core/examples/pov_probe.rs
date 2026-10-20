//! Everyone's position and view at some ticks: where the camera stands in a clip's frame, for
//! comparing a viewer's render against CS2's own picture.
//!   cargo run --release -p cs2hl-core --example pov_probe -- <demo> <tick> [<tick> ...]
use std::path::Path;

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let demo = cs2hl_core::demo_io::read_demo(Path::new(&args[0]))?;
    let ticks: Vec<i32> = args[1..].iter().map(|t| t.parse()).collect::<Result<_, _>>()?;
    let m = cs2hl_core::model::load_match(&demo)?;
    let sids: Vec<u64> = m.players.iter().map(|p| p.steamid).collect();
    let props = ["X", "Y", "Z", "yaw", "pitch", "duck_amount", "health"];
    let table = cs2hl_core::raw::players_table(&demo, &sids, &props, &ticks)?;
    println!("map {}", m.map);
    for &t in &ticks {
        for p in &m.players {
            if let Some((_, v)) = table.get(&p.steamid).and_then(|rows| rows.iter().find(|(tt, _)| *tt == t)) {
                println!("{t} {} {:?} {:?} x {:.1} y {:.1} z {:.1} yaw {:.2} pitch {:.2} duck {:.2} hp {}", p.steamid, p.team, p.name, v[0], v[1], v[2], v[3], v[4], v[5], v[6]);
            }
        }
    }
    Ok(())
}
