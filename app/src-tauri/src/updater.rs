//! One-click updates: the newest release on GitHub; its installer is downloaded and run quietly
//! (only its progress bar shows) and reopens Veloxify when it's done.

use anyhow::{bail, Context, Result};
use serde::Serialize;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

const REPO: &str = "jdwede/veloxify";

/// An update is being downloaded or installed: the background work stays idle meanwhile.
static UPDATING: AtomicBool = AtomicBool::new(false);

pub fn updating() -> bool {
    UPDATING.load(Ordering::SeqCst)
}

pub fn set_updating(on: bool) {
    UPDATING.store(on, Ordering::SeqCst);
}

#[derive(Clone, Serialize, Default)]
pub struct Update {
    pub version: String,
    /// The release notes (markdown).
    pub notes: String,
    pub url: String,
    pub size: u64,
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout_read(Duration::from_secs(60))
        .user_agent(concat!("Veloxify/", env!("CARGO_PKG_VERSION")))
        .build()
}

fn parts(v: &str) -> Vec<u64> {
    v.trim().trim_start_matches('v').split('.').map(|p| p.trim().parse().unwrap_or(0)).collect()
}

/// Whether version `a` is newer than `b` ("0.4.10" is newer than "0.4.9").
pub fn newer(a: &str, b: &str) -> bool {
    parts(a) > parts(b)
}

/// The newest release, if it's newer than this Veloxify.
pub fn check() -> Result<Option<Update>> {
    let v: serde_json::Value =
        agent().get(&format!("https://api.github.com/repos/{REPO}/releases/latest")).set("Accept", "application/vnd.github+json").call()?.into_json()?;
    let tag = v["tag_name"].as_str().context("no release")?;
    if !newer(tag, env!("CARGO_PKG_VERSION")) {
        return Ok(None);
    }
    let asset = v["assets"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|a| a["name"].as_str().is_some_and(|n| n.ends_with("_x64-setup.exe")))
        .context("the release has no installer")?;
    let url = asset["browser_download_url"].as_str().unwrap_or("").to_string();
    if !url.starts_with(&format!("https://github.com/{REPO}/releases/download/")) {
        bail!("unexpected download link");
    }
    Ok(Some(Update { version: tag.trim_start_matches('v').into(), notes: v["body"].as_str().unwrap_or("").into(), url, size: asset["size"].as_u64().unwrap_or(0) }))
}

/// Downloads the installer to the temp folder; `progress(bytes so far, total)`.
pub fn download(u: &Update, progress: impl Fn(u64, u64)) -> Result<PathBuf> {
    let name = u.url.rsplit('/').next().unwrap_or("");
    if !name.ends_with(".exe") || !name.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)) {
        bail!("unexpected installer name");
    }
    let dir = std::env::temp_dir().join("veloxify-update");
    std::fs::create_dir_all(&dir)?;
    let dest = dir.join(name);
    let part = dir.join(format!("{name}.part"));
    let mut reader = agent().get(&u.url).call()?.into_reader();
    let mut file = std::fs::File::create(&part)?;
    let mut buf = vec![0u8; 1 << 16];
    let (mut done, mut shown) = (0u64, Instant::now());
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n])?;
        done += n as u64;
        if shown.elapsed() > Duration::from_millis(150) {
            progress(done, u.size);
            shown = Instant::now();
        }
    }
    file.flush()?;
    drop(file);
    if u.size > 0 && done != u.size {
        bail!("the download was cut short");
    }
    let _ = std::fs::remove_file(&dest);
    std::fs::rename(&part, &dest)?;
    progress(done, u.size);
    Ok(dest)
}

/// Runs the installer: /P shows only its progress bar, /UPDATE keeps everything as it is, /R
/// reopens Veloxify afterwards.
pub fn run_installer(path: &Path) -> Result<()> {
    std::process::Command::new(path).args(["/P", "/UPDATE", "/R"]).spawn().context("starting the installer")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::newer;

    #[test]
    fn compares_versions_by_number() {
        assert!(newer("v0.4.10", "0.4.9"));
        assert!(newer("0.5.0", "0.4.12"));
        assert!(!newer("v0.4.9", "0.4.10"));
        assert!(!newer("0.4.10", "0.4.10"));
    }
}
