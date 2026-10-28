//! Locating Steam, CS2 and the user's CS2 config folder.

use anyhow::{Context, Result};
use std::path::{Path, PathBuf};
use windows::core::{w, PCWSTR};
use windows::Win32::System::Registry::{RegGetValueW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};

pub const STEAMID64_BASE: u64 = 76561197960265728;

/// A text value from the registry.
fn reg_sz(hive: HKEY, key: PCWSTR, value: PCWSTR) -> Option<String> {
    let mut buf = [0u16; 1024];
    let mut len = (buf.len() * 2) as u32;
    let ok = unsafe { RegGetValueW(hive, key, value, RRF_RT_REG_SZ, None, Some(buf.as_mut_ptr().cast()), Some(&mut len)) };
    let n = (len as usize / 2).saturating_sub(1);
    let s = String::from_utf16_lossy(&buf[..n.min(buf.len())]);
    (ok.is_ok() && !s.is_empty()).then(|| s.replace('/', "\\"))
}

/// Where Steam says it's installed: your account's Steam settings first, then the machine's.
fn steam_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = [
        reg_sz(HKEY_CURRENT_USER, w!("Software\\Valve\\Steam"), w!("SteamPath")),
        reg_sz(HKEY_LOCAL_MACHINE, w!("SOFTWARE\\WOW6432Node\\Valve\\Steam"), w!("InstallPath")),
        reg_sz(HKEY_LOCAL_MACHINE, w!("SOFTWARE\\Valve\\Steam"), w!("InstallPath")),
    ]
    .into_iter()
    .flatten()
    .map(PathBuf::from)
    .collect();
    dirs.push(PathBuf::from(r"C:\Program Files (x86)\Steam"));
    dirs
}

/// Steam's install folder: the first one Windows knows of that has Steam in it.
pub fn steam_dir() -> PathBuf {
    let dirs = steam_dirs();
    dirs.iter().find(|d| d.join("steam.exe").is_file()).unwrap_or(&dirs[0]).clone()
}

/// Steam's program: where Steam last said it was, else in its install folder.
pub fn steam_exe() -> PathBuf {
    reg_sz(HKEY_CURRENT_USER, w!("Software\\Valve\\Steam"), w!("SteamExe"))
        .map(PathBuf::from)
        .filter(|p| p.is_file())
        .unwrap_or_else(|| steam_dir().join("steam.exe"))
}

/// The end of one of Steam's own logs (`logs/<name>`): its last 256 KB.
fn log_tail(name: &str) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(steam_dir().join("logs").join(name)).ok()?;
    let len = f.metadata().ok()?.len();
    f.seek(SeekFrom::Start(len.saturating_sub(256 * 1024))).ok()?;
    let mut buf = vec![];
    f.read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// What's holding up Steam's latest start of CS2 (in the last 15 minutes), from Steam's log of
/// its steps: waiting for an answer (a "Cloud sync failed" message...) or stuck on one step for
/// over a minute. None when it finished, failed, or is just getting on with it.
pub fn launch_waiting() -> Option<String> {
    launch_waiting_in(&log_tail("console_log.txt")?, chrono::Local::now().naive_local())
}

/// [`launch_waiting`] from the end of Steam's log, at local time `now`.
fn launch_waiting_in(text: &str, now: chrono::NaiveDateTime) -> Option<String> {
    // [2026-10-28 04:07:46] GameAction [AppID 730, ActionID 105] : LaunchApp waiting for user response to SynchronizingCloud "syncfailed"
    let (at, what) = text.lines().rev().find_map(|l| {
        let (at, rest) = l.strip_prefix('[')?.split_once("] GameAction [AppID 730, ActionID ")?;
        let what = rest.split_once("] : LaunchApp ")?.1;
        Some((chrono::NaiveDateTime::parse_from_str(at, "%Y-%m-%d %H:%M:%S").ok()?, what))
    })?;
    let age = now - at;
    if age > chrono::TimeDelta::minutes(15) {
        return None;
    }
    if let Some(step) = what.strip_prefix("waiting for user response to ") {
        let task = step.split(' ').next().unwrap_or(step);
        return match task {
            // Steam answers these itself.
            "ShowInterstitials" | "CreatingProcess" => None,
            "SynchronizingCloud" => Some("Steam couldn't sync CS2's Steam Cloud files and is asking what to do (restarting Steam clears it)".into()),
            _ => Some(format!("Steam is waiting for an answer before it starts CS2 ({step})")),
        };
    }
    let task = what.strip_prefix("changed task to ")?.split(" with ").next()?;
    if matches!(task, "Completed" | "Failed") || age < chrono::TimeDelta::minutes(1) {
        return None;
    }
    Some(match task {
        "SynchronizingCloud" => "Steam is stuck syncing CS2's Steam Cloud files (restarting Steam clears it)".into(),
        "DownloadingDepots" => "Steam is updating CS2 first".into(),
        "WaitingPrevProcess" => "Steam is waiting for an earlier CS2 to close".into(),
        _ => format!("Steam's start of CS2 is stuck at \"{task}\""),
    })
}

