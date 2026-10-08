//! Prints a player's view and recoil props over a tick range (checking what a demo networks).
//!   cargo run --release -p cs2hl-core --example punch_probe -- <demo> <steamid64> <from tick> <to tick> [step]
use cs2hl_core::{demo_io, raw};

fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let demo = demo_io::read_demo(std::path::Path::new(&args.next().expect("demo")))?;
    let me: u64 = args.next().expect("steamid").parse()?;
    let from: i32 = args.next().expect("from").parse()?;
    let to: i32 = args.next().expect("to").parse()?;
    let step: usize = args.next().map(|s| s.parse()).transpose()?.unwrap_or(4);
    let ticks: Vec<i32> = (from..=to).step_by(step).collect();
    let props = ["pitch", "yaw", "aim_punch_angle", "aim_punch_angle_vel", "shots_fired"];
    let data = raw::players_series(&demo, &[me], &props, &ticks)?;
    for t in &ticks {
        let mut v: Vec<_> = data.get(&(me, *t)).map(|m| m.iter().map(|(k, v)| format!("{k}={v:.2}")).collect()).unwrap_or_default();
        v.sort();
        println!("{t}: {}", v.join(" "));
    }
    Ok(())
}
