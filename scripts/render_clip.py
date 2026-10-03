"""Render one highlight from a demo, in the background, using a render profile.

usage: python scripts/render_clip.py <demo.dem> <accountid> <segments> <out.mp4> [profile.json]
  segments: comma-separated tick ranges, e.g. "114239-115109,115453-115901"

CS2 runs as a borderless window parked off-screen, is controlled over VConsole and recorded with
Windows Graphics Capture (cs2hl-capture). Nothing is typed into the game and it never needs focus.

User settings are protected three ways:
- cs2_video.txt is swapped for the render and restored after CS2 has exited;
- console settings the profile changes are read first and set back before CS2 quits, so CS2 only
  ever saves (and syncs to Steam Cloud) the user's own values; a journal file lets the next run
  finish the job if this one crashes;
- the whole cfg folder is backed up to out/ before anything is touched.
(Throwaway prototype; the real pipeline will live in Rust.)
"""

import ctypes
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(__file__))
from vconsole import VConsole  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
STEAM = r"C:\Program Files (x86)\Steam\steam.exe"
USER_CFG = r"C:\Program Files (x86)\Steam\userdata\{acc}\730\local\cfg"
CAPTURE = os.path.join(ROOT, "target", "release", "cs2hl-capture.exe")
JOURNAL = os.path.join(ROOT, "out", "cvar-journal.json")
WINDOW_TITLE = "Counter-Strike 2"
TICKRATE = 64
SETTLE_S = 1.0  # recorded before each segment so the game settles after seeking; trimmed off later

user32 = ctypes.windll.user32
user32.SetProcessDPIAware()


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def cs2_running():
    out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq cs2.exe", "/NH"], capture_output=True, text=True).stdout
    return "cs2.exe" in out


# ---- cs2_video.txt ------------------------------------------------------------------------------

def apply_video(user_cfg, profile):
    """CS2 lets cs2_video.txt override -windowed, so the render profile's video settings (plus a
    borderless window at the output size) go into that file for the render."""
    path = os.path.join(user_cfg, "cs2_video.txt")
    orig = path + ".cs2hl-orig"
    if not os.path.exists(orig):
        shutil.copy2(path, orig)
    o = profile["output"]
    overrides = {k: v for k, v in profile["video"].items() if not k.startswith("_")}
    overrides.update({
        "setting.fullscreen": "0", "setting.coop_fullscreen": "0", "setting.nowindowborder": "1",
        "setting.defaultres": str(o["width"]), "setting.defaultresheight": str(o["height"]),
    })
    with open(orig, encoding="utf-8", newline="") as f:
        text = f.read()
    for key, val in overrides.items():
        # Replace only the quoted value, keeping the file's own whitespace and line endings.
        text, n = re.subn(r'("%s"\s+")[^"]*(")' % re.escape(key), lambda m: m.group(1) + val + m.group(2), text)
        if n == 0:
            text = text.replace("\n}", f'\n\t"{key}"\t\t"{val}"\n}}', 1)
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(text)


def restore_video(user_cfg):
    path = os.path.join(user_cfg, "cs2_video.txt")
    orig = path + ".cs2hl-orig"
    if os.path.exists(orig):
        shutil.copy2(orig, path)
        os.remove(orig)
        log("restored your cs2_video.txt")


# ---- console settings -----------------------------------------------------------------------------

def read_cvar(vc, name):
    n = len(vc.lines)
    vc.send(name)
    deadline = time.time() + 3
    # Empty values print as "name =" with nothing after, so the value part is optional.
    pat = re.compile(r"%s =(?: (.*))?$" % re.escape(name))
    while time.time() < deadline:
        for line in vc.lines[n:]:
            m = pat.search(line)
            if m:
                return (m.group(1) or "").strip()
        time.sleep(0.05)
    return None


def apply_console(vc, profile):
    wanted = {k: v for k, v in profile["console"].items() if not k.startswith("_")}
    pending = {}
    if os.path.exists(JOURNAL):  # a previous run crashed before reverting: keep its originals
        with open(JOURNAL) as f:
            pending = json.load(f)
    originals = dict(pending)
    for name in wanted:
        if name not in originals:
            val = read_cvar(vc, name)
            if val is not None:
                originals[name] = val
    with open(JOURNAL, "w") as f:
        json.dump(originals, f, indent=1)
    for name, val in wanted.items():
        vc.send(f'{name} "{val}"')  # quoted: values like device ids contain braces
    return originals


def revert_console(vc, originals):
    for name, val in originals.items():
        vc.send(f'{name} "{val}"')
    time.sleep(0.5)
    if os.path.exists(JOURNAL):
        os.remove(JOURNAL)
    log(f"put back {len(originals)} console settings")


# ---- window ---------------------------------------------------------------------------------------

