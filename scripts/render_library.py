"""Render not-yet-rendered highlights in one background CS2 session, best "hands" first. Clips go
to <library>/clips/<highlight id>.mp4 and each match file is updated as soon as a clip is done,
so the app shows clips as they finish and an interrupted run loses nothing.

Order: three passes over the pending highlights (3K+ first, then flashy or always-tier moments,
then the rest). Within a pass, highlights are grouped by match and matches go in order of their
best hand; a demo is only reloaded when the next highlight comes from a different match.

usage: python scripts/render_library.py [library dir] [--all | --match <id>] [--limit N] [--profile p.json]
  (default: the most recent session)
"""

import json
import os
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(__file__))
from renderer import ROOT, DemoIncompatible, Renderer, log, make_thumb  # noqa: E402

CLI = os.path.join(ROOT, "target", "release", "cs2hl.exe")
STEAMID64_BASE = 76561197960265728


def arg(name, default=None):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


def main():
    lib = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else os.path.join(ROOT, "library"))
    limit = int(arg("--limit", "0")) or None
    only = arg("--match")
    with open(arg("--profile", os.path.join(ROOT, "profiles", "default.json"))) as f:
        profile = json.load(f)
    with open(os.path.join(lib, "index.json"), encoding="utf-8") as f:
        index = json.load(f)
    acc = int(index["me"]) - STEAMID64_BASE

    # Pending highlights from the selected matches (default: the most recent session).
    sessions = [sess for day in index["days"] for sess in day["sessions"]]
    if only:
        wanted = {only}
    elif "--all" in sys.argv:
        wanted = {m["id"] for m in index["matches"]}
    else:
        wanted = set(sessions[-1]["match_ids"]) if sessions else set()
    matches = {}
    for mid in wanted:
        path = os.path.join(lib, "matches", f"{mid}.json")
        with open(path, encoding="utf-8") as f:
            matches[mid] = (path, json.load(f))
    pending = [(mid, h) for mid, (_, m) in matches.items() for h in m["highlights"]
               if not h.get("clip") and not h.get("render_error")]

    # Backfill thumbnails for clips rendered before thumbnails existed.
    for mid, (path, m) in matches.items():
        changed = False
        for h in m["highlights"]:
            if h.get("clip") and not h.get("thumb") and os.path.exists(os.path.join(lib, h["clip"])):
                h["thumb"] = h["clip"][:-4] + ".jpg"
                make_thumb(os.path.join(lib, h["clip"]), os.path.join(lib, h["thumb"]))
                changed = True
        if changed:
            with open(path, "w", encoding="utf-8") as f:
                json.dump(m, f, indent=2)

    def band(h):  # 0: 3K+, 1: flashy kicker or always-tier, 2: the rest
        hand = h.get("hand", 0)
        return 0 if hand >= 300 else 1 if hand % 100 >= 25 or h.get("tier", 0) == 3 else 2

    jobs = []  # (path, match, [highlights]) in render order
    for b in range(3):
        groups = {}
        for mid, h in pending:
            if band(h) == b:
                groups.setdefault(mid, []).append(h)
        for mid, hs in sorted(groups.items(), key=lambda kv: -max(h.get("hand", 0) for h in kv[1])):
            path, m = matches[mid]
            jobs.append((path, m, sorted(hs, key=lambda h: -h.get("hand", 0))))
    total = sum(len(t) for _, _, t in jobs)
    if limit:
        total = min(total, limit)
    if not total:
        log("nothing to render")
        return
    log(f"{total} highlights to render from {len(jobs)} matches")

    def save(path, m):
        with open(path, "w", encoding="utf-8") as f:
            json.dump(m, f, indent=2)

    for _, m, todo in jobs:
        log(f"  {m['map']} {m['score_mine']}-{m['score_theirs']}: "
            + ", ".join(f"{h['title']} [{h.get('hand', 0)}]" for h in todo))

    done = 0
    t0 = time.time()
    loaded = None
    with Renderer(acc, profile) as r, tempfile.TemporaryDirectory(prefix="cs2hl-demo-") as tmp:
        for path, m, todo in jobs:
            if limit and done >= limit:
                break
            dem = os.path.join(tmp, f"{m['id']}.dem")
            if not os.path.exists(dem):
                subprocess.run([CLI, "extract", m["demo_path"], dem], check=True)
            try:
                if loaded != m["id"]:
                    r.load_demo(dem)
                    loaded = m["id"]
            except DemoIncompatible:
                log(f"skip {m['map']} {m['played_at']}: demo is from an older CS2 version")
                for h in todo:
                    h["render_error"] = "Recorded on an older CS2 version; CS2 can no longer play this demo."
                save(path, m)
                continue
            for h in todo:
                if limit and done >= limit:
                    break
                rel = f"clips/{h['id']}.mp4"
                ts = time.time()
                try:
                    r.record([tuple(s) for s in h["segments"]], os.path.join(lib, rel))
                    h["clip"] = rel
                    make_thumb(os.path.join(lib, rel), os.path.join(lib, rel[:-4] + ".jpg"))
                    h["thumb"] = rel[:-4] + ".jpg"
                    log(f"rendered {h['title']} ({h['duration_s']:.0f}s clip in {time.time() - ts:.0f}s)")
                except Exception as e:  # keep going; one bad clip shouldn't stop the batch
                    h["render_error"] = str(e)
                    log(f"failed {h['title']}: {e}")
                save(path, m)
                done += 1
    log(f"rendered {done} highlights in {(time.time() - t0) / 60:.1f} min")


if __name__ == "__main__":
    main()
