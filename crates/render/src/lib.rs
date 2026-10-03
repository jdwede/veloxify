//! Background highlight rendering: a CS2 session controlled over VConsole, recorded with Windows
//! Graphics Capture, with the user's settings protected throughout.

pub mod assemble;
pub mod batch;
pub mod profile;
pub mod protect;
pub mod session;
pub mod steam;
pub mod vconsole;
pub mod window;

/// Window rects and capture sizes must be in physical pixels.
pub fn dpi_aware() {
    use windows::Win32::UI::HiDpi::{SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
}
