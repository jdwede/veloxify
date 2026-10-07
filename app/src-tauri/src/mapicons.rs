//! Map emblems and weapon silhouettes (the icons CS2's own menus use), taken from the CS2 install
//! on this PC: `panorama/images/map_icons/map_icon_<map>.vsvg_c` and
//! `panorama/images/icons/equipment/<weapon>.vsvg_c` inside `pak01_dir.vpk`. Those files are
//! compiled resources that carry the original SVG text, which is written out as
//! `library/maps/<map>.svg` and `library/weapons/<weapon>.svg`.

use anyhow::{bail, Context, Result};
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::Path;

const PREFIX: &str = "panorama/images/map_icons";
const WEAPONS: &str = "panorama/images/icons/equipment";

struct Entry {
    name: String,
    archive: u16,
    offset: u32,
    length: u32,
    preload: Vec<u8>,
}

fn cstr(r: &mut impl BufRead) -> Result<String> {
    let mut b = vec![];
    r.read_until(0, &mut b)?;
    if b.last() == Some(&0) {
        b.pop();
    }
    Ok(String::from_utf8_lossy(&b).into_owned())
}

fn u16le(r: &mut impl Read) -> Result<u16> {
    let mut b = [0; 2];
    r.read_exact(&mut b)?;
    Ok(u16::from_le_bytes(b))
}

fn u32le(r: &mut impl Read) -> Result<u32> {
    let mut b = [0; 4];
    r.read_exact(&mut b)?;
    Ok(u32::from_le_bytes(b))
}

/// SVG entries (`.vsvg_c`) in a VPK directory file that `want(path, name)` picks, plus where its
/// embedded data starts.
fn icon_entries(dir_vpk: &Path, want: impl Fn(&str, &str) -> bool) -> Result<(Vec<Entry>, u64)> {
    let mut r = BufReader::new(File::open(dir_vpk)?);
    if u32le(&mut r)? != 0x55AA_1234 {
        bail!("not a VPK file");
    }
    let version = u32le(&mut r)?;
    let tree = u32le(&mut r)?;
    if version == 2 {
        r.seek_relative(16)?;
    }
    let data_start = r.stream_position()? + tree as u64;
    let mut out = vec![];
    loop {
        let ext = cstr(&mut r)?;
        if ext.is_empty() {
            break;
        }
        loop {
            let path = cstr(&mut r)?;
            if path.is_empty() {
                break;
            }
            loop {
                let name = cstr(&mut r)?;
                if name.is_empty() {
                    break;
                }
                let _crc = u32le(&mut r)?;
                let preload_len = u16le(&mut r)?;
                let archive = u16le(&mut r)?;
                let offset = u32le(&mut r)?;
                let length = u32le(&mut r)?;
                let _end = u16le(&mut r)?;
                let mut preload = vec![0; preload_len as usize];
                r.read_exact(&mut preload)?;
                if ext == "vsvg_c" && want(&path, &name) {
                    out.push(Entry { name, archive, offset, length, preload });
                }
            }
        }
    }
    Ok((out, data_start))
}

fn read_entry(dir_vpk: &Path, e: &Entry, data_start: u64) -> Result<Vec<u8>> {
    let (path, offset) = if e.archive == 0x7FFF {
        (dir_vpk.to_path_buf(), data_start + e.offset as u64)
    } else {
        let stem = dir_vpk.to_string_lossy();
        let base = stem.strip_suffix("_dir.vpk").context("VPK name")?;
        (format!("{base}_{:03}.vpk", e.archive).into(), e.offset as u64)
    };
    let mut f = File::open(path)?;
    f.seek(SeekFrom::Start(offset))?;
    let mut data = e.preload.clone();
    let start = data.len();
    data.resize(start + e.length as usize, 0);
    f.read_exact(&mut data[start..])?;
    Ok(data)
}

/// Writes `maps/<map>.svg` for every map CS2 ships an emblem for. Returns how many were written.
pub fn extract(library: &Path) -> Result<usize> {
    let vpk = cs2hl_render::steam::cs2_csgo_dir()?.join("pak01_dir.vpk");
    let (entries, data_start) = icon_entries(&vpk, |p, n| p == PREFIX && n.starts_with("map_icon_"))?;
    let out = library.join("maps");
    std::fs::create_dir_all(&out)?;
    let mut n = 0;
    for e in &entries {
        let map = e.name.trim_start_matches("map_icon_");
        if !(map.starts_with("de_") || map.starts_with("cs_") || map.starts_with("ar_")) {
            continue;
        }
        let data = read_entry(&vpk, e, data_start)?;
        let text = String::from_utf8_lossy(&data);
        let (Some(a), Some(b)) = (text.find("<svg"), text.rfind("</svg>")) else { continue };
        std::fs::write(out.join(format!("{map}.svg")), &text[a..b + 6])?;
        n += 1;
    }
    Ok(n)
}

/// Writes `weapons/<weapon>.svg` for every equipment icon (ak47, awp, knife_karambit, ...).
pub fn extract_weapons(library: &Path) -> Result<usize> {
    let vpk = cs2hl_render::steam::cs2_csgo_dir()?.join("pak01_dir.vpk");
    let (entries, data_start) = icon_entries(&vpk, |p, _| p == WEAPONS)?;
    let out = library.join("weapons");
    std::fs::create_dir_all(&out)?;
    let mut n = 0;
    for e in &entries {
        let data = read_entry(&vpk, e, data_start)?;
        let text = String::from_utf8_lossy(&data);
        let (Some(a), Some(b)) = (text.find("<svg"), text.rfind("</svg>")) else { continue };
        std::fs::write(out.join(format!("{}.svg", e.name)), &text[a..b + 6])?;
        n += 1;
    }
    Ok(n)
}

/// Extracts the weapon icons once (again after CS2 updates).
pub fn ensure_weapons(library: &Path) {
    let dir = library.join("weapons");
    let stamp = cs2hl_render::steam::cs2_csgo_dir()
        .ok()
        .and_then(|d| std::fs::metadata(d.join("pak01_dir.vpk")).ok())
        .and_then(|m| m.modified().ok())
        .map(|t| format!("{t:?}"))
        .unwrap_or_default();
    if std::fs::read_to_string(dir.join(".source")).ok().as_deref() == Some(stamp.as_str()) {
        return;
    }
    match extract_weapons(library) {
        Ok(_) => {
            let _ = std::fs::write(dir.join(".source"), stamp);
        }
        Err(e) => eprintln!("weapon icons: {e}"),
    }
}

/// Extracts the emblems when a map in the library doesn't have one yet (first run, new maps).
pub fn ensure(library: &Path, maps: &[String]) {
    let dir = library.join("maps");
    if maps.iter().all(|m| dir.join(format!("{m}.svg")).exists()) {
        return;
    }
    // A map CS2 has no emblem for would otherwise re-extract every time: retry after CS2 updates.
    let stamp = cs2hl_render::steam::cs2_csgo_dir()
        .ok()
        .and_then(|d| std::fs::metadata(d.join("pak01_dir.vpk")).ok())
        .and_then(|m| m.modified().ok())
        .map(|t| format!("{t:?}"))
        .unwrap_or_default();
    if std::fs::read_to_string(dir.join(".source")).ok().as_deref() == Some(stamp.as_str()) {
        return;
    }
    match extract(library) {
        Ok(_) => {
            let _ = std::fs::write(dir.join(".source"), stamp);
        }
        Err(e) => eprintln!("map icons: {e}"),
    }
}
