//! Can CS2 throw a lineup again on an offline practice server and record it as a fresh demo (one
//! today's CS2 can play)? Throws it, records `vx_probe.dem`, then prints where the grenade went.
//!   cargo run --release -p cs2hl-render --example practice_probe -- <steamid64> <profile.json> <map> <x> <y> <z> <pitch> <yaw> <kind> <stand|jump>
//!   cargo run --release -p cs2hl-render --example practice_probe -- parse     (just report on the last vx_probe.dem)
//!
//! Found (October 2026): the offline map, `setpos`/`setang`, `give`, `slot4` and GOTV recording
//! (`tv_enable 1` before `map`, then `tv_record`) all work in the hidden CS2, but `+attack` sent
//! over the console does nothing, so the grenade is never thrown.

use anyhow::Result;
use cs2hl_core::raw;
use cs2hl_render::profile::Profile;
use cs2hl_render::session::Renderer;
use cs2hl_render::steam;
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::thread::sleep;
use std::time::Duration;

fn main() -> Result<()> {
    let a: Vec<String> = std::env::args().skip(1).collect();
    if a[0] == "parse" {
        return report();
    }
    let me: u64 = a[0].parse()?;
    let profile = Profile::load(Path::new(&a[1]))?;
    let map = &a[2];
    let (x, y, z, pitch, yaw) = (&a[3], &a[4], &a[5], &a[6], &a[7]);
    let kind = &a[8];
    let technique = a.get(9).map(String::as_str).unwrap_or("stand");
    let work = std::env::temp_dir().join("veloxify-practice-probe");
    std::fs::create_dir_all(&work)?;
    let r = Renderer::start(me, profile, &work, Arc::new(AtomicBool::new(false)), Box::new(|s| eprintln!("  [cs2] {s}")))?;
    let ms = |n: u64| sleep(Duration::from_millis(n));
    let result = (|| -> Result<()> {
        let vc = r.console();
        let since = vc.mark();
        // GOTV records the demo, like a real match server.
        vc.send("tv_enable 1");
        vc.send("tv_delay 0");
        ms(300);
        vc.send(&format!("map {map}"));
        let l = vc.wait_for_any(&["Signon traffic"], Duration::from_secs(180), since);
        println!("map loaded: {l:?}");
        ms(3000);
        for c in [
            "sv_cheats 1",
            "mp_backup_round_auto 0",
            "bot_quota 0",
            "bot_kick",
            "mp_autoteambalance 0",
            "mp_limitteams 0",
            "mp_freezetime 0",
            "mp_roundtime 60",
            "mp_roundtime_defuse 60",
            "mp_ignore_round_win_conditions 1",
            "mp_buy_anywhere 1",
            "mp_buytime 99999",
            "ammo_grenade_limit_total 5",
            "sv_infinite_ammo 1",
            "mp_warmup_end",
        ] {
            vc.send(c);
            ms(150);
        }
        vc.send("jointeam 3 1");
        ms(2000);
        vc.send("mp_restartgame 1");
        ms(3500);
        vc.send("tv_record vx_probe");
        ms(1000);
        let place = format!("setpos {x} {y} {z};setang {pitch} {yaw} 0");
        vc.send(&place);
        let weapon = match kind.as_str() {
            "smoke" => "weapon_smokegrenade",
            "molotov" => "weapon_molotov",
            "flash" => "weapon_flashbang",
            _ => "weapon_hegrenade",
        };
        vc.send(&format!("give {weapon}"));
        ms(400);
        vc.send("slot4");
        ms(1500);
        vc.send(&place);
        ms(800);
        let mark = vc.mark();
        vc.send("getpos");
        println!("before the throw: {:?}", vc.wait_for("setpos", Duration::from_secs(2), mark));
        vc.send("+attack");
        ms(800);
        match technique {
            "jump" => {
                vc.send("+jump;-attack");
                ms(100);
                vc.send("-jump");
            }
            _ => vc.send("-attack"),
        }
        ms(12000);
        vc.send("tv_stoprecord");
        ms(1500);
        vc.send("disconnect");
        ms(2000);
        vc.send("tv_enable 0");
        for l in vc.lines_since(since) {
            let low = l.to_lowercase();
            if ["record", "demo", "signon", "stop", "jointeam", "unknown", "give", "gotv", "tv_", "slot", "keybinding"].iter().any(|w| low.contains(w)) {
                println!("  | {l}");
            }
        }
        Ok(())
    })();
    r.close();
    result?;
    report()
}

/// Where the grenade went in the recorded demo.
fn report() -> Result<()> {
    let dem = steam::cs2_csgo_dir()?.join("vx_probe.dem");
    let bytes = std::fs::read(&dem)?;
    println!("demo: {} ({} KB)", dem.display(), bytes.len() / 1024);
    let ev = raw::parse_events(&bytes, &["all"])?;
    let mut names: BTreeMap<String, usize> = BTreeMap::new();
    for e in &ev.game_events {
        *names.entry(e.name.clone()).or_default() += 1;
    }
    println!("events: {names:?}");
    for e in ev.game_events.iter().filter(|e| e.name.contains("grenade") || e.name.contains("weapon_fire") || e.name.contains("detonate") || e.name.starts_with("item_") || e.name == "player_spawn" || e.name == "player_team") {
        println!("  {} tick {} {:?}", e.name, e.tick, e.fields.iter().filter(|f| ["item", "weapon", "team", "user_name", "defindex"].iter().any(|k| f.name.contains(k))).map(|f| format!("{}={:?}", f.name, f.data)).collect::<Vec<_>>());
    }
    let ticks: Vec<i32> = (0..40000).collect();
    let pts = raw::projectiles(&bytes, &ticks)?;
    let mut by: BTreeMap<i32, Vec<&raw::ProjectilePoint>> = BTreeMap::new();
    for p in &pts {
        by.entry(p.entity).or_default().push(p);
    }
    for (e, mut v) in by {
        v.sort_by_key(|p| p.tick);
        let (f, l) = (v[0], v[v.len() - 1]);
        println!("{e} {}: tick {} {:?} -> tick {} {:?}", f.class, f.tick, f.xyz, l.tick, l.xyz);
    }
    Ok(())
}
