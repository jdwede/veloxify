//! Client for Valve's VConsole2 protocol (TCP 29000), the channel CS2's own developer console tool
//! uses. It lets us run console commands and read console output without the game having focus
//! (Valve disables `-netconport` in retail CS2).
//!
//! Packet header (12 bytes, big endian): 4-byte ASCII type, u16 version, u32 total length
//! (including the header), u16 handle. Commands are `CMND` packets with a NUL-terminated string;
//! console output arrives as `PRNT` packets whose text starts 28 bytes into the payload.
//! (Reverse-engineered from CS2 build 10924, Oct 2026.)

use anyhow::{bail, Result};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const VERSION: u16 = 0x00D4;
const HEADER: usize = 12;
const PRNT_TEXT_OFFSET: usize = 28;

pub struct VConsole {
    stream: TcpStream,
    lines: Arc<Mutex<Vec<String>>>,
    alive: Arc<AtomicBool>,
}

impl VConsole {
    /// Connects to CS2's console port, retrying until `timeout` (CS2 opens it during startup).
    pub fn connect(timeout: Duration) -> Result<Self> {
        let deadline = Instant::now() + timeout;
        let stream = loop {
            match TcpStream::connect_timeout(&"127.0.0.1:29000".parse()?, Duration::from_secs(3)) {
                Ok(s) => break s,
                Err(_) if Instant::now() < deadline => std::thread::sleep(Duration::from_secs(1)),
                Err(e) => bail!("CS2 console port never opened: {e}"),
            }
        };
        let lines = Arc::new(Mutex::new(Vec::new()));
        let alive = Arc::new(AtomicBool::new(true));
        let mut reader = stream.try_clone()?;
        let (l2, a2) = (lines.clone(), alive.clone());
        std::thread::spawn(move || {
            let mut header = [0u8; HEADER];
            loop {
                if reader.read_exact(&mut header).is_err() {
                    break;
                }
                let len = u32::from_be_bytes([header[6], header[7], header[8], header[9]]) as usize;
                let mut payload = vec![0u8; len.saturating_sub(HEADER)];
                if reader.read_exact(&mut payload).is_err() {
                    break;
                }
                if &header[..4] == b"PRNT" && payload.len() > PRNT_TEXT_OFFSET {
                    let text = &payload[PRNT_TEXT_OFFSET..];
                    let end = text.iter().position(|&b| b == 0).unwrap_or(text.len());
                    let s = String::from_utf8_lossy(&text[..end]);
                    let mut lines = l2.lock().unwrap();
                    lines.extend(s.lines().map(str::trim_end).filter(|l| !l.trim().is_empty()).map(String::from));
                }
            }
            a2.store(false, Ordering::SeqCst);
        });
        Ok(Self { stream, lines, alive })
    }

    pub fn alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    pub fn send(&self, cmd: &str) {
        let mut packet = Vec::with_capacity(HEADER + cmd.len() + 1);
        packet.extend_from_slice(b"CMND");
        packet.extend_from_slice(&VERSION.to_be_bytes());
        packet.extend_from_slice(&((HEADER + cmd.len() + 1) as u32).to_be_bytes());
        packet.extend_from_slice(&0u16.to_be_bytes());
        packet.extend_from_slice(cmd.as_bytes());
        packet.push(0);
        let _ = (&self.stream).write_all(&packet);
    }

    /// Position in the output, so waits can ignore older lines.
    pub fn mark(&self) -> usize {
        self.lines.lock().unwrap().len()
    }

    /// First line after `since` containing any of `needles`.
    pub fn wait_for_any(&self, needles: &[&str], timeout: Duration, since: usize) -> Option<String> {
        let deadline = Instant::now() + timeout;
        let mut seen = since;
        while Instant::now() < deadline {
            {
                let lines = self.lines.lock().unwrap();
                if let Some(l) = lines.iter().skip(seen).find(|l| needles.iter().any(|n| l.contains(n))) {
                    return Some(l.clone());
                }
                seen = lines.len().max(seen);
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        None
    }

    pub fn wait_for(&self, needle: &str, timeout: Duration, since: usize) -> Option<String> {
        self.wait_for_any(&[needle], timeout, since)
    }

    /// Current value of a console variable (empty values print as `name =`).
    pub fn read_cvar(&self, name: &str) -> Option<String> {
        let since = self.mark();
        self.send(name);
        let prefix = format!("{name} =");
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            for line in self.lines_since(since) {
                // The name must not be the tail of a longer one (e.g. "volume" in "voice_volume").
                if let Some(i) = line.find(&prefix) {
                    let before = line[..i].chars().last();
                    if !before.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_') {
                        return Some(line[i + prefix.len()..].trim().to_string());
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        None
    }

    pub fn lines_since(&self, since: usize) -> Vec<String> {
        self.lines.lock().unwrap().iter().skip(since).cloned().collect()
    }
}
