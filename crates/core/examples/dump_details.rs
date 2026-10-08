//! Builds a match's details (aim, utility, activity, ...) and prints a summary per player.
//!   cargo run --release -p cs2hl-core --example dump_details -- <demo> <my steamid64>
use cs2hl_core::{analysis, demo_io, details, model};
use std::path::Path;

fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("demo path");
    let me: u64 = args.next().expect("steamid").parse()?;
    let demo = demo_io::read_demo(Path::new(&path))?;
    let t = std::time::Instant::now();
    let m = model::load_match(&demo)?;
    let a = analysis::analyze(&m);
    let t_parse = t.elapsed().as_secs_f64();
    let t = std::time::Instant::now();
    let d = details::build(&demo, &m, &a, me)?;
    println!("parse {:.1}s, details {:.1}s, json {} KB", t_parse, t.elapsed().as_secs_f64(), serde_json::to_string(&d)?.len() / 1024);
    let pct = |a: u32, b: u32| if b > 0 { format!("{:>3.0}%", a as f64 * 100.0 / b as f64) } else { "  n/a".into() };
    println!("{:<16} spot  TTD   TTK   xhair head HS%  first spray strafe all  | fl sm he mo  eFl/f fFl/f blind HEdmg unused$ | dmg  shots wasted surv", "player");
    for p in &d.players {
        let name = m.players.iter().find(|x| x.steamid.to_string() == p.steamid).map(|x| x.name.clone()).unwrap_or_default();
        let (a, u, ac) = (&p.aim, &p.utility, &p.activity);
        let f = |v: Option<f64>| v.map(|x| format!("{x:>5.0}")).unwrap_or("  n/a".into());
        println!(
            "{:<16} {} {} {} {:>5.1} {} {} {} {} {} {} | {:>2} {:>2} {:>2} {:>2}  {:>4.2} {:>4.2}  {:>4.1}s {:>5.1} {:>6} | {:>4} {:>5} {} {:>2}",
            name.chars().take(16).collect::<String>(), pct(a.spotted_hits, a.spotted_shots), f(a.ttd_ms), f(a.ttk_ms), a.crosshair_deg.unwrap_or(f64::NAN),
            pct(a.head_hits, a.body_hits), pct(a.hs_kills, a.kills), pct(a.first_hits, a.first_shots), pct(a.spray_hits, a.spray_shots), pct(a.strafe_good, a.strafe_shots), pct(a.hits, a.shots),
            u.flashes, u.smokes, u.hes, u.molotovs,
            if u.flashes > 0 { u.enemies_flashed as f64 / u.flashes as f64 } else { 0.0 }, if u.flashes > 0 { u.friends_flashed as f64 / u.flashes as f64 } else { 0.0 },
            if u.enemies_flashed > 0 { u.enemy_blind_time / u.enemies_flashed as f64 } else { 0.0 }, if u.hes > 0 { u.he_damage as f64 / u.hes as f64 } else { 0.0 },
            if u.deaths > 0 { u.unused_value / u.deaths } else { 0 },
            ac.damage, ac.shots, pct(ac.wasted_bullets, ac.magazine_bullets), ac.rounds_survived
        );
    }
    println!("clutches: {:?}", d.clutches.iter().map(|c| format!("r{} 1v{} {} k{}", c.round, c.vs, c.result, c.kills)).collect::<Vec<_>>());
    println!("openings: {}", d.kills.iter().filter(|k| k.opening).count());
    for p in &d.players {
        let t = &p.trades;
        let name = m.players.iter().find(|x| x.steamid.to_string() == p.steamid).map(|x| x.name.clone()).unwrap_or_default();
        println!("trades {:<16} kill {}/{}/{}  death {}/{}/{}", name, t.kill_opps, t.kill_attempts, t.kill_success, t.death_opps, t.death_attempts, t.death_success);
    }
    for (w, row) in &d.recoil {
        let pts: Vec<String> = row.iter().take(12).filter(|b| b[2] > 0.0).map(|b| format!("{:.2},{:.2}", b[0] / b[2], b[1] / b[2])).collect();
        println!("recoil {w} (n0={}): {}", row[0][2], pts.join(" "));
    }
    Ok(())
}
