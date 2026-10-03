"""One-off: hide Steam's FPS counter in clips rendered before renders did it themselves."""

import glob
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(__file__))
from renderer import ROOT, detect_fps_counter, fps_mask_filter, log, make_thumb  # noqa: E402

for clip in sorted(glob.glob(os.path.join(ROOT, "library", "clips", "*.mp4"))):
    corner = detect_fps_counter(clip, at=1.0)
    if not corner:
        continue
    tmp = clip + ".tmp.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", clip, "-filter_complex", "[0:v]" + fps_mask_filter(corner, 1920, 1080) + "[v]",
                    "-map", "[v]", "-map", "0:a?", "-c:v", "h264_nvenc", "-preset", "p6", "-tune", "hq", "-rc", "vbr",
                    "-cq", "23", "-b:v", "0", "-maxrate", "12M", "-bufsize", "24M", "-c:a", "copy", "-movflags", "+faststart", tmp],
                   check=True)
    os.replace(tmp, clip)
    if os.path.exists(clip[:-4] + ".jpg"):
        make_thumb(clip, clip[:-4] + ".jpg")
    log(f"cleaned {os.path.basename(clip)} ({corner})")
