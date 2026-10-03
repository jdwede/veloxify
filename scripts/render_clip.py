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
    pat = re.compile(r"%s = (.*)$" % re.escape(name))
    while time.time() < deadline:
        for line in vc.lines[n:]:
            m = pat.search(line)
            if m:
                return m.group(1).strip()
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
        vc.send(f"{name} {val}")
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
                          "-w", str(o["width"]), "-h", str(o["height"]), "+playdemo", demo])
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
        time.sleep(2)
        originals = apply_console(vc, profile)
        vc.send(f"spec_lock_to_accountid {acc}")

        for i, (start, end) in enumerate(segments):
            vc.send("demo_pause")
            vc.send(f"demo_gototick {start - int(SETTLE_S * TICKRATE)}")
            time.sleep(2.5)
            vc.send(f"spec_lock_to_accountid {acc}")
            time.sleep(0.5)
            part = os.path.join(tmp, f"part{i}.mp4")
            seconds = (end - start) / TICKRATE + SETTLE_S
            cap = subprocess.Popen([CAPTURE, WINDOW_TITLE, part, f"{seconds:.2f}", str(o["capture_bitrate_mbps"]),
                                    str(o["fps"])], stdout=subprocess.PIPE, text=True)
            first = cap.stdout.readline().strip()
            if first != "CAPTURE_STARTED":
                cap.wait()
                raise RuntimeError(f"capture failed to start: {first!r}")
            vc.send("demo_resume")
            done = cap.stdout.read().strip()
            cap.wait()
            vc.send("demo_pause")
            log(f"segment {i + 1}/{len(segments)}: {done}")
            parts.append((part, seconds))
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

    assemble(parts, out, profile["output"])
    shutil.rmtree(tmp, ignore_errors=True)
    log("done:", out)


def assemble(parts, out, o):
    """Trim the settle second off each part and join them with hard cuts or crossfades."""
    inputs, chains = [], []
    for i, (path, _) in enumerate(parts):
        inputs += ["-i", path]
        chains.append(f"[{i}:v]trim=start={SETTLE_S},setpts=PTS-STARTPTS,fps={o['fps']},format=yuv420p[v{i}]")
    lengths = [secs - SETTLE_S for _, secs in parts]
    if len(parts) == 1:
        graph, last = chains[0], "[v0]"
    elif o.get("transition") == "fade":
        d = o.get("transition_seconds", 0.35)
        graph, prev, offset = ";".join(chains), "[v0]", 0.0
        for i in range(1, len(parts)):
            offset += lengths[i - 1] - d
            graph += f";{prev}[v{i}]xfade=transition=fade:duration={d}:offset={offset:.3f}[x{i}]"
            prev = f"[x{i}]"
        last = prev
    else:
        graph = ";".join(chains) + ";" + "".join(f"[v{i}]" for i in range(len(parts))) + \
            f"concat=n={len(parts)}:v=1:a=0[cat]"
        last = "[cat]"
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *inputs, "-filter_complex", graph, "-map", last,
           "-c:v", "libx264", "-preset", "slow", "-crf", str(o["final_crf"]), "-profile:v", "high",
           "-movflags", "+faststart", "-an", out]
    subprocess.run(cmd, check=True)


if __name__ == "__main__":
    main()
