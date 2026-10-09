//! Locating Steam, CS2 and the user's CS2 config folder.

use anyhow::{Context, Result};
use std::path::{Path, PathBuf};
use windows::core::w;
use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD, RRF_RT_REG_SZ};

pub const STEAMID64_BASE: u64 = 76561197960265728;

/// Steam's install folder, from the registry (falls back to the default location).
pub fn steam_dir() -> PathBuf {
    let mut buf = [0u16; 1024];
    let mut len = (buf.len() * 2) as u32;
    let ok = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            w!("Software\\Valve\\Steam"),
            w!("SteamPath"),
            RRF_RT_REG_SZ,
            None,
            Some(buf.as_mut_ptr().cast()),
            Some(&mut len),
        )
    };
    if ok.is_ok() {
        let n = (len as usize / 2).saturating_sub(1);
        let s = String::from_utf16_lossy(&buf[..n]);
        if !s.is_empty() {
            return PathBuf::from(s.replace('/', "\\"));
        }
    }
    PathBuf::from(r"C:\Program Files (x86)\Steam")
}

/// Whether Steam is running with an account signed in (Steam keeps the signed-in account id in
/// the registry; 0 while it's at the sign-in window). A game launched before then waits for the
/// sign-in and starts after it, when the user may want to play.
pub fn signed_in() -> bool {
    let mut user = 0u32;
    let mut len = 4u32;
    let ok = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            w!("Software\\Valve\\Steam\\ActiveProcess"),
            w!("ActiveUser"),
            RRF_RT_REG_DWORD,
            None,
            Some((&mut user as *mut u32).cast()),
            Some(&mut len),
        )
    };
    ok.is_ok() && user != 0
}

pub fn steam_exe() -> PathBuf {
    steam_dir().join("steam.exe")
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
