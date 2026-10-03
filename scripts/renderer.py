"""Background highlight renderer: one CS2 session renders any number of clips from any number
of demos (demos are loaded through the console, so CS2 starts once per batch).

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
    corner = detect_fps_counter(parts[0]["video"]) if o.get("hide_fps_counter", True) else None
    if corner:
        graph += f";{vlast}{fps_mask_filter(corner, o['width'], o['height'])}[vmask]"
        vlast = "[vmask]"
    maps = ["-map", vlast]
    if o.get("final_encoder", "nvenc") == "nvenc":
        # GPU encode: a couple of seconds per clip instead of ~20 s of CPU, and quality-targeted.
        codec = ["-c:v", "h264_nvenc", "-preset", "p6", "-tune", "hq", "-rc", "vbr", "-cq", str(o["final_crf"]),
                 "-b:v", "0", "-maxrate", f"{o.get('max_bitrate_mbps', 12)}M",
                 "-bufsize", f"{2 * o.get('max_bitrate_mbps', 12)}M", "-spatial-aq", "1", "-profile:v", "high"]
    else:
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



# Steam's in-game FPS counter (green text on a black box) is drawn into the game window when the
# user has it enabled. Renders find it in the first frame and cover it with a mirrored copy of the
# strip next to it, which continues the surrounding image seamlessly at this size.
FPS_BOX_W, FPS_BOX_H = 56, 15


def detect_fps_counter(video, at=0.5):
    """Corner ('tl', 'tr', 'bl', 'br') holding Steam's FPS counter in `video`, or None."""
    probe = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v", "-show_entries", "stream=width,height",
                            "-of", "csv=p=0", video], capture_output=True, text=True).stdout.strip()
    w, h = map(int, probe.split(",")[:2])
    corners = {"tl": (0, 0), "tr": (w - FPS_BOX_W, 0), "bl": (0, h - FPS_BOX_H), "br": (w - FPS_BOX_W, h - FPS_BOX_H)}
    best, best_n = None, 0
    for name, (x, y) in corners.items():
        raw = subprocess.run(["ffmpeg", "-v", "error", "-ss", str(at), "-i", video, "-frames:v", "1",
                              "-vf", f"crop={FPS_BOX_W}:{FPS_BOX_H}:{x}:{y}", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                             capture_output=True).stdout
        n = sum(1 for i in range(0, len(raw) - 2, 3)
                if raw[i + 1] > 150 and raw[i + 1] > raw[i] + 60 and raw[i + 1] > raw[i + 2] + 60)
        if n > best_n:
            best, best_n = name, n
    return best if best_n >= 12 else None


def fps_mask_filter(corner, w, h):
    """Filter chain (input/output labelled by the caller) hiding the counter in `corner`."""
    bw, bh = FPS_BOX_W, FPS_BOX_H
    x = 0 if corner[1] == "l" else w - bw
    if corner[0] == "t":
        src_y, dst_y = bh, 0
    else:
        src_y, dst_y = h - 2 * bh, h - bh
    return (f"format=gbrp,split=2[fm_a][fm_b];[fm_b]crop={bw}:{bh}:{x}:{src_y},vflip[fm_p];"
            f"[fm_a][fm_p]overlay={x}:{dst_y},format=yuv420p")


def make_thumb(clip, thumb, at=3.7):
    """Preview frame for a clip: by default just before the first kill (clips have 4 s pre-roll)."""
    dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", clip],
                               capture_output=True, text=True).stdout.strip() or 0)
    t = max(0.0, min(at, dur - 0.5))
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{t:.2f}", "-i", clip, "-frames:v", "1",
                    "-vf", "scale=640:-2", "-q:v", "3", thumb], check=True)


class DemoIncompatible(Exception):
    """CS2 refuses demos recorded on older game versions (network protocol changes)."""


