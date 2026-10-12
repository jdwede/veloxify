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

/// The mice plugged in, by their product names ("G Pro X Superlight"), else by USB vendor and
/// product id. Virtual ones (remote desktop) are left out.
pub fn mice() -> Vec<String> {
    use windows::Win32::Devices::HumanInterfaceDevice::HidD_GetProductString;
    use windows::Win32::Storage::FileSystem::{CreateFileW, FILE_FLAGS_AND_ATTRIBUTES, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING};
    use windows::Win32::UI::Input::{GetRawInputDeviceInfoW, GetRawInputDeviceList, RAWINPUTDEVICELIST, RIDI_DEVICENAME, RIM_TYPEMOUSE};
    let mut out: Vec<String> = vec![];
    unsafe {
        let size = std::mem::size_of::<RAWINPUTDEVICELIST>() as u32;
        let mut n = 0u32;
        GetRawInputDeviceList(None, &mut n, size);
        let mut list = vec![RAWINPUTDEVICELIST::default(); n as usize];
        let got = GetRawInputDeviceList(Some(list.as_mut_ptr()), &mut n, size);
        if got == u32::MAX {
            return out;
        }
        for d in list.iter().take(got as usize).filter(|d| d.dwType == RIM_TYPEMOUSE) {
            let mut len = 0u32;
            GetRawInputDeviceInfoW(Some(d.hDevice), RIDI_DEVICENAME, None, &mut len);
            let mut path = vec![0u16; len as usize + 1];
            if GetRawInputDeviceInfoW(Some(d.hDevice), RIDI_DEVICENAME, Some(path.as_mut_ptr().cast()), &mut len) == u32::MAX {
                continue;
            }
            let p = String::from_utf16_lossy(&path[..path.iter().position(|&c| c == 0).unwrap_or(path.len())]).to_uppercase();
            if p.contains("RDP") || p.contains("ROOT#") || !p.contains("VID_") {
                continue;
            }
            let mut name = String::new();
            if let Ok(h) = CreateFileW(PCWSTR(path.as_ptr()), 0, FILE_SHARE_READ | FILE_SHARE_WRITE, None, OPEN_EXISTING, FILE_FLAGS_AND_ATTRIBUTES(0), None) {
                let mut buf = [0u16; 128];
                if HidD_GetProductString(h, buf.as_mut_ptr().cast(), (buf.len() * 2) as u32) {
                    name = String::from_utf16_lossy(&buf[..buf.iter().position(|&c| c == 0).unwrap_or(buf.len())]).trim().to_string();
                }
                let _ = CloseHandle(h);
            }
            if name.is_empty() {
                let id = |key: &str| p.split(key).nth(1).map(|r| r.chars().take(4).collect::<String>()).unwrap_or_default();
                name = format!("Mouse {}:{}", id("VID_"), id("PID_"));
            }
            if !out.contains(&name) {
                out.push(name);
            }
        }
    }
    out.sort();
    out
}
