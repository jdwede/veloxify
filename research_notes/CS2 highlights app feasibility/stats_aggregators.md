# CS2 Stats & Analytics Aggregators: Competitive Landscape (as of 2 Oct 2026)

Scope: stats/analytics services only (Leetify, csstats.gg, Scope.gg, Refrag, FACEIT, ESEA, Tracker.gg, plus 2025–2026 entrants). Clip-only services (Allstar etc.) are covered elsewhere and only mentioned in passing. Dates in brackets are publication dates of the cited source. Anything CS:GO-era or pre-2025 is labelled. Several primary pages (leetify.com/pricing and /faq, csstats.gg, FACEIT support centre, scope.gg/pricing, tracker.gg/cs2/app) returned 403/404 or rendered no content to the fetcher. Facts that depend on them come from secondary sources and are flagged.

---

## Q1. How does each service get match data, how fast does it appear, and is it parsed server-side?

### Takeaway
Nearly every Valve-matchmaking tracker uses the same Valve pipeline. The user gives a one-time Steam "game authentication code" plus their latest match share code. The service then polls `ICSGOPlayers_730/GetNextMatchSharingCode` and fetches the demo through the Game Coordinator, then parses it server-side. FACEIT is the outlier. Since February 2024 FACEIT demo downloads go through a gated, paid/limited Downloads API. Leetify lost automatic FACEIT import and now depends on browser extensions and a public "submit presigned URL" endpoint. FACEIT now offers its own in-house analysis (Match Insights, Premium only, April 2026).

### Cited Findings

