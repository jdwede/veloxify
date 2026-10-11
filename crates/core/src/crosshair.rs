//! CS2 crosshair share codes: reading them (both containers), turning one into console
//! variables, and writing the code CS2 imports today.
//!
//! Two containers exist (after akiver/csgo-sharecode, MIT):
//! - `CSGO-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx`: the old one, 18 bytes. Version 1 is the CS:GO-era
//!   crosshair (sizes in CS:GO's units); versions 3 and 4 (September 2026) are in pixels. CS2 no
//!   longer imports any of them.
//! - `CS` + 44 characters: the code CS2 makes since its 30 September 2026 update, 32 bytes.
//!
//! Every crosshair is read into the pixel model CS2 uses now. A version 1 crosshair is converted
//! (CS2 publishes no conversion, so it's close, not exact): CS:GO drew sizes scaled to a 480-line
//! screen, so at 1080 lines a unit is 2.25 pixels, and its gap was 4 + `cl_crosshairgap` pixels
//! from the centre to each line.

use serde::Serialize;

const DICTIONARY: &[u8] = b"ABCDEFGHJKLMNOPQRSTUVWXYZabcdefhijkmnopqrstuvwxyz23456789";

/// A crosshair in CS2's pixel model (the console variables CS2 has since September 2026).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Crosshair {
    /// 0 dynamic cross, 1 dynamic circle, 2 dynamic cross (legacy), 3 static circle, 4 static
    /// cross, 5 static cross (shot feedback), 6 dot only, 7 dynamic quad, 8 static square,
    /// 9 static quad.
    pub style: u8,
    pub follow_recoil: bool,
    pub dot: bool,
    pub t_style: bool,
    /// 0 none, 1 full, 2 half.
    pub outline: u8,
    pub color: [u8; 4],
    pub outline_color: [u8; 4],
    /// Pixels between the inner ends of opposite lines (negative overlaps the centre).
    pub gap: i32,
    pub length: u8,
    pub thickness: u8,
    pub spread_limit: u8,
    pub split_distance: u8,
    pub inner_split_alpha: f32,
    pub outer_split_alpha: f32,
    pub split_ratio: f32,
    /// The screen height the sizes are for; CS2 scales them to the real one.
    pub screen_height: u16,
    pub scope_dot_scale: f32,
    pub scope_dot_color: bool,
    /// Which code it was read from: "cs2", "pixel" (old container, pixels) or "csgo" (old
    /// container, CS:GO units: converted).
    pub format: &'static str,
}

/// The clean crosshair recordings use by default: a small static cross.
pub const CLEAN: Crosshair = Crosshair {
    style: 4,
    follow_recoil: false,
    dot: false,
    t_style: false,
    outline: 0,
    color: [200, 255, 0, 255],
    outline_color: [0, 0, 0, 255],
    gap: 4,
    length: 6,
    thickness: 1,
    spread_limit: 255,
    split_distance: 3,
    inner_split_alpha: 0.0,
    outer_split_alpha: 1.0,
    split_ratio: 0.3,
    screen_height: 1080,
    scope_dot_scale: 1.0,
    scope_dot_color: false,
    format: "cs2",
};

/// CS:GO-era crosshair variables. CS2 converts them into its pixel crosshair in ways that can't be
/// put back exactly, so recordings never set them (they set the pixel ones, which are read first
/// and put back after).
pub const LEGACY_CVARS: &[&str] = &[
    "cl_crosshairsize",
    "cl_crosshairgap",
    "cl_crosshairthickness",
    "cl_crosshaircolor",
    "cl_crosshairalpha",
    "cl_crosshairusealpha",
    "cl_crosshair_outlinethickness",
    "cl_crosshairgap_useweaponvalue",
    "cl_fixedcrosshairgap",
];

/// Base-57 characters (least significant first) to `len` big-endian bytes.
fn chars_to_bytes(chars: &str, len: usize) -> Option<Vec<u8>> {
    // Little-endian limbs of the big number.
    let mut n: Vec<u32> = vec![0];
    for c in chars.bytes().rev() {
        let d = DICTIONARY.iter().position(|&x| x == c)? as u64;
        let mut carry = d;
        for limb in n.iter_mut() {
            let v = *limb as u64 * 57 + carry;
            *limb = v as u32;
            carry = v >> 32;
        }
        if carry > 0 {
            n.push(carry as u32);
        }
    }
    let mut out = vec![0u8; len];
    for (i, limb) in n.iter().enumerate() {
        for b in 0..4 {
            let pos = i * 4 + b;
            let byte = (limb >> (8 * b)) as u8;
            if pos < len {
                out[len - 1 - pos] = byte;
            } else if byte != 0 {
                return None;
            }
        }
    }
    Some(out)
}

