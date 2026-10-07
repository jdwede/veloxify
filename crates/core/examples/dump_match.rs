//! Prints what a demo yields for the match page: kill positions and callouts, grenades, bomb.
//!   cargo run --release -p cs2hl-core --example dump_match -- <demo>
use cs2hl_core::{demo_io, model};
use std::path::Path;

fn main() -> anyhow::Result<()> {
    let path = std::env::args().nth(1).expect("demo path");
    let t = std::time::Instant::now();
    let m = model::load_match(&demo_io::read_demo(Path::new(&path))?)?;
    println!("parsed in {:.1}s: {} rounds, {} kills, {} grenades, {} bomb events, {} explosions", t.elapsed().as_secs_f64(), m.rounds.len(), m.kills.len(), m.grenades.len(), m.bomb.len(), m.explosions.len());
    let with_xy = m.kills.iter().filter(|k| k.victim_xy.is_some()).count();
    let with_place = m.kills.iter().filter(|k| !k.victim_place.is_empty()).count();
    println!("kills with victim position: {with_xy}, with callout: {with_place}");
    for k in m.kills.iter().take(4) {
        println!("  r{} {} -> {} {:?}@{:?} / {:?}@{:?} {}", k.round + 1, k.attacker.unwrap_or(0) % 100000, k.victim % 100000, k.attacker_place, k.attacker_xy, k.victim_place, k.victim_xy, k.weapon);
    }
    for kind in [model::GrenadeKind::He, model::GrenadeKind::Flash, model::GrenadeKind::Smoke, model::GrenadeKind::Molotov] {
        println!("  {:?}: {}", kind, m.grenades.iter().filter(|g| g.kind == kind).count());
    }
    for b in m.bomb.iter().take(4) {
        println!("  bomb r{} {} at {:?}", b.round + 1, if b.defused { "defused" } else { "planted" }, b.place);
    }
    Ok(())
}
