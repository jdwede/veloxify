//! 3D replays without CS2: the map comes from the user's own CS2 install (read with Source 2
//! Viewer, a free open-source tool downloaded once), the movement from the demo. Also "Watch in
//! CS2": the demo opened in the game itself, when the user asks.

use crate::settings::data_dir;
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
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
const MAP_VERSION: u32 = 2;
/// Material textures the viewer draws besides the color: a blended surface's second layer and the
/// pattern the two layers blend by.
const LAYER_TEXTURES: [&str; 2] = ["g_tLayer2Color", "g_tBlendModulation"];
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
    /// The players' models (agents, animations, the guns this match uses) are ready.
    pub models_ready: bool,
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
        models_ready: models_missing(lib, id).is_empty() && ModelIndex::load(lib).version == MODELS_VERSION,
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
        if ModelIndex::load(lib).version != MODELS_VERSION || !models_missing(lib, id).is_empty() {
            step("Preparing the players and their guns", 0.0);
            prepare_models(lib, id)?;
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
    layer_textures(&vpk_or_pak(&csgo), &gameinfo, &dir, &dir.join("world.glb"))?;
    trim(&dir.join("world.glb"))?;
    std::fs::write(dir.join("ready.json"), serde_json::json!({ "version": MAP_VERSION, "map": map, "s2v": S2V_VERSION }).to_string())?;
    Ok(())
}

/// CS2's main file package (materials and textures live there, not in the map's own file).
fn vpk_or_pak(csgo: &Path) -> PathBuf {
    csgo.join("pak01_dir.vpk")
}

/// The second-layer colors and blend patterns of the world's blended materials, as PNGs next to
/// the model (the model export only writes the textures a glTF material uses).
fn layer_textures(pak: &Path, gameinfo: &Path, dir: &Path, glb: &Path) -> Result<()> {
    let bytes = std::fs::read(glb)?;
    if bytes.len() < 20 {
        return Ok(());
    }
    let json_len = u32::from_le_bytes(bytes[12..16].try_into()?) as usize;
    let j: serde_json::Value = serde_json::from_slice(&bytes[20..20 + json_len])?;
    let mut want: Vec<String> = vec![];
    for m in j["materials"].as_array().into_iter().flatten() {
        for key in LAYER_TEXTURES {
            if let Some(vtex) = m["extras"]["vmat"]["TextureParams"][key].as_str() {
                let png = Path::new(vtex).file_stem().map(|s| format!("{}.png", s.to_string_lossy())).unwrap_or_default();
                if !png.is_empty() && !dir.join(&png).exists() && !want.contains(&format!("{vtex}_c")) {
                    want.push(format!("{vtex}_c"));
                }
            }
        }
    }
    if want.is_empty() {
        return Ok(());
    }
    let tmp = dir.join("layers");
    let filter = want.join(",");
    let _ = run_tool(&["-i".as_ref(), pak.as_os_str(), "--vpk_filepath".as_ref(), filter.as_ref(), "--game".as_ref(), gameinfo.as_os_str(), "-d".as_ref(), "-o".as_ref(), tmp.as_os_str()]);
    // Flatten: materials/.../name.png → name.png beside the model.
    fn pngs(d: &Path, out: &mut Vec<PathBuf>) {
        for e in std::fs::read_dir(d).into_iter().flatten().flatten() {
            let p = e.path();
            if p.is_dir() {
                pngs(&p, out);
            } else if p.extension().is_some_and(|x| x == "png") {
                out.push(p);
            }
        }
    }
    let mut found = vec![];
    pngs(&tmp, &mut found);
    for p in found {
        if let Some(name) = p.file_name() {
            let _ = std::fs::rename(&p, dir.join(name));
        }
    }
    let _ = std::fs::remove_dir_all(&tmp);
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
    let mut keep_extra = std::collections::HashSet::new();
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
            for key in LAYER_TEXTURES {
                if let Some(png) = m["extras"]["vmat"]["TextureParams"][key].as_str().and_then(|v| Path::new(v).file_stem()) {
                    keep_extra.insert(format!("{}.png", png.to_string_lossy()));
                }
            }
        }
    }
    let mut keep: std::collections::HashSet<String> = used
        .iter()
        .filter_map(|&t| j["textures"][t as usize]["source"].as_u64())
        .filter_map(|i| j["images"][i as usize]["uri"].as_str().map(str::to_string))
        .collect();
    keep.extend(keep_extra);
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

