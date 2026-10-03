"""Render one highlight from a demo in the background.

usage: python scripts/render_clip.py <demo.dem> <accountid> <segments> <out.mp4> [profile.json]
  segments: comma-separated tick ranges, e.g. "114239-115109,115453-115901"
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from renderer import ROOT, Renderer, log  # noqa: E402


def main():
    demo, acc, segs, out = sys.argv[1], int(sys.argv[2]), sys.argv[3], os.path.abspath(sys.argv[4])
    profile_path = sys.argv[5] if len(sys.argv) > 5 else os.path.join(ROOT, "profiles", "default.json")
    with open(profile_path) as f:
        profile = json.load(f)
    segments = [tuple(map(int, s.split("-"))) for s in segs.split(",")]
    with Renderer(acc, profile) as r:
        r.load_demo(demo)
        r.record(segments, out)
    log("done:", out)


if __name__ == "__main__":
    main()
