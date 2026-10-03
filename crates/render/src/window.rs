//! Keeping the CS2 render window out of the user's way.

use windows::core::w;
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::WindowsAndMessaging::{
    FindWindowW, GetForegroundWindow, GetSystemMetrics, SetForegroundWindow, SetWindowPos, HWND_BOTTOM, SM_CXVIRTUALSCREEN,
    SM_XVIRTUALSCREEN, SWP_NOACTIVATE, SWP_NOSIZE,
};

pub const TITLE: &str = "Counter-Strike 2";

pub fn cs2_window() -> Option<HWND> {
    unsafe { FindWindowW(None, w!("Counter-Strike 2")).ok().filter(|h| !h.is_invalid()) }
}

pub fn foreground() -> HWND {
    unsafe { GetForegroundWindow() }
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
