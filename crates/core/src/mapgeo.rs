//! A map's collision geometry, from CS2's own files, for line of sight: can one player see
//! another? (CS2's own "spotted" flag in demos lags and lingers, see `details`.)
//!
//! `maps/<map>.vpk` holds `maps/<map>/world_physics.vmdl_c`, a compiled resource whose `PHYS` block
//! is binary KeyValues3 (version 1-5, uncompressed, LZ4 or zstd): `m_parts[].m_rnShape` with
//! triangle meshes (`m_meshes[].m_Mesh`) and convex hulls (`m_hulls[].m_Hull`). The binary KV3
//! layout follows ValveResourceFormat (MIT), `BinaryKV3.cs`.

use anyhow::{bail, Context, Result};
use std::path::Path;

// ---- VPK -----------------------------------------------------------------------------------------

/// One file out of a VPK directory file (`*_dir.vpk`, or a single-file `.vpk`).
pub fn read_vpk_file(vpk: &Path, want: &str) -> Result<Vec<u8>> {
    let b = std::fs::read(vpk).with_context(|| format!("reading {}", vpk.display()))?;
    let u32_at = |p: usize| -> Result<u32> { Ok(u32::from_le_bytes(b.get(p..p + 4).context("VPK: short")?.try_into()?)) };
    if u32_at(0)? != 0x55aa_1234 {
        bail!("{} isn't a VPK", vpk.display());
    }
    let version = u32_at(4)?;
    let tree = u32_at(8)? as usize;
    let header = if version == 2 { 28 } else { 12 };
    let end = header + tree;
    let mut i = header;
    let cstr = |i: &mut usize| -> Result<String> {
        let j = b[*i..].iter().position(|&c| c == 0).context("VPK: unterminated name")? + *i;
        let s = String::from_utf8_lossy(&b[*i..j]).into_owned();
        *i = j + 1;
        Ok(s)
    };
    while i < end {
        let ext = cstr(&mut i)?;
        if ext.is_empty() {
            break;
        }
        loop {
            let dir = cstr(&mut i)?;
            if dir.is_empty() {
                break;
            }
            loop {
                let name = cstr(&mut i)?;
                if name.is_empty() {
                    break;
                }
                let preload = u16::from_le_bytes(b[i + 4..i + 6].try_into()?) as usize;
                let archive = u16::from_le_bytes(b[i + 6..i + 8].try_into()?);
                let offset = u32_at(i + 8)? as usize;
                let len = u32_at(i + 12)? as usize;
                i += 18;
                let pre = &b[i..i + preload];
                i += preload;
                if format!("{dir}/{name}.{ext}").eq_ignore_ascii_case(want) {
                    let mut out = pre.to_vec();
                    if archive == 0x7fff {
                        out.extend_from_slice(b.get(end + offset..end + offset + len).context("VPK: entry past the end")?);
                    } else {
                        let stem = vpk.to_string_lossy();
                        let part = format!("{}_{archive:03}.vpk", stem.trim_end_matches(".vpk").trim_end_matches("_dir"));
                        let data = std::fs::read(&part).with_context(|| format!("reading {part}"))?;
                        out.extend_from_slice(data.get(offset..offset + len).context("VPK: entry past the end")?);
                    }
                    return Ok(out);
                }
            }
        }
    }
    bail!("{want} isn't in {}", vpk.display())
}

/// A block of a compiled resource (`.vmdl_c` etc.) by its 4-letter type.
fn resource_block<'a>(res: &'a [u8], kind: &[u8; 4]) -> Option<&'a [u8]> {
    let u32_at = |p: usize| Some(u32::from_le_bytes(res.get(p..p + 4)?.try_into().ok()?) as usize);
    let block_offset = u32_at(8)?;
    let count = u32_at(12)?;
    let base = 8 + block_offset;
    (0..count).find_map(|k| {
        let o = base + k * 12;
        (res.get(o..o + 4)? == kind).then(|| {
            let (off, size) = (u32_at(o + 4)?, u32_at(o + 8)?);
            res.get(o + 4 + off..o + 4 + off + size)
        })?
    })
}

