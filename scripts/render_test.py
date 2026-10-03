"""Render-pipeline prototype: stock CS2 demo playback controlled over VConsole (TCP 29000),
recorded with Windows Graphics Capture (cs2hl-capture). Works in the background: no keyboard
input, no window focus needed, and other windows covering CS2 don't end up in the video.
Throwaway; the real pipeline will live in Rust.

usage: python scripts/render_test.py <demo.dem> <accountid> <start_tick> <end_tick> <out.mp4> [WxH]

Safety: backs up the user's CS2 cfg folder first; temporarily switches cs2_video.txt to a
borderless window and restores the original after CS2 has fully exited (or at the start of the
next run if this one crashed).
"""

import os
import re
import shutil
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
from vconsole import VConsole  # noqa: E402

STEAM = r"C:\Program Files (x86)\Steam\steam.exe"
USER_CFG = r"C:\Program Files (x86)\Steam\userdata\{acc}\730\local\cfg"
CAPTURE = os.path.join(os.path.dirname(__file__), "..", "target", "release", "cs2hl-capture.exe")
WINDOW_TITLE = "Counter-Strike 2"
TICKRATE = 64
PREROLL_TICKS = 2 * TICKRATE  # footage before the highlight starts; also lets the game settle


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def cs2_running():
    out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq cs2.exe", "/NH"], capture_output=True, text=True).stdout
    return "cs2.exe" in out


VIDEO_OVERRIDES = {"setting.fullscreen": "0", "setting.coop_fullscreen": "0", "setting.nowindowborder": "1"}


def force_windowed(user_cfg, w, h):
    """CS2 lets cs2_video.txt override -windowed, so temporarily switch it to a borderless
    window. The original is kept next to it and restored by restore_video()."""
    path = os.path.join(user_cfg, "cs2_video.txt")
    orig = path + ".cs2hl-orig"
    if not os.path.exists(orig):
        shutil.copy2(path, orig)
    overrides = dict(VIDEO_OVERRIDES, **{"setting.defaultres": str(w), "setting.defaultresheight": str(h)})
    with open(orig, encoding="utf-8", newline="") as f:
        text = f.read()
    for key, val in overrides.items():
        # Replace only the quoted value, keeping the file's own whitespace and line endings.
        text = re.sub(r'("%s"\s+")[^"]*(")' % re.escape(key), lambda m: m.group(1) + val + m.group(2), text)
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(text)


def restore_video(user_cfg):
    path = os.path.join(user_cfg, "cs2_video.txt")
    orig = path + ".cs2hl-orig"
    if os.path.exists(orig):
        shutil.copy2(orig, path)
        os.remove(orig)
        log("restored your cs2_video.txt")


def main():
    demo, acc, start, end, out = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), sys.argv[5]
    w, h = map(int, (sys.argv[6] if len(sys.argv) > 6 else "1920x1080").split("x"))
    demo, out = os.path.abspath(demo), os.path.abspath(out)
    user_cfg = USER_CFG.format(acc=acc)
    if cs2_running():
        raise SystemExit("CS2 is running; close it first")
    restore_video(user_cfg)  # in case a previous run crashed
    backup = os.path.abspath(os.path.join("out", "cfg-backup-" + time.strftime("%Y%m%d-%H%M%S")))
    shutil.copytree(user_cfg, backup)
    log("backed up CS2 cfg to", backup)
    force_windowed(user_cfg, w, h)

    vc = None
    try:
        log("launching CS2")
        subprocess.Popen([STEAM, "-applaunch", "730", "-insecure", "-novid", "-windowed", "-noborder",
                          "-w", str(w), "-h", str(h), "+playdemo", demo])
        vc = VConsole()
        record(vc, acc, start, end, out)
    finally:
        if vc and vc.alive:
            vc.send("quit")
        deadline = time.time() + 60
        while cs2_running() and time.time() < deadline:
            time.sleep(0.5)
        if cs2_running():
            log("CS2 didn't exit; force-closing it (no settings get written)")
            subprocess.run(["taskkill", "/F", "/IM", "cs2.exe"], capture_output=True)
            time.sleep(2)
        restore_video(user_cfg)
        if vc:
            with open(out + ".console.log", "w", encoding="utf-8") as f:
                f.write("\n".join(vc.lines))


def record(vc, acc, start, end, out):
    t0 = time.time()
    if not vc.wait_for("Requesting playback", 120):
        raise RuntimeError("CS2 never started demo playback")
    if vc.wait_for("REPLAY_INCOMPATIBLE", 8):
        raise RuntimeError("CS2 can't play this demo: it was recorded on an older game version")
    if not vc.wait_for("SIGNONSTATE_FULL", 180):
        raise RuntimeError("demo never finished loading")
    log(f"demo loaded in {time.time() - t0:.0f}s")
    time.sleep(3)

    vc.send("demo_pause")
    vc.send(f"demo_gototick {start - PREROLL_TICKS}")
    time.sleep(3)
    vc.send(f"spec_lock_to_accountid {acc}")
    time.sleep(1.5)

    seconds = (end - start + PREROLL_TICKS) / TICKRATE
    cap = subprocess.Popen([CAPTURE, WINDOW_TITLE, out, f"{seconds:.2f}"], stdout=subprocess.PIPE, text=True)
    first = cap.stdout.readline().strip()
    if first != "CAPTURE_STARTED":
        cap.wait()
        raise RuntimeError(f"capture failed to start: {first!r}")
    vc.send("demo_resume")
    log(f"recording {seconds:.1f}s")
    rest = cap.stdout.read().strip()
    cap.wait()
    vc.send("demo_pause")
    log("capture:", rest, "->", out)


if __name__ == "__main__":
    main()
