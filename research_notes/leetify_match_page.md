# Leetify CS2 match page: research notes (for Veloxify)

Researched 2026-10-07 using WebSearch/WebFetch only (no browser, no sign-in).

## How the evidence was gathered (read first)

- `leetify.com/app/match-details/<id>/...` is a client-rendered SPA. WebFetch returns only the shell ("Leetify"). The **tab URL slugs** and **column labels** below come from the search engine's rendered index of real public match pages, seen through WebSearch result snippets. Treat these as **observed**: the labels are real, but the snippet text is lossy.
- Metric **formulas** come from Leetify's blog and glossary (**documented**) or from arithmetic checks against observed numbers (**inferred-verified**). Anything else is marked **inferred**.
- The Leetify public API (`/v2/matches/{gameId}`) gives a per-player aggregate schema that matches the page columns. Field list from the `leetify` Rust crate docs: https://docs.rs/leetify/latest/leetify/types/struct.PlayerStats.html

### Observed tab/route structure (URL slugs)
| Slug | Tab | Example URL |
|---|---|---|
| `/overview` | Overview | https://leetify.com/app/match-details/a8288ee5-b925-498e-b336-579a9209e36e/overview |
| `/your-match` | Your Match | https://leetify.com/app/match-details/b728a881-816e-464c-bb3f-4f54d991775c/your-match |
| `/rating-breakdown` | Rating Breakdown | https://leetify.com/app/match-details/0773a99b-0441-48f4-927f-00cd3ebde6e1/rating-breakdown |
| `/details-general` | Match Details > General (scoreboard) | https://leetify.com/app/match-details/3b978cb2-a1e2-4807-ad9b-1d19a5862a59/details-general |
| `/details-timeline` | Match Details > Timeline | https://leetify.com/app/match-details/4509f5af-22c9-4c42-a68a-f25848763714/details-timeline |
| `/details-aim` | Match Details > Aim | https://leetify.com/app/match-details/f8d098a5-0110-4702-a9da-75752530d357/details-aim |
| `/details-utility` | Match Details > Utility | https://leetify.com/app/match-details/70247f35-1534-45b2-8101-593bda0a8cff/details-utility |
| `/details-activity` | Match Details > Activity | https://leetify.com/app/match-details/cf3badbf-b458-47f6-8d5a-acc415eac66c/details-activity |
| `/details-trades` | Match Details > Trades | https://leetify.com/app/match-details/4b982dd8-0091-43f2-a1e6-1031b1450100/details-trades |
| `/details-opening-duels` | Match Details > Opening Duels | https://leetify.com/app/match-details/1fbd5cdc-0f72-47d4-85d9-12ff2323fe0f/details-opening-duels |
| `/details-clutches` | Match Details > Clutches | https://leetify.com/app/match-details/cd447ca3-a2a5-458a-aba6-4d19e299a4c6/details-clutches |
| `/2d-replay` | 2D Replay (Pro) | https://leetify.com/app/match-details/2332f059-3a92-4385-80ac-586155d30589/2d-replay |
| `/head-to-head` | Head to Head | https://leetify.com/app/match-details/282f9ccb-a9bd-4f52-84d5-8f4986b6738f/head-to-head |
| `/map-zones` | Map Zones (logged-in/Pro) | https://leetify.com/app/match-details/e68b3c67-09bc-40c7-88b4-3b32ab074334/map-zones |

**"Match Details" is a parent tab, not a page of its own.** Its sub-tabs are General, Timeline, Aim, Utility, Activity, Trades, Opening Duels and Clutches (all `details-*`). Leetify's own wording, "Match Details -> Utility", confirms the nesting. A public mirror at `leetify.com/public/match-details/<id>/<slug>` uses the same slugs.

Every page header shows: score "13 : 9 on Ancient", Victory/Defeat, date and time, source (Matchmaking (Premier) / FACEIT / HLTV / Esplay), server region, ruleset (MR12/MR15), and each team's average Premier rating. Teams are listed as "Winning Team" and "Losing Team".

---

