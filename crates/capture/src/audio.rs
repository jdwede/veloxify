//! Per-application audio: record one process's audio (Windows application loopback, so other
//! apps like Discord or Spotify are never recorded) and mute/unmute that process's sessions in
//! the Windows volume mixer so renders don't play through the user's speakers.

use anyhow::{Context, Result};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;
use wasapi::{AudioClient, Direction, SampleType, StreamMode, WaveFormat};
use windows::core::Interface;
use windows::Win32::Media::Audio::{
    eRender, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator, ISimpleAudioVolume,
    MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};

/// Active output devices as (Windows endpoint id, friendly name).
pub fn output_devices() -> Result<Vec<(String, String)>> {
    use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
    use windows::Win32::System::Com::STGM_READ;
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let devices = enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)?;
        let mut out = vec![];
        for i in 0..devices.GetCount()? {
            let device = devices.Item(i)?;
            let id = device.GetId()?.to_string()?;
            let props = device.OpenPropertyStore(STGM_READ)?;
            let name = props.GetValue(&PKEY_Device_FriendlyName)?.to_string();
            out.push((id, name));
        }
        Ok(out)
    }
}

pub const SAMPLE_RATE: u32 = 48_000;
pub const CHANNELS: u16 = 2;

/// Output devices on which `pid` has an audio session, with that session's highest peak level
/// (0.0-1.0) sampled over `sample_ms`. A silent session reads 0.0.
pub fn process_devices(pid: u32, sample_ms: u64) -> Result<Vec<(String, f32)>> {
    use windows::Win32::Media::Audio::Endpoints::IAudioMeterInformation;
    let names: std::collections::HashMap<String, String> = output_devices()?.into_iter().collect();
    unsafe {
        let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let devices = enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)?;
        let mut meters = vec![];
        for i in 0..devices.GetCount()? {
            let device = devices.Item(i)?;
            let id = device.GetId()?.to_string()?;
            let Ok(manager) = device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else { continue };
            let sessions = manager.GetSessionEnumerator()?;
            for j in 0..sessions.GetCount()? {
                let control = sessions.GetSession(j)?;
                let control2: IAudioSessionControl2 = control.cast()?;
                if control2.GetProcessId().unwrap_or(0) == pid {
                    let meter: IAudioMeterInformation = control.cast()?;
                    meters.push((names.get(&id).cloned().unwrap_or(id.clone()), meter, 0.0f32));
                }
            }
        }
        let until = Instant::now() + std::time::Duration::from_millis(sample_ms);
        while Instant::now() < until {
            for (_, meter, peak) in meters.iter_mut() {
                *peak = peak.max(meter.GetPeakValue().unwrap_or(0.0));
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        Ok(meters.into_iter().map(|(n, _, p)| (n, p)).collect())
    }
}

/// Mutes (or unmutes) every audio session of `pid` on every active output device.
/// Returns how many sessions were changed. Sessions only exist once the process has opened audio.
pub fn set_process_mute(pid: u32, mute: bool) -> Result<usize> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let devices = enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)?;
        let mut changed = 0;
        for i in 0..devices.GetCount()? {
            let device = devices.Item(i)?;
            let Ok(manager) = device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else { continue };
            let sessions = manager.GetSessionEnumerator()?;
            for j in 0..sessions.GetCount()? {
                let control = sessions.GetSession(j)?;
                let control2: IAudioSessionControl2 = control.cast()?;
                if control2.GetProcessId().unwrap_or(0) == pid {
                    let volume: ISimpleAudioVolume = control.cast()?;
                    volume.SetMute(mute, std::ptr::null())?;
                    changed += 1;
                }
            }
        }
        Ok(changed)
    }
}

/// Records `pid`'s audio (and its child processes') as 48 kHz stereo float until `stop` is set,
/// returning the instant the stream started so callers can align it with video. Silence is
/// written while the process plays nothing, so the file stays in step with wall-clock time.
pub fn record_process(pid: u32, out: &str, stop: Arc<AtomicBool>) -> Result<Instant> {
    let _ = wasapi::initialize_mta();
    let format = WaveFormat::new(32, 32, &SampleType::Float, SAMPLE_RATE as usize, CHANNELS as usize, None);
    let mut client = AudioClient::new_application_loopback_client(pid, true).context("application loopback")?;
    client.initialize_client(&format, &Direction::Capture, &StreamMode::EventsShared { autoconvert: true, buffer_duration_hns: 0 })?;
    let event = client.set_get_eventhandle()?;
    let capture = client.get_audiocaptureclient()?;
    let spec = hound::WavSpec {
        channels: CHANNELS,
        sample_rate: SAMPLE_RATE,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };
    let mut wav = hound::WavWriter::create(out, spec)?;
    let mut queue: VecDeque<u8> = VecDeque::new();
    client.start_stream()?;
    let started = Instant::now();
    while !stop.load(Ordering::SeqCst) {
        let _ = event.wait_for_event(100);
        if capture.get_next_packet_size()?.unwrap_or(0) > 0 {
            capture.read_from_device_to_deque(&mut queue)?;
        }
        while queue.len() >= 4 {
            let b: Vec<u8> = queue.drain(..4).collect();
            wav.write_sample(f32::from_le_bytes([b[0], b[1], b[2], b[3]]))?;
        }
        let written_frames = wav.len() as u64 / CHANNELS as u64;
        // Application loopback delivers nothing while the app is silent: pad with silence so the
        // audio timeline keeps pace with real time.
        let due = (started.elapsed().as_secs_f64() * SAMPLE_RATE as f64) as u64;
        if due > written_frames + SAMPLE_RATE as u64 / 10 {
            for _ in written_frames..due {
                wav.write_sample(0.0f32)?;
                wav.write_sample(0.0f32)?;
            }
        }
    }
    client.stop_stream()?;
    wav.finalize()?;
    Ok(started)
}
