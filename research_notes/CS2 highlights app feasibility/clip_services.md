# Automatic CS2 Highlight/Clip Services: How They Produce Clips (as of 2 Oct 2026)

Research date: 2026-10-02. Allstar pages are JavaScript-rendered and block plain fetchers, so I read allstar.gg pages (upgrade, autocapture, !allstar, start) and help.allstar.gg articles in a real browser on 2026-10-02. Older info is labeled with its date.

---

## Q1. Allstar.gg: how it produces CS2 clips, how it gets demos, turnaround, pricing and features (2026)

### Takeaway
Allstar renders clips server-side from match demos, not from screen capture. There is no client app: the user links Steam (match share code / auth code), FACEIT or GamersClub, Allstar downloads the demo after the match, scores every moment, and renders clips in its cloud. Clips arrive in about 30 minutes. In 2026 the free tier is capped at 5 clips/month at 720p30. Paid plans cost $0.99–$11.99/month (or $0.89–$7.99/month billed yearly) and raise this to 1080p60 through 4K/120 fps. The "!allstar" all-chat command works as a manual marker: it is written into the demo itself.

### Cited Findings
**Method and positioning**
- Allstar's own marketing: "Get clips from your replays and demos using the cloud… No app download required, works without live streaming, zero FPS drop." Claims 1.9B moments, 62M matches, 14M players. — [Allstar /start (redirect from /howitworks), viewed 2026-10-02](https://allstar.gg/start)
- Autocapture page, step by step: (1) "Connect your Steam account… No overlay, no launcher, nothing running while you queue." (2) "Premier, Matchmaking, FACEIT or GamersClub. Allstar reads the demo once the match ends." (3) clips land in the library. Lists Steam, FACEIT, GamersClub, Esplay and HLTV as platforms. — [Allstar Autocapture](https://allstar.gg/feature/autocapture)
- How moments are picked: "Allstar scores every moment of your match, including kills, clutches, multi-frags and defuses, then clips the highest scoring ones. You choose how selective it is." Works "wherever a demo is available, including Premier, matchmaking, FACEIT and GamersClub." — [Allstar Autocapture FAQ](https://allstar.gg/feature/autocapture)
- Earlier coverage lists the Autocapture selectivity levels as "Everything, Solid Plays, or Highlights Only". — [contentcreators.com Allstar review (search snippet)](https://contentcreators.com/tools/allstar-review)
- Render options: "Your HUD settings apply to every Counter-Strike clip Autocapture makes. Pick which pieces show up, from the kill feed and radar to money, equipment and your crosshair, and tint the whole thing." Clip quality: resolution "up to 4K", frame rate "up to 120fps", motion blur "off to heavy". — [Allstar Autocapture](https://allstar.gg/feature/autocapture)
- Other render-time features: "Swap Skins, Add Filters, Memes and More… over 700 pro level effects", automatic music and FX syncing ("Effects are automatically applied to their corresponding events"), and fully licensed music. — [Allstar /start](https://allstar.gg/start)
- The pricing table lists "Cameras", "Time Remap" and "Enemy POV" as editing features. — [Allstar Upgrade](https://allstar.gg/upgrade)
- Press description (Dec 2023): Allstar works by "transforming server-side game data into high-quality videos in the cloud", with custom camera angles, in-game assets and "advanced 3D filters". Supports CS2, Dota 2, LoL and Fortnite. At that time it had 11.3M users and 27M+ clips. — [Gamelevate on the $12M raise](https://gamelevate.com/allstarsgg-secures-12m-to-scale-cloud-based-creator-tools/)

**How Allstar gets the match/demo**
- Valve MM/Premier uses match share codes (also called authentication codes): "Your share code, or authentication code, allows Allstar to access your previous match data." "Share codes only apply to Valve Matchmaking (MM) matches. FACEIT, Esplay, Refrag, and Gamers Club will not have these codes." The user copies the "CSGO-XXX…" code from CS2 → Watch → Your Matches (demos downloadable for "max 30 days"). — [Allstar Help: share codes](https://help.allstar.gg/hc/en-us/articles/19150960451735-How-do-I-find-my-share-codes-or-download-matches-in-CS2)
- FACEIT: the user links a FACEIT account at allstar.gg/connectedaccounts (FACEIT login prompt), then clicks "Refresh Matches" in Match History. — [Allstar Help: FACEIT FAQ](https://help.allstar.gg/hc/en-us/articles/12077240135319-FACEIT-FAQ)
- Manual fallback: users can upload a CS2 .dem on the Match History page ("Upload Match"). — [Allstar Help: upload a demo (search snippet)](https://help.allstar.gg/hc/en-us/articles/12775949766551-Can-I-upload-a-demo-file-to-Allstar); see also the !allstar FAQ: "If it still isn't there, upload the demo and we'll clip it for you." — [Allstar !allstar](https://allstar.gg/!allstar)
- Older help-center info (CS2 FAQ, written Sept 2023): "We currently only support Competitive and Wingman modes. Casual matchmaking, Deathmatch, etc. will not populate in Match History." The 2026 Autocapture page explicitly adds Premier. — [Allstar Help: CS2 FAQ](https://help.allstar.gg/hc/en-us/articles/17552790931735-CS2-FAQ)

**Turnaround**
- "It will take about 30 minutes for your clips to appear." — [Allstar Help: CS2 FAQ](https://help.allstar.gg/hc/en-us/articles/17552790931735-CS2-FAQ)
- 2026 tiers differ in processing speed: Free "Low", Basic "Standard", Standard "Fast", Unlimited "Priority" ("skip the queue"). — [Allstar Upgrade](https://allstar.gg/upgrade)
- Refrag's on-demand integration (May 16 2024): "Within minutes, you should have your own available." — [Refrag blog](https://refrag.gg/blog/refrag-x-allstar-match-highlights-with-the-click-of-a-button/)

**Pricing (allstar.gg/upgrade, viewed 2026-10-02)**
- Monthly billing: Free $0, Basic $0.99/mo, Standard $4.99/mo ("Most popular"), Unlimited $11.99/mo. Yearly billing works out to Basic $0.89/mo (save 10%), Standard $3.99/mo (save 20%) and Unlimited $7.99/mo (save 33%). — [Allstar Upgrade](https://allstar.gg/upgrade)
- Free: 5 clips/month, 10 clips of cloud storage, 720p at 30 fps, add music. — [Allstar Upgrade](https://allstar.gg/upgrade)
- Basic: 10 clips/month, 50 storage, 1080p60, download clips, filters/effects/cameras, squad/match/career montages. — [Allstar Upgrade](https://allstar.gg/upgrade)
- Standard: Autocapture "up to 5 clips per match", 50 clips/month, 600 storage, "1080p at 120fps", bulk download, Timeline Editor, watermark removal, autosave. — [Allstar Upgrade](https://allstar.gg/upgrade)
- Unlimited: Autocapture of "every highlight worth keeping, every match", unlimited clips and storage, "Stunning 4K at up to 600fps", priority processing. — [Allstar Upgrade](https://allstar.gg/upgrade)
- The same page's comparison table contradicts some of this. It gives max resolution as 720p / 1080p / 4K / 4K and max frame rate as 30 / 60 / 120 / 120 fps (Free / Basic / Standard / Unlimited). So it lists Standard at 4K, where its plan card says 1080p, and Unlimited at 120 fps, where its plan card says "600fps". The Autocapture page says "up to 4K… up to 120fps". — [Allstar Upgrade](https://allstar.gg/upgrade); [Allstar Autocapture](https://allstar.gg/feature/autocapture)
- Historical: Allstar Pro launched Aug 11 2021 at USD $3.99/month (watermark removal, Pro "Creator Cards"). Allstar Studio launched the same day with 80+ Creator Cards (music, kill FX, transitions, intros). — [Nick Cuomo, Medium, Aug 2021](https://medium.com/playsharestar/the-all-new-allstar-1d4f1b7bd535)

**Manual marker: "!allstar"**
- "Type !allstar in all chat after you do something worth keeping. If we can reach your match, we make the clip for free, even if you have hit your clip limit." Suggested bind: `bind "f3" "say !allstar"`. — [Allstar !allstar](https://allstar.gg/!allstar)
- "The command lives in match chat and the clip is built later from the match demo, so nothing has to be open while you play." — [Allstar !allstar FAQ](https://allstar.gg/!allstar)
- Late calls are accepted: "Sent during the next round's buy time or roughly its first 20 seconds, it looks back and clips the round you just finished." The marker granularity is a whole round ("we cut every round you called"). — [Allstar !allstar](https://allstar.gg/!allstar)
- "No, say it in all-chat. Team chat isn't recorded into the match demo, so a team-only !allstar won't be picked up." — [Allstar !allstar FAQ](https://allstar.gg/!allstar)
- !allstar clips are free on all tiers and never count against the limit. Free/Basic get an "Allstar-branded loadout". Standard/Unlimited get a "custom loadout and branding", watermark removal and priority queues. — [Allstar !allstar](https://allstar.gg/!allstar)
- The command dates back to the CS:GO era. In 2021 the desktop app's Activity Feed tracked "your clips journey from !allstar event" onward. — [Medium, Aug 2021](https://medium.com/playsharestar/the-all-new-allstar-1d4f1b7bd535)

**Studio, montages, Discord, mobile**
- Clips go "straight into your Allstar library, ready to share, remix in Studio, or cut into montages." — [Allstar Autocapture](https://allstar.gg/feature/autocapture)
- AllstarBot (Discord): `/share all` or `/share role @role` auto-posts clips to a server. `/match-notify on` posts when a match is ready. It is added from allstar.gg/dashboard. — [Allstar Help: Match History and AllstarBot (search snippet)](https://help.allstar.gg/hc/en-us/articles/19069643013399-Match-History-and-AllstarBot); [AllstarBot directory listing](https://discord.com/application-directory/580572502288498700)
- iOS and Android apps let users create clips from match history on mobile. — [Allstar /start](https://allstar.gg/start)

**B2B / partner API (Allstar as white-label clip engine)**
- FACEIT Highlights: "generated by Allstar.gg", "available only to players with a FACEIT Premium subscription", "cloud based… won't affect your FPS". — [FACEIT Help: Highlights FAQ (search snippet; page 403 to fetch)](https://support.faceit.com/hc/en-us/articles/17380248744860-Highlights-FAQ)
- Allstar's CS2 FAQ: users still receive clips automatically through Leetify, FACEIT and Refrag. — [Allstar Help: CS2 FAQ](https://help.allstar.gg/hc/en-us/articles/17552790931735-CS2-FAQ)
- Allstar's status page monitors a "Partner API" component. — [Allstar Status](https://status.allstar.gg/)
- QuickFrag (FR) markets free CS2 auto-clips from uploaded demos: "Allstar processes your demo in the cloud — no credits, no GPU queue on your account". It offers 16:9 and 9:16 output. — [QuickFrag](https://www.quickfrag.fr/cs2-auto-clips)
- FACEITSync (third party) uploads the FACEIT demo after each match, and Allstar.gg generates the clips. Plans start at €2.99/month: Free 4 clips/month, Player+ 25, Premium unlimited (search snippets; site behind a Cloudflare challenge). — [FACEITSync pricing](https://faceitsync.com/en/pricing); [FACEITSync highlight clips](https://faceitsync.com/en/features/highlight-clips)

**Company and 2025–2026 changes**
- Founded Aug 2019 by Nick "anTs" Cuomo (CEO) and Gavin Silver (CTO). $12M Series A (Dec 2023) led by Drive Capital, about $19M total. Investors include Mark Cuban and Overwolf. — [Esports Advocate](https://esportsadvocate.net/2023/12/allstar-seriesa-drive-capital/); [Esports Insider](https://esportsinsider.com/2023/12/automated-content-platform-allstar-secures-12m-series-a-funding-round)
- "3rd Party Settings" page (Jan 2, 2025) lets users control integrations (Facecheck, U.GG, Leetify, FACEIT, Refrag). — [Allstar Help search results](https://help.allstar.gg/hc/en-us/search?query=FACEIT)
- Leetify moved off Allstar on 30 Jul 2026. Free users' clips now come from an unnamed new provider with Leetify branding. Highlights+ subscribers stay on Allstar "for at least a few more weeks". — [Leetify blog](https://leetify.com/blog/highlights-provider-change/)
- 24 Sep 2026 status incident, "CS2 Clipping" degraded: "The recent CS2 update has been causing some minor issues… clips may be delayed or require retries". Resolved after about 13 h. — [Allstar Status](https://status.allstar.gg/)
- Autocapture is labeled "NEW" on the 2026 pricing page, and is gated to Standard/Unlimited. — [Allstar Upgrade](https://allstar.gg/upgrade)

### Inferences
- The free tier (5 clips/month, 720p30, watermark) suits a sampler, not "every match". Getting 1080p60 automatically for every match effectively needs Standard ($4.99/mo, or $3.99/mo billed yearly), and even that caps Autocapture at 5 clips per match. !allstar is the free workaround for flagged rounds.
- !allstar is a clever zero-install manual marker: the demo's all-chat log carries the timestamp, and a lookback rule maps it to a round. Team chat is not stored in demos. The cost is round-level granularity, and anyone in the lobby sees the message.
- The 2021 → 2026 trend shows Allstar moving from "core always free" toward metered clips, resolution tiers and paid Autocapture. That matches the paywall complaints (see Q9).

### Gaps
- Allstar has published no engineering detail on its render fleet (OS, GPU type, cloud vendor, use of HLAE). No job posting describing it was found; allstar.gg/careers lists no specific roles publicly.
- The exact Autocapture clip length and per-tier bitrate are not stated.
- It is unclear whether the free tier's watermark is removable (the pricing page lists removal from Standard up).
- A search-engine summary claimed an Aug 2026 "provider issue" delaying clips. I could not find the primary source.
- The FACEIT Highlights clip count per match and the FACEIT Premium price were not verified (the FACEIT help page returned 403).

---

## Q2. What demo-based cloud rendering implies: infrastructure, Valve ToS, and quality limitations

### Takeaway
All public evidence says Allstar plays back the demo in the real CS2 engine on its servers. A CS2 update broke its clipping in Sept 2026. Its features (swap skins, enemy POV, free cameras, motion blur, 4K/120 fps, HUD toggles) are what a demo-playback-and-frame-capture pipeline provides. The open-source equivalent is CS Demo Manager driving CS2 with `startmovie` or HLAE `mirv_streams` plus FFmpeg. That runs on Windows, and on Linux without HLAE. Built-in limits: Premier/MM demos contain no voice, team chat is not stored, demos are 64-tick server snapshots, and the HUD and crosshair are re-created by the renderer rather than recorded from your screen.

### Cited Findings
- The reference pipeline is CS Demo Manager. It "launches Counter-Strike, plays the demo, and executes a game command that generates uncompressed image files (.tga) and audio (.wav)", then uses FFmpeg/VirtualDub. Alternatively, HLAE `mirv_streams` "avoid[s] the need to generate temporary raw files". OS support: CS2 video works on Windows and Linux. HLAE is Windows-only. — [CS Demo Manager: Video guide](https://cs-demo-manager.com/docs/guides/video)
- Smooth rendering technique: `startmovie name 60` renders frame by frame, and HLAE + FFmpeg is the fastest Windows route. — [search summary of CS DM / vredux guides](https://cs-demo-manager.com/docs/guides/video); [vredux CS2 demos guide](https://vredux.com/articles/cs2-demos-guide)
- Allstar clipping depends on the CS2 build: on 24 Sep 2026, "The recent CS2 update has been causing some minor issues… clips may be delayed or require retries." — [Allstar Status](https://status.allstar.gg/)
- Tick rate: CS2 demos contain 64 ticks per second. CS2 runs a hardcoded 64 Hz server tick with sub-tick timestamps on inputs. — [vredux: tick rate & sub-tick](https://vredux.com/articles/tick-rate-and-sub-tick-system-in-cs2)
- Voice: Premier/MM demos do not record comms. "it only works for faceit demos. premier demos don't record comms" (Sep 15 2025). — [Steam Community thread](https://steamcommunity.com/app/730/discussions/0/594026537713418924/); also "Matchmaking and Premier demos contain no voice audio data whatsoever—your own team is missing too" — [ZeroUtil](https://zeroutil.com/blog/cs2-cant-hear-voice-demo/)
- FACEIT/server (SourceTV) demos can carry voice. Playback uses `tv_listen_voice_indices -1` / `tv_listen_voice_indices_h -1`. On community servers, CS2 SourceTV "does not record player's voice chat by default unless the server has `sv_alltalk 1`". — [b0ink/CS2-FixDemoVoiceChat](https://github.com/b0ink/CS2-FixDemoVoiceChat); [Hotspawn FACEIT demo guide](https://www.hotspawn.com/counter-strike/guide/how-to-watch-faceit-demos-in-cs2)
- Team chat is not recorded into the match demo. — [Allstar !allstar FAQ](https://allstar.gg/!allstar)
- Demo availability: Valve MM demos are downloadable for a maximum of 30 days. Casual and Deathmatch are not supported (no demos). — [Allstar share codes](https://help.allstar.gg/hc/en-us/articles/19150960451735-How-do-I-find-my-share-codes-or-download-matches-in-CS2); [Allstar CS2 FAQ](https://help.allstar.gg/hc/en-us/articles/17552790931735-CS2-FAQ)
- HUD and crosshair are render-time settings ("Pick which pieces show up… money, equipment and your crosshair, and tint the whole thing"). They are re-created by Allstar, not captured from the player's own client. — [Allstar Autocapture](https://allstar.gg/feature/autocapture)
- Server-vs-client view: demos show what the server saw, which can differ from what the player saw. This comes from a search summary of Steam/HLTV-related discussions and is not verified against a primary source. — [Steam discussion (search result)](https://steamcommunity.com/app/730/discussions/0/3821921399617253157)

### Inferences
- **Infrastructure.** To run CS2 (Source 2) you need a GPU-backed Windows or Linux host running the full Steam client and game. Likely a fleet of Windows GPU VMs if HLAE is used (HLAE is Windows-only), or Linux GPU hosts using native `startmovie`. Each render instance needs a Steam login/licence for CS2 (free-to-play), demo download from Valve's replay CDN (via share-code decoding) or FACEIT's API, a config/HUD injection step, frame capture, and an FFmpeg encode/composite stage. Allstar's music/FX editing ("cloud tool chains and algorithmic decision making engines", 2021) sits after that. Render cost scales with clip seconds × resolution × fps, which explains why 4K/120 and "priority processing" are paid tiers.
- **Valve ToS/licensing.** I found no public Valve statement authorizing or forbidding commercial cloud rendering of CS2 demos. Allstar has operated openly since 2019, with FACEIT as a distribution partner, and nothing indicates Valve objection. For a DIY tool, rendering locally on the user's own PC with their own CS2 install avoids this question.
- **Quality caveats vs. live capture.**
  - 64-tick snapshots are interpolated to 60–120 fps. Motion is smooth, but it is not your exact client frames: recoil and viewmodel nuances, sub-tick shot timing and your own visual settings can differ.
  - Premier clips have no voice. Your Discord comms are never available.
  - Your crosshair and HUD config is approximated, not native.
  - The upside: cinematic cameras, enemy POV, skin swaps and 4K are possible no matter how strong your PC is.
- **For the user's app.** Live capture on the player's PC gives exact what-you-saw 1080p60 with voice and Discord audio, and is ready instantly. Demo rendering gives flexible cameras with no in-game overhead, but with a delay, no Premier voice, and a dependency on CS2 updates. A hybrid is possible: live replay buffer plus GSI/demo-derived event timestamps.

### Gaps
- No primary source confirms whether Allstar uses HLAE, Windows or Linux, or which cloud provider.
- No measurements of Allstar clip bitrate or file specs were found.
- Valve's position on commercial demo rendering: not found.
- I found no systematic, sourced comparison of interpolation smoothness between demo renders and live capture (only community guides).

---

## Q3. Medal.tv: live capture with auto-clipping for CS2

### Takeaway
Medal is a local Windows recorder with a replay buffer. It auto-saves clips on CS2 events (Kill, 2K–Ace, Headshot, Clutch, Knife, Death, Assist), has a manual hotkey (F8) and a voice "clip that" command, and drops bookmarks during full-session recording. It is free. Medal Premium is $9.99/mo ($7.99/mo billed annually) as of June 2026. Medal does not publicly disclose its event-detection method.

### Cited Findings
- CS2 auto-detected events: "Ace, 4K, 3K, Clutch, Knife Kill, and Headshot". Medal "auto-detects Counter-Strike 2 and starts a lightweight replay buffer". Max recording quality "4K / 144fps". Manual save is F8. There is a "clip that" voice command. The buffer is adjustable from 15 s to 10 min. It works on NVIDIA/AMD/Intel GPUs. — [Medal: CS2 Game Recorder](https://medal.tv/developer/cs2)
- Anti-cheat claim: Medal is "a screen recorder that uses standard Windows graphics APIs" and "does not read or modify CS2's memory or interact with the VAC-protected process." — [Medal: CS2 Game Recorder](https://medal.tv/developer/cs2)
- Auto-clip event list: Kill, 2K, 3K, 4K, Ace, Headshot, Death, Assist. "Auto clipping is part of the same recorder that runs instant replay… in a supported game, the game event does it for you." With Full Session Recording, "Medal drops a bookmark on the session instead". "Most supported games also need their own replay system enabled, because Medal builds on it." — [Medal Auto Clipping](https://medal.tv/auto-clipping)
- Requirements: disable Streamer Mode, which "obfuscates some information that Medal uses to detect the in-game events". Windows only. — [Medal Support: Automatic Event Detection](https://support.medal.tv/support/solutions/articles/48001167701-what-is-automatic-event-detection-)
- When kills come back to back, Medal consolidates them into one clip (search snippet). — [Medal CS2 page](https://medal.tv/developer/counter-strike-2)
- Medal Premium: "Premium stays at $9.99 or $7.99 a month if you subscribe annually." The June 2026 update made clip uploads unlimited in length (previously capped at 30 min) and allowed "full original quality" uploads (previously downscaled to 1440p/120fps). It also added auto subtitles and full-library cloud backup. Watermark removal and no ads are unchanged. — [Medal blog, June 2026](https://medal.tv/blog/posts/same-price-more-stuff-check-out-the-updates-to-medal-premium)
- Older third-party claim (Feb 2026): free users limited to 10-minute clips (30 with Premium). Superseded for Premium by the June 2026 change. — [Techraisal, Feb 19 2026](https://nicholascarter.techraisal.com/blog/fastest-cs2-clipping-software/)

### Inferences
- The "Streamer Mode obfuscates information" requirement suggests Medal reads player-identifying game data, either CS2 Game State Integration or on-screen/kill-feed analysis. This is unconfirmed. GSI exposes the local player's per-round kills and headshots (see Q5), which is enough for Kill, 2K–Ace and Headshot events.
- Medal is the closest existing product to the user's target: auto plus manual, local 1080p60 or better, near-instant clips, voice and Discord audio captured. What it lacks is automatic per-match edited montages.

### Gaps
- Medal's exact CS2 detection mechanism (GSI vs. vision) is not disclosed.
- Free-tier upload resolution and watermark rules as of Oct 2026 were not confirmed.
- Medal's compatibility with FACEIT AC in 2026 was not found in a primary source.

---

## Q4. Overwolf Outplayed (and other Overwolf-based capture)

### Takeaway
Outplayed is a live-capture recorder on the Overwolf platform. It triggers on events from Overwolf's Game Events Provider (GEP): kill, death, assist, kill_feed, round and match start/end. It is ad-supported free, with a Premium tier of roughly $9/mo per secondary sources. The major caveat: FACEIT's anti-cheat blocks Overwolf game events in CS2, so auto-capture does not work on FACEIT. Overlays also need windowed mode in trusted CS2.

### Cited Findings
- Overwolf GEP for CS2 provides events `match_start`, `match_end`, `kill`, `death`, `assist`, `kill_feed`, `round_start`, `round_end`. Info updates include kills, deaths, assists, round number, phase, map, score and roster. The data source (GSI or otherwise) is not stated. — [Overwolf Dev: CS2 Game Events](https://dev.overwolf.com/ow-native/live-game-data-gep/supported-games/counter-strike-2/)
- Trusted-mode caveat: "When running this game in trusted mode (without any launch parameters), OW can't go into an 'exclusive mode' once the game is in a fullscreen state." — [Overwolf Dev: CS2 Game Events](https://dev.overwolf.com/ow-native/live-game-data-gep/supported-games/counter-strike-2/)
- Overwolf overlays for CS2 "only work while the game is in windowed mode". — [Overwolf Support: Overlay Troubleshooting (search snippet)](https://support.overwolf.com/support/solutions/articles/9000202391-overlay-troubleshooting)
- FACEIT conflict (modified Nov 24, 2025): FACEIT AC "may block Overwolf from accessing game events in certain titles (Such as Counter-Strike 2.)" Apps that rely on game events, "for example, the Highlights Capture Mode in Outplayed", "will not function while FACEIT is running." The workaround is to disable FACEIT AC or not use both together. — [Overwolf Support: Using Overwolf and FACEIT](https://support.overwolf.com/support/solutions/articles/9000233364-using-overwolf-and-faceit)
- Pricing: free tier with ads; Premium "roughly $8.99/month". Free-plan clips posted to Outplayed are deleted after 3 months. Premium adds unlimited hosting for content after March 2025 and watermark customization. These come from search-result summaries of competitor comparison pages, not Overwolf directly. — [Medal vs Outplayed](https://medal.tv/compare/medal-vs-outplayed); [Insights vs Outplayed](https://insights.gg/blog/insights-vs-outplayed)

### Inferences
- For this user, who plays both Premier and FACEIT with friends, Outplayed's auto-capture would silently fail on FACEIT. That is a major gap, and a lesson for their own design: event detection that depends on an injected or hooked client can be blocked by FACEIT AC. Out-of-process GSI or post-match demo parsing is more robust.

### Gaps
- Outplayed's CS2 recording quality limits and pricing were not confirmed on an Overwolf first-party page.
- Whether Overwolf GEP for CS2 is built on Valve GSI was not confirmed.

---

## Q5. NVIDIA ShadowPlay / NVIDIA App "Highlights", AMD Adrenalin, and CS2 Game State Integration

### Takeaway
NVIDIA Highlights needs per-game SDK integration. CS2 is listed as Highlights-enabled on GeForce NOW (cloud), but I found no evidence that CS2 triggers NVIDIA App Highlights on a local PC. ShadowPlay Instant Replay (manual hotkey) works in CS2 trusted mode, and the NVIDIA App now supports AV1 and 240 fps capture. AMD Adrenalin offers only a manual Instant Replay, with no CS2 auto-highlights found. CS2's own Game State Integration is the officially supported, out-of-process way to get local-player live events.

### Cited Findings
- On GeForce NOW, Highlights-supported games include Apex Legends, Counter-Strike 2, Cyberpunk 2077, Destiny 2 and Dota 2. Highlights is on by default for supported games, and Ctrl+G opens the gallery. (Search snippet of NVIDIA's support article; the article returned 403.) — [NVIDIA: What games on GeForce NOW support Highlights?](https://nvidia.custhelp.com/app/answers/detail/a_id/4812/~/what-games-on-geforce-now-support-highlights); [NVIDIA: Enable Highlights on GFN](https://nvidia.custhelp.com/app/answers/detail/a_id/4810/~/how-do-i-enable-nvidia-highlights-on-geforce-now)
- On a local PC, a user (Dec 29 2024) reports NVIDIA Highlights only triggering in Fortnite, not CS2. There is no official answer, and a May 2025 follow-up is unresolved. — [Steam Community: Nvidia highlight in CS2](https://steamcommunity.com/app/730/discussions/0/594010736966035819/)
- NVIDIA App release notes: 10.0.1 added "AV1 codec for Record, Instant Replay, and Highlights". 11.0.8 added "240 FPS ShadowPlay recording, for GeForce RTX 50 and 40 Series GPUs". The notes give no game list and never mention Counter-Strike. — [NVIDIA App release highlights](https://www.nvidia.com/en-us/software/nvidia-app/release-highlights/)
- The NVIDIA App "Highlights" auto-capture works only in supported games, with a prompt at game launch to choose which moments to save (search snippet). — [NVIDIA App page](https://www.nvidia.com/en-us/software/nvidia-app/)
- ShadowPlay still works under Trusted Mode (it is not an injected hook the way OBS Game Capture is), per streaming guides from the CS:GO Trusted Mode era (2020). — [Upcomer: streaming CS:GO after Trusted Mode](https://upcomer.com/how-to-stream-csgo-with-obs-after-the-trusted-mode-update-2/); [Dignitas guide](https://dignitas.gg/articles/how-to-stream-cs-go-using-obs)
- AMD Adrenalin Instant Replay buffers 30 s to 10 min (or up to 20 min per another description) and saves on a hotkey (Alt+R opens the overlay). I found no automatic game-event highlight feature for CS2. — [search summary of AMD/Insights guides](https://insights.gg/blog/10-best-clipping-software-that-doesnt-affect-fps); [AMD support FAQ](https://www.amd.com/en/resources/support-articles/faqs/DH3-023.html)
- CS2 Game State Integration: a `gamestate_integration_*.cfg` file in the game's cfg folder makes CS2 send HTTP POSTs of JSON state to a local endpoint. Data includes player state, weapons, match stats, and round kills, headshots and damage. The game "will only expose local player's information when playing a game" (all players only when spectating). Libraries derive events such as `PlayerGotKill`. — [antonpup/CounterStrike2GSI](https://github.com/antonpup/CounterStrike2GSI)

### Inferences
- For a DIY app on an NVIDIA GPU, the realistic path is (a) your own capture (OBS libobs, Windows Graphics Capture or DXGI Desktop Duplication, NVENC encoding) or ShadowPlay Instant Replay triggered by synthesized hotkeys, combined with (b) GSI for real-time kill and round timestamps. The NVIDIA Highlights SDK cannot be used, because it requires CS2 itself (Valve) to integrate it.

### Gaps
- NVIDIA's official local-PC Highlights game list for 2026 was not retrievable (403). Whether CS2 Highlights works locally via the NVIDIA App is unconfirmed.
- No 2025–2026 AMD auto-highlight feature found.

---

## Q6. Steam Game Recording and the Steam Timeline API: does CS2 publish markers?

### Takeaway
Yes. CS2 was a launch title for Steam Game Recording (beta June 2024, general availability Nov 5–6 2024). It auto-fills the timeline with game-defined markers such as kills, deaths and rounds, and players can add manual markers with a hotkey. Clips can be exported as video. However, the Timeline API is a write API for games. I found no documented way for third-party apps to read those markers, and there is no auto-editing.

### Cited Findings
- Official CS2 account (June 26 2024): "in CS2 your Game Recordings feature a timeline auto-filled with game-defined markers, like kills and deaths. And you can add your own markers at any time." — [CS2 on X](https://x.com/CounterStrike/status/1806063373731389859?lang=en)
- Auto-generated markers launched for only CS2, L4D2 and Dota 2 (June 2024). — [search summary of Pocket-lint/OneEsports](https://www.pocket-lint.com/how-to-record-and-share-your-gameplay-on-steam/)
- Steam Game Recording left beta and became available to all users with the Steam client update of Nov 5 2024 (reported Nov 6). — [Steam client update Nov 5](https://steamcommunity.com/games/593110/announcements/detail/4472730495692571025); [GameSpot](https://www.gamespot.com/articles/steam-game-recording-is-now-live-for-all-pc-and-steam-deck-users/1100-6527599/)
- Usage details (June 29 2024 article): background recording or on-demand recording (default record hotkey Ctrl+F11), a customizable marker hotkey, "Export Video File", adjustable resolution and bitrate (24 Mbps suggested for content creation), background recording up to 120 minutes, and a disk-usage display. It could not capture Discord audio (in-game voice only). — [OneEsports guide](https://www.oneesports.gg/counter-strike-2/how-to-use-steam-game-recording/)
- Timeline API for developers: `AddTimelineEvent` (icon, title, description, priority/time) and `SetTimelineGameMode` (e.g., `k_ETimelineGameMode_Playing` vs `Staging`). Built-in icon set uses the `steam_` prefix, plus `steam_0`–`steam_99` number icons. The docs do not describe any API for external apps to read timeline data. — [Steamworks: Timeline](https://partner.steamgames.com/doc/features/timeline)
- Regression report (Oct 7 2025, Linux): after a Steam client update, CS2 recordings showed "no timeline markers" (rounds, K/D) and clips could not be saved. No Valve response visible. — [steam-for-linux #12366](https://github.com/valvesoftware/steam-for-linux/issues/12366)

### Inferences
- Steam Recording plus CS2 markers already covers "auto-detect plus manual mark" for free, at zero install cost. But it is a closed UI: no automatic per-match highlight export, no montage, and no API to pull markers. A DIY app would need to rebuild the markers itself, from GSI live or from demo parsing after the match.

### Gaps
- Current (2026) Steam recording max resolution and fps options and the default marker hotkey were not confirmed from a Valve primary page (store.steampowered.com/gamerecording returned only navigation).
- Whether Steam exposes recordings or markers on disk in a parseable format was not researched or found.

---

## Q7. Other services: Leetify, FACEIT, Refrag, FACEITSync, QuickFrag, Insights.gg, Eklipse, Powder, SteelSeries, Logitech, Scope.gg, Clipped, Skybox

### Takeaway
Most CS2 "highlight" features from stats and community platforms (FACEIT Premium, Refrag, FACEITSync, QuickFrag and, until July 2026, Leetify) are Allstar's demo-render engine under the hood. Leetify switched to an unnamed provider on 30 Jul 2026. Live-capture competitors are Medal, Outplayed, Insights Capture, SteelSeries Moments and Logitech's new AI clipper. Eklipse and FragCut analyze VODs or uploaded video with AI in the cloud. Powder shut down in July 2026.

### Cited Findings
- **FACEIT Highlights**: generated by Allstar.gg, FACEIT Premium only, cloud-based, enabled automatically. — [FACEIT Help: Highlights FAQ (search snippet)](https://support.faceit.com/hc/en-us/articles/17380248744860-Highlights-FAQ)
- **Leetify**: "switching Highlights providers behind the scenes" (30 Jul 2026). New clips carry Leetify branding. A highlights page is at leetify.com/app/highlights (beta). A Discord-bot auto-posting feature is in progress. The new provider is not named. — [Leetify blog](https://leetify.com/blog/highlights-provider-change/)
- **Refrag**: an "A" button in Refrag match history requests an Allstar clip, "within minutes" (May 16 2024). — [Refrag blog](https://refrag.gg/blog/refrag-x-allstar-match-highlights-with-the-click-of-a-button/)
- **FACEITSync**: auto-uploads FACEIT demos to Allstar. Plans from €2.99/mo (Free 4 clips/mo, Player+ 25, Premium unlimited). — [FACEITSync pricing (search snippet)](https://faceitsync.com/en/pricing)
- **QuickFrag**: upload a .dem, choose a mode (Play of the Game, Best Play, Match, Squad) and a POV player. Rendered by Allstar in the cloud, free, 16:9 and 9:16. — [QuickFrag](https://www.quickfrag.fr/cs2-auto-clips)
- **Insights Capture (insights.gg)**: free local recorder. "Recording starts when you connect to a server and ends with the final round". Kills, deaths and round transitions are timestamped. "Aces, clutches and multi-kills are caught automatically." Marketed as a "No-Overwolf" alternative, although an Overwolf store listing also exists. Paid Insights plans ($39–$229/mo) are team VOD-review storage plans. — [Insights CS2 page (search snippet)](https://insights.gg/games/counter-strike-2); [Insights pricing](https://insights.gg/pricing); [Insights vs Outplayed](https://insights.gg/blog/insights-vs-outplayed); [Overwolf listing](https://www.overwolf.com/app/insights_gaming-insights_capture)
- Insights records at "1080p, 1440p, or 4K at 60 FPS" (third-party listicle, Feb 2026). — [Techraisal](https://nicholascarter.techraisal.com/blog/fastest-cs2-clipping-software/)
- **Eklipse**: cloud AI over stream VODs. "Auto-detects ace rounds, clutch 1vXs, and spray transfers, then exports vertical captioned highlights". Web, iOS and Android. — [Eklipse CS2 use case](https://eklipse.gg/use-case/counter-strike-2-highlights/)
- **Powder**: AI highlight clipper covering 40+ games, including CS2. NPU-accelerated editing announced March 2025. Reported shut down in July 2026, with subscriptions cancelled (search summary; primary shutdown notice not opened). — [BusinessWire, Mar 2025](https://www.businesswire.com/news/home/20250306279293/en/Powder-Unleashes-First-Ever-AI-Powered-NPU-Accelerated-Video-Editing-for-Gamers); [powder.gg](https://www.powder.gg/)
- **SteelSeries Moments**: free local recorder whose AI recognizes "3+ kills in a round" and headshots (third-party listicle). — [Techraisal](https://nicholascarter.techraisal.com/blog/fastest-cs2-clipping-software/)
- **Logitech**: new AI clipping software (G HUB "Replay") that records gameplay and uses deep learning to pick clips. PC Gamer tested it on CS (article body not retrievable). — [PC Gamer](https://www.pcgamer.com/software/ai/thanks-logitech-your-new-ai-fueled-game-clipping-software-makes-me-look-trash-at-counter-strike-but-imma-keep-it-installed/)
- **FragCut**: upload gameplay video and AI extracts CS2 highlights (AWP flicks, aces, clutches, spray transfers). — [FragCut](https://fragcut.io/games/counter-strike-2)

### Inferences
- **Cross-service summary matrix** (built from the findings above):

| Service | Method | Trigger | Max quality | Turnaround | Cost (USD) | Needs desktop app | Manual mark |
|---|---|---|---|---|---|---|---|
| Allstar | Cloud demo render (CS2 engine) | Demo parse + scoring; !allstar chat | Free 720p30; Basic 1080p60; Std/Unl up to 4K/120 | ~30 min; priority tiers | $0 / 0.99 / 4.99 / 11.99 per mo (yearly 0.89 / 3.99 / 7.99) | No | `say !allstar` (round-level) |
| FACEIT Highlights | Allstar engine | Auto | n/a | ~minutes–30 min | FACEIT Premium | No | No |
| Leetify Highlights | Allstar until Jul 2026, now undisclosed | Auto | n/a | n/a | Free / Highlights+ | No | No |
| Medal | Local capture, replay buffer | Game events + F8 + voice | 4K/144 | Instant | Free; Premium $9.99 (or $7.99/mo yearly) | Yes | Hotkey, voice, session bookmarks |
| Outplayed | Local capture (Overwolf) | Overwolf GEP events | n/a | Instant | Free w/ ads; ~$8.99 Premium | Yes | Hotkey (generic) |
| Insights Capture | Local capture | Event timestamps | up to 4K60 | Instant | Free | Yes | Not documented |
| Steam Recording | Local capture (Steam) | CS2 timeline markers | Configurable | Instant | Free | Steam client | Marker hotkey |
| NVIDIA App | Local NVENC | Manual (Highlights not confirmed for CS2 locally) | up to 240 fps on RTX 40/50 | Instant | Free | Yes | Hotkey only |
| Eklipse / FragCut | Cloud AI on video/VOD | Vision AI | Source-dependent | Minutes | Freemium | No (upload) | No |

- No existing product combines all three of the user's goals: exact what-you-saw local 1080p60, automatic per-match edited montage, and a Premier-plus-FACEIT manual marker that works under FACEIT AC. That is the gap a DIY tool could fill.

### Gaps
- **Scope.gg, Clipped, Skybox**: no reliable 2026 information found on CS2 clip features.
- **Leetify's new provider** (and whether it is demo-render or something else) is unknown.
- I did not verify "FACEIT Watch" clip features beyond FACEIT Highlights; the Watch FAQ was not fetched.

---

## Q8. Live capture safety and cost: VAC trusted mode, FACEIT AC, performance, storage

### Takeaway
CS2's Trusted Mode blocks injected capture hooks (OBS Game Capture) unless you launch with `-allow_third_party_software`. Non-injecting capture works: OBS Window or Display Capture, Windows Graphics Capture/DXGI, NVIDIA ShadowPlay, and Medal's "standard Windows graphics APIs". FACEIT AC (kernel-level) supports signed OBS builds, apart from a certificate-transition gap with OBS 31.0. It blocks Overwolf game events in CS2. Storage for a 1080p60 replay buffer or full-session recording runs to several GB per hour.

### Cited Findings
- OBS KB: "Valve does not allow any injection unless the game is running in 'Untrusted' mode via the `-allow_third_party_software` launch parameter." FACEIT AC compatibility with the OBS game-capture hook: OK on 30.1, 30.2 and 31.1+, failing on 31.0 (ECC-only certificate). — [OBS KB: Capture Hook Certificate Update](https://obsproject.com/kb/capture-hook-certificate-update)
- OBS forum (Dec 2024): OBS could not capture CS2 under FACEIT AC until FACEIT updated. Recommended options: Window Capture in windowed or borderless mode, `-allow_third_party_software`, or rolling back OBS. — [OBS forum thread](https://obsproject.com/forum/threads/capture-cs2-with-anti-cheat.182477/)
- Valve's Trusted Mode rationale: there is no whitelist, because "benign applications are often a vector for cheats that hijack them". OBS Game Capture is blocked, but "NVIDIA Shadowplay still works". — [Upcomer (CS:GO-era, 2020)](https://upcomer.com/how-to-stream-csgo-with-obs-after-the-trusted-mode-update-2/); [OBS forum: About CS:GO Trusted Mode](https://obsproject.com/forum/threads/about-cs-go-trusted-mode.128216/)
- Medal: it "uses standard Windows graphics APIs" and "does not read or modify CS2's memory or interact with the VAC-protected process." — [Medal CS2](https://medal.tv/developer/cs2)
- FACEIT AC blocks Overwolf game events in CS2 (Nov 2025). — [Overwolf Support](https://support.overwolf.com/support/solutions/articles/9000233364-using-overwolf-and-faceit)
- Aggregator (July 2026): FACEIT AC is kernel-level and rated "Caution" for overlays. "Official builds of OBS and Discord are supported; unrecognized software tends to be blocked from running alongside it rather than banned." (Secondary source.) — [Backgrind overlay/anti-cheat checker](https://backgrind.com/overlay-anticheat-checker/)
- An older community claim says FACEIT made ShadowPlay capture impossible because of the FACEIT client's own "Highlights" feature. This is a dated search snippet with no primary confirmation, so treat it as unreliable. — [Steam discussion (search result)](https://steamcommunity.com/app/730/discussions/0/3106892784345110165/)
- GSI is Valve's designed, out-of-process interface: game → HTTP POST to localhost, local player data only. — [CounterStrike2GSI](https://github.com/antonpup/CounterStrike2GSI)
- Steam Recording shows how much disk a background recording will use. A 24 Mbps setting is suggested, and the maximum background recording length is 120 min. — [OneEsports](https://www.oneesports.gg/counter-strike-2/how-to-use-steam-game-recording/)

### Inferences
- **Safe architecture for the user's app**:
  - Capture with Windows Graphics Capture or DXGI Desktop Duplication (or libobs window/display capture), plus NVENC/AMF/QSV hardware encoding. Do not inject into CS2.
  - Get events from GSI (sanctioned, out-of-process, works on FACEIT because CS2 itself sends the HTTP POST) and/or from post-match demo parsing.
  - Add a global hotkey for manual marks.
  - None of this touches CS2 memory, so it stays clear of VAC and very likely FACEIT AC. FACEIT may still block unknown processes that hook the game, so avoid overlays.
- **Storage math (my calculation)**: 1080p60 at 24 Mbps ≈ 10.8 GB/hour. At 50 Mbps ≈ 22.5 GB/hour. A rolling 5-minute buffer at 50 Mbps ≈ 1.9 GB. A ~45-minute Premier match at 24–50 Mbps ≈ 8–17 GB if the whole session is recorded rather than a ring buffer. Clipping to event windows (e.g., ±10 s around kills) cuts kept storage by more than 90%.
- **Performance**: hardware-encoder capture overhead is generally small (a few percent of FPS). Medal and NVIDIA both advertise "lightweight" capture, but I found no rigorous CS2-specific benchmark.

### Gaps
- No FACEIT primary documentation listing allowed or blocked capture software was retrievable (the FACEIT support site returned 403).
- No primary Valve statement on whether `-allow_third_party_software` affects Trust Factor was retrieved (community lore says it may).
- No measured CS2 FPS overhead for Medal, ShadowPlay or OBS was found.

---

## Q9. What users love and hate (reviews and community)

### Takeaway
Allstar is praised for zero FPS impact and for working on low-end PCs without an app. In 2025–2026 it is widely criticized for paywall creep, metered clips and billing problems (Trustpilot 1.7/5). Its demo-based clips also arrive with a delay (~30 min), cover only demo-available modes, and have no comms on Premier.

### Cited Findings
- Trustpilot: 1.7/5 from 19 reviews (79% one-star). Complaints:
  - "bait-and-switch": features previously included are "now heavily restricted" after an annual purchase
  - charges continuing after cancellation
  - paid editing that "never loaded and took my credits"
  - mobile clips that "never stop processing"
  - downloads hidden behind a paywall and new upload caps

  The only positive (5-star) reviews date from 2021 and cite good performance for low-spec systems. — [Trustpilot: allstar.gg](https://www.trustpilot.com/review/allstar.gg)
- Allstar's own comparison positions live-capture tools as "60fps if you are lucky", "Whatever your GPU spares" and "You hit record", against its own "Up to 4K / 120FPS / configurable motion blur / automatic". This is marketing. — [Allstar Autocapture](https://allstar.gg/feature/autocapture)
- Leetify moved away from Allstar (July 2026) to get "more control over the clips we create", which suggests B2B partners also want more control. — [Leetify blog](https://leetify.com/blog/highlights-provider-change/)
- Overwolf/Outplayed: the FACEIT incompatibility is acknowledged by Overwolf support. — [Overwolf Support](https://support.overwolf.com/support/solutions/articles/9000233364-using-overwolf-and-faceit)

### Inferences
- Pain points a DIY tool can avoid:
  - Wait times: local capture is instant.
  - Metering and paywalls: none, since you own the hardware.
  - Missing voice: capture system plus Discord audio locally.
  - Mode restrictions: capture works in any mode, including Casual and DM.
- Pain points it inherits: GPU encoder overhead, disk use, and no cinematic re-cameras unless it adds a demo-render path.

### Gaps
- Reddit threads (r/GlobalOffensive, r/cs2, r/FACEITcom) on Allstar quality and wait times were not retrieved directly; search surfaced only Steam and Trustpilot. Community sentiment on Allstar clip smoothness vs. live capture is therefore not quantified.

---

## Q10. Which services combine auto-detection with a manual "mark this moment", and how is the marker implemented?

### Takeaway
Several services do both, using four different marker mechanisms:
1. Allstar: an in-game all-chat command (`say !allstar`) that ends up in the demo, which is clever and needs zero install.
2. Medal: a local hotkey (F8), a voice command, and session bookmarks.
3. Steam Game Recording: a client hotkey that writes a timeline marker next to CS2's automatic kill/death markers.
4. Overwolf-style apps: a generic save hotkey.

### Cited Findings
- **Allstar**: Autocapture scores the demo automatically. The manual marker is `bind "f3" "say !allstar"`, and all-chat messages are stored in the demo. Typed during the next round's buy time or roughly its first 20 s, it clips the previous round. Team chat does not work. — [Allstar !allstar](https://allstar.gg/!allstar); [Allstar Autocapture](https://allstar.gg/feature/autocapture)
- **Medal**: game-event auto clips, plus the F8 hotkey, plus the "clip that" voice command. In Full Session Recording, events become session bookmarks. — [Medal CS2](https://medal.tv/developer/cs2); [Medal Auto Clipping](https://medal.tv/auto-clipping)
- **Steam Game Recording**: CS2 writes kill/death markers automatically, and the user adds markers via a configurable hotkey. — [CS2 on X](https://x.com/CounterStrike/status/1806063373731389859?lang=en); [OneEsports](https://www.oneesports.gg/counter-strike-2/how-to-use-steam-game-recording/)
- **Insights Capture**: automatic timestamps for kills, deaths and rounds. A manual marker is not documented. — [Insights CS2](https://insights.gg/games/counter-strike-2)

### Inferences
- For a DIY app, the most robust manual-marker designs are:
  - **(a) A global OS hotkey** (RegisterHotKey / low-level keyboard hook in your own process) that timestamps against the capture clock. It works everywhere, including FACEIT. Note that FACEIT AC may frown on low-level keyboard hooks; RegisterHotKey is safer.
  - **(b) Allstar's trick: a CS2 bind that writes into the demo.** Players may not want all-chat spam. A quieter variant writes something to the console log instead (e.g., `bind f3 "echo MARK"` with `-condebug`), which a watcher can tail. This is an inference: verify that echo output reaches console.log in CS2. Alternatively, a bind that triggers a GSI-visible state change.
  - **(c) Dual-source alignment**: GSI events plus hotkey marks live, then post-match demo parsing (e.g., demoparser2) to refine kill ticks and add clutch, multi-kill and wallbang context, the way Allstar scores moments.

### Gaps
- No public documentation of how Medal or Insights timestamp-align CS2 events to video frames (latency compensation).
- Not verified whether CS2's `-condebug` console log reliably captures user `echo` output in 2026.
