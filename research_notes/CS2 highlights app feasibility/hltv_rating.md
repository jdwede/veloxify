# HLTV Player Rating Systems (1.0 / 2.0 / 2.1 / 3.0) and HLTV Player-Profile Stats: Implementation Reference (as of 2 Oct 2026)

Research note conventions: "PUBLISHED" = stated by HLTV itself. "APPROXIMATION" = community reverse-engineering. "INFERENCE" = my own reasoning or design suggestion, not a sourced fact. HLTV.org stats pages and some news pages sit behind a Cloudflare bot check that blocked automated fetching. Where a fact came from a search-engine snippet instead of a full page read, the note says so.

---

## Q1. What is the current/latest HLTV rating version (Oct 2026)? Is 2.1 still used anywhere?

### Takeaway
The user's belief is out of date. HLTV has used **Rating 3.0** since **20 August 2025**. It was applied retroactively to every CS2 match, so it replaced 2.1. It was re-weighted on **29 October 2025** and got a small accuracy update around **1 October 2026**. It is still called "3.0": I found no 3.1. Rating 2.1 (October 2024) no longer appears on HLTV's CS2 pages. It survives only in older third-party scrapes and articles.

### Cited Findings
- "Introducing Rating 3.0" by NER0cs, dated 20-8-2025. It says: "Rating 3.0 has been released across all Counter-Strike 2 matches in rating's biggest overhaul since 2017's 2.0." — [HLTV: Introducing Rating 3.0](https://www.hltv.org/news/42485/introducing-rating-30) (full text read in browser)
- 3.0 is described as "a version of rating 2.1 that is adjusted on economic factors supplemented by a brand new Round Swing metric". It has six sub-ratings: Kills, Damage, Survival, KAST, Multi-Kills, Round Swing. "Like previous ratings, the average is 1.00 over a CS2 event." — [HLTV: Introducing Rating 3.0](https://www.hltv.org/news/42485/introducing-rating-30)
- "Rating 3.0 adjustments go live" by NER0cs, dated 29-10-2025. "The formula for rating 3.0 has been changed to put more weight on kills." Also: "Previous matches have been overwritten with the hotfixed version of rating 3.0." — [HLTV: Rating 3.0 adjustments go live](https://www.hltv.org/news/43047/rating-30-adjustments-go-live) (full text read in browser)
- **Date discrepancy:** the adjustments article mentions "EVPs handed out before the release of rating 3.0 in July", but the introduction article is dated 20 Aug 2025. — [HLTV adjustments](https://www.hltv.org/news/43047/rating-30-adjustments-go-live); [HLTV intro](https://www.hltv.org/news/42485/introducing-rating-30)
- **October 2026 update, "Rating 3.0 receives small accuracy improvements" (HLTV news #45596).** The HLTV page was blocked to direct fetch, so these details come from the search-engine snippet of that page:
  - 29,030 maps (9,029 on LAN) have been played since release.
  - 3.0 uses map-specific averages. A 5v5 win probability can differ by nearly 10 percentage points between Anubis and a CT-sided map like Overpass.
  - The update accounts for the July 2025 in-game economy changes.
  - A round now counts as over once the bomb cannot be stopped. Kills when the CTs have no kit and the bomb has fewer than 10 seconds left are treated like exit frags, and the same goes for CT deaths.
  - 9.4% of player-maps moved by ≥0.05, 1% by ≥0.10, and the largest move was 0.31.
  - Source: [HLTV: Rating 3.0 receives small accuracy improvements](https://www.hltv.org/news/45596/rating-30-receives-small-accuracy-improvements)
- Secondary coverage dates that update to 1–2 Oct 2026, mentions roughly 30,000 maps analysed, and says July–September matches shifted. — [Cybersport.in](https://cybersport.in/9913-hltv-updates-rating-3-0-player-evaluations-in-cs2/) (lower-quality summary)
- Rating 2.1 was published 14 Oct 2024 by NER0cs and applied to CS2 matches and stats pages. — [HLTV: Introducing rating 2.1](https://www.hltv.org/news/40051/introducing-rating-21) (date from WebFetch extraction)
  - HLTV's 3.0 article loosely says 2.1 "was then released last summer". HLTV news IDs are sequential, and #40051 is later than the attributes article #39672 dated 21 Aug 2024, which supports an autumn 2024 date. — [HLTV attributes](https://www.hltv.org/news/39672/introducing-hltv-attributes)
- A third-party HLTV scraper still outputs a "RATING 2.1" column. — [jparedesDS/hltv-scraper](https://github.com/jparedesDS/hltv-scraper)

### Inferences
- On hltv.org, CS2 matches show 3.0 everywhere. CS:GO-era matches presumably still show 2.0, or 1.0 for very old data, because 2.1 and 3.0 were described as covering CS2 matches only.
- Any "HLTV rating" number the app shows is **not** comparable to what HLTV currently displays unless it is a 3.0-style rating. Even then it would only be an approximation (see Q5).

### Gaps
- I could not read the full Oct 2026 HLTV article because of Cloudflare. Any new constants or weight changes it contains are unverified. The weights below are the Oct 2025 ones.
- One WebFetch summary claimed HLTV Fantasy kept using Rating 2.1 for ESL Pro League S24. That claim is **not** in the full 3.0 article text I read, so it is likely a summarizer hallucination. Treat it as unverified.

---

## Q2. Rating 1.0: exact published formula

### Takeaway
Rating 1.0 is the only fully public HLTV formula. It was published in 2010 and uses constants 0.679, 0.317 and 1.277. It can be implemented exactly; one open-source implementation (cs-demo-analyzer) already does.

### Cited Findings
- **PUBLISHED formula:**
  - `KillRating = (Kills/Rounds) / 0.679`
  - `SurvivalRating = ((Rounds − Deaths)/Rounds) / 0.317`
  - `RoundsWithMultipleKillsRating = ((1K + 4·2K + 9·3K + 16·4K + 25·5K)/Rounds) / 1.277`
  - `Rating 1.0 = (KillRating + 0.7·SurvivalRating + RoundsWithMultipleKillsRating) / 2.7`
  - Source: [Chris Sardegna: Exploring Problems with Counter-Strike Rating Systems](https://chrissardegna.com/blog/problems-with-csgo-rating-systems/), which cites HLTV's archived page ([web.archive.org snapshot of hltv.org/?pageid=242](https://web.archive.org/web/20100414190652/https://www.hltv.org/?pageid=242&eventid=0)).
- The HLTV article "What is that rating thing in stats?" (12 Apr 2010, Tgwri1s) gives average KPR 0.679 and the structure "added together, with Survival-Rating participating with a 0.7 factor… then divided by 2.7". — [HLTV news #4094](https://www.hltv.org/news/4094/what-is-that-rating-thing-in-stats)
- The 1.0 author is named as Petar "Tgwri1s" Milovanovic. — [HLTV 3.0 article](https://www.hltv.org/news/42485/introducing-rating-30)
- The same constants are implemented verbatim in Go. `nK` counts rounds with exactly n kills, excluding suicides and team kills. — [akiver/cs-demo-analyzer player.go `HltvRating()`](https://raw.githubusercontent.com/akiver/cs-demo-analyzer/main/pkg/api/player.go)
- Critique: Sardegna reports that K/D alone predicts Rating 1.0 with ~88% accuracy. — [Sardegna](https://chrissardegna.com/blog/problems-with-csgo-rating-systems/)

### Inferences
- The averages come from 2010-era (CS 1.6, MR15) data. In CS2 MR12, the population means drift, so a CS2 lobby's average 1.0 rating will not sit exactly at 1.00.
- Rating 1.0 is linear in per-round rates. A day/session value should therefore be computed from summed counts (total kills, deaths, nK and rounds). That equals the round-weighted mean of per-match ratings.

### Gaps
- None for the formula itself.

---

## Q3. Rating 2.0 (2017): components and the community approximation

### Takeaway
HLTV published the five components but not the formula. The standard community approximation is Dave's linear regression (flashed.gg, Jan 2021), which reports R² ≈ 0.995 on profile-level data. CS Demo Manager and awpy both use it.

### Cited Findings
- **PUBLISHED structure** ("Introducing Rating 2.0", 14 Jun 2017, Tgwri1s). Five components, computed separately for CT and T:
  1. **Kill rating:** gives less weight to assisted kills.
  2. **Survival rating:** traded deaths are penalized less.
  3. **KAST rating:** "round-to-round consistency".
  4. **Impact rating:** "multi-kills, opening kills, 1onX wins and more".
  5. **Damage rating:** ADR relative to expectation.
  - Values are scored by "how many standard deviations the player is above or below average" rather than divided by averages.
  - "The exact formula won't be public this time." The average stays 1.00.
  - Source: [HLTV: Introducing Rating 2.0](https://www.hltv.org/news/20695/introducing-rating-20)
- **APPROXIMATION** (Dave, "Reverse Engineering the HLTV 2.0 Rating", Sat 9 Jan 2021):
  - `Rating 2.0 ≈ 0.0073·KAST + 0.3591·KPR − 0.5329·DPR + 0.2372·Impact + 0.0032·ADR + 0.1587`
  - Full-precision coefficients: KAST 0.00738764, KPR 0.35912389, DPR −0.5329508, Impact 0.2372603, ADR 0.0032397, intercept 0.15872723.
  - Impact approximation: `Impact ≈ 2.13·KPR + 0.42·APR − 0.41` (APR = assists per round).
  - KAST is in **percent (0–100)**, from HLTV's "%" values with the sign stripped.
  - Method: linear regression with a train/test split on stats scraped from HLTV player profiles. Dataset size not stated.
  - Reported accuracy: **R² = 0.99510, RMSE = 0.00456, MAE = 0.00208**.
  - Caveat from the author: HLTV uses round-level data, teammate context and separate CT/T formulas, so the fit is approximate.
  - Source: [dave's site](https://dave.xn--tckwe/posts/reverse-engineering-hltv-rating/) (mirror of the original [flashed.gg post](https://flashed.gg/posts/reverse-engineering-hltv-rating/), which now returns a stub). CS Demo Manager links an [archived copy](https://web.archive.org/web/20241218023441/https://flashed.gg/posts/reverse-engineering-hltv-rating/).
- Implementations of the same constants:
  - cs-demo-analyzer `HltvRating2()` clamps negative results to 0. — [player.go](https://raw.githubusercontent.com/akiver/cs-demo-analyzer/main/pkg/api/player.go)
  - awpy `rating()` / `impact()` defaults are kast_coef 0.0073, kills_coef 0.3591, deaths_coef −0.5329, impact_coef 0.2372, adr_coef 0.0032, intercept 0.1587, and impact 2.13 / 0.42 / −0.41. — [awpy stats docs](https://awpy.readthedocs.io/en/latest/modules/stats.html)
- CS Demo Manager calls its 2.0 value "an estimated value and may not be 100% accurate as the official HLTV formula is private". — [CS Demo Manager docs: Demos analysis](https://cs-demo-manager.com/docs/guides/demos-analysis)
- Sardegna argues 2.0 still correlates strongly with K/D. — [Sardegna](https://chrissardegna.com/blog/problems-with-csgo-rating-systems/)

### Inferences
- The R² was measured on **career/profile aggregates**, which are large samples. Error on a single map, especially a Premier or FACEIT map, is likely much larger. No per-map validation was published.
- Dave's Impact proxy uses only KPR and APR. It ignores opening kills, clutches and multi-kills, even though HLTV's real Impact used them. A single-map 2.0 value will therefore miss clutch and opener effects.
- The formula is linear, so a session or day value is just the formula applied to the aggregated per-round stats. That equals the round-weighted mean of per-match values, except where the 0 clamp applies.

### Gaps
- Dave's dataset size, scrape date and per-side behavior are not documented.
- I found no published per-map accuracy study.

---

## Q4. Rating 2.1 (Oct 2024): what changed, and is there an approximation?

### Takeaway
2.1 kept 2.0's structure: five sub-ratings × two sides, formula private. It made the sub-ratings equally weighted, cut the reward for saving, retuned averages for CS2/MR12, and handled CS2's lower assist threshold. **I found no public reverse-engineered formula for 2.1**, and CS Demo Manager explicitly declined to build one.

### Cited Findings
- Statements from the 2.1 article ([HLTV: Introducing rating 2.1](https://www.hltv.org/news/40051/introducing-rating-21)):
  - "All five sub-ratings now have equal weight, after survival, impact, and KAST became too important in CS2 for rating 2.0."
  - "You no longer earn a KAST point from saving in lost rounds where you did not get a kill or an assist, and survival rating treats survivals in lost rounds as less impactful than in won rounds."
  - "Kill rating gives more value to openers and 'perfect' kills (those where the attacker receives 0 damage), and less to assisted kills."
  - "Impact is based on multi-kill rounds (with differing credit based on how many kills, assists, and deaths a player scored in one round), openers, and clutches."
  - "Assisted kills give more reward than in 2.0, because of 26 damage assists rather than 41."
  - "There are different averages behind all five sub-ratings on both sides of the map."
  - Averages retuned with one year of CS2 data; target is a 1.00 average "over a CS2 event (not map, or season)".
  - "The formula behind rating remains private, but we can reveal some elements."
  - Example: Jame went from 1.00 (2.0) to 0.88 (2.1) on one map because of saves in lost rounds.
- Secondary summary: 2.1 accounts for MR12, and CS2 assists changed "from 41 damage to 26". — [Dust2.in](https://www.dust2.in/news/54073/hltv-introduces-rating-21)
- CS Demo Manager on 2.1+: "The official HLTV formula is private and there is no plan to reverse-engineer it. Like for the HLTV 2.0 rating, if someone finds an accurate formula and make it public, it will be added to the application." — [CS Demo Manager docs](https://cs-demo-manager.com/docs/guides/demos-analysis)
- Searches for a 2.1 regression only turned up the 2.0 work. — e.g. [Medium: Approximating HLTV 2.0 in VALORANT](https://medium.com/@ferahgothegreat/approximating-hltvs-cs-go-2-0-rating-in-valorant-54e1e7224759)

### Inferences
- With no published coefficients, a "2.1" label in the app would be unfounded. The honest options are:
  - (a) Show the 2.0 approximation, labeled as such.
  - (b) Build a home-grown "2.1-style" rating: equal-weight sub-ratings, KAST that excludes saves in lost rounds, survival discounted in lost rounds, and perfect-kill and opener bonuses in kill rating. This would need its own normalization constants, so it must not be called HLTV 2.1.

### Gaps
- No public 2.1 coefficients, per-side averages or standard deviations exist.

---

## Q5. Rating 3.0 (Aug 2025, adjusted Oct 2025 and Oct 2026): components, methodology, reproducibility, and MM practicality

### Takeaway
3.0 = six sub-ratings, five of them eco-adjusted versions of the 2.1 family plus Multi-Kills, and a win-probability **Round Swing** metric.

- **Weights after the Oct 2025 update:** Kills 25%, Damage 15%, Multi-kills 4%, Round Swing 33%, Survival 15%, KAST 8%.
- **HLTV published:** the economy duel win-rate matrix, the inputs to each sub-rating, the swing credit rules (including a 5-second trade window) and the 40-damage assist rule.
- **HLTV did not publish:** the win-probability model, the per-map averages, or how raw metrics are scaled into sub-ratings.

A third party can therefore build a **3.0-style** rating, but cannot reproduce HLTV's numbers exactly.

### Cited Findings — structure and changelog (PUBLISHED, from [HLTV: Introducing Rating 3.0](https://www.hltv.org/news/42485/introducing-rating-30), 20 Aug 2025)
- Sub-ratings: Kills, Damage, Survival, KAST, Multi-Kills, Round Swing. "Impact replaced by a combination of Round Swing and Multi-Kill rating."
- "Kill, Damage, Survival, ratings are all eco-adjusted based on the win-rate of a duel based on the map, side, and equipment of the individuals involved."
- "KAST and Multi-Kill ratings are eco-adjusted based on the probability of a given action taking place given the map, side, equipment of the individual, and average equipment value of the opposing team."
- "Assists reset to CS:GO value of 40 damage for all purposes." Elsewhere the same article says "assists being 40 damage instead of 25".
- "We have added the concept of trade denials (two kills within 5 seconds), and failed trades (punishing the second player, and rewarding the first, if both die within 5 seconds) within the sub-ratings."
- **Economy categories:** "The calculation is based on the price of a player's armor plus their most expensive weapon." Groups: "Sniper, tier-one rifles, tier-two rifles, SMGs and shotguns, upgraded pistols, and starter pistols."
- "Only 44.7% of duels in Counter-Strike take place between players in the same economy category."
- **Kill points:** "on T side, a rifle vs rifle kill (48% win rate) counts as around 1.10 'kill points.' Killing a starter pistol (75% win rate) drops that figure to 0.54."
- **AWPs:** "AWPers win 56% of their duels against riflers on T side and 60% on CT side."
- **Duel win-rate matrix (PUBLISHED image, "Duel win-rate on T side across all maps in CS2. The lower the win%, the more points a player earns.").** Rows are T equipment value, columns are CT equipment value, values are T win %:

  | T \ CT | $4700+ | $3550–4700 | $2700–3550 | $1700–2700 | $1000–1700 | $0–1000 |
  |---|---|---|---|---|---|---|
  | $4700+ | 49.8 | 55.5 | 57.8 | 60.9 | 66.3 | 74.0 |
  | $3550–4700 | 39.6 | 48.0 | 51.1 | 56.2 | 61.3 | 74.8 |
  | $2700–3550 | 34.9 | 43.8 | 48.4 | 53.9 | 59.0 | 76.1 |
  | $1700–2700 | 33.3 | 38.8 | 41.9 | 48.2 | 55.7 | 74.0 |
  | $1000–1700 | 30.3 | 35.1 | 38.4 | 41.2 | 48.0 | 65.0 |
  | $0–1000 | 22.4 | 20.5 | 21.7 | 20.0 | 26.6 | 48.6 |

  Source: [HLTV 3.0 article image](https://www.hltv.org/news/42485/introducing-rating-30) (read directly from the gallery image).
- **Per-sub-rating inputs (PUBLISHED graphic in the same article).** "•" means a positive input and "—" means you lose points. Small text, read from the image:
  - **Round Swing:** "The player's direct impact on each round's win probability". Eco-adjusted on team equipment value. • win probability added (kill, damage share, flash assists, trades); • win probability deducted (deaths, trades).
  - **Survival:** "How hard it is to kill the player". Eco-adjusted on player and opponent individual equipment. — Deaths; Failed trades; Traded deaths; — Opening deaths; — Saves. The exact +/– marks on "failed trades" and "traded deaths" were hard to read.
  - **KAST:** "How consistent the player is round-to-round". • "Round with a kill, assist, survival in a won round, or a traded death".
  - **Multi-Kills:** "How frequently the player delivers big explosive moments". • 2ks, 3ks, 4ks, 5ks.
  - **Damage:** "How much raw damage the player deals to their opponents". • Damage.
  - **Kills:** "How frequently the player deals the final point of damage". • Kills, • Perfect kills, • Opening kills, — Assisted kills, • Trade denials.

### Cited Findings — Round Swing (PUBLISHED)
- Round Swing "looks at each kill and sees how much it changes a team's chance of winning the round. That includes each team's economic situation, whether the bomb is planted, how many players are alive on each team, and which map the player is on for targeted CT-T percentages." — [HLTV 3.0](https://www.hltv.org/news/42485/introducing-rating-30)
- "Share of credit is divided based on yes, who got the final point of damage, but also the damage share, flash assists, and if the kill was a trade." — [HLTV 3.0](https://www.hltv.org/news/42485/introducing-rating-30)
- **Magnitudes:**
  - Best players are around +4.0% per round over a season (donk +3.79%, ZywOo +3.69% in 2025); "mortals between -1.5% and +1.5%".
  - "If the opponent is on a full eco, and your win probability is 96%, your team can only gain +4% round swing in sum rather than the +50% of a regular 50-50 round."
  - "An opening kill is around +20%, but winning a one-on-one clutch might be +50%."
  - Example: a T double entry takes win probability from 48% to 89%. If three CTs then save, the Ts are credited the final 11%. "Because Round Swing is zero-sum, the saving players are punished the same as if they had lost that clutch."
  - Source: [HLTV 3.0](https://www.hltv.org/news/42485/introducing-rating-30)
- HLTV described Round Swing earlier (25 Sep 2025 per WebFetch) as assigning "a value to each kill based on how much it alters a team's probability of winning the round" with "knowledge of the economy, map, side, and players alive". The trade window is about 5 s, and HLTV noted it may later get a "decay". — [HLTV: Finding the most impactful CS2 players](https://www.hltv.org/news/42763/finding-the-most-impactful-cs2-players)
- **Oct 2025 swing changes** ([HLTV: Rating 3.0 adjustments go live](https://www.hltv.org/news/43047/rating-30-adjustments-go-live)):
  - Less weight on the final point of damage and more on "damage share, trades, and flash assists".
  - Clutches now include no-kill wins such as ninja defuses and running down the bomb timer.
  - Remaining swing at round end (time expiry, bomb explodes, bomb defused) used to go 100% to the clutcher, or else pro rata to positive kill swing. It is now split: "1x to the player doing a clutch, 2x to players with WPA from kills, 1x to the player defusing the bomb, 1x to players alive at round end".
  - HLTV admits 3.0 still lacks "game state, the HP of players, and the location of frags on the map".

### Cited Findings — Weights (PUBLISHED image in the Oct 2025 article)
- **Before (Aug 2025):** Kills 12%, Damage 12%, Multis 12%, Round Swing 40%, Survival 12%, KAST 12%.
- **After (29 Oct 2025):** Kills 25%, Damage 15%, Multis 4%, Round Swing 33%, Survival 15%, KAST 8%.
- Source: ["Rating 3.0 weights before and after" image in HLTV news #43047](https://www.hltv.org/news/43047/rating-30-adjustments-go-live) (read directly from the image).
- Kills 12→25 and Swing 40→33 match independent coverage. — [Dust2.us](https://www.dust2.us/news/67183/hltv-releases-update-for-rating-30)
- **Conflict note:** one WebFetch summary reported "Damage 12%, Swing 36%". That contradicts the HLTV image and is wrong.
- HLTV's rationale: "In rating 2.0, there was a 60-40 balance of output (kills, damage, Impact) versus the price players paid for that output (KAST, survival). The first version of 3.0 was slightly behind that (56-44)… we have now restored that 60-40 balance." — [HLTV #43047](https://www.hltv.org/news/43047/rating-30-adjustments-go-live)

### Cited Findings — Eco-adjusted display stats (PUBLISHED, Oct 2025)
- The non-swing part is "essentially an eco-adjusted version of 2.1 with five sub-ratings (Kills, Deaths, KAST, Damage, and Multi-Kills)". — [HLTV #43047](https://www.hltv.org/news/43047/rating-30-adjustments-go-live)
- **eK-eD:** players get "kill (and death) points" based on duel win %. "An anti-eco kill might be 0.50 eKPR, or a death with an AK against a Glock might be 1.50 eDPR… if you are favored in a duel, you are rewarded less for winning it and punished harder for losing it."
- **eADR** uses the same process.
- **eKAST** gives more "KAST points" based on how likely a KAST is in that economic situation.
- Eco-adjusted damage was made "kinder" to AWPers, and the strength of eco-adjusted KAST was "reduced significantly".
- An eco-adjustment toggle was added to match pages and scoreboards.
- Source for the four items above: [HLTV #43047](https://www.hltv.org/news/43047/rating-30-adjustments-go-live)

### Cited Findings — Reproducibility / open implementations
- HLTV does not publish the combining coefficients or the win-probability model. The 3.0 article says "far more goes into these sub-ratings than just the main figure you see". — [HLTV 3.0](https://www.hltv.org/news/42485/introducing-rating-30)
- Atehortuajf/eco-rating (Go) parses CS2 `.dem` files and computes an **independent** rating, not an HLTV replica:
  - Its own win-probability engine uses players alive, equipment values, bomb status and time remaining.
  - Rating = "1.0 (baseline) + adrContrib + kastContrib + probSwingContrib", with swing weighted 2.5×.
  - It reports 140+ stats and gives no accuracy comparison to HLTV.
  - Source: [GitHub: Atehortuajf/eco-rating](https://github.com/Atehortuajf/eco-rating)
- jacekasen/cs2 reportedly holds official HLTV per-map box scores (40,920 player-maps with ADR, KAST, Rating 2.0/3.0, Round Swing %). This is from a search snippet only, not verified. It could serve as ground truth for fitting an approximation. — [GitHub: jacekasen/cs2](https://github.com/jacekasen/cs2)
- An X/Twitter project (rdygg) built its own CS2 rating with "Duel swing. Round swing." on a 0–100 scale. Not HLTV-compatible. — [rdygg on X](https://x.com/rdygg_cs2/status/2037183806105399497)
- **Academic win-probability work:**
  - "Valuing Player Actions in Counter-Strike: Global Offensive" (Xenopoulos et al., IEEE Big Data 2020, the awpy author) defines Win Probability Added (WPA) from how actions change round-win probability, using over 70M CS:GO events. — [arXiv 2011.01324](https://arxiv.org/pdf/2011.01324)
  - A related paper compares professional and amateur play through win probability. — [ACM: Analyzing the Differences between Professional and Amateur Esports through Win Probability](https://dl.acm.org/doi/10.1145/3485447.3512277)
- Escorenews claims you get no swing increase if your team loses the round, even after kills. That conflicts with HLTV's per-kill win-probability-delta description, so treat it as unverified. — [Escorenews](https://escorenews.com/en/csgo/article/71475-how-hltv-rating-3-0-formula-actually-works-round-swing-and-eco-adjustment-explained) (403 on fetch; snippet only)

### Inferences (implementation design — NOT HLTV-published)
- **Eco kill/death points.** HLTV's examples fit `eKill ≈ 2·(1 − p)` and `eDeath ≈ 2·p`, where p = the killer's (or the victim's) pre-duel win probability from the matrix. Checks:
  - p = 0.75 → kill 0.50 and death 1.50, exactly HLTV's anti-eco numbers.
  - p = 0.48 → 1.04, versus HLTV's "around 1.10".
  - p = 0.75 → 0.50, versus HLTV's 0.54.
  
  The small gaps suggest a normalization factor of about 2.1–2.2 so the average kill is about 1.0. Index p by (side, killer equipment bin, victim equipment bin). The matrix is T-side; the CT view is 1 − T win%. Equipment = armor price + most expensive weapon held at the moment of the duel.
- **Round Swing approximation:**
  1. Train a round-win-probability model P(T wins | map, T alive, CT alive, T team equipment value, CT team equipment value, bomb planted, time remaining or bomb time left). Logistic regression or gradient boosting both work; this is Xenopoulos-style WPA.
  2. For each kill, ΔWP = WP_after − WP_before for the killer's team. The victim's team gets the mirror value (zero-sum).
  3. Split +ΔWP among teammates: final blow plus damage share on that victim (HLTV says less weight on the final blow since Oct 2025), plus flash-assist credit, plus trade credit (5 s window). Charge −ΔWP to the victim.
  4. At round end, give the remaining (1 − WP) to the winners in 1:2:1:1 shares (clutcher : kill-swing holders : defuser : alive players). Apply the Oct 2026 rule: once a planted bomb cannot be defused (no kit and <10 s left), treat the round as decided.
  5. Report swing as a mean % per round.
- **Combining.** Map each raw metric to a sub-rating centered at 1.00, e.g. `1 + k·(x − μ_side)/σ_side` (2.0 used SD-based scaling). Then `Rating3_style = 0.25·Kills + 0.15·Damage + 0.04·Multi + 0.33·Swing + 0.15·Survival + 0.08·KAST`. μ and σ are not public. They have to be estimated from a reference population: pro demos for HLTV-like calibration, or the app's own MM data for a lobby-relative rating.
- **Practicality for Premier/FACEIT:**
  - Every input is available from demos: kills, damage, flash assists, equipment values, bomb events, alive counts and timers.
  - The hard part is the win-probability model and calibration. Training on a few thousand parsed rounds is feasible. A 5-player group's own matches may be too small and biased a sample, so training on public pro demos or a broad FACEIT set is better.
  - Amateur round dynamics differ from pro (see the ACM paper title), so a pro-calibrated model will be biased for MM.
  - Bottom line: a "3.0-style" rating is practical; an "HLTV 3.0-accurate" rating is not.

### Gaps
- The exact WP model, the per-map averages and SDs, the sub-rating scaling, and the precise credit-split percentages for final blow vs damage share vs flash are not published.
- Exact Oct 2026 constant changes are unverified (Cloudflare).
- I found no open-source project that claims to reproduce HLTV 3.0 numerically.

---

## Q6. Which version should a third-party app display, and is there a naming/trademark issue?

### Takeaway
"HLTV" is a brand owned by Better Collective, which acquired HLTV.org ApS in 2020 and has applied to register the HLTV word mark. The formulas behind 2.0, 2.1 and 3.0 are private. The defensible approach is:
1. Show the reproducible 2.0 approximation, and optionally the exact 1.0, under neutral names such as "Rating 2.0 (HLTV-style, est.)".
2. Optionally add a home-grown "3.0-style" impact rating built from HLTV's published principles.
3. Do not present any number as "HLTV Rating", especially not "3.0", because it will not match HLTV and could imply endorsement.

### Cited Findings
- Better Collective acquired HLTV.org in February 2020. — [GlobeNewswire: Better Collective acquires HLTV.org](https://www.globenewswire.com/news-release/2020/02/28/1992842/0/en/Better-Collective-acquires-leading-esports-platform-HLTV-org.html)
- A US trademark application for "HLTV" by Better Collective A/S exists (serial 90478034, filed January 2021 per search summary). Registration status and classes could not be verified because Justia returned 403. — [Justia Trademarks: HLTV 90478034](https://trademarks.justia.com/904/78/hltv-90478034.html)
- Precedent naming:
  - CS Demo Manager uses "HLTV 2.0 rating" and calls it "an estimated value". — [CS Demo Manager docs](https://cs-demo-manager.com/docs/guides/demos-analysis)
  - awpy describes its function as a rating "similar to HLTV". — [awpy docs](https://awpy.readthedocs.io/en/latest/modules/stats.html)
- HLTV states that all of its CS2 ratings are tuned to average 1.00 "over a CS2 event" of pro play. — [HLTV 2.1](https://www.hltv.org/news/40051/introducing-rating-21); [HLTV 3.0](https://www.hltv.org/news/42485/introducing-rating-30)

### Inferences
- Recommended UI:
  - Headline: "Rating 2.0 (est.)" from Dave's formula.
  - Tooltip: "community approximation of HLTV Rating 2.0; HLTV.org now uses Rating 3.0 (private formula)".
  - Optional "Impact / Swing" and eco-adjusted K-D (eK-eD) columns built from HLTV's published duel matrix and credited as "methodology inspired by HLTV Rating 3.0".
- In a 10-player MM lobby, kills ≈ deaths, so any of these ratings will average about 1.0 per lobby by construction. That makes them good for comparing within a party, but they are not comparable to pro HLTV numbers.
- This is not legal advice. Nominative use ("approximates HLTV Rating 2.0") is common practice (CSDM, awpy), but the developer should check the HLTV/Better Collective terms if the app is monetized.

### Gaps
- Exact trademark registration status, classes and jurisdictions (EU/DK) are unverified.
- HLTV's terms of use regarding the rating name were not reviewed (Cloudflare blocked the site).

---

## Q7. Implementation definitions (from CS2 demo events)

### Takeaway
HLTV defines these stats only loosely. The concrete, sourced rules are:
- 5 s trade window (HLTV 3.0, cs-demo-analyzer).
- Assists at 40 damage under 3.0; CS2's native assist threshold is described by HLTV as 25/26.
- KAST under 2.1/3.0 excludes saves in lost rounds.
- A perfect kill means the attacker took 0 damage.
- Clutch wins under 3.0 can be kill-less.
- ADR in open-source tools uses actual health damage.

### Cited Findings
- **Trade window:**
  - HLTV 3.0 trade denial and failed trade = two kills or deaths "within 5 seconds". — [HLTV 3.0](https://www.hltv.org/news/42485/introducing-rating-30)
  - cs-demo-analyzer: `tradeKillDelaySeconds = 5` ("Maximum number of seconds between a teammate death and a possible revenge kill to be considered as a trade kill"). A trade is a kill whose victim killed the trader's teammate within that window; it sets both `IsTradeKill` and `IsTradeDeath`. — [analyzer.go](https://raw.githubusercontent.com/akiver/cs-demo-analyzer/main/pkg/api/analyzer.go); [kill.go](https://raw.githubusercontent.com/akiver/cs-demo-analyzer/main/pkg/api/kill.go)
  - awpy defaults are inconsistent: `calculate_trades(trade_length_in_seconds=5.0)` but `kast(trade_length_in_seconds=3.0)` per its docs. — [awpy stats docs](https://awpy.readthedocs.io/en/latest/modules/stats.html)
- **KAST:**
  - Classic definition: % of rounds with a Kill, Assist, Survival, or Traded death. — [HLTV 2.0](https://www.hltv.org/news/20695/introducing-rating-20)
  - 2.1 change: "no longer earn a KAST point from saving in lost rounds where you did not get a kill or an assist". — [HLTV 2.1](https://www.hltv.org/news/40051/introducing-rating-21)
  - 3.0 graphic: "Round with a kill, assist, survival in a won round, or a traded death". — [HLTV 3.0](https://www.hltv.org/news/42485/introducing-rating-30)
  - cs-demo-analyzer returns KAST as 0–100 and excludes team kills. — [player.go](https://raw.githubusercontent.com/akiver/cs-demo-analyzer/main/pkg/api/player.go)
- **Assists:**
  - 2.0 used CS:GO 41-damage assists; 2.1 used CS2's "26 damage assists rather than 41". — [HLTV 2.1](https://www.hltv.org/news/40051/introducing-rating-21)
  - 3.0: "Assists reset to CS:GO value of 40 damage for all purposes" (it also refers to CS2 assists as "25 damage"). — [HLTV 3.0](https://www.hltv.org/news/42485/introducing-rating-30)
- **ADR:**
  - cs-demo-analyzer ADR = `HealthDamage / rounds`. Health damage only; armor and utility damage are tracked separately. — [player.go](https://raw.githubusercontent.com/akiver/cs-demo-analyzer/main/pkg/api/player.go)
  - awpy ADR sums `dmg_health_real` and has `team_dmg` / `self_dmg` flags (`self_dmg=True` drops events with no attacker). Rounds come from `player_round_totals`. The docs' description of the `team_dmg` default is ambiguous. — [awpy adr.py](https://raw.githubusercontent.com/pnxenopoulos/awpy/main/awpy/stats/adr.py); [awpy docs](https://awpy.readthedocs.io/en/latest/modules/stats.html)
- **Impact:**
  - HLTV 2.x Impact = multi-kill rounds (credit varies with kills, assists and deaths in the round), openers, and clutches. — [HLTV 2.1](https://www.hltv.org/news/40051/introducing-rating-21)
  - Community proxy: `2.13·KPR + 0.42·APR − 0.41`. — [Dave](https://dave.xn--tckwe/posts/reverse-engineering-hltv-rating/)
  - Impact was removed in 3.0. — [HLTV 3.0](https://www.hltv.org/news/42485/introducing-rating-30)
- **Perfect kill:** "those where the attacker receives 0 damage". — [HLTV 2.1](https://www.hltv.org/news/40051/introducing-rating-21)
- **Opening kills:**
  - 2.1 rewarded opening kills more than it punished opening deaths. In 3.0, "opening deaths [are] punished as much as opening kills are rewarded". — [HLTV 3.0](https://www.hltv.org/news/42485/introducing-rating-30)
  - HLTV's individual stats show "Opening kill ratio", "Opening kill rating", "Team win percent after first kill" and "First kill in won rounds". Example: m0NESY at 74.8% / 19.5% / 1.23. — [HLTV m0NESY individual stats](https://www.hltv.org/stats/players/individual/19230/m0nesy) (search snippet)
- **Clutches:**
  - Since 3.0, clutch requirements allow kill-less wins such as ninja defuses or running down the bomb timer. HLTV can manually override bad clutch attributions. — [HLTV #43047](https://www.hltv.org/news/43047/rating-30-adjustments-go-live)
  - The Clutching attribute uses "last alive %" and "clutch points". — [HLTV attributes](https://www.hltv.org/news/39672/introducing-hltv-attributes)
- **Multi-kills:** count rounds with exactly n kills (1–5), excluding suicides and team kills. — [cs-demo-analyzer](https://raw.githubusercontent.com/akiver/cs-demo-analyzer/main/pkg/api/player.go)
- **Flash assists:** the cs-demo-analyzer Kill struct carries `IsAssistedFlash`, along with `IsHeadshot`, `IsThroughSmoke`, `IsNoScope`, `IsKillerBlinded` and others. — [kill.go](https://raw.githubusercontent.com/akiver/cs-demo-analyzer/main/pkg/api/kill.go)
- **Equipment value** for eco-adjustment = armor price + most expensive weapon. — [HLTV 3.0](https://www.hltv.org/news/42485/introducing-rating-30)

### Inferences (recommended rules for the app)
- **Kills/deaths:** exclude team kills and suicides from K. Count suicides and world deaths as deaths.
- **ADR:** use health damage capped at the victim's remaining HP, excluding teammates and self, divided by rounds played.
- **KAST:** use a 5 s trade window. Keep two variants:
  - "classic KAST": survival in any round counts.
  - "HLTV-2.1/3.0 KAST": survival counts only in won rounds unless the player had a K or A.
- **Assists:**
  - Use the demo's `player_death.assister` (CS2 native) for display.
  - For a 3.0-style rating, recompute assists as ≥41 damage to the victim in the round. CS:GO's 40-damage rule meant more than 40.
  - Flash assists come from `assistedflash`.
- **Opening duel:** the first kill of the round. Entry success = opening kills / (opening kills + opening deaths).
- **Trade kill:** you kill an enemy who killed your teammate in the previous 5 s.
- **Traded death:** your killer dies to your teammate within 5 s.
- **Clutch 1vX:** you are the last alive on your team with X enemies alive. It counts as won if your team wins the round, including by defuse or by time.
- **Utility damage:** HE + molotov/incendiary health damage.
- **HS%:** headshot kills / kills.
- These are standard community conventions. HLTV's exact edge-case handling is not published.

### Gaps
- HLTV's exact ADR handling (cap, team damage) and its exact clutch-start condition are not published.
- Whether HLTV's displayed KAST % (as opposed to the KAST sub-rating) uses the "won rounds only" survival rule is unclear.

---

## Q8. Full list of stats on an HLTV player profile / stats page (3.0 era)

### Takeaway
The 3.0-era stats page has five parts:
1. **Header:** Rating 3.0 with T and CT ratings, plus six tiles: Round Swing, DPR, KAST, Multi-kill, ADR, KPR. Each tile has a colored bar showing the sub-rating, and there are "Show player average" and "Eco-adjust stats" toggles.
2. **Seven style attributes** scored 0–100: Firepower, Entrying, Trading, Opening, Clutching, Sniping, Utility. They have side and per-round / per-24-round filters and dropdowns covering 22 underlying metrics.
3. **Classic statistics table.**
4. **Individual page:** opening stats, weapon kills, multi-kill rounds.
5. **Match scoreboards:** swing, 3.0, openers, multis, clutches, plus an eco-adjust toggle.

### Cited Findings
- **Header (ZywOo 2025 example image in the 3.0 article):**
  - "114 maps", "Show player average" toggle, "Eco-adjust stats" toggle.
  - T RATING 1.35, RATING 3.0 1.33 with a "GOOD" gauge, CT RATING 1.32.
  - ROUND SWING +3.69%, DPR 0.58, KAST 79.1%, MULTI-KILL 22.4%, ADR 88.8, KPR 0.85.
  - Source: [HLTV 3.0 article image](https://www.hltv.org/news/42485/introducing-rating-30)
  - The article adds: "Multi-Kill rating has gone where Impact was, while a new space has been added for Round Swing." "The red-yellow-green bars underneath each metric relate to a player's sub-rating in that category, not the metric you can see." The eco toggle shows eco-adjusted figures. — [HLTV 3.0](https://www.hltv.org/news/42485/introducing-rating-30)
- **Match pages:** "you will be able to see swing and 3.0 on the scoreboard. We have also added openers, multis, and clutches to match result box scores". The performance tab and MVP boxes show multi-kill rating and Round Swing. — [HLTV 3.0](https://www.hltv.org/news/42485/introducing-rating-30)
  - The eco toggle shows eK-eD, eADR and eKAST. — [HLTV #43047](https://www.hltv.org/news/43047/rating-30-adjustments-go-live)
- **Attributes (introduced 21 Aug 2024, NER0cs):**
  - Seven categories scored 0–100; "50 is the average score for a top-tier professional player, based on CS2 averages over one event".
  - Side filter (T / CT / both) and "per round, or per 24 rounds".
  - Clicking a score opens a dropdown of advanced stats, such as how often a player is last alive, kills and damage in round wins, opening kills with the AWP, saving stats, and trade kills per 24 rounds. There are "22 new metrics".
  - Category definitions:
    - **Firepower:** kills, damage, multi-kills (raw output).
    - **Entrying:** traded-death stats.
    - **Trading:** traded and assisted kills.
    - **Opening:** opening kills and attempts.
    - **Clutching:** last-alive % and clutch points.
    - **Sniping:** Scout and AWP kills.
    - **Utility:** flashbang usage, flash assists, utility damage.
  - "This is about showing what a player does most often, and not really about how good they are."
  - Source: [HLTV: Introducing HLTV attributes](https://www.hltv.org/news/39672/introducing-hltv-attributes) (full text read in browser)
  - The 3.0 article says eco-adjustment and round swing will later be integrated into attributes. — [HLTV 3.0](https://www.hltv.org/news/42485/introducing-rating-30)
  - Secondary source: Entrying also uses "saved by teammate per round". — search snippet via [Dust2.in](https://www.dust2.in/news/51999/hltv-attributes-up-and-running)
- **Classic statistics table** (labels from HLTV stats-page search snippets and an HLTV scraper's columns): Total kills, Headshot %, Total deaths, K/D Ratio, Damage / Round, Grenade dmg / Round, Maps played, Rounds played, Kills / round, Assists / round, Deaths / round, Saved by teammate / round, Saved teammates / round, Rating. — [HLTV stats pages (search results)](https://www.hltv.org/stats/players/7998/s1mple); [jparedesDS/hltv-scraper fields](https://github.com/jparedesDS/hltv-scraper)
- **Individual page:**
  - Opening stats: Total opening kills, Total opening deaths, Opening kill ratio, Opening kill rating, Team win percent after first kill, First kill in won rounds.
  - Weapon kills: Rifle, Sniper, SMG, Pistol.
  - Source: [HLTV individual stats (snippet)](https://www.hltv.org/stats/players/individual/19230/m0nesy); [jparedesDS scraper](https://github.com/jparedesDS/hltv-scraper)

### Inferences
- The Multi-kill % tile (22.4% for ZywOo at 0.85 KPR) is most plausibly the share of rounds with 2+ kills.
- "Saved teammates/round" is plausibly kills on an enemy who just damaged a teammate (who then survived), and "saved by teammate/round" is the reverse. HLTV does not define either publicly as far as I found.
- Mirror plan for the app:
  - Header: Rating (chosen version), T/CT split, KPR, DPR, ADR, KAST, Multi-kill %, Swing %.
  - Attribute-like bars computed as percentiles within the user's own dataset.

### Gaps
- I could **not** read a live HLTV stats page (Cloudflare "Performing security verification"; I did not attempt to bypass it). As a result:
  - The exact list and labels of the 22 attribute-dropdown metrics are unverified.
  - The full tab list (likely Overview / Individual / Clutches / Matches / Events / Career / Weapons / Opponents, from memory) is unverified.
  - The exact current labels on the classic table and the individual page beyond the snippets cited are unverified.
- The 0–100 attribute scoring method (percentile vs other) is not disclosed.

---

## Q9. Existing open-source implementations from CS2 demos

### Takeaway
- **Rating 1.0 (exact):** akiver/cs-demo-analyzer, which is the Go engine behind CS Demo Manager.
- **Rating 2.0 (Dave approximation):** cs-demo-analyzer and pnxenopoulos/awpy (Python).
- **2.1:** no implementation; CSDM refuses to reverse-engineer it.
- **3.0:** no faithful open implementation. Only independent swing-style ratings exist, e.g. Atehortuajf/eco-rating.

### Cited Findings
- **akiver/cs-demo-analyzer (Go):**
  - `HltvRating()` = exact 1.0.
  - `HltvRating2()` = Dave's 2.0 approximation, with `impact()` proxy and negative values clamped to 0.
  - KAST 0–100, ADR from health damage, 5 s trades.
  - Source: [player.go](https://raw.githubusercontent.com/akiver/cs-demo-analyzer/main/pkg/api/player.go); [Go docs](https://pkg.go.dev/github.com/akiver/cs-demo-analyzer/pkg/api)
- **CS Demo Manager:** shows HLTV 2.0 as an estimate and has "no plan" for 2.1+. — [docs](https://cs-demo-manager.com/docs/guides/demos-analysis)
  - Earlier issues show the maintainer declined to reverse-engineer 2.0 in 2017 and adopted Dave's formula after it was published in 2021. — [Issue #498](https://github.com/akiver/cs-demo-manager/issues/498); [Issue #225](https://github.com/akiver/cs-demo-manager/issues/225)
- **pnxenopoulos/awpy (Python, CS2):** `awpy.stats.adr`, `kast`, `calculate_trades`, `impact`, `rating` with Dave's defaults ("similar to HLTV"). — [awpy docs](https://awpy.readthedocs.io/en/latest/modules/stats.html); [GitHub](https://github.com/pnxenopoulos/awpy)
- **Atehortuajf/eco-rating (Go, CS2):** independent probability-swing rating plus 140+ stats; not an HLTV replica. — [GitHub](https://github.com/Atehortuajf/eco-rating)
- **jacekasen/cs2:** pipeline/dataset of official HLTV box scores, including 3.0 and Round Swing %. From search snippet; unverified. — [GitHub](https://github.com/jacekasen/cs2)
- **Academic:** the WPA framework (Xenopoulos et al. 2020) is the closest published method to Round Swing. — [arXiv 2011.01324](https://arxiv.org/pdf/2011.01324)

### Inferences
- Fastest path for the app:
  1. Reuse cs-demo-analyzer's (MIT/GPL — check the license) or awpy's 1.0 / 2.0 functions, or port them, since they are short formulas.
  2. Add a custom WPA model plus HLTV's published duel matrix for a "3.0-style" Swing and eK-eD.
  3. If HLTV-like calibration matters, fit μ/σ against an HLTV ground-truth dataset (e.g. jacekasen/cs2 box scores paired with public pro demos).

### Gaps
- License terms of cs-demo-analyzer and awpy were not checked.
- jacekasen/cs2's contents were not verified first-hand.