## 1. Overview (`/overview`)
- **Scoreboard columns (observed):** Rating (Leetify Rating, ±x.xx), Personal Performance, HLTV Rating, K/D, ADR, Aim, Utility (Rating). There is also a "top performers" podium (1st, 2nd and 3rd by Leetify Rating).
- **Personal Performance (documented-ish):** compares this match's rating to the player's **60-match average**. The Rating Breakdown "Consistency" box uses the same baseline, weighted for uneven CT/T rounds. https://leetify.com/blog/rating-breakdown
- **Win Rate Forecast / "Expected Outcome" (observed):** shows the win % for each team, for example 55% vs 41%. The two values sum to about 96–97%, so the remainder is **inferred** to be the tie (12–12) probability. Also shows "Rating Spread" and "Expected Round Differential", a distribution over final scores (13–≤7, 13–8, …). According to the indexed page text, it is "calculated using everyone's Premier Rating BEFORE the match starts" and needs at least 4 Premier-ranked players per team. Exact model: **not documented**.
- **Data needed:** per-player K/D/A, damage, rounds; your own rating; the Aim and Utility ratings below. For the forecast you need pre-match Premier ratings, which a demo doesn't contain. Veloxify can skip it, or use FACEIT Elo / stored history instead.

## 2. Match Details > General (`/details-general`)
- **Columns (observed):** Kills, Assists, Deaths, K/D, ADR, KAST, 2K, 3K, 4K, 5K, HLTV Rating, Personal Performance.
- **KAST:** % of rounds with a Kill, Assist, Survival or Trade. Leetify's trade window for KAST is **not documented**. awpy uses 3 s for KAST and 5 s for trades (https://awpy.readthedocs.io/en/latest/_modules/awpy/stats/kast.html).
- **API mirror:** `total_kills, total_assists, total_deaths, kd_ratio, dpr, total_damage, multi1k..multi5k, rounds_survived(_percentage), total_hs_kills, mvps, score`.
- **Data needed:** `player_death` (attacker, victim, assister, flash-assist, headshot, weapon), `player_hurt` (dmg_health, capped at remaining HP for ADR), round start/end, end-of-round alive state.

