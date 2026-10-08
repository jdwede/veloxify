//! Lists a demo's grenade throws and which look like set lineups.
//!   cargo run --release -p cs2hl-core --example dump_lineups -- <demo> <my steamid64>
use cs2hl_core::{analysis, demo_io, details, model};
use std::path::Path;

fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("demo");
    let me: u64 = args.next().expect("steamid").parse()?;
    let demo = demo_io::read_demo(Path::new(&path))?;
    let m = model::load_match(&demo)?;
    let a = analysis::analyze(&m);
    let d = details::build(&demo, &m, &a, me)?;
    let name = |s: &str| m.players.iter().find(|p| p.steamid.to_string() == s).map(|p| p.name.clone()).unwrap_or_default();
    let set: Vec<_> = d.throws.iter().filter(|t| t.set).collect();
    println!("{} throws, {} set lineups", d.throws.len(), set.len());
    for k in ["smoke", "molotov", "flash", "he"] {
        println!("  {k}: {} thrown, {} set", d.throws.iter().filter(|t| t.kind == k).count(), set.iter().filter(|t| t.kind == k).count());
    }
    for t in set.iter().filter(|t| t.kind == "smoke").take(8) {
        let dist = ((t.to[0] - t.from[0]).powi(2) + (t.to[1] - t.from[1]).powi(2)).sqrt();
        println!("  R{:>2} {:>5.1}s {:<14} {:<6} {:<6} still {:.2}s aim moved {:.1}° dist {:>5.0} score {:.2}  setpos {:.0} {:.0} {:.0};setang {:.2} {:.2} 0",
            t.round, t.t, name(&t.player).chars().take(14).collect::<String>(), t.technique, t.click, t.still_s, t.aim_moved_deg, dist, t.set_score, t.from[0], t.from[1], t.from[2], t.pitch, t.yaw);
    }
    Ok(())
}
