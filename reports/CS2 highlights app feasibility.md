# Record locally, parse demos, defer the cloud

The MVP can be built today, and no technical blocker stands in its way, as long as the app **records your gameplay live on your own PC instead of rendering clips from demos**. The only real external dependency is **FACEIT demo files**. Since February–March 2024 FACEIT has served them only through a gated, paid-above-threshold Downloads API, and at its scale Leetify was quoted about **€270k a year** and gave up on automatic import ([Leetify](https://leetify.com/blog/faceit-changes/); [Dust2.us](https://www.dust2.us/news/45779/update-leetify-halts-processing-faceit-demos-due-to-expensive-api-changes)). Premier, by contrast, is fully automatable. Your match-history auth code plus the share-code chain finds every match, the Steam Game Coordinator returns the scoreboard and a `replay*.valve.net` demo URL, and two independent projects shipped that pipeline in September 2026 ([FragIQ](https://github.com/Build-Labs-Group/fragiq); [5stack PR #444](https://github.com/5stackgg/api/pull/444)). For highlights, the safe and robust design has five parts. The official OBS build records the match through non-injecting Window or Display Capture. Valve's Game State Integration (GSI) supplies live kill timestamps. A global hotkey replaces the ShadowPlay button. A post-match demo parse adds clutch and wallbang labels. FFmpeg cuts a 1080p60 reel. This works identically on Premier and FACEIT and costs roughly 3–6% FPS. On ratings, your belief is out of date: HLTV replaced 2.1 with **Rating 3.0 on 20 August 2025**, re-weighted it in October 2025, and tweaked it again around 1 October 2026. The formula is private, so only Rating 1.0 can be reproduced exactly and 2.0 only approximately ([HLTV](https://www.hltv.org/news/42485/introducing-rating-30)). Costs are trivial for you and four friends (about $0–25/month). They stay modest for a hybrid public site that keeps clips for a limited time (about $160–210/month at 1,000 users, $6–9k/month at 50,000). They explode only if you render every match in the cloud, which adds $16k–89k/month at 50,000 users. The hard problems of the "public website" phase are commercial and legal, not technical: paid FACEIT demo access, Steam bot accounts talking to an undocumented protocol, Steam's terms for server-side rendering fleets, HLTV's trademark, and privacy.

## Incumbents either render demos in the cloud or record locally, and none build the session

The existing market splits along the same line your design has to choose. **Stats aggregators** all ingest Valve matches the same way. The user gives a one-time Steam game authentication code and a recent share code. The service polls `ICSGOPlayers_730/GetNextMatchSharingCode`, resolves each code to a demo through the Game Coordinator, and parses the demo on its servers ([Leetify](https://leetify.com/blog/share-codes/); [csstats.gg](https://csstats.gg/getting-the-sharecode); [Tracker.gg](https://tracker.gg/cs2/articles/cs2-stats-tracker-now-live)). Chaining only works forward, demo links expire 30 days after the match, and the in-game client lists only the last 8 matches ([CS Demo Manager](https://cs-demo-manager.com/docs/guides/downloads)). So no incumbent has a structural data advantage on Premier; they compete on analysis, speed and UX.

**Leetify** is the category leader. Its headline metric is a proprietary, zero-centred rating built on round-win-probability change. Credit for each kill is split 35% to the killer, 30% to everyone who damaged the victim, 15% to the flash assister and 20% to the player whose death was traded ([Leetify](https://leetify.com/blog/leetify-rating-explained/)). It adds 0–100 Aim and Utility ratings. The Utility formula is public since October 2025: the geometric mean of a grenade-quantity score and a z-scored quality score ([Leetify](https://leetify.com/blog/utility-ratings/)). It also has last-30-match profiles benchmarked against your rank and, since August 2026, "Top Stats" and teammate, map and rank-progression tabs. Pro unlocks switching the benchmark rank and filtering FACEIT vs Valve ([Leetify](https://leetify.com/blog/profiles-update/)). The 2D replay is Pro-only ([Leetify](https://leetify.com/blog/rating-breakdown/)). Pro was historically **$5.99/month** ([Profilerr](https://profilerr.net/top-7-best-csgo-stat-trackers-to-use/)); the current price could not be confirmed.

Its weaknesses are exactly where your app would aim. Leetify has had no automatic FACEIT import since March 2024, so users rely on community browser extensions or a "submit presigned URL" endpoint ([Leetify](https://leetify.com/blog/faceit-demo-upload-api/)). It had three outages between 26 January and 5 February 2026 that delayed reports by hours ([Leetify](https://leetify.com/blog/january-infrastructure-issues-postmortem/)). It keeps re-tuning a rating that users find opaque; Leetify itself conceded that "baiters" were over-rewarded and that the rating "only cares about whether you win your clutches" ([Leetify](https://leetify.com/blog/leetify-rating-update-2026-02-25/)). And since 23 January 2026 its public API returns data only for registered Leetify users and forbids storing results ([Leetify](https://leetify.com/blog/privacy-updates-to-our-api-and-profiles/)), so you cannot build on it.

**csstats.gg** is free, owned by ESL FACEIT Group ([Dust2.us](https://www.dust2.us/news/45779/update-leetify-halts-processing-faceit-demos-due-to-expensive-api-changes)), and offers full history, round-by-round kill feeds and an "HLTV rating" whose version is undisclosed. **Scope.gg** advertises "HLTV Rating 2.1" ([Scope.gg](https://scope.gg/)), although no public 2.1 formula exists. **Refrag** ($7–15/month) says it automatically pulls both FACEIT and Premier history ([Refrag](https://refrag.gg/blog/cs2-training-tool-comparison/)), but its FACEIT mechanism is undisclosed. **FACEIT** itself now sells analysis: Premium ($10.99/month) includes Match Insights, launched April 2026, with a 2D map and mistake detection ([hawk.live](https://hawk.live/posts/faceit-announced-new-auto-match-analysis-feature-for-cs2)). **ESEA** has run on FACEIT since the August 2023 season, so it needs no separate integration ([HLTV](https://www.hltv.org/news/36529/esea-league-moves-to-faceit)).

**Clip services** split cleanly by method. **Allstar** renders clips server-side from demos in the real CS2 engine, with "no app download required… zero FPS drop" ([Allstar](https://allstar.gg/start)). Clips arrive in about 30 minutes ([Allstar Help](https://help.allstar.gg/hc/en-us/articles/17552790931735-CS2-FAQ)). Its manual marker is clever: you type `!allstar` in all-chat, the message is written into the demo, and the round gets clipped later ([Allstar](https://allstar.gg/!allstar)). Allstar also white-labels the engine for FACEIT Premium highlights and, until July 2026, Leetify ([Leetify](https://leetify.com/blog/highlights-provider-change/)). On the other side, **Medal** records locally with a replay buffer, auto-clips Ace, 4K, 3K, clutch, knife and headshot events, saves manually on F8, and claims it "does not read or modify CS2's memory" ([Medal](https://medal.tv/developer/cs2)). **Overwolf Outplayed** also records locally, but FACEIT Anti-Cheat blocks Overwolf game events in CS2, so its auto-capture silently fails on FACEIT ([Overwolf Support](https://support.overwolf.com/support/solutions/articles/9000233364-using-overwolf-and-faceit)). **Steam Game Recording** writes CS2's own kill and death markers onto a timeline, but it exposes no API for third parties to read them ([Steamworks](https://partner.steamgames.com/doc/features/timeline)). **NVIDIA Instant Replay** has no programmatic save at all.

| Service | How it gets data/clips | Notable features | Price (USD) | Main weaknesses |
|---|---|---|---|---|
| Leetify | Share code + GC + server parse; FACEIT only via extensions/upload | WPA-based rating, Aim/Utility ratings, rank benchmarks, 2D (Pro), highlights | Pro historically $5.99/mo | No auto FACEIT; opaque rating; Jan 2026 outages; API locked down |
| csstats.gg | Share code + GC | Full history, round breakdowns, "HLTV rating" | Free | No 2D; rating version undisclosed |
| Scope.gg | Share code + Steam bot | "HLTV 2.1", 2D, recorder | $5–8/mo (2024) | Free tier 1 highlight per 7 days; billing complaints ([Trustpilot](https://www.trustpilot.com/review/scope.gg)) |
| FACEIT | Native | Scoreboard free; Match Insights + Allstar highlights in Premium | Premium $10.99/mo ([shattered.io](https://shattered.io/cs2-premier-rank-vs-faceit-level/)) | FACEIT matches only; paywalled |
| Allstar | Cloud demo render | Auto-scoring, `!allstar`, cameras, up to 4K | Free 5 clips/mo at 720p30; $0.99 / $4.99 / $11.99 per mo ([Allstar](https://allstar.gg/upgrade)) | ~30 min delay; no Premier voice; broke on a CS2 patch 24 Sep 2026 ([status](https://status.allstar.gg/)); Trustpilot 1.7/5 ([Trustpilot](https://www.trustpilot.com/review/allstar.gg)) |
| Medal | Local capture + game events | Auto-clips, F8 hotkey, voice command | Free; Premium $9.99/mo ([Medal](https://medal.tv/blog/posts/same-price-more-stuff-check-out-the-updates-to-medal-premium)) | No per-match edited reel, no stats |
| Outplayed | Local capture + Overwolf events | Auto-clips | Free with ads | Auto-capture blocked under FACEIT AC |

The steelman for not building anything is "Medal plus Leetify". That combination already gives you free local auto-clips and decent stats. But it never assembles a per-match or per-session edited reel. It cannot tie a clip to a stats moment. It has no friend-session calendar. And it still needs browser extensions for FACEIT stats. **No existing product combines exact what-you-saw 1080p60 capture, an automatic per-match montage, a manual marker that works under FACEIT AC, and unified Premier and FACEIT stats for a party.** That gap is real.

## Premier is fully automatable; FACEIT demo files are the one real blocker

The **Valve side works end to end today, with friction you can engineer around**. Discovery goes through `GetNextMatchSharingCode`, which covers Competitive, Wingman and Premier, but not Casual or Deathmatch. Since 31 August 2023 the known code you pass in must be no more than one month old ([Steam news](https://store.steampowered.com/news/posts/?feed=steam_community_announcements&appids=730&enddate=1694214924)). If the app stops polling for over a month, the user has to paste a fresh code. Your app's own Steam Web API key needs a non-limited account, meaning one with at least $5 spent. The key is capped at **100,000 calls/day** under the Steam Web API Terms of Use. Those terms also require that you retrieve data only "as requested by the end user", disclose what you store, and imply no Valve endorsement ([Steam Web API ToU](https://steamcommunity.com/dev/apiterms)).

Turning a share code into a demo URL requires a logged-in Steam client talking to the Game Coordinator (GC). On the desktop, CS Demo Manager (CS:DM) does this with the user's own running Steam client through akiver's boiler-writter. It briefly launches CS2 in the background, needs exclusive GC access (so CS2 must be closed), and "does not—and will never—ask for your Steam credentials" ([CS:DM](https://cs-demo-manager.com/docs/guides/downloads); [cs2-demo-fetcher](https://github.com/aznan-triks/cs2-demo-fetcher)). Demos are about 30–80 MB compressed and expire after about 30 days ([cs2replays](https://cs2replays.com/guides/upload-replay/)). The GC protocol is undocumented and unsupported, so it is a standing risk. FragIQ notes that Node is the only maintained library for it ([FragIQ](https://github.com/Build-Labs-Group/fragiq)). But nothing about it blocks a personal app.

The **FACEIT side splits in two**. The FACEIT Data API v4 easily gives you per-day match lists (`/players/{id}/history`), rosters with SteamID64s, and scoreboard stats: kills, assists, deaths, K/D, headshots, MVPs and multi-kills ([FACEIT docs](https://docs.faceit.com/docs/data-api/data/); [faceit-ruby](https://github.com/kallelundgren93/faceit-ruby)). FACEIT login runs on OAuth2 with PKCE, and a webhook can push `match_status_finished` and `match_demo_ready` ([FACEIT webhooks](https://docs.faceit.com/docs/webhooks/)). The **demo file**, however, is only a private resource URL. It has to be exchanged through `POST /download/v2/demos/download`. That requires a separate Downloads API token, granted after an application with an "expected response time … 30 days", with free use only up to an unpublished monthly threshold ([FACEIT Downloads API](https://docs.faceit.com/getting-started/Guides/download-api/)). CS:DM was given a server-side key and still has in-app FACEIT downloads "temporarily unavailable" because it would need its own proxy backend ([CS:DM](https://cs-demo-manager.com/docs/guides/downloads)).

Community tools work around this by using the user's own logged-in faceit.com session. The "Watch Demo" button yields a presigned S3 URL, which extensions forward to Leetify ([Leetify](https://leetify.com/blog/faceit-browser-extensions/)). That works in 2026, but FACEIT has not sanctioned it.

This blocker matters less to your MVP than it first appears. **Live capture needs no FACEIT demo at all**: GSI runs inside CS2 itself and therefore works on FACEIT ([CounterStrike2GSI](https://github.com/antonpup/CounterStrike2GSI)). The scoreboard view comes from the Data API. The demo is needed only for full HLTV-style stats (ADR, KAST, trades, openers, clutches) and for clutch and wallbang labels on FACEIT clips. You can get it three ways, in order of preference:

1. **Approved Downloads API access** — apply on day one.
2. **An embedded WebView logged into the user's FACEIT account** that captures the presigned URL — unsanctioned.
3. **A watcher on the Downloads folder** for `*.dem.zst` after a one-click manual download.

Party detection needs a small workaround. FACEIT exposes only a team-level `premade` boolean, and no verified party field exists in Valve's GC or demo data. For your own group, combining your Steam friend list (`GetFriendList`, which returns 401 if the list is private) with "same team in this match" is reliable ([Valve Developer Community](https://developer.valvesoftware.com/wiki/Steam_Web_API)). The anti-cheat constraints are firm but easy to respect. CS2's Trusted Mode blocks injected capture hooks such as OBS Game Capture unless you launch with `-allow_third_party_software`, which community consensus says can lower Trust Factor ([OBS KB](https://obsproject.com/kb/capture-hook-certificate-update)). So the app must never inject into CS2, read its memory or draw an overlay.

## Live capture plus demo parsing is the right MVP highlight engine

You have four ways to produce the video. They trade off differently on the things you care about: exact 1080p60 of what you saw, zero hotkey presses, Premier and FACEIT parity, and friends' POVs.

| Dimension | Live capture (OBS via websocket + GSI) | Steam Game Recording + CS2 markers | Demo render on your PC (HLAE) | Demo render in the cloud |
|---|---|---|---|---|
| FPS cost while playing | ~3–6% (NVENC) | ~6% measured ([Thour](https://x.com/ThourCS2/status/1806271762025308253)) | 0 | 0 |
| Fidelity | Exact POV, your crosshair, voice/Discord | Exact POV, no Discord audio | Reconstructed POV; effects 1–2 frames late | Same as local render |
| Friends' or enemies' POV | No | No | Yes | Yes |
| Time to clips | Seconds | Seconds | ~5–15 min per match; CS2 must be closed | ~30 min queue (Allstar) |
| Fragility | Stable | Undocumented on-disk format | HLAE breaks on CS2 patches | Same, plus accounts and ToS |
| Cost | $0 | $0 | $0 | $0.006–0.03 per highlight-minute |

**OBS Studio over obs-websocket v5 is the only mainstream recorder with a documented programmatic save.** `SaveReplayBuffer` returns the saved file path through the `ReplayBufferSaved` event, and recording start and stop are scriptable ([obs-websocket protocol](https://raw.githubusercontent.com/obsproject/obs-websocket/master/docs/generated/protocol.md)). The official OBS build passes FACEIT AC from version 31.1 onward ([OBS KB](https://obsproject.com/kb/capture-hook-certificate-update)).

**Record the whole match rather than a rolling buffer.** A 40-minute match at 12–50 Mbps is 3.6–15 GB, deleted after cutting. A full recording lets you clip moments that you request after the match or that only the demo parse identifies. GSI drives start and stop automatically (`map.phase` live → gameover). It reports your round kills and headshots within about 0.1–0.2 s, but it exposes only the local player while you are playing. That makes **clutches undetectable live**, so they must come from the demo ([go-cs2-gsi](https://pkg.go.dev/github.com/nescabir/go-cs2-gsi/models)). One pitfall: once you die and spectate a teammate, the `player` block switches to them. Compare `player.steamid` with `provider.steamid` before counting kills.

**Demo rendering is the phase-2 complement, not the MVP core.** The open-source pipeline is proven. It parses the demo with demoparser2, plans sequences, launches CS2 under HLAE with `-insecure`, drives exact ticks through CS:DM's plugin, and pipes `mirv_streams` frames into FFmpeg. It renders roughly in real time: about 10 twenty-second clips take 10–15 minutes including boot ([cs2-highlights-maker](https://github.com/Rovniy/cs2-highlights-maker)). Quality is now good enough. Valve's November 2025 "TrueView" re-runs client prediction during playback ([HLTV](https://www.hltv.org/news/43122/valve-adjust-demo-playback-system-in-update)), and HLAE 2.192.2 fixed animation stutter in September 2026 ([HLAE](https://github.com/advancedfx/advancedfx/releases/tag/v2.192.2)).

The operational cost is high, though. HLAE shipped four releases between 23 and 26 September 2026 to keep up with CS2 patches ([HLAE releases](https://github.com/advancedfx/advancedfx/releases)), and Allstar's own clipping degraded for about 13 hours after the same update ([Allstar Status](https://status.allstar.gg/)). Rendering also cannot run while you play, because one Steam account runs one CS2 ([cs-demodesk](https://github.com/noih/cs-demodesk)). And Premier demos contain no voice at all ([ZeroUtil](https://zeroutil.com/blog/cs2-cant-hear-voice-demo/)). Its unique value is **friends' POVs and re-cams**, so add it once the core loop works.

**Detection should be rule-based, scored and merged:**

1. Take `player_death` events where the attacker is the user.
2. Group kills by round into "moments", merging gaps under about 20 s.
3. Tag 2K, 3K, 4K and ACE.
4. Tag clutches by tracking alive counts per team.
5. Add the CS2 event flags `headshot`, `penetrated`, `noscope`, `thrusmoke`, `attackerblind` and `attackerinair`.
6. Score each moment and keep the top N per match.

The MIT-referencing cs2-highlights-maker publishes usable weights: kill +1, headshot +0.2, 3K +2, 4K +4, ace +8, smoke kill +1.5, won 1vX +2 + 1.5·X, final round ×1.3, with 4 s pre-roll and 3 s post-roll ([scoring.py](https://raw.githubusercontent.com/Rovniy/cs2-highlights-maker/main/src/highlights/analysis/scoring.py)).

**Manual requests** use Win32 `RegisterHotKey` in the tray app (no hook into the game). It timestamps against the recording clock, so the cut is exact. Map the timestamp to a demo tick by anchoring on the round: `tick ≈ freeze_end_tick(r) + (t_press − t_live_start(r)) × 64`, with an estimated error of ±0.3 s against a 4 s pre-roll. After the match, a round timeline built from the demo lets you click any round or kill and cut it instantly. Allstar's `say !allstar` bind is a zero-install alternative that works with demo rendering, but it spams all-chat and only marks whole rounds ([Allstar](https://allstar.gg/!allstar)).

**Editing** is plain FFmpeg: trim, `xfade` transitions, optional `setpts` slow-motion on the final kill, and `drawtext` labels such as "3K · AK-47 · R14 · 1v2". Encode with NVENC at YouTube's recommended 12 Mbps for 1080p60 ([YouTube Help](https://support.google.com/youtube/answer/1722171)), about 90 MB per minute of reel.

## HLTV moved to Rating 3.0 in 2025, and only 1.0 is exactly reproducible

You believe the latest HLTV rating is 2.1. **That is no longer true.** The versions so far:

- **1.0 (2010).** The only fully published formula.
- **2.0 (June 2017).** Added KAST, ADR and Impact; formula private.
- **2.1 (14 October 2024).** Made the five sub-ratings equal-weight, removed KAST credit for saving in lost rounds, rewarded opening and "perfect" kills, and retuned averages for MR12 ([HLTV](https://www.hltv.org/news/40051/introducing-rating-21)).
- **3.0 (20 August 2025).** Applied retroactively to every CS2 match. It is "a version of rating 2.1 that is adjusted on economic factors supplemented by a brand new Round Swing metric" ([HLTV](https://www.hltv.org/news/42485/introducing-rating-30)).

HLTV re-weighted 3.0 on 29 October 2025 to Kills 25%, Damage 15%, Multi-kills 4%, Round Swing 33%, Survival 15% and KAST 8% ([HLTV](https://www.hltv.org/news/43047/rating-30-adjustments-go-live)). A small accuracy update around 1 October 2026 added map-specific averages and treats a round as decided once a planted bomb cannot be defused. That update is known only from a search snippet because the page is behind Cloudflare ([HLTV](https://www.hltv.org/news/45596/rating-30-receives-small-accuracy-improvements)). 2.1 no longer appears on HLTV's CS2 pages.

What you can actually implement differs sharply by version:

- **1.0, exactly:** `(KPR/0.679 + 0.7·SurvivalRate/0.317 + MultiKillScore/1.277) / 2.7`. cs-demo-analyzer implements it verbatim ([Sardegna](https://chrissardegna.com/blog/problems-with-csgo-rating-systems/); [player.go](https://raw.githubusercontent.com/akiver/cs-demo-analyzer/main/pkg/api/player.go)).
- **2.0, as the community regression:** `0.0073·KAST + 0.3591·KPR − 0.5329·DPR + 0.2372·Impact + 0.0032·ADR + 0.1587`, with `Impact ≈ 2.13·KPR + 0.42·APR − 0.41`. It reports R² = 0.995, but that was fitted on career aggregates. Single Premier maps will err more, and its Impact proxy ignores openers and clutches ([dave](https://dave.xn--tckwe/posts/reverse-engineering-hltv-rating/)). CS:DM and awpy both ship it ([awpy docs](https://awpy.readthedocs.io/en/latest/modules/stats.html)).
- **2.1: no public approximation exists.** CS:DM states there is "no plan to reverse-engineer it" ([CS:DM](https://cs-demo-manager.com/docs/guides/demos-analysis)). Scope.gg's "2.1" label is unverifiable.
- **3.0: only a "3.0-style" rating can be built**, not HLTV's number. HLTV published the T-side duel win-rate matrix by equipment value, the inputs to each sub-rating, a 5-second trade window and the 40-damage assist rule. It did **not** publish the win-probability model, the per-map averages or the scaling constants. So you would build your own round-win-probability model (Xenopoulos-style Win Probability Added, [arXiv](https://arxiv.org/pdf/2011.01324)), derive eco-adjusted kill points from HLTV's matrix, and combine the sub-ratings with the published weights.

**"HLTV" is a Better Collective brand** ([GlobeNewswire](https://www.globenewswire.com/news-release/2020/02/28/1992842/0/en/Better-Collective-acquires-leading-esports-platform-HLTV-org.html)). The defensible display is therefore:

- **"Rating 2.0 (est.)"** as the headline.
- **Rating 1.0** optionally alongside it.
- **A home-grown "Impact/Swing" metric** credited as "inspired by HLTV 3.0".
- **Never a bare "HLTV Rating 3.0"**, which would not match HLTV and implies endorsement.

All of these ratings are linear in per-round rates. Compute a day's or session's value from summed counts (kills, deaths, rounds, multi-kill rounds), not by averaging per-match ratings. In a 10-player lobby the ratings average about 1.0 by construction. They are good for comparing within the party but are not comparable with pro HLTV figures.

Everything on an **HLTV player profile is derivable from demos** except the pro-calibrated scaling:

- **Header (3.0 era):** Rating with T and CT splits, Round Swing, DPR, KAST, Multi-kill %, ADR and KPR, plus an eco-adjust toggle.
- **Seven 0–100 attributes:** Firepower, Entrying, Trading, Opening, Clutching, Sniping, Utility ([HLTV](https://www.hltv.org/news/39672/introducing-hltv-attributes)).
- **Classic table:** kills, HS%, deaths, K/D, ADR, grenade damage per round, assists, deaths per round, "saved by teammate" and "saved teammates" per round.
- **Individual page:** opening kill and death stats, plus weapon-class kill splits.

The attributes are scaled against "a top-tier professional player", so your version needs its own reference population. Use these definitions:

- **Trades:** 5-second window.
- **KAST:** two variants — classic, and 3.0-style where survival counts only in won rounds.
- **ADR:** health damage only.
- **Clutch:** last alive with X enemies remaining, won by any means, including a defuse or time running out.

## MIT-licensed open source already covers parsing, Steam access and rendering

Only about 20 relevant GitHub projects have 500 or more stars. The ones that matter are almost all MIT and were updated within the last month. A large share of the highest-starred "CS2" repositories are cheats, offset dumpers or anti-cheat bypasses, such as Osiris, cs2-dumper, Valthrun and the VAC-Bypass family. Exclude them all ([Osiris](https://github.com/danielkrupinski/Osiris)).

| Project (stars) | Licence | What to reuse |
|---|---|---|
| [akiver/cs-demo-manager](https://github.com/akiver/cs-demo-manager) (2,009) | MIT | Closest existing app: Valve GC downloads, analysis into Postgres, 2D viewer with voice, HLAE+FFmpeg video queue, CLI. No auto-highlight selection; FACEIT in-app download disabled |
| [markus-wa/demoinfocs-golang](https://github.com/markus-wa/demoinfocs-golang) (1,060) | MIT | Event-streaming Go parser, WASM build (powers browser 2D viewers) |
| [advancedfx/advancedfx](https://github.com/advancedfx/advancedfx) — HLAE (805) | MIT (not submodules) | Demo rendering via `mirv_streams`; breaks on CS2 patches; "technically a hack", `-insecure` only |
| [LaihoE/demoparser](https://github.com/LaihoE/demoparser) — demoparser2 (727) | MIT | Fastest parser; Rust core with Python/Node/WASM bindings; exposes Premier rank fields |
| [pnxenopoulos/awpy](https://github.com/pnxenopoulos/awpy) (617) | MIT | ADR, KAST, 2.0-style rating, grenade/smoke DataFrames, nav meshes |
| [SteamRE/SteamKit](https://github.com/SteamRE/SteamKit) (3,204) | LGPL-2.1 | .NET Steam/GC client |
| [DoctorMcKay/node-steam-user](https://github.com/DoctorMcKay/node-steam-user) (1,121) | MIT | Node Steam client; pair with node-globaloffensive (365, MIT) for `requestGame(shareCode)` |
| [SteamTracking/Protobufs](https://github.com/SteamTracking/Protobufs) (581) | Unlicense | Current CS2 GC protobufs |
| [obsproject/obs-studio](https://github.com/obsproject/obs-studio) (76,866) / [obs-websocket](https://github.com/obsproject/obs-websocket) (4,357) | GPL-2.0 | Live capture; drive it as a separate process to stay arm's-length |
| [FFmpeg](https://github.com/FFmpeg/FFmpeg) (64,691) | LGPL-2.1+ (GPL if optional parts are enabled) | Cutting, reels, NVENC encoding |
| [roflmuffin/CounterStrikeSharp](https://github.com/roflmuffin/CounterStrikeSharp) (1,365), [MatchZy](https://github.com/shobhit-pathak/MatchZy) (500) | GPL-3.0 with exception / MIT | Server-side only (practice/replay servers) |
| [ByMykel/CSGO-API](https://github.com/ByMykel/CSGO-API) (806) | MIT | Weapon and skin names and images for the UI |
| [DrEAmSs59/CS2-insight-agent](https://github.com/DrEAmSs59/CS2-insight-agent) (904) | PolyForm Noncommercial | Nearly your exact feature set (auto-classified highlights, OBS-driven demo recording, 2D, radar cards). **Design reference only** |

Several critical pieces sit below 500 stars. **demofile-net** (182, MIT) is the best C# parser and reads a full match in under a second ([demofile-net](https://github.com/saul/demofile-net)). **cs-demo-analyzer** (126, MIT) is CS:DM's Go analysis engine and handles both `faceit` and `valve` sources. **boiler-writter** (MIT) handles GC access, and **csgo-sharecode** (MIT) handles share codes. **sparkoo/csgo-2d-demo-viewer** (81, MIT) is a browser 2D player built on WASM ([sparkoo](https://github.com/sparkoo/csgo-2d-demo-viewer)). **osztenkurden/csgogsi** (MIT) types the GSI data.

Licences rule several others out for copying. Segra, an OBS-based CS2 auto-highlight recorder, is GPL-2.0. CounterStrike2GSI is GPL-3.0. demotracer and MulNX are AGPL-3.0, which would force you to publish your website's source. zenojunior/cs2d (an excellent smoke and flash analyser) and hkslover's highlight tool have no licence, so they are all-rights-reserved ([cs2d](https://github.com/zenojunior/cs2d); [Segra](https://github.com/Segergren/Segra)). Parsing will never be the bottleneck: demoparser2 handled 50 demos in 6.14 s on a 12-core desktop ([demoparser](https://github.com/LaihoE/demoparser)).

## Video, not stats, drives every cost curve

There are three deployment shapes:

- **Local-only.** Everything runs on each player's PC. Hosting costs $0. Disk runs about **11–20 GB per player per month** if clips are kept and raw demos deleted, plus 3.6–15 GB of transient full-match recording. Each friend installs the app to get their own POV. A Windows code-signing cert is optional for five friends; Azure Artifact Signing costs $9.99/month but only for US and Canadian individuals ([MS Learn](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart)), and OV certificates run about $219+/year.
- **Website-only, the Allstar model.** Servers parse and render everything. This needs a fleet of Steam bot accounts for the GC, paid FACEIT demo access, and Windows GPU hosts running CS2+HLAE, where each concurrent instance needs its own Steam login. It runs straight into the Steam Subscriber Agreement's "personal, non-commercial use" and anti-automation clauses ([Steam SSA](https://store.steampowered.com/subscriber_agreement/)). Allstar's arrangement with Valve, if any, is unknown.
- **Hybrid.** The PC captures, parses and renders. The cloud stores stats rows (kilobytes) and only the clips users choose to share, on zero-egress object storage. This is the cost-optimal path to a public product.

Unit economics decide the outcome. A 30-second 1080p60 clip at 12 Mbps is 45 MB. Serving 1,000 views costs about **$0 on Cloudflare R2** (no egress fees), **$0.45 on Bunny CDN**, **$0.50 on Mux or Cloudflare Stream**, and **$4.05 straight from S3** ([R2](https://developers.cloudflare.com/r2/pricing/); [Bunny](https://bunny.net/pricing/cdn/); [S3](https://aws.amazon.com/s3/pricing/)).

Demo parsing costs about $0.0003 per demo on Lambda ([Lambda](https://aws.amazon.com/lambda/pricing/)). Cloud rendering costs $0.0055–0.0297 per highlight-minute, from RunPod consumer GPUs up to AWS g5 Windows on-demand ([RunPod](https://www.runpod.io/pricing); [Vantage](https://instances.vantage.sh/aws/ec2/g5.xlarge)). Leetify's own history confirms that bandwidth, not CPU, dominates: moving to OVHcloud's unmetered bandwidth cut its costs about 50% ([OVHcloud](https://www.ovhcloud.com/en/case-studies/leetify/)).

The model below assumes 2 highlight-minutes per player-match. It also assumes 60 matches per month for the friend group and 30 per active user publicly. "Short retention" means auto-clips are kept 30 days at 6 Mbps AV1 and the 10% that users star are kept forever. "Keep all" means every clip is kept forever at 12 Mbps. All figures are month-12 run rates.

| Scale | Hybrid, short retention | Hybrid, keep all | Add if rendering in the cloud |
|---|---|---|---|
| You + 4 friends (≈600 highlight-min/mo) | ≈ $1–10/mo (fits R2 free tier early) | ≈ $5–25/mo | +$3–18/mo |
| 1,000 users (≈60,000 highlight-min/mo) | ≈ $160 (B2) – $210 (R2) /mo | ≈ $1,090/mo | +$330–1,800/mo |
| 50,000 users (≈3M highlight-min/mo) | ≈ $6,200 (B2) – $8,600 (R2) /mo | ≈ $52,800/mo | +$16,500–89,250/mo (~100 GPUs 24/7) |

The 50,000-user hybrid figure breaks down to about $4.5k clip storage, $0.9k for 30-day demos, $2.2k for 2D-replay tick data in Parquet, and roughly $1k for database, parsing and web. Retention policy and codec move the bill more than vendor choice. The one exception is S3 or GCS egress for video, which would be ruinous. These figures exclude FACEIT Downloads API fees, which are unpublished. A rough revenue check: 5% paid conversion at a Leetify-like $5.99 on 50,000 users yields about $15k/month. That covers hybrid with retention limits, but not cloud rendering of every match.

## Build a hybrid desktop app in three phases, separating blockers from work

**Recommended architecture.** Build a Windows tray app with an Electron or Tauri shell and a TypeScript/Node core. This matches CS:DM's MIT codebase and keeps the same parser (demoparser2 via its Node binding now, WASM later) usable on the future website. The app has the following parts:

1. **GSI listener** on 127.0.0.1. It detects match start and end, logs your kills and round anchors, and confirms that a FACEIT or Premier match happened.
2. **Official OBS, driven over obs-websocket.** It records each match with Window or Display Capture at about 20–25 Mbps NVENC.
3. **Global hotkey** for manual marks.
4. **Post-match job,** run once CS2 closes:
   - For Premier: share-code chain, then boiler-writter for the GC, then download from `replay*.valve.net`.
   - For FACEIT: Data API for the scoreboard, plus the demo via Downloads API, WebView session or a folder watcher.
5. **Parse and score:** demoparser2 parse, rating and stats computation, highlight scoring, and alignment to the recording via round anchors.
6. **FFmpeg cut and edit** into a 1080p60 per-match reel plus a per-session reel.
7. **Local Postgres or SQLite store** of matches, players, rounds and clips.

The data maps cleanly onto your UI:

- **Calendar dots** come from matches that have clips.
- **The per-day CS2-style match list** shows map, score, date and time, and result. The scoreboard shows K/A/D/MVP/score for all ten players, taken from the demo, the GC scoreboard or FACEIT's stats endpoint.
- **The default-open stats tab** aggregates the day's summed counts per party member, with members found via your Steam friend list plus same-team co-occurrence.
- **Sessions** are matches separated by less than some idle gap. Attribute them to their start date so a late-night session does not split across two calendar days.

| Phase | Scope | Blockers (need permission or are impossible) | Merely work |
|---|---|---|---|
| **1 — MVP** | Auto plus manual 1080p60 clips and reels for your POV; calendar, match history, day stats (1.0 exact, 2.0 est., ADR, KAST, K/D, HS%, openers, clutches) for you and party; Premier + FACEIT | **FACEIT demo files** (apply for the Downloads API on day one; ~30-day review; fall back to WebView session or manual download). Exact HLTV 2.1/3.0 is impossible (label honestly) | OBS orchestration, GSI server, hotkey, GC via boiler-writter, share-code chain, parser integration, scoring, alignment, FFmpeg templates, UI, 30-day ingest discipline |
| **2 — Leetify-like** | Last-30 profile, form trajectory, Aim/Utility ratings, 3.0-style swing, same-skill comparison, 2D viewer, smoke/utility analyser, all HLTV profile stats, HLAE renders of friends' POVs | None technical. Same-skill comparison needs a population: each of your demos holds 9 other players at roughly your rank, which yields a growing local reference set. HLAE downtime after CS2 patches is an operational risk | Win-probability model, eco-adjusted kill points from HLTV's matrix, aim metrics from tick data, 2D viewer (fork sparkoo or CS:DM, both MIT), grenade trajectories, HLAE version pinning |
| **3 — Public website** | Steam OpenID + FACEIT OAuth login, shared clips, profiles, leaderboards | **Paid FACEIT demo access at scale** (top business risk); **Steam bot fleet on an undocumented GC protocol** that Valve can cut off "at any time" ([ToU](https://steamcommunity.com/dev/apiterms)); **Steam SSA exposure if you render in the cloud**; HLTV trademark; privacy rules (no indexing of non-users, since Valve encrypted demo chat after cstracker.gg exposed chat logs in Aug–Sep 2026 ([Dexerto](https://www.dexerto.com/counter-strike-2/cs2-players-in-game-chat-logs-are-now-being-exposed-publicly-3403361/); [timesaver.gg](https://timesaver.gg/news/cs2-update-demo-chat-encryption-cache-fixes))) | Hybrid upload to R2/B2, server-side re-parse for tamper-proof leaderboards (≤ $400/mo at 50k users), 100k/day Web API budgeting with event-driven polling, privacy policy listing storage countries |

Some things are constraints rather than blockers. History older than the first share code you enter cannot be backfilled, demos vanish after about 30 days, Casual and Deathmatch matches are invisible to the API, and Premier demos carry no voice. All of these argue for ingesting immediately after each session and for keeping live capture as the primary video source.

## Conclusion

The pivotal design insight is to **split video from data**. Most incumbents produce the video from the demo itself, either by rendering in the cloud like Allstar or with HLAE like CS:DM. That ties clip quality, latency and FACEIT coverage to the hardest dependencies in the ecosystem: FACEIT's paywalled demo files, Valve's undocumented Game Coordinator, and an HLAE hook that breaks with every patch. Record what you saw locally and use demos only to label it and compute stats. Then the FACEIT blocker shrinks from "no FACEIT highlights" to "FACEIT stats arrive by a slower or semi-manual path", and the 30-day demo window stops threatening the videos. The same split defines the business: your users' GPUs do the expensive rendering for free, and the cloud only handles kilobyte-sized stats plus opt-in clips on zero-egress storage.

The "better Leetify" ambition is technically within reach, because every metric Leetify and HLTV show can be computed from parsed demos with MIT-licensed tools. What cannot be built is an exact copy of their proprietary numbers. The opening is therefore transparency rather than replication: an honestly labelled 2.0 estimate beside an explainable round-swing metric, benchmarked against the very lobbies your group plays in. Treat FACEIT as a partner to negotiate with early rather than an API to scrape, because Leetify's 2024 retreat shows that FACEIT access, not engineering, sets the ceiling on going public.