// ---- Binary KeyValues3 --------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub enum Kv {
    Null,
    Bool(bool),
    Int(i64),
    UInt(u64),
    Float(f64),
    Str(String),
    Blob(Vec<u8>),
    Array(Vec<Kv>),
    Object(Vec<(String, Kv)>),
}

impl Kv {
    pub fn get(&self, key: &str) -> Option<&Kv> {
        match self {
            Kv::Object(m) => m.iter().rev().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }
    pub fn items(&self) -> &[Kv] {
        match self {
            Kv::Array(a) => a,
            _ => &[],
        }
    }
    pub fn blob(&self) -> Option<&[u8]> {
        match self {
            Kv::Blob(b) => Some(b),
            _ => None,
        }
    }
    pub fn int(&self) -> Option<i64> {
        match *self {
            Kv::Int(v) => Some(v),
            Kv::UInt(v) => Some(v as i64),
            Kv::Float(v) => Some(v as i64),
            Kv::Bool(v) => Some(v as i64),
            _ => None,
        }
    }
    pub fn float(&self) -> Option<f64> {
        match *self {
            Kv::Float(v) => Some(v),
            Kv::Int(v) => Some(v as f64),
            Kv::UInt(v) => Some(v as f64),
            _ => None,
        }
    }
    pub fn str(&self) -> Option<&str> {
        match self {
            Kv::Str(s) => Some(s),
            _ => None,
        }
    }
}

/// A read position in one of KV3's typed lanes.
#[derive(Default, Clone, Copy)]
struct Cur<'a> {
    b: &'a [u8],
    p: usize,
}

impl<'a> Cur<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        let s = self.b.get(self.p..self.p + n).context("KV3: lane ran out")?;
        self.p += n;
        Ok(s)
    }
    fn u8(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }
    fn i32(&mut self) -> Result<i32> {
        Ok(i32::from_le_bytes(self.take(4)?.try_into()?))
    }
}

#[derive(Default, Clone, Copy)]
struct Lanes<'a> {
    b1: Cur<'a>,
    b2: Cur<'a>,
    b4: Cur<'a>,
    b8: Cur<'a>,
}

struct Ctx<'a> {
    version: u32,
    types: Cur<'a>,
    object_lengths: Cur<'a>,
    blob_lengths: Cur<'a>,
    blobs: Cur<'a>,
    strings: Vec<String>,
    main: Lanes<'a>,
    aux: Lanes<'a>,
}

const TRAILER: u32 = 0xFFEE_DD00;

fn align(o: usize, a: usize) -> usize {
    o.div_ceil(a) * a
}

/// Splits a buffer into its 1/2/4/8-byte lanes, starting at `offset`; returns the lanes and the end.
fn split_lanes(buf: &[u8], mut offset: usize, counts: [usize; 4], align_empty8: bool) -> Result<(Lanes<'_>, usize)> {
    let mut lanes = Lanes::default();
    let lane = |o: &mut usize, n: usize, size: usize| -> Result<Cur<'_>> {
        *o = align(*o, size);
        let s = buf.get(*o..*o + n * size).context("KV3: lane past the buffer")?;
        *o += n * size;
        Ok(Cur { b: s, p: 0 })
    };
    if counts[0] > 0 {
        lanes.b1 = lane(&mut offset, counts[0], 1)?;
    }
    if counts[1] > 0 {
        lanes.b2 = lane(&mut offset, counts[1], 2)?;
    }
    if counts[2] > 0 {
        lanes.b4 = lane(&mut offset, counts[2], 4)?;
    }
    if counts[3] > 0 {
        lanes.b8 = lane(&mut offset, counts[3], 8)?;
    } else if align_empty8 {
        offset = align(offset, 8);
    }
    Ok((lanes, offset))
}

