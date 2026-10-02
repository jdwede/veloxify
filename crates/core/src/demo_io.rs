//! Loading demo files in any of the formats Valve and FACEIT serve.

use anyhow::{bail, Context, Result};
use std::io::Read;
use std::path::Path;

const DEMO_MAGIC: &[u8] = b"PBDEMS2\0";

/// Reads a CS2 demo from disk, transparently decompressing `.gz` (FACEIT, older),
/// `.zst` (FACEIT, current) and `.bz2` (Valve matchmaking). Detection is by magic bytes,
/// not file extension, since browsers sometimes save decompressed files under the old name.
pub fn read_demo(path: &Path) -> Result<Vec<u8>> {
    let raw = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    let bytes = match raw.get(..4) {
        Some([0x1f, 0x8b, ..]) => {
            let mut out = Vec::with_capacity(raw.len() * 4);
            flate2::read::GzDecoder::new(&raw[..]).read_to_end(&mut out).context("gunzip")?;
            out
        }
        Some([0x28, 0xb5, 0x2f, 0xfd]) => zstd::stream::decode_all(&raw[..]).context("zstd decode")?,
        Some([b'B', b'Z', b'h', _]) => {
            let mut out = Vec::with_capacity(raw.len() * 4);
            bzip2::read::BzDecoder::new(&raw[..]).read_to_end(&mut out).context("bunzip2")?;
            out
        }
        _ => raw,
    };
    if !bytes.starts_with(DEMO_MAGIC) {
        bail!("{} is not a CS2 demo (missing PBDEMS2 header)", path.display());
    }
    Ok(bytes)
}
