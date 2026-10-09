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
