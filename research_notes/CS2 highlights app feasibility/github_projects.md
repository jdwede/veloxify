# Open-source CS2 / CS:GO GitHub projects: reuse for a CS2 highlights + stats app (as of 2026-10-02)

**How the data was collected:** about 50 GitHub REST API repository searches were run on 2026-10-02, sorted by stars. They covered the topics cs2, csgo, counter-strike, counter-strike-2, demo-parser and hltv, and the keywords cs2, csgo, "counter strike", hltv, faceit, gsi, "demo parser", "cs2 demo", radar, highlights, leetify, 2d demo, hud, sharecode, "win probability", hlae, stats, analysis and "game state integration". Key repositories were also looked up by name. Example query: `https://api.github.com/search/repositories?q=topic:cs2&sort=stars`.

**What the fields mean:**
- **Stars** are `stargazers_count` from the API on 2026-10-02.
- **Push** is the API's `pushed_at` date, the last push to any branch, used as a stand-in for "last commit".
- **Licence** is GitHub's SPDX detection. Where GitHub said "NOASSERTION", the LICENSE file was read directly.
- **Release dates** come from the GitHub releases API, PyPI, npm or NuGet.

Each repository's URL is the source for its own metadata row.

## Q1. Which GitHub projects with 500 or more stars matter for this app? (ranked by usefulness, then stars)

### Takeaway
Only about 20 relevant projects have 500 or more stars. The core of a CS2 highlights + stats app can be built almost entirely from MIT-licensed, actively maintained code:
- **Parsing:** demoparser2, demoinfocs-golang or awpy.
- **Desktop reference app and video pipeline:** CS Demo Manager.
- **Rendering:** HLAE.
- **Match-list access through the Steam Game Coordinator (GC):** SteamKit or node-steam-user.

Every project listed below was pushed to within the last 30 days, except where noted.

### Cited Findings

**Tier 1: core building blocks, CS2-ready, permissive licences**

