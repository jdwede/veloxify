//! Practice: one click to start CS2 on a practice map, a local server with practice settings, a
//! bot deathmatch, or a community server.
//!
//! It's the same as a desktop shortcut with launch options: Steam starts CS2 normally (no
//! `-insecure`, so VAC-secured community servers still work) with commands to load the map. The
//! practice settings go in their own `cfg/veloxify_practice.cfg`; your own configs aren't touched.

use serde::Deserialize;

/// What to launch, from the Practice tab.
#[derive(Debug, Deserialize)]
pub struct Launch {
    /// "workshop" (Workshop file id), "map" (e.g. de_mirage), or "server" (address:port).
    pub kind: String,
    pub target: String,
    /// "practice" (no bots, infinite ammo, grenade trajectories, ...), "deathmatch" (bots), or
    /// "none" (load it as it is).
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub headshot_only: bool,
    /// Your own console commands, one per line.
    #[serde(default)]
    pub commands: String,
}

fn practice_lines(l: &Launch) -> Vec<String> {
    let mut out: Vec<&str> = vec![];
    match l.mode.as_str() {
        "practice" => out.extend([
            "sv_cheats 1",
            "mp_limitteams 0",
            "mp_autoteambalance 0",
            "mp_freezetime 0",
            "mp_roundtime 60",
            "mp_roundtime_defuse 60",
            "mp_buy_anywhere 1",
            "mp_buytime 9999",
            "mp_maxmoney 60000",
            "mp_startmoney 60000",
            "mp_respawn_on_death_ct 1",
            "mp_respawn_on_death_t 1",
            "sv_infinite_ammo 1",
            "ammo_grenade_limit_total 5",
            "sv_grenade_trajectory_prac_pipreview 1",
            "sv_showimpacts 1",
            "bot_kick",
            "mp_warmup_end",
            "mp_restartgame 1",
        ]),
        "deathmatch" => out.extend(["bot_difficulty 3", "bot_quota 10", "bot_quota_mode normal", "mp_warmup_end"]),
        _ => {}
    }
    let mut lines: Vec<String> = out.into_iter().map(String::from).collect();
    if l.headshot_only {
        lines.push("mp_damage_headshot_only 1".into());
    }
    lines.extend(l.commands.lines().map(|c| c.trim().to_string()).filter(|c| !c.is_empty()));
    lines
}

/// Steam launch arguments and the console commands they amount to (shown when CS2 is already
/// open, to paste into the console).
pub fn plan(l: &Launch) -> Result<(Vec<String>, String), String> {
    let t = l.target.trim();
    let ok = |s: &str, extra: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || extra.contains(c));
    let mut args: Vec<String> = vec![];
    let mut console: Vec<String> = vec![];
    match l.kind.as_str() {
        "workshop" if ok(t, "") && t.chars().all(|c| c.is_ascii_digit()) => {
            args.extend(["+host_workshop_map".into(), t.into()]);
            console.push(format!("host_workshop_map {t}"));
        }
        "map" if ok(t, "_") => {
            if l.mode == "deathmatch" {
                args.extend(["+game_type".into(), "1".into(), "+game_mode".into(), "2".into()]);
                console.push("game_type 1; game_mode 2".into());
            }
            args.extend(["+map".into(), t.into()]);
            console.push(format!("map {t}"));
        }
        "server" if ok(t, ".:-") => {
            args.extend(["+connect".into(), t.into()]);
            console.push(format!("connect {t}"));
        }
        _ => return Err(format!("That doesn't look like a valid {}.", if l.kind == "server" { "server address" } else { "map" })),
    }
    let lines = practice_lines(l);
    if !lines.is_empty() {
        let cfg = cs2hl_render::steam::cs2_csgo_dir().map_err(|e| e.to_string())?.join("cfg").join("veloxify_practice.cfg");
        let body = format!("// Written by Veloxify for practice launches. Run `exec veloxify_practice` to apply again.\n{}\n", lines.join("\n"));
        std::fs::write(&cfg, body).map_err(|e| e.to_string())?;
        args.extend(["+exec".into(), "veloxify_practice".into()]);
        console.push("exec veloxify_practice".into());
    }
    Ok((args, console.join("; ")))
}

/// Starts CS2 through Steam with `args`.
pub fn start(args: &[String]) -> Result<(), String> {
    let mut all: Vec<String> = vec!["-applaunch".into(), "730".into()];
    all.extend_from_slice(args);
    std::process::Command::new(cs2hl_render::steam::steam_exe()).args(&all).spawn().map_err(|e| e.to_string())?;
    Ok(())
}
