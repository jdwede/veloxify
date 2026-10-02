use anyhow::{bail, Context, Result};
use cs2hl_core::{analysis, demo_io, highlights, model, stats};
use std::path::PathBuf;
use std::time::Instant;

const USAGE: &str = "usage:
  cs2hl analyze <demo> [--player <steamid64>] [--json]
  cs2hl events <demo> [event names...]
  cs2hl validate <demo>...   (compare computed stats with CS2's in-demo scoreboard)";

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("analyze") => analyze(&args[1..]),
        Some("events") => events(&args[1..]),
        Some("validate") => validate(&args[1..]),
        _ => bail!("{USAGE}"),
    }
}

fn analyze(args: &[String]) -> Result<()> {
    let path = PathBuf::from(args.first().context(USAGE)?);
    let json = args.iter().any(|a| a == "--json");
    let focus: Option<u64> = args
        .iter()
        .position(|a| a == "--player")
        .and_then(|i| args.get(i + 1))
        .map(|s| s.parse())
        .transpose()?;

    let t = Instant::now();
    let demo = demo_io::read_demo(&path)?;
    let t_load = t.elapsed().as_secs_f64();
    let t = Instant::now();
    let m = model::load_match(&demo)?;
    let a = analysis::analyze(&m);
    let st = stats::player_stats(&m, &a, true);
    let t_parse = t.elapsed().as_secs_f64();
    let players: Vec<u64> = match focus {
        Some(p) => vec![p],
        None => m.players.iter().map(|p| p.steamid).collect(),
    };
    let hl: Vec<highlights::Highlight> = players
        .iter()
        .flat_map(|&p| highlights::detect(&m, &a, p))
        .filter(|h| h.score >= highlights::AUTO_THRESHOLD)
        .collect();

    if json {
        let out = serde_json::json!({
            "map": m.map, "source": m.source, "score": [m.score_a, m.score_b],
            "rounds": m.rounds, "players": m.players, "kills": m.kills, "stats": st, "highlights": hl,
            "clutches": a.clutches().collect::<Vec<_>>(),
        });
        println!("{}", serde_json::to_string_pretty(&out)?);
        return Ok(());
    }

    println!("{} | {:?} | {} - {} | {} rounds | load {:.2}s, analyze {:.2}s",
        m.map, m.source, m.score_a, m.score_b, m.rounds.len(), t_load, t_parse);
    println!("\n{:<18} {:>4} {:>3} {:>3} {:>3} {:>6} {:>6} {:>5} {:>5} {:>5} {:>5} {:>3} {:>5}",
        "player", "team", "K", "A", "D", "ADR", "KAST", "HS%", "R1.0", "R2.0", "FK-FD", "MK", "1vX");
    for s in &st {
        let c = &s.counts;
        let d = &s.derived;
        let mk: u32 = c.multikill_rounds[2..].iter().sum();
        let cw: u32 = c.clutches_won.iter().sum();
        let ca: u32 = c.clutches_attempted.iter().sum();
        let mark = if Some(s.steamid) == focus { "*" } else { "" };
        println!("{:<18} {:>4} {:>3} {:>3} {:>3} {:>6.1} {:>5.1}% {:>4.0}% {:>5.2} {:>5.2} {:>2}-{:<2} {:>3} {:>2}/{}",
            format!("{mark}{}", truncate(&s.name, 17)), format!("{:?}", s.team), c.kills, c.assists, c.deaths,
            d.adr, d.kast, d.hs_pct, d.rating1, d.rating2, c.opening_kills, c.opening_deaths, mk, cw, ca);
    }
    println!("\nhighlights (score >= {}):", highlights::AUTO_THRESHOLD);
    for h in &hl {
        let name = m.player(h.player).map(|p| p.name.as_str()).unwrap_or("?");
        let segs: Vec<String> = h.segments.iter()
            .map(|s| format!("{}-{}", s.start_tick, s.end_tick)).collect();
        println!("  {:>5.1}  {:<16} {:<36} {:>5.1}s  [{}]  {}",
            h.score, truncate(name, 16), h.title, h.duration_s, h.tags.join(", "), segs.join(" "));
    }
    Ok(())
}

fn validate(paths: &[String]) -> Result<()> {
    let mut total_mismatch = 0;
    for path in paths {
        let demo = demo_io::read_demo(&PathBuf::from(path))?;
        let m = model::load_match(&demo)?;
        let a = analysis::analyze(&m);
        let st = stats::player_stats(&m, &a, false);
        let end = m.rounds.last().unwrap().end_tick;
        let sb = cs2hl_core::raw::player_props_at(&demo, cs2hl_core::raw::SCOREBOARD_PROPS, &[end, end + 32, end + 64, end + 128])?;
        println!("{} {} {}-{} ({} rounds)", file_name(path), m.map, m.score_a, m.score_b, m.rounds.len());
        for s in &st {
            let Some(v) = sb.get(&s.steamid) else { println!("  {:<16} missing from scoreboard", s.name); continue };
            let c = &s.counts;
            let checks = [
                ("K", c.kills as i64, v.get("kills_total")),
                ("D", c.deaths as i64, v.get("deaths_total")),
                ("A", c.assists as i64, v.get("assists_total")),
                ("HS", c.headshot_kills as i64, v.get("headshot_kills_total")),
                ("DMG", c.damage, v.get("damage_total")),
                ("3K", c.multikill_rounds[3] as i64, v.get("3k_rounds_total")),
                ("4K", c.multikill_rounds[4] as i64, v.get("4k_rounds_total")),
                ("5K", c.multikill_rounds[5] as i64, v.get("ace_rounds_total")),
            ];
            let diffs: Vec<String> = checks.iter()
                .filter_map(|(n, ours, theirs)| match theirs {
                    Some(t) if **t != *ours => Some(format!("{n} ours={ours} cs2={t}")),
                    None => Some(format!("{n} cs2=?")),
                    _ => None,
                })
                .collect();
            total_mismatch += diffs.len();
            println!("  {:<16} {}", truncate(&s.name, 16), if diffs.is_empty() { "ok".to_string() } else { diffs.join(", ") });
        }
    }
    println!("mismatched fields: {total_mismatch}");
    Ok(())
}

fn events(args: &[String]) -> Result<()> {
    let path = PathBuf::from(args.first().context(USAGE)?);
    let filter: Vec<&str> = args[1..].iter().map(String::as_str).collect();
    let demo = demo_io::read_demo(&path)?;
    let out = cs2hl_core::raw::parse_events(&demo, &["all"])?;
    let mut counts: std::collections::BTreeMap<&str, usize> = Default::default();
    let mut first: std::collections::BTreeMap<&str, &parser::second_pass::game_events::GameEvent> = Default::default();
    for e in &out.game_events {
        *counts.entry(&e.name).or_default() += 1;
        first.entry(&e.name).or_insert(e);
    }
    for (name, n) in counts.iter().filter(|(n, _)| filter.is_empty() || filter.contains(n)) {
        let fields: Vec<String> = first[name].fields.iter().map(|f| format!("{}={:?}", f.name, f.data)).collect();
        println!("{name} x{n}\n    {}", fields.join(", "));
    }
    Ok(())
}

fn file_name(path: &str) -> String {
    PathBuf::from(path).file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default()
}

fn truncate(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}
