//! 3D replays without CS2: the map comes from the user's own CS2 install (read with Source 2
//! Viewer, a free open-source tool downloaded once), the movement from the demo. Also "Watch in
//! CS2": the demo opened in the game itself, when the user asks.

use crate::settings::data_dir;
use anyhow::{bail, Context, Result};
use serde::Serialize;
use std::io::{Read, Write};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

/// Source 2 Viewer's command-line build (ValveResourceFormat, MIT), pinned.
const S2V_VERSION: &str = "20.1";
const S2V_URL: &str = "https://github.com/ValveResourceFormat/ValveResourceFormat/releases/download/20.1/cli-windows-x64.zip";
const S2V_SIZE: u64 = 52_773_073;
/// Bumped when map preparation changes: maps are prepared again.
const MAP_VERSION: u32 = 1;
const NO_WINDOW: u32 = 0x0800_0000;

/// A map or a 3D replay is being prepared: the background work waits meanwhile.
static BUSY: AtomicBool = AtomicBool::new(false);

pub fn busy() -> bool {
    BUSY.load(Ordering::SeqCst)
}

fn tool_exe() -> PathBuf {
    data_dir().join("tools").join(format!("s2v-{S2V_VERSION}")).join("Source2Viewer-CLI.exe")
}

pub fn map_dir(lib: &Path, map: &str) -> PathBuf {
    lib.join("maps3d").join(map)
}

pub fn map_ready(lib: &Path, map: &str) -> bool {
    std::fs::read_to_string(map_dir(lib, map).join("ready.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .is_some_and(|v| v["version"].as_u64() == Some(MAP_VERSION as u64))
}

fn map_vpk(map: &str) -> Option<PathBuf> {
    if !map.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return None;
    }
    let vpk = cs2hl_render::steam::cs2_csgo_dir().ok()?.join("maps").join(format!("{map}.vpk"));
    vpk.exists().then_some(vpk)
}

#[derive(Serialize)]
pub struct State {
    pub map: String,
    /// The map is one of CS2's own (its file is in the CS2 install).
    pub supported: bool,
    pub tool: bool,
    pub map_ready: bool,
    pub track_ready: bool,
    /// The demo is still on disk (needed for the track and for Watch in CS2).
    pub demo: bool,
    pub busy: bool,
}

pub fn state(lib: &Path, id: &str) -> Result<State> {
    let m = entry(lib, id)?;
    Ok(State {
        supported: map_vpk(&m.map).is_some(),
        tool: tool_exe().exists(),
        map_ready: map_ready(lib, &m.map),
        track_ready: cs2hl_core::replay3d::current(lib, id),
        demo: Path::new(&m.demo_path).exists(),
        busy: busy(),
        map: m.map,
    })
}

fn entry(lib: &Path, id: &str) -> Result<cs2hl_core::library::MatchEntry> {
    if !id.chars().all(|c| c.is_ascii_alphanumeric() || "-_".contains(c)) {
        bail!("not a match id");
    }
    let t = std::fs::read_to_string(lib.join("matches").join(format!("{id}.json"))).context("this match isn't in the library")?;
    Ok(serde_json::from_str(&t)?)
}

/// Everything the 3D replay of this match needs, made where missing: the tool (downloaded once),
/// the map (once per map, about a minute) and the match's movement (a few seconds).
/// `step(what, done 0..1)` reports progress.
pub fn prepare(lib: &Path, id: &str, step: &dyn Fn(&str, f32)) -> Result<()> {
    if BUSY.swap(true, Ordering::SeqCst) {
        bail!("Already preparing a 3D replay");
    }
    let r = (|| {
        let m = entry(lib, id)?;
        if map_vpk(&m.map).is_none() {
            bail!("3D replays work on CS2's own maps; {} isn't one of them (or CS2 isn't installed)", m.map);
        }
        if !tool_exe().exists() {
            get_tool(&|done, total| step("Downloading Source 2 Viewer (once)", if total > 0 { done as f32 / total as f32 } else { 0.0 }))?;
        }
        if !map_ready(lib, &m.map) {
            step(&format!("Preparing {} in 3D (about a minute, once per map)", nice_map(&m.map)), 0.0);
            prepare_map(lib, &m.map)?;
        }
        if !cs2hl_core::replay3d::current(lib, id) {
            step("Reading the demo", 0.0);
            let demo = cs2hl_core::demo_io::read_demo(Path::new(&m.demo_path)).context("this match's demo is gone (deleted to save space?)")?;
            let model = cs2hl_core::model::load_match(&demo)?;
            cs2hl_core::replay3d::write(lib, id, &demo, &model)?;
        }
        step("Ready", 1.0);
        Ok(())
    })();
    BUSY.store(false, Ordering::SeqCst);
    r
}

fn nice_map(map: &str) -> String {
    let s = map.trim_start_matches("de_").trim_start_matches("cs_");
    let mut c = s.chars();
    c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
}

/// Downloads Source 2 Viewer's command-line build and unpacks it next to Veloxify's data.
fn get_tool(progress: &dyn Fn(u64, u64)) -> Result<()> {
    let dir = tool_exe().parent().unwrap().to_path_buf();
    std::fs::create_dir_all(&dir)?;
    let zip = dir.with_extension("zip.part");
    let agent = ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(10)).timeout_read(Duration::from_secs(60)).build();
    let mut reader = agent.get(S2V_URL).call()?.into_reader();
    let mut file = std::fs::File::create(&zip)?;
    let (mut buf, mut done, mut shown) = (vec![0u8; 1 << 16], 0u64, Instant::now());
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n])?;
        done += n as u64;
        if shown.elapsed() > Duration::from_millis(200) {
            progress(done, S2V_SIZE);
            shown = Instant::now();
        }
    }
    drop(file);
    if done != S2V_SIZE {
        let _ = std::fs::remove_file(&zip);
        bail!("Source 2 Viewer's download was cut short ({done} of {S2V_SIZE} bytes)");
    }
    // Windows' own tar unpacks zip files.
    let tar = PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into())).join("System32").join("tar.exe");
    let ok = Command::new(tar).arg("-xf").arg(&zip).arg("-C").arg(&dir).creation_flags(NO_WINDOW).status()?.success();
    let _ = std::fs::remove_file(&zip);
    if !ok || !tool_exe().exists() {
        bail!("couldn't unpack Source 2 Viewer");
    }
    Ok(())
}

