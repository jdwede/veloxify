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

/// Entries with extension `want_ext` in a VPK directory file that `want(path, name)` picks, plus
/// where its embedded data starts.
fn vpk_entries(dir_vpk: &Path, want_ext: &str, want: impl Fn(&str, &str) -> bool) -> Result<(Vec<Entry>, u64)> {
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
                if ext == want_ext && want(&path, &name) {
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
    let (entries, data_start) = vpk_entries(&vpk, "vsvg_c", |p, n| p == PREFIX && n.starts_with("map_icon_"))?;
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
    let (entries, data_start) = vpk_entries(&vpk, "vsvg_c", |p, _| p == WEAPONS)?;
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

/// LZ4 block decompression (CS2 stores texture mips compressed with it).
fn lz4_block(src: &[u8], out_len: usize) -> Result<Vec<u8>> {
    let mut out = Vec::with_capacity(out_len);
    let mut i = 0;
    let byte = |i: usize| src.get(i).copied().context("LZ4: truncated");
    while i < src.len() && out.len() < out_len {
        let tok = byte(i)?;
        i += 1;
        let mut lit = (tok >> 4) as usize;
        if lit == 15 {
            loop {
                let x = byte(i)?;
                i += 1;
                lit += x as usize;
                if x != 255 {
                    break;
                }
            }
        }
        out.extend_from_slice(src.get(i..i + lit).context("LZ4: literals past the end")?);
        i += lit;
        if i >= src.len() || out.len() >= out_len {
            break;
        }
        let off = byte(i)? as usize | (byte(i + 1)? as usize) << 8;
        i += 2;
        let mut ml = (tok & 15) as usize;
        if ml == 15 {
            loop {
                let x = byte(i)?;
                i += 1;
                ml += x as usize;
                if x != 255 {
                    break;
                }
            }
        }
        ml += 4;
        let start = out.len().checked_sub(off).context("LZ4: bad offset")?;
        for k in 0..ml {
            let b = out[start + k];
            out.push(b);
        }
    }
    Ok(out)
}

fn u16_at(b: &[u8], p: usize) -> Result<u16> {
    Ok(u16::from_le_bytes(b.get(p..p + 2).context("vtex: short")?.try_into()?))
}
fn u32_at(b: &[u8], p: usize) -> Result<u32> {
    Ok(u32::from_le_bytes(b.get(p..p + 4).context("vtex: short")?.try_into()?))
}

/// Decodes an uncompressed-format (BGRA8888) CS2 texture, `.vtex_c`, to RGBA: (width, height, pixels).
fn decode_vtex(b: &[u8]) -> Result<(u32, u32, Vec<u8>)> {
    let block_offset = u32_at(b, 8)? as usize;
    let block_count = u32_at(b, 12)? as usize;
    let mut data_block = None;
    for i in 0..block_count {
        let p = 8 + block_offset + i * 12;
        if b.get(p..p + 4) == Some(b"DATA") {
            data_block = Some((p + 4 + u32_at(b, p + 4)? as usize, u32_at(b, p + 8)? as usize));
        }
    }
    let (d, dlen) = data_block.context("vtex: no DATA block")?;
    let (w, h) = (u16_at(b, d + 20)? as usize, u16_at(b, d + 22)? as usize);
    let format = *b.get(d + 26).context("vtex: short")?;
    if format != 28 {
        bail!("vtex format {format} isn't BGRA8888");
    }
    // Extra data: COMPRESSED_MIP_SIZE (4) says whether and how the mips are LZ4-compressed.
    let (extra_off, extra_count) = (u32_at(b, d + 32)? as usize, u32_at(b, d + 36)? as usize);
    let mut sizes: Option<Vec<usize>> = None;
    for i in 0..extra_count {
        let e = d + 32 + extra_off + i * 12;
        if u32_at(b, e)? == 4 {
            let at = e + 4 + u32_at(b, e + 4)? as usize;
            let (compressed, mips_off, n) = (u32_at(b, at)? == 1, u32_at(b, at + 4)? as usize, u32_at(b, at + 8)? as usize);
            if compressed {
                sizes = Some((0..n).map(|k| u32_at(b, at + 4 + mips_off + 4 * k).map(|v| v as usize)).collect::<Result<_>>()?);
            }
        }
    }
    let data = &b[d + dlen..];
    let full = w * h * 4;
    // Mips are stored smallest first: the full-size picture is the last one.
    let bgra = match sizes {
        Some(s) => {
            let start: usize = s[..s.len() - 1].iter().sum();
            lz4_block(data.get(start..start + s[s.len() - 1]).context("vtex: mip past the end")?, full)?
        }
        None => data.get(data.len().saturating_sub(full)..).context("vtex: short")?.to_vec(),
    };
    if bgra.len() < full {
        bail!("vtex: decoded {} of {full} bytes", bgra.len());
    }
    let mut rgba = bgra[..full].to_vec();
    for px in rgba.chunks_exact_mut(4) {
        px.swap(0, 2);
    }
    Ok((w as u32, h as u32, rgba))
}

/// `"key" "value"` from a KeyValues text (the overview files).
fn kv(text: &str, key: &str) -> Option<f64> {
    let needle = format!("\"{key}\"");
    let rest = &text[text.find(&needle)? + needle.len()..];
    let start = rest.find('"')? + 1;
    let end = start + rest[start..].find('"')?;
    rest[start..end].trim().parse().ok()
}

/// Writes `radars/<map>.png` (CS2's overhead map) and `radars/<map>.json` (where game coordinates
/// land on it: pos_x, pos_y, scale) for these maps. Returns how many were written.
pub fn extract_radars(library: &Path, maps: &[String]) -> Result<usize> {
    let vpk = cs2hl_render::steam::cs2_csgo_dir()?.join("pak01_dir.vpk");
    let wanted: Vec<String> = maps.to_vec();
    let (entries, data_start) =
        vpk_entries(&vpk, "vtex_c", |p, n| p == "panorama/images/overheadmaps" && wanted.iter().any(|m| n == format!("{m}_radar_psd")))?;
    let (overviews, _) = vpk_entries(&vpk, "txt", |p, n| p == "resource/overviews" && wanted.iter().any(|m| m == n))?;
    let out = library.join("radars");
    std::fs::create_dir_all(&out)?;
    if entries.is_empty() {
        bail!("no radar textures in {} for {maps:?}", vpk.display());
    }
    let mut n = 0;
    let mut failures = vec![];
    for e in &entries {
        let map = e.name.trim_end_matches("_radar_psd");
        let Some(ov) = overviews.iter().find(|o| o.name == map) else {
            failures.push(format!("{map}: no overview file"));
            continue;
        };
        let text = String::from_utf8_lossy(&read_entry(&vpk, ov, data_start)?).into_owned();
        let (Some(pos_x), Some(pos_y), Some(scale)) = (kv(&text, "pos_x"), kv(&text, "pos_y"), kv(&text, "scale")) else {
            failures.push(format!("{map}: no pos_x/pos_y/scale in its overview"));
            continue;
        };
        let (w, h, rgba) = match decode_vtex(&read_entry(&vpk, e, data_start)?) {
            Ok(v) => v,
            Err(err) => {
                failures.push(format!("{map}: {err}"));
                continue;
            }
        };
        let file = std::io::BufWriter::new(File::create(out.join(format!("{map}.png")))?);
        let mut enc = png::Encoder::new(file, w, h);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.write_header()?.write_image_data(&rgba)?;
        let meta = serde_json::json!({ "pos_x": pos_x, "pos_y": pos_y, "scale": scale, "size": w });
        std::fs::write(out.join(format!("{map}.json")), meta.to_string())?;
        n += 1;
    }
    if n == 0 && !failures.is_empty() {
        bail!("{}", failures.join("; "));
    }
    Ok(n)
}

/// Radars for maps in the library that don't have one yet.
pub fn ensure_radars(library: &Path, maps: &[String]) {
    let dir = library.join("radars");
    let missing: Vec<String> = maps.iter().filter(|m| !dir.join(format!("{m}.png")).exists()).cloned().collect();
    if missing.is_empty() {
        return;
    }
    let stamp = cs2hl_render::steam::cs2_csgo_dir()
        .ok()
        .and_then(|d| std::fs::metadata(d.join("pak01_dir.vpk")).ok())
        .and_then(|m| m.modified().ok())
        .map(|t| format!("{t:?}|{}", missing.join(",")))
        .unwrap_or_default();
    if std::fs::read_to_string(dir.join(".source")).ok().as_deref() == Some(stamp.as_str()) {
        return; // already tried for these maps with this CS2 version
    }
    match extract_radars(library, &missing) {
        Ok(_) => {
            let _ = std::fs::create_dir_all(&dir);
            let _ = std::fs::write(dir.join(".source"), stamp);
            let _ = std::fs::remove_file(dir.join("error.txt"));
        }
        Err(e) => {
            let _ = std::fs::create_dir_all(&dir);
            let _ = std::fs::write(dir.join("error.txt"), format!("{e:#}
"));
        }
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
