"""Probe: route CS2's audio to a silent device via its own setting and still record it."""

import json
import os
import re
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
import render_clip as rc  # noqa: E402
from vconsole import VConsole  # noqa: E402

ACC = 57058334
SILENT_ID = "{0.0.0.00000000}.{c815ec17-c74c-4c1c-a6b5-0ffc6fe1e983}"  # Steam Streaming Speakers
TICK = 114239


def cs2_pid():
    out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq cs2.exe", "/FO", "CSV", "/NH"], capture_output=True, text=True).stdout
    m = re.search(r'"cs2\.exe","(\d+)"', out)
    return int(m.group(1)) if m else None


def dump(vc, cmd, n=40):
    start = len(vc.lines)
    vc.send(cmd)
    time.sleep(1.0)
    print(f"### {cmd}")
    for line in vc.lines[start:start + n]:
        print("   ", line[:200])


def main():
    with open(os.path.join(rc.ROOT, "profiles", "default.json")) as f:
        profile = json.load(f)
    user_cfg = rc.USER_CFG.format(acc=ACC)
    if rc.cs2_running():
        raise SystemExit("CS2 running")
    rc.restore_video(user_cfg)
    rc.apply_video(user_cfg, profile)
    vc, originals = None, None
    try:
        subprocess.Popen([rc.STEAM, "-applaunch", "730", "-insecure", "-novid", "-windowed", "-noborder", "-w", "1920", "-h", "1080",
                          "+demo_ui_mode", "0", "+playdemo", os.path.abspath("out/demos/recent_mirage.dem")])
        vc = VConsole()
        t0 = time.time()
        while not rc.user32.FindWindowW(None, rc.WINDOW_TITLE) and time.time() - t0 < 60:
            time.sleep(0.1)
        rc.park_offscreen()
        vc.wait_for("SIGNONSTATE_FULL", 180)
        rc.park_offscreen()
        time.sleep(2)
        vc.send("demo_pause")
        pid = cs2_pid()
        where = lambda: " | ".join(subprocess.run([rc.CAPTURE, "where", str(pid)], capture_output=True, text=True).stdout.split("\n")).strip(" |")

        prof = {"console": {"sound_device_override": SILENT_ID, "volume": "0.6", "snd_mute_losefocus": "0"}}
        originals = rc.apply_console(vc, prof)
        print("originals:", originals)
        time.sleep(2)

        vc.send(f"demo_gototick {TICK}")
        time.sleep(2.5)
        vc.send(f"spec_lock_to_accountid {ACC}")
        vc.send("demo_resume")
        time.sleep(1)
        print("session peaks while playing:")
        print(subprocess.run([rc.CAPTURE, "where", str(pid)], capture_output=True, text=True).stdout)
        r = subprocess.run([rc.CAPTURE, "audio", str(pid), os.path.abspath("out/cs2_audio_test.wav"), "5"], capture_output=True, text=True)
        print("capture:", r.stdout.strip(), r.stderr.strip()[-200:])
        vc.send("demo_pause")

    finally:
        if vc and vc.alive:
            if originals:
                rc.revert_console(vc, originals)
            vc.send("quit")
        deadline = time.time() + 60
        while rc.cs2_running() and time.time() < deadline:
            time.sleep(0.5)
        if rc.cs2_running():
            subprocess.run(["taskkill", "/F", "/IM", "cs2.exe"], capture_output=True)
            time.sleep(2)
        rc.restore_video(user_cfg)


if __name__ == "__main__":
    main()
