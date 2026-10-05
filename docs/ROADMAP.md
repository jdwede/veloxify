# Veloxify roadmap

Priorities, in order. Each phase ships something usable before the next starts.

## 1. Highlights (now)

- Auto-detected highlights for **you only** (teammates opt-in), rendered silently in the
  background after a session from FACEIT and Premier demos, Allstar-style by default and
  configurable (HUD, crosshair, graphics, resolution, transitions).
- Calendar → day → CS2-style match history → match scoreboard + stats → highlights.
- Highlight rules (from the player, 9,000 h / ex semi-pro):
  - Always: 3K/4K/ACE (eco kills included), any won clutch (incl. T-side win after the
    clutcher dies and the bomb explodes), ninja defuses, noscopes, knife kills, grenade-impact
    kills, jumping/falling kills, 2+ kills with Deagle/R8/Scout (Scout ranked by damage).
  - When it matters: 2K including the opening kill in a won round; 2K in a critical round
    (overtime, 10-10+ within one, enemy match point, our match point vs 10+); reaction flick
    (hit first, then a fast snap onto the enemy). Eco kills don't count toward a 2K.
  - Never: plain single kills; lost clutches (even with kills).
  - "Clutch" = a won 1vX round, by any means. Eco = enemy equipment under $2,000 (not in
    pistol rounds).

## 2. Stats (Leetify, minus the clutter)

- Match history → click a match → stats → its highlights. Nothing more by default.
- Default window: last 30 matches; any period selectable.
- HLTV-style numbers people already understand (Rating 1.0 exact, Rating 2.0 est., ADR, KAST,
  K/D, HS%, entries, clutches, multi-kills).
- **Profile page** (main page, old-Leetify layout): Aim / Utility / Positioning / Opening duels /
  Clutching bars scored against the players in your own lobbies (50 = lobby average); dials for
  win rate, rating and RWS; T and CT ratings; solo / 2-4 stack / 5 stack mix; Premier rating;
  per-match form chart. Done; still to come:
  - Rating 3.0 est. replacing 2.0 est. (round-swing model from a win-probability table).
  - Aim from tick data: reaction time and crosshair placement (Aim is "beta" until then).
- **FACEIT, found automatically** (done): the account linked to the user's Steam ID is looked up on
  FACEIT's public profile endpoints, so there is nothing to connect (no key, no login). Level,
  ELO, ELO trend and FACEIT stats show on the profile; match history lists every recent FACEIT
  match, with FACEIT's stats until the demo is in the library; demos get FACEIT's real start
  times and ELO change. Still to come: stats-only matches in the calendar/day views, and
  semi-automatic demo download through an embedded FACEIT login (the user signs in themselves;
  FACEIT's demo links need a signed-in download).
- **Platform weighting:** FACEIT stats matter most (especially level 10+ and Challenger,
  top 1,000). Premier counts less. Anything that isn't FACEIT, Premier or Competitive is
  "casual": hidden or greyed out, never mixed into ratings.
- **Velox rating** (to design): one number that means something in plain terms and accounts for
  the strength of the opposition, unlike an unexplained "80 aim". Ideas: opponent-strength
  adjustment from FACEIT ELO / Premier rating of the lobby; express it relative to a reference
  population ("plays like a FACEIT level 9").

## 3. Legit score (cheater detection)

Every player on every scoreboard gets a plain-English verdict, e.g. "95% likely legit" or
"5% likely legit: most likely cheating". Valve and Leetify are too conservative; some stat
lines
are effectively impossible legitimately (five Scout wallbang headshots in a game, consistently
30+ kills, never caught off guard).

Legit score = **Reputation** + **Overwatch**.

- **Reputation** (cheap, from public data):
  - Steam account age (older = more likely legit)
  - Games owned and inventory/skin value
  - FACEIT account and history: a god in Premier (top 3%, great stats) with a level-5 FACEIT
    and few matches or poor FACEIT stats is a red flag
  - Friend count (accounts people care about)
- **Overwatch** (gameplay analysis from the demo):
  - Quick and dirty first: statistical outliers (wallbang/through-smoke kill rates, headshot
    rates, reaction times, kills per round vs. lobby, "never caught off guard").
  - Deep dive on demand for a suspected player:
    - Aim: non-human mouse paths (instant snaps at the end of a movement, robotic lock-on,
      unnatural smoothing).
    - Information: rebuild what each team legitimately knew at every moment (teammates' sight
      lines, radar spots, sounds: footsteps, reloads, grenade throws/bounces/drops, utility seen
      in flight) and flag players who keep acting on information their team didn't have:
      prefiring/tracking through walls and smokes, rotating early with no info, always facing
      where the action will be.

## Later

- **Grenade lineups:** extract every throw (position, view angles, movement and jump state, where
  it landed), classify the technique (standing, jump-throw, run-throw, crouch), tell real
  lineups (repeated across games) from on-the-fly throws, show them on a 2D map, and render each
  unique lineup once while the PC is idle.
- **Pro lineups browser:** T1 events only (Valve's VRS standings on GitHub for team tiers,
  Liquipedia's API for events). Demos come from HLTV through a download the user starts in their
  own browser; no scraping.
- **FACEIT / ESEA league browser:** season leaders (RWS, ADR, kills), top teams, and a division
  browser with each team's average ELO and record, opened on the user's own team and division.
- **Drag-and-drop demo import** for any .dem (scrims, other platforms).
- **Start with Windows** and a Start-menu shortcut; a Settings page.
