use anyhow::{bail, Context, Result};
use cs2hl_core::{analysis, demo_io, highlights, model, stats};
use std::path::PathBuf;
use std::time::Instant;

const USAGE: &str = "usage:
  cs2hl analyze <demo> [--player <steamid64>] [--selectivity everything|solid-plays|highlights-only] [--json]
  cs2hl events <demo> [event names...]
  cs2hl extract <demo> <out.dem>   (decompress to a playable .dem)
  cs2hl library <library dir> --player <steamid64> [--also <steamid64>]... [--refresh]
        [--selectivity everything|solid-plays|highlights-only] [--max-per-match N] <demo>...
      (add demos and rebuild index.json; highlights only for --player and any --also players)
  cs2hl render <library dir> [--all | --match <id>]... [--limit N] [--profile p.json]
      (render pending highlights in the background, best first; default: latest session)
  cs2hl validate <demo>...   (compare computed stats with CS2's in-demo scoreboard)";

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("analyze") => analyze(&args[1..]),
        Some("events") => events(&args[1..]),
        Some("validate") => validate(&args[1..]),
        Some("library") => library(&args[1..]),
        Some("render") => render(&args[1..]),
        Some("extract") => {
            let (src, dst) = (args.get(1).context(USAGE)?, args.get(2).context(USAGE)?);
            std::fs::write(dst, demo_io::read_demo(&PathBuf::from(src))?)?;
            Ok(())
        }
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
    let sel = args
        .iter()
        .position(|a| a == "--selectivity")
        .and_then(|i| args.get(i + 1))
        .and_then(|s| highlights::Selectivity::parse(s))
        .unwrap_or(highlights::Selectivity::SolidPlays);
    let hl: Vec<highlights::Highlight> = players
        .iter()
        .flat_map(|&p| {
            let flicks = highlights::reaction_flicks(&demo, &m, p).unwrap_or_default();
            if std::env::var("CS2HL_DEBUG_FLICKS").is_ok() {
                let mut f: Vec<_> = flicks.iter().map(|(k, v)| (m.rounds[m.kills[*k].round].number, m.kills[*k].tick, *v as i32)).collect();
                f.sort();
                eprintln!("flick candidates (round, tick, swing deg): {f:?}");
            }
            highlights::select(highlights::detect(&m, &a, p, &flicks), sel, highlights::MAX_PER_PLAYER)
        })
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
    println!("\nhighlights ({sel:?}):");
    for h in &hl {
        let name = m.player(h.player).map(|p| p.name.as_str()).unwrap_or("?");
        let segs: Vec<String> = h.segments.iter()
            .map(|s| format!("{}-{}", s.start_tick, s.end_tick)).collect();
        println!("  T{} {:>5.1}  {:<16} {:<40} {:>5.1}s  [{}]  {}",
            h.tier, h.score, truncate(name, 16), h.title, h.duration_s, h.tags.join(", "), segs.join(" "));
    }
    Ok(())
}

fn library(args: &[String]) -> Result<()> {
    use cs2hl_core::library;
    use std::path::Path;
    let root = PathBuf::from(args.first().context(USAGE)?);
    let pi = args.iter().position(|a| a == "--player").context("--player <steamid64> is required")?;
    let me: u64 = args.get(pi + 1).context("--player <steamid64>")?.parse()?;
    let mut policy = library::ClipPolicy::default();
    let mut refresh = false;
    let mut skip: Vec<usize> = vec![pi, pi + 1];
    for (i, a) in args.iter().enumerate() {
        let val = || args.get(i + 1).with_context(|| format!("{a} needs a value"));
        match a.as_str() {
            // Also detect highlights for this player (opt-in, repeatable).
            "--also" => policy.also_clip.push(val()?.parse()?),
            "--selectivity" => {
                policy.selectivity = cs2hl_core::highlights::Selectivity::parse(val()?)
                    .context("--selectivity everything|solid-plays|highlights-only")?
            }
            "--max-per-match" => policy.max_per_player = val()?.parse()?,
            "--refresh" => {
                refresh = true;
                skip.push(i);
                continue;
            }
            _ => continue,
        }
        skip.extend([i, i + 1]);
    }
    let demos: Vec<&String> = args.iter().enumerate().skip(1).filter(|(i, _)| !skip.contains(i)).map(|(_, a)| a).collect();
    use cs2hl_core::ingest::{self, Added};
    for path in demos {
        match ingest::add_demo(&root, Path::new(path), me, &policy, refresh)? {
            Added::Added { id, map, score, result, seconds } => {
                println!("added   {id}  {map} {}-{} {result}  ({seconds:.1}s)", score.0, score.1)
            }
            Added::Cached { id } => println!("cached  {id}"),
            Added::Skipped { id, reason } => println!("skip    {id}: {reason}"),
        }
    }
    let index = ingest::rebuild_index(&root, me)?;
    println!("index: {} matches over {} days", index.matches.len(), index.days.len());
    Ok(())
}

fn render(args: &[String]) -> Result<()> {
    use cs2hl_render::batch::{self, Event, Scope};
    let lib = PathBuf::from(args.first().context(USAGE)?);
    let opt = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
    let matches: Vec<String> = args.iter().enumerate().filter(|(_, a)| *a == "--match").filter_map(|(i, _)| args.get(i + 1).cloned()).collect();
    let scope = if !matches.is_empty() {
        Scope::Matches(matches)
    } else if args.iter().any(|a| a == "--all") {
        Scope::All
    } else {
        Scope::LatestSession
    };
    let limit = opt("--limit").map(|s| s.parse()).transpose()?;
    let profile_path = opt("--profile").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("profiles/default.json"));
    let profile = cs2hl_render::profile::Profile::load(&profile_path)?;
    let index: cs2hl_core::library::Index = serde_json::from_str(&std::fs::read_to_string(lib.join("index.json"))?)?;
    let work = lib.join(".work");
    let t = |s: &str| println!("{} {s}", chrono::Local::now().format("%H:%M:%S"));
    batch::render(&lib, index.me.parse()?, profile, &work, scope, limit, &mut |e| match e {
        Event::Plan { total } => t(&format!("{total} highlights to render")),
        Event::Rendered { title, clip_s, took_s, .. } => t(&format!("rendered {title} ({clip_s:.0}s clip in {took_s:.0}s)")),
        Event::Failed { title, error, .. } => t(&format!("failed {title}: {error}")),
        Event::Done { rendered, minutes } => t(&format!("rendered {rendered} highlights in {minutes:.1} min")),
        Event::Log(s) => t(&s),
    })?;
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