def park_offscreen():
    """Move CS2 past the right edge of the virtual desktop without activating it. Windows Graphics
    Capture still receives frames for windows outside the visible desktop."""
    hwnd = user32.FindWindowW(None, WINDOW_TITLE)
    right = user32.GetSystemMetrics(76) + user32.GetSystemMetrics(78) + 100  # SM_XVIRTUALSCREEN + SM_CXVIRTUALSCREEN
    user32.SetWindowPos(hwnd, 1, right, 0, 0, 0, 0x1 | 0x10)  # HWND_BOTTOM, SWP_NOSIZE | SWP_NOACTIVATE
    return hwnd


# ---- main -----------------------------------------------------------------------------------------

def silent_device_id(name):
    """Windows endpoint id of the output device whose name contains `name` (e.g. Steam Streaming
    Speakers, a virtual device that plays to nothing), or None if it isn't installed."""
    out = subprocess.run([CAPTURE, "devices"], capture_output=True, text=True).stdout
    for line in out.splitlines():
        dev_id, _, dev_name = line.partition("\t")
        if name.lower() in dev_name.lower():
            return dev_id
    return None


def cs2_pid():
    out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq cs2.exe", "/FO", "CSV", "/NH"], capture_output=True, text=True).stdout
    m = re.search(r'"cs2\.exe","(\d+)"', out)
    return int(m.group(1)) if m else None


def main():
    demo, acc, segs, out = sys.argv[1], int(sys.argv[2]), sys.argv[3], os.path.abspath(sys.argv[4])
    profile_path = sys.argv[5] if len(sys.argv) > 5 else os.path.join(ROOT, "profiles", "default.json")
    with open(profile_path) as f:
        profile = json.load(f)
    segments = [tuple(map(int, s.split("-"))) for s in segs.split(",")]
    demo = os.path.abspath(demo)
    user_cfg = USER_CFG.format(acc=acc)
    if cs2_running():
        raise SystemExit("CS2 is running; close it first")

    # Audio: route CS2 to a device that plays to nothing, keep it playing while unfocused, and
    # record only CS2's own audio. Without a silent device, render without sound rather than
    # playing the game through the user's speakers.
    a = profile.get("audio", {})
    audio = bool(a.get("enabled", True))
    if audio:
        silent = silent_device_id(a.get("silent_device", "Steam Streaming Speakers"))
        if silent:
            profile["console"].update({"sound_device_override": silent, "snd_mute_losefocus": "0",
                                       "volume": str(a.get("game_volume", 0.6))})
        else:
            log("no silent output device found; rendering without audio")
            audio = False

    restore_video(user_cfg)  # in case a previous run crashed
    backup = os.path.join(ROOT, "out", "cfg-backup-" + time.strftime("%Y%m%d-%H%M%S"))
    shutil.copytree(user_cfg, backup)
    apply_video(user_cfg, profile)

    vc, originals, parts = None, None, []
    tmp = tempfile.mkdtemp(prefix="cs2hl-")
    prev_fg = user32.GetForegroundWindow()
    try:
        log("launching CS2 in the background")
        o = profile["output"]
        subprocess.Popen([STEAM, "-applaunch", "730", "-insecure", "-novid", "-windowed", "-noborder",
                          "-w", str(o["width"]), "-h", str(o["height"]),
                          # Demo UI must be off before playback starts; it isn't a saved setting.
                          "+demo_ui_mode", "0", "+playdemo", demo])
        vc = VConsole()
        t0 = time.time()
        while not user32.FindWindowW(None, WINDOW_TITLE) and time.time() - t0 < 60:
            time.sleep(0.1)
        park_offscreen()
        stole = user32.GetForegroundWindow() == user32.FindWindowW(None, WINDOW_TITLE)
        log("CS2 window parked off-screen;", "it took focus" if stole else "focus stayed with your window")
        if stole and prev_fg:
            user32.SetForegroundWindow(prev_fg)

        if not vc.wait_for("Requesting playback", 120):
            raise RuntimeError("CS2 never started demo playback")
        if vc.wait_for("REPLAY_INCOMPATIBLE", 8):
            raise RuntimeError("CS2 can't play this demo: it was recorded on an older game version")
        if not vc.wait_for("SIGNONSTATE_FULL", 180):
            raise RuntimeError("demo never finished loading")
        log(f"demo loaded in {time.time() - t0:.0f}s")
        park_offscreen()  # CS2 may re-position itself while loading
        vc.send("demo_pause")
        time.sleep(2)
        originals = apply_console(vc, profile)
        vc.send(f"spec_lock_to_accountid {acc}")
        pid = cs2_pid() if audio else None

        for i, (start, end) in enumerate(segments):
            vc.send("demo_pause")
            vc.send(f"demo_gototick {start - int(SETTLE_S * TICKRATE)}")
            time.sleep(2.5)
            vc.send(f"spec_lock_to_accountid {acc}")
            time.sleep(0.5)
            part = os.path.join(tmp, f"part{i}.mp4")
            seconds = (end - start) / TICKRATE + SETTLE_S
            cmd = [CAPTURE, WINDOW_TITLE, part, f"{seconds:.2f}", str(o["capture_bitrate_mbps"]), str(o["fps"])]
            if pid:
                cmd += ["--audio-pid", str(pid)]
            cap = subprocess.Popen(cmd, stdout=subprocess.PIPE, text=True)
            first = cap.stdout.readline().strip()
            if first != "CAPTURE_STARTED":
                cap.wait()
                raise RuntimeError(f"capture failed to start: {first!r}")
            vc.send("demo_resume")
            done = cap.stdout.read().strip()
            cap.wait()
            vc.send("demo_pause")
            m = re.search(r"AUDIO_OFFSET ([0-9.]+)", done)
            wav = part + ".wav" if m and os.path.exists(part + ".wav") else None
            log(f"segment {i + 1}/{len(segments)}: {done.splitlines()[0] if done else '?'}"
                + (f", audio offset {float(m.group(1)) * 1000:.0f} ms" if wav else ""))
            parts.append({"video": part, "seconds": seconds, "wav": wav, "audio_offset": float(m.group(1)) if wav else 0.0})
    finally:
        if vc and vc.alive:
            if originals:
                revert_console(vc, originals)
            vc.send("quit")
        deadline = time.time() + 60
        while cs2_running() and time.time() < deadline:
            time.sleep(0.5)
        if cs2_running():
            log("CS2 didn't exit; force-closing it (no settings get written)")
            subprocess.run(["taskkill", "/F", "/IM", "cs2.exe"], capture_output=True)
            time.sleep(2)
        restore_video(user_cfg)

    assemble(parts, out, profile["output"], a if audio else None)
    shutil.rmtree(tmp, ignore_errors=True)
    log("done:", out)