fn run_tool(args: &[&std::ffi::OsStr]) -> Result<()> {
    let out = Command::new(tool_exe()).args(args).creation_flags(NO_WINDOW).output().context("running Source 2 Viewer")?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let tail: String = err.lines().rev().take(4).collect::<Vec<_>>().join(" / ");
        bail!("Source 2 Viewer failed: {tail}");
    }
    Ok(())
}

/// The map's world (with its textures) and its baked lighting, from the CS2 install, in
/// `library/maps3d/<map>/`: `world.glb`, the color textures it uses, `irradiance.hdr`.
fn prepare_map(lib: &Path, map: &str) -> Result<()> {
    let vpk = map_vpk(map).context("map file not found")?;
    let csgo = cs2hl_render::steam::cs2_csgo_dir()?;
    let dir = map_dir(lib, map);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir)?;
    let world = format!("maps/{map}/world.vwrld_c");
    let gameinfo = csgo.join("gameinfo.gi");
    run_tool(&[
        "-i".as_ref(),
        vpk.as_os_str(),
        "--vpk_filepath".as_ref(),
        world.as_ref(),
        "--game".as_ref(),
        gameinfo.as_os_str(),
        "-o".as_ref(),
        dir.join("world").as_os_str(),
        "--gltf_export_format".as_ref(),
        "glb".as_ref(),
        "--gltf_export_materials".as_ref(),
        "--gltf_textures_adapt".as_ref(),
        "-d".as_ref(),
    ])?;
    // The baked lighting (bounced light): CS2 keeps it as one big HDR image.
    let lm = dir.join("lm");
    let irr = format!("maps/{map}/lightmaps/irradiance.vtex_c");
    run_tool(&["-i".as_ref(), vpk.as_os_str(), "--vpk_filepath".as_ref(), irr.as_ref(), "-d".as_ref(), "-o".as_ref(), lm.join("irradiance").as_os_str()])?;
    // Usually `irradiance.exr` (the tool may also leave the extension off): the folder holds only it.
    let exr = find_ext(&lm, "exr").or_else(|| first_file(&lm)).context("no baked lighting in the map")?;
    let ok = Command::new(cs2hl_render::assemble::ffmpeg_exe())
        .args(["-hide_banner", "-loglevel", "error", "-y", "-i"])
        .arg(&exr)
        .args(["-vf", "scale=4096:4096:flags=area,format=gbrpf32le", "-c:v", "hdr"])
        .arg(dir.join("irradiance.hdr"))
        .creation_flags(NO_WINDOW)
        .status()?
        .success();
    let _ = std::fs::remove_dir_all(&lm);
    if !ok {
        bail!("couldn't convert the map's lighting");
    }
    let _ = std::fs::remove_file(dir.join("world_physics.glb"));
    trim(&dir.join("world.glb"))?;
    std::fs::write(dir.join("ready.json"), serde_json::json!({ "version": MAP_VERSION, "map": map, "s2v": S2V_VERSION }).to_string())?;
    Ok(())
}

/// The first file with this extension under `dir` (any depth).
fn find_ext(dir: &Path, ext: &str) -> Option<PathBuf> {
    for e in std::fs::read_dir(dir).ok()?.flatten() {
        let p = e.path();
        if p.is_dir() {
            if let Some(f) = find_ext(&p, ext) {
                return Some(f);
            }
        } else if p.extension().is_some_and(|x| x == ext) {
            return Some(p);
        }
    }
    None
}

