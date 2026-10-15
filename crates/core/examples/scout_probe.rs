//! A team's rounds from one demo (CT setups, T sites), as the ESEA scout reads them.
//!   cargo run --release -p cs2hl-core --example scout_probe -- <demo> <steamid64 of one of the team's players>
use std::path::Path;

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let demo = cs2hl_core::demo_io::read_demo(Path::new(&args[0]))?;
    let me: u64 = args[1].parse()?;
    let m = cs2hl_core::model::load_match(&demo)?;
    let team = m.team_of(me).expect("player in the demo");
    let sids: Vec<u64> = m.players.iter().filter(|p| p.team == team).map(|p| p.steamid).collect();
    let v = cs2hl_core::scouting::team_rounds(&demo, &sids)?;
    println!("map {} score {} sites {}", v["map"], v["score"], v["sites"]);
    for r in v["rounds"].as_array().unwrap() {
        let s = &r["setup"];
        println!("R{:>2} {} {:<6} won {:<5} setup A{} Mid{} B{} pushed {} plant {} fast {}", r["number"], r["side"], r["buy"].as_str().unwrap_or(""), r["won"], s["A"], s["Mid"], s["B"], r["pushed"], r["plant"], r["fast"]);
        println!("      {}", r["spots"].as_array().unwrap().iter().map(|p| format!("{}:{}", p["zone"].as_str().unwrap_or(""), p["place"].as_str().unwrap_or(""))).collect::<Vec<_>>().join(" "));
    }
    Ok(())
}
