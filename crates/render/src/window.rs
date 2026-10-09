//! Keeping the CS2 render window out of the user's way.

use windows::core::{w, BOOL};
use windows::Win32::Foundation::{HWND, LPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, FindWindowW, GetClassNameW, GetDlgItemTextW, GetForegroundWindow, GetShellWindow, GetWindowTextW, GetSystemMetrics,
    GetWindowThreadProcessId, IsWindow, IsWindowVisible, SetForegroundWindow, SetWindowPos, HWND_BOTTOM, SM_CXVIRTUALSCREEN, SM_XVIRTUALSCREEN,
    SWP_NOACTIVATE, SWP_NOSIZE,
};

pub const TITLE: &str = "Counter-Strike 2";

pub fn cs2_window() -> Option<HWND> {
    unsafe { FindWindowW(None, w!("Counter-Strike 2")).ok().filter(|h| !h.is_invalid()) }
}

pub fn foreground() -> HWND {
    unsafe { GetForegroundWindow() }
}

/// Whether `h` is still an open, visible window (not closed, not hidden to the tray).
pub fn is_open(h: HWND) -> bool {
    unsafe { !h.is_invalid() && IsWindow(Some(h)).as_bool() && IsWindowVisible(h).as_bool() }
}

/// The message of an error box the process `pid` is showing: CS2 stops with one ("FATAL ERROR:
/// ...") when it can't go on, for example on a demo from an older version, and waits there.
pub fn error_box(pid: u32) -> Option<String> {
    struct Find {
        pid: u32,
        text: Option<String>,
    }
    unsafe extern "system" fn each(h: HWND, l: LPARAM) -> BOOL {
        let f = unsafe { &mut *(l.0 as *mut Find) };
        let mut owner = 0u32;
        unsafe { GetWindowThreadProcessId(h, Some(&mut owner)) };
        if owner != f.pid || !unsafe { IsWindowVisible(h) }.as_bool() {
            return BOOL(1);
        }
        let mut class = [0u16; 32];
        let n = unsafe { GetClassNameW(h, &mut class) };
        if String::from_utf16_lossy(&class[..n.max(0) as usize]) != "#32770" {
            return BOOL(1);
        }
        // A message box's text is its item 0xFFFF.
        let mut buf = [0u16; 512];
        let n = unsafe { GetDlgItemTextW(h, 0xFFFF, &mut buf) } as usize;
        f.text = Some(String::from_utf16_lossy(&buf[..n.min(buf.len())]));
        BOOL(0)
    }
    let mut f = Find { pid, text: None };
    unsafe {
        let _ = EnumWindows(Some(each), LPARAM(&mut f as *mut Find as isize));
    }
    f.text
}

/// Milliseconds since the last keyboard or mouse input anywhere on the PC.
pub fn idle_ms() -> u32 {
    use windows::Win32::System::SystemInformation::GetTickCount;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    let mut info = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
    unsafe {
        if !GetLastInputInfo(&mut info).as_bool() {
            return u32::MAX;
        }
        GetTickCount().wrapping_sub(info.dwTime)
    }
}

/// A window's title (for logs).
pub fn title(h: HWND) -> String {
    let mut buf = [0u16; 256];
    let n = unsafe { GetWindowTextW(h, &mut buf) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

/// Gives the focus to the desktop (when CS2 got it without anyone asking).
pub fn focus_desktop() {
    unsafe {
        let _ = SetForegroundWindow(GetShellWindow());
    }
}

pub fn set_foreground(h: HWND) {
    unsafe {
        let _ = SetForegroundWindow(h);
    }
}

/// Moves CS2 past the right edge of the virtual desktop without activating it. Windows Graphics
/// Capture still receives frames for windows outside the visible desktop.
pub fn park_offscreen() {
    if let Some(h) = cs2_window() {
        unsafe {
            let right = GetSystemMetrics(SM_XVIRTUALSCREEN) + GetSystemMetrics(SM_CXVIRTUALSCREEN) + 100;
            let _ = SetWindowPos(h, Some(HWND_BOTTOM), right, 0, 0, 0, SWP_NOSIZE | SWP_NOACTIVATE);
        }
    }
}