/// `bytes` (big-endian) as `count` base-57 characters, least significant first.
fn bytes_to_chars(bytes: &[u8], count: usize) -> String {
    let mut n: Vec<u8> = bytes.to_vec();
    let mut out = String::with_capacity(count);
    for _ in 0..count {
        let mut rem = 0u32;
        for b in n.iter_mut() {
            let v = (rem << 8) | *b as u32;
            *b = (v / 57) as u8;
            rem = v % 57;
        }
        out.push(DICTIONARY[rem as usize] as char);
    }
    out
}

fn checksum_ok(bytes: &[u8]) -> bool {
    bytes[1..].iter().map(|&b| b as u32).sum::<u32>() % 256 == bytes[0] as u32
}

/// Reads a crosshair share code (either container). None when it isn't a valid one.
pub fn decode(code: &str) -> Option<Crosshair> {
    let code = code.trim();
    if let Some(rest) = code.strip_prefix("CSGO") {
        let chars: String = rest.chars().filter(|&c| c != '-').collect();
        if chars.len() != 25 {
            return None;
        }
        let b = chars_to_bytes(&chars, 18)?;
        if !checksum_ok(&b) {
            return None;
        }
        return match b[1] {
            1 => Some(legacy_v1(&b)),
            3 | 4 => Some(legacy_pixel(&b)),
            _ => None,
        };
    }
    let chars = code.strip_prefix("CS")?;
    if chars.len() != 44 {
        return None;
    }
    let b = chars_to_bytes(chars, 32)?;
    if !checksum_ok(&b) || b[1] != 1 {
        return None;
    }
    let screen_height = b[2] as u16 | (b[3] as u16) << 8;
    if screen_height == 0 {
        return None;
    }
    let bits = b[18] as u32 | (b[19] as u32) << 8 | (b[20] as u32) << 16 | (b[21] as u32) << 24;
    Some(Crosshair {
        style: (b[4] & 0x1f).min(9),
        follow_recoil: b[4] & 0x20 != 0,
        dot: b[4] & 0x40 != 0,
        t_style: b[4] & 0x80 != 0,
        outline: (b[13] >> 6).min(2),
        color: [b[5], b[6], b[7], b[8]],
        outline_color: [b[9], b[10], b[11], b[12]],
        gap: (i16::from_le_bytes([b[14], b[15]]) as i32).clamp(-3840, 3840),
        length: b[16],
        thickness: (b[13] & 0x3f).min(32),
        spread_limit: b[17],
        split_distance: (bits & 0x7f) as u8,
        inner_split_alpha: ((bits >> 7) & 0x7f).min(100) as f32 / 100.0,
        outer_split_alpha: (((bits >> 14) & 0x7f).min(70) + 30) as f32 / 100.0,
        split_ratio: ((bits >> 21) & 0x7f).min(100) as f32 / 100.0,
        screen_height: screen_height.max(240),
        scope_dot_scale: ((b[22] as f32 + 10.0) / 100.0).min(2.0),
        scope_dot_color: (bits >> 28) & 1 == 1,
        format: "cs2",
    })
}

/// Defaults for what the old containers don't store.
fn base(format: &'static str) -> Crosshair {
    Crosshair {
        style: 4,
        follow_recoil: false,
        dot: false,
        t_style: false,
        outline: 0,
        color: [0, 255, 0, 255],
        outline_color: [0, 0, 0, 255],
        gap: 4,
        length: 8,
        thickness: 1,
        spread_limit: 255,
        split_distance: 3,
        inner_split_alpha: 0.0,
        outer_split_alpha: 1.0,
        split_ratio: 0.3,
        screen_height: 1080,
        scope_dot_scale: 1.0,
        scope_dot_color: false,
        format,
    }
}

/// The old container's pixel versions (3 and 4).
fn legacy_pixel(b: &[u8]) -> Crosshair {
    let bits = b[10] as u32 | (b[11] as u32) << 8 | (b[12] as u32) << 16 | (b[13] as u32) << 24;
    let outline = if b[1] == 4 { ((b[13] >> 4) & 3).min(2) } else { (b[2] & 0x20 != 0) as u8 };
    Crosshair {
        style: b[2] & 0xf,
        follow_recoil: b[2] & 0x10 != 0,
        dot: b[2] & 0x40 != 0,
        t_style: b[2] & 0x80 != 0,
        outline,
        color: [b[3], b[4], b[5], b[6]],
        gap: b[7] as i32,
        length: b[8],
        thickness: ((bits >> 23) & 0x1f) as u8,
        spread_limit: b[9],
        split_distance: (bits & 0x7f) as u8,
        inner_split_alpha: ((bits >> 7) & 0x1f) as f32 / 20.0,
        outer_split_alpha: (((bits >> 12) & 0xf) + 6) as f32 / 20.0,
        split_ratio: ((bits >> 16) & 0x7f) as f32 / 100.0,
        screen_height: (b[14] as u16 | (b[15] as u16) << 8).max(240),
        ..base("pixel")
    }
}