class Renderer:
    """One background CS2 session. Use as a context manager: settings are applied on entry and
    always restored on exit, even if rendering fails.

        with Renderer(accountid, profile) as r:
            r.load_demo("match.dem")
            r.record([(start_tick, end_tick), ...], "clip.mp4")
    """

    def __init__(self, acc, profile):
        self.acc = acc
        self.profile = json.loads(json.dumps(profile))  # private copy; audio settings get added
        self.user_cfg = USER_CFG.format(acc=acc)
        self.vc = None
        self.originals = None
        self.pid = None
        self.audio = None

    def __enter__(self):
        if cs2_running():
            raise RuntimeError("CS2 is running; close it first")
        p = self.profile
        a = p.get("audio", {})
        if a.get("enabled", True):
            silent = silent_device_id(a.get("silent_device", "Steam Streaming Speakers"))
            if silent:
                p["console"].update({"sound_device_override": silent, "snd_mute_losefocus": "0",
                                     "volume": str(a.get("game_volume", 0.6))})
                self.audio = a
            else:
                log("no silent output device found; rendering without audio")
        restore_video(self.user_cfg)  # in case a previous run crashed
        shutil.copytree(self.user_cfg, os.path.join(ROOT, "out", "cfg-backup-" + time.strftime("%Y%m%d-%H%M%S")))
        apply_video(self.user_cfg, p)
        try:
            self._launch()
        except BaseException:
            self.__exit__(None, None, None)
            raise
        return self

    def _launch(self):
        o = self.profile["output"]
        prev_fg = user32.GetForegroundWindow()
        log("launching CS2 in the background")
        subprocess.Popen([STEAM, "-applaunch", "730", "-insecure", "-novid", "-windowed", "-noborder",
                          "-w", str(o["width"]), "-h", str(o["height"]),
                          "+demo_ui_mode", "0"])  # must be off before any demo plays; not a saved setting
        self.vc = VConsole()
        t0 = time.time()
        while not user32.FindWindowW(None, WINDOW_TITLE) and time.time() - t0 < 60:
            time.sleep(0.1)
        park_offscreen()
        if user32.GetForegroundWindow() == user32.FindWindowW(None, WINDOW_TITLE) and prev_fg:
            user32.SetForegroundWindow(prev_fg)
        if not self.vc.wait_for("OnSwitchLoopModeFinished", 120):
            raise RuntimeError("CS2 main menu never loaded")
        time.sleep(2)
        park_offscreen()
        self.originals = apply_console(self.vc, self.profile)
        self.pid = cs2_pid() if self.audio else None
        log(f"CS2 ready in {time.time() - t0:.0f}s")

    def load_demo(self, path):
        vc = self.vc
        t0 = time.time()
        since = vc.mark()
        vc.send(f'playdemo "{os.path.abspath(path)}"')
        if not vc.wait_for("Requesting playback", 60, since):
            raise RuntimeError("CS2 didn't start demo playback")
        if vc.wait_for("REPLAY_INCOMPATIBLE", 8, since):
            raise DemoIncompatible(path)
        # Ready once the demo is in game: loading from the menu prints SIGNONSTATE_FULL, switching
        # from one demo to another doesn't but does print its first full snapshot.
        if not vc.wait_for("playing demo from", 120, since):
            raise RuntimeError("demo never started loading")
        if not vc.wait_for_any(["SIGNONSTATE_FULL", "received full update"], 180, since):
            raise RuntimeError("demo never finished loading")
        vc.send("demo_pause")
        park_offscreen()
        time.sleep(1)
        vc.send(f"spec_lock_to_accountid {self.acc}")
        log(f"demo loaded in {time.time() - t0:.0f}s: {os.path.basename(path)}")

    def record(self, segments, out):
        vc, o = self.vc, self.profile["output"]
        tmp = tempfile.mkdtemp(prefix="cs2hl-")
        parts = []
        try:
            for i, (start, end) in enumerate(segments):
                vc.send("demo_pause")
                vc.send(f"demo_gototick {start - int(SETTLE_S * TICKRATE)}")
                time.sleep(1.5)  # seek; anything still settling falls in the trimmed SETTLE_S lead-in
                vc.send(f"spec_lock_to_accountid {self.acc}")
                time.sleep(0.3)
                part = os.path.join(tmp, f"part{i}.mp4")
                seconds = (end - start) / TICKRATE + SETTLE_S
                cmd = [CAPTURE, WINDOW_TITLE, part, f"{seconds:.2f}", str(o["capture_bitrate_mbps"]), str(o["fps"])]
                if self.pid:
                    cmd += ["--audio-pid", str(self.pid)]
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
                parts.append({"video": part, "seconds": seconds, "wav": wav,
                              "audio_offset": float(m.group(1)) if wav else 0.0})
            os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
            assemble(parts, out, o, self.audio)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def __exit__(self, *exc):
        vc = self.vc
        if vc and vc.alive:
            if self.originals:
                revert_console(vc, self.originals)
            vc.send("quit")
        deadline = time.time() + 60
        while cs2_running() and time.time() < deadline:
            time.sleep(0.5)
        if cs2_running():
            log("CS2 didn't exit; force-closing it (no settings get written)")
            subprocess.run(["taskkill", "/F", "/IM", "cs2.exe"], capture_output=True)
            time.sleep(2)
        restore_video(self.user_cfg)
        return False
