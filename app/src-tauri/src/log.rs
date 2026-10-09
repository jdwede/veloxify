//! Veloxify's running log (`veloxify.log` in the app's data folder): what it did and what went
//! wrong, kept to about 2 MB (the previous one stays as `veloxify.1.log`). "Save debug log" puts
//! it in a report on the Desktop that a person can send to whoever is helping them.

use crate::settings::{data_dir, Settings};
use crate::worker::Status;
use cs2hl_core::library::{Index, MatchEntry};
use std::fmt::Write as _;
use std::io::Write as _;
use std::path::Path;
use std::sync::Mutex;

static LOCK: Mutex<()> = Mutex::new(());
const MAX_BYTES: u64 = 2_000_000;
/// Lines of the log in the report.
const REPORT_LINES: usize = 2000;

/// Appends to the log, each line timestamped.
pub fn line(what: impl AsRef<str>) {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = data_dir().join("veloxify.log");
    if std::fs::metadata(&path).is_ok_and(|m| m.len() > MAX_BYTES) {
        let _ = std::fs::rename(&path, data_dir().join("veloxify.1.log"));
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
        for l in what.as_ref().lines() {
            let _ = writeln!(f, "{now} {l}");
        }
    }
}

fn date(ts: i64) -> String {
    chrono::DateTime::from_timestamp(ts, 0).map(|d| d.with_timezone(&chrono::Local).format("%Y-%m-%d").to_string()).unwrap_or_else(|| "?".into())
}

fn windows_version() -> String {
    let mut c = std::process::Command::new("cmd");
    c.args(["/c", "ver"]);
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    c.output().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default()
}

/// The debug report: versions, where Steam and CS2 are, settings, the library's state and the
/// log's last lines. No passwords or cookies; it does have the Steam ID and match IDs.
pub fn report(version: &str, settings: &Settings, status: &Status) -> String {
    let mut r = String::new();
    let yes = |b: bool| if b { "yes" } else { "no" };
    let _ = writeln!(r, "Veloxify debug log, saved {}", chrono::Local::now().format("%Y-%m-%d %H:%M:%S"));
    let _ = writeln!(r, "Veloxify {version} · {}", windows_version());

    let _ = writeln!(r, "\n== Steam and CS2 ==");
    let exe = cs2hl_render::steam::steam_exe();
    let _ = writeln!(r, "steam.exe: {} (exists: {})", exe.display(), yes(exe.is_file()));
    let _ = writeln!(r, "Steam folder: {}", cs2hl_render::steam::steam_dir().display());
    match cs2hl_render::steam::cs2_csgo_dir() {
        Ok(d) => {
            let _ = writeln!(r, "CS2 game folder: {}", d.display());
        }
        Err(e) => {
            let _ = writeln!(r, "CS2 game folder: not found ({e:#})");
        }
    }
    let _ = writeln!(
        r,
        "Steam account: in settings {:?}, signed in now {:?}, last signed in {:?}",
        settings.steamid64,
        crate::system::active_steam_user(),
        cs2hl_render::steam::recent_login()
    );
    let _ = writeln!(r, "CS2 running: {}", yes(cs2hl_render::session::cs2_running()));
    if let Some(me) = settings.steamid64.or_else(crate::system::active_steam_user) {
        let cfg = cs2hl_render::steam::user_cfg_dir(me);
        let _ = writeln!(r, "CS2 config folder: {} (exists: {})", cfg.display(), yes(cfg.is_dir()));
        let _ = writeln!(r, "Render settings swapped in (cs2_video.txt.veloxify-orig): {}", yes(cfg.join("cs2_video.txt.veloxify-orig").exists()));
    }

    let _ = writeln!(r, "\n== Settings ==");
    let _ = writeln!(r, "Library: {}", settings.library_dir.display());
    let _ = writeln!(
        r,
        "Make highlights automatically: {} · lowlights too: {} · lineup videos: {} · FACEIT data: {} · FACEIT nickname set: {}",
        yes(settings.auto_render),
        yes(settings.auto_lowlights),
        yes(settings.auto_lineups),
        yes(settings.faceit_enabled),
        yes(!settings.faceit_nickname.trim().is_empty())
    );
    if let Some(output) = std::fs::read_to_string(&settings.profile).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()).and_then(|p| p.get("output").cloned()) {
        let _ = writeln!(r, "Video output: {output}");
    }

    let _ = writeln!(r, "\n== Status ==");
    let _ = writeln!(r, "{}: {} ({}/{})", status.state, status.message, status.done, status.total);

    let _ = writeln!(r, "\n== Library ==");
    library(&mut r, &settings.library_dir);

    let _ = writeln!(r, "\n== Log (last {REPORT_LINES} lines) ==");
    let mut lines: Vec<String> = vec![];
    for f in ["veloxify.1.log", "veloxify.log"] {
        if let Ok(t) = std::fs::read_to_string(data_dir().join(f)) {
            lines.extend(t.lines().map(String::from));
        }
    }
    for l in &lines[lines.len().saturating_sub(REPORT_LINES)..] {
        let _ = writeln!(r, "{l}");
    }
    if let Ok(t) = std::fs::read_to_string(data_dir().join("import.log")) {
        let imports: Vec<&str> = t.lines().collect();
        let _ = writeln!(r, "\n== Import problems (last 50) ==");
        for l in &imports[imports.len().saturating_sub(50)..] {
            let _ = writeln!(r, "{l}");
        }
    }
    r
}