def assemble(parts, out, o, audio):
    """Trim the settle second off each part, join them with hard cuts or crossfades, and mix in
    CS2's audio (aligned per part, loudness-normalised) when it was recorded."""
    with_audio = audio is not None and all(p["wav"] for p in parts)
    inputs, chains = [], []
    for i, p in enumerate(parts):
        length = p["seconds"] - SETTLE_S
        inputs += ["-i", p["video"]]
        chains.append(f"[{2 * i}:v]trim=start={SETTLE_S}:duration={length:.3f},setpts=PTS-STARTPTS,"
                      f"fps={o['fps']},format=yuv420p[v{i}]")
        if with_audio:
            inputs += ["-i", p["wav"]]
            start = SETTLE_S + p["audio_offset"]
            chains.append(f"[{2 * i + 1}:a]atrim=start={start:.4f}:duration={length:.3f},asetpts=PTS-STARTPTS,"
                          f"apad=whole_dur={length:.3f}[a{i}]")
    if not with_audio:  # inputs are video-only, so renumber
        inputs = [x for p in parts for x in ("-i", p["video"])]
        chains = [c.replace(f"[{2 * i}:v]", f"[{i}:v]") for i, c in enumerate(chains)]
    lengths = [p["seconds"] - SETTLE_S for p in parts]
    n = len(parts)
    graph = ";".join(chains)
    if n == 1:
        vlast, alast = "[v0]", "[a0]"
    elif o.get("transition") == "fade":
        d = o.get("transition_seconds", 0.35)
        vprev, aprev, offset = "[v0]", "[a0]", 0.0
        for i in range(1, n):
            offset += lengths[i - 1] - d
            graph += f";{vprev}[v{i}]xfade=transition=fade:duration={d}:offset={offset:.3f}[xv{i}]"
            vprev = f"[xv{i}]"
            if with_audio:
                graph += f";{aprev}[a{i}]acrossfade=d={d}[xa{i}]"
                aprev = f"[xa{i}]"
        vlast, alast = vprev, aprev
    else:
        pads = "".join(f"[v{i}][a{i}]" if with_audio else f"[v{i}]" for i in range(n))
        graph += f";{pads}concat=n={n}:v=1:a={1 if with_audio else 0}" + ("[cv][ca]" if with_audio else "[cv]")
        vlast, alast = "[cv]", "[ca]"
    maps = ["-map", vlast]
    codec = ["-c:v", "libx264", "-preset", "slow", "-crf", str(o["final_crf"]), "-profile:v", "high"]
    if with_audio:
        lufs = audio.get("loudness_lufs", -18)
        graph += f";{alast}loudnorm=I={lufs}:TP=-1.5:LRA=11,aresample=48000[aout]"
        maps += ["-map", "[aout]"]
        codec += ["-c:a", "aac", "-b:a", f"{audio.get('bitrate_kbps', 192)}k"]
    else:
        codec += ["-an"]
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *inputs, "-filter_complex", graph, *maps, *codec,
           "-movflags", "+faststart", out]
    subprocess.run(cmd, check=True)


if __name__ == "__main__":
    main()