/// Why Steam's start of CS2 since `since` (local time) failed, from its log: e.g. AppError_16
/// when it was asked while it still counted an earlier CS2 as running.
pub fn launch_failed(since: chrono::NaiveDateTime) -> Option<String> {
    launch_failed_in(&log_tail("console_log.txt")?, since)
}

fn launch_failed_in(text: &str, since: chrono::NaiveDateTime) -> Option<String> {
    // [2026-10-28 14:48:34] GameAction [AppID 730, ActionID 429] : LaunchApp failed with AppError_16 with ""
    text.lines().rev().find_map(|l| {
        let (at, rest) = l.strip_prefix('[')?.split_once("] GameAction [AppID 730, ActionID ")?;
        let at = chrono::NaiveDateTime::parse_from_str(at, "%Y-%m-%d %H:%M:%S").ok()?;
        let error = rest.split_once("] : LaunchApp failed with ")?.1.split(' ').next()?;
        (at >= since).then(|| format!("Steam couldn't start it ({error})"))
    })
}

/// Whether Steam still counts a CS2 as running (its log: added, not removed since). It notices a
/// CS2 that closed a few seconds late, and won't start another until then.
pub fn tracks_cs2() -> bool {
    log_tail("gameprocess_log.txt").is_some_and(|t| tracks_cs2_in(&t))
}

fn tracks_cs2_in(text: &str) -> bool {
    text.lines().rev().find_map(|l| {
        if l.ends_with("] Remove 730 from running list") {
            Some(false)
        } else {
            l.contains("] AppID 730 adding PID ").then_some(true)
        }
    }) == Some(true)
}

/// Whether the latest CS2 Steam started has Veloxify's `-insecure` (Steam logs each game's
/// command line as it starts it); None when Steam's log doesn't say.
pub fn last_cs2_was_ours() -> Option<bool> {
    let text = log_tail("gameprocess_log.txt")?;
    let line = text.lines().rev().find(|l| l.contains(" as a tracked process ") && l.contains("cs2.exe"))?;
    Some(line.contains(" -insecure"))
}

/// When a CS2 you started yourself last closed (Unix seconds), from Steam's log of the games it
/// runs: so Veloxify knows you just played even when it wasn't running at the time.
pub fn last_played() -> Option<i64> {
    use chrono::TimeZone;
    let at = last_played_in(&log_tail("gameprocess_log.txt")?)?;
    chrono::Local.from_local_datetime(&at).earliest().map(|t| t.timestamp())
}

/// [`last_played`] from the end of Steam's log.
fn last_played_in(text: &str) -> Option<chrono::NaiveDateTime> {
    // [2026-10-28 04:26:03] AppID 730 adding PID 80108 as a tracked process ""C:\...\cs2.exe" -steam -novid"
    // [2026-10-28 04:51:37] Remove 730 from running list
    let (mut yours, mut last) = (false, None);
    for l in text.lines() {
        let Some((at, what)) = l.strip_prefix('[').and_then(|l| l.split_once("] ")) else { continue };
        // A start with its command line: CS2 (yours unless it has Veloxify's -insecure), or
        // another program counted as CS2 (Veloxify's Premier check). CS2 starting itself again
        // is logged without one.
        if what.starts_with("AppID 730 adding PID") && what.contains("tracked process \"") {
            yours = what.contains("cs2.exe") && !what.contains(" -insecure");
        } else if what == "Remove 730 from running list" && yours {
            last = chrono::NaiveDateTime::parse_from_str(at, "%Y-%m-%d %H:%M:%S").ok().or(last);
        }
    }
    last
}

