<div align="center">

# Veloxify

**Your CS2 highlights, stats and coaching, made on your own PC. Free.**

Veloxify watches for your FACEIT and Premier matches, records your best plays as clean clips,
breaks down your worst deaths, films the grenade lineups thrown in your matches, and gives you
Leetify-style match pages: aim, utility, trades, 2D replays and HLTV Rating 3.0 round by round.
No subscription, no cloud, no watermark.

<a href="https://ko-fi.com/jdwede"><img src="https://img.shields.io/badge/Support%20Veloxify-Ko--fi-29abe0?logo=kofi&logoColor=white" alt="Support Veloxify on Ko-fi"></a>

<img src="docs/screenshots/match-overview.png" alt="Veloxify match page: result, HLTV Rating 3.0 chart, highlights and scoreboard" width="900">

</div>

---

## Why Veloxify

Most of what makes CS2 stats and clip tools worth paying for runs fine on your own computer:
your demos are already there, and so is CS2. Veloxify uses them, so features that are paid
elsewhere are free here, with no monthly clip caps.

| What you get | Elsewhere it's paid | Veloxify |
|---|---|---|
| Auto highlight clips from **every** match, no clip limit | Allstar's free plan is 5 clips a month; auto-capture of every match is a paid plan. FACEIT's highlights need FACEIT Premium. | ✅ Free, unlimited |
| No watermark, up to 1440p / 60 fps | Allstar removes the watermark on paid plans only | ✅ Free |
| 2D round replays | Leetify: "2D Replay is only available to Leetify Pro users" | ✅ Free, every round |
| Highlights of your matches | Leetify Pro / FACEIT Premium | ✅ Free |
| Benchmarks against other players | Leetify Pro (pro-player benchmarks) | ✅ Free, against every player in your own matches |
| Advanced aim, utility, trade and clutch stats | Partly behind Leetify Pro / FACEIT Premium | ✅ Free |
| Whiff analyzer: *why* you lost a duel (spray, movement, crosshair) | Not offered | ✅ |
| Grenade lineups from your matches: grouped, counted, tagged (jump throw, run-and-jump...) and **filmed** | Not offered | ✅ |
| Your data stays on your PC | Uploaded to their servers | ✅ Nothing leaves your machine |

<sub>Compared with what these services listed in October 2026. Veloxify isn't affiliated with Leetify,
FACEIT, Allstar or Valve.</sub>

## Features

**Highlights**
- Finds your best rounds in every demo: aces, 4Ks, 3Ks, clutches, entry kills, wallbangs, noscopes, smoke kills, flicks.
- Fair 2Ks count, eco-round kills are tagged "vs eco" so they don't drown out real plays.
- Renders them from the demo in CS2 itself, always from **your** view, with the clean kill-feed-only HUD.
- Runs after you close CS2: CS2 opens hidden, records, and puts your settings back. It stops the moment you open CS2 or FACEIT finds you a match.
- Clips page with "top this week", folders, presets (best pistol rounds, AWP, clutches...), montages.
- Hover a highlight to preview it, like a YouTube thumbnail.

**Lowlights and the whiff analyzer**
- Your deaths right after a miss, ranked by how much they cost.
- For each one: your crosshair against his body, your spray against the gun's real recoil pattern, the keys you pressed and your speed at every shot, in slow motion next to the clip.
- Tells you what went wrong ("counter-strafe 200 ms late", "pulled down too far") and what to practice.

**Grenades**
- The lineups thrown in your matches, by everyone: **instant smokes** (thrown from spawn the moment the round starts) and **set lineups** (lined up against a wall or corner, crosshair placed, then thrown). The same spot to the same place counts as one lineup, however many times and by whoever it was thrown; grenades thrown on the move are left out.
- Named and sorted the way you'd say them: "Instant Smoke #1" from T spawn #3, "Set Molotov #2", and how often each was thrown.
- Tags for how it's thrown: jump throw, jump throw + W, running jump throw, crouch, walk, left or right click.
- A **video of each lineup**, filmed from a demo in CS2: the thrower lining it up in first person, then the camera follows the grenade until it pops and holds on it.
- Every map with its lineup count, then a radar with every arc; a `setpos` to stand and aim exactly like the thrower on a practice server.
- Star your favorites and filter the map to them; remove a lineup that's really a miss (and put it back if you change your mind).

