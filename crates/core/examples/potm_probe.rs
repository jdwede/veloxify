//! Prints each recent match's play of the match and the runners-up with their montage scores,
//! for tuning `highlights::montage_score`. Reads only (nothing in the library changes).
//!   cargo run --release -p cs2hl-core --example potm_probe -- <library> [matches]
use cs2hl_core::{analysis, demo_io, highlights, library::Index, library::MatchEntry, model};
use std::collections::HashMap;
use std::path::Path;

fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let lib = std::path::PathBuf::from(args.next().expect("library"));
    let limit: usize = args.next().map(|s| s.parse()).transpose()?.unwrap_or(8);
    let index: Index = serde_json::from_str(&std::fs::read_to_string(lib.join("index.json"))?)?;
    let mut ms: Vec<_> = index.matches.iter().collect();
    ms.sort_by_key(|m| std::cmp::Reverse(m.played_ts));
    let mut n = 0;
    for m in ms {
        if n >= limit {
            break;
        }
        let Ok(entry) = std::fs::read_to_string(lib.join("matches").join(format!("{}.json", m.id))).map_err(anyhow::Error::from).and_then(|t| Ok(serde_json::from_str::<MatchEntry>(&t)?)) else {
            eprintln!("{}: no match file", m.id);
            continue;
        };
        // VELOXIFY_PATH_FROM / VELOXIFY_PATH_TO: read demos through another path (e.g. a UNC share).
        let mut path = entry.demo_path.clone();
        if let (Ok(from), Ok(to)) = (std::env::var("VELOXIFY_PATH_FROM"), std::env::var("VELOXIFY_PATH_TO")) {
            if path.to_lowercase().starts_with(&from.to_lowercase()) {
                path = format!("{to}{}", &path[from.len()..]);
            }
        }
        let p = Path::new(&path);
        if !p.exists() {
            continue;
        }
        n += 1;
        let demo = match demo_io::read_demo(p) {
            Ok(d) => d,
            Err(e) => {
                eprintln!("{path}: {e:#}");
                continue;
            }
        };
        let mm = model::load_match(&demo)?;
        let a = analysis::analyze(&mm);
        let names: HashMap<u64, String> = mm.players.iter().map(|p| (p.steamid, p.name.clone())).collect();
        let mut all: Vec<(f64, highlights::Highlight)> = mm
            .players
            .iter()
            .flat_map(|p| highlights::detect(&mm, &a, p.steamid, &HashMap::new()))
            .map(|h| (highlights::montage_score(&mm, &a, &h), h))
            .collect();
        all.sort_by(|x, y| y.0.partial_cmp(&x.0).unwrap());
        println!("\n{} {} {}-{}", entry.played_at, entry.map, entry.score_mine, entry.score_theirs);
        for (s, h) in all.iter().take(5) {
            let mark = if *s >= highlights::POTM_MIN && std::ptr::eq(h, &all[0].1) { "POTM" } else { "    " };
            println!("  {mark} {s:6.1}  {:<18} R{:<2} {}  [{}]", names.get(&h.player).cloned().unwrap_or_default(), h.round_number, h.title, h.tags.join(", "));
        }
    }
    Ok(())
}