// ---- players: agents, their animations and guns, from CS2's own files -----------------------------

/// Bumped when the players' models change: they're prepared again.
const MODELS_VERSION: u32 = 3;
/// First-person clips besides the idle one: what each is called in a weapon's folder.
const FP_CLIPS: [&str; 3] = ["shoot1", "reload", "draw"];
/// The agents players are shown as (CS2's defaults), by side.
const AGENTS: [(&str, &str); 2] = [("CT", "agents/models/ctm_sas/ctm_sas.vmdl_c"), ("T", "agents/models/tm_phoenix/tm_phoenix.vmdl_c")];
/// Animation sets (by what's held) and the clips used from each.
const CLIP_SETS: [&str; 3] = ["rifle", "pistol", "knife"];
const CLIPS: [&str; 15] = ["idle", "idle_crouch", "run_n", "run_e", "run_s", "run_w", "walk_n", "walk_e", "walk_s", "walk_w", "crouch_n", "crouch_e", "crouch_s", "crouch_w", "inair_stand"];
/// Textures of players and guns are made at most this big (they're small on screen).
const MODEL_TEXTURE_MAX: u32 = 1024;

/// What's been prepared (`library/models3d/index.json`); paths are relative to `models3d/`.
#[derive(Serialize, Deserialize, Default)]
pub struct ModelIndex {
    pub version: u32,
    /// Side ("CT", "T") → its agent.
    pub agents: BTreeMap<String, AgentFiles>,
    /// Set ("rifle", ...) → clip name ("run_n", ...) → file.
    pub anims: BTreeMap<String, BTreeMap<String, String>>,
    /// Weapon (as the 2D replay names it: "ak47", "knife_default_ct", ...) → model file.
    pub weapons: BTreeMap<String, String>,
    /// Weapon → its first-person (viewmodel) idle clip: the arms' skeleton and pose.
    #[serde(default)]
    pub firstperson: BTreeMap<String, String>,
    /// Weapon → its other first-person clips ("shoot1", "reload", "draw") → file.
    #[serde(default)]
    pub firstperson_clips: BTreeMap<String, BTreeMap<String, String>>,
}

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct AgentFiles {
    pub model: String,
    pub bones: String,
}