| # | Project | Stars | Lang | Licence | Last push / latest release | CS2 | Use in the app / caveats |
|---|---|---|---|---|---|---|---|
| 1 | [akiver/cs-demo-manager](https://github.com/akiver/cs-demo-manager) (CS:DM) | 2,009 | TypeScript (Electron) | MIT | push 2026-09-25; v3.20.1 (2026-07-30) | Yes | The closest existing product to this app. It downloads demos, analyses them into matches and stats, has a 2D viewer, and exports video through HLAE + FFmpeg. MIT means code can be lifted with attribution. Q3 covers it in depth. |
| 2 | [LaihoE/demoparser](https://github.com/LaihoE/demoparser) (demoparser2) | 727 | Rust core, with Python, Node and WASM bindings | MIT | push 2026-09-30; PyPI `demoparser2` 0.42.0 and npm `@laihoe/demoparser2` 0.42.0 (both 2026-08-08); tag v0.42.01 | Yes (CS2 only) | Fastest published parser. You query a demo like a database (`parse_event`, `parse_ticks`), and results come back as DataFrames or JSON. Exposes Premier and competitive rank fields (`rank`, `rank_if_win`/`loss`/`tie`, `comp_rank_type`). |
| 3 | [markus-wa/demoinfocs-golang](https://github.com/markus-wa/demoinfocs-golang) | 1,060 | Go | MIT | push 2026-09-17; v5.2.0 (2026-04-21) | Yes (CS2 and CS:GO) | Event-streaming parser: game events, grenade trajectories, entities, net-messages, MM ranks, full POV demo support, browser and Node support via WASM. It is the parser behind sparkoo's web 2D viewer and hkslover's highlight tool. Requires Go 1.27. |
| 4 | [pnxenopoulos/awpy](https://github.com/pnxenopoulos/awpy) | 617 | Python | MIT | push 2026-09-29; last PyPI release 2.0.2 (2025-03-10) | Yes | HLTV-style stats: ADR, KAST and "Rating". Also visibility checks, `.nav` parsing, and animated round GIFs and heatmaps. Returns Polars DataFrames and requires Python 3.11+. Uses demoparser2 as its backend. PyPI releases lag the actively developed repo. |
| 5 | [advancedfx/advancedfx](https://github.com/advancedfx/advancedfx) (HLAE) | 805 | C++ | MIT, but "the license does not apply to submodules" | push 2026-09-29; v2.192.6 (2026-09-26) | Yes, via AfxHookSource2 | Movie-making hook (`mirv_streams` recording, camera control, death-notice editing). Breaks on CS2 updates and gets patched within days: v2.192.3 to v2.192.6 (23 to 26 Sept 2026) each "adjusted to CS2 update" 1.41.8.x and fixed `mirv_streams` bugs. README warning: HLAE "is technically a hack" and joining VAC servers with it "will probably get you VAC banned". Windows 10+, .NET Framework 4.6.2 and genuine Steam required. |
| 6 | [SteamRE/SteamKit](https://github.com/SteamRE/SteamKit) (SteamKit2) | 3,204 | C# | LGPL-2.1 | push 2026-10-01; 3.4.0 (2026-01-14) | n/a (Steam network) | .NET client for the Steam network. It is the basis for talking to the CS2 GC (recent matches, share-code lookups) from a .NET desktop app. |
| 7 | [DoctorMcKay/node-steam-user](https://github.com/DoctorMcKay/node-steam-user) | 1,121 | JavaScript | MIT | push 2025-12-04; v5.2.3 (2025-05-25) | n/a | Steam client protocol for Node. Pair it with [node-globaloffensive](https://github.com/DoctorMcKay/node-globaloffensive) (365 stars, MIT, push 2026-03-17, v3.2.0 from 2024-10-03), whose `requestRecentGames(steamid)` returns the last 8 matches and whose `requestGame(shareCode)` gets match details including the demo URL. |
| 8 | [ValvePython/steam](https://github.com/ValvePython/steam) | 1,287 | Python | MIT | push 2026-06-23; last PyPI release 1.4.4 (2022-12-10) | n/a | Python Steam client. Releases are stale. Its CS:GO GC companion [ValvePython/csgo](https://github.com/ValvePython/csgo) (132 stars) was last pushed in Feb 2021, so treat the pair as CS:GO-era. |
| 9 | [SteamTracking/Protobufs](https://github.com/SteamTracking/Protobufs) | 581 | protobuf definitions | Unlicense | push 2026-10-02 | Yes | Auto-tracked CS2 GC protobufs, including the match-list messages. These are needed whatever Steam library you use. |

**Tier 2: useful supporting infrastructure**

| # | Project | Stars | Lang | Licence | Last push / release | CS2 | Use / caveats |
|---|---|---|---|---|---|---|---|
| 10 | [obsproject/obs-studio](https://github.com/obsproject/obs-studio) | 76,866 | C | GPL-2.0 | push 2026-10-02 | n/a | Alternative capture path: record CS2 demo playback, or record live play with a replay buffer. |
| 11 | [obsproject/obs-websocket](https://github.com/obsproject/obs-websocket) | 4,357 | C++ | GPL-2.0 | push 2026-10-02 | n/a | "Included by default with OBS Studio 28.0.0 and above". Its v5 server listens on port 4455, so start/stop recording and the replay buffer can be driven from your app over the network. |
| 12 | [FFmpeg/FFmpeg](https://github.com/FFmpeg/FFmpeg) | 64,691 | C | LGPL-2.1+, or GPL if optional parts are enabled ([ffmpeg legal](https://ffmpeg.org/legal.html)) | push 2026-10-02 | n/a | Encodes HLAE `mirv_streams` output into a 1080p60 MP4, and handles clip concatenation. |
| 13 | [roflmuffin/CounterStrikeSharp](https://github.com/roflmuffin/CounterStrikeSharp) | 1,365 | C# | GPL-3.0, with an exception allowing plugins and software built on its published .NET packages to be MIT (from the LICENSE file) | push 2026-10-01; v1.0.376 (2026-09-27) | Yes | Server-side only. Relevant if you run your own CS2 server, for example a practice or nade-lineup server, or replaying demos as bots (see demotracer in Q2). |
| 14 | [alliedmodders/metamod-source](https://github.com/alliedmodders/metamod-source) | 558 | C++ | zlib/libpng-style (from the LICENSE file) | push 2026-10-01 | Yes | Required loader for CounterStrikeSharp and other CS2 server plugins. |
| 15 | [shobhit-pathak/MatchZy](https://github.com/shobhit-pathak/MatchZy) | 500 | C# | MIT | push 2026-10-01; 0.9.0 (2026-10-01) | Yes | CS2 match, practice and scrim plugin, the CS2 successor to get5. CS:DM can analyse MatchZy demos ([CS:DM docs](https://cs-demo-manager.com/docs/guides/demos-analysis)). |
| 16 | [skadistats/clarity](https://github.com/skadistats/clarity) | 768 | Java | BSD-3-Clause | push 2026-09-24; last GitHub release 2.1 (2016) | Yes (Dota 2, CS:GO, CS2, Deadlock) | Fast Java parser. Only relevant if the backend is on the JVM. |
| 17 | [SteamTracking/GameTracking-CS2](https://github.com/SteamTracking/GameTracking-CS2) | 963 | data | none detected | push 2026-09-30 | Yes | Tracks CS2 game-file changes. Useful for spotting map, radar and overview changes after patches. |
| 18 | [ByMykel/CSGO-API](https://github.com/ByMykel/CSGO-API) | 806 | JavaScript (JSON) | MIT | push 2026-10-01 | Yes | JSON of skins, stickers and agents in many languages. Gives weapon and skin names and images for the UI. |
| 19 | [kus/cs2-modded-server](https://github.com/kus/cs2-modded-server) / [joedwards32/CS2](https://github.com/joedwards32/CS2) | 772 / 538 | Shell | LGPL-3.0 / MIT | push 2026-09-29 / 2026-09-24 | Yes | Dedicated-server setups (Metamod + CounterStrikeSharp, and Docker). Only needed for server-side features. |

**Tier 3: overlapping app with a restrictive licence (study it, don't reuse the code)**

| # | Project | Stars | Lang | Licence | Last push / release | CS2 | Notes |
|---|---|---|---|---|---|---|---|
| 20 | [DrEAmSs59/CS2-insight-agent](https://github.com/DrEAmSs59/CS2-insight-agent) | 904 | Python, with a Tauri shell | **PolyForm Noncommercial 1.0.0** (from the LICENSE file); its skin-change core is closed-source | push 2026-09-29; V2.7.5 (2026-09-29) | Yes | Very close to the user's highlight goal. See details below the table. |

What CS2-insight-agent does:
- Watches the demo-download folders of 5E, Perfect World, Valve MM and FACEIT.
- Auto-classifies highlights (multi-kills, one-taps, clutches, knife and jump kills, defuses) and "fail" moments.
- Provides a round timeline, a fast local 2D replay, heatmaps, and overview, player and economy views.
- Records a batch queue by launching CS2 demo playback and **driving OBS**, "with no injection and no hooks". It uses `-insecure` and backs up and restores the user's config.
- Adds victim-POV follow-ups, key-press overlays and kill-effect overlays.
- Has a compilation workbench with FFmpeg export (NVENC, QSV or AMF hardware encoding), a multi-track editor, per-player six-axis stat radar cards (KPR, survival, ADR, KAST, multi-kill rounds, Rating), and optional LLM commentary.
- Uses a custom PyO3-built demoparser2 extension.

**Its licence forbids commercial use**, so it can serve only as a design reference.

**Legacy CS:GO-era projects with 500 or more stars (do not use for CS2)**
- [splewis/get5](https://github.com/splewis/get5): 556 stars, SourcePawn, GPL-3.0, last push 2023-11-14. CS:GO SourceMod match plugin, replaced by MatchZy on CS2.
- [alliedmodders/sourcemod](https://github.com/alliedmodders/sourcemod): 1,149 stars, C++, push 2026-10-02. Source 1 scripting. The CS2 server ecosystem shown in [kus/cs2-modded-server](https://github.com/kus/cs2-modded-server) uses Metamod + CounterStrikeSharp instead.
- [ValveSoftware/csgo-demoinfo](https://github.com/ValveSoftware/csgo-demoinfo): 518 stars, C++, BSD-2-Clause, last push 2023-03-12. Valve's CS:GO demo parsing sample. CS:GO only.
- [TeaPearce/Counter-Strike_Behavioural_Cloning](https://github.com/TeaPearce/Counter-Strike_Behavioural_Cloning): 506 stars, Python, no licence, push 2024-10-29. Research code and dataset for an IEEE CoG / NeurIPS workshop paper on CS:GO deathmatch behavioural cloning. Background reading for ML only.
- Just under 500 stars:
  - [saul/demofile](https://github.com/saul/demofile): 496 stars, JavaScript, MIT, **archived**. CS:GO-only Node parser. Its successor is demofile-net.
  - [gigobyte/HLTV](https://github.com/gigobyte/HLTV): 497 stars, TypeScript, MIT, last release v3.5.0 (2023-09-20), push 2025-03-03. Unofficial HLTV scraper API. Stale, and depends on scraping.

**CS-related projects with 500 or more stars that are not relevant**
- Skin trading:
  - [Steamauto/Steamauto](https://github.com/Steamauto/Steamauto) (1,303, AGPL-3.0)
  - [EricZhu-42/SteamTradingSiteTracker](https://github.com/EricZhu-42/SteamTradingSiteTracker) (2,320)
  - [IatomicreactorI/CSGOTrading](https://github.com/IatomicreactorI/CSGOTrading) (579)
  - [csfloat/inspect](https://github.com/csfloat/inspect) (544, archived)
  - [nombersDev/casemove](https://github.com/nombersDev/casemove) (703)
- Other:
  - [ed0ard/CS2-Bot-Improver](https://github.com/ed0ard/CS2-Bot-Improver) (1,201, AGPL-3.0; server bot AI)
  - [FN-FAL113/cs2-server-picker](https://github.com/FN-FAL113/cs2-server-picker) (620)
  - [ekmas/cs16.css](https://github.com/ekmas/cs16.css) (2,025; a CSS theme)
  - CS 1.6 engine work: [rehlds/ReGameDLL_CS](https://github.com/rehlds/ReGameDLL_CS) (792) and [rehlds/ReHLDS](https://github.com/rehlds/ReHLDS) (861)
  - [solcloud/Counter-Strike](https://github.com/solcloud/Counter-Strike) (986; a PHP game)
  - [ValveSoftware/csgo-osx-linux](https://github.com/ValveSoftware/csgo-osx-linux) (859; issue tracker)
  - [ValveSoftware/counter-strike_rules_and_regs](https://github.com/ValveSoftware/counter-strike_rules_and_regs) (625)
  - [antonpup/Aurora](https://github.com/antonpup/Aurora) (1,841; RGB lighting)

### Inferences
- The ≥500-star CS2 ecosystem is small and concentrated. The only full apps are CS:DM (MIT) and CS2-insight-agent (non-commercial). Everything else is a library or infrastructure.
- The demo-parsing layer is effectively solved. Three maintained, MIT-licensed, CS2-capable parsers exist in Rust, Go and C# (demofile-net, Q2), so pick by host language.
- HLAE is the de-facto rendering tool, but it needs a patch after each CS2 update. Shipping an auto-highlight feature on top of it means your users will hit downtime of a day or more after big CS2 patches.

### Gaps
- awpy's "Rating" was not checked: is it HLTV 1.0, 2.0, 2.1 or 3.0, or awpy's own approximation? The README only says "Rating", and the docs page was not opened.
- No ≥500-star self-hosted "Leetify clone" or stats website for CS2 was found. Searches for leetify, "cs2 stats" and "csgo stats" returned only projects with fewer than 65 stars.
- clarity's recent release channel (Maven) was not checked. Its last GitHub release is from 2016.

## Q2. Which projects under 500 stars are critical or notable?

### Takeaway
Several of the most directly reusable pieces have fewer than 500 stars:
- CS:DM's own engines: cs-demo-analyzer and boiler-writter.
- demofile-net, the C# parser.
- Web 2D viewers.
- GSI libraries.
- Segra, an OBS-based auto-highlight recorder.

Pay close attention to licence here. Several have no licence or a copyleft one (AGPL, GPL).

### Cited Findings

**Parsing and analysis**
- [saul/demofile-net](https://github.com/saul/demofile-net):
  - 182 stars, C#, MIT, push 2026-05-09, tag v0.44.1. NuGet package `DemoFile.Game.Cs`.
  - Supports CS2 and Deadlock, CSTV/GOTV and POV demos, HTTP broadcasts (live), game events, entity updates, and seeking forwards and backwards.
  - Strongly typed API. The best fit if the Windows app is .NET (WPF, WinUI or Avalonia).
- [akiver/cs-demo-analyzer](https://github.com/akiver/cs-demo-analyzer) (CSDA):
  - 126 stars, Go, MIT, push 2026-09-09, v1.11.0 (2026-09-02).
  - The analysis engine CS:DM uses ([CS:DM deps](https://cs-demo-manager.com/docs/development/deps)). It ships as a CLI and a Go API (`api.AnalyzeDemo`) that exports CSV, JSON or the CS:DM format, optionally with positions.
  - Has per-source handling, set with `-source`: challengermode, ebot, esea, esl, esportal, **faceit**, fastcup, 5eplay, perfectworld, popflash, **valve**.
- [Rupas1k/source2-demo](https://github.com/Rupas1k/source2-demo): 71 stars, Rust, Apache-2.0. Parser for Dota 2, Deadlock and CS2.
- [Igor-Losev/deadem](https://github.com/Igor-Losev/deadem): 27 stars, JavaScript, MIT, push 2026-10-01. Pure-JavaScript parser and player for Deadlock, CS2 and Dota 2.
- Archived and CS:GO-only:
  - [StatsHelix/demoinfo](https://github.com/StatsHelix/demoinfo) (320, C#)
  - [markus-wa/cs-demo-minifier](https://github.com/markus-wa/cs-demo-minifier) (71)

**Fetching demos: Steam GC and share codes**
- [akiver/boiler-writter](https://github.com/akiver/boiler-writter):
  - 36 stars, C++, MIT, v1.7.0 (2025-12-21).
  - Gets `CMsgGCCStrike15_v2_MatchList` from the Steam GC through the Steamworks SDK and writes it to a file. It was written so CS:DM can download recent MM demos.
- [akiver/csgo-sharecode](https://github.com/akiver/csgo-sharecode): 63 stars, TypeScript, MIT, push 2026-09-24. Encodes and decodes CS share codes.
- [claabs/cs-demo-downloader](https://github.com/claabs/cs-demo-downloader): 26 stars, TypeScript, push 2026-08-04. Description: "Automatically download Counter-Strike demos of Premier, competitive, and wingman matches". The README could not be fetched, so the method and licence were not checked.
- [akiver/csgo-voice-extractor](https://github.com/akiver/csgo-voice-extractor): 41 stars, Go, MIT. Exports player voices from CS:GO and CS2 demos to WAV.

**2D replay in the browser or desktop**
- [sparkoo/csgo-2d-demo-viewer](https://github.com/sparkoo/csgo-2d-demo-viewer):
  - 81 stars, JavaScript, MIT, push 2026-09-30.
  - "Web based CS2 2d demo player", live at 2d.sparko.cz. The parser is demoinfocs-golang compiled to **WebAssembly**, with a Preact player and a custom protobuf message format.
  - Its Go server is only a demo-download proxy, deployed on Firebase Hosting and Cloud Run.
  - Ships a FACEIT browser extension that fetches the demo URL from the FACEIT API and opens the player.
- [zenojunior/cs2d](https://github.com/zenojunior/cs2d):
  - 21 stars, Vue, **no licence detected**, push 2026-07-02.
  - 100% client-side 2D viewer that parses in a Web Worker.
  - Features: heatmaps (deaths, presence, utility; multi-floor), grenade trajectories, flash effectiveness (who blinded whom and for how long), HE and molotov damage per player, economy per round, telestrator drawing, voice comms playback, and a compact `.cs2dv` export.
  - A good feature reference for the smoke and utility analyser. Without a licence the code can't legally be reused.
- [Linus4/csgoverview](https://github.com/Linus4/csgoverview): 195 stars, Go, MIT, push 2024-05-11. CS:GO 2D replay only.
- [pnxenopoulos/ggViz](https://github.com/pnxenopoulos/ggViz): 5 stars, MIT. Old CS:GO visualisation app.

**Highlights, recording and rendering**
- [Segergren/Segra](https://github.com/Segergren/Segra):
  - 222 stars, C#, **GPL-2.0**, v1.8.1 (2026-09-26).
  - Recorder built on OBS: replay buffer, up to 4K 144 fps, HDR, H.264/HEVC/AV1 via NVENC, AMF, QSV or x264, and a clip editor.
  - "Auto highlights from kill/death tracking in CS2" and other games, with upload to Segra.tv.
  - The live-gameplay alternative to rendering from demos.
- [hkslover/cs2-highlight-tool](https://github.com/hkslover/cs2-highlight-tool):
  - 59 stars, Go (Wails), **no licence detected**, push 2026-09-20.
  - Imports local demos and demos from Perfect World and 5E, selects kill clips by player or round (killer and victim POV), drives recording, and stitches the output.
  - Credits HLAE, demoinfocs-golang, FFmpeg and cs-demo-manager.
- [Co1Swet/MulNX_CS2](https://github.com/Co1Swet/MulNX_CS2): 125 stars, C++, **AGPL-3.0**, push 2026-10-02. "Full-stack CS2 GOTV/Demo visual production platform" with camera paths and a real-time GUI.
- [unicbm/demotracer](https://github.com/unicbm/demotracer):
  - 65 stars, Rust, **AGPL-3.0**, push 2026-09-30.
  - Converts CS2 demos so they can be **replayed through bots on a local CS2 server**: movement, view angles, subtick input, grenade throws, cosmetics.
  - Needs Metamod 2.0 and a CounterStrikeSharp build with KHook support.
- [Run1e/STRIKER](https://github.com/Run1e/STRIKER): 196 stars, Python, GPL-3.0, push 2023-08-31. Records CS:GO highlights from Discord. CS:GO only.
- [henb13/frag-finder](https://github.com/henb13/frag-finder): 26 stars, MIT, 2023. Finds highlights from CS:DM JSON exports. CS:GO-era.
- [advancedfx/ReShade_advancedfx](https://github.com/advancedfx/ReShade_advancedfx): 13 stars, MIT. Connects HLAE `mirv_streams` to ReShade.

**Game State Integration (GSI), HUDs and observing**
- GSI libraries:
  - [antonpup/CounterStrike2GSI](https://github.com/antonpup/CounterStrike2GSI): 181 stars, C#, **GPL-3.0**, v1.0.4 (2026-03-21).
  - [rakijah/CSGSI](https://github.com/rakijah/CSGSI): 126 stars, C#. GitHub shows NOASSERTION; the LICENSE file contains MIT-style text. Push 2023-12-27, CS:GO-era.
  - [osztenkurden/csgogsi](https://github.com/osztenkurden/csgogsi): 50 stars, TypeScript, MIT, push 2026-09-17. Turns CS2 and CS:GO GSI data into typed match state and gameplay events.
  - [ShaunLWM/node-csgo-gsi](https://github.com/ShaunLWM/node-csgo-gsi): 91 stars, MIT, last push 2023-05.
  - [Erlendeikeland/csgo-gsi-python](https://github.com/Erlendeikeland/csgo-gsi-python): 62 stars, MIT, last push 2021.
  - [alebcj/cs2-gsi-z](https://github.com/alebcj/cs2-gsi-z): 40 stars, TypeScript, MIT.
  - [lupusbytes/cs2mqtt](https://github.com/lupusbytes/cs2mqtt): 81 stars, C#. GSI to MQTT bridge.
- Lexogrine:
  - [lexogrine/hud-manager](https://github.com/lexogrine/hud-manager) (LHM.gg): 283 stars, **proprietary EULA**; the free tier shows a "Powered by Lexogrine HUD Manager" watermark. v6.3.1 (2026-06-23).
  - [lexogrine/cs2-react-hud](https://github.com/lexogrine/cs2-react-hud): 45 stars, TypeScript, MIT, push 2026-09-01. Example HUD for LHM.
  - [lexogrine/csgo-react-hud](https://github.com/lexogrine/csgo-react-hud): 110 stars, MIT, push 2024-10-16.
- Other HUDs and observer tools:
  - [boltgolt/boltobserv](https://github.com/boltgolt/boltobserv): 385 stars, JavaScript, GPL-3.0, push 2026-05-15. An "external CS radar made specifically for observing", which uses GSI rather than memory reading.
  - [drweissbrot/cs-hud](https://github.com/drweissbrot/cs-hud): 365 stars, JavaScript, ISC, push 2025-09-26.
  - [JohnTimmermann/JTs-Hud](https://github.com/JohnTimmermann/JTs-Hud): 220 stars, Vue, GPL-3.0.

**Analytics and ML**
- [Gary2005/cs-net](https://github.com/Gary2005/cs-net): 109 stars, MIT, push 2026-09-10. "Transformer-based deep learning framework for analyzing Counter-Strike 2 match replays".
- [eigenpaul/cs2-evalbar](https://github.com/eigenpaul/cs2-evalbar): 0 stars, Python, MIT, push 2026-07-06. Round-win-probability model for CS2 demos.
- [pnxenopoulos/esta](https://github.com/pnxenopoulos/esta): 53 stars, **CC-BY-SA-4.0**, push 2025-02-22. ESTA, the Esports Trajectories and Actions dataset (CS:GO-era).
- [David-Durst/csknow](https://github.com/David-Durst/csknow): 124 stars, C++, MIT, push 2024-09-22. CS:GO research.
- [kamalchah/CounterStrikeWinProb](https://github.com/kamalchah/CounterStrikeWinProb) and [nkashyap14/WPAModelCSGO](https://github.com/nkashyap14/WPAModelCSGO): 1 and 0 stars. Toy win-probability models.

**FACEIT tools and extensions**
- [repeekgg/browser-extension](https://github.com/repeekgg/browser-extension): 144 stars, GPL-3.0, **archived**, last push 2025-02-10.
- [Faceit-Forecast/Forecast](https://github.com/Faceit-Forecast/Forecast): 35 stars, **archived**.
- [iffypixy/faceitperf](https://github.com/iffypixy/faceitperf): 62 stars, TypeScript, MIT, push 2026-06-27. Performance tracker.
- [CSNADESgg/faceit-to-leetify-extension](https://github.com/CSNADESgg/faceit-to-leetify-extension): 30 stars. Uploads FACEIT demos to Leetify.
- [mxgic1337/faceit-stats-widget](https://github.com/mxgic1337/faceit-stats-widget): 33 stars. Streamer widget.
- The original "FACEIT Enhancer" only appears as an archived [faceit-enhancer/website](https://github.com/faceit-enhancer/website) repo (1 star).

### Inferences
- For a .NET Windows app, the cleanest permissive pipeline is demofile-net (parse) + SteamKit2 (GC) + HLAE (render) + FFmpeg (encode), using CS:DM as a reference.
- For an Electron or Node app, the cleanest is `@laihoe/demoparser2` + node-steam-user/node-globaloffensive + HLAE + FFmpeg. Either way CS:DM's MIT-licensed code is the main reference implementation.
- Most active CS2 highlight tools (insight-agent, hkslover, MulNX, demotracer) carry licences that block commercial reuse: non-commercial, none, or AGPL. Only CS:DM (MIT) is safe to copy from.
- zenojunior/cs2d and CS2-insight-agent show the feature bar for the utility analyser and 2D replay (heatmaps, flash effectiveness, grenade trajectories, drawing, voice). Meeting it needs an original implementation.

### Gaps
- Whether cs-demo-analyzer is built on demoinfocs-golang was not confirmed. Its README doesn't say.
- The method and licence of claabs/cs-demo-downloader were not checked (README returned 404).
- No published CS2 auto-highlight scoring algorithm with a permissive licence was found. CS2-insight-agent documents its tag taxonomy, but its code is non-commercial.

## Q3. CS Demo Manager in depth: how far does it overlap the planned app, and what can be reused?

### Takeaway
CS:DM (MIT, 2,009 stars, v3.20.1 from July 2026) already covers most of the planned desktop features:
- Valve and other platforms' demo downloads.
- Analysis of many demo sources into a PostgreSQL database.
- A 2D viewer with voice playback.
- A queued video export pipeline: CS2 + HLAE `mirv_streams` + FFmpeg, with sequences, camera focus and death notices.
- A CLI.

It does **not** auto-select highlights. **In-app FACEIT downloads are currently disabled** because FACEIT moved demo downloads behind a private API.

### Cited Findings
- **Licence:** MIT ([README](https://github.com/akiver/cs-demo-manager)).
- **Architecture** ([architecture](https://cs-demo-manager.com/docs/development/architecture)):
  - Electron, with a separate Node.js WebSocket-server daemon that does "almost all the heavy work" (database, filesystem, demo analysis).
  - The GUI and CLI attach to the same daemon. Messages are JSON `{name, payload}`.
- **Bundled tools** ([deps](https://cs-demo-manager.com/docs/development/deps)):
  - Uses cs-demo-analyzer (Go CLI) for analysis.
  - Uses boiler-writter (C++) to fetch matchmaking data for the logged-in Steam account from the GC.
- **Downloads** ([downloads](https://cs-demo-manager.com/docs/guides/downloads)):
  - **Valve:** last **8** matchmaking matches through the GC ("Only the last 8 matches are available because the Steam Game Coordinator only provides this data"). Needs Steam running, and briefly launches CS2 in the background. Demos can also be fetched by share code. "The demo's download link for a match expires 1 month after the match ends." CS:DM never asks for Steam credentials.
  - **FACEIT:** The docs say FACEIT "restricted demo downloads to a private API" and gave CS:DM a server-side key, which would require "our own backend service". "There is no ETA for restoring in-app downloads". Users must download from the browser.
  - **Others:** Renown (by SteamID64) and 5EPlay downloads are supported. Background and startup auto-download options exist.
- **Analysis sources** ([demos-analysis](https://cs-demo-manager.com/docs/guides/demos-analysis)):
  - CS2 is supported for 5EPlay, Challengermode, eBot, ESL, Esplay, Esportal, Esportligaen, FACEIT, FASTCUP, MatchZy, Perfect World, Renown and Valve MM.
  - Private-server demos (`tv_record` run by hand) are not supported.
  - zip, gz and bz2 archives can be extracted automatically.
- **Storage** ([database](https://cs-demo-manager.com/docs/guides/database)): PostgreSQL, local or remote. Positions for the 2D viewer take a lot of space; a "Delete positions" option "strongly reduces disk usage".
- **2D viewer** ([2d-viewer](https://cs-demo-manager.com/docs/guides/2d-viewer)):
  - Lower and upper radar levels with adjustable offset and opacity.
  - Pen and eraser drawing mode.
  - Audio playback synced to the demo, including a "Generate audio file" button that extracts voice chat. Valve MM demos have no voice data.
- **Video** ([video](https://cs-demo-manager.com/docs/guides/video)):
  - Queued jobs made of "sequences" (start and end tick; CS2 runs at 64 ticks per second).
  - Per-sequence camera focus on players, fixed viewpoint cameras, player options, and custom game commands.
  - Two recording systems: the game's `startmovie` (raw TGA + WAV output) or **HLAE `mirv_streams`**.
  - Output can be video, images, or both. Settings include width, height and frame rate, encoded with FFmpeg or VirtualDub.
  - "If your goal is to generate a video and you are on Windows, the best option is to use HLAE + FFmpeg as it doesn't need to generate raw files and is faster."
  - Death-notice editing via HLAE is Windows only. On Linux, CS2 video works with FFmpeg only.
  - Warns that game updates may break HLAE compatibility.
- **Game control plugin** ([cs-server-plugin](https://cs-demo-manager.com/docs/development/cs-server-plugin)):
  - For CS2, CS:DM loads a custom library into the game that connects to its WebSocket server. It reads an "actions file" (`myDemo.dem.json`) of `{tick, cmd}` entries such as `demo_gototick`.
  - The reason: "CS2 doesn't support VDM files", and `-netconport` needs `-tools`/Workshop tools.
  - The library "may break when the game is updated".
- **CLI** ([cli](https://cs-demo-manager.com/docs/cli)): CS:DM ships a `csdm` CLI for tasks without the GUI.

### Inferences
- The fastest MVP is to fork or embed CS:DM's pipeline (MIT). Use its CLI and daemon for analysis and video, and add an auto-highlight selector on top. The selector would turn kill and multi-kill events into "sequences" and actions files, rendered at 1920×1080, 60 fps.
- CS:DM's FACEIT situation shows that FACEIT demo fetching for a distributed app now needs a FACEIT Downloads API grant plus a backend you operate.
- CS:DM's 8-match Valve limit means the app must poll regularly (for example via a tray process) to build per-day or per-session history. Share codes from the Steam match-history auth-code API (out of scope here) would extend coverage.
- CS:DM appears to be installed on the user's machine already (its install folder is on PATH), so it can be used for hands-on evaluation right away.

### Gaps
- No CS:DM benchmark for analysis time per demo is published in the docs.
- CS:DM's stats definitions (which HLTV rating version it computes) were not checked.
- No CS:DM docs claim auto-highlight detection; the docs pages read didn't show any.

## Q4. Which repositories are excluded as cheats or legally risky?

### Takeaway
A large share of the highest-starred "CS2" repositories are cheats, offset dumpers or anti-cheat bypasses. All are excluded. Using or bundling them risks VAC or FACEIT AC bans and reputational or legal harm.

### Cited Findings
Excluded as cheats or cheat infrastructure (do not use or recommend):
- [danielkrupinski/Osiris](https://github.com/danielkrupinski/Osiris): 3,877 stars. "game hack for Counter-Strike 2".
- [a2x/cs2-dumper](https://github.com/a2x/cs2-dumper): 2,383 stars. Offset dumper.
- [KEV0143/Direct-memory-access-CS2-DMA](https://github.com/KEV0143/Direct-memory-access-CS2-DMA): 1,850 stars.
- [RootKit-Org/AI-Aimbot](https://github.com/RootKit-Org/AI-Aimbot): 2,078 stars, archived.
- [frk1/hazedumper](https://github.com/frk1/hazedumper): 1,677 stars.
- [TKazer/CS2_External](https://github.com/TKazer/CS2_External): 841 stars.
- [Valthrun/valthrun-cs2](https://github.com/Valthrun/valthrun-cs2): 816 stars. Kernel "gameplay enhancer".
- [clauadv/cs2_webradar](https://github.com/clauadv/cs2_webradar): 661 stars. "undetected ... browser based radar cheat".
- [IMXNOOBX/cs2-external-esp](https://github.com/IMXNOOBX/cs2-external-esp): 589 stars.
- [danielkrupinski/VAC](https://github.com/danielkrupinski/VAC), [VAC-Bypass](https://github.com/danielkrupinski/VAC-Bypass) and [VAC-Bypass-Loader](https://github.com/danielkrupinski/VAC-Bypass-Loader): 819, 661 and 514 stars.
- [slack2450/csgo-dma-overlay](https://github.com/slack2450/csgo-dma-overlay): 819 stars.
- [Jire/Charlatano](https://github.com/Jire/Charlatano): 665 stars.
- [AimTuxOfficial/AimTux](https://github.com/AimTuxOfficial/AimTux): 664 stars.
- [245950258/How-to-create-a-csgo-cheating-program](https://github.com/245950258/How-to-create-a-csgo-cheating-program): 930 stars.
- [Speedi13/ROP-COMPILER](https://github.com/Speedi13/ROP-COMPILER): 556 stars.
- Under 500 stars: ByteCorum/DragonBurn (378), avitran0/deadlocked (406), leo4048111/Potato-Injector (176), mlghuskie/NoBastian (145; a FACEIT/ESEA AC bypass), and more.

Handle with caution:
- [emp0ry/cs2-ErScripts](https://github.com/emp0ry/cs2-ErScripts): 496 stars. "multi-feature tool" of scripts. Gray area, so don't use.

Excluded for legal or IP reasons:
- [perilouswithadollarsign/cstrike15_src](https://github.com/perilouswithadollarsign/cstrike15_src): 1,665 stars. Self-described "Leak of CS:GO Source code".

Related caution:
- HLAE's own README warns that it is "technically a hack" and should only be used for videos and demo playback, because joining VAC-protected servers with it will probably get you VAC banned ([advancedfx](https://github.com/advancedfx/advancedfx)).
- CS2-insight-agent warns not to run its `-insecure` recording client alongside a matchmaking-connected CS2 client ([CS2-insight-agent](https://github.com/DrEAmSs59/CS2-insight-agent)).

### Inferences
- The app's rendering step must run CS2 in an isolated, `-insecure` demo-playback session, separate from the user's matchmaking session. The UI should make that clear so users don't take HLAE or the CS:DM plugin into VAC-secured play.

### Gaps
- None material.

## Q5. What is the most practical library stack for (a) parsing, (b) HLTV-style stats, (c) browser 2D replay, (d) video rendering and (e) fetching Premier and FACEIT demos?

### Takeaway
- **Parse:** demoparser2 (Rust; Python, Node or WASM) or demofile-net (C#).
- **Stats:** awpy, or a port of cs-demo-analyzer's logic.
- **2D replay:** demoparser2-WASM or demoinfocs-WASM in a Web Worker plus a canvas renderer, following sparkoo's MIT viewer.
- **Video:** CS2 + HLAE `mirv_streams` + FFmpeg, orchestrated the way CS:DM does it. OBS + obs-websocket is the no-injection fallback.
- **Demo fetching:**
  - Premier/MM: the Steam GC via SteamKit2, node-globaloffensive or boiler-writter, plus share-code decoding.
  - FACEIT: the official Data API plus the gated Downloads API, called from your own backend.

### Cited Findings
- **(a) Parsing**
  - demoparser2 offers query-style Python and Node APIs plus a WASM build (`npm i demoparser2`) and is MIT ([demoparser](https://github.com/LaihoE/demoparser)).
  - demofile-net offers typed C# events and entities, seeking, and live HTTP broadcast parsing ([demofile-net](https://github.com/saul/demofile-net)).
  - demoinfocs-golang offers event streaming, WASM and full POV support ([demoinfocs-golang](https://github.com/markus-wa/demoinfocs-golang)).
- **(b) Stats**
  - awpy computes "ADR, KAST and Rating", returns kills, damages, grenades, smokes, infernos, shots, footsteps and ticks as Polars DataFrames, and does visibility checks and nav-mesh distances ([awpy](https://github.com/pnxenopoulos/awpy)).
  - cs-demo-analyzer produces a full `Match` (kills etc.) with per-platform source handling, exportable to JSON or CSV ([cs-demo-analyzer](https://github.com/akiver/cs-demo-analyzer)).
- **(c) 2D replay**
  - sparkoo's viewer (MIT) uses demoinfocs compiled to WASM plus Preact and a protobuf message format. The only server it needs is a demo-download proxy ([sparkoo viewer](https://github.com/sparkoo/csgo-2d-demo-viewer)).
  - zenojunior/cs2d parses fully client-side in a Web Worker and adds heatmaps, grenade trajectories and flash effectiveness. Use it as a feature reference only, since it has no licence ([cs2d](https://github.com/zenojunior/cs2d)).
  - CS:DM's 2D viewer adds radar levels, drawing and voice sync ([CS:DM 2D viewer](https://cs-demo-manager.com/docs/guides/2d-viewer)).
- **(d) Rendering**
  - CS:DM recommends HLAE + FFmpeg on Windows (no raw files, faster). It controls CS2 playback through a loaded library and a `{tick, cmd}` actions file, because CS2 lacks VDM support ([CS:DM video](https://cs-demo-manager.com/docs/guides/video); [CS:DM plugin](https://cs-demo-manager.com/docs/development/cs-server-plugin)).
  - HLAE is currently CS2-compatible (v2.192.6, 2026-09-26) but needs updates after CS2 patches ([HLAE releases](https://github.com/advancedfx/advancedfx/releases)).
  - The OBS approach: CS2-insight-agent records CS2 demo playback by controlling OBS, with "no injection, no hook", and exports through FFmpeg with NVENC, QSV or AMF ([CS2-insight-agent](https://github.com/DrEAmSs59/CS2-insight-agent)). obs-websocket is built into OBS 28+ on port 4455 ([obs-websocket](https://github.com/obsproject/obs-websocket)).
- **(e) Fetching demos**
  - Valve GC tools:
    - node-globaloffensive: `requestRecentGames(steamid)` returns at most 8 matches; `requestGame(shareCode)` returns match details ([node-globaloffensive](https://github.com/DoctorMcKay/node-globaloffensive)).
    - boiler-writter: fetches `CMsgGCCStrike15_v2_MatchList` through the Steamworks SDK ([boiler-writter](https://github.com/akiver/boiler-writter)).
    - SteamKit2: the .NET equivalent ([SteamKit](https://github.com/SteamRE/SteamKit)).
    - csgo-sharecode: decodes share codes ([csgo-sharecode](https://github.com/akiver/csgo-sharecode)).
    - Demo links expire about one month after the match ([CS:DM downloads](https://cs-demo-manager.com/docs/guides/downloads)).
  - FACEIT:
    - Demo files are private by default and can only be fetched by signed URL through `POST /download/v2/demos/download`. This requires "an exclusive Access Token that has a Downloads API scope", granted after an application form with an expected 30-day response.
    - A "Match Demo Ready" webhook exists ([FACEIT Download API docs](https://docs.faceit.com/getting-started/Guides/download-api)).

### Inferences
- **Recommended Windows-first stack (C#/.NET):**
  - DemoFile.Game.Cs for parsing.
  - Your own stats layer, porting formulas from awpy and cs-demo-analyzer (both MIT).
  - SteamKit2 + SteamTracking protobufs for the GC.
  - HLAE + FFmpeg (NVENC) for 1080p60 rendering.
  - A WebView2 or React front-end that reuses a WASM parser for the 2D viewer later.
- **Alternative stack (Electron/TypeScript, closest to CS:DM):** `@laihoe/demoparser2` (Node, plus WASM for the web), node-steam-user + node-globaloffensive, and CS:DM's video module.
- **Python sidecar option:** awpy + demoparser2 gives HLTV-style stats with the least effort.
- For a later public website, the same demoparser2 or demoinfocs WASM build allows client-side parsing, avoiding server CPU costs and demo uploads, as sparkoo and cs2d do. Server-side rendering of video would need Windows hosts running genuine Steam + CS2 + HLAE, which is operationally heavy and risky under Steam's terms (not verified here).

### Gaps
- Whether HLAE `mirv_streams` in CS2 supports arbitrary frame rates such as 60 fps reliably was not checked in its wiki. CS:DM exposes a frame-rate setting, which suggests it does.
- Valve's match-history auth-code API (used to enumerate share codes beyond the last 8 matches) was outside this repository survey.

## Q6. What performance figures are published?

### Takeaway
Published parser benchmarks put a full competitive CS2 demo at roughly 0.1 to 0.9 seconds per demo on modern desktop CPUs. Demo parsing will not be the bottleneck. Rendering with HLAE in real time or near real time will be.

### Cited Findings
- **demoparser2:** benchmarked on 50 demos (a mix of MM, FACEIT and HLTV; 4.6 GB in total), extracting coordinates of all player deaths ([demoparser README](https://github.com/LaihoE/demoparser)).
  - Ryzen 5900X (12 cores), NVMe: **6.14 s in total, 749 MB/s**.
  - i5-1335G7 (4 cores): **14.00 s, 328 MB/s**.
  - "Python/JS are roughly as fast."
  - Note that this measures a narrow query, not full tick extraction.
- **demofile-net:** "can read a full competitive game (just under 1 hour of game time) in under a second", including all entity data ([demofile-net README](https://github.com/saul/demofile-net)).
  - Apple M1 Pro, .NET 10: `ParseDemo` **903 ms** (about 598 MB allocated); `ReadAllParallelAsync` **353 ms**.
- **demoinfocs-golang:** i7-6700K, Windows 10, a demo with 85,000 frames ([demoinfocs README](https://github.com/markus-wa/demoinfocs-golang)).
  - **0.89 s** per demo, about 25 minutes of gameplay per second.
  - 8 demos concurrently in **2.06 s**.
  - Caveat: the hardware and frame count suggest this benchmark predates CS2. No CS2-specific figure is published.

### Inferences
- Dividing demoparser2's 6.14 s by 50 demos gives about 0.12 s per demo for that query on a 12-core desktop. Full per-tick extraction for a 2D replay will be slower and more memory-hungry (demofile-net allocates about 600 MB per full parse).

### Gaps
- No published numbers for awpy end-to-end stats time, CS:DM analysis time, or HLAE render speed (seconds of 1080p60 output per wall-clock second).

## Q7. What do the licences imply for a public, possibly monetised website?

### Takeaway
The recommended core is commercially safe with attribution: demoparser2, demoinfocs, demofile-net, awpy, CS:DM, cs-demo-analyzer, HLAE core, node-steam-user and node-globaloffensive, csgo-sharecode, sparkoo's viewer, and MatchZy are MIT; SteamKit2 is LGPL. Avoid copying code from:
- **AGPL:** MulNX, demotracer.
- **Non-commercial:** CS2-insight-agent.
- **No licence:** hkslover, cs2d.
- **GPL:** Segra, CounterStrike2GSI, boltobserv, JTs-Hud, repeek.

### Cited Findings
- **MIT:** CS:DM, demoparser2, demoinfocs-golang, awpy, demofile-net, cs-demo-analyzer, boiler-writter, csgo-sharecode, MatchZy, node-steam-user, node-globaloffensive, ValvePython/steam, sparkoo's 2D viewer, csgogsi and cs2-react-hud. Sources: the respective repo pages above, from the GitHub API licence fields, with demoparser's LICENSE checked as MIT.
- **HLAE:** MIT, but "the license does not apply to submodules" ([advancedfx](https://github.com/advancedfx/advancedfx)).
- **SteamKit:** LGPL-2.1 ([SteamKit](https://github.com/SteamRE/SteamKit)).
- **CounterStrikeSharp:** GPL-3.0, with the special exception that derivative works ("plugins and extensions, or any software built referencing published .NET packages") may be MIT ([CounterStrikeSharp LICENSE](https://github.com/roflmuffin/CounterStrikeSharp)).
- **OBS Studio and obs-websocket:** GPL-2.0 ([obs-studio](https://github.com/obsproject/obs-studio); [obs-websocket](https://github.com/obsproject/obs-websocket)).
- **Segra:** "GPLv2 licensed" ([Segra](https://github.com/Segergren/Segra)).
- **FFmpeg:** LGPL-2.1+, but "if those [optional GPL] parts get used the GPL applies to all of FFmpeg". FFmpeg is not available under proprietary terms ([FFmpeg legal](https://ffmpeg.org/legal.html)).
- **CS2-insight-agent:** PolyForm Noncommercial 1.0.0 ([LICENSE](https://github.com/DrEAmSs59/CS2-insight-agent)).
- **AGPL-3.0:** MulNX_CS2 ([repo](https://github.com/Co1Swet/MulNX_CS2)) and demotracer ([repo](https://github.com/unicbm/demotracer)).
- **GPL-3.0:** CounterStrike2GSI ([repo](https://github.com/antonpup/CounterStrike2GSI)), boltobserv ([repo](https://github.com/boltgolt/boltobserv)), JTs-Hud ([repo](https://github.com/JohnTimmermann/JTs-Hud)) and get5 ([repo](https://github.com/splewis/get5)).
- **Lexogrine HUD Manager:** a proprietary EULA with a watermark on the free tier ([hud-manager LICENSE](https://github.com/lexogrine/hud-manager)).
- **ESTA dataset:** CC-BY-SA-4.0 ([esta](https://github.com/pnxenopoulos/esta)).
- **No licence detected:** hkslover/cs2-highlight-tool ([repo](https://github.com/hkslover/cs2-highlight-tool)), zenojunior/cs2d ([repo](https://github.com/zenojunior/cs2d)) and TeaPearce behavioural cloning ([repo](https://github.com/TeaPearce/Counter-Strike_Behavioural_Cloning)).
- **FACEIT demos** for third-party apps need a Downloads API token, and the application process takes up to about 30 days ([FACEIT docs](https://docs.faceit.com/getting-started/Guides/download-api)).

### Inferences
- **MIT components:** keep the copyright and licence notices in the distributed app (an about or licences page); commercial SaaS use is fine.
- **LGPL (SteamKit2, FFmpeg in an LGPL build):** link dynamically or run as a separate process, and ship the LGPL notices. Any changes to SteamKit2 itself must be published.
- **GPL components:** driving OBS over obs-websocket, or running `ffmpeg.exe` as a separate process, is generally treated as arm's-length use rather than a derived work. Copying Segra's or OBS's source into the app would make the app GPL-2.0.
- **AGPL code on a public website:** it would force publishing the website's source, so avoid MulNX and demotracer code for the web product.
- **Repos with no licence:** they are "all rights reserved", so use them only as feature inspiration.
- **CS2-insight-agent:** it cannot be used in any monetised product.
- **Non-licence risks for a monetised site:** FACEIT API terms (Downloads API approval), Valve and Steam terms for GC access, use of Valve trademarks and assets (radar images, weapon icons), and HLTV scraping (gigobyte/HLTV) are separate from code licences. Another workstream should check them.

### Gaps
- FACEIT Data and Downloads API commercial-use terms, and Valve's terms for automated GC access, were not reviewed. They are outside a GitHub survey.
- The licences of map radar and overview assets bundled by awpy (`awpy get`) or CS:DM were not checked.