/// The CS:GO-era crosshair, converted to pixels at 1080 lines.
fn legacy_v1(b: &[u8]) -> Crosshair {
    let i8_ = |x: u8| x as i8 as f32;
    let gap = i8_(b[2]) / 10.0;
    let thickness = b[12] as f32 / 10.0;
    let length = b[14] as f32 / 10.0;
    let preset = b[10] & 7;
    let alpha_on = (b[13] >> 4) & 4 != 0;
    // Colours 0-4 are CS:GO's presets; 5 is the custom RGB.
    let rgb = match preset {
        0 => [250, 50, 50],
        1 => [50, 250, 50],
        2 => [250, 250, 50],
        3 => [50, 50, 250],
        4 => [50, 250, 250],
        _ => [b[4], b[5], b[6]],
    };
    let unit = 1080.0 / 480.0;
    let old_style = (b[13] & 0xf) >> 1;
    Crosshair {
        style: match old_style {
            4 => 4,
            5 => 2,
            _ => 0,
        },
        follow_recoil: (b[8] >> 4) & 8 != 0,
        dot: (b[13] >> 4) & 1 != 0,
        t_style: (b[13] >> 4) & 8 != 0,
        outline: ((b[10] & 8) != 0) as u8,
        color: [rgb[0], rgb[1], rgb[2], if alpha_on { b[7] } else { 255 }],
        gap: (2.0 * (4.0 + gap)).round() as i32,
        length: (length * unit).round().clamp(0.0, 255.0) as u8,
        thickness: (thickness * unit).round().clamp(1.0, 32.0) as u8,
        split_distance: b[8] & 7,
        inner_split_alpha: (b[10] >> 4) as f32 / 10.0,
        outer_split_alpha: ((b[11] & 0xf) as f32 / 10.0).max(0.3),
        split_ratio: (b[11] >> 4) as f32 / 10.0,
        ..base("csgo")
    }
}

/// The code CS2 imports today (`CS...`), for any crosshair.
pub fn encode(c: &Crosshair) -> String {
    let steps = |v: f32, lo: f32, hi: f32| (v.clamp(lo, hi) * 100.0).round() as u32;
    let bits = (c.split_distance.min(127) as u32)
        | steps(c.inner_split_alpha, 0.0, 1.0) << 7
        | (steps(c.outer_split_alpha, 0.3, 1.0) - 30) << 14
        | steps(c.split_ratio, 0.0, 1.0) << 21
        | (c.scope_dot_color as u32) << 28;
    let mut b = [0u8; 32];
    b[1] = 1;
    b[2..4].copy_from_slice(&c.screen_height.to_le_bytes());
    b[4] = c.style.min(9) | (c.follow_recoil as u8) << 5 | (c.dot as u8) << 6 | (c.t_style as u8) << 7;
    b[5..9].copy_from_slice(&c.color);
    b[9..13].copy_from_slice(&c.outline_color);
    b[13] = c.thickness.min(32) | c.outline.min(2) << 6;
    b[14..16].copy_from_slice(&(c.gap.clamp(-3840, 3840) as i16).to_le_bytes());
    b[16] = c.length;
    b[17] = c.spread_limit;
    b[18..22].copy_from_slice(&bits.to_le_bytes());
    b[22] = (steps(c.scope_dot_scale, 0.1, 2.0) - 10) as u8;
    b[0] = (b[1..].iter().map(|&x| x as u32).sum::<u32>() & 0xff) as u8;
    format!("CS{}", bytes_to_chars(&b, 44))
}