impl ModelIndex {
    fn load(lib: &Path) -> ModelIndex {
        std::fs::read_to_string(lib.join("models3d").join("index.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    }
    fn save(&self, lib: &Path) -> Result<()> {
        Ok(std::fs::write(lib.join("models3d").join("index.json"), serde_json::to_string_pretty(self)?)?)
    }
}

/// The guns (and knives, grenades, the bomb) this match's players held that aren't prepared yet.
fn models_missing(lib: &Path, id: &str) -> Vec<String> {
    let have = ModelIndex::load(lib).weapons;
    let mut want: Vec<String> = cs2hl_core::details::load_replay(lib, id).map(|r| r.weapons).unwrap_or_default();
    want.extend(["knife_default_ct".to_string(), "knife_default_t".to_string()]);
    want.retain(|w| !w.is_empty() && !matches!(w.as_str(), "knife" | "inferno" | "world" | "planted_c4") && !have.contains_key(w));
    want.sort();
    want.dedup();
    want
}

/// The model file for a weapon name, found in CS2's file list.
fn weapon_model(list: &[String], name: &str) -> Option<String> {
    let fixed = |p: &str| list.iter().any(|x| x == p).then(|| p.to_string());
    match name {
        "flashbang" => return fixed("weapons/models/grenade/flashbang/weapon_flashbang.vmdl_c"),
        "hegrenade" => return fixed("weapons/models/grenade/hegrenade/weapon_hegrenade.vmdl_c"),
        "smokegrenade" => return fixed("weapons/models/grenade/smokegrenade/weapon_smokegrenade.vmdl_c"),
        "molotov" => return fixed("weapons/models/grenade/molotov/weapon_molotov.vmdl_c"),
        "incgrenade" => return fixed("weapons/models/grenade/incendiary/weapon_incendiarygrenade.vmdl_c"),
        "decoy" => return fixed("weapons/models/grenade/decoy/weapon_decoy.vmdl_c"),
        "c4" => return fixed("weapons/models/c4/weapon_c4.vmdl_c"),
        _ => {}
    }
    // Knives: "bayonet", "knife_karambit", ... (some go by an older name in game).
    let knife = match name {
        "bayonet" => Some("knife_bayonet".to_string()),
        "knife_widowmaker" => Some("knife_talon".into()),
        "knife_survival_bowie" => Some("knife_bowie".into()),
        "knife_gypsy_jackknife" => Some("knife_navaja".into()),
        "knife_m9_bayonet" => Some("knife_m9".into()),
        n if n.starts_with("knife_") => Some(n.to_string()),
        _ => None,
    };
    if let Some(k) = knife {
        return fixed(&format!("weapons/models/knife/{k}/weapon_{k}.vmdl_c"));
    }
    let dir = match name {
        "glock" => "glock18",
        "m4a1" => "m4a4",
        n => n,
    };
    // Guns: weapons/models/<dir>/weapon_<class>_<dir>.vmdl_c.
    let prefix = format!("weapons/models/{dir}/weapon_");
    let suffix = format!("_{dir}.vmdl_c");
    list.iter().find(|x| x.starts_with(&prefix) && x.ends_with(&suffix) && !x[prefix.len()..].contains('/')).cloned()
}

/// A weapon's first-person idle clip (its own, else its kind's default), from CS2's file list.
fn firstperson_clip(list: &[String], name: &str) -> Option<String> {
    const BASE: &str = "animation/anims/viewmodel/";
    // The idle clip in a folder: "idle_<x>" (not "idle_slide_back", not "idles").
    let idle_in = |folder: &str| -> Option<String> {
        let prefix = format!("{BASE}{folder}/idle_");
        list.iter().filter(|x| x.starts_with(&prefix) && x.ends_with(".vnmclip_c") && !x[prefix.len()..].contains('/')).min_by_key(|x| x.len()).cloned()
    };
    let grenade = match name {
        "flashbang" => Some("grenade/grenade_flashbang"),
        "hegrenade" => Some("grenade/grenade_hegrenade"),
        "smokegrenade" => Some("grenade/grenade_smokegrenade"),
        "molotov" => Some("grenade/grenade_molotov"),
        "incgrenade" => Some("grenade/grenade_incendiary"),
        "decoy" => Some("grenade/_default_grenade"),
        "c4" => Some("equipment/c4"),
        _ => None,
    };
    if let Some(g) = grenade {
        return idle_in(g).or_else(|| idle_in("grenade/_default_grenade"));
    }
    if name.starts_with("knife") || name == "bayonet" {
        let k = match name {
            "bayonet" => "knife_bayonet".to_string(),
            "knife_widowmaker" => "knife_talon".into(),
            "knife_survival_bowie" => "knife_bowie".into(),
            "knife_gypsy_jackknife" => "knife_navaja".into(),
            "knife_m9_bayonet" => "knife_m9".into(),
            "knife_default_ct" => "_default_knife".into(),
            n => n.to_string(),
        };
        return idle_in(&format!("knife/{k}")).or_else(|| idle_in("knife/_default_knife"));
    }
    let pistol = matches!(name, "glock" | "usp_silencer" | "hkp2000" | "p250" | "fiveseven" | "tec9" | "cz75a" | "deagle" | "revolver" | "elite" | "taser");
    let kind = if pistol { "pistol" } else { "rifle" };
    // Folder names: rifle_ak, rifle_m4a4, pistol_glock18, ...
    let mut names = vec![name.to_string(), name.replace("47", "")];
    names.push(match name { "glock" => "glock18".into(), "m4a1" => "m4a4".into(), n => n.to_string() });
    names.iter().find_map(|n| idle_in(&format!("{kind}/{kind}_{n}"))).or_else(|| idle_in(&format!("{kind}/_default_{kind}")))
}

/// The other first-person clips next to an idle clip (same folder): shooting, reloading, drawing.
fn firstperson_extras(list: &[String], idle: &str) -> Vec<(&'static str, String)> {
    let Some(folder) = idle.rsplit_once('/').map(|(f, _)| f) else { return vec![] };
    FP_CLIPS
        .iter()
        .filter_map(|kind| {
            let prefix = format!("{folder}/{kind}_");
            // The plain one ("reload_ak", not "reload_empty_..."; "draw_pistol", not "draw_silenced_pistol").
            let c = list.iter().filter(|x| x.starts_with(&prefix) && x.ends_with(".vnmclip_c") && !x[prefix.len()..].contains('/')).min_by_key(|x| x.len())?;
            Some((*kind, c.clone()))
        })
        .collect()
}

/// The agents (with their bones), the animations and the guns this match uses, in `models3d/`.
fn prepare_models(lib: &Path, id: &str) -> Result<()> {
    let csgo = cs2hl_render::steam::cs2_csgo_dir()?;
    let pak = csgo.join("pak01_dir.vpk");
    let gameinfo = csgo.join("gameinfo.gi");
    let dir = lib.join("models3d");
    std::fs::create_dir_all(&dir)?;
    let mut index = ModelIndex::load(lib);
    if index.version != MODELS_VERSION {
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir)?;
        index = ModelIndex { version: MODELS_VERSION, ..Default::default() };
    }
    let list = vpk_list(&pak)?;
    let mut export: Vec<String> = vec![];
    if index.agents.is_empty() {
        export.extend(AGENTS.iter().map(|(_, p)| p.to_string()));
    }
    let clip_path = |set: &str, clip: &str| format!("animation/anims/world/{set}/_default_{set}/{clip}_{set}.vnmclip_c");
    if index.anims.is_empty() {
        for set in CLIP_SETS {
            for clip in CLIPS {
                let p = clip_path(set, clip);
                if list.contains(&p) {
                    export.push(p);
                }
            }
        }
    }
    let mut guns = vec![];
    let mut firsts = vec![];
    for name in models_missing(lib, id) {
        if let Some(p) = weapon_model(&list, &name) {
            export.push(p.clone());
            guns.push((name.clone(), p));
        }
        if let Some(c) = firstperson_clip(&list, &name) {
            let extras = firstperson_extras(&list, &c);
            for p in std::iter::once(&c).chain(extras.iter().map(|(_, p)| p)) {
                if !export.contains(p) {
                    export.push(p.clone());
                }
            }
            firsts.push((name, c, extras));
        }
    }
    if !export.is_empty() {
        let filter = export.join(",");
        run_tool(&[
            "-i".as_ref(),
            pak.as_os_str(),
            "--vpk_filepath".as_ref(),
            filter.as_ref(),
            "--game".as_ref(),
            gameinfo.as_os_str(),
            "-o".as_ref(),
            dir.as_os_str(),
            "--gltf_export_format".as_ref(),
            "glb".as_ref(),
            "--gltf_export_materials".as_ref(),
            "--gltf_textures_adapt".as_ref(),
            "-d".as_ref(),
        ])?;
    }
    let glb_of = |vpk_path: &str| vpk_path.trim_end_matches(".vmdl_c").trim_end_matches(".vnmclip_c").to_string() + ".glb";
    let finish = |rel: &str| -> Result<()> {
        let glb = dir.join(rel);
        if !glb.exists() {
            bail!("Source 2 Viewer didn't make {rel}");
        }
        let _ = std::fs::remove_file(glb.with_file_name(format!("{}_physics.glb", glb.file_stem().unwrap().to_string_lossy())));
        trim(&glb)?;
        shrink_textures(glb.parent().unwrap(), MODEL_TEXTURE_MAX);
        Ok(())
    };
    if index.agents.is_empty() {
        for (side, vmdl) in AGENTS {
            let model = glb_of(vmdl);
            finish(&model)?;
            let bones = model.replace(".glb", "_bones.json");
            std::fs::write(dir.join(&bones), agent_bones(&pak, vmdl)?.to_string())?;
            index.agents.insert(side.to_string(), AgentFiles { model, bones });
        }
    }
    if index.anims.is_empty() {
        for set in CLIP_SETS {
            let mut clips = BTreeMap::new();
            for clip in CLIPS {
                let rel = glb_of(&clip_path(set, clip));
                if dir.join(&rel).exists() {
                    clips.insert(clip.to_string(), rel);
                }
            }
            index.anims.insert(set.to_string(), clips);
        }
    }
    for (name, vmdl) in guns {
        let rel = glb_of(&vmdl);
        if finish(&rel).is_ok() {
            index.weapons.insert(name, rel);
        }
    }
    for (name, clip, extras) in firsts {
        let rel = glb_of(&clip);
        if dir.join(&rel).exists() {
            index.firstperson.insert(name.clone(), rel);
            let clips: BTreeMap<String, String> = extras.into_iter().map(|(k, p)| (k.to_string(), glb_of(&p))).filter(|(_, r)| dir.join(r).exists()).collect();
            index.firstperson_clips.insert(name, clips);
        }
    }
    index.save(lib)
}

/// Every file in a VPK (Source 2 Viewer's listing).
fn vpk_list(vpk: &Path) -> Result<Vec<String>> {
    let out = Command::new(tool_exe()).arg("-i").arg(vpk).arg("-l").creation_flags(NO_WINDOW).output().context("listing CS2's files")?;
    Ok(String::from_utf8_lossy(&out.stdout).lines().filter_map(|l| l.split(" CRC:").next()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect())
}

/// An agent's own bones (names and parents, in its meshes' numbering), from its model data: the
/// viewer links them to CS2's animation skeleton by name.
fn agent_bones(vpk: &Path, vmdl: &str) -> Result<serde_json::Value> {
    let out = Command::new(tool_exe()).arg("-i").arg(vpk).args(["--vpk_filepath", vmdl, "-b", "DATA"]).creation_flags(NO_WINDOW).output().context("reading the agent's bones")?;
    let text = String::from_utf8_lossy(&out.stdout);
    let sk = text.find("m_modelSkeleton").map(|i| &text[i..]).context("the agent has no skeleton")?;
    let array = |name: &str| -> Option<&str> {
        let i = sk.find(&format!("{name} = "))?;
        let a = i + sk[i..].find('[')?;
        let b = a + sk[a..].find(']')?;
        Some(&sk[a + 1..b])
    };
    let names: Vec<String> = array("m_boneName").context("no bone names")?.split('"').skip(1).step_by(2).map(str::to_string).collect();
    let parents: Vec<i32> = array("m_nParent").context("no bone parents")?.split(|c: char| c == ',' || c.is_whitespace()).filter_map(|x| x.trim().parse().ok()).collect();
    if names.is_empty() || names.len() != parents.len() {
        bail!("the agent's bones didn't read right ({} names, {} parents)", names.len(), parents.len());
    }
    Ok(serde_json::json!({ "names": names, "parents": parents }))
}

/// Textures bigger than `max` across are scaled down (in place).
fn shrink_textures(dir: &Path, max: u32) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        if p.extension().is_none_or(|x| x != "png") || e.metadata().map(|m| m.len()).unwrap_or(0) < 1_500_000 {
            continue;
        }
        let tmp = p.with_extension("small.png");
        let ok = Command::new(cs2hl_render::assemble::ffmpeg_exe())
            .args(["-hide_banner", "-loglevel", "error", "-y", "-i"])
            .arg(&p)
            .args(["-vf", &format!("scale='min({max},iw)':-2")])
            .arg(&tmp)
            .creation_flags(NO_WINDOW)
            .status()
            .is_ok_and(|s| s.success());
        if ok {
            let _ = std::fs::rename(&tmp, &p);
        } else {
            let _ = std::fs::remove_file(&tmp);
        }
    }
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
