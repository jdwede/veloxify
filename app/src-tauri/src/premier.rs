//! Premier (and Competitive) matches without downloading them in CS2: after you close CS2,
//! Veloxify asks Valve's matchmaking servers for your recent matches, through your own Steam,
//! and downloads the demos it doesn't have yet into its demos folder (imported like any other).
//!
//! The asking runs in a short-lived copy of Veloxify (`veloxify --premier-matches <out.json>`):
//! it loads CS2's own `steam_api64.dll` as app 730, so Steam briefly shows you in CS2 while it
//! runs (a few seconds), and it can't while CS2 itself is open. The same way CS Demo Manager does
//! it (boiler-writter).

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::ffi::c_void;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// What the helper writes: the logged-in account and its recent matchmaking matches.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct MatchList {
    pub steamid: String,
    pub matches: Vec<RecentMatch>,
    #[serde(default)]
    pub error: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RecentMatch {
    pub matchid: u64,
    /// Unix seconds.
    pub matchtime: u32,
    /// The demo on Valve's replay servers (`http://replayNNN.valve.net/730/<id>_<n>.dem.bz2`).
    pub url: String,
    /// Players' Steam account ids (10 in a 5v5, 4 in Wingman).
    pub players: Vec<u32>,
    pub game_type: u32,
    /// Each player's party (same order as `players`): players who queued together share one.
    #[serde(default)]
    pub parties: Vec<u32>,
    /// The match's CDataGCCStrike15_v2_MatchInfo, hex: saved as `<demo>.info` beside the demo, as
    /// CS2 does, so the import knows when it was played.
    #[serde(default)]
    pub info: String,
}

// ---- the helper: asking the game coordinator ---------------------------------------------------

const PROTO: u32 = 0x8000_0000;
const MSG_CLIENT_HELLO: u32 = 4006;
const MSG_CLIENT_WELCOME: u32 = 4004;
const MSG_MATCH_LIST: u32 = 9139;
const MSG_REQUEST_RECENT_USER_GAMES: u32 = 9141;

type Fn0 = unsafe extern "C" fn();
type FnI32 = unsafe extern "C" fn() -> i32;
type FnPtr = unsafe extern "C" fn() -> *mut c_void;
type FnInit = unsafe extern "C" fn(*mut u8) -> i32;
type FnGeneric = unsafe extern "C" fn(*mut c_void, i32, i32, *const u8) -> *mut c_void;
type FnSteamId = unsafe extern "C" fn(*mut c_void) -> u64;
type FnBool = unsafe extern "C" fn(*mut c_void) -> bool;
// ISteamGameCoordinator's methods, in vtable order.
type GcSend = unsafe extern "C" fn(*mut c_void, u32, *const u8, u32) -> i32;
type GcAvailable = unsafe extern "C" fn(*mut c_void, *mut u32) -> bool;
type GcRetrieve = unsafe extern "C" fn(*mut c_void, *mut u32, *mut u8, u32, *mut u32) -> i32;

/// `veloxify --premier-matches <out.json>`: writes [`MatchList`] (or its error) and exits.
pub fn helper_main(out: &Path) -> i32 {
    let list = match ask_game_coordinator() {
        Ok(l) => l,
        Err(e) => MatchList { error: format!("{e:#}"), ..Default::default() },
    };
    let code = if list.error.is_empty() { 0 } else { 1 };
    let _ = std::fs::write(out, serde_json::to_string(&list).unwrap_or_default());
    code
}

