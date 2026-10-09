//! Cheap system queries the background worker polls.

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
use windows::Win32::System::Registry::{RegDeleteKeyValueW, RegGetValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ, RRF_RT_REG_DWORD, RRF_RT_REG_SZ};

/// Whether cs2.exe is running: one process-list snapshot, no handles opened to any process.
pub fn cs2_running() -> bool {
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return false };
        let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut found = false;
        if Process32FirstW(snap, &mut entry).is_ok() {
            loop {
                let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
                if String::from_utf16_lossy(&entry.szExeFile[..len]).eq_ignore_ascii_case("cs2.exe") {
                    found = true;
                    break;
                }
                if Process32NextW(snap, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
        found
    }
}

/// SteamID64 of the account signed in to Steam (registry `ActiveProcess\ActiveUser`), else the
/// account last signed in on this PC (Steam sometimes leaves that registry value at 0).
pub fn active_steam_user() -> Option<u64> {
    let mut value: u32 = 0;
    let mut len = 4u32;
    let ok = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            w!("Software\\Valve\\Steam\\ActiveProcess"),
            w!("ActiveUser"),
            RRF_RT_REG_DWORD,
            None,
            Some((&mut value as *mut u32).cast()),
            Some(&mut len),
        )
    };
    (ok.is_ok() && value != 0).then(|| cs2hl_render::steam::STEAMID64_BASE + value as u64).or_else(cs2hl_render::steam::recent_login)
}

/// The Steam display name last used in a game (registry `LastGameNameUsed`), as a hint for
/// finding the user's FACEIT account.
pub fn steam_persona_name() -> Option<String> {
    let mut buf = vec![0u16; 256];
    let mut len = (buf.len() * 2) as u32;
    let ok = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            w!("Software\\Valve\\Steam"),
            w!("LastGameNameUsed"),
            RRF_RT_REG_SZ,
            None,
            Some(buf.as_mut_ptr().cast()),
            Some(&mut len),
        )
    };
    if ok.is_err() {
        return None;
    }
    let n = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    let name = String::from_utf16_lossy(&buf[..n]);
    (!name.is_empty()).then_some(name)
}

const RUN_KEY: PCWSTR = w!("Software\\Microsoft\\Windows\\CurrentVersion\\Run");

/// Adds or removes Veloxify from the current user's startup programs (starts in the tray).
pub fn set_start_with_windows(enabled: bool) -> Result<(), String> {
    let r = unsafe {
        if enabled {
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            let cmd: Vec<u16> = format!("\"{}\" --hidden", exe.display()).encode_utf16().chain([0]).collect();
            RegSetKeyValueW(HKEY_CURRENT_USER, RUN_KEY, w!("Veloxify"), REG_SZ.0, Some(cmd.as_ptr().cast()), (cmd.len() * 2) as u32)
        } else {
            match RegDeleteKeyValueW(HKEY_CURRENT_USER, RUN_KEY, w!("Veloxify")) {
                // Already absent is fine.
                r if r.0 == 2 => return Ok(()),
                r => r,
            }
        }
    };
    r.ok().map_err(|e| e.message())
}