fn first_file(dir: &Path) -> Option<PathBuf> {
    for e in std::fs::read_dir(dir).ok()?.flatten() {
        let p = e.path();
        if p.is_dir() {
            if let Some(f) = first_file(&p) {
                return Some(f);
            }
        } else {
            return Some(p);
        }
    }
    None
}

/// The viewer only draws color (and glow) textures: the others (normal, roughness, occlusion
/// maps) are dropped from the model and deleted, which saves loading time and disk.
fn trim(glb: &Path) -> Result<()> {
    let bytes = std::fs::read(glb)?;
    if bytes.len() < 20 || &bytes[..4] != b"glTF" {
        bail!("not a glb file");
    }
    let json_len = u32::from_le_bytes(bytes[12..16].try_into()?) as usize;
    let mut j: serde_json::Value = serde_json::from_slice(&bytes[20..20 + json_len])?;
    let rest = &bytes[20 + json_len..];
    let mut used = std::collections::HashSet::new();
    if let Some(mats) = j["materials"].as_array_mut() {
        for m in mats {
            if let Some(o) = m.as_object_mut() {
                o.remove("normalTexture");
                o.remove("occlusionTexture");
                if let Some(p) = o.get_mut("pbrMetallicRoughness").and_then(|p| p.as_object_mut()) {
                    p.remove("metallicRoughnessTexture");
                }
            }
            for key in ["emissiveTexture"] {
                if let Some(i) = m[key]["index"].as_u64() {
                    used.insert(i);
                }
            }
            if let Some(i) = m["pbrMetallicRoughness"]["baseColorTexture"]["index"].as_u64() {
                used.insert(i);
            }
        }
    }
    let keep: std::collections::HashSet<String> = used
        .iter()
        .filter_map(|&t| j["textures"][t as usize]["source"].as_u64())
        .filter_map(|i| j["images"][i as usize]["uri"].as_str().map(str::to_string))
        .collect();
    let dir = glb.parent().unwrap();
    for e in std::fs::read_dir(dir)?.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.ends_with(".png") && !keep.contains(&name) {
            let _ = std::fs::remove_file(e.path());
        }
    }
    let mut json = serde_json::to_vec(&j)?;
    while json.len() % 4 != 0 {
        json.push(b' ');
    }
    let total = 12 + 8 + json.len() + rest.len();
    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(b"glTF");
    out.extend_from_slice(&2u32.to_le_bytes());
    out.extend_from_slice(&(total as u32).to_le_bytes());
    out.extend_from_slice(&(json.len() as u32).to_le_bytes());
    out.extend_from_slice(b"JSON");
    out.extend_from_slice(&json);
    out.extend_from_slice(rest);
    let tmp = glb.with_extension("glb.tmp");
    std::fs::write(&tmp, out)?;
    std::fs::rename(tmp, glb)?;
    Ok(())
}

/// Opens the match's demo in CS2 itself (the user asked): CS2 starts normally (their own settings,
/// not Veloxify's filming setup) and plays it. When CS2 is already open, the console command to
/// paste is returned instead.
pub fn watch_in_cs2(lib: &Path, id: &str) -> Result<Option<String>> {
    let m = entry(lib, id)?;
    let src = Path::new(&m.demo_path);
    if !src.exists() {
        bail!("this match's demo is gone (deleted to save space?)");
    }
    // CS2 plays plain .dem files: compressed ones (FACEIT, Valve) are unpacked first.
    let dem = if src.extension().is_some_and(|e| e == "dem") {
        src.to_path_buf()
    } else {
        let dir = data_dir().join("work").join("watch");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir)?;
        let out = dir.join(format!("{id}.dem"));
        std::fs::write(&out, cs2hl_core::demo_io::read_demo(src)?)?;
        out
    };
    // A path with spaces doesn't survive the trip through Steam: then it goes in CS2's folder.
    let (path_arg, shown) = if dem.to_string_lossy().contains(' ') {
        let csgo = cs2hl_render::steam::cs2_csgo_dir()?;
        std::fs::copy(&dem, csgo.join("veloxify_watch.dem"))?;
        ("veloxify_watch".to_string(), "veloxify_watch".to_string())
    } else {
        (dem.display().to_string(), format!("\"{}\"", dem.display()))
    };
    if crate::system::cs2_running() {
        return Ok(Some(format!("playdemo {shown}")));
    }
    let exe = cs2hl_render::steam::steam_exe();
    if Command::new(&exe).args(["-applaunch", "730", "+playdemo", &path_arg]).spawn().is_err() {
        Command::new("explorer.exe").arg(format!("steam://run/730//+playdemo {path_arg}/")).spawn().context("starting CS2 through Steam")?;
    }
    Ok(None)
}
