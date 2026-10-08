//! Walks a CS2 demo's top-level frames and reports anything odd (debugging unreadable demos).
//!   cargo run --release -p cs2hl-core --example demo_frames -- <demo>
use cs2hl_core::demo_io;
use std::path::Path;

fn varint(b: &[u8], p: &mut usize) -> Option<u64> {
    let (mut v, mut s) = (0u64, 0);
    loop {
        let x = *b.get(*p)?;
        *p += 1;
        v |= ((x & 0x7f) as u64) << s;
        if x & 0x80 == 0 {
            return Some(v);
        }
        s += 7;
        if s > 63 {
            return None;
        }
    }
}

fn main() -> anyhow::Result<()> {
    let path = std::env::args().nth(1).expect("demo");
    let b = demo_io::read_demo(Path::new(&path))?;
    println!("{} bytes, magic {:?}", b.len(), String::from_utf8_lossy(&b[..8]));
    let mut p = 16; // magic (8) + two u32 offsets
    let mut counts = std::collections::BTreeMap::new();
    let mut n = 0;
    while p + 3 < b.len() {
        let start = p;
        let (Some(cmd), Some(tick), Some(size)) = (varint(&b, &mut p), varint(&b, &mut p), varint(&b, &mut p)) else {
            println!("bad varint at {start}");
            break;
        };
        let kind = cmd & !64;
        *counts.entry(kind).or_insert(0u32) += 1;
        if n < 6 || p + size as usize > b.len() || kind > 20 {
            println!("frame {n} at {start}: cmd {kind} compressed {} tick {tick} size {size}", cmd & 64 != 0);
        }
        if p + size as usize > b.len() {
            println!("  -> runs past the end of the file ({} bytes short)", p + size as usize - b.len());
            break;
        }
        p += size as usize;
        n += 1;
    }
    println!("{n} frames; by command: {counts:?}");
    Ok(())
}
