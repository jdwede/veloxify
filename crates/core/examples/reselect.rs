//! Sorts every match's moments again with a quick pick's highlight rules, as the app does when the
//! Settings change, and prints how many highlights there are before and after.
//!   cargo run --release -p cs2hl-core --example reselect -- <library> everything|solid-plays|highlights-only
use cs2hl_core::highlights::{preset_kinds, Selectivity};
use cs2hl_core::library::{is_entry_file, reselect, ClipPolicy, MatchEntry};

fn count(lib: &std::path::Path) -> (usize, usize, usize) {
    let (mut h, mut c, mut filmed) = (0, 0, 0);
    for f in std::fs::read_dir(lib.join("matches")).unwrap().flatten() {
        if !is_entry_file(&f.path()) {
            continue;
        }
        if let Ok(e) = serde_json::from_str::<MatchEntry>(&std::fs::read_to_string(f.path()).unwrap()) {
            h += e.highlights.len();
            c += e.candidates.len();
            filmed += e.highlights.iter().filter(|x| x.clip.is_some()).count();
        }
    }
    (h, c, filmed)
}

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let lib = std::path::PathBuf::from(&args[0]);
    let mut policy = ClipPolicy::default();
    policy.rules.kinds = preset_kinds(Selectivity::parse(&args[1]).expect("level"));
    println!("before: (highlights, others, filmed) = {:?}", count(&lib));
    let n = reselect(&lib, &policy)?;
    println!("{n} matches changed; after: {:?}", count(&lib));
    Ok(())
}