/// The console variables that set this crosshair in CS2.
pub fn convars(c: &Crosshair) -> Vec<(&'static str, String)> {
    let b = |v: bool| (if v { "true" } else { "false" }).to_string();
    let f = |v: f32| {
        let s = format!("{v:.2}");
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    };
    vec![
        ("cl_crosshairstyle", c.style.to_string()),
        ("cl_crosshair_recoil", b(c.follow_recoil)),
        ("cl_crosshairdot", b(c.dot)),
        ("cl_crosshair_t", b(c.t_style)),
        ("cl_crosshair_drawoutline", c.outline.to_string()),
        ("cl_crosshaircolor_r", c.color[0].to_string()),
        ("cl_crosshaircolor_g", c.color[1].to_string()),
        ("cl_crosshaircolor_b", c.color[2].to_string()),
        ("cl_crosshaircolor_a", c.color[3].to_string()),
        ("cl_crosshairoutline_r", c.outline_color[0].to_string()),
        ("cl_crosshairoutline_g", c.outline_color[1].to_string()),
        ("cl_crosshairoutline_b", c.outline_color[2].to_string()),
        ("cl_crosshairoutline_a", c.outline_color[3].to_string()),
        ("cl_crosshair_gap", c.gap.to_string()),
        ("cl_crosshair_length", c.length.to_string()),
        ("cl_crosshair_thickness", c.thickness.to_string()),
        ("cl_crosshair_dynamic_spread_limit", c.spread_limit.to_string()),
        ("cl_crosshair_dynamic_splitdist", c.split_distance.to_string()),
        ("cl_crosshair_dynamic_splitalpha_innermod", f(c.inner_split_alpha)),
        ("cl_crosshair_dynamic_splitalpha_outermod", f(c.outer_split_alpha)),
        ("cl_crosshair_dynamic_maxdist_splitratio", f(c.split_ratio)),
        ("cl_crosshair_screen_height", c.screen_height.to_string()),
        ("cl_ironsight_dot_scale", f(c.scope_dot_scale)),
        ("cl_ironsight_usecrosshaircolor", b(c.scope_dot_color)),
    ]
}

/// Sets these console variables in CS2's saved settings (`cs2_user_convars_0_slot0.vcfg`'s
/// text): each one's value is replaced where it's listed, or it's added to the `convars` block.
pub fn set_in_vcfg(text: &str, vars: &[(&str, String)]) -> String {
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    for (name, value) in vars {
        let key = format!("\"{name}\"");
        match lines.iter().position(|l| l.trim_start().starts_with(&key)) {
            Some(i) => {
                let indent: String = lines[i].chars().take_while(|c| c.is_whitespace()).collect();
                lines[i] = format!("{indent}{key}\t\t\"{value}\"");
            }
            None => {
                // Into the convars block, before its closing brace.
                let open = lines.iter().position(|l| l.trim() == "\"convars\"");
                let close = open.and_then(|o| (o..lines.len()).find(|&i| lines[i].trim() == "}"));
                match close {
                    Some(c) => lines.insert(c, format!("\t\t{key}\t\t\"{value}\"")),
                    None => {}
                }
            }
        }
    }
    // CS2 writes the file with Windows line endings: keep whichever it has.
    let nl = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let mut out = lines.join(nl);
    if text.ends_with('\n') {
        out.push_str(nl);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cs2_code_round_trips() {
        let c = Crosshair { style: 9, dot: true, outline: 2, color: [13, 255, 0, 200], gap: -3, length: 11, thickness: 5, screen_height: 1440, ..base("cs2") };
        let code = encode(&c);
        assert!(code.starts_with("CS") && code.len() == 46, "{code}");
        assert_eq!(decode(&code), Some(c));
    }

    #[test]
    fn library_example_decodes() {
        // The example code in csgo-sharecode's documentation.
        let c = decode("CSvbPubOq37zTGqtsPTP5QTrp5CB4xFXiKRLfzJsm49ZRe");
        assert!(c.is_some());
    }

    #[test]
    fn old_codes_decode_and_convert() {
        // A CS:GO-era code (a well-known pro crosshair) decodes and re-encodes as a CS2 code.
        let c = decode("CSGO-O4Jsi-V36wY-rTMGK-9w7qF-jQ8WB").expect("valid");
        assert_eq!(c.format, "csgo");
        let again = decode(&encode(&c)).unwrap();
        assert_eq!(again.length, c.length);
        assert_eq!(again.gap, c.gap);
    }

    #[test]
    fn vcfg_values_replaced_and_added() {
        let text = "\"config\"\n{\n\t\"convars\"\n\t{\n\t\t\"cl_crosshair_gap\"\t\t\"5\"\n\t}\n}\n";
        let out = set_in_vcfg(text, &[("cl_crosshair_gap", "-2".into()), ("cl_crosshair_length", "9".into())]);
        assert!(out.contains("\"cl_crosshair_gap\"\t\t\"-2\""));
        assert!(out.contains("\"cl_crosshair_length\"\t\t\"9\""));
        assert!(out.find("cl_crosshair_length").unwrap() < out.rfind('}').unwrap());
    }
}
