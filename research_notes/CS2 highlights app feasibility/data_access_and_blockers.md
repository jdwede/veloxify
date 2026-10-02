# CS2 match data and demo access (Valve Premier and FACEIT): pipelines and blockers, as of Oct 2026

Research date: 2026-10-02. Several primary pages (developer.valvesoftware.com, support.faceit.com, csstats.gg) returned HTTP 403 to the fetch tool. Claims taken only from search-engine snippets of those pages are marked "(snippet)". Claims from model memory that I could not verify are kept out of Cited Findings and listed under Gaps or Inferences.

---

## 1. Valve: discovering the user's matches with `ICSGOPlayers_730/GetNextMatchSharingCode`

### Takeaway
This is still the only official, automatic way to list a user's Valve matches. It covers Competitive, Wingman and Premier (not Deathmatch or Casual). The user supplies their Steam match-history authentication code and one recent share code, and the app then walks the chain forward, one code per call. The known code passed in must be no more than 1 month old, so a chain that goes unpolled for more than a month breaks and the user has to paste a fresh code.

### Cited Findings
- Valve's CS2 release notes of **Aug 31, 2023** ("GAME AUTHENTICATION CODES" section) say: "Access to match history granted to third-party websites will now cover Competitive, Wingman, and Premier matches" and "GetNextMatchSharingCode API used by third-party websites must now supply a match sharing code that is no more than 1 month old to obtain the next match sharing code." — [Steam news, CS2 announcements feed](https://store.steampowered.com/news/posts/?feed=steam_community_announcements&appids=730&enddate=1694214924)
- Inputs: `steamid` (uint64), `steamidkey` (the user's match-history authentication code), and `knowncode` (a previously known share code). When no newer code exists the call returns `"n/a"`. — [go-steamapi csgo package docs](https://pkg.go.dev/github.com/an0nfunc/go-steamapi/csgo); (snippet) [search result summary of Go Steam API packages](https://pkg.go.dev/github.com/an0nfunc/go-steamapi/csgo)
- A typical per-user setup has three parts: a Steam Web API key, an auth code in the format `XXXX-XXXXX-XXXX`, and an initial share code `CSGO-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX`. "Starting from a known share code, the tool calls Steam's `GetNextMatchSharingCode` API to discover all newer matches." The tool waits 0.4 s between Steam API calls. — [aznan-triks/cs2-demo-fetcher README](https://github.com/aznan-triks/cs2-demo-fetcher)
- 5stack PR #444 (dated **Sep 29, 2026**) calls GetNextMatchSharingCode "the only automatic source of Valve matches" and says certain modes are never handed out through it ("Rush is unverified"), so those can never be imported any other way. It accepts raw `CSGO-…` codes or `steam://…csgo_download_match` links and limits imports to one per player per 30 s. — [5stackgg/api PR #444](https://github.com/5stackgg/api/pull/444)
- Users find the auth code via Steam Support (Help > Steam Support) or the in-game match history page. — (snippet) [5stack PR / search summary](https://github.com/5stackgg/api/pull/444); see also [cswatch.gg guide](https://cswatch.gg/blog/how-to-get-a-cs2-match-share-code)
- To create a Steam Web API key, the account cannot be "limited": it needs at least one purchase or $5 USD added to the wallet. — (snippet) [Steam Community discussion](https://steamcommunity.com/discussions/forum/1/4576192906984114093/)
- Steam Web API Terms of Use: "You are limited to one hundred thousand (100,000) calls to the Steam Web API per day." — [Steam Web API Terms of Use](https://steamcommunity.com/dev/apiterms)

### Inferences
- The app can use its own server-side Web API key. Each user supplies only their auth code and one starting share code; no user API key is needed. This is how csstats, Leetify and 5stack-style sites work.
- At 100k calls per day per key, polling every few minutes would cap a public site at a few hundred to low thousands of users per key. Adaptive polling (for example, poll when Steam presence or GSI shows a match just ended) is needed at scale.
- Because of the 1-month rule, a user who stops playing (or stops being polled) for more than 30 days must re-enter a recent share code.
- Only Premier, Competitive and Wingman matches are discoverable. Casual, Deathmatch, Retakes and Arms Race matches cannot be found through this API.

### Gaps
- I could not open Valve's own page ("Counter-Strike: Global Offensive Access Match History", HTTP 403), so the exact HTTP status codes are unverified. From memory, the page documented 202 with `nextcode: "n/a"` when no newer match exists, 403 for a bad auth code or steamid, and 412 for a knowncode that doesn't belong to the user. Verify these before implementing.
- I found no authoritative figure for how long after a match ends the next share code appears. Community experience suggests minutes, but I have no source.
- Valve publishes no per-endpoint rate limit beyond the 100k/day ToU cap. A per-IP 429 limit is commonly reported (snippet only).

---

## 2. Valve: turning a share code into a demo URL (Game Coordinator, using a Steam account)

### Takeaway
A share code decodes locally into `matchId`, `outcomeId` (reservation) and `token`. Getting the demo URL requires a logged-in Steam account that talks to the CS2 Game Coordinator (`CMsgGCCStrike15_v2_MatchListRequestFullGameInfo`). The GC returns the scoreboard and a `replayNNN.valve.net` URL. This still works in **September 2026**: two independent projects shipped bot or GC-based pipelines that month.

### Cited Findings
- node-globaloffensive (DoctorMcKay), described as "A Node.js module to connect to and interact with the CS2 game coordinator":
  - `requestGame(shareCodeOrDetails)` "Requests stats for a historical game. Listen for the `matchList` event to get your response." It accepts a share code string or `{matchId, outcomeId, token}` and needs v2.2.0 or later.
  - `requestRecentGames()` "Request a list of recent games (max. 8). This is the list you see in the client under Watch -> Your Matches."
  - Setup requires node-steam-user logged into an account and `client.gamesPlayed([730])`.
  — [node-globaloffensive README](https://github.com/DoctorMcKay/node-globaloffensive)
- The underlying protobuf is `CMsgGCCStrike15_v2_MatchListRequestFullGameInfo` (fields matchid, outcomeid, token), sent as `k_EMsgGCCStrike15_v2_MatchListRequestFullGameInfo`. — (snippet) [node-csgo source / search summary](https://github.com/OverFrag/node-csgo)
- Replay URL format: `http://replayNNN.valve.net/730/<matchid>_<reservation>.dem.bz2`, "provided by the Game Coordinator to authorized Steam clients". — (snippet) [cs2-check repo / search summary](https://github.com/FURFanTom1331FUR/cs2-check); see also [Steam discussion about replay190.valve.net being down](https://steamcommunity.com/app/730/discussions/0/1291817208498351609/)
- cs2-demo-fetcher "Uses boiler-writter to communicate with Valve's Game Coordinator and retrieve the demo URL". "CS2 must be closed": "boiler-writter needs exclusive access to the Game Coordinator". It requires a locally logged-in Steam account and waits 4 s between GC calls (`boiler_delay`). — [cs2-demo-fetcher README](https://github.com/aznan-triks/cs2-demo-fetcher)
- FragIQ (README entries dated up to 25/09/2026, in Portuguese) runs a Node.js bot account. The Web API delivers the share-code chain, and "o bot pergunta ao Game Coordinator por cada um" (the bot asks the GC about each one) and "recebe o scoreboard dos dez jogadores sem baixar demo" (it gets the ten players' scoreboard without downloading the demo). Since **18/09/2026** the bot also downloads and parses the demos. The README notes that Node is the only maintained library for this protocol and that the GC stat `total_shots_hit` "está quebrado há anos" (has been broken for years). — [Build-Labs-Group/fragiq](https://github.com/Build-Labs-Group/fragiq)
- 5stack (PR dated Sep 29, 2026) refuses share-code imports when "the Game Coordinator isn't configured", which confirms a server-side GC client in production. — [5stackgg/api PR #444](https://github.com/5stackgg/api/pull/444)
- CS:DM fetches the user's recent matches through the Steam GC: "Steam must be running and connected to your account", CS2 is "briefly launched in the background automatically to fetch data", "Only the last 8 matches are available because the Steam Game Coordinator only provides this data", and "CS:DM does not—and will never—ask for your Steam credentials." — [CS Demo Manager docs, Downloads](https://cs-demo-manager.com/docs/guides/downloads)

### Inferences
- **Desktop MVP (Windows):** the lowest-risk route is CS:DM's: use the user's own running Steam client through a helper such as akiver's boiler-writter, which needs exclusive GC access (CS2 closed). No extra bot account is needed. It conflicts with CS2 being open, so run it after the match, once CS2 is closed.
- **Public website:** you need one or more dedicated Steam bot accounts logged in headless (node-steam-user plus node-globaloffensive is the maintained stack; SteamKit2 for C# and ValvePython/csgo exist, but I did not verify their 2026 maintenance). Bot accounts must be non-limited to hold API keys and must "play" app 730 to reach the GC. CS2 is free to play, so the license is free.
- These Valve endpoints are undocumented and unsupported. Valve can change or restrict them without notice (the ToU says Valve may terminate API use "at any time for any reason"). Keep the GC request rate low (the open-source tools use about 4 s spacing) and cache results.

### Gaps
- I found no source saying whether the GC bot account needs Prime status. Nobody documents it as required, and the 2026 projects don't mention it.
- I found no 2024–2026 report of Valve bans or crackdowns on GC match-info bots, and no published GC rate limit. "No evidence found" is not proof none exist.
- I did not verify current maintenance status of SteamKit2 or ValvePython/csgo for CS2 match info. FragIQ says Node is the only maintained library for this protocol.

---

## 3. Valve demos: retention, format, size, download limits

### Takeaway
Valve Premier and Competitive demos are `.dem.bz2` files on `replayNNN.valve.net`. They expire **about 1 month (30 days)** after the match. Sources give 50–150 MB as a typical GOTV demo size; Valve publishes no download rate limit.

### Cited Findings
- "The demo's download link for a match expires 1 month after the match ends." — [CS Demo Manager docs](https://cs-demo-manager.com/docs/guides/downloads)
- "Match demos are available for approximately 30 days after the match is played. After this window, the demo files are removed from Valve servers." Typical size: "Demo files range from 50-150 MB depending on match length" (GOTV). POV demos are "Typically 10-30 MB". — [csdb.gg CS2 demo guide](https://csdb.gg/guides/demo-guide/)
- "Valve deletes demo files after ~30 days." — [cs2-demo-fetcher](https://github.com/aznan-triks/cs2-demo-fetcher)
- A search summary claimed 30–80 MB compressed and 100–250 MB raw. I could not tie that to one primary page, so treat it as indicative only. — (snippet, unattributed) [search results incl. csdb.gg, healeycodes.com](https://healeycodes.com/compressing-cs2-demos)
- In an engineering write-up (March 2024), a CS2 demo of about 300 MB is used as the parsing example. — [Andrew Healey, "Compressing CS2 Demos"](https://healeycodes.com/compressing-cs2-demos)
- History: early CS2 demos lacked events until Valve "re-enabled CSTV recording" (Leetify, **Nov 9, 2023**). — [Leetify blog "Demos are back!"](https://leetify.com/blog/demos-are-back/)

### Inferences
- Plan for about 30–80 MB downloaded and 100–300 MB on disk per 24-round Premier match. A public site should parse on ingest and keep a compact event or tick extract rather than raw demos.
- Download within days, not weeks. After 30 days the demo is gone and nothing can recover it.

### Gaps
- No primary-source size figures specific to Premier (24 rounds, MR12).
- No documented rate limit on `replay*.valve.net` downloads.

---

## 4. Valve: demos the CS2 client already downloads locally

### Takeaway
When the user clicks Download in Watch > Your Matches, CS2 saves the demo to `...\Counter-Strike Global Offensive\game\csgo\replays\`. A desktop app can watch this folder, but only the last 8 matches are listed in-client, and someone has to click (or the app has to drive the GC, as in section 2).

### Cited Findings
- Path: "C:\Program Files (x86)\Steam\steamapps\common\Counter-Strike Global Offensive\game\csgo\replays\". Clicking download saves the GOTV demo to the replays folder. — [csdb.gg demo guide](https://csdb.gg/guides/demo-guide/)
- "Downloaded/GOTV demos are stored at ...\game\csgo\replays", while POV demos go to `...\game\csgo\`. — (snippet) [Steam discussion / search summary](https://steamcommunity.com/app/730/discussions/0/558746745835747595)
- In-client list: "Request a list of recent games (max. 8). This is the list you see in the client under Watch -> Your Matches." — [node-globaloffensive](https://github.com/DoctorMcKay/node-globaloffensive)

### Inferences
- A FileSystemWatcher on the `replays` folder is a zero-risk fallback that needs no GC access.
- Full automation still needs the section 2 GC call (via boiler-writter or similar) to get the URL and download it directly. That is also simpler than automating UI clicks.

### Gaps
- I could not confirm the current CS2 file naming (`match730_<id>.dem`) or whether a `.info` sidecar file is still written in CS2. Neither was in any page I could fetch.

---

## 5. Game State Integration (GSI) in CS2

### Takeaway
GSI is Valve's official, configuration-file-based feature. The game POSTs JSON to a local HTTP endpoint. While the user is playing it exposes **only the local player's** data plus map, round, bomb and phase info. All 10 players (`allplayers_*`) are exposed only when spectating or watching GOTV or demos. It works well as a live trigger (round end, the local player's kill count increments, bomb events), but kill events are inferred from state changes, not delivered as discrete events.

### Cited Findings
- Config path in CS2: `<GAME DIR>/game/csgo/cfg/gamestate_integration_<NAME>.cfg`. The format is KeyValues with `uri`, `timeout`, `buffer`, `throttle`, `heartbeat` and a `data` block. Components: `provider`, `tournamentdraft`, `map`, `map_round_wins`, `round`, `player_id`, `player_state`, `player_weapons`, `player_match_stats`, `player_position`, `phase_countdowns`, `allplayers_id`, `allplayers_state`, `allplayers_match_stats`, `allplayers_weapons`, `allplayers_position`, `allgrenades`, `bomb`. — [antonpup/CounterStrike2GSI](https://github.com/antonpup/CounterStrike2GSI)
- GSI exposes "information about all players in the game while spectating a match, but will only expose local player's information when playing". The library's events (`PlayerGotKill`, `RoundConcluded`, `BombPlanted`, …) "are generated based on the GameState", meaning from diffs between updates. — [antonpup/CounterStrike2GSI](https://github.com/antonpup/CounterStrike2GSI)
- "The `allplayers` field … is only available when in spectator mode." Between events "no data is sent"; the heartbeat (typically 30 s) keeps the connection alive. — [cut-room.com, "How CS2 GSI works"](https://cut-room.com/blog/how-cs2-gsi-works)
- Valve Developer Community documents GSI (config files named `gamestate_integration_*.cfg` in the cfg folder). — (snippet) [Valve Developer Community, GSI page (zh)](https://developer.valvesoftware.com/wiki/Zh/Counter-Strike:_Global_Offensive_Game_State_Integration)

### Inferences
- GSI is a sanctioned Valve feature: config file plus HTTP from the game, with no memory reading or injection. It is the standard VAC-safe integration used by HUD and overlay tools.
- For highlights, use GSI only for live timestamps and triggers ("round X ended", "local player kills went from 2 to 4 within 10 s"). Take authoritative 10-player stats from the demo.
- GSI works the same in FACEIT matches because it is the game's own feature. But FACEIT matches are not visible to the Valve share-code API, so for FACEIT, GSI is the only live signal on the local machine.

### Gaps
- I could not open Valve's official English GSI page (403), so I have no primary quote stating it is VAC-safe. No measured latency figures were found; `throttle`/`buffer` default to about 0.1 s in common configs, but that is unverified.

---

## 6. Valve policy: Web API ToU, Steam sign-in, bot accounts

### Takeaway
The Steam Web API ToU does not ban commercial use. It caps calls at 100k/day, requires user-requested data only, disclosure of stored data, no implied Valve endorsement, and nothing that gives an "unfair competitive advantage". Steam OpenID 2.0 is the supported way for a website to identify a user's SteamID64.

### Cited Findings
- ToU text:
  - "You are limited to one hundred thousand (100,000) calls to the Steam Web API per day."
  - "You will only retrieve Steam Data about a Steam end user as requested by the end user."
  - "You will inform the end user about any Steam Data you will store, and you will store the Steam Data in a country (or countries) identified in your privacy policy."
  - No presentation suggesting the app "is endorsed or affiliated with Valve or Steam".
  - "You agree that you will not create or assist third parties in any way to create any technology or functionality that may give a user an unfair competitive advantage when playing multiplayer versions of any Steam game."
  - Valve may "suspend or terminate your use of the Steam Web API … at any time for any reason, without notice."
  — [Steam Web API Terms of Use](https://steamcommunity.com/dev/apiterms)
- Steam OpenID: the endpoint is `https://steamcommunity.com/openid/`, and the claimed ID format is `http://steamcommunity.com/openid/id/<steamid>`. — [Steamworks docs, User Authentication and Ownership](https://partner.steamgames.com/doc/features/auth)

### Inferences
- Post-match analytics and highlights are not live competitive advantage. Any live overlay showing information the player couldn't otherwise see would conflict with the "unfair competitive advantage" clause and with FACEIT rules.
- The GC bot route is outside the documented Web API and has no ToU coverage either way. It is the largest Valve-side policy risk for a public site.

### Gaps
- No explicit Valve statement on whether third-party sites may run GC bots. No trust-factor guidance for bot accounts was found.

---

## 7. FACEIT Data API v4: match list, match details, match stats

### Takeaway
`https://open.faceit.com/data/v4` with a server-side API key (Bearer) gives: the player's match history (`/players/{player_id}/history?game=cs2&from&to&offset&limit`), match details (`/matches/{match_id}`, including `demo_url`) and scoreboard-level stats (`/matches/{match_id}/stats`). `demo_url` is a **private resource URL**, not a downloadable link.

### Cited Findings
- Base URL `https://open.faceit.com/data/v4`; key auth is required on all endpoints; 429 means too many requests. Match details include `match_id`, `game`, `status`, `started_at`, `finished_at`, **`demo_url` (array of strings)**, `results`, and `teams` (faction plus roster). Roster entries: `player_id`, `nickname`, `game_player_id` (SteamID64), `game_skill_level`, `membership`, `anticheat_required`, `avatar`. — [FACEIT Data API reference](https://docs.faceit.com/docs/data-api/data/)
- Player history: `GET /players/{player_id}/history` with `from`/`to` (UNIX timestamps), `offset`, `limit`. — [faceit-ruby wrapper](https://github.com/kallelundgren93/faceit-ruby); filter with `game=cs2` — (snippet) [search summary of FACEIT forum/docs](https://forums.faceit.com/t/data-api-v4-player-match-history-bug/11089)
- Match stats keys (example responses): team `team_id`, `premade`, and `team_stats` ("Final Score", "Team Headshot %", "Team Win"). Per-player `player_stats` include "Kills", "Assists", "Deaths", "K/D Ratio", "K/R Ratio", "Headshots", "Headshots %", "MVPs", "Triple Kills", "Quadro Kills", "Penta Kills", "Result". — [faceit-ruby README examples](https://github.com/kallelundgren93/faceit-ruby)
- "the `demo_url` the Data API returns is a private resource URL whose host is not publicly resolvable; it must be exchanged for a signed download URL via the Faceit Downloads API." 5stack throttles to "at most once per player per hour" to avoid exhausting its quota. — [5stack docs, FACEIT integration](https://docs.5stack.gg/advanced/faceit-integration)

### Inferences
- The Data API alone gives a per-day match list and basic scoreboard stats. HLTV 2.0 rating inputs (KAST, ADR, impact, per-round survival) and anything for highlights need the demo.

### Gaps
- FACEIT does not publish numeric Data API rate limits in the docs I could reach. The fetched pages say only that authenticated requests get higher limits and that 429 exists.
- The current CS2 `player_stats` key list (ADR, utility, entry stats added for CS2) was not verifiable from the official schema, which shows a generic map.

---

## 8. FACEIT demo downloads: Downloads API, history of the restriction, and current state

### Takeaway
Since **February–March 2024**, FACEIT demo files have been private and can be fetched programmatically only via the **Downloads API**, which signs a URL. It requires a separate application (about 30-day review), an access token with the Downloads API scope, and payment above a free monthly threshold. Leetify (Mar 2024: ~€270k/yr quoted) and CS:DM (still "temporarily unavailable" in-app as of Oct 2026) have no viable automated path. Community tools instead drive the user's own logged-in browser session ("Watch Demo" in the match room yields a presigned S3 URL). Demos are kept about 30 days.

### Cited Findings
- Downloads API: "private by default and can only be accessed with a signed URL". Endpoint **`POST /download/v2/demos/download`**: request JSON `{ "resource_url": … }` returns `{ "download_url": … }`. It requires "an exclusive Access Token that has a Downloads API scope" (Bearer). Apply at `https://fce.gg/downloads-api-application`; "expected response time … 30 days" (urgent requests by email). There is a "Match Demo Ready" webhook. Rate limits, URL expiry and fees are not documented on the page. — [FACEIT docs, Downloads API guide](https://docs.faceit.com/getting-started/Guides/download-api/)
- Timeline (Leetify / Dust2.us):
  - July 2023: FACEIT mentioned paid API changes.
  - **Sept 2023**: a Developer Discord post announced a monthly free-download threshold.
  - **mid-Feb 2024**: paid model announced with days of notice.
  - **Mar 11, 2024**: Leetify halted FACEIT processing; its cost estimate was "~€270k" per year.
  - FACEIT said it was "looking to offer the API at-cost depending upon their usage and needs" because of unsustainable costs after CS2's integration.
  — [Leetify "Here's why new FACEIT matches aren't available"](https://leetify.com/blog/faceit-changes/); [Dust2.us, Mar 11 2024](https://www.dust2.us/news/45779/update-leetify-halts-processing-faceit-demos-due-to-expensive-api-changes)
- **Apr 15, 2024**: "FACEIT currently have a threshold for how many free API calls a service can make per month." The csnades.gg Chrome extension uploads from the match page. — [Dust2.us](https://www.dust2.us/news/47389/chrome-extension-restores-faceit-demos-to-leetify-in-one-click)
- **Jul 11, 2024**: "FACEIT imposed a limit on the number of demos we can download, which means we can no longer automatically grab your matches"; "We've been trying to contact FACEIT for their paid API, but haven't been able to get replies." — [Leetify blog, browser extensions](https://leetify.com/blog/faceit-browser-extensions/)
- **Aug 4, 2025**: Leetify published `POST https://api.cs-prod.leetify.com/api/faceit-demos/submit-demo-download-url`. "The URL must be a presigned URL, pointing to an S3 endpoint provided by FACEIT", to "automate the process of opening the FACEIT match room, downloading the demo file, and uploading it". — [Leetify blog, FACEIT Demo Upload API](https://leetify.com/blog/faceit-demo-upload-api/)
- CS:DM (current docs): FACEIT "restricted demo downloads to a private API" and gave CS:DM "a server-side API key with the maximum rate limit", which requires a proxy backend. "in-app downloads are temporarily unavailable"; users must "download demos from your browser (one extra click)". — [CS:DM Downloads docs](https://cs-demo-manager.com/docs/guides/downloads). In March 2024 akiver said FACEIT "will give the highest rate limit for CS:DM … requires setting up a server and 'proxifying' requests". — [CS:DM Discussion #793](https://github.com/akiver/cs-demo-manager/discussions/793)
- Retention: "FACEIT demos are deleted after 30 days"; the "Watch Demo" button disappears after about 30 days. — (snippet) [FACEIT support, "How to download and watch a CS2 demo"](https://support.faceit.com/hc/en-us/articles/10622392832412-How-to-download-and-watch-a-CS2-demo)
- Format: browser downloads are `.dem.zst`; `.dem.gz` also appears. — (snippet) [Steam guide "Instant FACEIT Demos"](https://steamcommunity.com/sharedfiles/filedetails/?id=3671537941); [Leetify FACEIT uploads](https://leetify.com/blog/faceit-uploads/)
- The "FACEIT to Leetify Demo Uploader" extension was reported working as of Jul 9, 2026. — (snippet) [Firefox add-on page](https://addons.mozilla.org/en-US/firefox/addon/faceit-to-leetify/)

### Inferences
- **Personal MVP:** applying for Downloads API access as a small, non-commercial personal app is the sanctioned path. Volume (a few demos a day) should sit under any free threshold, but approval is at FACEIT's discretion and slow (about 30 days).
- Fallbacks:
  - (a) A browser extension, or an embedded WebView logged in as the user, that captures the presigned URL behind the match room's "Watch Demo" button. This is what Leetify-oriented extensions do and it works in 2026, but it is unsanctioned automation of faceit.com.
  - (b) Watch the user's Downloads folder for `*.dem.zst` after a manual click.
- **Public website:** demo volume (users × matches × 30–100 MB) puts it above the free threshold. Expect paid, at-cost pricing negotiated with FACEIT. Treat FACEIT demo access as the top business risk; Leetify, the largest CS2 analytics site, could not make the economics work in 2024.

### Gaps
- No public numbers for the free threshold, per-demo price, signed-URL expiry, or Downloads API rate limits.
- No source on whether the policy changed in 2025–2026 beyond the Leetify upload endpoint and CS:DM's still-disabled in-app downloads.
- No primary data on FACEIT CS2 demo sizes.

---

## 9. FACEIT auth, keys, webhooks, developer terms

### Takeaway
Create an app in FACEIT App Studio (developers.faceit.com) to get server-side and client-side API keys, OAuth2 / OpenID Connect ("FACEIT Login") for account linking, and webhooks that can push `match_status_finished` and `match_demo_ready` for a user. Numeric rate limits and the developer ToS commercial clauses were not retrievable.

### Cited Findings
- Key types: **Server side** keys are "for apps developed using server side languages" and are kept secret. **Client side** keys are for code distributed "within an app or … Front end Javascript apps or Widgets", with "additional restrictions in the App Studio". Keys "can be revoked and created by you at will". — [FACEIT docs, API Keys](https://docs.faceit.com/getting-started/authentication/api-keys/)
- OAuth2 account linking: Authorization Code Flow with PKCE. The app needs an icon, Client ID, Client Secret and Redirect URL. Endpoints are at `https://api.faceit.com/auth/v1/openid_configuration`. — [FACEIT docs, Account Linking (OAuth2)](https://docs.faceit.com/getting-started/authentication/oauth2/). Scopes `openid`, `email`, `profile` (plus `membership`) return email, nickname, guid and avatar. — (snippet) [FACEIT Connect 3.0 PDF](https://cdn.faceit.com/third_party/docs/FACEIT_Connect_3.0.pdf)
- Webhooks: subscription types Organizer, **User** ("My user" or a static list of users) and Game. Events include `match_object_created`, `match_status_finished` and `match_demo_ready`. Webhook auth is via a custom header or query parameter. — [FACEIT docs, Webhooks](https://docs.faceit.com/docs/webhooks/)
- Using the Data API you can access "all publicly available information on faceit.com". Terms of Service for FACEIT Developer Tools exist but were not readable. — (snippet) [FACEIT Data API docs](https://docs.faceit.com/docs/data-api/)

### Inferences
- MVP flow: the user signs in with FACEIT (OAuth2 + PKCE) to get their `player_id`. A User-type webhook (or polling `/history`) then signals finished matches, and `match_demo_ready` triggers the Downloads API call, if approved.
- Ship only a server-side key; a desktop app should proxy through your backend, as CS:DM had to.

### Gaps
- FACEIT developer ToS text (commercial use, data retention, caching limits) could not be retrieved. Obtain it from developers.faceit.com before any public launch.
- No numeric Data API rate limits found.

---

## 10. FACEIT Anti-Cheat implications for background software

### Takeaway
FACEIT AC launches CS2 with `-allow_third_party_software` and tolerates legitimate overlays and recorders (Discord, Steam, OBS official builds, NVIDIA). Bans target injection, memory reading and input automation. An app using GSI (HTTP), file watching and an external screen recorder is in the normal-use category. Anything that injects into or reads CS2 memory is not.

### Cited Findings
- "The FACEIT Anti-Cheat will automatically start the game with `-allow_third_party_software`, which means that any 3rd party overlays will work, whereas they would be normally blocked by default", but incompatible third-party DLLs can crash the game. — (snippet) [FACEIT support "FPS drops / input lag issues"](https://support.faceit.com/hc/en-us/articles/360015781379-FPS-drops-input-lag-issues); [FACEIT support "Troubleshooting game crashes"](https://support.faceit.com/hc/en-us/articles/360014237399-Troubleshooting-game-crashes)
- OBS game capture had issues with FACEIT AC and CS2 in OBS 31.0+, fixed in 31.1+ (capture-hook certificate update). — (snippet) [OBS KB, Capture Hook Certificate Update](https://obsproject.com/kb/capture-hook-certificate-update)
- An aggregator says unrecognized software tends to be blocked from running alongside FACEIT AC rather than banned, and that bans come from DLL injection, memory reading and input automation. This is secondary and unverified. — (snippet) [backgrind overlay/anti-cheat checker (2026)](https://backgrind.com/overlay-anticheat-checker/)
- FACEIT publishes a "What is deemed to be a cheat?" policy. — [FACEIT support](https://support.faceit.com/hc/en-us/articles/360015788779-What-is-deemed-to-be-a-cheat) (not readable, 403)

### Inferences
- Prefer demo-based rendering (CS2 `playdemo` plus HLAE-style recording) after the match over live capture. This avoids any AC interaction during FACEIT matches.
- If live capture is used, rely on signed, mainstream capture paths (OBS official, NVIDIA/AMD encoders). Do not ship a custom game-capture hook DLL; FACEIT AC may block it.

### Gaps
- I could not read FACEIT's official allowed or blocked software list or the "deemed a cheat" article text.

---

## 11. Party (premade) detection

### Takeaway
FACEIT match stats expose only a team-level `premade` boolean. The documented Data API gives no per-party grouping. Valve share code, GC and demo data has no party field I could verify. Practical approach: infer parties from Steam friend lists plus co-occurrence across matches, and from FACEIT `premade`.

### Cited Findings
- FACEIT `/matches/{id}/stats` team objects include `"premade"` (boolean). — [faceit-ruby examples](https://github.com/kallelundgren93/faceit-ruby)
- The official `/matches/{id}` roster schema has no `party`, `premade` or `team_id` per player. — [FACEIT Data API reference (as fetched)](https://docs.faceit.com/docs/data-api/data/)
- On FACEIT, all players are always inside a party, even when solo. — (snippet) [FACEIT support, "Intro and Overview of Parties"](https://support.faceit.com/hc/en-us/articles/14996726238236-Intro-and-Overview-of-Parties)
- `GetFriendList` returns HTTP 401 if the user's friend list is private. `GetPlayerSummaries` returns `communityvisibilitystate` 1 (not visible) or 3 (public). — (snippet) [Valve Developer Community, Steam Web API](https://developer.valvesoftware.com/wiki/Steam_Web_API); [Steamworks ISteamUser docs](https://partner.steamgames.com/doc/webapi/ISteamUser)

### Inferences
- For the user's own friend group, the user's Steam friend list (`ISteamUser/GetFriendList`; the user can authorize, and a public list is needed for keyless reads) combined with "same team in this match" identifies party members reliably for this MVP.
- For strangers' parties (other players in the lobby), only heuristics are possible: repeated co-occurrence, or FACEIT's internal web API, which the match room uses but which is undocumented and unsanctioned.

### Gaps
- No verified source on whether CS2 demos or the GC `CDataGCCStrike15_v2_MatchInfo` contain party or lobby identifiers.

---

## 12. ESEA in 2026

### Takeaway
The ESEA League has run on the FACEIT platform since the August 2023 season. ESEA matches are therefore FACEIT matches, reachable through the same Data API, Downloads API and 30-day retention. The old ESEA site is an archive.

### Cited Findings
- **June 23, 2023**: the ESEA League moved to FACEIT from the August 2023 season, keeping the same divisions; "the ESEA website will live on as an archive of previous seasons." — [HLTV](https://www.hltv.org/news/36529/esea-league-moves-to-faceit)
- FACEIT support maintains an "ESEA Legacy Information" section. — [FACEIT support](https://support.faceit.com/hc/en-us/sections/9714520473116-ESEA-Legacy-Information)

### Inferences
- No separate ESEA integration is needed.

### Gaps
- I found no source on the status of the old ESEA pug client or archived ESEA demos.

---

## 13. Steam Web API for friends, summaries and avatars

### Takeaway
`ISteamUser/GetPlayerSummaries` (names, avatars, visibility) and `ISteamUser/GetFriendList` (requires a public friend list, otherwise 401) work with any normal Web API key and count toward the 100k/day cap.

### Cited Findings
- Friend list returns 401 when private. Summaries hide private fields; `communityvisibilitystate` is 1 or 3. — (snippet) [Valve Developer Community, Steam Web API](https://developer.valvesoftware.com/wiki/Steam_Web_API); [Steamworks ISteamUser](https://partner.steamgames.com/doc/webapi/ISteamUser)
- ToU: retrieve end-user data only "as requested by the end user"; disclose what is stored. — [Steam Web API ToU](https://steamcommunity.com/dev/apiterms)

### Inferences
- Cache summaries and avatars (with disclosure) to stay well under the call cap. Batch up to 100 SteamIDs per `GetPlayerSummaries` call (from memory, unverified here).

### Gaps
- The 100-ID batch limit was not verified in this session.

---

## 14. Leetify Public API and other aggregators as a shortcut

### Takeaway
Leetify's Public API (guidelines July 2025) gives Leetify-computed stats. Since **Jan 23, 2026** it returns data **only for users registered on Leetify**, forbids storing its data, and requires attribution. It does not provide demo files, so it cannot replace the demo pipeline. It works at best as an optional enrichment for users who also use Leetify.

### Cited Findings
- **Jul 20, 2025** developer guidelines:
  - Attribution ("Data Provided by Leetify", "View on Leetify").
  - No use of the Leetify name or suggestion of affiliation.
  - Do not rename or rescale metrics.
  - "please refrain from storing any data sent by our API".
  - API key from leetify.com/app/developer; keyless requests get "increased rate limits".
  — [Leetify API Developer Guidelines](https://leetify.com/blog/leetify-api-developer-guidelines/); (snippet) [same, key details](https://leetify.com/blog/leetify-api-developer-guidelines/)
- **Jan 23, 2026**: the Public API now returns data "only for users registered to Leetify", which Leetify acknowledges "may break some existing integrations". — [Leetify blog, Privacy updates](https://leetify.com/blog/privacy-updates-to-our-api-and-profiles/); context: [NEOK on X](https://x.com/CsNeok/status/2019051717283684668)
- Swagger docs: [api-public-docs.cs-prod.leetify.com](https://api-public-docs.cs-prod.leetify.com/) (the page is JS-rendered and its endpoints could not be extracted).
- Leetify's FACEIT upload endpoint (Aug 2025) accepts presigned FACEIT S3 URLs (section 8). — [Leetify blog](https://leetify.com/blog/faceit-demo-upload-api/)
- CS:DM also supports Renown (Steam ID64) and 5EPlay (5EPlay ID) demo downloads. — [CS:DM Downloads docs](https://cs-demo-manager.com/docs/guides/downloads)

### Inferences
- No aggregator legally redistributes Valve or FACEIT demo files. Every serious tool (Leetify, CS:DM, 5stack, FragIQ) runs its own Valve GC pipeline and either pays for FACEIT access or pushes the FACEIT download to the user's browser.

### Gaps
- Leetify Public API endpoint list and rate-limit numbers (the Swagger page did not render).

---

## 15. Summary table

### Takeaway
Valve has a working, free (but unofficial on the GC side) automated pipeline. FACEIT has an official but gated and paid-above-threshold demo pipeline. Both delete demos at about 30 days.

| Data source | What you get | Auth needed | Retention | Rate limit | Blocker risk |
|---|---|---|---|---|---|
| Steam Web API `ICSGOPlayers_730/GetNextMatchSharingCode/v1` | Next share code after a known one, for Premier, Competitive and Wingman only (no DM or Casual) | App Web API key (non-limited account) + user's auth code + a share code no more than 1 month old | Chain breaks if the known code is older than 1 month | 100k calls/day per key (ToU); per-IP 429 reported | Low–Med (official, but 1-month rule and mode coverage) |
| Steam GC `MatchListRequestFullGameInfo` (node-globaloffensive `requestGame`, boiler-writter) | 10-player scoreboard + `replayNNN.valve.net/730/<matchid>_<reservation>.dem.bz2` URL | Logged-in Steam account running app 730 (user's own client for desktop; bot account for a website) | n/a (metadata) | Undocumented; tools space calls about 4 s apart | Med (undocumented protocol; Valve can change it; bot-account policy unclear) |
| Steam GC `requestRecentGames` / CS2 Watch tab | Last 8 matches incl. demo URLs | User's own Steam client (CS2 closed for boiler-writter) | Last 8 only | n/a | Low (desktop only) |
| Valve replay servers (`replay*.valve.net`) | `.dem.bz2` demo (about 50–150 MB GOTV; sizes approximate) | None beyond the URL | About 30 days | Undocumented | Low (but hard 30-day expiry) |
| Local `game\csgo\replays` folder | Demos the user downloaded in-client | Local file access | Until deleted | n/a | Low |
| CS2 GSI (`gamestate_integration_*.cfg`) | Live local-player state, round, map, bomb; all players only when spectating or in GOTV/demo | Local cfg file | Live only | Game-side throttle/heartbeat | Low (official Valve feature) |
| Steam `ISteamUser/GetPlayerSummaries`, `GetFriendList` | Names, avatars, friend list (if public) | Web API key | n/a | 100k/day shared | Low |
| Steam OpenID 2.0 (`steamcommunity.com/openid/`) | User's SteamID64 for website login | None (OpenID) | n/a | n/a | Low |
| FACEIT Data API v4 (`/players/{id}/history`, `/matches/{id}`, `/matches/{id}/stats`) | Match list per day, rosters (with SteamID64), scoreboard stats, team `premade`, private `demo_url` | FACEIT App Studio server-side key (Bearer) | Match metadata persists; demo about 30 days | Not published; 429 enforced | Low |
| FACEIT Webhooks (User subscription) | `match_status_finished`, `match_demo_ready` pushes | App Studio app + HTTPS endpoint | n/a | n/a | Low |
| FACEIT OAuth2 / OIDC | Linked FACEIT `player_id`, nickname, avatar | Client ID/secret, PKCE | n/a | n/a | Low |
| FACEIT Downloads API `POST /download/v2/demos/download` | Signed URL for `.dem.zst`/`.dem.gz` demo | Separate approval (fce.gg/downloads-api-application, about 30-day review) + access token with Downloads scope | About 30 days | Free monthly threshold, then paid (since Feb–Mar 2024); numbers not public | **High** (approval + cost; Leetify priced out; CS:DM in-app still disabled) |
| FACEIT match room "Watch Demo" via user's browser session (extension/WebView) | Presigned S3 demo URL | User's logged-in faceit.com session | About 30 days | n/a | Med–High (unsanctioned scraping; may break; ToS risk) |
| ESEA | Same as FACEIT (league runs on FACEIT since Aug 2023) | Same as FACEIT | Same | Same | Same as FACEIT |
| Leetify Public API | Leetify stats for Leetify-registered users only (since Jan 23 2026); no demos | Leetify API key (optional, higher limits) | No storing allowed | Not published | Med–High (registered-users-only, no-storage rule, no demos) |

### Inferences
- MVP verdict: for the user's own Premier matches, the pipeline is fully automatable today: auth code + share-code chain, then the local Steam client or a bot asks the GC for the URL, then download from replay*.valve.net within 30 days. FACEIT match lists and stats are trivial, but FACEIT demo files are the critical blocker. Either apply for Downloads API access early (about 30-day lead time) or accept a semi-manual or browser-session fallback.
- Public-site verdict: Valve requires running bot accounts against an undocumented GC protocol plus 100k/day key budgeting. FACEIT requires a negotiated, likely paid Downloads API agreement.

### Gaps
- See the per-section gaps above, especially: FACEIT pricing and thresholds, FACEIT developer ToS text, official Valve GSI and match-history page text (403), and whether Prime is needed for GC bots.