/// Matches, demos, clips and what went wrong rendering them.
fn library(r: &mut String, lib: &Path) {
    let Some(index) = std::fs::read_to_string(lib.join("index.json")).ok().and_then(|t| serde_json::from_str::<Index>(&t).ok()) else {
        let _ = writeln!(r, "No library index yet.");
        return;
    };
    let mut entries: Vec<MatchEntry> = index
        .matches
        .iter()
        .filter_map(|m| std::fs::read_to_string(lib.join("matches").join(format!("{}.json", m.id))).ok())
        .filter_map(|t| serde_json::from_str::<MatchEntry>(&t).ok())
        .collect();
    entries.sort_by_key(|e| std::cmp::Reverse(e.played_ts));
    let demos = entries.iter().filter(|e| Path::new(&e.demo_path).exists()).count();
    let (oldest, newest) = (entries.last().map(|e| date(e.played_ts)), entries.first().map(|e| date(e.played_ts)));
    let _ = writeln!(r, "Matches: {} ({} to {}), demos on disk: {demos}", entries.len(), oldest.unwrap_or_default(), newest.unwrap_or_default());
    let mut by_source: std::collections::BTreeMap<&str, usize> = Default::default();
    for e in &entries {
        *by_source.entry(e.source.as_str()).or_default() += 1;
    }
    let _ = writeln!(r, "By source: {by_source:?}");
    let hl = entries.iter().flat_map(|e| e.highlights.iter());
    let (total, clips, failed) = hl.fold((0, 0, 0), |(t, c, f), h| (t + 1, c + h.clip.is_some() as usize, f + h.render_error.is_some() as usize));
    let ll = entries.iter().flat_map(|e| e.lowlights.iter());
    let (ltotal, lclips, lfailed) = ll.fold((0, 0, 0), |(t, c, f), l| (t + 1, c + l.clip.is_some() as usize, f + l.render_error.is_some() as usize));
    let _ = writeln!(r, "Highlights: {total}, filmed {clips}, failed {failed} · Lowlights: {ltotal}, filmed {lclips}, failed {lfailed}");
    let unplayable: Vec<String> = std::fs::read_to_string(lib.join("unplayable_demos.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    let _ = writeln!(r, "Demos CS2 couldn't play: {}", unplayable.len());
    for id in &unplayable {
        let when = entries.iter().find(|e| &e.id == id).map(|e| date(e.played_ts)).unwrap_or_default();
        let _ = writeln!(r, "  {when} {id}");
    }
    let _ = writeln!(r, "Newest filmed match: {}", entries.iter().find(|e| e.highlights.iter().any(|h| h.clip.is_some())).map(|e| format!("{} {}", date(e.played_ts), e.id)).unwrap_or_else(|| "none".into()));
    let _ = writeln!(r, "Recent clip errors (newest 40):");
    let errors = entries.iter().flat_map(|e| {
        let hs = e.highlights.iter().filter_map(move |h| h.render_error.as_ref().map(|err| (e, h.title.as_str(), err.as_str())));
        let ls = e.lowlights.iter().filter_map(move |l| l.render_error.as_ref().map(|err| (e, l.title.as_str(), err.as_str())));
        hs.chain(ls)
    });
    for (e, title, err) in errors.take(40) {
        let _ = writeln!(r, "  {} {} {} · {title}: {err}", date(e.played_ts), e.map, e.id);
    }
}