/// The account last signed in on this PC, from Steam's list of remembered accounts
/// (`config/loginusers.vdf`: account ids and names, no passwords): the one marked most recent,
/// else the newest. For when Steam doesn't say who's signed in right now.
pub fn recent_login() -> Option<u64> {
    let text = std::fs::read_to_string(steam_dir().join("config").join("loginusers.vdf")).ok()?;
    let mut best: Option<(bool, u64, u64)> = None; // (most recent, timestamp, steamid)
    let mut cur: Option<(bool, u64, u64)> = None;
    for line in text.lines() {
        let parts: Vec<&str> = line.split('"').filter(|p| !p.trim().is_empty()).collect();
        match parts.as_slice() {
            [id] if id.len() == 17 && id.starts_with("7656") => {
                best = best.max(cur.take());
                cur = id.parse().ok().map(|id| (false, 0, id));
            }
            ["MostRecent", v] => {
                if let Some(c) = cur.as_mut() {
                    c.0 = *v == "1";
                }
            }
            ["Timestamp", v] => {
                if let Some(c) = cur.as_mut() {
                    c.1 = v.parse().unwrap_or(0);
                }
            }
            _ => {}
        }
    }
    best.max(cur).map(|(_, _, id)| id)
}

/// `...\Counter-Strike Global Offensive\game\csgo`, searching every Steam library folder.
pub fn cs2_csgo_dir() -> Result<PathBuf> {
    let steam = steam_dir();
    let mut libraries = vec![steam.clone()];
    if let Ok(vdf) = std::fs::read_to_string(steam.join("steamapps").join("libraryfolders.vdf")) {
        for line in vdf.lines() {
            let parts: Vec<&str> = line.split('"').collect();
            if parts.len() >= 4 && parts[1] == "path" {
                libraries.push(PathBuf::from(parts[3].replace("\\\\", "\\")));
            }
        }
    }
    libraries
        .into_iter()
        .map(|l| l.join(r"steamapps\common\Counter-Strike Global Offensive\game\csgo"))
        .find(|p| p.is_dir())
        .context("CS2 install not found in any Steam library")
}

/// CS2's installed build (`steamapps\appmanifest_730.acf`): it changes with each CS2 update.
pub fn cs2_build() -> Option<String> {
    let csgo = cs2_csgo_dir().ok()?;
    let acf = std::fs::read_to_string(csgo.ancestors().nth(4)?.join("appmanifest_730.acf")).ok()?;
    acf.lines().find_map(|l| {
        let parts: Vec<&str> = l.split('"').collect();
        (parts.len() >= 4 && parts[1] == "buildid").then(|| parts[3].to_string())
    })
}

/// The user's CS2 config folder (`userdata\<account id>\730\local\cfg`).
pub fn user_cfg_dir(steamid64: u64) -> PathBuf {
    steam_dir().join("userdata").join((steamid64 - STEAMID64_BASE).to_string()).join(r"730\local\cfg")
}

pub fn account_id(steamid64: u64) -> u64 {
    steamid64 - STEAMID64_BASE
}

pub fn exists(p: &Path) -> bool {
    p.exists()
}

#[cfg(test)]
mod tests {
    use super::{last_played_in, launch_failed_in, launch_waiting_in, tracks_cs2_in};

    const LOG: &str = r#"[2026-10-28 04:07:45] ExecCommandLine: ""c:\program files (x86)\steam\steam.exe" -applaunch 730 -insecure"
[2026-10-28 04:07:45] GameAction [AppID 730, ActionID 105] : LaunchApp changed task to UpdatingAppInfo with ""
[2026-10-28 04:07:46] GameAction [AppID 730, ActionID 105] : LaunchApp changed task to SynchronizingCloud with ""
[2026-10-28 04:07:46] GameAction [AppID 730, ActionID 105] : LaunchApp waiting for user response to SynchronizingCloud "syncfailed"
"#;

