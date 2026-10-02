# CS2 Highlight Capture & Rendering: Live Capture vs. Demo Rendering, Detection, Manual Clips, Editing (as of Oct 2026)

Research date: 2026-10-02. Sources fetched directly are marked as such. Items that only appeared in search-engine summaries (not opened) are flagged "(search summary)". Old CS:GO-era information is labeled.

---

## 1. Approach A: which live-capture backends exist, and can a third-party app control them?

### Takeaway
OBS Studio, driven over obs-websocket v5, is the only mainstream recorder with a documented, programmatic "save replay" call and a callback that returns the saved file path. NVIDIA Instant Replay has no API, and the NVIDIA Highlights SDK is a legacy SDK that has to be built into the game itself. Steam Game Recording is the most interesting zero-effort backend: CS2 already writes its own kill and death markers into the Steam timeline. Third parties can't add markers, but the recordings are plain DASH files (.m4s + session.mpd) that ffmpeg can read.

### Cited Findings
**OBS + obs-websocket v5**
- obs-websocket 5.x has `StartReplayBuffer`, `StopReplayBuffer`, `ToggleReplayBuffer`, `GetReplayBufferStatus` (`outputActive`, `outputState`), `SaveReplayBuffer` (no parameters, so you can't pick a custom duration) and `GetLastReplayBufferReplay`. The `ReplayBufferSaved` event returns `savedReplayPath`. Auth is a SHA256 challenge-response, the RPC version is 1, and messages are JSON or MessagePack. (fetched) — [obs-websocket protocol.md](https://raw.githubusercontent.com/obsproject/obs-websocket/master/docs/generated/protocol.md)
- Because `SaveReplayBuffer` always saves the whole configured buffer, the clip length has to be set by the buffer length (e.g. 20–30 s) or trimmed afterwards with ffmpeg. This follows from the missing duration parameter above. — [obs-websocket protocol.md](https://raw.githubusercontent.com/obsproject/obs-websocket/master/docs/generated/protocol.md)
- Tip from an OBS guide: use the stream encoder for the replay buffer instead of a separate encoder. That avoids a second NVENC session, which the guide calls "the most common cause of frame drops when you save". (search summary) — [faceitsync OBS settings for CS2 (Apr 2026)](https://faceitsync.com/en/blog/guide/obs-settings-cs2)

**NVIDIA ShadowPlay / NVIDIA App Instant Replay / Highlights SDK**
- NVIDIA's developer page says the Highlights SDK "is a legacy SDK. Developers may download and continue to use, but it is no longer supported". It is integrated by game developers (UE4.18 / Unity 5.6 era). (fetched) — [NVIDIA Highlights developer page](https://developer.nvidia.com/highlights)
- NVIDIA support lists Counter-Strike 2 as a Highlights-supported game in a GeForce NOW context. The page returned 403, so it's unclear whether this also applies to the local NVIDIA App. (search summary) — [NVIDIA: What games on GeForce NOW support Highlights?](https://nvidia.custhelp.com/app/answers/detail/a_id/4812/~/what-games-on-geforce-now-support-highlights)
- No public API exists to trigger an Instant Replay save. Third-party tools simulate the configured hotkey instead, e.g. an AutoHotkey script sends F13 and the user binds F13 to "Save Instant Replay". Sources disagree on the default hotkey: Alt+F10 vs. Alt+Shift+F10 in the NVIDIA App. (search summary) — [consolemode issue #77](https://github.com/lippdev/consolemode/issues/77); [NVIDIA forums: NVIDIA App record shortcut](https://www.nvidia.com/en-us/geforce/forums/instant-replay-recording/15/557996/nvidia-app-record-custom-shortcut-not-working/)
- FACEIT's OBS troubleshooting article says ShadowPlay works with FACEIT Anti-Cheat, and that FACEIT detects overlays but allows Steam and NVIDIA ShadowPlay. The page itself returned 403. (search summary) — [FACEIT: Troubleshooting issues with OBS](https://support.faceit.com/hc/en-us/articles/360015763620-Troubleshooting-issues-with-OBS)

**Steam Game Recording + Steam Timeline**
- Valve's CS2 account (June 2024): in CS2, Game Recordings "feature a timeline auto-filled with game-defined markers, like kills and deaths", and users can add their own markers. (search summary) — [CS2 on X](https://x.com/CounterStrike/status/1806063373731389859?lang=en); [Steam News: CS2 Game Recording Beta](https://store.steampowered.com/news/app/730/view/4257672198476571195)
- SteamDB reportedly shows the CS2 timeline marker definitions were updated on 2026-04-02, including `cs2_double_kill`, `cs2_multi_kill`, `cs2_gun_kill`, `cs2_knife_kill`, `cs2_grenade_kill` and `cs2_taser_kill`. The page returned 403, so this is unverified. (search summary) — [SteamDB app 730 info](https://steamdb.info/app/730/info/)
- ISteamTimeline (`AddInstantaneousTimelineEvent`, `AddRangeTimelineEvent`, `StartGamePhase`, `SetTimelineTooltip`, etc.) is called from inside a game process through the Steamworks SDK. Nothing in the docs suggests external apps can add markers or export clips. (fetched) — [ISteamTimeline docs](https://partner.steamgames.com/doc/api/ISteamTimeline)
- Before export, recordings sit on disk as DASH `.m4s` segments plus `session.mpd`. `gamerecording.pb` indexes the sessions, timeline metadata is in `timelines/timeline*.json`, and footage is in `video/bg*` directories. `ffmpeg -i session.mpd -c copy out.mp4` converts losslessly, and `-ss/-to` trims. (search summary + fetched) — [y.tsutsumi.io (Jul 2024)](https://y.tsutsumi.io/reading-steam-game-recordings); [steam_game_recording_converter](https://github.com/dmn001/steam_game_recording_converter); [SteamClip](https://github.com/Nastas95/SteamClip)
- SteamClip says Steam's native export "often produces pixelation and stuttering", and it re-muxes the DASH segments with ffmpeg instead. Works on Windows and Linux. (fetched) — [SteamClip](https://github.com/Nastas95/SteamClip)
- A Linux bug report says CS2 timeline markers didn't appear automatically on that platform. (search summary) — [steam-for-linux #12366](https://github.com/valvesoftware/steam-for-linux/issues/12366)

**Windows.Graphics.Capture (WGC) / Medal-style recorders**
- Medal says it is "a screen recorder that uses standard Windows graphics APIs. It does not read or modify CS2's memory or interact with the VAC-protected process". It also says it uses NVENC/AMF/QuickSync at "under 5% CPU on most systems". (fetched) — [Medal CS2 recorder page](https://medal.tv/developer/cs2)
- Medal auto-clips CS2 events (Ace, 4K, 3K, Clutch, Knife Kill, Headshot). Its troubleshooting advice to disable in-game "Streamer Mode", because it obfuscates data Medal uses, suggests the detection relies on game-provided data such as GSI. (search summary) — [Medal CS2 page](https://medal.tv/developer/counter-strike-2); [Medal support: event detection](https://support.medal.tv/support/solutions/articles/48001167701-what-is-automatic-event-detection-auto-clipping-)

### Inferences
- Best backends for a background app:
  - **OBS (portable install, controlled via obs-websocket)** gives full control: set up the scene/source programmatically, start the replay buffer or full recording, save on triggers, and receive file paths.
  - **Embedding libobs** avoids a separate OBS process but is much more work.
  - **A custom WGC + NVENC (ffmpeg `-f gdigrab` is too slow; you'd use `ddagrab`, WGC, or the NVENC SDK directly)** is the most work. It's only worth it later, for a polished public product.
- Steam Game Recording is the lowest-effort MVP path: no custom capture code, Valve-native markers, and lossless cutting from DASH segments. The risks are an undocumented on-disk format (`.pb`/timeline JSON can change without notice) and the user having to turn on background recording.
- NVIDIA Instant Replay can only be driven by simulating keystrokes. That's brittle (user-remapped hotkeys, focus issues) and gives no callback with the saved file path. Not recommended as the primary backend.

### Gaps
- No primary-source documentation of the Steam timeline JSON schema (marker timestamps vs. video offsets) was found. It needs hands-on reverse engineering.
- Couldn't confirm whether NVIDIA App's local Highlights (auto-capture) works for CS2 outside GeForce NOW in 2026.
- Steam background recording's default retention ("most recent two hours") appeared only in a search summary and wasn't verified against a Valve page.

---

## 2. Event triggers: what CS2 Game State Integration (GSI) provides for the local player, its latency, and its limits

### Takeaway
GSI is Valve-sanctioned, anti-cheat-safe local HTTP POSTs. While you're playing, it exposes only the local player's own state. You can detect your kills (deltas in `round_kills`/`round_killhs`), deaths, round phases and bomb events. You can't get alive counts for every player while playing, because `allplayers_*` is spectator-only, so live clutch (1vX) detection is impossible from GSI alone. It has to come from the demo after the match.

### Cited Findings
- `PlayerState` includes `health`, `armor`, `helmet`, `defusekit`, `flashed`, `smoked`, `burning`, `money`, `round_kills`, `round_killhs`, `round_totaldmg`, `equip_value`, `adr`. `PlayerMatchStats` has kills, assists, deaths, mvps, score. `Provider` includes `steamid` and `timestamp`. There are also `Map` (phase, round, team scores), `Round` (phase, win_team, bomb), `Bomb`, `PhaseCountdown` and `AllPlayers` (steamid → player). (fetched) — [go-cs2-gsi models](https://pkg.go.dev/github.com/nescabir/go-cs2-gsi/models)
- From the CS:GO-era quick-start guide, still the same mechanism: player components available while playing are `provider`, `map`, `round`, `player_id`, `player_state`, `player_weapons`, `player_match_stats`, `map_round_wins`. Spectator-only components are `allplayers_*`, `allgrenades`, `bomb`, `phase_countdowns`, `player_position`. (fetched; CS:GO-era) — [tsuriga/csgo-gsi-qsguide](https://github.com/tsuriga/csgo-gsi-qsguide)
- The CounterStrike2GSI (C#) library exposes all players only "while spectating a match, but will only expose local player's information when playing". Its `PlayerGotKill` event is derived from `round_kills` deltas (`PlayerRoundKillsChanged`). Other events: PlayerDied, RoundStarted/Concluded, BombPlanted/Defused/Exploded, MatchStarted, Gameover, FreezetimeStarted, etc. Default throttle is 0.1 and heartbeat 10.0 in its sample config. (fetched) — [antonpup/CounterStrike2GSI](https://github.com/antonpup/CounterStrike2GSI)
- A CS2 GSI tooling write-up says `allplayers_*` is spectator-only, or available when launching with `-netconport`. That's an unusual claim from a single source, and other sources say only "spectator". (search summary) — [go-cs2-gsi](https://github.com/Nescabir/go-cs2-gsi)
- Typical GSI config values: `"timeout" 5.0`, `"buffer" 0.1`, `"throttle" 0.1`, `"heartbeat"` 30–60. (fetched; CS:GO 2019) — [WTFender GSI + OBS blog](https://blog.wtfender.com/posts/obs-gamestate/)
- The cs2mqtt project describes GSI as Valve's built-in system that "is safe to use and will not be flagged by anti-cheat systems such as VAC or FACEIT". This is a third-party claim. (search summary) — [lupusbytes/cs2mqtt](https://github.com/lupusbytes/cs2mqtt)
- On-screen event timing: a frame-by-frame test found the CS2 killfeed appears about 60 ms later than in CS:GO, and CS2 visual reactions wait for the next tick (~15.6 ms at 64 tick). (search summary) — [EGW news](https://egw.news/counterstrike/news/25096/cs2-vs-cs-go-new-test-reveals-major-delay-in-kill--ZBUet2cBN); [Escorenews](https://escorenews.com/en/csgo/article/50979-why-cs2-shots-and-kills-have-delays-and-input-lag-how-cs2-hit-registration-works-and-how-to-fix-it)

### Inferences
- **Latency budget:** with `buffer 0.1` and `throttle 0.1`, a kill reaches the local listener roughly 0.1–0.2 s after the client learns of it (plus ~60 ms of killfeed/tick delay). That's negligible against a 3–5 s pre-roll, so stamping kills with the GSI arrival time (or `provider.timestamp`) is accurate enough for cutting a replay buffer or full recording. No measured end-to-end ms figure was found (see Gaps).
- **Local-player pitfall:** once the local player dies and spectates a teammate, the `player` block can switch to the observed player. Compare `player.steamid` with `provider.steamid` before counting kills, otherwise teammates' kills get attributed to the user. This is standard GSI practice, inferred from both fields being in the model.
- **What live GSI can detect:**
  - **Reliable:** your own kill count per round (2K/3K/4K/ACE via `round_kills` reaching N), headshot kills (`round_killhs` delta), deaths, round win/loss, bomb plant/defuse (via `round.bomb`), match end.
  - **Not detectable:** clutches (needs alive counts per team), wallbangs, noscopes, through-smoke, flash-assisted, collaterals, kill timing within a multi-kill (you only get it at GSI resolution), opponents' identities.
  - **Approximate:** the weapon used (from `player_weapons` active weapon at kill time), e.g. knife or Zeus kills.
- **Use GSI as the trigger and timestamp source, and the demo (parsed after the match) as the authoritative enrichment source** for clutch, wallbang, smoke, noscope and similar labels.

### Gaps
- No primary source with a measured GSI end-to-end latency in ms for CS2. Valve's GSI wiki page returned HTTP 403.
- Whether CS2 still honors the `buffer` parameter the same way as CS:GO isn't documented by Valve.

---

## 3. Approach A: performance overhead and storage of continuous capture

### Takeaway
Hardware-encoded background capture typically costs CS2 about 4–6% average FPS. Steam Game Recording measured about −6% avg FPS in CS2. OBS + NVENC is usually "minimal", but there are documented edge cases: the GPU getting stuck in a lower P-state, and stutter at high GPU load. Storage is driven by bitrate: about 90 MB/min at 12 Mbps to about 375 MB/min at 50 Mbps, so a full 40-minute match costs roughly 3.6–15 GB, while clips only cost tens to hundreds of MB.

### Cited Findings
- Steam Game Recording background capture in a CS2 FPS benchmark: avg 372 → 350 FPS (−6%), frametime 2.7 → 2.9 ms (June 2024). A second test showed −5.7% avg FPS and −4% on 1% lows (Oct 2024). Single tester, so treat as indicative only. — [Thour on X (Jun 2024)](https://x.com/ThourCS2/status/1806271762025308253); [Thour on X (Oct 2024)](https://x.com/ThourCS2/status/1847918428457197686)
- Steam Game Recording uses AMD/NVIDIA hardware encoders and falls back to CPU encoding if neither is available, which "may cause a noticeable performance impact". (search summary) — [PCGamesN](https://www.pcgamesn.com/steam/game-recording)
- OBS issue: enabling the replay buffer with NVENC kept an RTX 2080 Ti at power level 4/5 instead of 5/5. (search summary) — [obs-studio #8574](https://github.com/obsproject/obs-studio/issues/8574)
- OBS forum reports of 50–70% GPU usage with the replay buffer on, causing stutter in CS2/Valorant. Disabling Hardware-Accelerated GPU Scheduling (HAGS) was reported as a fix. (search summary) — [OBS forum: High GPU usage when replay buffer is on](https://obsproject.com/forum/threads/high-gpu-usage-when-replay-buffer-is-on.174414/); [OBS forum: 25% GPU usage replay buffer](https://obsproject.com/forum/threads/25-gpu-usage-using-replay-buffer.151022/)
- Claimed Game Capture vs. Window Capture overhead at 1080p60: 1.2% vs 4.8% CPU and 15–25 ms vs 30–45 ms capture-to-encode latency. The source is an unofficial SEO blog, so low confidence. — [obs-versions.com](https://obs-versions.com/blog/obs-screen-recording-vs-game-capture)
- Users report Display Capture of fullscreen CS2 can look washed out or too bright, and fullscreen-windowed recordings are less smooth than exclusive fullscreen. (search summary) — [OBS forum: Display capture in CS2 too bright](https://obsproject.com/forum/threads/obs-display-capture-in-cs2-too-bright.170932/)
- Medal claims "under 5% CPU on most systems" with NVENC/AMF/QuickSync. (fetched; vendor claim) — [Medal CS2](https://medal.tv/developer/cs2)

### Inferences
- Storage is arithmetic: MB/min = Mbps × 60 / 8.

| Bitrate (1080p60) | MB/min | 40-min full match | 10 clips × 15 s |
|---|---|---|---|
| 12 Mbps (YouTube 1080p60 SDR recommendation) | 90 MB | 3.6 GB | 225 MB |
| 20 Mbps | 150 MB | 6.0 GB | 375 MB |
| 50 Mbps (high-quality source) | 375 MB | 15 GB | 940 MB |

- A rolling OBS replay buffer lives in RAM (OBS has a "Maximum Memory" setting). A 30 s buffer at 50 Mbps is about 190 MB of RAM, so there's no disk churn. Full-match recording to disk lets you re-cut any moment after the match, including hotkey marks and moments detected only later from the demo. Recommended: record the full match at about 20–30 Mbps CQP/VBR, cut clips, then delete the source after N days.
- On an NVIDIA GPU (NVENC has a dedicated ASIC), expect about 3–6% avg FPS loss at 1080p60 based on the Steam numbers. Since CS2 often runs at 300+ FPS, this rarely matters in practice, but it should be measured on the user's machine.

### Gaps
- No rigorous, independent OBS-vs-Steam-vs-NVIDIA App FPS benchmark specific to CS2 in 2025–2026 was found.
- No vendor-published NVENC encode-latency numbers were collected for this note.

---

## 4. Approach A: anti-cheat safety (VAC Trusted Mode, -allow_third_party_software, FACEIT AC)

### Takeaway
In CS2, OBS **Game Capture** (DLL hook injection) is blocked by Valve's Trusted Mode unless you launch with `-allow_third_party_software`, which turns Trusted Mode off and, by community consensus, lowers Trust Factor. Window Capture (WGC) and Display Capture don't inject anything and work under both VAC and FACEIT AC, so a public app should use non-injecting capture. GSI is safe. No bans for OBS, ShadowPlay or Medal were found.

### Cited Findings
- OBS's knowledge-base article on capture-hook certificates (last updated 2025-06-03) gives Valve Anti-Cheat for CS2 a partial-compatibility rating across all OBS versions: "Valve does not allow any injection unless the game is running in 'Untrusted' mode via the `-allow_third_party_software` launch parameter." For FACEIT AC (CS2), Game Capture worked on OBS 30.1 and 30.2, failed on 31.0 (new ECC-only cert), and works again on 31.1+. (fetched) — [OBS KB: Capture Hook Certificate Update](https://obsproject.com/kb/capture-hook-certificate-update)
- OBS forum (Dec 2024): Valve's Trusted mode "does not allow OBS to hook" via Game Capture, and Valve has no plans to whitelist OBS. The fixes offered were Window Capture in windowed or borderless mode, the launch flag, or downgrading OBS. (fetched) — [OBS forum: Capture cs2 with anti-cheat](https://obsproject.com/forum/threads/capture-cs2-with-anti-cheat.182477/)
- Valve's 2020 Trusted Mode announcement (CS:GO; the mechanism carried over to CS2) made Trusted Mode the default and introduced `-allow_third_party_software` to let third-party software access the game process. (search summary; 2020 CS:GO-era) — [Dot Esports](https://dotesports.com/counter-strike/news/how-to-allow-third-party-software-in-cs2); [OBS forum: About CS:GO Trusted Mode](https://obsproject.com/forum/threads/about-cs-go-trusted-mode.128216/)
- Community consensus (Steam forum, Dec 2020) is that the flag lowers Trust Factor. That isn't confirmed by Valve, and nobody knows whether it's permanent. (fetched; old) — [Steam discussion](https://steamcommunity.com/app/730/discussions/0/2967272920354546207/)
- Guides from 2025–26 say the flag disables Trusted Mode, may lower Trust Factor over time (longer queues, worse match quality), and recommend Display Capture to avoid it. (search summary) — [swap.gg](https://swap.gg/blog/how-to-record-cs2-gameplay); [vredux](https://vredux.com/articles/allow-third-party-software-cs2)
- FACEIT says the latest official OBS release works with FACEIT AC, but modified OBS builds may not. ShadowPlay works, and the Steam overlay is allowed. (search summary; page 403) — [FACEIT: Troubleshooting issues with OBS](https://support.faceit.com/hc/en-us/articles/360015763620-Troubleshooting-issues-with-OBS)
- Medal says it uses standard Windows graphics APIs and doesn't touch CS2's memory or process. (fetched; vendor claim) — [Medal CS2](https://medal.tv/developer/cs2)
- HLAE forces `-insecure`, which blocks joining VAC servers. "As long as you only watch demos with HLAE, you will not get banned." (fetched) — [advancedfx FAQ](https://github.com/advancedfx/advancedfx/wiki/FAQ)

### Inferences
- For a zero-friction, safe app: use **Window Capture (WGC method)** with CS2 in borderless/fullscreen-windowed mode, or **Display Capture (DXGI Desktop Duplication / WGC monitor capture)**. Never ask users to add `-allow_third_party_software`, because it's a Trust Factor risk in Premier and a support burden.
- The background app must never inject into cs2.exe, read its memory, or draw overlays inside the game. Global hotkeys (RegisterHotKey), GSI, a local HTTP listener and screen capture are all external to the game process.
- On FACEIT, use only the official OBS build if OBS is embedded or bundled. A custom-built or modified libobs could be flagged; FACEIT warns that modified OBS "is not guaranteed" to work.

### Gaps
- No current (2026) official Valve statement on Trust Factor and `-allow_third_party_software` was found.
- No FACEIT statement specifically on WGC-based recorders or on Steam Game Recording was found, though the Steam overlay is reportedly allowed.

---

## 5. Approach B: demo sources and playback quality (Premier/MM vs. FACEIT, tick/snapshot rate, smoothness)

### Takeaway
CS2 servers (Premier and FACEIT) run at 64 tick with sub-tick, and CS Demo Manager treats CS2 demos as 64 ticks/s. The famous "16/32-tick GOTV demo" choppiness is CS:GO-era information. Two developments improved demo fidelity: Valve's November 2025 "TrueView" playback, and HLAE's September 2026 animation-stutter fix for recordings. Demo-rendered footage still isn't identical to the live POV: crosshair/viewmodel settings, sounds and some effects can differ, and effects may lag by 1–2 frames.

### Cited Findings
- CS2 uses 64 ticks per second, while CS:GO used 64 or 128 depending on the server. CSDM converts seconds to ticks at 64/s for CS2. (fetched) — [CS Demo Manager video docs](https://cs-demo-manager.com/docs/guides/video)
- Valve's official matchmaking servers (Competitive, Premier, etc.) run at 64 tick with sub-tick, and 64 Hz is hardcoded. (search summary) — [csdb.gg](https://csdb.gg/what-is-the-tick-rate-for-cs2/); [xplay.gg](https://xplay.gg/blog/cs2-tick-rate-subtick-system/)
- **CS:GO-era (old):** GOTV demos were 16 tick and POV demos 32 tick, while FACEIT/ESEA ran 128 tick. Valve later raised the GOTV snapshot rate to 32. (fetched; 2016–2017 posts, not valid for CS2) — [Steam discussion: Demo Tick Rate](https://steamcommunity.com/app/730/discussions/0/350540974006481554/); [HLTV blog: 16tick demos](https://www.hltv.org/blog/8930/16tick-demos-what-valve-could-do-about-that)
- Search summaries saying "FACEIT matches run at 128 tick" are CS:GO-era and conflict with CS2's hardcoded 64 tick. — conflicting: [profilerr FACEIT demo guide](https://profilerr.net/how-to-watch-faceit-demos-in-cs2/) vs. [CSDM docs](https://cs-demo-manager.com/docs/guides/video)
- **TrueView (CS2 update, 2025-11-05):** demo playback "reconstructs the observed player's original experience more accurately by re-running client-side prediction". It includes damage-prediction effects. It isn't frame-perfect: hit timing matches the click frame, but recoil and blood effects may be 1–2 frames late, especially in slow motion. It's disabled by default on older demos or when the client version doesn't match the recording, and `cl_demo_predict 2` overrides that. A demo-pause tick-advance bug was also fixed. (fetched) — [HLTV: Valve adjust demo playback system](https://www.hltv.org/news/43122/valve-adjust-demo-playback-system-in-update)
- HLAE 2.192.2 (2026-09-12) "fixed low FPS player animations and stuttering in recordings" via `mirv_fix forceClIntInterpRatio`, so demo-render smoothness depended on the HLAE version until very recently. (search summary + fetched releases) — [HLAE 2.192.2 release](https://github.com/advancedfx/advancedfx/releases/tag/v2.192.2); [HLAE releases](https://github.com/advancedfx/advancedfx/releases)
- FACEIT demos download as compressed archives (.gz/.zst), are usually ready about 5 minutes after the match, and are kept about 30 days. (search summary) — [FACEIT: How to download and watch a CS2 demo](https://support.faceit.com/hc/en-us/articles/10622392832412-How-to-download-and-watch-a-CS2-demo); [setups.gg (2026)](https://www.setups.gg/how-to-watch-faceit-demos-in-cs2-2026-guide/)
- Valve MM/Premier demos are fetched by redeeming a match share code (`CSGO-xxxxx-…`) with the Game Coordinator for a download URL. New share codes can be enumerated with `GetNextMatchSharingCode` using the user's game authentication code. Open-source implementations exist. (search summary) — [Leetify: share codes](https://leetify.com/blog/share-codes/); [cs_stats](https://github.com/ramireztirso-rgb/cs_stats); [CSDM downloads](https://cs-demo-manager.com/docs/guides/downloads)
- In CS2, client-side POV recording (`record`) was buggy in Nov 2023 ("will often freeze your game"), and POV demos lack reliable utility data. (fetched; 2023, may be outdated) — [Leetify: CS2 POV demos](https://leetify.com/blog/cs2-pov-demos/)

### Inferences
- Demo renders at 1080p60 are smooth enough for highlight reels in 2026, provided you use a current HLAE plus the `mirv_fix` interpolation setting and TrueView-compatible demos (rendered soon after the match, before a CS2 update creates a version mismatch). Render jobs should run quickly after each match, since TrueView turns off when the client version differs.
- The demo POV will use the recording player's in-demo crosshair, viewmodel and HUD as reconstructed by the game, not the user's own. Voice, the user's exact sensitivity "feel", and client-side-only cosmetics can differ. Live capture is the only route to the exact on-screen experience.

### Gaps
- No authoritative 2026 figure for the CS2 Premier GOTV `tv_snapshotrate` (whether demos contain all 64 ticks or fewer snapshots) was found.
- The Valve MM demo retention period wasn't verified.

---

## 6. Approach B: HLAE / CS Demo Manager automation, render speed, constraints and fragility

### Takeaway
The proven open-source pipeline is: parse the demo (demoparser2) → plan sequences → launch CS2 through HLAE with `-insecure` → send console commands at exact ticks (CSDM's server plugin or netcon) → `mirv_streams` pipes frames straight into FFmpeg. Rendering is roughly real-time plus overhead (about 10–15 min for 10 × 20 s clips, including game boot and seeking). It needs a Windows machine where CS2 isn't being played, since one Steam account runs one CS2. It breaks on CS2 updates until HLAE catches up: four HLAE releases shipped between Sept 23 and 26, 2026.

### Cited Findings
- **CSDM video export:**
  - Records either through CS's `startmovie` (raw .tga + .wav, then FFmpeg/VirtualDub) or through HLAE.
  - HLAE + FFmpeg skips raw files, saving disk space and time.
  - HLAE is Windows-only. Linux supports CS2 with FFmpeg only (no HLAE). macOS doesn't support CS2.
  - Configurable: resolution, framerate, codec (libx264 default), CRF.
  - Warns when disk use exceeds 40 GB. Playback is real-time, with no acceleration mentioned.
  - HLAE must be updated after game patches.
  - Per-player camera focus, death-notice styling, X-ray toggle and kill highlighting are available.
  (fetched) — [CSDM video guide](https://cs-demo-manager.com/docs/guides/video)
- CSDM also has a CLI. (search result) — [CSDM CLI docs](https://cs-demo-manager.com/docs/cli)
- **cs2-highlights-maker (open source):**
  - Pipeline: demoparser2 → moment detector → HLAE/CS2 recording → FFmpeg → MP4.
  - Injects `AfxHookSource2.dll` via HLAE, "the same mechanism as CS Demo Manager (MIT)". The CSDM server plugin runs console commands at exact demo ticks from a JSON actions file. `mirv_streams` pipes frames directly into FFmpeg with no raw TGA files.
  - Always runs with `-insecure`: "Never join VAC-secured servers while HLAE is running".
  - Speed: about real-time, roughly 10 clips of ~20 s in 10–15 min including boot and seeking.
  - Defaults: 1920×1080, 60 fps, CRF 23, 4.0 s lead-in, 3.0 s lead-out.
  - Decompresses FACEIT (.gz) and Valve (.dem.zst) demos. Sandboxes the game config through the `USRLOCALCSGO` env var.
  - Can't play CS:GO-era demos.
  (fetched) — [Rovniy/cs2-highlights-maker](https://github.com/Rovniy/cs2-highlights-maker)
- **CS DemoDesk (open source):** launches a separate CS2 process via HLAE with `-insecure`, sends commands over the game's netcon console, encodes H.264/H.265 on CPU or NVIDIA GPU, and has 10/20/50 MB size caps for chat apps. "Users cannot play while recording", and exports run one at a time. (fetched) — [noih/cs-demodesk](https://github.com/noih/cs-demodesk)
- The HLAE FAQ: `-insecure` is forced for Source 2. FFmpeg via `mirv_streams` "can drastically improve the speed", with no indication of faster-than-real-time recording. Game updates can break compatibility. (fetched) — [advancedfx FAQ](https://github.com/advancedfx/advancedfx/wiki/FAQ)
- **HLAE release cadence (2026):**
  - 2.190.2 (May 27)
  - 2.191.0 (Jul 10): FFmpeg 8.1.1, CS2 1.41.6.8
  - 2.191.1 (Jul 16)
  - 2.192.0 (Jul 21, pre-release): ProRes presets, demo_goto crash fix
  - 2.192.1 (Jul 29)
  - 2.192.2 (Sep 12): interp/stutter fix, alpha-matte streams
  - 2.192.3 (Sep 23): CS2 1.41.8.2
  - 2.192.4 (Sep 24): CS2 1.41.8.3, scope fix
  - 2.192.5 (Sep 26): CS2 1.41.8.5, depth stream fix
  - 2.192.6 (Sep 26): sniper scope fix again
  (fetched) — [HLAE releases](https://github.com/advancedfx/advancedfx/releases); [HLAE 2.192.5](https://github.com/advancedfx/advancedfx/releases/tag/v2.192.5)
- Regression example: "[CS2] Sniper scopes broken again in HLAE 2.192.5" (issue #1222). Another project pinned HLAE 2.192.4 "to stop the DeathMsg.cpp crash on CS2 1.41.8.3". (search summary) — [advancedfx #1222](https://github.com/advancedfx/advancedfx/issues/1222); [cliphub PR #217](https://github.com/rechedev9/cliphub/pull/217)
- Other local-first projects follow the same pattern: "TickCut/ClipHub: parse → kill plan → HLAE/CS2 capture → FFmpeg/Lua → publish pack" ([rechedev9/cliphub](https://github.com/rechedev9/cliphub)), and a German pipeline using demoparser2 → rule-based detection (2K–Ace, clutch) → HLAE → overlays → 16:9/9:16/1:1 exports ([automate-the-process.de](https://automate-the-process.de/cs2/)). (fetched)

### Inferences
- **Render time model:** about 1× real-time per clip second, plus about 1–3 min fixed overhead (CS2 boot, demo load) and a few seconds of seek per clip. A 2–3 min highlight reel is about 5–15 min of wall-clock render on a local GPU.
- **On the user's own PC:** render only when CS2 isn't running (after the session, or on idle). Use a sandboxed config (`USRLOCALCSGO`) so the user's settings aren't touched. Never auto-launch while they're queueing. Rendering requires closing their CS2 because one account runs one CS2 instance.
- **Operations:** pin a known-good HLAE version per CS2 build, auto-update from GitHub releases, and add a "render failed → retry after HLAE update" queue. Expect breakage within hours of CS2 patches, with fixes usually within days.
- **Linux alternative:** CS2 native plus `startmovie` (no HLAE) is possible per the CSDM matrix, but writes raw TGA/WAV, which is disk-heavy, and loses HLAE's camera and deathnotice control.

### Gaps
- No public benchmark of HLAE render speed versus resolution and GPU (e.g., whether 1080p60 renders faster than real-time on high-end GPUs with `host_framerate`) was found for CS2.

---

## 7. Does CS2 have Valve's own highlight reels (like CS:GO's "Your Highlights/Lowlights")?

### Takeaway
No. CS:GO's in-client highlights/lowlights reel wasn't carried into CS2, and players still complain about it. Valve's substitute is Steam Game Recording with automatic CS2 kill/death timeline markers.

### Cited Findings
- In CS2 "you can no longer just view 'highlights' or 'low-lights'". CS:GO used to assemble a highlight/lowlight reel, and players now rely on third parties such as Scope.gg and Leetify. (search summary of Steam threads) — [Steam: When Replay highlights???](https://steamcommunity.com/app/730/discussions/0/604145351836849480/); [Steam: CS2 highlight reels](https://steamcommunity.com/app/730/discussions/0/4309452818499509939/); [Scope.gg CS2 highlights guide](https://scope.gg/guides/scope_clips_en/)
- Steam Game Recording in CS2 auto-marks kills and deaths (June 2024 onward). — [CS2 on X](https://x.com/CounterStrike/status/1806063373731389859?lang=en)

### Inferences
- There's a genuine product gap: no native "replayable edited highlights per match" in CS2.

### Gaps
- No Valve roadmap statement about restoring highlight reels in 2026 was found.

---

## 8. Cloud rendering: feasibility, cost, account and Terms of Service constraints, and what's known about Allstar

### Takeaway
Cloud rendering is technically feasible: Windows GPU VMs with HLAE, or Linux CS2 with `startmovie`. Compute is cheap, at about $0.01–$0.13 per match reel. The hard parts are a CS2-owning Steam account per concurrent instance, the Steam Subscriber Agreement's "personal, non-commercial use" and anti-automation clauses, and HLAE breaking on every CS2 patch. Allstar does cloud rendering at scale but hasn't published its pipeline.

### Cited Findings
- **AWS g4dn.xlarge** (1× T4 16 GB, 4 vCPU, 16 GiB RAM) in us-east-1: $0.526/hr on-demand, spot about $0.2498–$0.2842/hr. The page doesn't separate Windows pricing; AWS normally adds a Windows license surcharge (not verified here). (fetched) — [DoiT g4dn.xlarge](https://www.doit.com/compute/spot/us-east-1/g4dn.xlarge)
- **Vast.ai (late Sept 2026 marketplace):** RTX 4090 from $0.32/hr on-demand ($0.17 spot), RTX 3060 from $0.05/hr ($0.042 spot). Vast.ai hosts are mostly Linux containers. (search summary) — [gpuperhour Vast.ai](https://gpuperhour.com/providers/vastai); [gpuperhour RTX 4090](https://gpuperhour.com/rent/rtx-4090)
- The Steam Subscriber Agreement bans automation ("scripts, bots, macros, or other non-human-controlled systems ... to interact with Content and Services on Steam") except where expressly permitted, and limits use to "personal, non-commercial use of their Subscriptions" unless otherwise permitted. (search summary) — [Steam Subscriber Agreement](https://store.steampowered.com/subscriber_agreement/)
- One Steam account can run only one CS2 at a time. (search summary from a highlight-tool README) — [noih/cs-demodesk](https://github.com/noih/cs-demodesk)
- **Allstar:**
  - Clips are made "from your replays and demos using the cloud": no download needed, "zero FPS drop".
  - CS2 demo upload accepts zip/bz2/gz for Competitive and Wingman.
  - Supports CS2, League of Legends, Fortnite and Dota 2.
  - Reportedly 1.9B moments across 62M matches for 14M players.
  - No technical pipeline details are public: a project page about Allstar contained none.
  (search summary + fetched) — [Allstar how it works](https://allstar.gg/howitworks); [Allstar help: demo upload](https://help.allstar.gg/hc/en-us/articles/12775949766551-Can-I-upload-a-demo-file-to-Allstar); [Allstar App Store listing](https://apps.apple.com/us/app/allstar-gg/id6476161266); [Mike DG Allstar project page](https://mikedg.com/projects/allstar/)

### Inferences
- **Cost per match reel:**
  - About 10–15 min of VM time (from the cs2-highlights-maker timing): roughly $0.09–$0.13 on AWS g4dn on-demand (Linux price), $0.04–$0.07 spot, or about $0.01–$0.08 on Vast.ai consumer GPUs.
  - Per rendered output minute (at about 3–5× wall-clock overhead for short clips): roughly $0.03–$0.05 on AWS on-demand and under $0.01 on Vast.ai 3060/4090.
  - Add storage and egress: about 90–150 MB per minute of 1080p60 output.
- **Scaling constraint:** each concurrent CS2 renderer needs its own Steam login that owns CS2 (free-to-play, but the account still has to exist and be logged in). Running fleets of such accounts on servers for a commercial service collides with the SSA's personal/non-commercial and anti-automation language. This is legal and business risk rather than a technical blocker; Allstar's arrangement with Valve, if any, is unknown.
- **Linux cloud (cheapest GPUs)** would rule out HLAE, so it's raw `startmovie` frames then FFmpeg, which is disk-heavy and offers fewer camera and HUD controls. Windows GPU VMs (AWS/Azure/GCP) keep HLAE but cost more.
- **For a personal tool, render on the user's own PC after the session.** It costs nothing, has no ToS ambiguity about server-farmed accounts, and uses the user's own account and license.

### Gaps
- No public information on Allstar's render infrastructure (OS, GPU type, accounts, render times) was found.
- Windows-specific g4dn pricing wasn't confirmed, and CS2 performance on a T4 at 1080p60 wasn't benchmarked.
- No explicit Valve statement on cloud demo-rendering services was found.

---

## 9. Highlight detection logic and the demo event fields available in CS2

### Takeaway
Detection is rule-based everywhere: Medal, Steam markers, open-source tools. Group your kills within a round into "moments" (merge when the gap is under about 20 s), then score multi-kills, clutches, headshots, special kills (noscope, wallbang, through smoke, while blind, in air, knife/Zeus) and round importance. CS2's `player_death` event exposes the needed flags: `headshot`, `penetrated`, `noscope`, `thrusmoke`, `attackerblind`, `attackerinair`, `assistedflash`, `distance`, `hitgroup`. Clutches are computed by tracking alive counts per team.

### Cited Findings
- **cs2-highlights-maker detection:**
  - Kills in a round are grouped into moments with gaps under 20 s.
  - Each moment is scored on multi-kills, headshots, knife/Zeus, AWP noscope, smoke/flashed/wallbang kills, won 1vX clutches (tracked via alive counts) and round significance.
  - The top N moments become clips. Overlapping moments are merged, with camera switches between featured players.
  (fetched) — [cs2-highlights-maker README](https://github.com/Rovniy/cs2-highlights-maker)
- **Its scoring weights (`scoring.py`):**
  - Base: kill +1.0, headshot +0.2, knife +3.0, Zeus +3.0, AWP noscope +2.5.
  - Multi-kill bonus: 2K +0.5, 3K +2.0, 4K +4.0, 5K (Ace) +8.0.
  - Special kills: through smoke +1.5, while blind +2.0, wallbang +1.0.
  - Clutch: won 1vX +2.0 plus 1.5 × X; lost clutch with 2+ kills +1.0.
  - Round multipliers: pistol ×1.15, overtime ×1.2, final round ×1.3, lost round ×0.85.
  (fetched) — [scoring.py](https://raw.githubusercontent.com/Rovniy/cs2-highlights-maker/main/src/highlights/analysis/scoring.py)
- Default clip padding in that tool: 4.0 s pre-roll and 3.0 s post-roll. (fetched) — [cs2-highlights-maker](https://github.com/Rovniy/cs2-highlights-maker)
- CS2 `player_death` payload fields (cs2parser/demoparser ecosystem): attacker/victim/assister, weapon, `assistedflash`, `headshot`, `penetrated` (number of objects penetrated), `noscope`, `thrusmoke`, `attackerblind`, `attackerinair`, `distance`, `dmg_health`, `dmg_armor`, `hitgroup`.
  - `thrusmoke`: the line from the killer's eyes to the victim's chest crosses a smoke.
  - `attackerblind`: the attacker's flashed alpha is at or above `sv_flashed_amount_for_blind_kill` (0.7).
  - `attackerinair`: the killer wasn't on the ground.
  (search summary of GitHub issues/PRs) — [RivalHub-Broadcast issue #26](https://github.com/Starfie1d1272/RivalHub-Broadcast/issues/26); [CSGODOT PR #140](https://github.com/sidcarrollworks/CSGODOT/pull/140); [LaihoE/demoparser](https://github.com/LaihoE/demoparser)
- Known demoparser2 issue: bots aren't resolved in `player_death`/`player_hurt` user fields (`user_*` is null). This matters for bot or practice demos. (search summary) — [demoparser #358](https://github.com/LaihoE/demoparser/issues/358)
- Medal's CS2 auto-clip triggers: Ace, 4K, 3K, Clutch, Knife Kill, Headshot. (search summary) — [Medal CS2](https://medal.tv/developer/counter-strike-2)
- Steam's CS2 timeline markers reportedly include double, multi, gun, knife, grenade and taser kills (unverified; SteamDB 403). — [SteamDB](https://steamdb.info/app/730/info/)
- Other tools such as CS DemoDesk detect "multi-kills, clutches, and ninja defuses" without publishing their algorithms. (fetched) — [cs-demodesk](https://github.com/noih/cs-demodesk)

### Inferences
- **Recommended MVP detector**, as a post-match demo pass with GSI as a live fallback:
  1. Filter `player_death` where the attacker is the user's steamid.
  2. Cluster kills by round, with merge gap ≤ 6–8 s for "fast multi-kill" clips (and ≤ 20 s to merge into one clip).
  3. Tag 2K/3K/4K/ACE.
  4. Tag a clutch when, at the user's first kill after their team's alive count reaches 1, enemies alive ≥ 2 and the round is won. Compute alive counts from `player_death` plus `round_start`.
  5. Add flags from the `player_death` booleans; collateral = two deaths on the same tick from the same attacker and weapon; entry = first kill of the round.
  6. Score with weights like those above.
  7. Clip window = [first_kill_tick − 4 s, last_kill_tick + 3 s], 64 ticks/s.
  8. Merge overlapping windows. Keep the top N per match, and always keep anything at 4K or above, or a clutch of 1v3 or bigger.
- Live (GSI-only) detection can reliably flag multi-kills, headshots and knife/Zeus. The post-match demo pass upgrades labels (clutch, wallbang, smoke) and can recover moments the replay buffer missed, but only if a full-match recording exists.

### Gaps
- Leetify's, Allstar's and Medal's exact scoring formulas aren't public.
- I didn't verify `attackerinair`/`thrusmoke` presence directly against Valve's CS2 game-events definition file. They come from secondary GitHub sources.

---

## 10. Manual "clip that": a hotkey during play and post-match moment selection

### Takeaway
A background app can register a global hotkey (outside the game process) and record a wall-clock timestamp. That timestamp then either saves the OBS replay buffer immediately (`SaveReplayBuffer`) or is mapped onto a full-match recording or a demo tick afterwards. Aligning to the demo works by anchoring on round boundaries seen both live (GSI round-phase transitions with timestamps) and in the demo (round start/freeze-end ticks), then computing tick = anchor_tick + Δt × 64.

### Cited Findings
- `SaveReplayBuffer` plus the `ReplayBufferSaved.savedReplayPath` callback gives an immediate saved file. (fetched) — [obs-websocket protocol](https://raw.githubusercontent.com/obsproject/obs-websocket/master/docs/generated/protocol.md)
- GSI provides `provider.timestamp` and the round/map phase on every payload. (fetched) — [go-cs2-gsi models](https://pkg.go.dev/github.com/nescabir/go-cs2-gsi/models)
- CS2 runs at 64 ticks/s, and CSDM converts seconds to ticks for sequences. (fetched) — [CSDM video docs](https://cs-demo-manager.com/docs/guides/video)
- Steam Game Recording lets users add their own markers (Ctrl+F12 by default). (search summary) — [PCGamesN](https://www.pcgamesn.com/steam/game-recording); [CS2 on X](https://x.com/CounterStrike/status/1806063373731389859?lang=en)
- NVIDIA Instant Replay can only be triggered by simulated hotkeys. (search summary) — [consolemode #77](https://github.com/lippdev/consolemode/issues/77)

### Inferences
- **During play:**
  1. Win32 `RegisterHotKey` (or a raw-input hook) in the tray app. Pick a key that doesn't clash with in-game binds, or let the user choose; mouse side buttons are popular.
  2. On press, record `t_wall` along with the latest GSI round number and phase.
  3. If OBS replay-buffer mode is on, call `SaveReplayBuffer` (the clip ends at the press, so pre-roll equals the buffer length).
  4. Play a subtle audio cue for confirmation, since there can't be an in-game overlay.
- **Mapping to the demo:** for round r, take `t_live_start(r)` from the GSI transition freezetime → live. Demo tick ≈ `round_freeze_end_tick(r) + (t_wall − t_live_start(r)) × 64`. Expected error is about ±0.2–0.3 s (GSI throttle plus HTTP), well inside a 4 s pre-roll. Timeouts and pauses happen during freezetime, so per-round anchoring avoids drift.
- **Mapping to a full-match video:** the video start wall-clock is known (OBS `RecordStateChanged` event / file creation time), so offset = `t_wall − t_record_start`. Simple and exact.
- **After the match:** show a round timeline built from the demo (kills, deaths, bomb events per round, from the parse). The user clicks a round or kill, and the app cuts from the full-match recording (instant, with `ffmpeg -c copy` at keyframes or a quick re-encode) or queues a demo render from any player's POV.
- **Optional, unverified idea:** an in-game bind like `bind F8 "echo CLIPTHAT"` with console logging (`-condebug` / `con_logfile`) could give a game-side marker without a global hook. Whether CS2 console log lines carry timestamps and whether `-condebug` behaves in CS2 2026 needs testing.

### Gaps
- No existing documentation of a GSI-to-demo-tick alignment method or its measured accuracy was found. The method above is an engineering inference.

---

## 11. Automated editing pipeline and 1080p60 encoding

### Takeaway
FFmpeg filter graphs (trim/concat, `xfade` transitions, `setpts` slow-mo, `drawtext`/overlay for labels, `amix` for music) are enough for automated edits. MoviePy or Remotion add templating at the cost of speed. For 1080p60 output, YouTube recommends 12 Mbps H.264 High profile for SDR. NVENC H.264/HEVC/AV1 at about 12–20 Mbps yields about 90–150 MB per minute of output.

### Cited Findings
- YouTube's recommended upload settings: 1080p at 48/50/60 fps is 12 Mbps SDR (15 Mbps HDR). H.264 High profile, MP4, AAC-LC 48 kHz, 2 consecutive B-frames, closed GOP, progressive, 4:2:0. (search summary) — [YouTube Help: recommended upload encoding settings](https://support.google.com/youtube/answer/1722171?hl=en)
- cs2-highlights-maker outputs 1920×1080 at 60 fps, libx264 CRF 23. CSDM defaults to libx264 and libmp3lame with CRF configurable. CS DemoDesk offers H.264/H.265 on CPU or NVIDIA GPU, with 10/20/50 MB file-size targets for chat sharing. (fetched) — [cs2-highlights-maker](https://github.com/Rovniy/cs2-highlights-maker); [CSDM video](https://cs-demo-manager.com/docs/guides/video); [cs-demodesk](https://github.com/noih/cs-demodesk)
- HLAE 2.191.0 bundles FFmpeg 8.1.1, and 2.192.0 added ProRes presets. (fetched) — [HLAE releases](https://github.com/advancedfx/advancedfx/releases)
- One local pipeline renders overlays with "HyperFrames" and exports 16:9, 9:16 and 1:1 versions. (fetched) — [automate-the-process.de](https://automate-the-process.de/cs2/)
- Steam's native export reportedly causes pixelation and stutter, while ffmpeg re-muxing doesn't. (fetched) — [SteamClip](https://github.com/Nastas95/SteamClip)

### Inferences
- **Suggested pipeline:**
  1. Cut each moment from the source using frame-accurate trim, re-encoding only the cut (from a full-match recording at 20–30 Mbps).
  2. Optionally add 0.5× slow-mo on the final kill (`setpts=2*PTS` plus `atempo=0.5` or muted audio).
  3. Add a lower-third label ("3K · AK-47 · Round 14 · 1v2 clutch") with `drawtext`.
  4. Join clips with 0.3–0.5 s `xfade`/`acrossfade`.
  5. Optionally duck a music bed under game audio (`sidechaincompress`).
  6. Encode with NVENC: `h264_nvenc -preset p5 -rc vbr -cq 21 -b:v 15M -maxrate 25M -g 120 -bf 2`, or `hevc_nvenc`/`av1_nvenc` (RTX 40/50 series) at about 60–70% of the H.264 bitrate for local storage.
- **Expected sizes:** a 2-minute reel at 15 Mbps H.264 is about 225 MB. With AV1 at about 8 Mbps it's about 120 MB. A 30 s clip at 12 Mbps is about 45 MB, which is too big for Discord's free upload limit, so offer a 10 MB "share" variant like DemoDesk does.
- NVENC re-encoding of a 2-minute 1080p60 reel should take well under real-time on any RTX GPU, so editing time is dominated by the number of ffmpeg passes, not encode speed. A single filter-graph pass is preferable to chaining many tools.

### Gaps
- I didn't benchmark MoviePy or Remotion render speed for 1080p60, or the quality of NVENC AV1 vs. H.264 at equal bitrate.

---

## 12. Comparison of approaches and MVP recommendation

### Takeaway
For the user's personal MVP (NVIDIA PC, Premier plus FACEIT, zero manual steps), use **live capture with a non-injecting recorder plus GSI triggers plus a global hotkey**, cutting from a **full-match or long rolling recording**. Then **enrich labels with a post-match demo parse**. Add **demo rendering (HLAE, on the user's PC after the session)** as phase 2, for party members' POVs and re-renders. Defer cloud rendering until there's a public service, and budget for the ToS and account question.

### Cited Findings
- Live-capture facts:
  - Non-injecting capture is the only VAC-trusted-mode-safe OBS route without `-allow_third_party_software`. ([OBS KB](https://obsproject.com/kb/capture-hook-certificate-update))
  - Steam recording costs about 6% FPS in CS2. ([Thour](https://x.com/ThourCS2/status/1806271762025308253))
  - GSI exposes only the local player while playing. ([CounterStrike2GSI](https://github.com/antonpup/CounterStrike2GSI))
- Demo-render facts:
  - Real-time rendering. ([cs2-highlights-maker](https://github.com/Rovniy/cs2-highlights-maker))
  - `-insecure`; can't play at the same time. ([advancedfx FAQ](https://github.com/advancedfx/advancedfx/wiki/FAQ); [cs-demodesk](https://github.com/noih/cs-demodesk))
  - Frequent HLAE breakage. ([HLAE releases](https://github.com/advancedfx/advancedfx/releases))
  - TrueView improved POV fidelity since Nov 2025. ([HLTV](https://www.hltv.org/news/43122/valve-adjust-demo-playback-system-in-update))

### Inferences
**Trade-off matrix (synthesized from the findings above):**

| Dimension | A: Live capture (WGC/Display via OBS + GSI) | A′: Steam Game Recording + CS2 markers | B: Demo render, local (HLAE) | B′: Demo render, cloud |
|---|---|---|---|---|
| FPS cost while playing | ~3–6% (NVENC) | ~6% measured | 0 | 0 |
| Fidelity | Exact POV, settings, voice | Exact POV | Reconstructed POV (TrueView), 1–2 frame FX lag | Same as B |
| Any player's POV / re-cam | No | No | Yes | Yes |
| Clutch / wallbang labels | Only via post-match demo parse | Valve markers (kills only) plus demo parse | Native from demo | Native |
| Time to highlights | Seconds (cut only) | Seconds | ~5–15 min per match, PC busy, CS2 must be closed | Minutes; queueing |
| Anti-cheat risk | Low (no injection; no `-allow_third_party_software`) | Low (Valve-native) | None during play; `-insecure` only offline | None for user |
| Fragility | OBS/WGC stable; GSI stable | Undocumented on-disk format | HLAE breaks on CS2 patches (4 releases in 4 days, Sep 2026) | Same plus account/ToS |
| Storage | 3.6–15 GB per full match (or RAM buffer) | Steam-managed rolling buffer | Only output clips | Server-side |
| Dev effort (MVP) | Medium (OBS orchestration, GSI server, ffmpeg) | Low–medium (parse Steam files) | Medium–high (HLAE, plugin, sequencing) | High (fleet, accounts, legal) |
| Cost | $0 | $0 | $0 | ~$0.01–0.13 per match reel compute |

**Recommended MVP (Windows tray app):**
1. **Capture:** bundle or drive official OBS via obs-websocket with Window Capture (WGC) on CS2 in fullscreen-windowed mode, or Display Capture. Record each match fully (auto start/stop on GSI `map.phase` live → gameover) at about 20–25 Mbps NVENC (HEVC if supported). An alternative "lite" backend reads Steam Game Recording background footage plus CS2 markers.
2. **Live triggers:** a GSI listener on 127.0.0.1 (throttle 0.1) logs kills, round phases and timestamps. A global hotkey logs manual marks (optionally also calls `SaveReplayBuffer`).
3. **Post-match:** fetch the demo (Valve: share code via GC; FACEIT: Data API/download URL, ready in about 5 min). Parse it with demoparser2, align rounds to the recording timeline via GSI round anchors, score moments, and cut with ffmpeg. Build the auto reel (titles, transitions, optional slow-mo) at 1080p60, 12–15 Mbps H.264.
4. **UI:** a per-match page with the auto reel, individual clips, the manual-mark clips, and a round timeline to "clip any moment" (cut from the recording instantly).
5. **Phase 2:** "Render from demo" button for teammates' or enemies' POVs using HLAE on the user's own PC when CS2 is closed (CSDM-style), with a pinned or auto-updated HLAE.
6. **Phase 3 (public service):** decide between client-side capture plus cloud editing (no Valve ToS exposure; Medal/Outplayed model) and cloud demo rendering (Allstar model; account and ToS risk, about $0.01–0.13 per reel compute).

### Gaps
- No head-to-head measurement of the user's own system FPS with each capture method was done. Benchmark on the target PC before choosing between OBS and Steam recording.
- The Steam timeline file format and FACEIT's stance on WGC/Steam recording weren't confirmed from primary sources.