## 3. Match Details > Timeline (`/details-timeline`)
- **Observed metric labels:** Kills, Deaths, Damage, AWP Kills, Enemies Flashed, Round Difference, Team Economy. **Inferred:** a round-by-round chart with a metric selector, per player or team, plus a score-difference line and an equipment-value line.
- **Economy labels Leetify uses elsewhere (observed in Recaps):** Pistol, Semi-Eco, Force Buy, Full Buy (plus Eco). Its rating model uses "4 economy groups… Values are different for CT and T" (https://leetify.com/blog/leetify-rating-explained). The exact thresholds are **not published**.
  - Reference thresholds from CSDM/cs-demo-analyzer `economy.go`: pistol = first round of a half (no OT); eco ≤ $1000 equipment per player; full ≥ $4000 for T and ≥ $4500 for CT; force = lost previous round and money ≤ $400 after buying; else semi. https://raw.githubusercontent.com/akiver/cs-demo-analyzer/main/pkg/api/economy.go
- **Data needed:** per round: winner, `round_end` reason (elimination, bomb exploded, defused, time), score, per-player kills/deaths/damage/AWP kills/flashes, team equipment value at freeze-end (`current_equip_value`), money spent, and bomb plant/defuse ticks.

## 4. Match Details > Aim (`/details-aim`)
- **Columns (observed):** Spotted Accuracy, Time to Damage, Counter-Strafing, Crosshair Placement, Head Accuracy, HS Kill %, Spray Accuracy, Accuracy (All).
- **Definitions (documented, https://leetify.com/blog/leetify-stats-glossary):**
  - **Accuracy (Enemy Spotted):** hits / shots fired while an enemy is spotted. Excludes spamming through smoke or walls.
  - **Head Accuracy:** headshot hits / all hits on enemies. **Excludes AWP**.
  - **Spray Accuracy:** a spray is 3 or more consecutive shots; hits in sprays / spray shots, counted while an enemy is visible.
  - **Counter-Strafing:** share of rifle shots fired at speed below **34% of the weapon's max speed** (where inaccuracy starts). Excludes crouching and non-rifles. The API exposes `counter_strafing_shots_good/bad/all`.
  - **Time to Damage:** time from first seeing the enemy to first damage on them. Engagements longer than **1 s are excluded**, and the median is used. Leetify stresses that this "is NOT reaction time" because it includes fire-rate and accuracy.
  - **Crosshair Placement:** angular distance in degrees between the eye angles at the enemy's first appearance in FOV and at the first hit. Median.
  - **Visibility:** Leetify uses its own raycaster with a human-shaped hitbox, replacing radar `spotted` events that lag 0–500 ms. https://leetify.com/blog/enemy-actually-spotted/ and https://leetify.com/blog/aim-stat-calculation-hitboxes-improved/
- **API field names `preaim` (degrees) and `reaction_time` (ms):** **inferred** to be the older names for Crosshair Placement and Time to Damage.
- **Aim Rating (0–100):** a z-score against benchmarks, average 50. All stats on the Aim tab are weighted equally, except Accuracy (All Shots), which is not counted. https://leetify.com/blog/cs2-benchmarks/
- **Data needed:** `weapon_fire` (tick, weapon), `player_hurt` (hitgroup), per-tick pitch/yaw, velocity, ducking and position for shooter and target, plus visibility. The cheap version uses demoparser2 `approximate_spotted_by` (`m_bSpottedByMask`). The better version raycasts against map geometry (awpy VisibilityChecker).

## 5. Match Details > Utility (`/details-utility`)
- **Shows (observed):** per-team counts of flashes, smokes, HEs and molotovs thrown; per-player Utility Rating with its Quantity and Quality sub-ratings; Flash Assists; Enemies Flashed; Avg Blind Time; Teammates Flashed; Avg HE damage; Utility on Death.
- **Definitions (documented, glossary):**
  - "Full" blind means **≥1.1 s**; shorter flashes count as half-blind and are excluded.
  - **Enemies flashed per flash** = full-blinded enemies / flashes thrown.
  - **Teammates flashed** is the same calculation and includes yourself.
  - **Flash blind duration** = average over flashes of the *longest-blinded* enemy per flash.
  - **Flashbangs leading to kills** = enemies killed while blinded by your flash, including your own kills, excluding half-blinds.
  - **HE damage per HE** = HE damage dealt / HEs thrown.
  - **Unused utility on death** = average $ value of unthrown grenades held at death.
  - **[CT] Smokes that stopped a push** = % of CT smokes that bloomed within **800 units** of enemies.
- **Utility Rating (documented, https://leetify.com/blog/utility-ratings/):** geometric mean of Quantity and Quality.
  - **Quantity** = min(100, (nades per round excluding decoys / 3)^(2/3) × 100).
  - **Quality** = Φ(zCombined) × 100, where z_i = (stat − avg)/std, negated for team-damage and friends-flashed stats. z_i is scaled by √matches, then S = Σ w_i z_i and zCombined = S / √Σ(w_i √matches)². The six inputs are Flash Assist %, Enemies flashed/flash, Friends flashed/flash, Avg blind time/flash, HE dmg/HE and HE team dmg/HE. Weights are not published.
- **API mirror:** `flashbang_thrown, flashbang_hit_foe, flashbang_hit_friend, flashbang_leading_to_kill, flashbang_hit_foe_avg_duration, flash_assist, he_thrown, he_foes_damage_avg, he_friends_damage_avg, molotov_thrown, smoke_thrown, utility_on_death_avg`.
- **Data needed:** `player_blind` (attacker, victim, blind_duration), `flashbang_detonate`, `hegrenade_detonate`, `smokegrenade_detonate` (position), `inferno_startburn`, `player_hurt` with weapon hegrenade/inferno/molotov, inventory at death, and enemy positions at smoke bloom.

## 6. Match Details > Activity (`/details-activity`)
- **Columns (observed):** Total Damage, HE dmg, Molotov dmg, Enemies Flashed, Shots Fired, Wasted Magazine % (shown like "21% (16 bullets)"), Rounds Survived (count and %).
- "Wasted Magazine" is **not documented** anywhere I could find. Possibly bullets left unused or discarded, as a share of something. Treat it as unknown and don't copy it without a clear definition of our own.
- **Data needed:** damage by weapon class, `weapon_fire` count, ammo clip state on reload or death (`m_iClip1`), and alive state at round end.

## 7. Match Details > Trades (`/details-trades`)
- **Columns (observed):** Trade Kill Opportunities, Trade Kill Attempts (%), Trade Kill Success (%), and Traded Death Opportunities, Attempts (%), Success (%).
  - Example: 12 opportunities, 11 attempts (92%), 5 successes (45%). **Attempts % = attempts / opportunities; Success % = successes / attempts.** This is inferred-verified: 5/11 = 45%, and 5/8 = 63% in another row.
- **Documented definitions (glossary, wording only):** Opportunity = "you had the chance to trade a teammate"; Attempt = "you actually attempt[ed] a trade"; Success = you killed the killer. Traded death = the same, seen from the victim's side. **Leetify does not publish the time window, distance or visibility criteria.**
- **Reference implementations:**
  - CSDM (cs-demo-analyzer `analyzer.go`): `tradeKillDelaySeconds = 5`. A kill is a trade kill if the victim killed one of the killer's teammates within 5 s in the same round.
  - awpy `calculate_trades`: 5.0 s by default.
- **Suggested Veloxify definition (inferred, not Leetify's):**
  - **Opportunity:** a teammate is killed and you are alive at that moment.
  - **Attempt:** within 5 s you damage or shoot at the killer, or have the killer spotted while aiming.
  - **Success:** you kill the killer within 5 s.
- **API mirror:** `trade_kill_opportunities, trade_kill_attempts, trade_kills_succeed, *_percentage, trade_kill_opportunities_per_round, traded_death_*`.

## 8. Match Details > Opening Duels (`/details-opening-duels`)
- **Columns (observed):** Attempts %, Success %, Traded %, Most killed (player), Best weapon. A 2025 Recap shows the same data as won / lost (traded) / lost (untraded) shares.
- **Formulas (inferred-verified against one match with 22 rounds and five players, all consistent):**
  - Attempts % = rounds where the player was in the first duel (as first killer or first victim) / rounds played. Example: 9/22 = 41%.
  - Success % = opening kills / attempts. Example: 5/9 = 56%.
  - Traded % = opening deaths that were traded / opening deaths. Example: 1/4 = 25%.
- **Opening duel definition (Leetify tooltip):** "Getting the first kill or being the first death in the round".
- **Data needed:** the first `player_death` of each round (excluding warmup, world and team kills), trade detection on that death, the weapon used, and side for per-side splits.

## 9. Match Details > Clutches (`/details-clutches`)
- **Shows (observed):**
  - Team summary: clutches won, lost and saves, plus clutch kills.
  - Per player: each clutch with round number, 1vX (1v1 to 1v5) and outcome **Won / Lost / Saved**.
- **Definition (Leetify tooltip):** "Winning rounds as the last player alive on your team".
- **Reference implementation (CSDM):** a clutch starts the first time a team has exactly one player alive. Opponent count = enemies alive at that moment. It also tracks a secondary 1v1, and records `HasWon`, `ClutcherSurvived` and `ClutcherKillCount`. Saved = round lost but the clutcher survived (**inferred**).
- **Rating note:** since 2026-02-25, 1v1 kills inside clutches are worth about 5% less. https://leetify.com/blog/leetify-rating-update-2026-02-25/

## 10. 2D Replay (`/2d-replay`, Pro only)
- Leetify publishes no text spec; the indexed pages only say it is Pro-only. **Inferred** from similar products (OP.GG's 2D replay; open-source viewers below), the replay shows: the radar image, with players as team-coloured dots plus view direction, HP, active weapon, alive/dead state, and name.
  - Grenade throw paths and detonation areas: smoke radius, molotov fire area, flash pop.
  - Kill markers and kill feed, bomb carrier/plant/defuse state, round timer, score.
  - Per-round selector and a play/pause/speed/scrub timeline with event ticks.
- **Data needed:** sampled player state (about 4–16 Hz is enough; healeycodes samples 200 ms and interpolates with lerp/angle-lerp), grenade projectile positions, detonations, inferno extents, bomb events, and map radar transform `pos_x, pos_y, scale` (+ vertical sections for Nuke and Vertigo). https://healeycodes.com/rendering-counter-strike-demos-in-the-browser

## 11. Head to Head (`/head-to-head`)
- **Observed:** a player-vs-player view. Pick two players and compare kills against each other with a weapon breakdown (rifles, pistols, snipers), damage dealt and received, aim stats in their duels (spotted accuracy, TTD, crosshair placement, counter-strafing), and flashes on each other. Exact layout unknown; a 5×5 kill matrix is a reasonable **inferred** overview.
- **Data needed:** attacker→victim pairs for kills, damage and blinds; aim samples tagged with the target.

## 12. Rating Breakdown (`/rating-breakdown`)
- **Sections (documented, https://leetify.com/blog/rating-breakdown):**
  - **Rating by Round:** one bar per round = % change in round-win probability attributed to you (can exceed ±100). Hover names the category. Match LR = average of the round values.
  - **Rating Gained & Lost:** totals by category.
  - **T/CT rating:** shown separately.
  - **Consistency:** this match vs your 60-match average.
- **Categories with Leetify's own tooltips (observed):**
  - Opening Duels: "first kill or being the first death in the round".
  - Mid-round K/D: fights after the opening duel, before the plant.
  - Afterplants: T after the plant.
  - Retakes: CT after the plant.
  - Clutches.
  - Flash Assists: "Opponents that died while blind to your flashbangs".
  - Damage Assists.
  - Traded: "Rating given back to you when your death helped a teammate get a kill".
  - Saving: rewards gear saved for the next round.
  - Enemy Saving: "Credit for winning the round when opponents were still alive (adjusted down by the value of the equipment they saved)".
- **Model (documented):**
  - Round-win probability is a function of both teams' economy group (4 groups, CT/T-specific), players alive (XvY), and which side got the last kill.
  - Each kill's ΔP is split 35% killer, 30% damage dealers (overkill up to 50 HP considered), 15% flash assister and 20% traded player, renormalised when a part is missing.
  - Deaths are charged fully to the victim.
  - Kills within 4 s form a kill chain, weighted linearly.
  - End-of-round adjustments cover bomb explode, defuse with Ts alive, and time expiry. Saves are rewarded.
  - The rating is zero-sum.
  - Benchmarks since 2024-11-25: Good > +2.09, Great > +5.12.
  - Sources: https://leetify.com/blog/leetify-rating-explained, https://leetify.com/blog/rating-upgrade/, https://leetify.com/blog/leetify-rating-update/
- **Data needed:** a win-probability table P(win | econ_CT, econ_T, aliveCT, aliveT, lastKillSide, bombPlanted). Build it from many parsed demos, or seed it from public tables. Also needed: every kill with damage contributors and flash assister, trade links, round end and saved equipment.

## 13. Map Zones (`/map-zones`)
- **Observed:** "only available to Leetify users", and part of Pro on the profile-level tool.
- **Documented features of the Map Zone Tool** (https://leetify.com/blog/more-data-on-smokes/, https://leetify.com/blog/leetify-guide-how-to-start-improving-in-csgo/):
  - The map is split into named zones, each showing the % of time or engagements you were there and your performance against a **per-zone benchmark**.
  - Filters: CT/T and Pre-plant/Post-plant, plus a Team view.
  - Clicking a zone shows killer and victim locations for its kills and deaths. Labels on hover; zoom.
- Leetify's zone polygons are **hand-made and not public (inferred)**.
- **For Veloxify:** CS2 demos include the nav-mesh place name per player (`m_szLastPlaceName`, exposed as `last_place_name` in demoparser2), for example "BombsiteA" or "Long". Group kills and deaths by the victim's and attacker's place to get callout zones for free. For polygons, the awpy-data nav meshes (.nav areas) can be unioned by place.

## Your Match (`/your-match`)
The slug exists, but its content isn't indexed. **Inferred:** a personal summary for the logged-in player, probably covering their rating vs average, highlights, rating gained/lost, and the post-match journal. The journal is opened via a "Journal" icon next to the score on the match report (https://leetify.com/blog/post-match-journal/).

---

## Open-source references (stars as of fetch, Oct 2026)
| Project | Stars | What it gives us |
|---|---|---|
| akiver/cs-demo-manager https://github.com/akiver/cs-demo-manager | ~2.0k | Full app: 2D viewer, heatmaps, trades, opening duels, clutches, utility, economy (MIT) |
| akiver/cs-demo-analyzer https://github.com/akiver/cs-demo-analyzer | 126 | Go analyzer, JSON/CSV out. Trade 5 s, clutch detection, economy types (MIT) |
| markus-wa/demoinfocs-golang https://github.com/markus-wa/demoinfocs-golang | ~1.1k | CS2 parser (Go), grenade trajectories (MIT) |
| LaihoE/demoparser https://github.com/LaihoE/demoparser | ~731 | Rust parser with Python/JS/WASM bindings. Fields: `last_place_name`, `approximate_spotted_by`, `flash_duration`, pitch/yaw, velocity (MIT) |
| pnxenopoulos/awpy https://github.com/pnxenopoulos/awpy | ~618 | Python: ADR/KAST/rating, trades, nav meshes, visibility raycast, map data via awpy-data (MIT) |
| Linus4/csgoverview https://github.com/Linus4/csgoverview | 195 | 2D replay (CS:GO-era, Go) with playback controls |
| LouisAsanaka/Valorant-Zone-Stats https://github.com/LouisAsanaka/Valorant-Zone-Stats | 103 | Clone of Leetify's Map Zones idea (polygons + K/D per zone), Valorant |
| MurkyYT/cs2-map-icons https://github.com/MurkyYT/cs2-map-icons | 70 | CS2 radar images + `pos_x/pos_y/scale/verticalsections` JSON |
| zenojunior/cs2d https://github.com/zenojunior/cs2d | 21 | Browser 2D CS2 viewer: heatmaps, grenade trajectories, economy (Vue + Rust/WASM) |
| whiskeyo/cs2analyzer https://github.com/whiskeyo/cs2analyzer | 2 | Leetify-like browser analyzer: 2D radar, scoreboard (KAST/rating), clutches, economy timeline (buy thresholds $2,000/$3,700) |

## Key gaps (not documented publicly)
- Leetify's exact trade opportunity and attempt criteria.
- Economy group thresholds.
- Win-probability tables.
- Utility Quality weights.
- Wasted Magazine definition.
- Win Rate Forecast model.
- 2D replay and Your Match layouts.