**Match Insights** (how players in your matches play each map)
- Built from every round of every match: where each player was, twice a second, with CS2's own callouts, plus what each team bought, the kills, damage, grenades and the bomb.
- Filter by side, round type (pistol, eco, force buy, full buy), whose rounds (your opponents, your team, everyone) and FACEIT or Premier.
- **Overview**: the strongest patterns first. Pistol round splits, "tells" ("when the T are in Apps by 1:25, they plant B 40% of the time"), timings, plant spots, executes and site entries.
- **Ask**: build a situation and see what follows. "Someone of the T in Palace by 1:30 and a Window smoke by 1:40": where the bomb goes, who wins, first contact, where the first kill happens, with every matching round one click from its 2D replay.
- **Positions**: a heat map over the round clock (press play), and for any callout how often it's taken, when, when contact happens there and what it means for the round.
- **Strats**: how the 5 split up and where the round went ("4-man A → rush A", "Split 2 A / 2 B → B"), executes (the smokes thrown together), CT setups.
- **Plants**: plant spots by name (the default, "Long plant"...) and where the T play after the plant.
- **Paths**: where the first T into a site comes from, the defender spots they check and the ones they miss, lurks, and a line you draw across a door or choke to see who crosses it, when, where along it and whether they jump.
- **Utility**: when players reach an area and how many are there second by second, so you know when a molotov or HE catches the most.

**Playstyle** (you, from every round you played)
- Your roles against everyone else in the same rounds: entry fragger, opening duels, lurker, AWPer, support, trader, anchor, rotator, clutcher.
- T or CT: per-side kills, deaths, survival, opening duels and duels won.
- Your duels by kind (range, weapon, moving or still targets, shooting on the move, height, openings, afterplants, retakes, clutches), with your strengths, weaknesses and a tip for each weakness. Click a kind to see every one of those duels and open it in the 2D replay.
- Your spots on each map: where you usually play, and where you win and lose your fights.

