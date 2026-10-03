# cs2-highlights

Local CS2 highlight + stats tool. Runs only after you play: fetches your FACEIT / Premier demos,
computes HLTV-style stats for you and your party, detects highlights, and renders them.

## Layout
- `crates/core` — demo loading, match model, stats (Rating 1.0, Rating 2.0 est., ADR, KAST, ...),
  highlight detection.
- `crates/capture` — window recording (Windows Graphics Capture + hardware H.264) and
  per-process audio capture; `cs2hl-capture` CLI for diagnostics.
- `crates/render` — background highlight rendering: CS2 driven over VConsole, settings
  protection, assembly (cuts/fades, audio, FPS-counter patch, NVENC), batch ordering.
- `crates/cli` — `cs2hl` command line for development:
  - `cs2hl analyze <demo> [--player <steamid64>] [--json]`
  - `cs2hl validate <demo>...` — checks event-derived stats against CS2's in-demo scoreboard
  - `cs2hl events <demo> [names...]` — dump raw game events
  - `cs2hl library <dir> --player <steamid64> <demos...>` — build the match library
  - `cs2hl render <dir> [--all | --match <id>] [--limit N]` — render pending highlights
- `app/ui` — the Veloxify UI (calendar → day → matches → stats/highlights).
- `profiles/default.json` — render profile (Allstar-style defaults).
- `third_party/demoparser` — vendored, pinned CS2 demo parser (MIT). See `VENDORED.md`.

## Build
```
cargo build --release
```