fn ask_game_coordinator() -> Result<MatchList> {
    use windows::core::{PCSTR, PCWSTR};
    use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryExW, LOAD_WITH_ALTERED_SEARCH_PATH};
    let csgo = cs2hl_render::steam::cs2_csgo_dir().context("CS2 isn't installed")?;
    let dll = csgo.parent().unwrap_or(&csgo).join("bin").join("win64").join("steam_api64.dll");
    if !dll.exists() {
        bail!("CS2's steam_api64.dll wasn't found at {}", dll.display());
    }
    // Steam reads the app from these (or steam_appid.txt next to the working directory).
    let work = std::env::temp_dir().join("veloxify-premier");
    let _ = std::fs::create_dir_all(&work);
    let _ = std::fs::write(work.join("steam_appid.txt"), "730");
    let _ = std::env::set_current_dir(&work);
    std::env::set_var("SteamAppId", "730");
    std::env::set_var("SteamGameId", "730");
    let wide: Vec<u16> = dll.as_os_str().encode_wide_null();
    let lib = unsafe { LoadLibraryExW(PCWSTR(wide.as_ptr()), None, LOAD_WITH_ALTERED_SEARCH_PATH) }.context("loading steam_api64.dll")?;
    let sym = |name: &str| -> Result<unsafe extern "system" fn() -> isize> {
        let c = format!("{name}\0");
        unsafe { GetProcAddress(lib, PCSTR(c.as_ptr())) }.ok_or_else(|| anyhow!("steam_api64.dll has no {name}"))
    };
    unsafe {
        let init: FnInit = std::mem::transmute(sym("SteamAPI_InitFlat")?);
        let run_callbacks: Fn0 = std::mem::transmute(sym("SteamAPI_RunCallbacks")?);
        let shutdown: Fn0 = std::mem::transmute(sym("SteamAPI_Shutdown")?);
        let h_user: FnI32 = std::mem::transmute(sym("SteamAPI_GetHSteamUser")?);
        let h_pipe: FnI32 = std::mem::transmute(sym("SteamAPI_GetHSteamPipe")?);
        let client: FnPtr = std::mem::transmute(sym("SteamClient")?);
        let generic: FnGeneric = std::mem::transmute(sym("SteamAPI_ISteamClient_GetISteamGenericInterface")?);
        let user: FnPtr = std::mem::transmute(sym("SteamAPI_SteamUser_v023")?);
        let steam_id: FnSteamId = std::mem::transmute(sym("SteamAPI_ISteamUser_GetSteamID")?);
        let logged_on: FnBool = std::mem::transmute(sym("SteamAPI_ISteamUser_BLoggedOn")?);

        let mut err = [0u8; 1024];
        let r = init(err.as_mut_ptr());
        if r != 0 {
            let msg = String::from_utf8_lossy(&err[..err.iter().position(|&b| b == 0).unwrap_or(0)]).into_owned();
            bail!("Steam isn't running or isn't logged in ({r}: {msg})");
        }
        let result = (|| -> Result<MatchList> {
            let u = user();
            if u.is_null() || !logged_on(u) {
                bail!("Steam isn't logged in");
            }
            let sid = steam_id(u);
            let gc = generic(client(), h_user(), h_pipe(), b"SteamGameCoordinator001\0".as_ptr());
            if gc.is_null() {
                bail!("Steam's game coordinator interface isn't available");
            }
            let vt = *(gc as *const *const usize);
            let send: GcSend = std::mem::transmute(*vt.add(0));
            let available: GcAvailable = std::mem::transmute(*vt.add(1));
            let retrieve: GcRetrieve = std::mem::transmute(*vt.add(2));
            let send_msg = |kind: u32, body: &[u8]| -> bool {
                let mut buf = Vec::with_capacity(body.len() + 8);
                buf.extend_from_slice(&(kind | PROTO).to_le_bytes());
                buf.extend_from_slice(&0u32.to_le_bytes());
                buf.extend_from_slice(body);
                send(gc, kind | PROTO, buf.as_ptr(), buf.len() as u32) == 0
            };
            // Messages until `want` arrives (or the time's up): its body.
            let wait_for = |want: u32, secs: u64| -> Option<Vec<u8>> {
                let until = Instant::now() + Duration::from_secs(secs);
                while Instant::now() < until {
                    run_callbacks();
                    let mut size = 0u32;
                    while available(gc, &mut size) {
                        let mut buf = vec![0u8; size.max(8) as usize];
                        let (mut kind, mut got) = (0u32, 0u32);
                        if retrieve(gc, &mut kind, buf.as_mut_ptr(), buf.len() as u32, &mut got) != 0 {
                            break;
                        }
                        buf.truncate(got as usize);
                        if kind & PROTO != 0 && kind & !PROTO == want && buf.len() >= 8 {
                            let header = u32::from_le_bytes(buf[4..8].try_into().unwrap()) as usize;
                            return Some(buf.get(8 + header..).unwrap_or_default().to_vec());
                        }
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                None
            };
            let request = {
                let mut b = vec![0x08];
                varint(&mut b, (sid & 0xffff_ffff) as u64);
                b
            };
            // The game coordinator needs a moment after Steam starts the session.
            let _ = wait_for(0, 1);
            let mut body = None;
            if send_msg(MSG_REQUEST_RECENT_USER_GAMES, &request) {
                body = wait_for(MSG_MATCH_LIST, 8);
            }
            if body.is_none() {
                // Say hello like the game does, then ask again.
                send_msg(MSG_CLIENT_HELLO, &[]);
                let _ = wait_for(MSG_CLIENT_WELCOME, 8);
                if send_msg(MSG_REQUEST_RECENT_USER_GAMES, &request) {
                    body = wait_for(MSG_MATCH_LIST, 12);
                }
            }
            let body = body.ok_or_else(|| anyhow!("Valve's matchmaking servers didn't answer (is CS2 open?)"))?;
            if std::env::var_os("VELOXIFY_PREMIER_RAW").is_some() {
                let _ = std::fs::write(std::env::temp_dir().join("veloxify-premier-raw.bin"), &body);
            }
            Ok(MatchList { steamid: sid.to_string(), matches: parse_match_list(&body), error: String::new() })
        })();
        shutdown();
        result
    }
}

trait WideNull {
    fn encode_wide_null(&self) -> Vec<u16>;
}
impl WideNull for std::ffi::OsStr {
    fn encode_wide_null(&self) -> Vec<u16> {
        use std::os::windows::ffi::OsStrExt;
        self.encode_wide().chain(std::iter::once(0)).collect()
    }
}

// ---- protobuf, just enough ---------------------------------------------------------------------

fn varint(out: &mut Vec<u8>, mut v: u64) {
    while v >= 0x80 {
        out.push((v as u8) | 0x80);
        v >>= 7;
    }
    out.push(v as u8);
}

enum Val<'a> {
    Int(u64),
    Bytes(&'a [u8]),
}

/// A message's fields in order: (field number, value). Stops at anything malformed.
fn fields(mut b: &[u8]) -> Vec<(u32, Val<'_>)> {
    fn read_varint(b: &mut &[u8]) -> Option<u64> {
        let mut v = 0u64;
        for i in 0..10 {
            let (&byte, rest) = b.split_first()?;
            *b = rest;
            v |= ((byte & 0x7f) as u64) << (7 * i);
            if byte < 0x80 {
                return Some(v);
            }
        }
        None
    }
    let mut out = vec![];
    while !b.is_empty() {
        let Some(key) = read_varint(&mut b) else { break };
        let (num, wire) = ((key >> 3) as u32, key & 7);
        match wire {
            0 => match read_varint(&mut b) {
                Some(v) => out.push((num, Val::Int(v))),
                None => break,
            },
            1 => {
                if b.len() < 8 {
                    break;
                }
                out.push((num, Val::Int(u64::from_le_bytes(b[..8].try_into().unwrap()))));
                b = &b[8..];
            }
            2 => {
                let Some(len) = read_varint(&mut b) else { break };
                let len = len as usize;
                if b.len() < len {
                    break;
                }
                out.push((num, Val::Bytes(&b[..len])));
                b = &b[len..];
            }
            5 => {
                if b.len() < 4 {
                    break;
                }
                out.push((num, Val::Int(u32::from_le_bytes(b[..4].try_into().unwrap()) as u64)));
                b = &b[4..];
            }
            _ => break,
        }
    }
    out
}

/// Repeated varints, packed or not.
fn ints(fs: &[(u32, Val<'_>)], num: u32) -> Vec<u64> {
    let mut out = vec![];
    for (n, v) in fs {
        if *n != num {
            continue;
        }
        match v {
            Val::Int(i) => out.push(*i),
            Val::Bytes(mut b) => {
                while !b.is_empty() {
                    let mut v = 0u64;
                    let mut ok = false;
                    for i in 0..10 {
                        let Some((&byte, rest)) = b.split_first() else { break };
                        b = rest;
                        v |= ((byte & 0x7f) as u64) << (7 * i);
                        if byte < 0x80 {
                            ok = true;
                            break;
                        }
                    }
                    if !ok {
                        break;
                    }
                    out.push(v);
                }
            }
        }
    }
    out
}

fn int(fs: &[(u32, Val<'_>)], num: u32) -> u64 {
    fs.iter().rev().find_map(|(n, v)| (*n == num).then_some(v)).and_then(|v| if let Val::Int(i) = v { Some(*i) } else { None }).unwrap_or(0)
}

fn msgs<'a>(fs: &[(u32, Val<'a>)], num: u32) -> Vec<&'a [u8]> {
    fs.iter().filter(|(n, _)| *n == num).filter_map(|(_, v)| if let Val::Bytes(b) = v { Some(*b) } else { None }).collect()
}

/// CMsgGCCStrike15_v2_MatchList: matches (4) -> CDataGCCStrike15_v2_MatchInfo: matchid (1),
/// matchtime (2), roundstatsall (5, the last is the final score) -> map (3, the demo's address),
/// reservation (2) -> account_ids (1), game_type (2), party_ids (8).
fn parse_match_list(body: &[u8]) -> Vec<RecentMatch> {
    let top = fields(body);
    msgs(&top, 4)
        .into_iter()
        .filter_map(|m| {
            let mf = fields(m);
            let rounds = msgs(&mf, 5);
            let last = fields(rounds.last()?);
            let url = msgs(&last, 3).first().map(|b| String::from_utf8_lossy(b).into_owned()).unwrap_or_default();
            // The players are in a round stats' reservation (the first, or the legacy one).
            let reservation = rounds
                .iter()
                .chain(msgs(&mf, 4).iter())
                .map(|r| fields(r))
                .filter_map(|f| msgs(&f, 2).first().map(|b| fields(b)))
                .max_by_key(|r| (ints(r, 8).len(), ints(r, 1).len()));
            let (players, game_type, parties) = reservation
                .map(|r| (ints(&r, 1).into_iter().map(|v| v as u32).collect(), int(&r, 2) as u32, ints(&r, 8).into_iter().map(|v| v as u32).collect()))
                .unwrap_or_default();
            let info = m.iter().map(|b| format!("{b:02x}")).collect();
            Some(RecentMatch { matchid: int(&mf, 1), matchtime: int(&mf, 2) as u32, url, players, game_type, parties, info })
        })
        .filter(|m| m.matchid != 0)
        .collect()
}

// ---- in the app: run the helper, download what's new -------------------------------------------

/// Runs the helper and reads its answer.
pub fn recent_matches() -> Result<MatchList> {
    use std::os::windows::process::CommandExt;
    let out = std::env::temp_dir().join(format!("veloxify-premier-{}.json", std::process::id()));
    let _ = std::fs::remove_file(&out);
    let mut child = std::process::Command::new(std::env::current_exe()?)
        .arg("--premier-matches")
        .arg(&out)
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .spawn()
        .context("starting the Premier helper")?;
    let until = Instant::now() + Duration::from_secs(45);
    loop {
        if child.try_wait()?.is_some() {
            break;
        }
        if Instant::now() > until {
            let _ = child.kill();
            bail!("Valve's matchmaking servers took too long to answer");
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    let list: MatchList = serde_json::from_str(&std::fs::read_to_string(&out).context("the Premier helper wrote nothing")?)?;
    let _ = std::fs::remove_file(&out);
    if !list.error.is_empty() {
        bail!("{}", list.error);
    }
    Ok(list)
}

/// What happened to each recent match (`premier.json` in the library), so a demo isn't fetched
/// twice and one Valve no longer has isn't tried forever.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct State {
    /// library match id (`valve-<n>`) -> "downloaded", "have" (already in the library), "gone" (Valve no longer has the
    /// demo), "wingman" (not filmed), or "waiting" (not uploaded yet: tried again soon).
    pub matches: BTreeMap<String, String>,
    #[serde(default)]
    pub checked_at: i64,
    /// Who queued together, from Valve: library match id (`valve-<n>`) -> SteamID64 -> party.
    /// The match page's party tabs use it (Premier demos don't record parties).
    #[serde(default)]
    pub parties: BTreeMap<String, BTreeMap<String, u32>>,
}

impl State {
    pub fn load(lib: &Path) -> Self {
        std::fs::read_to_string(lib.join("premier.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    }
    fn save(&self, lib: &Path) {
        let _ = std::fs::write(lib.join("premier.json"), serde_json::to_string_pretty(self).unwrap_or_default());
    }
}

/// A Steam account id plus this is its SteamID64.
const STEAMID64_BASE: u64 = 76_561_197_960_265_728;

/// The demo's file name as CS2 names a downloaded one (`match730_<id>_<n>_<server>`), compressed.
fn file_name(url: &str) -> Option<String> {
    let base = url.rsplit('/').next()?.strip_suffix(".dem.bz2")?;
    let server = url.split("//replay").nth(1)?.split('.').next()?;
    Some(format!("match730_{base}_{server}.dem.bz2"))
}

pub struct Fetched {
    pub downloaded: usize,
    /// Some match's demo isn't on Valve's servers yet: ask again in a few minutes.
    pub waiting: bool,
}

/// Asks for the recent matches and downloads the new ones' demos into `dest`. `stop` is checked
/// during downloads (CS2 opened): a partial download is thrown away and done again next time.
pub fn fetch_new(lib: &Path, me: u64, dest: &Path, stop: &dyn Fn() -> bool, progress: &dyn Fn(usize, usize)) -> Result<Fetched> {
    let list = recent_matches()?;
    if list.steamid != me.to_string() {
        bail!("Steam is logged in to a different account ({})", list.steamid);
    }
    let mut state = State::load(lib);
    state.checked_at = chrono::Utc::now().timestamp();
    let now = state.checked_at;
    let mut todo = vec![];
    for m in &list.matches {
        // The library's id for it (`valve-<n>`, from the demo's name, as CS2 names it).
        let name = file_name(&m.url);
        let id = name.as_deref().map(cs2hl_core::library::demo_id).unwrap_or_else(|| format!("match-{}", m.matchid));
        if !m.parties.is_empty() && m.parties.len() == m.players.len() {
            let who = m.players.iter().zip(&m.parties).map(|(a, p)| ((STEAMID64_BASE + *a as u64).to_string(), *p)).collect();
            state.parties.insert(id.clone(), who);
        }
        let done = state.matches.get(&id).map(String::as_str);
        if matches!(done, Some("downloaded" | "have" | "gone" | "wingman")) {
            continue;
        }
        if lib.join("matches").join(format!("{id}.json")).exists() {
            state.matches.insert(id, "have".into());
            continue;
        }
        if m.players.len() < 10 && !m.players.is_empty() {
            state.matches.insert(id, "wingman".into());
            continue;
        }
        let Some(name) = name else {
            // No address yet: the demo isn't uploaded (or the match is still going).
            state.matches.insert(id, if now - (m.matchtime as i64) < 86_400 { "waiting" } else { "gone" }.into());
            continue;
        };
        if dest.join(&name).exists() {
            state.matches.insert(id, "downloaded".into());
            continue;
        }
        todo.push((id, m.clone(), name));
    }
    state.save(lib);
    let mut fetched = Fetched { downloaded: 0, waiting: state.matches.values().any(|s| s == "waiting") };
    let total = todo.len();
    for (i, (id, m, name)) in todo.into_iter().enumerate() {
        if stop() {
            break;
        }
        progress(i, total);
        // When it was played (the import reads it from here), before the demo itself appears.
        let info: Vec<u8> = (0..m.info.len() / 2).filter_map(|i| u8::from_str_radix(&m.info[i * 2..i * 2 + 2], 16).ok()).collect();
        if !info.is_empty() {
            let _ = std::fs::write(dest.join(format!("{name}.info")), &info);
        }
        match download(&m.url, &dest.join(&name), stop) {
            Ok(true) => {
                state.matches.insert(id, "downloaded".into());
                fetched.downloaded += 1;
            }
            Ok(false) => break, // stopped
            Err(e) => {
                let missing = e.to_string().contains("404");
                // Uploaded a few minutes after the match; Valve keeps demos a few weeks.
                let status = if !missing { "waiting" } else if now - (m.matchtime as i64) < 86_400 { "waiting" } else { "gone" };
                vlog!("premier: {name}: {e:#} ({status})");
                state.matches.insert(id, status.into());
                fetched.waiting |= status == "waiting";
            }
        }
        state.save(lib);
    }
    Ok(fetched)
}

/// Downloads to `<file>.part`, then renames. False when stopped.
fn download(url: &str, file: &PathBuf, stop: &dyn Fn() -> bool) -> Result<bool> {
    use std::io::{Read, Write};
    let resp = ureq::get(url).timeout(Duration::from_secs(600)).call().map_err(|e| match e {
        ureq::Error::Status(code, _) => anyhow!("HTTP {code}"),
        e => anyhow!(e),
    })?;
    let part = file.with_extension("bz2.part");
    let mut out = std::fs::File::create(&part)?;
    let mut body = resp.into_reader();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        if stop() {
            drop(out);
            let _ = std::fs::remove_file(&part);
            return Ok(false);
        }
        let n = body.read(&mut buf)?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n])?;
    }
    out.flush()?;
    drop(out);
    std::fs::rename(&part, file)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_the_file_like_cs2() {
        assert_eq!(
            file_name("http://replay129.valve.net/730/003732577077749088281_0425699953.dem.bz2").as_deref(),
            Some("match730_003732577077749088281_0425699953_129.dem.bz2")
        );
        assert_eq!(cs2hl_core::library::demo_id("match730_003732577077749088281_0425699953_129.dem.bz2"), "valve-003732577077749088281");
    }

    #[test]
    fn reads_a_match_list() {
        // matches { matchid: 5, matchtime: 7, roundstatsall { reservation { account_ids: [1, 2] game_type: 8 } }, roundstatsall { map: "http://replay1.valve.net/730/x_1.dem.bz2" } }
        let reservation = [0x08, 0x01, 0x08, 0x02, 0x10, 0x08, 0x40, 0x09, 0x40, 0x09];
        let mut r1 = vec![0x12, reservation.len() as u8];
        r1.extend_from_slice(&reservation);
        let url = b"http://replay1.valve.net/730/x_1.dem.bz2";
        let mut r2 = vec![0x1a, url.len() as u8];
        r2.extend_from_slice(url);
        let mut m = vec![0x08, 0x05, 0x10, 0x07];
        m.push(0x2a);
        m.push(r1.len() as u8);
        m.extend_from_slice(&r1);
        m.push(0x2a);
        m.push(r2.len() as u8);
        m.extend_from_slice(&r2);
        let mut top = vec![0x22, m.len() as u8];
        top.extend_from_slice(&m);
        let list = parse_match_list(&top);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].matchid, 5);
        assert_eq!(list[0].matchtime, 7);
        assert_eq!(list[0].players, vec![1, 2]);
        assert_eq!(list[0].game_type, 8);
        assert_eq!(list[0].parties, vec![9, 9]);
        assert_eq!(list[0].url, "http://replay1.valve.net/730/x_1.dem.bz2");
    }
}