**Crosshairs**
- Every player's crosshair on the match page: a preview and a copy button, as the scoreboard's last column.
- Your crosshair history (every crosshair you've played with, by date), favorites, and the crosshairs most popular in your matches.
- "Use in my CS2" puts one in your CS2 settings for the next time you start it (while CS2 is closed; your settings are backed up first), and you can record your clips with any crosshair.
- Reads CS2's new pixel crosshair codes and the old `CSGO-` ones (converted, since CS2 no longer imports those).

**Match page** (every match, for all 10 players)
- Overview: HLTV Rating 3.0, Round Swing, RWS, KAST, ADR, HLTV-style summary and top highlights.
- Rating Breakdown: HLTV Rating 3.0 or RWS for any player, round by round, in plain words: why that round was a 1.85, and where each bit of Round Swing came from.
- Timeline: every round on the radar, kill by kill, with each player's swing.
- 2D Replay: whole rounds on the map with positions, view direction, HP, grenades and the bomb.
- Lineups: set smokes, molotovs and flashes, how they were thrown (jump-throw, crouch, left/right click) and a `setpos` to practice them.
- Aim: time to damage, crosshair placement, head accuracy, first-bullet and spray accuracy, counter-strafing.
- Utility, Activity, Trades, Opening Duels, Clutches, Head to Head, Map Zones.
- Every stat colored Poor to Great against every player-match in your library.

**Profile and progress**
- Your ratings over the last 10, 30, 50 games or all time; FACEIT and Premier side by side.
- FACEIT ELO graph, one dot per game, and monthly rating trends.
- Build your own ratings: pick stats, weight them, group them (an "Aim" or "Movement" rating your way).

**Demos**
- Premier: download the match in CS2 and Veloxify picks it up.
- FACEIT: one click downloads every missing demo through Veloxify's own FACEIT window. No API key; you sign in to FACEIT once, Veloxify never sees your password.
- ESEA league matches work too, including split demos after a server change.

**ESEA League** (only shown if you're on a league team)
- Your team, roster and record, every league match played and to come, your division's standings and its stat leaders.

## Screenshots

| | |
|---|---|
| <img src="docs/screenshots/grenade-video.png" alt="A Dust II lineup with its video: thrower's view, then the molotov burning on Catwalk" width="440"> | <img src="docs/screenshots/grenades.png" alt="Grenades: lineups counted on every map" width="440"> |
| **Grenades**: every lineup from your matches, with its video | **Grenades**: lineups per map, most thrown first |
| <img src="docs/screenshots/breakdown.png" alt="Rating Breakdown: HLTV Rating 3.0 round by round with a plain-language explanation" width="440"> | <img src="docs/screenshots/profile.png" alt="Profile: ratings, FACEIT and Premier stats" width="440"> |
| **Rating Breakdown**: why each round got its rating | **Profile**: ratings and FACEIT / Premier side by side |
| <img src="docs/screenshots/clips.png" alt="Clips: top highlights this week" width="440"> | <img src="docs/screenshots/replay.png" alt="2D replay of a round" width="440"> |
| **Clips**: your best highlights | **2D Replay**: any round, on the map |
| <img src="docs/screenshots/whiff-analyzer.png" alt="Whiff analyzer" width="440"> | <img src="docs/screenshots/timeline.png" alt="Timeline of a round" width="440"> |
| **Whiff analyzer**: why you lost the duel | **Timeline**: every kill, with round swing |
| <img src="docs/screenshots/lineups.png" alt="Grenade lineups on the radar" width="440"> | <img src="docs/screenshots/aim.png" alt="Aim stats" width="440"> |
| **Lineups**: set grenades from the match | **Aim**: Leetify-style aim stats with benchmarks |
| <img src="docs/screenshots/map-zones.png" alt="Map zones" width="440"> | <img src="docs/screenshots/head-to-head.png" alt="Head to head" width="440"> |
| **Map Zones**: where you win and lose fights | **Head to Head**: every matchup in the game |
| <img src="docs/screenshots/insights.png" alt="Match Insights: pistol round splits, tells and timings on Mirage" width="440"> | <img src="docs/screenshots/insights-ask.png" alt="Match Insights Ask: what happens when someone of the T is in Palace" width="440"> |
| **Match Insights**: how players in your matches play the map | **Ask**: what usually follows a situation |
| <img src="docs/screenshots/playstyle.png" alt="Playstyle: roles, T or CT, duel strengths and weaknesses" width="440"> | <img src="docs/screenshots/crosshairs.png" alt="Crosshairs: history, favorites and popular crosshairs" width="440"> |
| **Playstyle**: your roles, duels and best spots | **Crosshairs**: history, favorites, copy and apply |

## Support

Veloxify is free and open source. If it helps your game, you can buy me a coffee on
[Ko-fi](https://ko-fi.com/jdwede). It keeps the updates coming.

## Install

1. Download `Veloxify_x.y.z_x64-setup.exe` from [Releases](../../releases).
2. Windows may say "Windows protected your PC" (the app isn't code-signed): **More info → Run anyway**.
3. Stay logged in to Steam. Veloxify finds your Steam and FACEIT accounts by itself.

Needs Windows 10/11 (64-bit) and CS2 installed through Steam.

## How it works

- **Demos** are parsed locally with a vendored, pinned [demoparser](third_party/demoparser) (MIT).
- **Clips** are recorded from CS2's own demo playback: CS2 runs hidden, Veloxify drives it over the console, captures the window with Windows Graphics Capture and encodes with NVENC (or x264). Your video settings are swapped for the render and always restored.
- **Stats** follow HLTV's Rating 3.0 and Round Swing, and Leetify's published definitions for aim and utility.
- **Nothing is uploaded.** Steam and FACEIT are only asked for public match info and avatars.

## Build from source

```
cargo build --release -p veloxify          # the app
cd app/src-tauri && cargo tauri build      # the installer (bundles ffmpeg; see resources/ffmpeg/README.txt)
```

Layout:
- `app/` — the Veloxify desktop app (Tauri 2): `src-tauri/` (Rust) and `ui/` (HTML/JS/CSS).
- `crates/core` — demo loading, match model, stats, highlights, lowlights, match-page details.
- `crates/render` — rendering clips with CS2 (console control, settings protection, assembly).
- `crates/capture` — window and per-process audio capture, hardware H.264.
- `crates/cli` — `cs2hl` developer CLI (`analyze`, `validate`, `events`, `library`, `render`).
- `third_party/demoparser` — vendored CS2 demo parser (MIT, see `VENDORED.md`).
