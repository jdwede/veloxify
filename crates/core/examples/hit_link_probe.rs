//! How far apart (in ticks) a gun's damage event and the shooter's nearest shot of that gun are,
//! for tuning how hits are matched to shots in `details`.
//!   cargo run --release -p cs2hl-core --example hit_link_probe -- <demo>
use cs2hl_core::{demo_io, model};
use std::collections::BTreeMap;
use std::path::Path;

fn main() -> anyhow::Result<()> {
    let path = std::env::args().nth(1).expect("demo path");
    let demo = demo_io::read_demo(Path::new(&path))?;
    let m = model::load_match(&demo)?;
    let mut hist: BTreeMap<i32, u32> = BTreeMap::new();
    let mut none = 0;
    for d in &m.damages {
        let Some(att) = d.attacker else { continue };
        let w = d.weapon.trim_start_matches("weapon_");
        if w.is_empty() || ["hegrenade", "inferno", "molotov", "incgrenade", "knife", "world", "flashbang", "smokegrenade", "planted_c4"].iter().any(|x| w.starts_with(x)) {
            continue;
        }
        let nearest = m.shots.iter().filter(|s| s.player == att && cs2hl_core::details::base_weapon(s.weapon.trim_start_matches("weapon_")) == w && (s.tick - d.tick).abs() <= 16).min_by_key(|s| (s.tick - d.tick).abs());
        match nearest {
            Some(s) => *hist.entry(s.tick - d.tick).or_default() += 1,
            None => none += 1,
        }
    }
    println!("shot tick - damage tick: count");
    for (k, v) in &hist {
        println!("{k:>4}: {v}");
    }
    println!("no shot of that gun within 16 ticks: {none}");
    // Damage weapons with no shot at all, by name (naming mismatches show up here).
    let mut names: BTreeMap<String, u32> = BTreeMap::new();
    for d in &m.damages {
        names.entry(d.weapon.clone()).and_modify(|n| *n += 1).or_insert(1);
    }
    let shot_names: std::collections::BTreeSet<String> = m.shots.iter().map(|s| s.weapon.trim_start_matches("weapon_").to_string()).collect();
    println!("damage weapons: {:?}", names);
    println!("shot weapons: {:?}", shot_names);
    Ok(())
}