    fn at(t: &str) -> chrono::NaiveDateTime {
        chrono::NaiveDateTime::parse_from_str(t, "%Y-%m-%d %H:%M:%S").unwrap()
    }

    #[test]
    fn steam_waiting_on_cloud_sync() {
        assert!(launch_waiting_in(LOG, at("2026-10-28 04:07:50")).unwrap().contains("Steam Cloud"));
        // Long gone: not about this start.
        assert_eq!(launch_waiting_in(LOG, at("2026-10-28 05:00:00")), None);
    }

    #[test]
    fn steam_steps_that_finish() {
        let routine = format!("{LOG}[2026-10-28 04:19:20] GameAction [AppID 730, ActionID 106] : LaunchApp waiting for user response to ShowInterstitials \"\"\n");
        assert_eq!(launch_waiting_in(&routine, at("2026-10-28 04:19:21")), None);
        let stuck = "[2026-10-28 03:58:26] GameAction [AppID 730, ActionID 104] : LaunchApp changed task to SynchronizingCloud with \"\"\n";
        assert_eq!(launch_waiting_in(stuck, at("2026-10-28 03:58:50")), None);
        assert!(launch_waiting_in(stuck, at("2026-10-28 04:00:00")).unwrap().contains("stuck syncing"));
        let done = "[2026-10-28 04:26:03] GameAction [AppID 730, ActionID 1] : LaunchApp changed task to Completed with \"\"\n";
        assert_eq!(launch_waiting_in(done, at("2026-10-28 04:30:00")), None);
    }

    #[test]
    fn your_cs2_closing_not_veloxifys() {
        let log = r#"[2026-10-28 04:26:03] AppID 730 adding PID 80108 as a tracked process ""C:\Steam\cs2.exe" -steam -novid -freq 240"
[2026-10-28 04:26:05] Remove 730 from running list
[2026-10-28 04:26:06] AppID 730 adding PID 69112 as a tracked process
[2026-10-28 04:51:37] AppID 730 no longer tracking PID 69112, exit code -1073741819
[2026-10-28 04:51:37] Remove 730 from running list
[2026-10-28 04:54:23] AppID 730 adding PID 83424 as a tracked process ""C:\veloxify.exe" --premier-matches x.json"
[2026-10-28 04:54:26] Remove 730 from running list
[2026-10-28 04:54:29] AppID 730 adding PID 51408 as a tracked process ""C:\Steam\cs2.exe" -steam -insecure -novid -windowed"
[2026-10-28 04:55:11] Remove 730 from running list
"#;
        // Your CS2 started itself again at 04:26:05 (Steam logs a close then too): it closed at 04:51:37.
        assert_eq!(last_played_in(log), Some(at("2026-10-28 04:51:37")));
    }

    #[test]
    fn steam_slow_to_see_cs2_gone() {
        let log = r#"[2026-10-28 14:47:54] AppID 730 adding PID 60992 as a tracked process ""C:\cs2.exe" -steam -insecure"
[2026-10-28 14:47:55] AppID 730 adding PID 123716 as a tracked process
[2026-10-28 14:48:22] SSGL: persona state flags"#;
        assert!(tracks_cs2_in(log));
        let gone = format!("{log}\n[2026-10-28 14:48:37] AppID 730 no longer tracking PID 123716, exit code -1073741819\n[2026-10-28 14:48:37] Remove 730 from running list");
        assert!(!tracks_cs2_in(&gone));
    }

    #[test]
    fn steam_refusing_a_start() {
        let log = r#"[2026-10-28 14:48:29] GameAction [AppID 730, ActionID 429] : LaunchApp changed task to WaitingPrevProcess with ""
[2026-10-28 14:48:34] GameAction [AppID 730, ActionID 429] : LaunchApp failed with AppError_16 with ""
[2026-10-28 14:48:34] GameAction [AppID 730, ActionID 429] : LaunchApp changed task to Failed with """#;
        let at = |t: &str| chrono::NaiveDateTime::parse_from_str(t, "%Y-%m-%d %H:%M:%S").unwrap();
        assert_eq!(launch_failed_in(log, at("2026-10-28 14:48:28")).as_deref(), Some("Steam couldn't start it (AppError_16)"));
        assert_eq!(launch_failed_in(log, at("2026-10-28 14:50:00")), None);
    }
}
