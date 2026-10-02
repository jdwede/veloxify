"""Render-pipeline prototype: stock CS2 demo playback, driven by an exec'd cfg triggered with an
unused key (F13), captured with FFmpeg (Desktop Duplication -> NVENC). Throwaway; the real
pipeline will live in Rust.

usage: python scripts/render_test.py <demo.dem> <accountid> <start_tick> <end_tick> <out.mp4> [WxH]

Safety: backs up the user's CS2 cfg folder first; on exit unbinds F13 and quits CS2 normally so
the clean bindings are what CS2 saves (locally and to Steam Cloud).
"""

import ctypes
import ctypes.wintypes as wt
import os
import shutil
import subprocess
import sys
import time

STEAM = r"C:\Program Files (x86)\Steam\steam.exe"
GAME = r"C:\Program Files (x86)\Steam\steamapps\common\Counter-Strike Global Offensive\game\csgo"
USER_CFG = r"C:\Program Files (x86)\Steam\userdata\{acc}\730\local\cfg"
CFG_DIR = os.path.join(GAME, "cfg", "cs2hl")
CONSOLE_LOG = os.path.join(GAME, "console.log")
TICKRATE = 64
PREROLL_TICKS = 2 * TICKRATE  # let the game settle after seeking
VK_F13 = 0x7C

user32 = ctypes.windll.user32
user32.SetProcessDPIAware()


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", ctypes.c_ushort), ("wScan", ctypes.c_ushort), ("dwFlags", ctypes.c_ulong),
                ("time", ctypes.c_ulong), ("dwExtraInfo", ctypes.c_size_t)]


class INPUT(ctypes.Structure):
    class _U(ctypes.Union):
        _fields_ = [("ki", KEYBDINPUT), ("pad", ctypes.c_byte * 32)]
    _anonymous_ = ("u",)
    _fields_ = [("type", ctypes.c_ulong), ("u", _U)]


def cs2_window():
    return user32.FindWindowW(None, "Counter-Strike 2")


def press_f13():
    scan = user32.MapVirtualKeyW(VK_F13, 0)
    for flags in (0x0008, 0x0008 | 0x0002):  # KEYEVENTF_SCANCODE, then + KEYEVENTF_KEYUP
        inp = INPUT(type=1)
        inp.ki = KEYBDINPUT(0, scan, flags, 0, 0)
        user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(INPUT))
        time.sleep(0.03)


class Console:
    """Sends commands via cfg + F13 and reads replies from -condebug's console.log."""

    def __init__(self):
        self.n = 0

    def send(self, *cmds, wait=True):
        self.n += 1
        marker = f"cs2hl_ack_{self.n}"
        with open(os.path.join(CFG_DIR, "cmd.cfg"), "w") as f:
            f.write("\n".join(cmds) + f"\necho {marker}\n")
        log(">", "; ".join(cmds))
        for attempt in range(5):
            user32.SetForegroundWindow(cs2_window())
            time.sleep(0.15)
            press_f13()
            if not wait or self.wait_for(marker, 3):
                return True
        log("  (no ack)")
        return False

    @staticmethod
    def lines():
        try:
            with open(CONSOLE_LOG, encoding="utf-8", errors="replace") as f:
                return f.read().splitlines()
        except FileNotFoundError:
            return []

    def wait_for(self, needle, timeout, after=None):
        deadline = time.time() + timeout
        while time.time() < deadline:
            lines = self.lines()
            if after is not None:
                idx = next((i for i, l in enumerate(lines) if after in l), None)
                lines = lines[idx:] if idx is not None else []
            hit = next((l for l in lines if needle in l), None)
            if hit:
                return hit
            time.sleep(0.25)
        return None


def client_rect():
    hwnd = cs2_window()
    rect, pt = wt.RECT(), wt.POINT(0, 0)
    user32.GetClientRect(hwnd, ctypes.byref(rect))
    user32.ClientToScreen(hwnd, ctypes.byref(pt))
    return pt.x, pt.y, rect.right, rect.bottom


def main():
    demo, acc, start, end, out = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), sys.argv[5]
    w, h = map(int, (sys.argv[6] if len(sys.argv) > 6 else "1920x1080").split("x"))
    demo = os.path.abspath(demo)
    user_cfg = USER_CFG.format(acc=acc)
    backup = os.path.abspath(os.path.join("out", "cfg-backup-" + time.strftime("%Y%m%d-%H%M%S")))
    shutil.copytree(user_cfg, backup)
    log("backed up CS2 cfg to", backup)

    os.makedirs(CFG_DIR, exist_ok=True)
    with open(os.path.join(CFG_DIR, "init.cfg"), "w") as f:
        f.write('bind "F13" "exec cs2hl/cmd"\necho cs2hl_init_ok\n')
    if os.path.exists(CONSOLE_LOG):
        os.remove(CONSOLE_LOG)

    con = Console()
    try:
        record(con, demo, acc, start, end, out, w, h)
    finally:
        if cs2_window():
            con.send('unbind "F13"', "quit", wait=False)
            for _ in range(60):
                if not cs2_window():
                    break
                time.sleep(1)
        log("CS2 closed" if not cs2_window() else "CS2 still running!")
        shutil.copy(CONSOLE_LOG, out + ".console.log")


def record(con, demo, acc, start, end, out, w, h):
    log("launching CS2")
    subprocess.Popen([STEAM, "-applaunch", "730", "-insecure", "-novid", "-windowed", "-noborder",
                      "-w", str(w), "-h", str(h), "-condebug", "+exec", "cs2hl/init", "+playdemo", demo])
    t0 = time.time()
    if not con.wait_for("Requesting playback", 120):
        raise RuntimeError("CS2 never started demo playback")
    # The demo is in game once the client reaches full signon after the playback request.
    hit = con.wait_for("SIGNONSTATE_FULL", 180, after="Requesting playback")
    if not hit:
        raise RuntimeError("demo never finished loading (see console.log)")
    log(f"demo loaded in {time.time() - t0:.0f}s")
    time.sleep(3)

    con.send("demo_pause", f"demo_gototick {start - PREROLL_TICKS}")
    time.sleep(2)
    con.send(f"spec_lock_to_accountid {acc}")
    time.sleep(1)

    x, y, cw, ch = client_rect()
    cw, ch = cw // 2 * 2, ch // 2 * 2
    log(f"capturing client area {cw}x{ch} at {x},{y}")
    duration = (end - start + PREROLL_TICKS) / TICKRATE
    ff = subprocess.Popen(
        ["ffmpeg", "-hide_banner", "-loglevel", "warning", "-y",
         "-f", "lavfi", "-i",
         f"ddagrab=output_idx=0:framerate=60:draw_mouse=0:video_size={cw}x{ch}:offset_x={x}:offset_y={y}",
         "-t", f"{duration:.2f}",
         "-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", "19", "-b:v", "0", out])
    time.sleep(0.4)
    con.send("demo_resume", wait=False)
    ff.wait()
    log("captured", out, "exit", ff.returncode)
    con.send("demo_pause")


if __name__ == "__main__":
    main()