fn decompress(method: u32, input: &[u8], out_len: usize) -> Result<Vec<u8>> {
    match method {
        0 => Ok(input.get(..out_len).context("KV3: short buffer")?.to_vec()),
        1 => lz4_block(input, out_len, &[]),
        2 => {
            let out = zstd::bulk::decompress(input, out_len).context("KV3: zstd")?;
            if out.len() != out_len {
                bail!("KV3: zstd gave {} bytes, expected {out_len}", out.len());
            }
            Ok(out)
        }
        m => bail!("KV3: unknown compression {m}"),
    }
}

/// LZ4 block decompression; `history` is data decoded before this block that matches may
/// reference (chained frames).
fn lz4_block(src: &[u8], out_len: usize, history: &[u8]) -> Result<Vec<u8>> {
    let mut out: Vec<u8> = Vec::with_capacity(history.len() + out_len);
    out.extend_from_slice(history);
    let target = history.len() + out_len;
    let mut i = 0;
    let byte = |i: usize| src.get(i).copied().context("LZ4: truncated");
    while i < src.len() && out.len() < target {
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
        if i >= src.len() || out.len() >= target {
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
    Ok(out.split_off(history.len()))
}

/// Parses binary KeyValues3 (versions 1-5).
pub fn parse_kv3(b: &[u8]) -> Result<Kv> {
    let mut r = Cur { b, p: 0 };
    let magic = u32::from_le_bytes(r.take(4)?.try_into()?);
    let version = magic & 0xff;
    if magic & 0xffff_ff00 != 0x4b56_3300 || !(1..=5).contains(&version) {
        bail!("KV3: unsupported signature {magic:#x}");
    }
    r.take(16)?; // format GUID
    let method = u32::from_le_bytes(r.take(4)?.try_into()?);
    let rd = |r: &mut Cur| -> Result<usize> { Ok(r.i32()? as usize) };
    let rd16 = |r: &mut Cur| -> Result<usize> { Ok(u16::from_le_bytes(r.take(2)?.try_into()?) as usize) };
    let (mut count_types, mut count_blocks, mut blob_bytes, mut frame_size) = (0, 0, 0, 0);
    let (b1, b4, b8, unc_total, cmp_total);
    if version == 1 {
        b1 = rd(&mut r)?;
        b4 = rd(&mut r)?;
        b8 = rd(&mut r)?;
        unc_total = rd(&mut r)?;
        cmp_total = b.len() - r.p;
    } else {
        let _dict = rd16(&mut r)?;
        frame_size = rd16(&mut r)?;
        b1 = rd(&mut r)?;
        b4 = rd(&mut r)?;
        b8 = rd(&mut r)?;
        count_types = rd(&mut r)?;
        let _objects = rd16(&mut r)?;
        let _arrays = rd16(&mut r)?;
        unc_total = rd(&mut r)?;
        cmp_total = rd(&mut r)?;
        count_blocks = rd(&mut r)?;
        blob_bytes = rd(&mut r)?;
    }
    let (mut b2, mut _block_sizes_bytes) = (0, 0);
    if version >= 4 {
        b2 = rd(&mut r)?;
        _block_sizes_bytes = rd(&mut r)?;
    }
    let (mut unc1, mut cmp1, mut unc2, mut cmp2) = (unc_total, cmp_total, 0, 0);
    let mut counts2 = [0usize; 4];
    let mut objects2 = 0;
    if version >= 5 {
        unc1 = rd(&mut r)?;
        cmp1 = rd(&mut r)?;
        unc2 = rd(&mut r)?;
        cmp2 = rd(&mut r)?;
        counts2 = [rd(&mut r)?, rd(&mut r)?, rd(&mut r)?, rd(&mut r)?];
        let _nodes = rd(&mut r)?;
        objects2 = rd(&mut r)?;
        let _arrays2 = rd(&mut r)?;
        let _elements = rd(&mut r)?;
    }
    // Buffer 1 (before v5 zstd also holds the blobs, as a second frame decompressed with it).
    let joint_zstd = version < 5 && method == 2;
    let buf1 = if method == 0 {
        r.take(unc1)?.to_vec()
    } else {
        let want = if joint_zstd { unc1 + blob_bytes } else { unc1 };
        decompress(method, r.take(cmp1)?, want)?
    };
    let (lanes1, mut off1) = split_lanes(&buf1[..unc1], 0, [b1, b2, b4, b8], version < 5)?;
    let mut aux = lanes1;
    let count_strings = aux.b4.i32()? as usize;
    let mut strings = Vec::with_capacity(count_strings);
    let types;
    let mut blob_sizes = Cur::default();
    let buf2: Vec<u8>;
    let main;
    let mut object_lengths = Cur::default();
    if version >= 5 {
        for _ in 0..count_strings {
            let s = &aux.b1.b[aux.b1.p..];
            let n = s.iter().position(|&c| c == 0).context("KV3: unterminated string")?;
            strings.push(String::from_utf8_lossy(&s[..n]).into_owned());
            aux.b1.p += n + 1;
        }
        buf2 = if method == 0 { r.take(unc2)?.to_vec() } else { decompress(method, r.take(cmp2)?, unc2)? };
        object_lengths = Cur { b: buf2.get(..objects2 * 4).context("KV3: short buffer 2")?, p: 0 };
        let (lanes2, off2) = split_lanes(&buf2, objects2 * 4, counts2, false)?;
        main = lanes2;
        types = Cur { b: buf2.get(off2..off2 + count_types).context("KV3: types past the end")?, p: 0 };
        if count_blocks > 0 {
            blob_sizes = Cur { b: &buf2[off2 + count_types..], p: 0 };
        }
    } else {
        main = aux;
        let start = off1;
        for _ in 0..count_strings {
            let n = buf1[off1..].iter().position(|&c| c == 0).context("KV3: unterminated string")?;
            strings.push(String::from_utf8_lossy(&buf1[off1..off1 + n]).into_owned());
            off1 += n + 1;
        }
        let types_len = if version == 1 { unc_total - off1 - 4 } else { count_types - off1 + start };
        types = Cur { b: buf1.get(off1..off1 + types_len).context("KV3: types past the end")?, p: 0 };
        off1 += types_len;
        if count_blocks > 0 {
            blob_sizes = Cur { b: &buf1[off1..unc1], p: 0 };
        }
    }
    // Binary blobs.
    let blobs_raw: Vec<u8>;
    let mut blob_lengths = Cur::default();
    if count_blocks > 0 {
        blob_lengths = Cur { b: blob_sizes.take(count_blocks * 4)?, p: 0 };
        if u32::from_le_bytes(blob_sizes.take(4)?.try_into()?) != TRAILER {
            bail!("KV3: bad trailer after blob sizes");
        }
        blobs_raw = match method {
            0 => r.take(blob_bytes)?.to_vec(),
            1 => {
                // Frames of up to `frame_size` bytes, never spanning two blobs, chained.
                let mut out: Vec<u8> = Vec::with_capacity(blob_bytes);
                let mut lens = Cur { b: blob_lengths.b, p: 0 };
                for _ in 0..count_blocks {
                    let blob_end = out.len() + lens.i32()? as usize;
                    while out.len() < blob_end {
                        let csize = u16::from_le_bytes(blob_sizes.take(2)?.try_into()?) as usize;
                        let want = (blob_end - out.len()).min(frame_size.max(1));
                        let hist_from = out.len().saturating_sub(65536);
                        let dec = lz4_block(r.take(csize)?, want, &out[hist_from..])?;
                        if dec.is_empty() {
                            bail!("KV3: empty LZ4 frame");
                        }
                        out.extend_from_slice(&dec);
                    }
                }
                out
            }
            2 if version >= 5 => decompress(2, r.take(cmp_total - cmp1 - cmp2)?, blob_bytes)?,
            2 => buf1[unc1..unc1 + blob_bytes].to_vec(),
            m => bail!("KV3: unknown compression {m}"),
        };
        if u32::from_le_bytes(r.take(4)?.try_into()?) != TRAILER {
            bail!("KV3: bad trailer after blobs");
        }
    } else {
        blobs_raw = vec![];
    }
    let mut ctx = Ctx { version, types, object_lengths, blob_lengths, blobs: Cur { b: &blobs_raw, p: 0 }, strings, main, aux };
    let t = read_type(&mut ctx)?;
    read_value(&mut ctx, t, false)
}

fn read_type(c: &mut Ctx) -> Result<u8> {
    let mut t = c.types.u8()?;
    if c.version >= 3 {
        if t & 0x80 != 0 {
            c.types.u8()?; // flag
        }
        if t & 0x40 != 0 {
            c.types.u8()?;
        }
        t &= 0x3f;
    } else {
        if t & 0x80 != 0 {
            c.types.u8()?;
        }
        t &= 0x7f;
    }
    Ok(t)
}

/// One value. Primitives come from the main buffer's lanes, or the auxiliary buffer's for elements
/// of an auxiliary-buffer typed array (`aux`); strings, blobs and container lengths always from the
/// main buffer.
fn read_value(c: &mut Ctx, t: u8, aux: bool) -> Result<Kv> {
    macro_rules! lane {
        () => {
            if aux { &mut c.aux } else { &mut c.main }
        };
    }
    let v = match t {
        1 => Kv::Null,
        2 => Kv::Bool(lane!().b1.u8()? != 0),
        3 => Kv::Int(i64::from_le_bytes(lane!().b8.take(8)?.try_into()?)),
        4 => Kv::UInt(u64::from_le_bytes(lane!().b8.take(8)?.try_into()?)),
        5 => Kv::Float(f64::from_le_bytes(lane!().b8.take(8)?.try_into()?)),
        6 => {
            let id = c.main.b4.i32()?;
            Kv::Str(if id >= 0 { c.strings.get(id as usize).cloned().unwrap_or_default() } else { String::new() })
        }
        7 if c.version < 2 => {
            let n = c.main.b4.i32()? as usize;
            Kv::Blob(c.main.b1.take(n)?.to_vec())
        }
        7 => {
            let n = c.blob_lengths.i32()? as usize;
            Kv::Blob(c.blobs.take(n)?.to_vec())
        }
        8 => {
            let n = c.main.b4.i32()? as usize;
            let mut a = Vec::with_capacity(n);
            for _ in 0..n {
                let et = read_type(c)?;
                a.push(read_value(c, et, false)?);
            }
            Kv::Array(a)
        }
        10 | 24 | 25 => {
            let n = if t == 10 { c.main.b4.i32()? as usize } else { c.main.b1.u8()? as usize };
            let et = read_type(c)?;
            let mut a = Vec::with_capacity(n);
            for _ in 0..n {
                a.push(read_value(c, et, t == 25)?);
            }
            Kv::Array(a)
        }
        9 => {
            let n = if c.version >= 5 { c.object_lengths.i32()? as usize } else { c.main.b4.i32()? as usize };
            let mut o = Vec::with_capacity(n);
            for _ in 0..n {
                let et = read_type(c)?;
                let id = c.main.b4.i32()?;
                let name = if id >= 0 { c.strings.get(id as usize).cloned().unwrap_or_default() } else { String::new() };
                o.push((name, read_value(c, et, false)?));
            }
            Kv::Object(o)
        }
        11 => Kv::Int(lane!().b4.i32()? as i64),
        12 => Kv::UInt(u32::from_le_bytes(lane!().b4.take(4)?.try_into()?) as u64),
        13 => Kv::Bool(true),
        14 => Kv::Bool(false),
        15 => Kv::Int(0),
        16 => Kv::Int(1),
        17 => Kv::Float(0.0),
        18 => Kv::Float(1.0),
        19 => Kv::Float(f32::from_le_bytes(lane!().b4.take(4)?.try_into()?) as f64),
        20 => Kv::Int(i16::from_le_bytes(lane!().b2.take(2)?.try_into()?) as i64),
        21 => Kv::UInt(u16::from_le_bytes(lane!().b2.take(2)?.try_into()?) as u64),
        22 => Kv::Int(lane!().b1.u8()? as i8 as i64),
        23 => Kv::UInt(lane!().b1.u8()? as u64),
        26 => Kv::UInt(0),
        27 => Kv::UInt(1),
        t => bail!("KV3: unknown type {t}"),
    };
    Ok(v)
}

// ---- Collision geometry ------------------------------------------------------------------------

pub type V3 = [f32; 3];

/// A map's solid triangles, with a bounding-volume tree for ray casts.
pub struct Geometry {
    pub tris: Vec<[V3; 3]>,
    nodes: Vec<Node>,
    /// Triangle indices, in leaf order.
    order: Vec<u32>,
}

#[derive(Clone, Copy)]
struct Node {
    min: V3,
    max: V3,
    /// Leaf: first index into `order`; inner: the right child (the left one is the next node).
    start: u32,
    /// Leaf: triangle count; inner: 0.
    count: u32,
}

/// A collision attribute's interaction tags (e.g. "default", "playerclip").
fn attribute_tags(attr: &Kv) -> Vec<String> {
    attr.get("m_InteractAsStrings")
        .or_else(|| attr.get("m_PhysicsTagStrings"))
        .map(|a| a.items().iter().filter_map(|s| s.str().map(str::to_lowercase)).collect())
        .unwrap_or_default()
}

/// Whether a collision attribute stops sight: solid world, not clip brushes that only stop
/// players (or grenades), sky or water.
pub fn blocks_sight(tags: &[String]) -> bool {
    !tags.iter().any(|t| t.contains("clip") || t.contains("sky") || t.contains("water") || t.contains("trigger"))
}

fn vec3s(blob: &[u8]) -> Vec<V3> {
    blob.chunks_exact(12)
        .map(|c| [f32::from_le_bytes(c[0..4].try_into().unwrap()), f32::from_le_bytes(c[4..8].try_into().unwrap()), f32::from_le_bytes(c[8..12].try_into().unwrap())])
        .collect()
}

/// The collision attributes' tags and every triangle with its attribute: meshes as they are,
/// convex hulls' faces fanned into triangles.
pub fn physics_triangles(phys: &Kv) -> (Vec<Vec<String>>, Vec<(usize, [V3; 3])>) {
    let attrs: Vec<Vec<String>> = phys.get("m_collisionAttributes").map(|a| a.items().iter().map(attribute_tags).collect()).unwrap_or_default();
    let mut out = vec![];
    for part in phys.get("m_parts").map(|p| p.items()).unwrap_or(&[]) {
        let Some(shape) = part.get("m_rnShape") else { continue };
        for m in shape.get("m_meshes").map(|v| v.items()).unwrap_or(&[]) {
            let attr = m.get("m_nCollisionAttributeIndex").and_then(Kv::int).unwrap_or(0) as usize;
            let Some(mesh) = m.get("m_Mesh") else { continue };
            let verts = mesh.get("m_Vertices").and_then(Kv::blob).map(vec3s).unwrap_or_default();
            let Some(tri) = mesh.get("m_Triangles").and_then(Kv::blob) else { continue };
            for t in tri.chunks_exact(12) {
                let i = |k: usize| i32::from_le_bytes(t[k * 4..k * 4 + 4].try_into().unwrap()) as usize;
                if let (Some(a), Some(b), Some(c)) = (verts.get(i(0)), verts.get(i(1)), verts.get(i(2))) {
                    out.push((attr, [*a, *b, *c]));
                }
            }
        }
        for h in shape.get("m_hulls").map(|v| v.items()).unwrap_or(&[]) {
            let attr = h.get("m_nCollisionAttributeIndex").and_then(Kv::int).unwrap_or(0) as usize;
            let Some(hull) = h.get("m_Hull") else { continue };
            let positions = hull.get("m_VertexPositions").or_else(|| hull.get("m_Vertices")).and_then(Kv::blob).map(vec3s).unwrap_or_default();
            let (Some(edges), Some(faces)) = (hull.get("m_Edges").and_then(Kv::blob), hull.get("m_Faces").and_then(Kv::blob)) else { continue };
            // Half-edges: next, twin, origin, face (a byte each); a face: its first edge.
            for &first in faces {
                let mut poly = vec![];
                let mut e = first as usize;
                for _ in 0..256 {
                    let Some(he) = edges.get(e * 4..e * 4 + 4) else { break };
                    if let Some(p) = positions.get(he[2] as usize) {
                        poly.push(*p);
                    }
                    e = he[0] as usize;
                    if e == first as usize {
                        break;
                    }
                }
                for k in 1..poly.len().saturating_sub(1) {
                    out.push((attr, [poly[0], poly[k], poly[k + 1]]));
                }
            }
        }
    }
    (attrs, out)
}

/// The parsed `PHYS` block of a map's `world_physics` (for inspecting it).
pub fn load_physics(csgo: &Path, map: &str) -> Result<Kv> {
    let res = read_vpk_file(&csgo.join("maps").join(format!("{map}.vpk")), &format!("maps/{map}/world_physics.vmdl_c"))?;
    let block = resource_block(&res, b"PHYS").context("no PHYS block in world_physics")?;
    parse_kv3(block)
}

/// Loads a map's sight-blocking geometry from CS2's files (`csgo` is `.../game/csgo`).
pub fn load(csgo: &Path, map: &str) -> Result<Geometry> {
    let phys = load_physics(csgo, map)?;
    let (attrs, tris) = physics_triangles(&phys);
    let solid: Vec<bool> = attrs.iter().map(|t| blocks_sight(t)).collect();
    let tris: Vec<[V3; 3]> = tris.into_iter().filter(|(a, _)| solid.get(*a).copied().unwrap_or(true)).map(|(_, t)| t).collect();
    Ok(Geometry::new(tris))
}

impl Geometry {
    pub fn new(tris: Vec<[V3; 3]>) -> Self {
        let mut g = Geometry { order: (0..tris.len() as u32).collect(), tris, nodes: vec![] };
        let n = g.order.len();
        if n > 0 {
            let centers: Vec<V3> = g.tris.iter().map(|t| std::array::from_fn(|k| (t[0][k] + t[1][k] + t[2][k]) / 3.0)).collect();
            g.build(0, n, &centers);
        }
        g
    }

    fn bounds(&self, from: usize, to: usize) -> (V3, V3) {
        let mut min = [f32::MAX; 3];
        let mut max = [f32::MIN; 3];
        for &i in &self.order[from..to] {
            for v in &self.tris[i as usize] {
                for k in 0..3 {
                    min[k] = min[k].min(v[k]);
                    max[k] = max[k].max(v[k]);
                }
            }
        }
        (min, max)
    }

    /// Splits at the median of the longest axis down to leaves of 4 or fewer triangles. Returns
    /// the node's index.
    fn build(&mut self, from: usize, to: usize, centers: &[V3]) -> usize {
        let (min, max) = self.bounds(from, to);
        let me = self.nodes.len();
        self.nodes.push(Node { min, max, start: from as u32, count: (to - from) as u32 });
        if to - from <= 4 {
            return me;
        }
        let axis = (0..3).max_by(|&a, &b| (max[a] - min[a]).partial_cmp(&(max[b] - min[b])).unwrap()).unwrap();
        let mid = (from + to) / 2;
        self.order[from..to].select_nth_unstable_by(mid - from, |&a, &b| {
            centers[a as usize][axis].partial_cmp(&centers[b as usize][axis]).unwrap_or(std::cmp::Ordering::Equal)
        });
        self.build(from, mid, centers);
        let right = self.build(mid, to, centers);
        self.nodes[me].start = right as u32;
        self.nodes[me].count = 0;
        me
    }

    /// Whether the segment from `a` to `b` passes through no solid triangle.
    pub fn clear(&self, a: V3, b: V3) -> bool {
        if self.nodes.is_empty() {
            return true;
        }
        let d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let mut stack: Vec<usize> = Vec::with_capacity(64);
        stack.push(0);
        while let Some(idx) = stack.pop() {
            let n = self.nodes[idx];
            if !segment_box(a, d, n.min, n.max) {
                continue;
            }
            if n.count > 0 {
                for &i in &self.order[n.start as usize..(n.start + n.count) as usize] {
                    if segment_hits(a, d, &self.tris[i as usize]) {
                        return false;
                    }
                }
            } else {
                stack.push(n.start as usize);
                stack.push(idx + 1);
            }
        }
        true
    }
}

/// Does the segment `a + t d` (0 <= t <= 1) touch the box?
fn segment_box(a: V3, d: V3, min: V3, max: V3) -> bool {
    let (mut t0, mut t1) = (0.0f32, 1.0f32);
    for k in 0..3 {
        if d[k].abs() < 1e-9 {
            if a[k] < min[k] || a[k] > max[k] {
                return false;
            }
            continue;
        }
        let inv = 1.0 / d[k];
        let (mut lo, mut hi) = ((min[k] - a[k]) * inv, (max[k] - a[k]) * inv);
        if lo > hi {
            std::mem::swap(&mut lo, &mut hi);
        }
        t0 = t0.max(lo);
        t1 = t1.min(hi);
        if t0 > t1 {
            return false;
        }
    }
    true
}

/// Möller-Trumbore: does the segment `a + t d` (0 < t < 1) cross the triangle?
fn segment_hits(a: V3, d: V3, t: &[V3; 3]) -> bool {
    let sub = |x: V3, y: V3| [x[0] - y[0], x[1] - y[1], x[2] - y[2]];
    let cross = |x: V3, y: V3| [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
    let dot = |x: V3, y: V3| x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
    let e1 = sub(t[1], t[0]);
    let e2 = sub(t[2], t[0]);
    let p = cross(d, e2);
    let det = dot(e1, p);
    if det.abs() < 1e-8 {
        return false;
    }
    let inv = 1.0 / det;
    let s = sub(a, t[0]);
    let u = dot(s, p) * inv;
    if !(0.0..=1.0).contains(&u) {
        return false;
    }
    let q = cross(s, e1);
    let v = dot(d, q) * inv;
    if v < 0.0 || u + v > 1.0 {
        return false;
    }
    let tt = dot(e2, q) * inv;
    tt > 1e-4 && tt < 1.0 - 1e-4
}

// ---- Per map, loaded once --------------------------------------------------------------------

static CSGO_DIR: std::sync::Mutex<Option<std::path::PathBuf>> = std::sync::Mutex::new(None);
type Cache = std::collections::HashMap<String, Option<std::sync::Arc<Geometry>>>;
static GEOMETRY: std::sync::Mutex<Option<Cache>> = std::sync::Mutex::new(None);

/// Where CS2's `game/csgo` folder is (the app sets it at start; `VELOXIFY_CSGO` overrides).
pub fn set_csgo_dir(dir: std::path::PathBuf) {
    *CSGO_DIR.lock().unwrap() = Some(dir);
}

/// The map's geometry, loaded from CS2's files once per run; None when CS2 or the map isn't there.
pub fn for_map(map: &str) -> Option<std::sync::Arc<Geometry>> {
    let dir = std::env::var_os("VELOXIFY_CSGO").map(std::path::PathBuf::from).or_else(|| CSGO_DIR.lock().unwrap().clone())?;
    let mut cache = GEOMETRY.lock().unwrap();
    let cache = cache.get_or_insert_with(Default::default);
    cache.entry(map.to_string()).or_insert_with(|| load(&dir, map).ok().filter(|g| !g.tris.is_empty()).map(std::sync::Arc::new)).clone()
}