**Valve pipeline (applies to Leetify, csstats.gg, Scope.gg, Tracker.gg, Refrag)**
- The Steam Web API endpoint is `GET api.steampowered.com/ICSGOPlayers_730/GetNextMatchSharingCode/v001/` with params `steamid`, `steamidkey` (the user's auth code) and `knowncode` (last known share code). It returns the next newer share code, or "n/a" if there isn't one. — [SteamTracking ICSGOPlayers_730.json](https://github.com/SteamTracking/SteamTracking/blob/master/API/ICSGOPlayers_730.json); [go-steamapi csgo package](https://pkg.go.dev/github.com/an0nfunc/go-steamapi/csgo)
- Leetify [Jan 9, 2024] describes the share code as a 24-character code that lets it download the demo and find future ones. The Authentication Code "tells Valve that you've given Leetify permission to request your demos using share codes". Share codes "do not allow Leetify to find older matches", only newer ones. The auth code is entered once during the "Connect Steam Account" onboarding step. — [Leetify: What are Share Codes?](https://leetify.com/blog/share-codes/)
- A share code / demo link expires 30 days after the match ends. If your newest code is older than 30 days, you must give a fresh one. — [Leetify: Share Codes](https://leetify.com/blog/share-codes/); CS Demo Manager says the same: "The demo's download link for a match expires 1 month after the match ends." — [CS Demo Manager docs](https://cs-demo-manager.com/docs/guides/downloads)
- The demo URL itself comes from the Steam Game Coordinator. CS Demo Manager "communicates with the Steam Game Coordinator to retrieve the recent matches" and briefly launches CS2 in the background to do it. "Only the last 8 matches are available because the Steam Game Coordinator only provides this data." — [CS Demo Manager docs](https://cs-demo-manager.com/docs/guides/downloads)
- csstats.gg "automatically tracks your CS2 stats, matches and rank after you login with Steam and add your game authentication code". Users can also paste a single share code into the search bar to add one match. — [csstats.gg sharecode guide](https://csstats.gg/getting-the-sharecode); [csstats.gg homepage via search snippet](https://csstats.gg/)
- Scope.gg [Sep 28, 2023]: "Autoupload" needs the "Recently Completed Match Token" and "Authentication Code" from Steam, with match notifications via its Steam bot. Login is via Steam or FACEIT account. — [SCOPE.GG blog: CS2 support](https://blog.scope.gg/scopegg-cs2-en/)
- Tracker.gg [Nov 20, 2023]: users log in with Steam and enter "your Game Authentication Code and most recent Match Token". The site "analyzes match replays". Valve disabled match replays from Sep 28 to Nov 11, 2023, so that period can't be backfilled. — [Tracker.gg: CS2 Stats Tracker Now Live](https://tracker.gg/cs2/articles/cs2-stats-tracker-now-live)
- Refrag [Jul 20, 2026]: "Refrag Coach, included with every subscription, automatically pulls in your FACEIT and Premier match history." The 2D viewer "automatically parses demos from your match history". Import is via Steam authentication. — [Refrag tool comparison blog](https://refrag.gg/blog/cs2-training-tool-comparison/); [Refrag: view demos online, Apr 5 2025](https://refrag.gg/blog/how-to-view-cs2-demos-online/)
- CS2-launch history (2023, now outdated): Valve had CSTV demo recording disabled at CS2 launch, so Leetify temporarily accepted user-recorded POV demos (about 80% of analysis possible, frequent client crashes, unreliable utility data). Valve re-enabled CSTV in November 2023. — [Leetify: CS2 POV Demos, Nov 8 2023](https://leetify.com/blog/cs2-pov-demos/)

**FACEIT pipeline**
- FACEIT Data API endpoints include `GET /matches/{match_id}/stats` (per-match player/team stats), `GET /players/{player_id}/matches` / history, and player aggregate stats. Auth is an API key, rate limiting returns 429, and match objects include `demo_url` arrays. — [FACEIT Data API docs](https://docs.faceit.com/docs/data-api/data/)
- Demo files need the separate **Downloads API**. You apply via a form (fce.gg/downloads-api-application, "expected response time of 30 days") and get an "exclusive Access Token that has a Downloads API scope". The flow is: get a resource URL from the Data API, then `POST /download/v2/demos/download`, then receive a signed URL. A "Match Demo Ready" webhook is available. — [FACEIT Downloads API guide](https://docs.faceit.com/getting-started/Guides/download-api)
- FACEIT moved demo downloads to a paid model in mid-February 2024 with days of notice. Leetify estimated about **€270,000/year**, which it said would double its infrastructure costs, and halted new FACEIT imports [Mar 11, 2024]. — [Leetify: FACEIT changes](https://leetify.com/blog/faceit-changes/); FACEIT's statement said access would be offered "at-cost depending upon their usage and needs". — [Dust2.us](https://www.dust2.us/news/45779/update-leetify-halts-processing-faceit-demos-due-to-expensive-api-changes)
- Leetify [Aug 4, 2025] published a public endpoint, `POST https://api.cs-prod.leetify.com/api/faceit-demos/submit-demo-download-url`. It accepts a presigned FACEIT S3 demo URL and returns a Leetify match ID. It returns 429 when rate-limited ("wait 300 seconds") and 422 for malformed requests. Leetify said there was no native FACEIT push; it is intended for "desktop apps, browser extensions, or anything else". — [Leetify: FACEIT Demo Upload API](https://leetify.com/blog/faceit-demo-upload-api/)
- Leetify's FACEIT browser-extension page [Jul 11, 2024, updated to Jul 2026] says "FACEIT imposed a limit on the number of demos we can download". It lists three community extensions: CSNades.gg "FACEIT to Leetify Demo Uploader", FACEIT Vision, and "Auto Leetify Faceit Match Importer". — [Leetify: FACEIT browser extensions](https://leetify.com/blog/faceit-browser-extensions/)
- "Auto Leetify Faceit Match Importer" checks for new matches every hour and imports up to 100 matches from the last 30 days. Chrome v1.2.1 was updated Aug 27, 2026 and Firefox v1.2.2 on Sep 14, 2026. — [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/leetify-faceit-match-importer/); [Chrome Web Store](https://chromewebstore.google.com/detail/auto-leetify-faceit-match/iedkpgglpddhgnijgcngnfhpomoogkfp)
- CS Demo Manager (open-source desktop tool) says FACEIT "restricted demo downloads to a private API and provided us a server-side API key with the maximum rate limit". In-app FACEIT downloads are currently "temporarily unavailable", so users must download from the FACEIT website. — [CS Demo Manager docs](https://cs-demo-manager.com/docs/guides/downloads)

**Other platforms**
- Leetify auto-imports **Esplay** matches (Swedish ID-verified matchmaking) if the same SteamID is used [Oct 20, 2025]. — [Leetify: Esplay](https://leetify.com/blog/esplay/)
- Leetify and DatHost launched **Renown**, an invite-only matchmaking platform [Feb 27, 2025]. Invite eligibility uses match history verified through Leetify. — [Dust2.us](https://www.dust2.us/news/58527/leetify-and-dathost-announce-new-matchmaking-platform-renown)

**Latency**
- Leetify [Feb 9, 2026 postmortem]: between Jan 26 and Feb 5, 2026 three "catastrophic" infrastructure issues made the site unreachable or interrupted match processing. Reports arrived "hours after gameplay". The cause was growth: it now imports "thousands of matches per hour". — [Leetify: January infrastructure postmortem](https://leetify.com/blog/january-infrastructure-issues-postmortem/)
- Free Pro via clan tag (2022–2023 thread, possibly outdated): users waited 12+ hours for credits to appear. — [Leetify Steam group](https://steamcommunity.com/groups/Leetify/discussions/0/6126615404782525810/)
- Noesis processes an uploaded demo in about 30 seconds in the browser. — [Noesis](https://www.noesis.gg/)
- FACEIT Match Insights needs no demo download; analysis appears automatically on the match page. — [hawk.live, Apr 2026](https://hawk.live/posts/faceit-announced-new-auto-match-analysis-feature-for-cs2)

### Inferences
- Every Valve-MM tracker shares the same limits: one-time auth code, share-code chaining (forward-only, so no backfill of history older than the first code), a 30-day demo window, and Steam/GC-based demo URL resolution (in practice a fleet of Steam bot accounts). A new entrant has no structural data advantage on Valve matches. Differentiation has to come from UX, latency and analysis.
- Latency for Valve MM is bounded by (a) when Valve's API yields the next share code, (b) demo availability on Valve's replay servers, and (c) the service's parse queue. A local Windows app that grabs the demo or GSI data right after the match could beat server-side trackers. That fits the user's Phase-1 "session/party" idea.
- FACEIT is the biggest moat and pain point. Server-side bulk FACEIT demo access is gated and costly. Leetify's workaround (client-side extension fetches the presigned URL with the user's own FACEIT session, then posts it to the service) is the proven pattern. A desktop app could do the same natively.

### Gaps
- No official, published figure for typical "match ends → stats visible" latency for Leetify, csstats.gg, Scope.gg or Tracker.gg in 2026.
- Could not confirm from a Valve primary source which modes produce share codes (Premier / Competitive / Wingman). Third parties say Premier, Competitive and Wingman. Valve's developer wiki page returned 403.
- Did not confirm whether csstats.gg, Scope.gg or Tracker.gg currently auto-import FACEIT matches in 2026. Secondary listicles claim "FACEIT integration" but give no mechanism.
- FACEIT's actual Downloads API pricing and rate limits are not published.

---

## Q2. Leetify deep-dive: features, ratings, Pro paywall, price, and 2025–2026 changes

### Takeaway
Leetify is the category leader. Its features include a proprietary, zero-centred Leetify Rating based on win-probability change, 0–100 Aim and Utility ratings, positioning/opening/clutch stats, last-30-match profiles benchmarked by rank, and round-by-round rating breakdowns. Pro adds the 2D replay, rank-benchmark switching, FACEIT/MM filtering, highlights, and training servers (SCL partnership). In 2025–2026 it added a public API (then restricted it), Esplay import, the Renown matchmaking venture, a reworked Utility Rating, an in-house highlight pipeline replacing Allstar, and a profile redesign. The current standalone Pro price could not be confirmed from a primary source.

### Cited Findings

**Leetify Rating (headline proprietary metric)**
- The rating is centred on zero and based on change in round win probability. Kills are rewarded by "how much a kill improves their team's chances of winning in the current round". Credit split per kill: 35% killer, 30% all damagers, 15% flash assister, 20% to the player whose death was traded (rescaled if any are absent). It is zero-sum per match. — [Leetify Rating explained, Nov 25 2024](https://leetify.com/blog/leetify-rating-explained/)
- Economy uses four equipment groups (different T/CT thresholds) with historical CS2 base win odds. Bands: Great > +5.12, Good +2.09 to +5.12, Average ±2.09, Subpar −2.09 to −5.12, Poor < −5.12. — [Leetify Rating explained](https://leetify.com/blog/leetify-rating-explained/)
- CS2 recalibration [Nov 25, 2024]: recalibrated on CS2 pro data, with less credit for T-side lurkers/AWPers and slight boosts for CT anchors/rotators. Thresholds changed: Good from +3.31 to +2.09, Great from +8.10 to +5.12. Its stated aim was the long-standing critique that "passive players (or more harshly called baiters) are rewarded too much". — [Leetify Rating updated for CS2](https://leetify.com/blog/leetify-rating-update/)
- Clutch change [Feb 25, 2026]: 1v1 clutch reward cut about 5% after feedback that "it only cares about whether you win your clutches". A fix stopped Ts being punished for post-plant deaths when the bomb still won the round (one user saw a +2.65 swing). — [Leetify Rating clutch update](https://leetify.com/blog/leetify-rating-update-2026-02-25/)
- The Rating Breakdown tab shows each round's contribution as a percent change in win probability; for example, +34.90 means a 34.9% win-probability increase. Hovering shows the category gained or lost, and these sum into a "Rating Gained & Lost" box. — [Leetify: Rating Breakdown tab (search snippet)](https://leetify.com/blog/rating-breakdown/)

**Sub-ratings and skill-level comparison**
- Utility Rating rework [Oct 24, 2025]:
  - **Quantity**: grenades per round (excluding decoys) against an expected 3/round, scaled x^(2/3), capped at 100.
  - **Quality**: z-scores of Flash Assists %, Enemies Flashed/flash, Friends Flashed/flash, Avg Blind Time/flash, Avg HE dmg/HE and Avg HE team dmg/HE, through a weighted normal CDF.
  - **Final score**: the geometric mean of the two.
  - **Benchmarks rose**: HLTV pros from 58 to 70, FACEIT Level 10 from 39 to 65.
  — [Leetify: Utility Ratings](https://leetify.com/blog/utility-ratings/)
- "Aim and Utility Benchmarks Recalculated" [Aug 1, 2025] and "Aim Stat Hitboxes Improved" [Aug 11, 2026] show ongoing benchmark/aim-model maintenance. — [Leetify blog index](https://leetify.com/blog/)
- Profile redesign [Aug 17, 2026]:
  - Stats cover the "last 30 matches": aim rating, utility, positioning, opening kills, clutch, pre-aim, reaction time.
  - A new "Top Stats" section highlights stats that exceed rank expectations.
  - Tabs: match history, rank progression, teammates, maps.
  - **Free** users see stats benchmarked against their current rank. **Pro** users can switch the benchmark to any rank and filter by data source (FACEIT vs Valve MM).
  — [Leetify: Profiles Update](https://leetify.com/blog/profiles-update/)
- Other features from the blog index:
  - "Post-Match Journal" for warm-up impact analysis [Mar 19, 2025].
  - Pro-player crosshair database [Jun 10, 2025].
  - New Home page [Jan 2025].
  - League of Legends expansion [Jan 2025] and LoL Leetify Rating beta [May 13, 2025].
  - Steam-profile stats via browser extension [Aug 28, 2026].
  — [Leetify blog index](https://leetify.com/blog/)

**Pro / paywall contents**
- Leetify Pro includes "Training & Warmup Servers, PLUS Highlights, 2D Replay, pro player stats benchmarks, and all other Leetify Pro benefits". From Mar 26, 2026 it also includes SCL Individual Tier benefits (warmup, 9 guided aim/utility modes, retakes, practice servers, scrim servers with coach slot) at no extra cost. — [Leetify: SCL Training Collab](https://leetify.com/blog/scl-training-collab/)
- "2D Replay is only available to Leetify Pro users." — [Leetify Rating Breakdown (search snippet)](https://leetify.com/blog/rating-breakdown/)
- Pro gets on average about 1 highlight clip per CS2 match played. — [Leetify: "Get Leetify" Highlight Rewards, Feb 25 2026 (search snippet)](https://leetify.com/blog/get-leetify-highlight-rewards/)
- A separate **Highlights+** subscription tier exists. On Jul 30, 2026 Leetify switched its highlight generation from Allstar to an in-house provider with Leetify branding and a highlights gallery (beta). Highlights+ stays on Allstar "for at least a few more weeks". — [Leetify: Highlights Provider Change](https://leetify.com/blog/highlights-provider-change/)
- Manual demo upload was Pro-only at the time FACEIT import was halted (Mar 2024). — [Leetify: FACEIT changes](https://leetify.com/blog/faceit-changes/). The Aug 2025 FACEIT upload API post doesn't say whether it is Pro-gated. — [Leetify: FACEIT Demo Upload API](https://leetify.com/blog/faceit-demo-upload-api/)
- Ways to earn free Pro (2022–2024 era, may be outdated): 1 day of Pro per day played with the "Leetify" clan tag (ranked matches only), and 14 days for referrer and referee. — [Leetify Steam group thread](https://steamcommunity.com/groups/Leetify/discussions/0/6126615404782525810/); [Steam CS2 discussion](https://steamcommunity.com/app/730/discussions/0/4841941418351076219/)

**Price (unresolved, conflicting)**
- Pro was **$5.99/month**, with "Founders Edition" at **$199.99/year** [Profilerr, Jul 9 2024; pre-2025]. — [Profilerr](https://profilerr.net/top-7-best-csgo-stat-trackers-to-use/)
- Renown costs $4.99/month, or **$8.99/month bundled with Leetify Pro** [Feb 27, 2025]. — [Dust2.us](https://www.dust2.us/news/58527/leetify-and-dathost-announce-new-matchmaking-platform-renown)
- A third-party guide claims Pro is "approximately $10 USD/month (2025 pricing)" (page "last verified" Jul 16, 2026). It is low reliability: the same page wrongly says FACEIT import is "automatic". — [thegamercodex](https://thegamercodex.com/en/counter-strike-2/tools/leetify)

**API and privacy (relevant to a competitor that might build on Leetify data)**
- A public API launched Jul 20, 2025 (docs at api-public-docs.cs-prod.leetify.com). Guidelines require "Data Provided by Leetify" attribution. Third parties may not rename, rescale or recalculate metrics, may not store API data ("rely on live requests"), and may not imply endorsement. — [Leetify API Developer Guidelines](https://leetify.com/blog/leetify-api-developer-guidelines/)
- From Jan 23, 2026 the Public API returns data "only for users registered to Leetify" and no longer covers non-users in a match. Users can hide their profile, which deletes their Leetify account. — [Leetify: Privacy updates](https://leetify.com/blog/privacy-updates-to-our-api-and-profiles/)

**Scale / company**
- CS:GO-era case study (~2022): 200,000 monthly users, more than 2 million matches/month processed, 70–140 TB of data/month, about 50% infra cost cut after moving to OVHcloud. CTO and co-founder is Vitalii Zurian. — [OVHcloud case study](https://www.ovhcloud.com/en/case-studies/leetify/)
- 2026: "thousands of matches per hour" and strong growth. — [Leetify postmortem, Feb 9 2026](https://leetify.com/blog/january-infrastructure-issues-postmortem/)

### Inferences
- The paywall pattern is: core stats and ratings free, while "drill-down" tools (2D replay, cross-rank benchmarking, data-source filtering, highlights volume, training servers) are paid. A "better Leetify" could win attention by giving away what Leetify charges for, especially 2D replay and peer-rank comparison.
- The 2026 changes (outages, clutch-weight tweak, Allstar replacement, API lock-down) suggest Leetify is consolidating: owning highlights in-house and protecting its data from third-party aggregators. The API's no-storage, no-recalculation rules make it unsuitable as a backend for a competitor's ratings.
- Leetify has to keep re-tuning its rating, and the community keeps complaining. That is evidence that win-probability ratings are hard to explain. A competitor showing a transparent HLTV-style rating next to an impact metric could address this.

### Gaps
- **Current (Oct 2026) Leetify Pro and Highlights+ prices are not confirmed from a primary source.** The pricing page renders client-side and returned no content.
- No official current user count. The 200k MAU figure is CS:GO-era. No funding information was found.
- Sub-rating formulas for Aim, Positioning, Opening and Clutch were not documented in fetched sources (only Utility and overall Rating were).
- Unclear whether Leetify has its own official FACEIT extension. The extension page mentions one but the fetch summary was ambiguous.

---

## Q3. Which services show an HLTV rating vs a proprietary rating?

### Takeaway
Scope.gg advertises HLTV Rating 2.1. csstats.gg shows a value labelled "HLTV Rating", but which version could not be confirmed from a primary source. Leetify uses only its proprietary Leetify Rating. No tracker was found implementing HLTV Rating 3.0, HLTV's new eco-adjusted model with Round Swing.

### Cited Findings
- Scope.gg lists "ADR, HLTV Rating 2.1, K/D ratios, and KPR" among match stats. — [SCOPE.GG homepage](https://scope.gg/)
- csstats.gg's displayed RATING "is the HLTV rating (higher is better)". Aggregated career stats include K/D, HLTV Rating, ADR, HS%. — [csstats.gg glossary (search snippet)](https://csst.at/blog/glossary-csstatsgg); the glossary page itself returned 403. Another source says "CSStats shows your entry frags and calculated HLTV rating". — [theglobalgaming via search snippet](https://theglobalgaming.com/cs/best-stats-tracker)
- HLTV Rating history:
  - **1.0 (2010)**: KPR, DPR, multi-kill Impact.
  - **2.0 (June 6, 2017)**: added ADR, KAST and an updated Impact (multi-kills, opening kills, 1vX). The exact formula is not public; it was approximated by reverse engineering.
  — [counterstrikestats.com via search snippet](https://counterstrikestats.com/guides/hltv-rating-explained/); [HLTV: Introducing Rating 2.0](https://www.hltv.org/news/20695/introducing-rating-20)
- **Rating 3.0**: "a version of rating 2.1 that is adjusted on economic factors supplemented by a brand new Round Swing metric". Sub-ratings are Kills, Damage, Survival, KAST, Multi-Kills, Round Swing. It has since received adjustments. — [HLTV: Introducing Rating 3.0](https://www.hltv.org/news/42485/introducing-rating-30); [HLTV: Rating 3.0 adjustments](https://www.hltv.org/news/43047/rating-30-adjustments-go-live)
- Leetify uses its proprietary zero-centred rating (see Q2). A search-indexed user comment said "it would be awesome to have rating 3.0 in Leetify", suggesting it is not offered. — [search result summary](https://www.hltv.org/news/42485/introducing-rating-30)
- Tracker.gg shows "rating/rank tracking". Its own rating type was not confirmed (listicles call it proprietary). — [Tracker.gg launch post](https://tracker.gg/cs2/articles/cs2-stats-tracker-now-live)
- Free CSRun-style aggregators show Leetify ratings pulled from the Leetify API rather than computing their own. — [CSRun](https://csrun.win/)

### Inferences
- HLTV 3.0 is not public, and the Round Swing component needs a win-probability model, so trackers are likely stuck on approximations of 2.0/2.1. A new app could ship a documented "HLTV 2.0-approximation" (well-known reverse-engineered formula) plus its own win-probability impact metric. Labelling it honestly matters, since HLTV owns the brand.
- The user wants "HLTV-style stats" for the MVP. That is table stakes (csstats.gg and Scope.gg have it free), so it is not a differentiator on its own.

### Gaps
- csstats.gg's exact rating version (1.0 vs 2.0-approximation) is unconfirmed (site blocks fetch).
- No source found on whether any tracker has adopted or approximated Rating 3.0 as of Oct 2026.
- FACEIT's own match-room rating/stat fields: one snippet mentioned "Rating 2.0" among FACEIT-derived stats, but it was ambiguous and not verified from FACEIT docs.

---

## Q4. 2D replay, utility/smoke analysis, heatmaps, lineups, round-by-round: who offers what, browser vs desktop?

### Takeaway
2D replay is now commodity. It is in Leetify (Pro), Scope.gg (free in 2023), Refrag (Competitor tier), FACEIT Match Insights (Premium), Noesis, Skybox EDGE (pro teams), and several free viewers. Almost all run in the browser. Desktop software is mainly used for clip recording (Scope.gg) and in-match overlays (Tracker.gg).

### Cited Findings
- **Leetify**: browser 2D Replay (Pro-only) and per-round Rating Breakdown. — [Leetify Rating Breakdown (snippet)](https://leetify.com/blog/rating-breakdown/); [SCL collab post](https://leetify.com/blog/scl-training-collab/)
- **Scope.gg**:
  - 2D replay, browser-based. In 2023 it was "available for free".
  - Stats on clutches, economy, heat maps, first duels and aim, plus grenade setups, mistake identification, a 30-match progress view (15 previous vs 15 current) and a strategy board.
  - Auto-recorded highlight clips.
  — [SCOPE.GG CS2 blog, Sep 2023](https://blog.scope.gg/scopegg-cs2-en/); [SCOPE.GG homepage](https://scope.gg/)
- **Refrag**:
  - 2D demo viewer (Competitor tier and above) with utility spread and timers, annotations and keybinds.
  - Utility Hub and the "NADR" grenade system with "hundreds of pre-loaded grenades".
  - Restrat (strategy review), Academy.
  - In-game training mods run on Refrag's own high-tickrate servers.
  — [Refrag homepage](https://refrag.gg/); [Refrag comparison blog, Jul 2026](https://refrag.gg/blog/cs2-training-tool-comparison/); [Refrag demo blog, Apr 2025](https://refrag.gg/blog/how-to-view-cs2-demos-online/)
- **FACEIT Match Insights** (launched Apr 22, 2026 with Season 8, Premium only): 2D map visualisation of the whole match, round-by-round graphs, trades and entries, highlight moments, missed grenades, repeated mistakes. No demo download needed. — [hawk.live](https://hawk.live/posts/faceit-announced-new-auto-match-analysis-feature-for-cs2); [FACEIT Season 8 Match Insights FAQ (title only; page 403)](https://support.faceit.com/hc/en-us/articles/26679388937500-FACEIT-Season-8-Match-Insights-Premium-FAQ)
- **Noesis** (browser): 2D replay, round filtering (buy/eco, side), multi-round heatmaps, utility analysis, cross-match comparison. Uses upload. Testimonials from G2, Endpoint and Renegades analysts. — [Noesis](https://www.noesis.gg/)
- **Skybox EDGE** (pro/team-focused): advanced 2D replayer, team stats, voice comm integration, role-detection AI, and (top tier) tactic-spotter AI "Playbook", tactic filters, match reports. It claims "85%+ of Pro teams" use it. — [Skybox pricing](https://skybox.gg/pricing/); [Skybox EDGE](https://skybox.gg/edge/)
- **Tracker.gg**: website plus a Windows "CS2 Tracker App". It shows FACEIT levels and ranks of players in the current match for Premier, Competitive and Wingman. — [Tracker.gg CS2 (search snippet)](https://tracker.gg/cs2); [Tracker.gg app page (title only; 403)](https://tracker.gg/cs2/app)
- **csstats.gg**: a round-by-round breakdown of how each round was won, clutches and full kill feeds; full match history (vs in-game last 8); VAC/Overwatch ban tracking for "played with" players. No 2D replay was found. — [csstats.gg homepage (search snippet)](https://csstats.gg/)
- Free/other browser viewers in 2025–2026 search results: Recoil Analytics demo viewer, cs2.cam, cs2replays.com. — [recoilanalytics.com](https://recoilanalytics.com/demo-viewer); [cs2.cam](https://cs2.cam/); [cs2replays.com](https://cs2replays.com/)

### Inferences
- 2D replay and basic heatmaps are expected, not differentiators. Under-served areas include:
  - party/session-level views across friends;
  - fast post-match (minutes) availability that covers FACEIT and Premier together;
  - clips tied to stats moments (as Leetify is now trying with its in-house highlights).
- A Windows desktop app is unusual among stats tools. Only Scope.gg (recorder) and Tracker.gg (overlay) ship desktop clients. That is an opening for local demo capture/parse with no server dependency for the user's own matches.

### Gaps
- Could not confirm whether Scope.gg's 2D replay is still free in 2026.
- No primary source on whether csstats.gg added any 2D/heatmap features in 2025–2026.

---

## Q5. Business model, pricing, user counts, funding

### Takeaway
Consumer pricing clusters at about $4–15/month. Examples: Tracker.gg ~$4, Scope.gg $5–8, Leetify Pro historically $5.99 (bundle $8.99 with Renown), Refrag $7–15, FACEIT Premium $10.99. csstats.gg is free and ad-supported (owned by ESL FACEIT Group). Pro-team tools are far pricier: Skybox EDGE €350–1,299/month. Hard user numbers are scarce.

### Cited Findings

| Service | Free tier | Paid tiers (USD unless noted) | Users / scale | Source |
|---|---|---|---|---|
| Leetify | Yes (core stats, ratings, rank benchmarks) | Pro $5.99/mo; Founders $199.99/yr (Jul 2024, may be outdated). Renown $4.99/mo or $8.99/mo bundled with Pro (Feb 2025). Highlights+ tier exists (price unknown) | ~200k MAU, >2M matches/mo (CS:GO-era ~2022); "thousands of matches per hour" (2026) | [Profilerr](https://profilerr.net/top-7-best-csgo-stat-trackers-to-use/); [Dust2.us](https://www.dust2.us/news/58527/leetify-and-dathost-announce-new-matchmaking-platform-renown); [OVHcloud](https://www.ovhcloud.com/en/case-studies/leetify/); [Leetify postmortem](https://leetify.com/blog/january-infrastructure-issues-postmortem/) |
| csstats.gg | Fully free | None found | "millions of CS2 games per month" (Aug 2023) | [Profilerr](https://profilerr.net/top-7-best-csgo-stat-trackers-to-use/); [csstats Steam group](https://steamcommunity.com/groups/csstats-gg/announcements/listing) |
| Scope.gg | Yes (free highlights very limited: 1 per 7 days) | Scope Lens $5/mo; Scope Prematch $8/mo (2024) | "2 million registered users"; homepage also says "10,000 players monthly active" (ambiguous) | [Profilerr](https://profilerr.net/top-7-best-csgo-stat-trackers-to-use/); [esports.gg snippet](https://esports.gg/news/counter-strike-2/scope-gg-review/); [SCOPE.GG](https://scope.gg/) |
| Refrag | No (subscription) | Player $7/mo ($5.40 annual); Competitor $15/mo ($11.50 annual); Team $79/mo ($60–61 annual, up to 7 players) | "Over 550,000 users" | [Refrag](https://refrag.gg/); [Refrag blog Jul 2026](https://refrag.gg/blog/cs2-training-tool-comparison/) |
| FACEIT | Free (Elo MM, levels, match history) | Plus $6.99/mo or $49.99/yr; Premium $10.99/mo or $95.99/yr (regional pricing). Match Insights is Premium | EFG claimed "22 million serious players" at CS2 launch (2023; not updated) | [shattered.io, Jun 2026](https://shattered.io/cs2-premier-rank-vs-faceit-level/) |
| Tracker.gg | Free, ad-supported | $3.99/mo at CS2 launch (ad removal); TRN Premium $4/mo or $48/yr (2024) | n/a | [Tracker.gg launch](https://tracker.gg/cs2/articles/cs2-stats-tracker-now-live); [Profilerr](https://profilerr.net/top-7-best-csgo-stat-trackers-to-use/) |
| Noesis | Free tier / 14-day trial | €9.99/mo (Apr 2025) | n/a | [Refrag demo blog](https://refrag.gg/blog/how-to-view-cs2-demos-online/); [Noesis](https://www.noesis.gg/) |
| Skybox EDGE | Limited free | Tier 2 €350/mo (€3,570/yr); Tier 1 €1,299/mo (€11,400/yr); team min 5 seats | Claims 85–90% of pro teams | [Skybox pricing](https://skybox.gg/pricing/); [Skybox EDGE](https://skybox.gg/edge/) |
| Blitz.gg | Free | Premium $4/mo (2024) | n/a | [Profilerr](https://profilerr.net/top-7-best-csgo-stat-trackers-to-use/) |
| Competing training tools (context) | — | CYBERSHOKE $2–5.50/mo; PRACC free/$5 VIP; Xplay free/$4.99; SCL €2.90–19.90/mo | — | [Refrag blog Jul 2026](https://refrag.gg/blog/cs2-training-tool-comparison/) |

- Ownership:
  - csstats.gg is owned by ESL FACEIT Group. — [Dust2.us](https://www.dust2.us/news/45779/update-leetify-halts-processing-faceit-demos-due-to-expensive-api-changes)
  - ESL and FACEIT were acquired for US$1.5B by Savvy Games Group (Saudi PIF) in 2022. — [Dexerto](https://www.dexerto.com/esports/esl-sells-for-1-billion-in-shock-saudi-takeover-1747441/); [HLTV](https://www.hltv.org/news/33161/esl-and-faceit-merge-under-new-ownership)
  - csstats.gg was formerly csgostats.gg (domain moved Sep 26, 2023). — [csstats Steam group](https://steamcommunity.com/groups/csstats-gg/announcements/listing)
- Valve tried selling stats itself: "CS:GO 360 Stats" at $0.99/month [May 2021, CS:GO era]. It was received negatively since csgostats.gg and Leetify were free. — [Kotaku](https://kotaku.com/cs-go-players-can-now-pay-a-buck-a-month-to-access-bett-1846827323)
- Leetify diversification: League of Legends (2025), Renown matchmaking with DatHost (2025), SCL training partnership (2026), in-house highlights (2026). — [Leetify blog](https://leetify.com/blog/); [Dust2.us](https://www.dust2.us/news/58527/leetify-and-dathost-announce-new-matchmaking-platform-renown)

### Inferences
- Willingness to pay is proven at about $5–10/month. Free incumbents (csstats.gg, FACEIT free) anchor the basic-stats price at $0.
- csstats.gg being owned by the same group as FACEIT plausibly gives it preferential FACEIT data access. This is inference only: the Dust2.us article called it a "potential beneficiary" with no confirmation.

### Gaps
- No funding rounds found for Leetify, Scope.gg, Refrag or Noesis.
- No current, primary user counts for any service except Refrag's "550,000+" and Scope.gg's "2 million registered".
- Scope.gg current 2026 prices: pricing page 404, so 2024 figures used.
- FACEIT prices come from a secondary site (shattered.io). FACEIT's own pages blocked the fetcher.

---

## Q6. ESEA status in 2026 and FACEIT-native stats

### Takeaway
ESEA survives as a league brand run on the FACEIT platform. Season 56 started January 2026 under a VRS-linked structure. The standalone ESEA site is reportedly an archive. Stats for ESEA matches therefore come through FACEIT match rooms and APIs. FACEIT's own analytics are its free match-room scoreboard, Premium "expanded match stats", and since April 2026 Premium Match Insights (2D plus mistakes).

### Cited Findings
- ESEA League moved to the FACEIT platform. — [HLTV: ESEA League moves to FACEIT](https://www.hltv.org/news/36529/esea-league-moves-to-faceit); [FACEIT blog: first CS2 ESEA season on FACEIT](https://blog.faceit.com/registration-opens-for-the-first-cs2-with-the-esea-league-on-faceit-b49f1712b719?gi=4819e2265b62)
- Season 56 changes [Nov 26, 2025 article]:
  - Registration Dec 3, 2025 to Jan 7, 2026; season start Jan 12, 2026.
  - Tiered Finals Bracket; VRS-ranked structure for upper divisions.
  - Top 2 per region get ECL Cup wildcards.
  - Roster must keep at least 3 core players.
  — [Dust2.us](https://www.dust2.us/news/68056/faceit-introduces-major-changes-to-esea-starting-next-season)
- "The ESEA website will live on as an archive of previous seasons." — [search summary citing Dust2.us/HLTV](https://www.dust2.us/news/37493/esea-moving-league-structure-to-faceit)
- FACEIT Premium includes "expanded match stats" and "cloud highlights". FACEIT Plus is mainly convenience and cosmetic features. — [shattered.io](https://shattered.io/cs2-premier-rank-vs-faceit-level/)
- Match Insights (Premium, Apr 22, 2026): see Q4. — [hawk.live](https://hawk.live/posts/faceit-announced-new-auto-match-analysis-feature-for-cs2)
- The FACEIT Data API exposes per-match stats (`/matches/{id}/stats`) with an API key, so third parties can show FACEIT scoreboard-level stats without demos. — [FACEIT Data API docs](https://docs.faceit.com/docs/data-api/data/)
- Many community browser extensions enrich FACEIT rooms, for example "FACEIT Room Stats (CS2)", "FACEIT Detailed CS2 Stats" and Faceit EGO Enhancer. — [Chrome Web Store](https://chromewebstore.google.com/detail/faceit-room-stats-cs2/dbfpapbndgmohbmfjgjhhdilijnoelmb); [Faceit EGO](https://faceit-ego-enhancer.github.io/faceit-ego/)

### Inferences
- FACEIT is now vertically integrating analytics (Match Insights) and charging third parties for demos. Expect it to keep the deepest FACEIT analysis behind its own Premium. A third-party app must lean on user-side demo access (the user's own FACEIT session) for full parsing. It can fall back to Data API scoreboard stats when no demo is available.

### Gaps
- Status of ESEA Premium pugs / Rank-S matchmaking in 2026 was not confirmed by any source found.
- Exact free-tier FACEIT match-room stat fields were not confirmed from FACEIT docs (support centre 403).

---

## Q7. Notable 2025–2026 entrants and adjacent players

### Takeaway
The 2025–2026 wave is mostly free "lookup" aggregators built on Steam, Leetify and FACEIT APIs (CSRun, CSDB.gg), trust/cheat-detection sites (csrep.gg, cstracker.gg), and browser 2D viewers. cstracker.gg's August 2026 chat-log scandal led Valve to encrypt chat in demos (Sep 9, 2026). This is a reminder that Valve will patch the demo format when third parties misuse it.

### Cited Findings
- **CSRun**: free and no-login. It aggregates Steam Web API (identity, bans), Leetify API (aim, positioning, utility, opening, clutch, recent form) and FACEIT API (level, ELO, hourly leaderboards). It has a demo analyzer. — [CSRun](https://csrun.win/)
- **CSDB.gg**: free "independent resource". Data comes "from Steam, SteamWebAPI, and community APIs" with optional match tracking. It shows Premier rating, FACEIT ELO, headshot accuracy, reaction time, counter-strafing, preaim, opening duels, flash/HE effectiveness. — [CSDB.gg](https://csdb.gg/stats/)
- **csrep.gg**: trust scores (0–100) "continuously computed from match demos, FACEIT and Premier history, AI flags, and community reviews". — [csrep.gg (search snippet)](https://csrep.gg/)
- **cstracker.gg**: builds public profiles from Steam data and processed demos. On Aug 27–28, 2026 the community found it exposed players' in-game chat (one profile had more than 2,800 messages across 388 matches); users didn't need accounts to be indexed. — [Dexerto](https://www.dexerto.com/counter-strike-2/cs2-players-in-game-chat-logs-are-now-being-exposed-publicly-3403361/); [Strafe](https://www.strafe.com/news/read/cs-2-tracker-exposes-in-game-chat-history-raising-privacy-concerns/); [skin.club](https://community.skin.club/en/news/cs2-players-discover-their-in-game-chat-logs-are-publicly-searchable)
- Valve's Sep 9, 2026 update: "Chat is now encrypted in demo files using the same rules as CS:GO". Team chat is unreadable in demos; all-chat is viewable only in the official client; it applies to new demos only. Valve did not link it to cstracker.gg. — [timesaver.gg](https://timesaver.gg/news/cs2-update-demo-chat-encryption-cache-fixes)
- A separate domain, **cs2tracker.gg**, markets "Track CS2 Player Stats, Chat Logs & AI Cheating Detection". Its relationship to cstracker.gg is unclear. — [cs2tracker.gg (search result title)](https://cs2tracker.gg/stats)
- **Eyrie.gg** positions itself as a "Leetify alternative" ("CS2 Match Tracker, Stats & Replay Review"). No further detail was retrievable. — [Eyrie.gg](https://eyrie.gg/leetify-alternative)
- **Esplay** (Sweden, ID-verified) and **Renown** (Leetify + DatHost, invite-only, AI anti-cheat, skin drops, EU-first) are new matchmaking venues whose matches flow into Leetify. — [Leetify: Esplay](https://leetify.com/blog/esplay/); [Dust2.us: Renown](https://www.dust2.us/news/58527/leetify-and-dathost-announce-new-matchmaking-platform-renown)
- Clip services (covered elsewhere): Leetify previously used Allstar for highlights and moved in-house on Jul 30, 2026. Scope.gg includes its own auto-highlight recorder. — [Leetify](https://leetify.com/blog/highlights-provider-change/); [SCOPE.GG](https://scope.gg/)

### Inferences
- Since Leetify's January 2026 API restriction (registered users only), lookup aggregators that depend on Leetify are fragile. Valve's chat-encryption patch shows that demo-derived features which create privacy harm will be shut down. A new app should keep party data opt-in and avoid indexing non-users.

### Gaps
- No data on traffic or users for CSRun, CSDB.gg, csrep.gg, cstracker.gg or Eyrie.gg.
- "cs2.space", "cs2stats", "Stratbook": no relevant 2025–2026 information found. cs2stats.gg appears in results only as a csstats.gg mirror/redirect title.

---

## Q8. User complaints (what "a better interface" should fix)

### Takeaway
The recurring complaints are: the rating feels unfair or opaque (Leetify), especially rewarding passive or clutch-heavy play; FACEIT matches missing or needing manual workarounds (Leetify since 2024); import delays and outages (Leetify, Jan 2026); paywalls with thin value; and billing and auto-renew friction (Scope.gg). Reddit itself could not be fetched, so evidence comes from Trustpilot, Steam discussions and the companies' own admissions.

### Cited Findings
- Leetify Trustpilot: 2.8/5 on only 10 reviews.
  - Rating inconsistency: one user got −6.7 while playing positively while "baiting" teammates got +9 [Nov 2025 / Apr 2026].
  - Very slow match loading [Jan 2026].
  - Pro "minimal benefits", training features working "50% of the time" [Apr 2026].
  - Bot/onboarding problems [Apr 2023].
  - Praise for support [Aug 2026].
  — [Trustpilot: Leetify](https://www.trustpilot.com/review/leetify.com)
- Leetify itself acknowledged the critiques: "baiters" over-rewarded (Nov 2024), "it only cares about whether you win your clutches" (Feb 2026), and the T post-plant death bug. — [Leetify CS2 rating update](https://leetify.com/blog/leetify-rating-update/); [Leetify clutch update](https://leetify.com/blog/leetify-rating-update-2026-02-25/)
- Leetify said its January 2026 outages were part of a recurring pattern ("rocky performance after strong growth"). It compensated Pro/Highlights+ subscribers with two free weeks. — [Leetify postmortem](https://leetify.com/blog/january-infrastructure-issues-postmortem/)
- Missing FACEIT matches since Mar 2024. Users must install community extensions or upload manually. — [Leetify: FACEIT changes](https://leetify.com/blog/faceit-changes/); [Leetify: FACEIT extensions](https://leetify.com/blog/faceit-browser-extensions/)
- Share-code friction: users struggle to find the "most recently completed match" code during onboarding (2023 thread, unanswered). — [Leetify Steam group](https://steamcommunity.com/groups/Leetify/discussions/0/3806152724338230886/)
- Scope.gg Trustpilot: 3.9/5 on 43 reviews.
  - Complaints: unclear upgrade paths forcing resubscription, auto-renewal, "price increases without notice", losing access to saved clips after cancelling, slow or freezing site, Discord-only support.
  - Praise: flash-hit stats, clipping, quick refunds.
  — [Trustpilot: Scope.gg](https://www.trustpilot.com/review/scope.gg)
- Scope.gg's free tier is "extremely limited" (1 highlight per 7 days). — [esports.gg review (search snippet)](https://esports.gg/news/counter-strike-2/scope-gg-review/)
- Privacy backlash against cstracker.gg exposing chat (Aug 2026). — [Dexerto](https://www.dexerto.com/counter-strike-2/cs2-players-in-game-chat-logs-are-now-being-exposed-publicly-3403361/)

### Inferences
- Product opportunities implied:
  1. A transparent, explainable rating: show the HLTV-style number and why your impact rating moved, round by round.
  2. FACEIT and Premier unified automatically via the desktop client, with no extension.
  3. Near-instant post-match availability, using local parsing for the user's own party.
  4. A generous free tier for 2D replay and peer comparison.
  5. Simple billing.
  6. Opt-in, privacy-respecting party features.

### Gaps
- Reddit (r/GlobalOffensive, r/cs2, r/LeetifyCS) threads could not be retrieved, so sentiment is under-sampled. Trustpilot sample sizes are small (10 and 43 reviews).
- No complaint data found for csstats.gg, Tracker.gg or Refrag specifically.

---

## Q9. Platform limitations: share-code modes, Valve and FACEIT demo windows, FACEIT support per service

### Takeaway
Valve demos and share codes are usable for about 30 days (some community posts claim shorter). The in-game GC exposes only the last 8 matches. Share-code chaining is forward-only. FACEIT demos are also kept about 30 days (secondary sources), but bulk third-party download is gated by FACEIT's Downloads API. Per-service FACEIT support: Leetify via user-side extensions or upload; Refrag via automatic import; Scope.gg via FACEIT login (mechanism unverified); csstats.gg and Tracker.gg unclear.

### Cited Findings
- Valve share code/demo link: 30 days. — [Leetify](https://leetify.com/blog/share-codes/); [CS Demo Manager](https://cs-demo-manager.com/docs/guides/downloads)
- Conflicting lower-quality claims of "7 to 14 days" for Premier/ranked demos. — [critfeed via search summary](https://critfeed.com/match-demo-has-expired-cs2/). Treat as unreliable versus the two sources above.
- GC lists only the last 8 matches. Older matches need a stored share-code chain. — [CS Demo Manager](https://cs-demo-manager.com/docs/guides/downloads); csstats.gg advertises full history "unlike in-game where you can only see your past 8 matches". — [csstats.gg (snippet)](https://csstats.gg/)
- Modes: Tracker.gg's in-match lookup covers "Premier, Competitive and Wingman". — [Tracker.gg (snippet)](https://tracker.gg/cs2). Scope.gg's 2023 CS2 launch post explicitly supports Premier. — [SCOPE.GG blog](https://blog.scope.gg/scopegg-cs2-en/). The Leetify free-Pro clan-tag rule counted only ranked competitive matches (2022–23 era). — [Leetify Steam group](https://steamcommunity.com/groups/Leetify/discussions/0/6126615404782525810/)
- FACEIT demos are stored "exactly 30 days from match completion". — [secondary guides via search summary, e.g. swap.gg](https://swap.gg/blog/how-to-watch-faceit-cs2-demos); FACEIT's own help article was blocked (403). — [FACEIT support](https://support.faceit.com/hc/en-us/articles/10622392832412-How-to-download-and-watch-a-CS2-demo)
- FACEIT per service:
  - **Leetify**: no automatic server-side import since Mar 2024; manual upload, the Aug 2025 submit-URL API, and community extensions. Its Aug 2026 profiles allow filtering "FACEIT vs. Valve Matchmaking", so FACEIT data is still a core input. — [Leetify](https://leetify.com/blog/faceit-changes/); [Leetify profiles](https://leetify.com/blog/profiles-update/)
  - **Refrag**: auto-pulls FACEIT and Premier history (2026). — [Refrag](https://refrag.gg/blog/cs2-training-tool-comparison/)
  - **Scope.gg**: FACEIT account login supported (2023). Whether full demo parsing is still automatic in 2026 is unverified. — [SCOPE.GG blog](https://blog.scope.gg/scopegg-cs2-en/)
- Valve demo-format changes can break or limit parsers (CSTV disabled at launch in 2023; chat encrypted Sep 2026). — [Leetify POV demos](https://leetify.com/blog/cs2-pov-demos/); [timesaver.gg](https://timesaver.gg/news/cs2-update-demo-chat-encryption-cache-fixes)

### Inferences
- An MVP must save the user's and party's share codes (or demos) within 30 days, ideally at match end. Otherwise history is lost permanently. A desktop app watching the CS2 replay folder or GC is the most robust option.
- Casual/Deathmatch/Arms Race likely produce no share codes or GC demos. Expect only Premier, Competitive and Wingman plus FACEIT, which matches the user's play pattern.

### Gaps
- No Valve primary documentation found for the retention window or for the list of modes that produce share codes.
- csstats.gg and Tracker.gg FACEIT support status in 2026 was not verified.
