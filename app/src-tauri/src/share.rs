//! Sharing a clip: a copy that fits Discord's upload limit, with the Veloxify mark in the corner,
//! put on the clipboard to paste straight into Discord (Ctrl+V). Copies are kept a week in
//! Veloxify's folder, so sharing the same clip again is instant.

use crate::settings::data_dir;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// The mark's logo (the app icon).
const LOGO: &[u8] = include_bytes!("../icons/128x128@2x.png");

pub struct Shared {
    pub path: PathBuf,
    pub bytes: u64,
    pub height: u32,
}

/// A copy of `clip` under `limit_mb` megabytes, with the mark: made now, or the one made before
/// (if the clip hasn't been filmed again since).
pub fn discord_copy(clip: &Path, limit_mb: u32) -> Result<Shared, String> {
    let dir = data_dir().join("share");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    forget_old(&dir);
    let stem = clip.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "clip".into());
    let dst = dir.join(format!("{stem}-{limit_mb}mb.mp4"));
    // Megabytes as Discord counts them, or a little under (1,000,000 bytes each).
    let limit = limit_mb as u64 * 1_000_000;
    let modified = |p: &Path| std::fs::metadata(p).and_then(|m| m.modified()).ok();
    if let (Some(made), Some(filmed), Ok(meta)) = (modified(&dst), modified(clip), std::fs::metadata(&dst)) {
        if made >= filmed && meta.len() <= limit && meta.len() > 0 {
            let (_, height) = cs2hl_render::assemble::probe(&dst).unwrap_or((0.0, 0));
            return Ok(Shared { path: dst, bytes: meta.len(), height });
        }
    }
    let logo = dir.join("veloxify-mark.png");
    if !logo.exists() {
        std::fs::write(&logo, LOGO).map_err(|e| e.to_string())?;
    }
    let fonts = PathBuf::from(std::env::var("WINDIR").unwrap_or_else(|_| r"C:\Windows".into())).join("Fonts");
    let font = ["segoeuib.ttf", "segoeui.ttf", "arialbd.ttf", "arial.ttf"].iter().map(|f| fonts.join(f)).find(|p| p.exists());
    let made = cs2hl_render::assemble::share_copy(clip, &dst, limit, Some(&logo), font.as_deref(), &dir.join("work")).map_err(|e| format!("{e:#}"))?;
    Ok(Shared { path: dst, bytes: made.bytes, height: made.height })
}

/// Shared copies older than a week go.
fn forget_old(dir: &Path) {
    let Ok(list) = std::fs::read_dir(dir) else { return };
    for f in list.flatten() {
        let p = f.path();
        let old = f.metadata().and_then(|m| m.modified()).ok().and_then(|t| SystemTime::now().duration_since(t).ok()).is_some_and(|age| age > Duration::from_secs(7 * 86_400));
        if old && p.extension().is_some_and(|e| e == "mp4") {
            let _ = std::fs::remove_file(p);
        }
    }
}

/// Puts a file on the clipboard, as Explorer's Copy does (paste it into Discord, a chat, a folder).
pub fn to_clipboard(path: &Path) -> Result<(), String> {
    let mut c = std::process::Command::new("powershell");
    c.args(["-NoProfile", "-Command", &format!("Set-Clipboard -LiteralPath '{}'", path.display().to_string().replace('\'', "''"))]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    let out = c.output().map_err(|e| e.to_string())?;
    out.status.success().then_some(()).ok_or_else(|| String::from_utf8_lossy(&out.stderr).into_owned())
}
