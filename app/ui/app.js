// Veloxify UI. Reads the library written by the backend (index.json + matches/<id>.json)
// and renders: calendar → day (CS2-style match history) → day stats / match scoreboard / clips.
// Runs inside the Tauri window; for development it also works from any static file server.
"use strict";

// In the desktop app the library lives wherever the app keeps it (asked over IPC) and files are
// served through Tauri's asset protocol; the dev preview serves the repo root instead.
const tauri = window.__TAURI__;
let LIB = null;
async function initLib() {
  if (LIB) return;
  LIB = tauri ? await tauri.core.invoke("library_root")
    : window.CS2HL_LIBRARY || (location.pathname.includes("/app/ui/") ? "../../library" : "library");
}
const assetUrl = (rel) => (tauri ? tauri.core.convertFileSrc(`${LIB}\\${rel.replaceAll("/", "\\")}`) : `${LIB}/${rel}`);

const state = { index: null, faceit: null, matches: new Map(), details: new Map(), benchmarks: undefined, myStats: undefined, avatars: new Map(), rosters: new Map(), month: null, playlist: [], playing: -1 };
const BROWSER_DEFAULTS = { heroPeriod: "week", sort: "best", when: "all", from: "", to: "", source: "all", map: "all", types: [], playableOnly: true, hideEco: false, preset: "", tags: [], folder: "" };
let browser = { ...BROWSER_DEFAULTS };
try { browser = { ...BROWSER_DEFAULTS, ...JSON.parse(localStorage.getItem("veloxify.browser") || "{}") }; } catch (e) { /* defaults */ }
const saveBrowser = () => { try { localStorage.setItem("veloxify.browser", JSON.stringify(browser)); } catch (e) { /* not persisted */ } };

// ---- data ----------------------------------------------------------------------------------------

// "vs eco": most of a highlight's kills were on players who'd saved (under $2,000 of equipment,
// pistol rounds aside). Tagged so they're easy to spot or hide; works for clips analyzed before
// the tag existed too.
const ECO_TAG = "vs eco";
function tagEco(h) {
  const kills = h.kills ?? h.details?.kills ?? 0, eco = h.eco_kills ?? h.details?.eco_kills ?? 0;
  if (kills > 0 && eco * 2 >= kills && !h.tags.includes(ECO_TAG)) h.tags.push(ECO_TAG);
  return h;
}
const tagHtml = (t, extra = "") => `<span class="tag ${t === ECO_TAG ? "eco" : ""} ${extra}">${esc(t)}</span>`;

async function loadIndex() {
  const res = await fetch(assetUrl("index.json"), { cache: "no-store" });
  if (!res.ok) throw new Error(`index.json: ${res.status}`);
  state.index = await res.json();
  state.index.highlights.forEach(tagEco);
  // FACEIT account and match list (written by the app; absent until the first lookup).
  try {
    const f = await fetch(assetUrl("faceit.json"), { cache: "no-store" });
    state.faceit = f.ok ? await f.json() : null;
  } catch (e) {
    state.faceit = null;
  }
  // Your folders and deleted clips (written by the app; absent until you make a folder).
  try {
    const c = await fetch(assetUrl("curation.json"), { cache: "no-store" });
    state.curation = c.ok ? await c.json() : null;
  } catch (e) {
    state.curation = null;
  }
  state.curation = { folders: [], deleted: [], evicted: [], ...(state.curation || {}) };
  mergeFaceit();
}

const SESSION_GAP_S = 6 * 3600; // same as the backend's session grouping (a night's sleep)
const pad2 = (n) => String(n).padStart(2, "0");
const localIso = (ts) => { const d = new Date(ts * 1000); return `${iso(d)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; };

// Library matches plus FACEIT matches whose demo isn't processed yet ("stats only"), grouped into
// days and sessions like the backend does. FACEIT's list refreshes while CS2 is open, so a
// session's finished matches show up between games; demos and clips are processed afterwards.
function mergeFaceit() {
  const fms = new Map((state.faceit?.matches || []).map((fm) => [faceitLibId(fm), fm]));
  const all = state.index.matches.map((m) => {
    const fm = fms.get(m.id) || null;
    fms.delete(m.id);
    // FACEIT's start time (the index has it too once rebuilt; demo files only know the download time).
    const ts = fm && fm.finished_ts ? fm.started_ts || fm.finished_ts - m.duration_s : m.played_ts;
    return { ...m, faceit: fm, played_ts: ts, played_at: ts === m.played_ts ? m.played_at : localIso(ts) };
  });
  for (const [id, fm] of fms) {
    const ts = fm.started_ts || fm.finished_ts;
    all.push({
      id, stats_only: true, source: "faceit", map: fm.map, played_ts: ts, played_at: localIso(ts),
      duration_s: fm.started_ts && fm.finished_ts > fm.started_ts ? fm.finished_ts - fm.started_ts : 0,
      score_mine: fm.score_mine, score_theirs: fm.score_theirs, result: fm.result, highlight_count: 0,
      elo: fm.elo ?? null, elo_delta: fm.elo_delta ?? null, faceit: fm,
      line: { kills: fm.kills, assists: fm.assists, deaths: fm.deaths, adr: fm.adr, hs_pct: fm.hs_pct, kpr: fm.kr, kd: fm.kd, mvps: fm.mvps, faceit_only: true },
    });
  }
  all.sort((a, b) => a.played_ts - b.played_ts);
  state.all = all;
  state.byId = new Map(all.map((m) => [m.id, m]));

  const sessions = [];
  let lastEnd = -Infinity;
  for (const m of all) {
    if (!sessions.length || m.played_ts - lastEnd > SESSION_GAP_S) sessions.push([]);
    sessions[sessions.length - 1].push(m);
    lastEnd = m.played_ts + (m.duration_s || 0);
  }
  const byDate = new Map();
  for (const ss of sessions) {
    const date = ss[0].played_at.slice(0, 10); // late-night sessions stay on the day they began
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(ss);
  }
  const indexDays = new Map(state.index.days.map((d) => [d.date, d]));
  state.days = [...byDate].sort(([a], [b]) => a.localeCompare(b)).map(([date, list]) => ({
    date,
    sessions: list.map((ss) => ({
      match_ids: ss.map((m) => m.id),
      wins: ss.filter((m) => m.result === "win").length,
      losses: ss.filter((m) => m.result === "loss").length,
      ties: ss.filter((m) => m.result !== "win" && m.result !== "loss").length,
    })),
    highlight_count: sum(list.flat().map((m) => m.highlight_count || 0)),
    stats_only: list.flat().filter((m) => m.stats_only).length,
    // Session totals for you and your party come from demos only.
    players: indexDays.get(date)?.players || [],
  }));
}

async function loadMatch(id, fresh = false) {
  if (fresh || !state.matches.has(id)) {
    const res = await fetch(assetUrl(`matches/${id}.json`), { cache: "no-store" });
    const m = await res.json();
    m.highlights.forEach(tagEco);
    state.matches.set(id, m);
  }
  return state.matches.get(id);
}

const dayOf = (date) => state.days.find((d) => d.date === date);
const summaryOf = (id) => state.byId.get(id);
const dayMatchIds = (day) => day.sessions.flatMap((s) => s.match_ids);

// ---- formatting ----------------------------------------------------------------------------------

const MAPS = {
  de_mirage: ["Mirage", "#8a5a2b"], de_inferno: ["Inferno", "#8c3b2a"], de_nuke: ["Nuke", "#3c6e8f"],
  de_ancient: ["Ancient", "#3f6b3a"], de_anubis: ["Anubis", "#9b7a3c"], de_dust2: ["Dust II", "#a8844c"],
  de_train: ["Train", "#55606b"], de_overpass: ["Overpass", "#4f6e5a"], de_vertigo: ["Vertigo", "#4a5d8f"],
  de_office: ["Office", "#5d6670"], cs_italy: ["Italy", "#8b6a4a"], cs_office: ["Office", "#5d6670"], de_cache: ["Cache", "#6b6f4a"],
};
const mapName = (m) => {
  if (MAPS[m]) return MAPS[m][0];
  const s = m.replace(/^(de|cs|ar)_/, "").replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
};
const mapColor = (m) => (MAPS[m] ? MAPS[m][1] : "#3b4652");

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const parseLocal = (s) => new Date(s); // backend writes local time without offset
const fmtTime = (s) => parseLocal(s).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const fmtDate = (d) => {
  const date = new Date(`${d}T12:00:00`);
  const opts = { weekday: "long", month: "long", day: "numeric" };
  if (date.getFullYear() !== new Date().getFullYear()) opts.year = "numeric"; // older matches need the year
  return date.toLocaleDateString([], opts);
};
const fmtDur = (s) => `${Math.round(s / 60)} min`;
// Long spans in hours: "4h 41m" (under an hour stays "41 min").
const fmtSpan = (minutes) => {
  const m = Math.round(minutes);
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `${m} min`;
};
const fmtClip = (s) => { const t = Math.round(s); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`; };
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const f1 = (x) => x.toFixed(1);
const f2 = (x) => x.toFixed(2);
// How good a number is, as a class g0 (great, green) .. g4 (poor, red).
const GRADES = {
  rating: [1.2, 1.05, 0.95, 0.85], rws: [13, 11, 9, 7], win: [0.6, 0.53, 0.47, 0.4],
  kd: [1.3, 1.1, 0.9, 0.75], kpr: [0.85, 0.75, 0.62, 0.52], adr: [95, 82, 70, 60], kast: [80, 73, 66, 58],
  // Round Swing, % per round: 0 is neutral (it's zero-sum).
  swing: [1.5, 0.5, -0.5, -1.5],
  // Generally accepted marks (percent): opening duels and all duels won (the average is 50% by
  // definition, so 58%+ is excellent), headshot kills.
  open: [58, 53, 47, 42], duels: [56, 52, 48, 44], hs: [55, 48, 35, 28],
};
const GRADE_COLORS = ["#2fd36f", "#9ddb8c", "var(--text)", "#f3a5a0", "#ff5252"];
// A kind without thresholds is plain (average), never an error that blanks the page.
const gradeOf = (kind, v) => (GRADES[kind] ? GRADES[kind].filter((t) => v < t).length : 2);
const ratingClass = (r) => `g${gradeOf("rating", r)}`;
const gradeClass = (kind, v) => `g${gradeOf(kind, v)}`;
// HLTV Rating 3.0 est. (falls back to 2.0 est. for anything analyzed before 3.0 existed).
const r3 = (d) => (d && d.rating3 ? d.rating3 : d ? d.rating2 : 0);
const fmtSwing = (x) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}%`;
const resultWord = (r) => ({ win: "Victory", loss: "Defeat", tie: "Tied" }[r] || r);
const sum = (a) => a.reduce((x, y) => x + y, 0);

// FACEIT's date style: "Sat 3 Oct" over "04:32" (the year only when it isn't this year).
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fcDate(d) {
  const year = d.getFullYear() !== new Date().getFullYear() ? ` ${d.getFullYear()}` : "";
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `<b>${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}${year}</b><span>${time}</span>`;
}

const mapIcon = (m) =>
  `<img src="${assetUrl(`maps/${m}.svg`)}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('span'), { className: 'noicon' }))">`;

const LEVEL_COLORS = ["#eeeeee", "#eeeeee", "#1ce400", "#1ce400", "#ffc800", "#ffc800", "#ffc800", "#ffc800", "#ff6309", "#ff6309", "#fe1f00"];
const levelFor = (elo) => [500, 750, 900, 1050, 1200, 1350, 1530, 1750, 2000].filter((t) => elo > t).length + 1;

// FACEIT's level gauge: an open ring that fills with the level, the number inside.
function levelBadge(level, size = 24) {
  const c = LEVEL_COLORS[level] || LEVEL_COLORS[1];
  const r = 9.6, start = 135, sweep = 270;
  const at = (deg) => { const a = ((start + deg) * Math.PI) / 180; return `${(12 + r * Math.cos(a)).toFixed(2)},${(12 + r * Math.sin(a)).toFixed(2)}`; };
  const arc = (deg) => `M${at(0)} A${r},${r} 0 ${deg > 180 ? 1 : 0} 1 ${at(deg)}`;
  return `<svg class="lvl" width="${size}" height="${size}" viewBox="0 0 24 24" role="img" aria-label="FACEIT level ${level}">
    <path d="${arc(sweep)}" fill="none" stroke="#3a3a3a" stroke-width="2.4" stroke-linecap="round"/>
    <path d="${arc((sweep * level) / 10)}" fill="none" stroke="${c}" stroke-width="2.4" stroke-linecap="round"/>
    <text x="12" y="16" text-anchor="middle" font-size="${level === 10 ? 8.5 : 10.5}" fill="${c}">${level}</text></svg>`;
}

// CS2's Premier rating colors, by tier.
const premierTier = (r) => (r >= 30000 ? "#ffd700" : r >= 25000 ? "#eb4b4b" : r >= 20000 ? "#f03cff" : r >= 15000 ? "#c166ff" : r >= 10000 ? "#6a7dff" : r >= 5000 ? "#8cc6ff" : "#b0c3d9");
function premierChip(r) {
  const s = r.toLocaleString("en-US"), i = s.lastIndexOf(",");
  return `<span class="premier-chip" style="--tier:${premierTier(r)}" title="Premier rating"><span>${i > 0 ? s.slice(0, i) : s}<small>${i > 0 ? s.slice(i) : ""}</small></span></span>`;
}
const deltaHtml = (d) => (d == null ? "" : `<span class="delta ${d >= 0 ? "up" : "down"}">${d >= 0 ? "↑" : "↓"} ${Math.abs(d).toLocaleString("en-US")}</span>`);
const ICONS = {
  party: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="8" r="3.2"/><circle cx="16.5" cy="9" r="2.6"/><path d="M3 19c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5zM14.6 13.7c3.2-.4 6.4 1.4 6.4 5.3h-4.4c0-2-.7-3.9-2-5.3z"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  cross: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8z"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 19h14"/></svg>',
  external: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
  rating: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 12l4-4" stroke-linecap="round"/></svg>',
};
// Lineups thrown this many times or more get a video on their own (batch::LINEUP_AUTO_MIN_THROWS);
// the rest when asked for.
const LINEUP_AUTO_MIN = 4;
const lineupWaitText = (count) => count >= LINEUP_AUTO_MIN
  ? "Veloxify films it in the background, after your highlights."
  : `Veloxify films lineups thrown ${LINEUP_AUTO_MIN}+ times on its own. This one was thrown ${count} time${count === 1 ? "" : "s"}: film it whenever you like.`;
const faceitLibId = (fm) => `faceit-${fm.match_id.replace(/^1-/, "")}-m${Math.max(1, fm.map_number)}`;
function openFaceitRoom(matchId) {
  const path = `en/cs2/room/${matchId}`;
  if (tauri) tauri.core.invoke("open_faceit", { path });
  else window.open(`https://www.faceit.com/${path}`, "_blank");
}

// FACEIT demos: Veloxify downloads them through its own FACEIT window; one click fetches every
// missing demo. (Preview: opens the room in a browser.)
function getDemos(matchIds) {
  if (!matchIds.length || demoRunActive()) return; // one run at a time: a click mustn't restart it
  if (tauri) tauri.core.invoke("get_demos", { matchIds });
  else openFaceitRoom(matchIds[0]);
}
// Stats-only FACEIT matches, newest first, recent enough that FACEIT still has the demo.
const missingDemos = (ms, days = 30) =>
  ms.filter((m) => m.stats_only && m.played_ts > Date.now() / 1000 - days * DAY_S).sort((a, b) => b.played_ts - a.played_ts).map((m) => m.faceit.match_id);
const demoButton = (ids, cls = "btn") =>
  ids.length ? `<button class="${cls}" data-get-demos="${esc(ids.join(","))}">${ICONS.download} Get ${ids.length === 1 ? "the demo" : `${ids.length} demos`}</button>` : "";
// Buttons made by demoButton() anywhere on the page.
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-get-demos]");
  if (b) { e.stopPropagation(); getDemos(b.dataset.getDemos.split(",")); }
});

function relDay(date) {
  const today = iso(new Date());
  const y = new Date(); y.setDate(y.getDate() - 1);
  if (date === today) return "Today";
  if (date === iso(y)) return "Yesterday";
  const d = new Date(`${date}T12:00:00`), opts = { month: "short", day: "numeric" };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString([], opts);
}

// ---- router -------------------------------------------------------------------------------------

async function route() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  document.getElementById("xh-modal")?.remove(); // a crosshair opened on the previous page
  document.querySelectorAll("[data-nav]").forEach((a) => a.classList.remove("active"));
  const view = document.getElementById("view");
  await initLib();
  if (!state.index) {
    try { await loadIndex(); } catch (e) {
      view.innerHTML = `<div class="empty">No library yet. Play a match and it will show up here.<br><span class="sub">${esc(e.message)}</span></div>`;
      return;
    }
  }
  // The League tab only for players with ESEA league games.
  const hasLeague = state.all?.some((m) => leagueOf(m.faceit?.competition)) || state.faceit?.matches?.some((m) => leagueOf(m.competition));
  document.querySelector('[data-nav="league"]').hidden = !hasLeague;
  if (parts[0] === "grenades") {
    document.querySelector('[data-nav="grenades"]').classList.add("active");
    return renderGrenades(view, parts[1] ? decodeURIComponent(parts[1]) : null);
  }
  if (parts[0] === "insights") {
    document.querySelector('[data-nav="insights"]').classList.add("active");
    return renderInsights(view, parts[1] ? decodeURIComponent(parts[1]) : null);
  }
  if (parts[0] === "mechanics") {
    document.querySelector('[data-nav="mechanics"]').classList.add("active");
    return renderMechanics(view);
  }
  if (parts[0] === "playstyle") {
    document.querySelector('[data-nav="playstyle"]').classList.add("active");
    return renderPlaystyle(view, parts[1] ? decodeURIComponent(parts[1]) : null);
  }
  if (parts[0] === "crosshairs") {
    document.querySelector('[data-nav="profile"]').classList.add("active");
    return renderCrosshairs(view);
  }
  if (parts[0] === "league") {
    document.querySelector('[data-nav="league"]').classList.add("active");
    return renderLeague(view);
  }
  if (parts[0] === "scout" && parts[1]) {
    document.querySelector('[data-nav="league"]')?.classList.add("active");
    return renderScout(view, decodeURIComponent(parts[1]));
  }
  if (parts[0] === "ratings") {
    document.querySelector('[data-nav="profile"]').classList.add("active");
    return renderRatingBuilder(view, parts[1] ? decodeURIComponent(parts[1]) : null);
  }
  if (parts[0] === "match" && parts[1]) {
    document.querySelector('[data-nav="matches"]').classList.add("active");
    return renderMatchPage(view, decodeURIComponent(parts[1]), parts[2] || "overview");
  }
  if (parts[0] === "day" && parts[1]) return renderDay(view, parts[1], parts[2] === "m" ? decodeURIComponent(parts[3]) : null, parts[4]);
  if (parts[0] === "latest") {
    const last = state.days[state.days.length - 1];
    if (last) { location.hash = `#/session/${last.date}/${last.sessions.length - 1}`; return; }
  }
  if (parts[0] === "sessions") {
    document.querySelector('[data-nav="latest"]').classList.add("active");
    return renderSessionCalendar(view);
  }
  if (parts[0] === "session" && parts[1]) {
    document.querySelector('[data-nav="latest"]').classList.add("active");
    return renderSession(view, parts[1], Number(parts[2] || 0));
  }
  if (parts[0] === "settings") return renderSettings(view);
  if (parts[0] === "practice") {
    document.querySelector('[data-nav="practice"]').classList.add("active");
    return renderPractice(view);
  }
  if (parts[0] === "profile" || !parts.length) {
    document.querySelector('[data-nav="profile"]').classList.add("active");
    return renderProfile(view);
  }
  if (parts[0] === "matches") {
    document.querySelector('[data-nav="matches"]').classList.add("active");
    return renderMatchHistory(view);
  }
  // Highlights and lowlights live under Clips (old links still work).
  if (parts[0] === "highlights") { location.replace("#/clips/highlights"); return; }
  if (parts[0] === "lowlights") { location.replace(parts[1] ? `#/clips/lowlights/${parts[1]}/${parts[2]}` : "#/clips/lowlights"); return; }
  if (parts[0] === "clips") {
    document.querySelector('[data-nav="clips"]').classList.add("active");
    const sub = parts[1] || "highlights";
    if (sub === "lowlights" && parts[2] && parts[3]) return renderLowlight(view, decodeURIComponent(parts[2]), decodeURIComponent(parts[3]));
    return renderClips(view, sub);
  }
  // Anything else (old calendar links included) goes to the profile.
  location.replace("#/profile");
}

// ---- day view ------------------------------------------------------------------------------------

async function renderDay(view, date, matchId, tab) {
  const day = dayOf(date);
  if (!day) { view.innerHTML = `<div class="empty">No matches on ${esc(date)}</div>`; return; }
  const ids = dayMatchIds(day);
  const cards = ids.map((id) => {
    const m = summaryOf(id);
    return `
      <a class="mcard ${m.result} ${id === matchId ? "selected" : ""} ${m.stats_only ? "stats-only" : ""}" href="${matchHref(id)}">
        <div class="map-tile" title="${esc(mapName(m.map))}">${mapIcon(m.map)}</div>
        <div>
          <div class="mscore">${m.score_mine}<span class="sep">-</span>${m.score_theirs} <span class="src ${m.source}">${m.source === "valve" ? "PREMIER" : m.source.toUpperCase()}</span></div>
          <div class="mmeta">${relDay(date)}, ${fmtTime(m.played_at)}</div>
          <div class="mres ${m.result}">${resultWord(m.result)}${m.stats_only ? `<span class="hl-badge pending" title="FACEIT stats; the demo hasn't been processed yet">Stats only</span>` : m.highlight_count ? `<span class="hl-badge">★ ${m.highlight_count}</span>` : ""}</div>
        </div>
      </a>`;
  }).join("");
  const w = sum(day.sessions.map((s) => s.wins)), l = sum(day.sessions.map((s) => s.losses));
  view.innerHTML = `
    <a class="day-back" href="#/matches">◀ Match history</a>
    <div class="day">
      <div class="mlist">
        <a class="mcard overview ${matchId ? "" : "selected"}" href="#/day/${date}">
          <div><div class="h2">${relDay(date)}</div><div class="mscore">${w}<span class="sep">-</span>${l}</div><div class="mmeta">${ids.length} matches · overview</div></div>
        </a>
        ${cards}
      </div>
      <section class="panel detail" id="detail"></section>
    </div>`;
  const detail = view.querySelector("#detail");
  if (matchId) await renderMatch(detail, date, matchId, tab || "scoreboard");
  else await renderOverview(detail, day, tab || "stats");
}

function tabsHtml(tabs, active) {
  return `<div class="dtabs">${tabs.map(([k, label]) => `<button data-tab="${k}" class="${k === active ? "active" : ""}">${label}</button>`).join("")}</div>`;
}

async function renderOverview(el, day, tab) {
  const ids = dayMatchIds(day);
  const minutes = sum(ids.map((id) => summaryOf(id).duration_s)) / 60;
  el.innerHTML = `
    <div class="match-head">
      <div><div class="k">Day</div><div class="v">${fmtDate(day.date)}</div></div>
      <div><div class="k">Matches</div><div class="v">${ids.length}</div></div>
      <div><div class="k">Time played</div><div class="v">${fmtSpan(minutes)}</div></div>
      <div><div class="k">Highlights</div><div class="v"><span class="star">★</span> ${day.highlight_count}</div></div>
    </div>
    ${tabsHtml([["stats", "Stats"], ["highlights", "Highlights"]], tab)}
    <div class="dbody" id="dbody"></div>`;
  el.querySelectorAll("[data-tab]").forEach((b) => (b.onclick = () => (location.hash = `#/day/${day.date}/o/x/${b.dataset.tab}`)));
  const body = el.querySelector("#dbody");
  if (tab === "highlights") return renderHighlights(body, ids);

  const waiting = ids.map(summaryOf).filter((m) => m.stats_only);
  const waitingHtml = waiting.length ? `
    <div style="display:flex;align-items:center;gap:12px;margin:${day.players.length ? "26px" : "0"} 0 10px"><div class="h2">Waiting for the demo · stats from FACEIT</div><span class="grow"></span>${demoButton(missingDemos(waiting, 3650), "btn primary")}</div>
    <table class="sb">
      <thead><tr><th>Map</th><th>Time</th><th>Score</th><th>K / D / A</th><th>ADR</th><th>HS%</th><th>ELO</th></tr></thead>
      <tbody>${waiting.map((m) => { const fm = m.faceit; return `<tr class="clickable" data-href="${matchHref(m.id)}">
        <td>${esc(mapName(m.map))}</td><td>${fmtTime(m.played_at)}</td><td class="${m.result}-text">${m.score_mine}-${m.score_theirs}</td>
        <td>${fm.kills} / ${fm.deaths} / ${fm.assists}</td><td>${f1(fm.adr)}</td><td>${Math.round(fm.hs_pct)}%</td>
        <td>${fm.elo ? `${fm.elo.toLocaleString("en-US")} ${deltaHtml(fm.elo_delta)}` : fm.calibrating ? "Placement" : "–"}</td></tr>`; }).join("")}</tbody>
    </table>
    <div class="note">Get the demos and these join the totals above, with HLTV rating, RWS, highlights and lowlights. Veloxify downloads them for you through its FACEIT window and analyzes them; downloads wait while CS2 is open.</div>` : "";
  const rows = day.players.map((p) => {
    const c = p.counts, d = p.derived;
    const mk = sum(c.multikill_rounds.slice(2));
    const cw = sum(c.clutches_won), ca = sum(c.clutches_attempted);
    const diff = c.kills - c.deaths;
    return `<tr class="${p.is_me ? "me" : "party"}">
      <td>${esc(p.name)}</td><td>${c.matches}</td><td>${c.wins}-${c.matches - c.wins}</td>
      <td class="rating ${ratingClass(r3(d))}">${f2(r3(d))}</td><td class="${gradeClass("rws", d.rws)}">${f1(d.rws)}</td>
      <td>${c.kills}-${c.deaths} <span class="sub">(${diff > 0 ? "+" : ""}${diff})</span></td>
      <td>${f2(d.kd)}</td><td>${f1(d.adr)}</td><td>${f1(d.kast)}%</td><td>${Math.round(d.hs_pct)}%</td>
      <td>${c.opening_kills}-${c.opening_deaths}</td><td>${cw}/${ca}</td><td>${mk}</td><td>${fmtSwing(d.swing || 0)}</td></tr>`;
  }).join("");
  if (!day.players.length) {
    body.innerHTML = waitingHtml;
    wireRowLinks(body);
    return;
  }
  body.innerHTML = `
    <div class="h2" style="margin-bottom:10px">You${day.players.length > 1 ? " and your party" : ""}</div>
    <table class="sb">
      <thead><tr><th>Player</th><th>Maps</th><th>W-L</th><th>HLTV 3.0*</th><th>RWS</th><th>K-D</th><th>K/D</th><th>ADR</th><th>KAST</th><th>HS%</th><th>Entries</th><th>Clutches</th><th>Multi-kills</th><th>Swing</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="note">*HLTV Rating 3.0, estimated: HLTV's six sub-ratings and weights, eco-adjusted with HLTV's published duel matrix, with Round Swing from Veloxify's win-probability model; 1.00 = the average player in your lobbies. Swing = average change in your team's chance to win each round.
    Party = teammates who played at least two of the session's matches with you. Totals are summed across matches before rates are computed.</div>
    ${waitingHtml}`;
  wireRowLinks(body);
}

function wireRowLinks(root) {
  root.querySelectorAll("tr[data-href]").forEach((tr) => (tr.onclick = () => (location.hash = tr.dataset.href)));
}

// ---- match view ---------------------------------------------------------------------------------

// A FACEIT match whose demo isn't processed yet: FACEIT's stats and a way to get the demo.
function renderStatsOnly(el, date, m) {
  const fm = m.faceit;
  const elo = fm.elo ? `${levelBadge(levelFor(fm.elo))}${fm.elo.toLocaleString("en-US")} ${deltaHtml(fm.elo_delta)}` : fm.calibrating ? "Placement match" : "–";
  el.innerHTML = `
    <div class="match-head">
      <div class="map-tile">${mapIcon(m.map)}</div>
      <div><div class="k">Map</div><div class="v">${esc(mapName(m.map))}</div></div>
      <div><div class="k">Score</div><div class="v ${m.result}-text">${m.score_mine} - ${m.score_theirs}</div></div>
      <div><div class="k">Date</div><div class="v">${relDay(date)}, ${fmtTime(m.played_at)}</div></div>
      <div><div class="k">ELO</div><div class="v ml-elo">${elo}</div></div>
      <div><div class="k">Source</div><div class="v"><span class="src faceit">FACEIT</span></div></div>
    </div>
    <div class="dbody">
      <div class="h3" style="margin-bottom:12px">Your stats <span class="sub">from FACEIT</span></div>
      <div class="kpis six">
        <div class="kpi"><div class="v">${fm.kills} / ${fm.deaths} / ${fm.assists}</div><div class="l">K / D / A</div></div>
        <div class="kpi"><div class="v">${fm.deaths ? f2(fm.kills / fm.deaths) : "–"}</div><div class="l">K/D</div></div>
        <div class="kpi"><div class="v">${f1(fm.adr)}</div><div class="l">ADR</div></div>
        <div class="kpi"><div class="v">${Math.round(fm.hs_pct)}%</div><div class="l">HS%</div></div>
        <div class="kpi"><div class="v">${f2(fm.kr)}</div><div class="l">K/R</div></div>
        <div class="kpi"><div class="v">${fm.mvps}</div><div class="l">MVPs</div></div>
      </div>
      ${fm.team_elo && fm.enemy_elo ? `<div class="sub" style="margin-top:14px">Average ELO: your team ${fm.team_elo.toLocaleString("en-US")} · enemy team ${fm.enemy_elo.toLocaleString("en-US")}</div>` : ""}
      <div class="stats-only-note">
        <div><b>The full scoreboard, HLTV rating, RWS and highlights come from the demo.</b>
          <span>One click: Veloxify downloads it through its FACEIT window and analyzes it. Downloads wait while CS2 is open.</span></div>
        ${demoButton([fm.match_id], "btn primary")}
      </div>
    </div>`;
}

async function renderMatch(el, date, id, tab) {
  const s = summaryOf(id);
  if (s?.stats_only) return renderStatsOnly(el, date, s);
  const m = await loadMatch(id);
  el.innerHTML = `
    <div class="match-head">
      <div class="map-tile">${mapIcon(m.map)}</div>
      <div><div class="k">Map</div><div class="v">${esc(mapName(m.map))}</div></div>
      <div><div class="k">Duration</div><div class="v">${fmtDur(m.duration_s)}</div></div>
      <div><div class="k">Date</div><div class="v">${relDay(date)}, ${fmtTime(m.played_at)}</div></div>
      <div><div class="k">Source</div><div class="v"><span class="src ${m.source}">${m.source === "valve" ? "PREMIER" : m.source.toUpperCase()}</span></div></div>
    </div>
    ${tabsHtml([["scoreboard", "Scoreboard"], ["highlights", `Highlights (${m.highlights.length})`], ["lowlights", `Lowlights (${(m.lowlights || []).length})`]], tab)}
    <div class="dbody" id="dbody"></div>`;
  el.querySelectorAll("[data-tab]").forEach((b) => (b.onclick = () => (location.hash = `#/day/${date}/m/${encodeURIComponent(id)}/${b.dataset.tab}`)));
  const body = el.querySelector("#dbody");
  if (tab === "highlights") return renderHighlights(body, [id]);
  if (tab === "lowlights") {
    const list = (m.lowlights || []).map((l) => ({ ...l, match_id: id, map: m.map, played_at: m.played_at, source: m.source, source_label: summaryOf(id)?.source_label || "", score_mine: m.score_mine, score_theirs: m.score_theirs }));
    body.innerHTML = list.length ? `<div class="ll-grid">${list.map(lowlightCard).join("")}</div>` : `<div class="empty">No lowlights: no deaths right after a miss this match.</div>`;
    return;
  }

  const me = state.index.me;
  const team = (side) => m.players.filter((p) => p.side === side).sort((a, b) => b.counts.score - a.counts.score);
  const row = (p) => {
    const c = p.counts, d = p.derived;
    const cls = p.steamid === me ? "me" : p.party ? "party" : "";
    return `<tr class="${cls}"><td>${esc(p.name)}</td><td>${c.kills}</td><td>${c.assists}</td><td>${c.deaths}</td>
      <td>${c.mvps ? `<span class="star">★</span>${c.mvps > 1 ? c.mvps : ""}` : ""}</td><td>${c.score}</td>
      <td>${f1(d.adr)}</td><td>${f1(d.kast)}%</td><td>${Math.round(d.hs_pct)}%</td><td class="${gradeClass("rws", d.rws)}">${f1(d.rws)}</td><td>${fmtSwing(d.swing || 0)}</td><td class="rating ${ratingClass(r3(d))}">${f2(r3(d))}</td></tr>`;
  };
  body.innerHTML = `
    <table class="sb">
      <thead><tr><th>Player</th><th>K</th><th>A</th><th>D</th><th>★</th><th>Score</th><th>ADR</th><th>KAST</th><th>HS%</th><th>RWS</th><th>Swing</th><th title="HLTV Rating 3.0, estimated">HLTV 3.0</th></tr></thead>
      <tbody>
        <tr class="team-row"><td colspan="10"><span class="big">${m.score_mine}</span>Your team · ${resultWord(m.result)}</td></tr>
        ${team("mine").map(row).join("")}
        <tr class="team-row"><td colspan="10"><span class="big">${m.score_theirs}</span>Enemy team</td></tr>
        ${team("enemy").map(row).join("")}
      </tbody>
    </table>
    <div class="note">K/A/D, MVPs and score come from CS2's own end-of-match scoreboard. ● marks party members.</div>`;
}

// ---- avatars and ranks ---------------------------------------------------------------------------

// Steam avatars (fetched once per player by the app, cached) that open the Steam profile.
const AVATAR_BLANK = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#2a2a2a"/><circle cx="16" cy="12" r="6" fill="#555"/><path d="M5 30c1-7 6-10 11-10s10 3 11 10z" fill="#555"/></svg>');
const avatarHtml = (sid, size = 28) =>
  `<a class="pav" data-steam="${esc(sid)}" title="Steam profile" style="width:${size}px;height:${size}px"><img data-avatar="${esc(sid)}" src="${esc(state.avatars.get(sid) || AVATAR_BLANK)}" alt="" loading="lazy"></a>`;
let avatarsBusy = false;
async function fillAvatars(root) {
  if (!tauri || avatarsBusy) return;
  const imgs = [...root.querySelectorAll("img[data-avatar]")];
  const need = [...new Set(imgs.map((i) => i.dataset.avatar).filter((id) => !state.avatars.has(id)))];
  if (need.length) {
    avatarsBusy = true;
    try {
      const got = await tauri.core.invoke("player_avatars", { ids: need });
      for (const [k, v] of Object.entries(got)) state.avatars.set(k, v);
    } catch (e) { for (const id of need) state.avatars.set(id, ""); }
    avatarsBusy = false;
  }
  for (const i of root.querySelectorAll("img[data-avatar]")) {
    const u = state.avatars.get(i.dataset.avatar);
    if (u && i.src !== u) i.src = u;
  }
}
document.addEventListener("click", (e) => {
  const a = e.target.closest("[data-steam]");
  if (!a) return;
  e.preventDefault();
  e.stopPropagation();
  const url = `https://steamcommunity.com/profiles/${a.dataset.steam}`;
  if (tauri) tauri.core.invoke("open_link", { url }); else window.open(url, "_blank");
}, true);

// A player's rank in this match's mode: FACEIT level + ELO, Premier rating, or "?" when unranked.
const unrankedChip = () => `<span class="rank-chip none" title="Unranked or unknown">?</span>`;
function rankHtml(p, roster) {
  if (roster) {
    const r = roster[p.steamid];
    return r?.level ? `<span class="rank-chip faceit" title="FACEIT level ${r.level} · ${r.elo.toLocaleString("en-US")} ELO">${levelBadge(r.level, 20)}<b>${r.elo.toLocaleString("en-US")}</b></span>` : unrankedChip();
  }
  return p.rank_type === 11 && p.rank ? premierChip(p.rank) : unrankedChip();
}
// Everyone's FACEIT ELO/level in a FACEIT match (from FACEIT's room, cached by the app).
async function loadRoster(m) {
  if (m.source !== "faceit" || !tauri) return null;
  if (!state.rosters.has(m.id)) {
    const room = m.id.replace(/^faceit-/, "1-").replace(/-m\d+$/, "");
    let r = null;
    try { r = await tauri.core.invoke("faceit_roster", { matchId: room }); } catch (e) { /* offline */ }
    state.rosters.set(m.id, r && Object.keys(r).length ? r : null);
  }
  return state.rosters.get(m.id);
}
// Who queued together in a match, like Leetify shows it: FACEIT's party of every player, Valve's
// for Premier matches Veloxify downloaded (premier.json), else just your own party. Each party gets
// a tab of its own color (your team's greens and blues, the enemy's oranges and pinks), biggest first.
const PARTY_COLORS = { mine: ["#2fc9a0", "#5aa9ff", "#b98cff", "#e3c25a"], enemy: ["#f2806b", "#ffb03a", "#ff6fae", "#9d8cff"] };
let premierParties = null;
async function loadPremierParties() {
  if (premierParties) return premierParties;
  try {
    const r = await fetch(assetUrl("premier.json"), { cache: "no-store" });
    premierParties = r.ok ? (await r.json()).parties || {} : {};
  } catch (e) { premierParties = {}; }
  return premierParties;
}
function partyTabs(m) {
  const key = new Map();
  const valve = premierParties?.[m.id];
  for (const p of m.players) {
    const k = m._roster ? m._roster[p.steamid]?.party : valve ? valve[p.steamid] : p.party || p.steamid === state.index.me ? "you" : null;
    if (k) key.set(p.steamid, String(k));
  }
  const out = new Map();
  for (const side of ["mine", "enemy"]) {
    const groups = new Map();
    for (const p of m.players.filter((x) => x.side === side)) {
      const k = key.get(p.steamid);
      if (k) groups.set(k, [...(groups.get(k) || []), p.steamid]);
    }
    [...groups.values()].filter((g) => g.length > 1).sort((a, b) => b.length - a.length)
      .forEach((g, i) => g.forEach((sid) => out.set(sid, { size: g.length, color: PARTY_COLORS[side][i % PARTY_COLORS[side].length] })));
  }
  return out;
}
const nameCell = (p, roster, withRank = true, party = null) =>
  `${party ? `<span class="pt-tab" style="--pc:${party.color}" title="Queued together: a party of ${party.size}">${ICONS.party}<b>${party.size}</b></span>` : ""}${avatarHtml(p.steamid)}${withRank ? rankHtml(p, roster) : ""}<span class="mp-pname">${esc(p.name)}</span>`;
// A player's rank as a number to sort by: FACEIT ELO in a FACEIT match, else the Premier rating.
const rankValue = (p, roster) => (roster ? roster[p.steamid]?.elo ?? -1 : p.rank_type === 11 && p.rank ? p.rank : -1);

// ---- match page (Leetify-style): header, scoreboard and the match's sections ------------------

const matchHref = (id, tab) => `#/match/${encodeURIComponent(id)}${tab ? `/${tab}` : ""}`;
// ---- table columns you pick -----------------------------------------------------------------------

// A table's columns: the ones you picked, in your order (saved per table), else its defaults.
// `catalog` is [[key, label], ...]. Columns added to a catalog's defaults after you saved show up
// where they are by default; other new ones start hidden (add them from Columns).
function pickedCols(store, catalog, defaults) {
  const known = new Set(catalog.map(([k]) => k));
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(store) || "null"); } catch (e) { /* defaults */ }
  if (Array.isArray(saved)) saved = { cols: saved, seen: saved }; // the old format: every column, in order
  if (!saved || !Array.isArray(saved.cols)) return defaults.filter((k) => known.has(k));
  const cols = saved.cols.filter((k) => known.has(k));
  const seen = new Set(saved.seen || saved.cols);
  defaults.forEach((k, i) => { if (!seen.has(k) && !cols.includes(k)) cols.splice(Math.min(i, cols.length), 0, k); });
  return cols;
}
function savePickedCols(store, catalog, cols) {
  try { localStorage.setItem(store, JSON.stringify({ cols, seen: catalog.map(([k]) => k) })); } catch (e) { /* not saved */ }
}
const COLS_ICON = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 5h16M4 12h16M4 19h16"/><circle cx="9" cy="5" r="1.6" fill="currentColor"/><circle cx="15" cy="12" r="1.6" fill="currentColor"/><circle cx="8" cy="19" r="1.6" fill="currentColor"/></svg>`;

// The Columns button's menu: tick to show, untick to hide, Reset for the defaults.
// `groups` is [[group name, [keys...]], ...] over the catalog.
function openColPicker(btn, { catalog, groups, cols, onChange, onReset }) {
  document.getElementById("col-picker")?.remove();
  const label = new Map(catalog);
  const el = document.createElement("div");
  el.id = "col-picker";
  el.className = "col-picker";
  el.innerHTML = `<div class="col-picker-head"><b>Columns</b><span class="sub">Tick to show. Drag a column's header to move it.</span></div>
    <div class="col-picker-groups">${groups.map(([g, keys]) => `<div class="col-group"><div class="col-group-h">${esc(g)}</div>
      ${keys.filter((k) => label.has(k)).map((k) => `<label class="col-opt"><input type="checkbox" data-col="${esc(k)}" ${cols.includes(k) ? "checked" : ""}> ${esc(label.get(k))}</label>`).join("")}</div>`).join("")}</div>
    <div class="col-picker-foot"><button class="btn small ghost" data-reset>Reset to default</button><button class="btn small" data-done>Done</button></div>`;
  document.body.appendChild(el);
  const r = btn.getBoundingClientRect();
  el.style.top = `${Math.round(r.bottom + window.scrollY + 6)}px`;
  el.style.left = `${Math.round(Math.max(12, Math.min(r.right - el.offsetWidth, window.innerWidth - el.offsetWidth - 12)) + window.scrollX)}px`;
  el.querySelectorAll("[data-col]").forEach((c) => (c.onchange = () => {
    const k = c.dataset.col;
    onChange(c.checked ? [...cols.filter((x) => x !== k), k] : cols.filter((x) => x !== k));
    cols = c.checked ? [...cols.filter((x) => x !== k), k] : cols.filter((x) => x !== k);
  }));
  el.querySelector("[data-reset]").onclick = () => { onReset(); el.remove(); };
  el.querySelector("[data-done]").onclick = () => el.remove();
  setTimeout(() => document.addEventListener("pointerdown", function away(e) {
    if (!document.body.contains(el)) return document.removeEventListener("pointerdown", away);
    if (!el.contains(e.target) && e.target !== btn && !btn.contains(e.target)) { el.remove(); document.removeEventListener("pointerdown", away); }
  }), 0);
}

// Header drag and drop: moving `from` onto `to` (before or after it, the way it was dragged).
function moveCol(cols, from, to) {
  if (!from || from === to) return cols;
  const order = cols.filter((k) => k !== from);
  const after = cols.indexOf(from) < cols.indexOf(to);
  order.splice(order.indexOf(to) + (after ? 1 : 0), 0, from);
  return order;
}
function wireColDrag(cells, getCols, setCols) {
  cells.forEach((th) => {
    th.draggable = true;
    th.ondragstart = (e) => { e.dataTransfer.setData("text/plain", th.dataset.col); e.dataTransfer.effectAllowed = "move"; th.classList.add("dragging"); };
    th.ondragend = () => th.classList.remove("dragging");
    th.ondragover = (e) => { e.preventDefault(); th.classList.add("drop"); };
    th.ondragleave = () => th.classList.remove("drop");
    th.ondrop = (e) => {
      e.preventDefault();
      th.classList.remove("drop");
      setCols(moveCol(getCols(), e.dataTransfer.getData("text/plain"), th.dataset.col));
    };
  });
}

const MATCH_SORTS = {
  name: (p) => p.name.toLowerCase(), kills: (p) => p.counts.kills, assists: (p) => p.counts.assists, deaths: (p) => p.counts.deaths,
  kd: (p) => p.derived.kd, adr: (p) => p.derived.adr, kast: (p) => p.derived.kast,
  k2: (p) => p.counts.multikill_rounds[2], k3: (p) => p.counts.multikill_rounds[3], k4: (p) => p.counts.multikill_rounds[4], k5: (p) => p.counts.multikill_rounds[5],
  rws: (p) => p.derived.rws, swing: (p) => p.derived.swing || 0, rating: (p) => r3(p.derived), kr: (p) => p.derived.kpr,
  rating2: (p) => p.derived.rating2, rating1: (p) => p.derived.rating1, hs: (p) => p.derived.hs_pct, dpr: (p) => p.derived.dpr,
  mvps: (p) => p.counts.mvps, dmg: (p) => p.counts.damage, fk: (p) => p.counts.opening_kills, fd: (p) => p.counts.opening_deaths,
  trades: (p) => p.counts.trade_kills, clutch: (p) => sum(p.counts.clutches_won.slice(1)), ud: (p) => p.counts.utility_damage,
  ef: (p) => p.counts.enemies_flashed, fa: (p) => p.counts.flash_assists, acc: (p) => p.derived.accuracy, hacc: (p) => p.derived.head_accuracy,
  plants: (p) => p.counts.bomb_plants, defuses: (p) => p.counts.bomb_defuses,
  // From the match details, once loaded (see renderMatchScoreboard); -1 sorts them last.
  aim: (p) => p._aim ?? -1, util: (p) => p._util ?? -1,
};
// The Aim and Utility ratings (Profile > Your ratings: 0-100, 50 = the average player in your
// library) for one set of stats.
const ratingDef = (id) => customRatings.find((r) => r.id === id) || DEFAULT_RATINGS.find((r) => r.id === id);
const rateCell = (v, tag = "td") => (v == null || v < 0 ? `<${tag} class="na">–</${tag}>`
  : `<${tag}><span class="rate-bar ${v >= 60 ? "good" : v <= 40 ? "poor" : ""}"><i style="width:${v}%"></i><b>${v}</b></span></${tag}>`);
const matchSort = { key: "rating", desc: true };

async function renderMatchPage(view, id, tab) {
  const s = summaryOf(id);
  if (!s) { view.innerHTML = `<a class="day-back" href="#/matches">◀ Match history</a><div class="empty">Match not found.</div>`; return; }
  const m = s.stats_only ? null : await loadMatch(id);
  if (m) [m._roster] = await Promise.all([loadRoster(m), loadPremierParties()]);
  const tabs = [["overview", "Overview"]];
  if (m) tabs.push(["timeline", "Timeline"], ["replay", "2D Replay"], ["lineups", "Lineups"], ["aim", "Aim"], ["utility", "Utility"], ["activity", "Activity"], ["trades", "Trades"], ["opening", "Opening Duels"], ["clutches", "Clutches"], ["h2h", "Head to Head"], ["breakdown", "Rating Breakdown"], ["zones", "Map Zones"], ["ratings", "Ratings"],
    ["highlights", `Highlights${m.highlights.length ? ` (${m.highlights.length})` : ""}`], ["lowlights", `Lowlights${(m.lowlights || []).length ? ` (${m.lowlights.length})` : ""}`]);
  if (!tabs.some(([k]) => k === tab)) tab = "overview";
  const fm = s.faceit;
  const eloNow = s.elo ?? fm?.elo, eloDelta = s.elo_delta ?? fm?.elo_delta;
  const room = s.source === "faceit" ? fm?.match_id || s.id.replace(/^faceit-/, "1-").replace(/-m\d+$/, "") : null;
  const when = new Date(s.played_ts * 1000);
  const stamp = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, "0")}-${String(when.getDate()).padStart(2, "0")} ${fmtTime(s.played_at)}`;
  const elo = eloNow ? `<span class="mp-chip">${levelBadge(levelFor(eloNow), 20)}${eloNow.toLocaleString("en-US")} ${deltaHtml(eloDelta)}</span>`
    : leagueOf(fm?.competition) ? `<span class="mp-chip">${leagueChip(fm.competition, true)}</span>`
    : s.premier ? `<span class="mp-chip">${premierChip(s.premier)}${deltaHtml(s.premier_delta)}</span>` : "";
  const source = s.source === "valve" ? "Premier" : s.source === "faceit" ? "FACEIT" : s.source;
  view.innerHTML = `
    <a class="day-back" href="#/matches">◀ Match history</a>
    <section class="mp-hero ${s.result}" style="--shot:url('${assetUrl(`mapshots/${s.map}.png`)}')">
      <div class="mp-map">${mapIcon(s.map)}</div>
      <div class="mp-top">
        <div class="mp-result"><b>${resultWord(s.result)}</b><span class="mp-score"><span class="${s.result}">${s.score_mine}</span>:<span>${s.score_theirs}</span></span></div>
        <div class="mp-meta">${stamp}<i>|</i>${esc(mapName(s.map))}<i>|</i>${esc(source)}${s.source_label && s.source_label.toLowerCase() !== source.toLowerCase() ? ` · ${esc(s.source_label)}` : ""}${s.duration_s ? `<i>|</i>${fmtDur(s.duration_s)}` : ""}</div>
      </div>
      <div class="mp-chips">${elo}${room ? `<button class="mp-chip link" id="mp-room">${ICONS.external} FACEIT room</button>` : ""}</div>
      <nav class="mp-tabs">${tabs.map(([k, label]) => `<a href="${matchHref(id, k === "overview" ? "" : k)}" class="${k === tab ? "active" : ""}">${label}</a>`).join("")}</nav>
    </section>
    <div class="mp-body" id="mp-body"></div>`;
  view.querySelector("#mp-room")?.addEventListener("click", () => openFaceitRoom(room));
  const body = view.querySelector("#mp-body");
  if (!m) return renderStatsOnly(body, s.played_at.slice(0, 10), s);
  if (tab === "highlights") return renderHighlights(body, [id]);
  if (tab === "lowlights") {
    const list = (m.lowlights || []).map((l) => ({ ...l, match_id: id, map: m.map, played_at: m.played_at, source: m.source, source_label: s.source_label || "", score_mine: m.score_mine, score_theirs: m.score_theirs }));
    body.innerHTML = list.length ? `<div class="ll-grid">${list.map(lowlightCard).join("")}</div>` : `<div class="empty">No lowlights: no deaths right after a miss this match.</div>`;
    return;
  }
  if (tab === "aim" || tab === "utility" || tab === "activity") return renderStatTab(body, m, id, tab);
  if (tab === "opening") return renderOpeningTab(body, m, id);
  if (tab === "trades") return renderTradesTab(body, m, id);
  if (tab === "h2h") return renderH2HTab(body, m, id);
  if (tab === "breakdown") return renderBreakdownTab(body, m, id);
  if (tab === "zones") return renderZonesTab(body, m, id);
  if (tab === "clutches") return renderClutchTab(body, m, id);
  if (tab === "ratings") return renderRatingsTab(body, m, id);
  if (tab === "timeline") return renderTimelineTab(body, m, id);
  if (tab === "lineups") return renderLineupsTab(body, m, id);
  if (tab === "replay") return renderReplayTab(body, m, id);
  body.innerHTML = `<div class="ov-grid"><div id="mp-summary"></div><div id="mp-board"></div></div>`;
  renderMatchScoreboard(body.querySelector("#mp-board"), m);
  await renderMatchSummary(body.querySelector("#mp-summary"), m, id);
}

// Every column the scoreboard can show; Columns picks which, dragging a header moves one (saved).
const BOARD_COLS = [["rank", "Rank"], ["rating", "HLTV 3.0"], ["rws", "RWS"], ["swing", "Swing"], ["kills", "Kills"], ["assists", "Assists"], ["deaths", "Deaths"], ["kd", "K/D"],
  ["adr", "ADR"], ["kr", "K/R"], ["kast", "KAST"], ["k2", "2K"], ["k3", "3K"], ["k4", "4K"], ["k5", "5K"], ["xhair", "Crosshair"],
  ["rating2", "Rating 2.0"], ["rating1", "Rating 1.0"], ["hs", "HS%"], ["dpr", "D/R"], ["mvps", "MVPs"], ["dmg", "Damage"], ["fk", "First kills"], ["fd", "First deaths"],
  ["trades", "Trade kills"], ["clutch", "Clutches"], ["ud", "Utility dmg"], ["ef", "Flashed"], ["fa", "Flash assists"], ["acc", "Accuracy"], ["hacc", "Head accuracy"],
  ["plants", "Plants"], ["defuses", "Defuses"], ["aim", "Aim"], ["util", "Utility"]];
// Shorter column names, used when the scoreboard has to tighten up to fit.
const BOARD_SHORT = { kills: "K", assists: "A", deaths: "D", xhair: "Xhair", rating2: "R 2.0", rating1: "R 1.0", dmg: "Dmg", fk: "FK", fd: "FD", trades: "Trades",
  clutch: "Clutch", ud: "UD", ef: "Flashed", fa: "FA", acc: "Acc", hacc: "Head acc", util: "Util", defuses: "Defs", mvps: "MVPs" };
const BOARD_DEFAULT = ["rank", "rating", "rws", "swing", "kills", "assists", "deaths", "kd", "adr", "kr", "kast", "aim", "util", "k2", "k3", "k4", "k5", "xhair"];
const BOARD_GROUPS = [["Ratings", ["rating", "rating2", "rating1", "rws", "swing", "aim", "util", "rank"]], ["Kills and damage", ["kills", "assists", "deaths", "kd", "kr", "dpr", "hs", "adr", "dmg", "kast", "mvps"]],
  ["Multi-kills", ["k2", "k3", "k4", "k5"]], ["Openings, trades, clutches", ["fk", "fd", "trades", "clutch"]], ["Utility", ["ud", "ef", "fa"]], ["Aim", ["acc", "hacc"]],
  ["Bomb", ["plants", "defuses"]], ["Other", ["xhair"]]];
function boardCols() {
  const known = new Map(BOARD_COLS);
  return pickedCols("veloxify.boardCols", BOARD_COLS, BOARD_DEFAULT).map((k) => [k, known.get(k)]);
}

// Both teams, Leetify's match-details columns (no Leetify rating), sortable by any column.
function renderMatchScoreboard(body, m) {
  const me = state.index.me;
  // Each player's Aim and Utility ratings, from the match details (every player's aim and utility stats).
  if (m._rated === undefined) {
    m._rated = false;
    Promise.all([loadDetails(m.id), loadBenchmarks()]).then(([d]) => {
      const stats = new Map((d?.players || []).map((p) => [String(p.steamid), p.stats || {}]));
      for (const p of m.players) {
        const st = stats.get(String(p.steamid));
        p._aim = st ? customRating(ratingDef("aim"), st) : null;
        p._util = st ? customRating(ratingDef("utility"), st) : null;
      }
      m._rated = true;
      if (document.body.contains(body)) renderMatchScoreboard(body, m);
    });
  }
  // Crosshairs come from crosshairs.json: draw again once it's loaded.
  if (!state.xh) loadCrosshairs().then(() => { if (document.body.contains(body)) renderMatchScoreboard(body, m); });
  const codes = state.xh?.matches?.[m.id] || {};
  const COLS = boardCols();
  const by = matchSort.key === "rank" ? (p) => rankValue(p, m._roster) : MATCH_SORTS[matchSort.key];
  const sorted = (side) => m.players.filter((p) => p.side === side).sort((a, b) => {
    const x = by(a), y = by(b);
    return (x < y ? -1 : x > y ? 1 : 0) * (matchSort.desc ? -1 : 1);
  });
  const cell = (p, k) => {
    const c = p.counts, d = p.derived;
    switch (k) {
      case "kills": return `<td>${c.kills}</td>`;
      case "assists": return `<td>${c.assists}</td>`;
      case "deaths": return `<td>${c.deaths}</td>`;
      case "kd": return `<td class="${gradeClass("kd", d.kd)}">${f2(d.kd)}</td>`;
      case "adr": return `<td class="${gradeClass("adr", d.adr)}">${Math.round(d.adr)}</td>`;
      case "kr": return `<td class="${gradeClass("kpr", d.kpr)}">${f2(d.kpr)}</td>`;
      case "kast": return `<td class="${gradeClass("kast", d.kast)}">${Math.round(d.kast)}%</td>`;
      case "rws": return `<td class="${gradeClass("rws", d.rws)}">${f1(d.rws)}</td>`;
      case "swing": return `<td class="${gradeClass("swing", d.swing || 0)}" title="Round Swing: average change in the team's chance to win each round (HLTV Rating 3.0)">${fmtSwing(d.swing || 0)}</td>`;
      case "rating": return `<td><span class="mp-rating ${ratingClass(r3(d))}">${f2(r3(d))}</span></td>`;
      case "rank": return `<td class="mp-rank">${rankHtml(p, m._roster)}</td>`;
      case "xhair": return xhCell(codes[p.steamid], p.name);
      case "rating2": return `<td class="${gradeClass("rating", d.rating2)}">${f2(d.rating2)}</td>`;
      case "rating1": return `<td class="${gradeClass("rating", d.rating1)}">${f2(d.rating1)}</td>`;
      case "hs": return `<td>${Math.round(d.hs_pct)}%</td>`;
      case "dpr": return `<td>${f2(d.dpr)}</td>`;
      case "mvps": return `<td class="${c.mvps ? "" : "zero"}">${c.mvps}</td>`;
      case "dmg": return `<td>${c.damage}</td>`;
      case "fk": return `<td class="${c.opening_kills ? "" : "zero"}">${c.opening_kills}</td>`;
      case "fd": return `<td class="${c.opening_deaths ? "" : "zero"}">${c.opening_deaths}</td>`;
      case "trades": return `<td class="${c.trade_kills ? "" : "zero"}">${c.trade_kills}</td>`;
      case "clutch": { const w = sum(c.clutches_won.slice(1)), a = sum(c.clutches_attempted.slice(1)); return `<td class="${a ? "" : "zero"}" title="Clutches won of the 1vX situations">${w}/${a}</td>`; }
      case "ud": return `<td class="${c.utility_damage ? "" : "zero"}">${c.utility_damage}</td>`;
      case "ef": return `<td class="${c.enemies_flashed ? "" : "zero"}">${c.enemies_flashed}</td>`;
      case "fa": return `<td class="${c.flash_assists ? "" : "zero"}">${c.flash_assists}</td>`;
      case "acc": return `<td>${Math.round(d.accuracy)}%</td>`;
      case "hacc": return `<td>${Math.round(d.head_accuracy)}%</td>`;
      case "plants": return `<td class="${c.bomb_plants ? "" : "zero"}">${c.bomb_plants}</td>`;
      case "defuses": return `<td class="${c.bomb_defuses ? "" : "zero"}">${c.bomb_defuses}</td>`;
      case "aim": return rateCell(p._aim);
      case "util": return rateCell(p._util);
      default: return `<td class="${c.multikill_rounds[Number(k[1])] ? "" : "zero"}">${c.multikill_rounds[Number(k[1])]}</td>`;
    }
  };
  const label = (k, t) => (BOARD_SHORT[k] ? `<span class="lf">${t}</span><span class="ls">${BOARD_SHORT[k]}</span>` : t);
  const head = (title, won, tools) => `<tr class="mp-team"><th class="mp-name">${title} <span class="mp-badge ${won ? "win" : "loss"}">${won ? "WIN" : m.result === "tie" ? "TIE" : "LOSS"}</span>
    ${tools ? `<button class="btn ghost small mp-cols-btn" id="mp-cols" title="Pick the stats this table shows">${COLS_ICON}<span>Columns</span></button>` : ""}</th>
    ${COLS.map(([k, t]) => `<th data-sort="${k}" draggable="true" title="${esc(t)}: click to sort, drag to move" class="${matchSort.key === k ? "on" : ""}">${label(k, t)}${matchSort.key === k ? (matchSort.desc ? " ↓" : " ↑") : ""}</th>`).join("")}</tr>`;
  const parties = partyTabs(m);
  const LOWER_BETTER = new Set(["deaths", "dpr", "fd"]);
  const best = {};
  for (const [k] of COLS) {
    const f = MATCH_SORTS[k];
    if (!f || k === "name") continue;
    const vals = m.players.map(f).filter((v) => typeof v === "number" && !Number.isNaN(v));
    const b = LOWER_BETTER.has(k) ? Math.min(...vals) : Math.max(...vals);
    // A column where nobody did it (no 5Ks) has no leader.
    if (vals.length && (LOWER_BETTER.has(k) || b > 0)) best[k] = b;
  }
  const starred = (p, k) => {
    const html = cell(p, k);
    return best[k] != null && MATCH_SORTS[k](p) === best[k]
      ? html.replace(/^(<td[^>]*>)([\s\S]*)<\/td>$/, `$1<span class="cv">$2<span class="star" title="Best in the match">★</span></span></td>`) : html;
  };
  const row = (p, won) => `<tr class="${won ? "won" : "lost"} ${p.steamid === me ? "me" : ""}">
    <td class="mp-name">${nameCell(p, m._roster, false, parties.get(p.steamid))}</td>
    ${COLS.map(([k]) => starred(p, k)).join("")}</tr>`;
  const mineWon = m.result === "win", theirsWon = m.result === "loss";
  body.innerHTML = `
    <div class="mp-board-wrap"><table class="mp-board">
      <thead>${head("My Team", mineWon, true)}</thead>
      <tbody>${sorted("mine").map((p) => row(p, mineWon)).join("")}</tbody>
      <thead>${head("Enemy Team", theirsWon)}</thead>
      <tbody>${sorted("enemy").map((p) => row(p, theirsWon)).join("")}</tbody>
    </table></div>
    <div class="note">Kills, assists and deaths come from CS2's end-of-match scoreboard. HLTV 3.0 is estimated from the demo. Click a column to sort, drag it to move it, and pick stats with Columns (saved; <a class="link" href="#" id="mp-cols-reset">reset</a>).</div>`;
  fitBoard(body);
  body.querySelectorAll("th[data-sort]").forEach((th) => {
    th.onclick = () => {
      const k = th.dataset.sort;
      if (!MATCH_SORTS[k] && k !== "rank") return; // e.g. Crosshair: nothing to sort by
      matchSort.desc = matchSort.key === k ? !matchSort.desc : k !== "name";
      matchSort.key = k;
      renderMatchScoreboard(body, m);
    };
    // Drag a header onto another to put it there.
    th.ondragstart = (e) => { e.dataTransfer.setData("text/plain", th.dataset.sort); e.dataTransfer.effectAllowed = "move"; th.classList.add("dragging"); };
    th.ondragend = () => th.classList.remove("dragging");
    th.ondragover = (e) => { e.preventDefault(); th.classList.add("drop"); };
    th.ondragleave = () => th.classList.remove("drop");
    th.ondrop = (e) => {
      e.preventDefault();
      const from = e.dataTransfer.getData("text/plain"), to = th.dataset.sort;
      if (!from || from === to) return;
      savePickedCols("veloxify.boardCols", BOARD_COLS, moveCol(COLS.map(([k]) => k), from, to));
      renderMatchScoreboard(body, m);
    };
  });
  body.querySelector("#mp-cols-reset").onclick = (e) => { e.preventDefault(); try { localStorage.removeItem("veloxify.boardCols"); } catch (err) { /* nothing saved */ } renderMatchScoreboard(body, m); };
  body.querySelector("#mp-cols").onclick = (e) => { e.stopPropagation(); openColPicker(e.currentTarget, {
    catalog: BOARD_COLS, groups: BOARD_GROUPS, cols: COLS.map(([k]) => k),
    onChange: (cols) => { savePickedCols("veloxify.boardCols", BOARD_COLS, cols); renderMatchScoreboard(body, m); },
    onReset: () => { try { localStorage.removeItem("veloxify.boardCols"); } catch (err) { /* nothing saved */ } renderMatchScoreboard(body, m); },
  }); };
}

// A scoreboard never scrolls sideways: it tightens its spacing, then uses short column names and
// smaller text, and only then scales down to the page's width. Again whenever the page resizes.
function fitBoard(holder) {
  const fit = () => {
    const wrap = holder.querySelector(".mp-board-wrap"), table = wrap?.querySelector("table");
    if (!table) return;
    table.classList.remove("dense", "denser");
    table.style.zoom = "";
    for (const cls of ["dense", "denser"]) {
      if (table.scrollWidth <= wrap.clientWidth + 1) return;
      table.classList.add(cls);
    }
    if (table.scrollWidth > wrap.clientWidth + 1) table.style.zoom = String(Math.max(0.55, (wrap.clientWidth - 2) / table.scrollWidth));
  };
  fit();
  if (!holder._fit) {
    let width = holder.clientWidth;
    holder._fit = new ResizeObserver(() => { if (holder.clientWidth !== width) { width = holder.clientWidth; holder._fitNow(); } });
    holder._fit.observe(holder);
  }
  holder._fitNow = fit;
}

// ---- match details: HLTV-style summary, Aim, Utility, Activity, Opening duels, Clutches ----------

async function loadDetails(id) {
  if (!state.details.has(id)) {
    let d = null;
    try {
      const r = await fetch(assetUrl(`matches/${id}.details.json`), { cache: "no-store" });
      if (r.ok) d = await r.json();
    } catch (e) { /* not built yet */ }
    state.details.set(id, d);
  }
  return state.details.get(id);
}

async function loadBenchmarks() {
  if (state.benchmarks === undefined) {
    try {
      const r = await fetch(assetUrl("benchmarks.json"), { cache: "no-store" });
      state.benchmarks = r.ok ? await r.json() : null;
    } catch (e) { state.benchmarks = null; }
  }
  return state.benchmarks;
}

// Each gun's usual spray pattern (aim punch pitch, yaw per bullet), learned from the Premier demos
// in the library: FACEIT demos don't record recoil, so their whiffs are compared against this.
async function loadRecoil() {
  if (state.recoil === undefined) {
    try {
      const r = await fetch(assetUrl("recoil.json"), { cache: "no-store" });
      state.recoil = r.ok ? await r.json() : null;
    } catch (e) { state.recoil = null; }
  }
  return state.recoil;
}

// Where a value sits among every player-match in your library: 0 = worst, 1 = best.
function standing(key, v) {
  const b = state.benchmarks?.[key];
  if (!b || v == null || !b.quantiles?.length) return null;
  const q = b.quantiles, last = q.length - 1;
  let p;
  if (v <= q[0]) p = 0;
  else if (v >= q[last]) p = 1;
  else {
    let i = 0;
    while (i < last - 1 && q[i + 1] <= v) i++;
    const lo = q[i], hi = q[i + 1];
    p = (i + (hi > lo ? (v - lo) / (hi - lo) : 0.5)) / last;
  }
  return b.lower_is_better ? 1 - p : p;
}
// Leetify's bands: bottom 10% Poor, 10-30% Subpar, 30-70% Average, 70-90% Good, top 10% Great.
const bandOf = (p) => (p == null ? "" : p >= 0.9 ? "g0" : p >= 0.7 ? "g1" : p >= 0.3 ? "g2" : p >= 0.1 ? "g3" : "g4");
const BAND_WORDS = { g0: "Great", g1: "Good", g2: "Average", g3: "Subpar", g4: "Poor" };
function erf(x) {
  // Abramowitz & Stegun 7.1.26
  const s = Math.sign(x), a = Math.abs(x), t = 1 / (1 + 0.3275911 * a);
  return s * (1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a));
}
const phi = (x) => 0.5 * (1 + erf(x / Math.SQRT2));
// Standard score against the library, oriented so higher is better, clamped to +-3.
function zOf(key, v) {
  const b = state.benchmarks?.[key];
  if (!b || v == null || !b.sd) return null;
  const x = (v - b.mean) / b.sd;
  return Math.max(-3, Math.min(3, b.lower_is_better ? -x : x));
}
// A 0-100 rating from the average standard score of some stats (50 = the average player).
function ratingFrom(keys, stats) {
  const zs = keys.map((k) => zOf(k, stats[k])).filter((x) => x != null);
  return zs.length >= Math.ceil(keys.length / 2) ? Math.round(phi(zs.reduce((a, b) => a + b, 0) / zs.length) * 100) : null;
}
const AIM_RATING_KEYS = ["spotted_accuracy", "ttd_ms", "ttk_ms", "crosshair_deg", "head_accuracy", "hs_kill_pct", "first_bullet", "spray_accuracy", "counter_strafe"];
// Leetify's Aim rating, as reproduced from their published averages and your matches: the six aim
// stats against Leetify's average player, equally weighted (Accuracy, all shots, isn't counted),
// as 0-100 where 50 is average. One match is judged against how much single matches vary; a
// period's matches together (their round-weighted averages) against how much players' averages vary.
// [stat, average, spread per match, spread of many-match averages, lower is better]
const LEETIFY_AIM = [
  ["spotted_accuracy", 33, 7.12, 7.3, false], ["ttd_ms", 641, 106.1, 51, true], ["crosshair_deg", 10.19, 3.17, 1.47, true],
  ["head_accuracy", 19, 8.96, 5.8, false], ["spray_accuracy", 34, 14.04, 4.9, false], ["counter_strafe", 76, 8.57, 7.5, false],
];
function leetifyAim(stats, many = false) {
  if (!stats) return null;
  const zs = LEETIFY_AIM.filter(([k]) => stats[k] != null && Number.isFinite(stats[k])).map(([k, mu, sd1, sdN, lower]) => ((stats[k] - mu) / (many ? sdN : sd1)) * (lower ? -1 : 1));
  return zs.length >= 4 ? Math.round(phi(zs.reduce((a, b) => a + b, 0) / zs.length) * 100) : null;
}
// Round-weighted averages of several matches' stats (my_stats.json rows: { rounds, stats }).
function meanStats(rows) {
  const sums = {}, ws = {};
  for (const r of rows) {
    const w = r.rounds || 1;
    for (const [k, v] of Object.entries(r.stats || {})) {
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      sums[k] = (sums[k] || 0) + v * w;
      ws[k] = (ws[k] || 0) + w;
    }
  }
  return Object.fromEntries(Object.keys(sums).map((k) => [k, sums[k] / ws[k]]));
}
const QUALITY_KEYS = ["flash_assist_pct", "enemies_per_flash", "friends_per_flash", "blind_time", "he_damage_avg", "he_team_damage_avg"];
const aimRating = (s) => leetifyAim(s);
// Leetify's published Quantity formula; Quality is the flash/HE stats against your library.
const quantityRating = (s) => (s.nades_per_round == null ? null : Math.round(Math.min(100, (s.nades_per_round / 3) ** (2 / 3) * 100)));
const qualityRating = (s) => ratingFrom(QUALITY_KEYS, s);
function utilityRating(s) {
  const q = qualityRating(s), n = quantityRating(s);
  return q == null || n == null ? null : Math.round(Math.sqrt(q * n));
}
const ratingChip = (v) => `<span class="mp-rating ${v == null ? "" : bandOf(v / 100)}">${v == null ? "–" : v}</span>`;

const WEAPON_NAMES = {
  ak47: "AK-47", m4a1: "M4A4", m4a1_silencer: "M4A1-S", awp: "AWP", ssg08: "SSG 08", deagle: "Desert Eagle", revolver: "R8 Revolver",
  usp_silencer: "USP-S", glock: "Glock-18", hkp2000: "P2000", p250: "P250", fiveseven: "Five-SeveN", tec9: "Tec-9", cz75a: "CZ75-Auto",
  elite: "Dual Berettas", famas: "FAMAS", galilar: "Galil AR", aug: "AUG", sg556: "SG 553", g3sg1: "G3SG1", scar20: "SCAR-20",
  mac10: "MAC-10", mp9: "MP9", mp7: "MP7", mp5sd: "MP5-SD", ump45: "UMP-45", p90: "P90", bizon: "PP-Bizon", nova: "Nova",
  xm1014: "XM1014", mag7: "MAG-7", sawedoff: "Sawed-Off", m249: "M249", negev: "Negev", hegrenade: "HE grenade",
  inferno: "Molotov", molotov: "Molotov", incgrenade: "Incendiary", flashbang: "Flashbang", taser: "Zeus x27", world: "World",
};
const weaponName = (w) => WEAPON_NAMES[w] || (w.startsWith("knife") || w === "bayonet" ? "Knife" : w);
const weaponFile = (w) => (w.startsWith("knife") || w === "bayonet" ? "knife" : w === "molotov" ? "inferno" : w);
function weaponIcon(w) {
  if (!w) return `<span class="sub">N/A</span>`;
  const name = esc(weaponName(w));
  return `<img class="wicon" src="${assetUrl(`weapons/${weaponFile(w)}.svg`)}" alt="${name}" title="${name}" onerror="this.outerHTML='<span class=&quot;wtext&quot;>${name}</span>'">`;
}

// Players of one side with their row data and details, for the tab tables.
function detailRows(m, d) {
  const byId = new Map((d?.players || []).map((p) => [p.steamid, p]));
  return m.players.map((p) => ({ p, d: byId.get(p.steamid), s: byId.get(p.steamid)?.stats || {} }));
}

// Both teams in Leetify's table look: `cols` = [{ key, label, tip, value(row) -> number|null, cell(row, ctx) -> html }].
function teamTables(body, m, rows, cols, sortState, rerender) {
  const me = state.index.me;
  const value = (r, c) => (c.value ? c.value(r) : null);
  const col = cols.find((c) => c.key === sortState.key) || cols[0];
  const sorted = (side) => rows.filter((r) => r.p.side === side).sort((a, b) => {
    const x = value(a, col), y = value(b, col);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return (x - y) * (sortState.desc ? -1 : 1);
  });
  // Best value across all ten players per column (for the star and the in-cell bars).
  const ctx = {};
  for (const c of cols) {
    const vals = rows.map((r) => value(r, c)).filter((v) => v != null);
    ctx[c.key] = { max: Math.max(0, ...vals), best: c.lower ? Math.min(...vals) : Math.max(...vals) };
  }
  const head = (title, won, tie) => `<tr class="mp-team"><th class="mp-name">${title} <span class="mp-badge ${won ? "win" : "loss"}">${won ? "WIN" : tie ? "TIE" : "LOSS"}</span></th>
    ${cols.map((c) => `<th data-sort="${c.key}" class="${sortState.key === c.key ? "on" : ""}" ${c.tip ? `title="${esc(c.tip)}"` : ""}>${c.label}${sortState.key === c.key ? (sortState.desc ? " ↓" : " ↑") : ""}</th>`).join("")}</tr>`;
  const parties = partyTabs(m);
  const row = (r, won) => `<tr class="${won ? "won" : "lost"} ${r.p.steamid === me ? "me" : ""}">
    <td class="mp-name">${nameCell(r.p, m._roster, true, parties.get(r.p.steamid))}</td>
    ${cols.map((c) => c.cell(r, ctx[c.key])).join("")}</tr>`;
  const mineWon = m.result === "win", theirsWon = m.result === "loss", tie = m.result === "tie";
  body.innerHTML = `<div class="mp-board-wrap"><table class="mp-board">
      <thead>${head("My Team", mineWon, tie)}</thead><tbody>${sorted("mine").map((r) => row(r, mineWon)).join("")}</tbody>
      <thead>${head("Enemy Team", theirsWon, tie)}</thead><tbody>${sorted("enemy").map((r) => row(r, theirsWon)).join("")}</tbody>
    </table></div>`;
  fitBoard(body);
  body.querySelectorAll("th[data-sort]").forEach((th) => (th.onclick = () => {
    const k = th.dataset.sort;
    const c = cols.find((x) => x.key === k);
    sortState.desc = sortState.key === k ? !sortState.desc : !c?.lower;
    sortState.key = k;
    rerender();
  }));
}

// A stat cell colored by where it sits in your library, with an optional star for the match's best.
function statCell(key, fmt, opts = {}) {
  return (r, ctx) => {
    const v = r.s[key];
    if (v == null) return `<td class="na">n/a</td>`;
    const star = opts.star && ctx && v === ctx.best ? ` <span class="star">★</span>` : "";
    return `<td class="${bandOf(standing(key, v))}">${fmt(v)}${star}</td>`;
  };
}
const pct0 = (v) => `${Math.round(v)}%`;
const ms0 = (v) => `${Math.round(v)}ms`;
const deg2 = (v) => `${v.toFixed(2)}°`;

const AIM_COLS = [
  { key: "aim_rating", label: "Aim Rating", tip: "Leetify's Aim rating, reproduced: spotted accuracy, time to damage, crosshair placement, head accuracy, spray accuracy and counter-strafing, equally weighted against Leetify's average player (50 = average). Accuracy (All) isn't counted.",
    value: (r) => aimRating(r.s), cell: (r) => `<td>${ratingChip(aimRating(r.s))}</td>` },
  { key: "spotted_accuracy", label: "Spotted Accuracy", tip: "When you were firing at a spotted enemy, how many of those shots hit. All hits divided by all shots at the spotted enemy.", value: (r) => r.s.spotted_accuracy, cell: statCell("spotted_accuracy", pct0) },
  { key: "ttd_ms", label: "Time to Damage", lower: true, tip: "Median time from first seeing an enemy to first damaging them. Waits over 1 s (holding an angle) are excluded. Not reaction time: it includes accuracy, crosshair placement and fire rate.", value: (r) => r.s.ttd_ms, cell: statCell("ttd_ms", ms0) },
  { key: "ttk_ms", label: "Time to Kill", lower: true, tip: "Median time from seeing an enemy to killing them. Kills that took over 5 s from the first hit are ignored.", value: (r) => r.s.ttk_ms, cell: statCell("ttk_ms", ms0) },
  { key: "crosshair_deg", label: "Cross. Placement", lower: true, tip: "Median angle your crosshair moved from first seeing an enemy until the first hit on them. Lower is better.", value: (r) => r.s.crosshair_deg, cell: statCell("crosshair_deg", deg2) },
  { key: "head_accuracy", label: "Head Accuracy", tip: "Hits on enemies that were in the head, divided by all hits on enemies. AWP shots excluded.", value: (r) => r.s.head_accuracy, cell: statCell("head_accuracy", pct0) },
  { key: "hs_kill_pct", label: "HS Kill %", tip: "Kills that were headshots.", value: (r) => r.s.hs_kill_pct, cell: statCell("hs_kill_pct", pct0) },
  { key: "first_bullet", label: "First Bullet", tip: "How often your first bullet hits after spotting an enemy. Only shots fired with the recoil fully reset; shotguns and snipers excluded.", value: (r) => r.s.first_bullet, cell: statCell("first_bullet", pct0) },
  { key: "spray_accuracy", label: "Spray Accuracy", tip: "Rifles only. A spray is 3+ shots in a row; shots in sprays that hit, divided by all spray shots, with an enemy spotted.", value: (r) => r.s.spray_accuracy, cell: statCell("spray_accuracy", pct0) },
  { key: "counter_strafe", label: "Counter-Strafing", tip: "Rifle shots with an enemy spotted (not fully crouched) fired below 34% of the gun's max speed, where inaccuracy kicks in.", value: (r) => r.s.counter_strafe, cell: statCell("counter_strafe", pct0) },
  { key: "accuracy", label: "Accuracy (All)", tip: "All hits divided by all shots. Not part of the Aim Rating.", value: (r) => r.s.accuracy, cell: statCell("accuracy", pct0) },
];

const UTIL_COLORS = { flashes: "#3fb6c9", smokes: "#4a7cf0", hes: "#c27a3e", molotovs: "#d0453f" };
const UTIL_NAMES = { flashes: "Flashes", smokes: "Smokes", hes: "HEs", molotovs: "Molotovs" };
function utilMix(u) {
  const parts = [["flashes", u.flashes], ["smokes", u.smokes], ["hes", u.hes], ["molotovs", u.molotovs]];
  return `<span class="umix">${parts.filter(([, n]) => n).map(([k, n]) => `<i style="flex:${n};background:${UTIL_COLORS[k]}" title="${n} ${k}">${n}</i>`).join("")}</span>`;
}
const UTIL_COLS = [
  { key: "utility_rating", label: "Utility Rating", tip: "Geometric mean of Quality and Quantity (Leetify's method).", value: (r) => utilityRating(r.s), cell: (r) => `<td>${ratingChip(utilityRating(r.s))}</td>` },
  { key: "quality", label: "Quality Rating", tip: "Flash assists, enemies and friends flashed, blind time, HE damage and HE team damage, against every player in your library (50 = average).", value: (r) => qualityRating(r.s), cell: (r) => `<td>${ratingChip(qualityRating(r.s))}</td>` },
  { key: "flash_assist_pct", label: "Flash Assists", tip: "Kills your flashes assisted, per flash thrown.", value: (r) => r.s.flash_assist_pct, cell: statCell("flash_assist_pct", pct0) },
  { key: "enemies_per_flash", label: "Enemies flashed", tip: "Enemies blinded for 1.1 s or more, per flash.", value: (r) => r.s.enemies_per_flash, cell: statCell("enemies_per_flash", (v) => v.toFixed(2)) },
  { key: "friends_per_flash", label: "Friends flashed", lower: true, tip: "Teammates blinded for 1.1 s or more, per flash.", value: (r) => r.s.friends_per_flash, cell: statCell("friends_per_flash", (v) => v.toFixed(2)) },
  { key: "blind_time", label: "Avg blind time", tip: "Average time enemies stayed blind from your flashes.", value: (r) => r.s.blind_time, cell: statCell("blind_time", (v) => `${v.toFixed(1)}sec`) },
  { key: "he_damage_avg", label: "Avg HE damage", tip: "Damage to enemies per HE grenade.", value: (r) => r.s.he_damage_avg, cell: statCell("he_damage_avg", (v) => v.toFixed(2)) },
  { key: "he_team_damage_avg", label: "Avg HE team damage", lower: true, tip: "Damage to teammates per HE grenade.", value: (r) => r.s.he_team_damage_avg, cell: statCell("he_team_damage_avg", (v) => v.toFixed(2)) },
  { key: "quantity", label: "Quantity Rating & Utility Usage", tip: "Grenades thrown per round (decoys aside): min(100, (per round / 3)^(2/3) x 100).", value: (r) => quantityRating(r.s),
    cell: (r) => `<td class="uq">${ratingChip(quantityRating(r.s))}${r.d ? utilMix(r.d.utility) : ""}</td>` },
  { key: "unused_utility", label: "Avg unused utility", lower: true, tip: "Value of the grenades you still had when you died, per death.", value: (r) => r.s.unused_utility, cell: statCell("unused_utility", (v) => `${Math.round(v)}$`) },
];

// Activity: in-cell bars against the match's highest value, a star for the best.
function barCell(key, fmt, color) {
  return (r, ctx) => {
    const v = r.s[key];
    if (v == null) return `<td class="na">n/a</td>`;
    const w = ctx.max ? Math.max(2, (v / ctx.max) * 100) : 0;
    const star = v === ctx.best && v > 0 ? ` <span class="star">★</span>` : "";
    return `<td class="barcell"><i style="width:${w}%;background:${color}"></i><span>${fmt(r, v)}${star}</span></td>`;
  };
}
const ACT_COLS = [
  { key: "damage", label: "Total Damage", value: (r) => r.s.damage, cell: barCell("damage", (r, v) => Math.round(v), "var(--bar-neutral)") },
  { key: "he_damage", label: "HE dmg", value: (r) => r.s.he_damage, cell: barCell("he_damage", (r, v) => Math.round(v), "#7a2f33") },
  { key: "molotov_damage", label: "Molotov dmg", value: (r) => r.s.molotov_damage, cell: barCell("molotov_damage", (r, v) => Math.round(v), "#7a4a24") },
  { key: "enemies_flashed", label: "Enemies Flashed", tip: "Enemies blinded for 1.1 s or more.", value: (r) => r.s.enemies_flashed, cell: barCell("enemies_flashed", (r, v) => Math.round(v), "#255a66") },
  { key: "shots", label: "Shots Fired", value: (r) => r.s.shots, cell: barCell("shots", (r, v) => Math.round(v), "var(--bar-neutral)") },
  { key: "wasted_magazine", label: "Wasted Magazine %", lower: true, tip: "How much of the magazine was still loaded when you reloaded (bullets left / magazine size, over all reloads).", value: (r) => r.s.wasted_magazine,
    cell: (r, ctx) => {
      const v = r.s.wasted_magazine;
      if (v == null) return `<td class="na">n/a</td>`;
      const star = v === ctx.best ? ` <span class="star">★</span>` : "";
      return `<td class="barcell"><i style="width:${Math.max(2, v)}%;background:var(--bar-neutral)"></i><span>${Math.round(v)}% (${r.d.activity.wasted_bullets} bullets)${star}</span></td>`;
    } },
  { key: "rounds_survived_pct", label: "Rounds Survived", value: (r) => r.s.rounds_survived_pct,
    cell: (r, ctx) => {
      const v = r.s.rounds_survived_pct;
      if (v == null) return `<td class="na">n/a</td>`;
      return `<td class="barcell"><i style="width:${Math.max(2, v)}%;background:var(--bar-neutral)"></i><span>${r.d.activity.rounds_survived} (${Math.round(v)}%)</span></td>`;
    } },
];

const detailSorts = { aim: { key: "aim_rating", desc: true }, utility: { key: "utility_rating", desc: true }, activity: { key: "damage", desc: true }, trades: { key: "trade_kill_opps", desc: true }, opening: { key: "attempts", desc: true } };
const detailSide = { opening: "all", clutches: "all" };

const noDetails = (body) => (body.innerHTML = `<div class="empty">This match's details aren't built yet. Veloxify analyzes older matches in the background while CS2 is closed; this tab fills in when it gets to this one.</div>`);

async function renderStatTab(body, m, id, tab) {
  const [d] = await Promise.all([loadDetails(id), loadBenchmarks()]);
  if (!d) return noDetails(body);
  const rows = detailRows(m, d);
  const cols = { aim: AIM_COLS, utility: UTIL_COLS, activity: ACT_COLS }[tab];
  const draw = () => {
    teamTables(body, m, rows, cols, detailSorts[tab], draw);
    if (tab === "utility") {
      // Each team's utility mix above its table.
      body.querySelectorAll("tbody").forEach((tb, i) => {
        const side = i === 0 ? "mine" : "enemy";
        const t = { flashes: 0, smokes: 0, hes: 0, molotovs: 0 };
        for (const r of rows.filter((x) => x.p.side === side && x.d)) for (const k in t) t[k] += r.d.utility[k];
        const total = t.flashes + t.smokes + t.hes + t.molotovs;
        const pct = (n) => (total ? Math.round((n / total) * 100) : 0);
        const bar = document.createElement("tr");
        bar.className = "umix-row";
        bar.innerHTML = `<td colspan="${cols.length + 1}"><div class="umix-total"><b>${total} total</b>
          <div class="umix-bar">${Object.entries(t).filter(([, n]) => n).map(([k, n]) => `<i style="flex:${n};background:${UTIL_COLORS[k]}">${pct(n)}%</i>`).join("")}</div></div>
          <div class="umix-legend">${Object.entries(t).map(([k, n]) => `<span><i style="background:${UTIL_COLORS[k]}"></i>${UTIL_NAMES[k]}: ${n}</span>`).join("")}</div></td>`;
        tb.parentNode.insertBefore(bar, tb.previousElementSibling);
      });
    }
    const note = document.createElement("div");
    note.className = "note";
    note.textContent = {
      aim: "Colors compare each value with every player-match in your library: bottom 10% Poor, 10-30% Subpar, 30-70% Average, 70-90% Good, top 10% Great. \"Spotted\" is CS2's own spotted state, so Time to Damage and Crosshair Placement run lower than Leetify's numbers (it flags a visible enemy a moment later than Leetify's own line-of-sight check).",
      utility: "Utility, Quality and Quantity ratings: 50 = the average player in your library. A flash counts from 1.1 s of blindness.",
      activity: "Bars compare the ten players in this match; ★ marks the best.",
    }[tab];
    body.appendChild(note);
  };
  draw();
}

// ---- match page: trades, head to head, map zones ---------------------------------------------------

// "67% (2/3)", colored against the library like the other stats.
function fracCell(key, num, den) {
  return (r) => {
    const v = r.s[key];
    if (v == null || !r.d) return `<td class="na">n/a</td>`;
    return `<td class="${bandOf(standing(key, v))}">${Math.round(v)}% <span class="sub">(${r.d.trades[num]}/${r.d.trades[den]})</span></td>`;
  };
}

const TRADE_COLS = [
  { key: "trade_kill_opps", label: "Trade Kill Opportunities", tip: "A teammate died and you were alive and close enough to the killer to trade them (within about 19 m), or got to them anyway.",
    value: (r) => r.s.trade_kill_opps, cell: barCell("trade_kill_opps", (r, v) => Math.round(v), "var(--bar-neutral)") },
  { key: "trade_kill_attempt_pct", label: "Trade Kill Attempts", tip: "Of those, how often you hit the killer within 5 seconds.", value: (r) => r.s.trade_kill_attempt_pct, cell: fracCell("trade_kill_attempt_pct", "kill_attempts", "kill_opps") },
  { key: "trade_kill_success_pct", label: "Trade Kill Success", tip: "Of your attempts, how often you killed the killer within 5 seconds.", value: (r) => r.s.trade_kill_success_pct, cell: fracCell("trade_kill_success_pct", "kill_success", "kill_attempts") },
  { key: "traded_death_opps", label: "Traded Death Opportunities", tip: "You died with a teammate alive and close enough to trade your killer.",
    value: (r) => r.s.traded_death_opps, cell: barCell("traded_death_opps", (r, v) => Math.round(v), "var(--bar-neutral)") },
  { key: "traded_death_attempt_pct", label: "Traded Death Attempts", tip: "Of those, how often a teammate hit your killer within 5 seconds.", value: (r) => r.s.traded_death_attempt_pct, cell: fracCell("traded_death_attempt_pct", "death_attempts", "death_opps") },
  { key: "traded_death_success_pct", label: "Traded Death Success", tip: "Of those attempts, how often a teammate killed your killer within 5 seconds.", value: (r) => r.s.traded_death_success_pct, cell: fracCell("traded_death_success_pct", "death_success", "death_attempts") },
];

async function renderTradesTab(body, m, id) {
  const [d] = await Promise.all([loadDetails(id), loadBenchmarks()]);
  if (!d) return noDetails(body);
  if (!d.players.some((p) => p.trades)) { body.innerHTML = `<div class="empty">Trades need this match analyzed again; Veloxify does that in the background while CS2 is closed.</div>`; return; }
  const rows = detailRows(m, d);
  const draw = () => {
    teamTables(body, m, rows, TRADE_COLS, detailSorts.trades, draw);
    // Your own deaths, traded or not: the untraded ones are the ones to talk through.
    const me = state.index.me;
    const names = new Map(m.players.map((p) => [p.steamid, p.name]));
    const mine = d.kills.filter((k) => k.victim === me && !k.team_kill && k.attacker);
    const list = document.createElement("section");
    list.className = "panel tr-deaths";
    list.innerHTML = `<div class="panel-head"><div class="h3">Your deaths</div><span class="grow"></span><span class="sub">${mine.filter((k) => k.traded).length} of ${mine.length} traded</span></div>
      <div class="tr-list">${mine.map((k) => `<a class="tr-row ${k.traded ? "ok" : ""}" href="${matchHref(id, "replay")}" data-round="${k.round}" data-t="${k.t}">
        <span class="tr-r">R${k.round}</span><span>${esc(names.get(k.attacker) || "")} ${weaponIcon(k.weapon)} you · ${mmss(k.t)}${k.victim_place ? ` · ${esc(placeName(k.victim_place))}` : ""}</span>
        <b>${k.traded ? "Traded" : "Not traded"}</b></a>`).join("") || `<div class="empty small">You didn't die this match.</div>`}</div>`;
    body.appendChild(list);
    list.querySelectorAll("[data-round]").forEach((a) => (a.onclick = () => { Object.assign(replay, { matchId: id, round: Number(a.dataset.round), t: Math.max(0, Number(a.dataset.t) - 4), playing: false }); }));
    const note = document.createElement("div");
    note.className = "note";
    note.textContent = "A trade is a kill on the enemy who just killed a teammate, within 5 seconds. Colors compare each value with every player-match in your library. Click a death to watch it in the 2D replay.";
    body.appendChild(note);
  };
  draw();
}

const placeName = (s) => (s || "").replace(/([a-z])([A-Z])/g, "$1 $2").replace("Bombsite", "Site ");

// Head to head: every player on your team against every enemy (kills each way).
const h2h = { cell: null };
async function renderH2HTab(body, m, id) {
  const d = await loadDetails(id);
  if (!d) return noDetails(body);
  const me = state.index.me;
  const mine = m.players.filter((p) => p.side === "mine").sort((a, b) => (a.steamid === me ? -1 : b.steamid === me ? 1 : b.kills - a.kills));
  const enemy = m.players.filter((p) => p.side === "enemy").sort((a, b) => b.kills - a.kills);
  const kills = d.kills.filter((k) => !k.team_kill && k.attacker);
  const duels = (a, b) => kills.filter((k) => (k.attacker === a && k.victim === b) || (k.attacker === b && k.victim === a));
  const count = (a, b) => kills.filter((k) => k.attacker === a && k.victim === b).length;
  if (h2h.matchId !== id) Object.assign(h2h, { matchId: id, cell: null });
  const cell = (p, e) => {
    const k = count(p.steamid, e.steamid), dd = count(e.steamid, p.steamid);
    const open = duels(p.steamid, e.steamid).filter((x) => x.opening).length;
    const cls = !k && !dd ? "none" : k > dd ? "up" : k < dd ? "down" : "even";
    const on = h2h.cell === `${p.steamid}:${e.steamid}`;
    return `<td class="h2h-c ${cls} ${on ? "on" : ""}" data-cell="${p.steamid}:${e.steamid}" title="${esc(p.name)} killed ${esc(e.name)} ${k}×, died to them ${dd}×${open ? ` (${open} opening duel${open > 1 ? "s" : ""})` : ""}">
      ${!k && !dd ? "–" : `<b>${k}</b><i>:</i><span>${dd}</span>`}${open ? `<em>●</em>` : ""}</td>`;
  };
  const [a, b] = (h2h.cell || ":").split(":");
  const sel = h2h.cell ? duels(a, b).sort((x, y) => x.round - y.round || x.t - y.t) : [];
  const names = new Map(m.players.map((p) => [p.steamid, p.name]));
  body.innerHTML = `
    <section class="panel h2h">
      <table class="h2h-t"><thead><tr><th class="h2h-corner"><span>My team ↓</span><span>Enemy →</span></th>
        ${enemy.map((e) => `<th>${avatarHtml(e.steamid, 28)}<div>${esc(e.name)}</div></th>`).join("")}<th>Total</th></tr></thead>
        <tbody>${mine.map((p) => {
          const k = enemy.reduce((n, e) => n + count(p.steamid, e.steamid), 0), dd = enemy.reduce((n, e) => n + count(e.steamid, p.steamid), 0);
          return `<tr class="${p.steamid === me ? "me" : ""}"><th>${avatarHtml(p.steamid, 28)}<span>${esc(p.name)}</span></th>${enemy.map((e) => cell(p, e)).join("")}
            <td class="h2h-tot"><b>${k}</b><i>:</i><span>${dd}</span></td></tr>`;
        }).join("")}</tbody></table>
      <div class="sub h2h-legend"><span class="up">■</span> won the matchup <span class="down">■</span> lost it <span class="even">■</span> even · <em>●</em> includes an opening duel · numbers are kills : deaths for the row player</div>
    </section>
    ${h2h.cell ? `<section class="panel h2h-detail"><div class="panel-head"><div class="h3">${esc(names.get(a) || "")} vs ${esc(names.get(b) || "")}</div><span class="grow"></span><button class="btn ghost" id="h2h-close">Close</button></div>
      <div class="tl-list">${sel.map((k) => `<div class="tl-ev"><div><b style="color:${TEAM_COLOR[k.attacker === a ? "mine" : "enemy"]}">${esc(names.get(k.attacker) || "")}</b>${weaponIcon(k.weapon)}${k.headshot ? `<span class="hs">◎</span>` : ""}<b style="color:${TEAM_COLOR[k.victim === a ? "mine" : "enemy"]}">${esc(names.get(k.victim) || "")}</b>${k.opening ? `<span class="tag">Opening</span>` : ""}</div>
        <span>Round ${k.round} · ${mmss(k.t)}${k.attacker_place ? ` · ${esc(placeName(k.attacker_place))}` : ""}</span></div>`).join("") || `<div class="empty small">They never fought.</div>`}</div></section>` : ""}`;
  body.querySelectorAll("[data-cell]").forEach((td) => (td.onclick = () => { h2h.cell = h2h.cell === td.dataset.cell ? null : td.dataset.cell; renderH2HTab(body, m, id); }));
  body.querySelector("#h2h-close")?.addEventListener("click", () => { h2h.cell = null; renderH2HTab(body, m, id); });
}

// Map zones: where on the map a player won and lost their fights.
const zones = { player: null, side: "all", sel: null };
async function renderZonesTab(body, m, id) {
  const [d, radar] = await Promise.all([loadDetails(id), loadRadar(m.map)]);
  if (!d) return noDetails(body);
  if (zones.matchId !== id) Object.assign(zones, { matchId: id, player: state.index.me, sel: null });
  const who = zones.player;
  const fights = [];
  for (const k of d.kills) {
    if (k.team_kill || !k.attacker) continue;
    if (k.attacker === who && k.attacker_xy && k.attacker_place) fights.push({ won: true, xy: k.attacker_xy, place: k.attacker_place, side: k.attacker_side, k });
    if (k.victim === who && k.victim_xy && k.victim_place) fights.push({ won: false, xy: k.victim_xy, place: k.victim_place, side: k.victim_side, k });
  }
  const shown = fights.filter((f) => zones.side === "all" || f.side === zones.side);
  const byPlace = new Map();
  for (const f of shown) {
    const z = byPlace.get(f.place) || { place: f.place, kills: 0, deaths: 0, open_k: 0, open_d: 0, xs: [], ys: [] };
    if (f.won) { z.kills++; z.open_k += f.k.opening ? 1 : 0; } else { z.deaths++; z.open_d += f.k.opening ? 1 : 0; }
    z.xs.push(f.xy[0]); z.ys.push(f.xy[1]);
    byPlace.set(f.place, z);
  }
  const avg = (v) => v.reduce((a, b) => a + b, 0) / v.length;
  const list = [...byPlace.values()].map((z) => ({ ...z, n: z.kills + z.deaths, win: z.kills / (z.kills + z.deaths), x: avg(z.xs), y: avg(z.ys) }))
    .sort((a, b) => b.n - a.n || b.kills - a.kills);
  const size = radar?.size || 1024;
  const at = (x, y) => (radar ? [(x - radar.pos_x) / radar.scale, (radar.pos_y - y) / radar.scale] : [0, 0]);
  const color = (w) => (w >= 0.6 ? "var(--win)" : w <= 0.4 ? "var(--loss)" : "#c9a227");
  const maxN = Math.max(1, ...list.map((z) => z.n));
  const sel = list.find((z) => z.place === zones.sel);
  const players = m.players.slice().sort((a, b) => (a.side === b.side ? a.name.localeCompare(b.name) : a.side === "mine" ? -1 : 1));
  const dots = (sel ? shown.filter((f) => f.place === sel.place) : []).map((f) => {
    const [x, y] = at(f.xy[0], f.xy[1]);
    return `<circle cx="${x}" cy="${y}" r="6" class="mz-fight ${f.won ? "won" : "lost"}"><title>Round ${f.k.round}: ${f.won ? "kill" : "death"}</title></circle>`;
  }).join("");
  body.innerHTML = `
    <div class="ln-bar">
      <select id="mz-player">${players.map((p) => `<option value="${p.steamid}" ${p.steamid === who ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select>
      <div class="seg" id="mz-side">${[["all", "Both sides"], ["T", "T side"], ["CT", "CT side"]].map(([k, l]) => `<button data-side="${k}" class="${zones.side === k ? "on" : ""}">${l}</button>`).join("")}</div>
      <span class="sub">${shown.filter((f) => f.won).length} kills · ${shown.filter((f) => !f.won).length} deaths in ${list.length} zones</span>
    </div>
    <div class="ln-main">
      <section class="tl-map"><div class="tl-viewport rp-viewport"><div class="tl-canvas">
        ${radar ? `<img src="${assetUrl(`radars/${m.map}.png`)}" alt="${esc(mapName(m.map))} radar" draggable="false">` : `<div class="tl-noradar">Radar not available for ${esc(mapName(m.map))} yet</div>`}
        <svg viewBox="0 0 ${size} ${size}">${list.map((z) => {
          const [x, y] = at(z.x, z.y), r = 16 + 22 * Math.sqrt(z.n / maxN);
          return `<g class="mz-zone ${sel && sel !== z ? "dim" : ""}" data-zone="${esc(z.place)}"><circle cx="${x}" cy="${y}" r="${r}" fill="${color(z.win)}" class="mz-bubble"/>
            <text x="${x}" y="${y + 5}" text-anchor="middle" class="mz-kd">${z.kills}-${z.deaths}</text>
            <text x="${x}" y="${y + r + 15}" text-anchor="middle" class="mz-name">${esc(placeName(z.place))}</text></g>`;
        }).join("")}${dots}</svg></div></div></section>
      <section class="tl-events ln-side">
        <table class="mz-t"><thead><tr><th>Zone</th><th>K</th><th>D</th><th>Won</th><th>Opening</th></tr></thead>
          <tbody>${list.map((z) => `<tr data-zone="${esc(z.place)}" class="${sel === z ? "on" : ""}"><td>${esc(placeName(z.place))}</td><td>${z.kills}</td><td>${z.deaths}</td>
            <td><span class="mz-win" style="color:${color(z.win)}">${Math.round(z.win * 100)}%</span></td><td>${z.open_k || z.open_d ? `${z.open_k}-${z.open_d}` : "–"}</td></tr>`).join("") || `<tr><td colspan="5" class="empty small">No fights.</td></tr>`}</tbody></table>
      </section>
    </div>
    <div class="note">Each bubble is a zone (CS2's own callouts) where this player got kills or died: the score is kills-deaths, the color how many of those fights they won (green 60%+, red 40% or less), the size how many fights. Click a zone to see each fight.</div>`;
  const rerender = () => renderZonesTab(body, m, id);
  body.querySelector("#mz-player").onchange = (e) => { zones.player = e.target.value; zones.sel = null; rerender(); };
  body.querySelectorAll("[data-side]").forEach((b) => (b.onclick = () => { zones.side = b.dataset.side; zones.sel = null; rerender(); }));
  body.querySelectorAll("[data-zone]").forEach((el) => (el.onclick = () => { zones.sel = zones.sel === el.dataset.zone ? null : el.dataset.zone; rerender(); }));
}

// ---- match page: rating breakdown ------------------------------------------------------------------

// HLTV Rating 3.0, RWS or Round Swing for one player, taken apart: by side, by what added or cost
// the most, and round by round in plain words (the formula is at the bottom). Rating 3.0 is the
// average of per-round ratings (every part is a per-round sum), so each round's bar is exact.
const breakdown = { player: null, metric: "rating3" };
const R3_PARTS = [
  ["kills", "Kills", "Eco-adjusted kill points per round: a kill counts about 1, less on an eco or with an assist, more for an opening kill."],
  ["damage", "Damage", "Eco-adjusted damage per round."],
  ["survival", "Survival", "1 − eco-adjusted death points per round."],
  ["kast", "KAST", "Rounds with a kill, assist, survival or trade."],
  ["multi", "Multi-kills", "Multi-kill points per round (2K, 3K, ... weigh more than their kills)."],
  ["swing", "Round Swing", "How much you changed your team's chance to win each round."],
];
// What each part means in a sentence ("your kills", "dying").
const PART_WORDS = [["your kills", "no kills"], ["the damage you did", "low damage"], ["surviving", "dying"], ["KAST (a kill, assist, survival or trade)", "no KAST"], ["the multi-kill", ""], ["helping the round", "hurting your team's chances"]];
// Each Round Swing reason, for one event.
const SWING_WHY = {
  kill: ["Killed", "+"], damage: ["Damaged", "+"], flash: ["Flashed", "+"], traded: ["Got traded after dying to", "+"], death: ["Died to", "-"],
  teamkill: ["Team-killed", "-"], plant: ["Planted the bomb", "+"], planted_on: ["Bomb planted while you were alive on CT", "-"], clutch: ["Won the clutch", "+"],
  won_kills: ["Round won: credit for your kills", "+"], defuse: ["Defused the bomb", "+"], won_alive: ["Round won with you alive", "+"], won: ["Round won", "+"],
  lost_alive: ["Round lost while you were still alive (saving or a lost clutch)", "-"], lost: ["Round lost", "-"],
};
// The same, summed over a match ("where your swing came from").
const SWING_GROUPS = {
  kill: "Kills", damage: "Damage on players a teammate killed", flash: "Flash assists", traded: "Deaths your team traded", death: "Deaths",
  teamkill: "Team kills", plant: "Bomb plants", planted_on: "Bomb planted on you (CT, alive)", clutch: "Clutches won", won_kills: "Rounds won (kill share)",
  defuse: "Defuses", won_alive: "Rounds won, alive", won: "Rounds won", lost_alive: "Rounds lost while alive (saves, lost clutches)", lost: "Rounds lost",
};

// Each part of Rating 3.0 for a set of rounds (1.00 = average), and the rating.
function r3Parts(rows, model) {
  const n = Math.max(1, rows.length);
  const sum = (f) => rows.reduce((a, r) => a + f(r), 0);
  const parts = [
    sum((r) => r.e_kills) / n / model.kpr,
    sum((r) => r.e_damage) / n / model.adr,
    (1 - sum((r) => r.e_deaths) / n) / (1 - model.dpr),
    sum((r) => (r.kast ? 1 : 0)) / n / model.kast,
    sum((r) => r.multi) / n / model.multi,
    1 + sum((r) => r.swing / 100) / n / model.swing_scale,
  ];
  return { parts, rating: parts.reduce((a, p, i) => a + p * model.weights[i], 0) };
}

async function renderBreakdownTab(body, m, id) {
  const d = await loadDetails(id);
  if (!d) return noDetails(body);
  const model = d.r3_model;
  if (!model?.weights || !d.rounds.some((r) => r.players.some((p) => p.e_kills != null))) {
    body.innerHTML = `<div class="empty">The rating breakdown needs this match analyzed again; Veloxify does that in the background while CS2 is closed.</div>`;
    return;
  }
  if (breakdown.matchId !== id) Object.assign(breakdown, { matchId: id, player: state.index.me });
  const who = m.players.some((p) => p.steamid === breakdown.player) ? breakdown.player : m.players[0].steamid;
  const me = m.players.find((p) => p.steamid === who);
  const metric = breakdown.metric;
  const rws = metric === "rws", swingView = metric === "swing";
  const names = new Map(m.players.map((p) => [p.steamid, p.name]));
  const nameOf = (s) => esc(names.get(s) || "someone");
  const hasSwings = d.rounds.some((r) => r.swings?.length);
  // This player's rounds, with the round's result for them and their team's damage (for RWS).
  const rows = d.rounds.map((r) => {
    const p = r.players.find((x) => x.steamid === who);
    if (!p) return null;
    const won = (r.winner === "mine") === (me.side === "mine");
    const teamDamage = r.players.filter((x) => x.side === p.side).reduce((a, x) => a + x.damage, 0);
    const teamSize = r.players.filter((x) => x.side === p.side).length;
    const events = (r.swings || []).filter((e) => e.player === who);
    return { ...p, number: r.number, won, reason: r.reason, teamDamage, teamSize, events, bombRound: r.reason === "bomb_exploded" || r.reason === "bomb_defused" };
  }).filter(Boolean);
  const w = model.weights;
  const roundRating = (r) => r3Parts([r], model).rating;
  const value = (rs) => (rws ? rs.reduce((a, r) => a + r.rws, 0) / Math.max(1, rs.length) : swingView ? rs.reduce((a, r) => a + r.swing, 0) / Math.max(1, rs.length) : r3Parts(rs, model).rating);
  const fmt = (v) => (rws ? v.toFixed(1) : swingView ? fmtSwing(v) : v.toFixed(2));
  const sides = { all: rows, T: rows.filter((r) => r.side === "T"), CT: rows.filter((r) => r.side === "CT") };
  const verdict = (v) => {
    if (swingView) return v >= 2 ? ["Swinging rounds", "up"] : v <= -2 ? ["Costing rounds", "down"] : ["Even", ""];
    const avg = rws ? 10 : 1;
    return v >= avg * 1.1 ? ["Overperforming", "up"] : v <= avg * 0.9 ? ["Underperforming", "down"] : ["On par", ""];
  };
  const dialOf = (v, label, color) => { const [t, c] = verdict(v); return dial(fmt(v), rws ? v / 25 : swingView ? 0.5 + v / 20 : v / 2, label, t, 150, color, c); };
  const pct = (v) => `${Math.round(v)}%`;
  const signed = (v) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}%`;

  // One swing event in words.
  const kill = (r, attacker, victim) => d.kills.find((k) => k.round === r.number && k.attacker === attacker && k.victim === victim);
  const eventLine = (r, e) => {
    const [what] = SWING_WHY[e.why] || [e.why];
    const other = e.other ? nameOf(e.other) : "";
    let text;
    switch (e.why) {
      case "kill": { const k = kill(r, who, e.other); text = `Killed <b>${other}</b>${k ? ` with the ${esc(WEAPON_NAMES[k.weapon] || k.weapon)}${k.headshot ? " (headshot)" : ""}${k.opening ? ", the round's first kill" : ""}${k.trade ? ", trading a teammate" : ""}` : ""}`; break; }
      case "damage": text = `Hurt <b>${other}</b>, and a teammate finished him`; break;
      case "flash": text = `Your flash set up the kill on <b>${other}</b>`; break;
      case "traded": text = `<b>${other}</b> traded your death right away (you drew the enemy out, so you get a share)`; break;
      case "planted_on": text = `<b>${other}</b> planted the bomb while you were alive on CT`; break;
      case "death": { const k = kill(r, e.other, who); text = `Died to <b>${other}</b>${k?.opening ? ", the round's first death" : ""}${k && !k.traded ? " and nobody traded you" : k?.traded ? " (you were traded)" : ""}`; break; }
      default: text = esc(what) + (other ? ` <b>${other}</b>` : "");
    }
    const chance = ["kill", "damage", "flash", "traded", "death", "teamkill", "plant", "planted_on"].includes(e.why) ? ` <span class="sub">(your team's chance to win: ${pct(e.before)} → ${pct(e.after)})</span>` : "";
    return `<div class="bd-ev"><span class="bd-evt">${mmss(e.t)}</span><span>${text}${chance}</span><b class="${e.delta > 0.05 ? "up" : e.delta < -0.05 ? "down" : ""}">${signed(e.delta)}</b></div>`;
  };
  // Why a round rated what it did, in a sentence: what helped and what hurt most.
  const ratingWhy = (r, rating, parts) => {
    const contrib = parts.map((p, i) => [i, w[i] * (p - 1)]);
    const good = contrib.filter(([, c]) => c > 0.04).sort((a, b) => b[1] - a[1]).map(([i]) => PART_WORDS[i][0]).filter(Boolean);
    const bad = contrib.filter(([, c]) => c < -0.04).sort((a, b) => a[1] - b[1]).map(([i]) => PART_WORDS[i][1]).filter(Boolean);
    const level = rating >= 1.5 ? "A big round" : rating >= 1.1 ? "A good round" : rating >= 0.9 ? "An average round" : rating >= 0.5 ? "A below-average round" : "A rough round";
    const facts = [`${r.kills} kill${r.kills === 1 ? "" : "s"}`, r.assists ? `${r.assists} assist${r.assists === 1 ? "" : "s"}` : "", `${r.damage} damage`, r.deaths ? "died" : "survived"].filter(Boolean).join(", ");
    return `<b>${level}: ${rating.toFixed(2)}</b> <span class="sub">(1.00 is average)</span><br>${facts}.${good.length ? ` Pushed it up: ${good.join(", ")}.` : ""}${bad.length ? ` Pulled it down: ${bad.join(", ")}.` : ""}`;
  };
  const explain = (r) => {
    const shown = r.events.filter((e) => Math.abs(e.delta) >= 0.05);
    const evs = shown.length ? `<div class="bd-evs">${shown.map((e) => eventLine(r, e)).join("")}</div>` : "";
    if (rws) {
      if (!r.won) return `<b>Round ${r.number} · lost · 0 points</b><br>RWS only gives points in rounds your team wins.`;
      const pool = r.bombRound ? 70 : 100;
      const share = r.teamDamage > 0 ? Math.round((100 * r.damage) / r.teamDamage) : Math.round(100 / r.teamSize);
      return `<b>Round ${r.number} · won · ${r.rws.toFixed(1)} points</b><br>You did ${r.damage} of your team's ${r.teamDamage} damage (${share}%), so you got ${share}% of the round's ${pool} points${r.rws_bomb ? `, plus 30 for ${r.reason === "bomb_defused" ? "defusing" : "planting"} the bomb` : ""}.${r.bombRound && !r.rws_bomb ? " (The bomb ended this round, so 30 of the 100 went to whoever planted or defused it.)" : ""}`;
    }
    if (swingView) {
      return `<b>Round ${r.number} · ${r.won ? "won" : "lost"} · swing ${signed(r.swing)}</b><br>Every moment that changed your team's chance to win, and your share of it:${evs || `<div class="sub">Nothing you did changed the odds this round.</div>`}`;
    }
    const { parts, rating } = r3Parts([r], model);
    return `<b>Round ${r.number} · ${r.won ? "won" : "lost"}</b><br>${ratingWhy(r, rating, parts)}${evs ? `<div class="bd-evhead">What happened</div>${evs}` : ""}`;
  };

  // Gained and lost, by part: Rating 3.0 = 1.00 + Σ weight × (part − 1). Swing: by cause.
  let gains, gainsTitle, gainsSub;
  if (rws) {
    const n = Math.max(1, rows.length);
    const bomb = rows.reduce((a, r) => a + r.rws_bomb, 0) / n;
    const dmg = rows.reduce((a, r) => a + r.rws - r.rws_bomb, 0) / n;
    gains = [["Damage share in rounds won", dmg, "Points for your share of your team's damage in the rounds you won (70 or 100 per round, split by damage)."],
      ["Bomb planted / defused", bomb, "30 points for planting the bomb that exploded, or defusing it, in rounds you won."]];
    [gainsTitle, gainsSub] = ["Where the points came from", "points per round"];
  } else if (swingView) {
    const n = Math.max(1, rows.length);
    const by = {};
    for (const r of rows) for (const e of r.events) by[e.why] = (by[e.why] || 0) + e.delta;
    gains = Object.entries(by).map(([k, v]) => [SWING_GROUPS[k] || k, v / n, `${(v >= 0 ? "+" : "")}${v.toFixed(1)}% over the match`]).sort((a, b) => b[1] - a[1]);
    [gainsTitle, gainsSub] = ["Where your swing came from", "% per round, by cause"];
  } else {
    const { parts } = r3Parts(rows, model);
    gains = R3_PARTS.map(([, label, tip], i) => [label, w[i] * (parts[i] - 1), tip]).sort((a, b) => b[1] - a[1]);
    [gainsTitle, gainsSub] = ["Rating gained & lost", "vs an average player (1.00)"];
  }
  const gmax = Math.max(rws ? 1 : 0.05, ...gains.map((g) => Math.abs(g[1])));
  const gainsHtml = gains.map(([label, v, tip]) => `<div class="bd-gain" title="${esc(tip)}"><span>${esc(label)}</span>
    <div class="bd-gtrack ${rws ? "one" : ""}"><i class="${v >= 0 ? "pos" : "neg"}" style="${rws ? "" : v >= 0 ? "left:50%;" : `right:50%;`}width:${(Math.abs(v) / gmax) * (rws ? 100 : 50)}%"></i></div>
    <b class="${v > 0.004 ? "up" : v < -0.004 ? "down" : ""}">${rws ? v.toFixed(1) : swingView ? signed(v) : `${v >= 0 ? "+" : ""}${v.toFixed(2)}`}</b></div>`).join("");

  // How to raise your swing: the biggest things costing it, in words.
  let tips = "";
  if (swingView) {
    const n = Math.max(1, rows.length);
    const tot = (k) => rows.reduce((a, r) => a + r.events.filter((e) => e.why === k).reduce((x, e) => x + e.delta, 0), 0);
    const deaths = rows.flatMap((r) => r.events.filter((e) => e.why === "death").map((e) => ({ r, e, k: kill(r, e.other, who) })));
    const untraded = deaths.filter((x) => x.k && !x.k.traded), openings = deaths.filter((x) => x.k?.opening);
    const list = [];
    if (untraded.length) list.push(`<b>${untraded.length} of your ${deaths.length} deaths weren't traded</b>, costing ${signed(untraded.reduce((a, x) => a + x.e.delta, 0))}. Play within a teammate's reach (or let them peek first) so a death still wins the fight back.`);
    if (openings.length) list.push(`<b>You died first in ${openings.length} round${openings.length === 1 ? "" : "s"}</b> (${signed(openings.reduce((a, x) => a + x.e.delta, 0))}). An early death costs the most: the team plays 4v5 for the rest of the round.`);
    const saves = tot("lost_alive");
    if (saves < -1) list.push(`<b>Rounds lost while you were still alive</b> cost ${signed(saves)}. Saving keeps your gun, but Swing charges the round to the players left alive: when a round is winnable, playing for it helps your swing.`);
    const flashes = tot("flash"), dmg = tot("damage");
    if (flashes + dmg > 0.5) list.push(`Your utility and damage on kills teammates finished earned ${signed(flashes + dmg)}. Keep flashing for teammates and chipping enemies: it counts even when you don't get the kill.`);
    const kills = rows.flatMap((r) => r.events.filter((e) => e.why === "kill"));
    const big = kills.filter((e) => e.delta >= 10);
    if (big.length) list.push(`Your biggest moments were ${big.length} kill${big.length === 1 ? "" : "s"} worth 10%+ each: opening kills and kills in close rounds move the odds most.`);
    tips = list.length ? `<section class="panel bd-tips"><div class="panel-head"><div class="h3">How to raise your swing</div><span class="grow"></span><span class="sub">From this match</span></div><ul>${list.map((t) => `<li>${t}</li>`).join("")}</ul></section>` : "";
    void n;
  }

  // Round by round: a bar each, its value written on it.
  const vals = rows.map((r) => (rws ? r.rws : swingView ? r.swing : roundRating(r) - 1));
  const labels = rows.map((r, i) => (rws ? (r.rws ? Math.round(r.rws) : "") : swingView ? `${r.swing >= 0 ? "+" : ""}${Math.round(r.swing)}` : roundRating(r).toFixed(2)));
  const vmax = Math.max(rws ? 20 : swingView ? 10 : 0.5, ...vals.map(Math.abs));
  const CW = 1100, CH = 300, top = 16, bottom = 34, mid = rws ? CH - bottom : top + (CH - top - bottom) / 2;
  const bw = (CW - 50) / Math.max(1, rows.length);
  const yOf = (v) => (rws ? mid - (v / vmax) * (CH - top - bottom) : mid - (v / vmax) * ((CH - top - bottom) / 2));
  const ticks = rws ? [0, vmax / 2, vmax] : [-vmax, -vmax / 2, 0, vmax / 2, vmax];
  const bars = rows.map((r, i) => {
    const v = vals[i], x = 44 + i * bw, y = Math.min(yOf(v), mid), h = Math.max(1.5, Math.abs(yOf(v) - mid));
    const thr = swingView ? 0.5 : 0.05;
    const cls = rws ? (v > 0 ? "pos" : "zero") : v > thr ? "pos" : v < -thr ? "neg" : "zero";
    // The value inside the bar when it fits, else just outside its end.
    const inside = h >= 20;
    const ly = inside ? (v >= 0 ? y + 14 : y + h - 6) : v >= 0 ? y - 4 : y + h + 12;
    return `<g class="bd-bar" data-i="${i}"><rect x="${x}" y="${top}" width="${bw}" height="${CH - top - bottom + 4}" class="bd-hit"/>
      <rect x="${x + bw * 0.1}" y="${y}" width="${bw * 0.8}" height="${h}" rx="3" class="${cls}"/>
      ${labels[i] !== "" ? `<text x="${x + bw / 2}" y="${ly}" text-anchor="middle" class="bd-val ${inside ? "in" : ""}">${labels[i]}</text>` : ""}
      <text x="${x + bw / 2}" y="${CH - 10}" text-anchor="middle" class="bd-rnum ${r.won ? "won" : "lost"}">${r.number}</text></g>`;
  }).join("");
  const grid = ticks.map((t) => `<line x1="40" x2="${CW}" y1="${yOf(t)}" y2="${yOf(t)}" class="bd-grid ${t === 0 ? "zero" : ""}"/>
    <text x="34" y="${yOf(t) + 4}" text-anchor="end" class="bd-tick">${rws ? Math.round(t) : swingView ? `${t >= 0 ? "+" : ""}${Math.round(t)}%` : (t >= 0 ? "+" : "") + t.toFixed(2)}</text>`).join("");

  // How it's calculated, with this player's match numbers.
  const n = rows.length;
  const formula = rws
    ? `<p>In every round your team wins, the winners share <b>100 points</b> by damage dealt (or <b>70</b>, when the bomb exploding or being defused ended the round, with <b>30</b> to the planter or defuser). Lost rounds give 0.
       RWS is the average over all rounds:</p>
       <p class="bd-eq">RWS = ${rows.reduce((a, r) => a + r.rws, 0).toFixed(1)} points ÷ ${n} rounds = <b>${fmt(value(rows))}</b></p>`
    : swingView
      ? `<p>Round Swing (part of HLTV Rating 3.0) follows your team's chance to win the round, from the players alive on each side, their equipment and whether the bomb is down. Every kill changes it: the killer gets half the change, the teammates who damaged or flashed the victim share the rest (a traded player gets some back for drawing the enemy out), and the victim is charged the whole drop. A plant credits the planter. When the round ends, what's left of it goes to the winners (clutcher, players with kills, defuser, players alive) and is charged to the losers still alive.</p>
         <p class="bd-eq">Swing = ${rows.reduce((a, r) => a + r.swing, 0).toFixed(1)}% over ${n} rounds = <b>${fmt(value(rows))}</b> per round</p>`
      : (() => {
        const { parts, rating } = r3Parts(rows, model);
        const sum = (f) => rows.reduce((a, r) => a + f(r), 0);
        const items = [
          ["Kills", `${sum((r) => r.e_kills).toFixed(1)} ÷ ${n} ÷ ${model.kpr}`],
          ["Damage", `${sum((r) => r.e_damage).toFixed(0)} ÷ ${n} ÷ ${model.adr}`],
          ["Survival", `(1 − ${sum((r) => r.e_deaths).toFixed(1)} ÷ ${n}) ÷ ${(1 - model.dpr).toFixed(3)}`],
          ["KAST", `${sum((r) => (r.kast ? 1 : 0))} ÷ ${n} ÷ ${model.kast}`],
          ["Multi-kills", `${sum((r) => r.multi).toFixed(2)} ÷ ${n} ÷ ${model.multi}`],
          ["Round Swing", (() => { const sw = sum((r) => r.swing / 100); return `1 ${sw < 0 ? "−" : "+"} ${Math.abs(sw).toFixed(2)} ÷ ${n} ÷ ${model.swing_scale}`; })()],
        ];
        return `<p>HLTV Rating 3.0 adds six parts, each <b>1.00 for an average player</b>, with HLTV's weights. Kills, damage and deaths are eco-adjusted: a kill on an eco counts less, one against a better-armed enemy more.</p>
          <table class="bd-ftable"><thead><tr><th>Part</th><th>This match</th><th>Value</th><th>Weight</th><th>Adds</th></tr></thead><tbody>
          ${items.map(([label, expr], i) => `<tr><td>${label}</td><td><code>${expr}</code></td><td>${parts[i].toFixed(2)}</td><td>× ${w[i]}</td><td>${(parts[i] * w[i]).toFixed(3)}</td></tr>`).join("")}
          <tr class="tot"><td colspan="4">Rating 3.0</td><td>${rating.toFixed(2)}</td></tr></tbody></table>
          <p class="sub">Every part is a per-round sum, so the rating is also the average of the ${n} round ratings in the chart above.</p>`;
      })();

  const players = m.players.slice().sort((a, b) => (a.side === b.side ? r3(b.derived) - r3(a.derived) : a.side === "mine" ? -1 : 1));
  const metrics = [["rating3", "HLTV Rating 3.0"], ["rws", "RWS"], ...(hasSwings ? [["swing", "Round Swing"]] : [])];
  body.innerHTML = `
    <div class="bd-bar-top">
      <select id="bd-player" aria-label="Player">${players.map((p) => `<option value="${p.steamid}" ${p.steamid === who ? "selected" : ""}>${esc(p.name)} · ${p.counts.kills}/${p.counts.deaths}/${p.counts.assists} · ${f2(r3(p.derived))}</option>`).join("")}</select>
      <div class="seg" id="bd-metric">${metrics.map(([k, l]) => `<button data-metric="${k}" class="${metric === k ? "on" : ""}">${l}</button>`).join("")}</div>
      <span class="bd-who">${avatarHtml(who, 28)}<b>${esc(me.name)}</b> <span class="sub">${me.counts.kills} / ${me.counts.deaths} / ${me.counts.assists}</span></span>
    </div>
    <div class="bd-top">
      <section class="panel bd-dials"><div class="panel-head"><div class="h3">Consistency</div></div>
        <div class="bd-dialrow">${dialOf(value(sides.all), rws ? "RWS" : swingView ? "Swing / round" : "Rating 3.0", "")}${sides.T.length ? dialOf(value(sides.T), "T side", "#e0a73a") : ""}${sides.CT.length ? dialOf(value(sides.CT), "CT side", "#5b8fd9") : ""}</div></section>
      <section class="panel bd-gains"><div class="panel-head"><div class="h3">${gainsTitle}</div><span class="grow"></span><span class="sub">${gainsSub}</span></div>
        <div class="bd-gainlist">${gainsHtml}</div></section>
    </div>
    <section class="panel bd-rounds"><div class="panel-head"><div class="h3">${rws ? "RWS points by round" : swingView ? "Round Swing by round" : "Rating by round"}</div><span class="grow"></span><span class="sub">Hover a round to see why</span></div>
      <div class="bd-chart"><svg viewBox="0 0 ${CW} ${CH}" id="bd-svg">${grid}${bars}</svg><div class="bd-tip" id="bd-tip" hidden></div></div></section>
    ${tips}
    <section class="panel bd-how"><div class="panel-head"><div class="h3">How it's calculated</div></div><div class="bd-howbody">${formula}</div></section>`;

  body.querySelector("#bd-player").onchange = (e) => { breakdown.player = e.target.value; renderBreakdownTab(body, m, id); };
  body.querySelectorAll("[data-metric]").forEach((b) => (b.onclick = () => { breakdown.metric = b.dataset.metric; renderBreakdownTab(body, m, id); }));
  const tip = body.querySelector("#bd-tip"), chart = body.querySelector(".bd-chart");
  body.querySelectorAll(".bd-bar").forEach((g) => {
    g.onmouseenter = () => { tip.innerHTML = explain(rows[Number(g.dataset.i)]); tip.hidden = false; g.classList.add("on"); };
    g.onmousemove = (e) => {
      const b = chart.getBoundingClientRect();
      const x = e.clientX - b.left, y = e.clientY - b.top;
      const left = x + 16 + tip.offsetWidth > b.width ? x - tip.offsetWidth - 16 : x + 16;
      tip.style.left = `${Math.max(4, left)}px`;
      tip.style.top = `${Math.max(4, Math.min(y - 20, b.height - tip.offsetHeight - 4))}px`;
    };
    g.onmouseleave = () => { tip.hidden = true; g.classList.remove("on"); };
  });
}

// Opening duels: who took the first fight of each round, with what, and how it went.
async function renderOpeningTab(body, m, id) {
  const d = await loadDetails(id);
  if (!d) return noDetails(body);
  const side = detailSide.opening;
  const names = new Map(m.players.map((p) => [p.steamid, p.name]));
  const team = new Map(m.players.map((p) => [p.steamid, p.side]));
  const openings = d.kills.filter((k) => k.opening);
  const onSide = (s, sideOf) => side === "all" || sideOf === side;
  const roundsOn = (sid) => d.rounds.filter((r) => side === "all" || (team.get(sid) === "mine" ? r.mine_side : r.mine_side === "T" ? "CT" : "T") === side).length;
  const mode = (arr) => {
    const c = new Map();
    for (const x of arr) c.set(x, (c.get(x) || 0) + 1);
    return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
  };
  const rows = m.players.map((p) => {
    const won = openings.filter((k) => k.attacker === p.steamid && onSide(p.steamid, k.attacker_side));
    const lost = openings.filter((k) => k.victim === p.steamid && onSide(p.steamid, k.victim_side));
    const n = won.length + lost.length, rounds = roundsOn(p.steamid);
    return {
      p, s: {}, won, lost,
      attempts: rounds ? (n / rounds) * 100 : null,
      success: n ? (won.length / n) * 100 : null,
      traded: lost.length ? (lost.filter((k) => k.traded).length / lost.length) * 100 : null,
      victim: mode(won.map((k) => k.victim)), weapon: mode(won.map((k) => k.weapon)), diedTo: mode(lost.map((k) => k.weapon)),
    };
  });
  const pctBar = (key) => (r, ctx) => {
    const v = r[key];
    if (v == null) return `<td class="na">–</td>`;
    const star = v === ctx.best && v > 0 ? ` <span class="star">★</span>` : "";
    return `<td class="barcell"><i style="width:${Math.max(2, v)}%;background:var(--bar-neutral)"></i><span>${Math.round(v)}%${star}</span></td>`;
  };
  const cols = [
    { key: "attempts", label: "Attempts", tip: "Rounds in which this player took the round's first duel (won or lost).", value: (r) => r.attempts, cell: pctBar("attempts") },
    { key: "success", label: "Success", tip: "Opening duels won.", value: (r) => r.success, cell: pctBar("success") },
    { key: "traded", label: "Traded", tip: "Opening deaths a teammate traded within 5 s.", value: (r) => r.traded, cell: pctBar("traded") },
    { key: "victim", label: "Most Killed Player", cell: (r) => `<td class="left">${r.victim ? esc(names.get(r.victim) || "") : "N/A"}</td>` },
    { key: "weapon", label: "Best Weapon", cell: (r) => `<td>${weaponIcon(r.weapon)}</td>` },
    { key: "diedTo", label: "Most Died To", cell: (r) => `<td>${weaponIcon(r.diedTo)}</td>` },
  ];
  const sideSeg = `<div class="seg side-seg">${[["all", "Overall"], ["T", "T Side"], ["CT", "CT Side"]].map(([k, l]) => `<button data-side="${k}" class="${side === k ? "on" : ""}">${l}</button>`).join("")}</div>`;
  body.innerHTML = `${sideSeg}<div id="op-tables"></div>
    <div class="h3 mp-sub">Round Breakdown</div>
    <table class="mp-list"><thead><tr><th>Round</th><th>Attacker</th><th>Attacker Side</th><th>Attacker Weapon</th><th>Victim</th><th>Victim Side</th><th>Round Time</th></tr></thead>
    <tbody>${openings.filter((k) => onSide(k.attacker, k.attacker_side)).map((k) => `<tr class="${team.get(k.attacker) === "mine" ? "mine" : "enemy"}">
      <td>${k.round}</td><td>${esc(names.get(k.attacker) || "World")}</td><td class="${k.attacker_side === "T" ? "t-text" : "ct-text"}">${k.attacker_side}</td>
      <td>${weaponIcon(k.weapon)}</td><td>${esc(names.get(k.victim) || "")}</td><td class="${k.victim_side === "T" ? "t-text" : "ct-text"}">${k.victim_side}</td><td>${Math.round(k.t)} sec</td></tr>`).join("")}</tbody></table>`;
  const tables = body.querySelector("#op-tables");
  const draw = () => teamTables(tables, m, rows, cols, detailSorts.opening, draw);
  draw();
  body.querySelectorAll("[data-side]").forEach((b) => (b.onclick = () => { detailSide.opening = b.dataset.side; renderOpeningTab(body, m, id); }));
}

// Clutches: every 1vX, per team and per player, as Leetify lays them out.
async function renderClutchTab(body, m, id) {
  const d = await loadDetails(id);
  if (!d) return noDetails(body);
  const side = detailSide.clutches;
  const team = new Map(m.players.map((p) => [p.steamid, p.side]));
  const list = d.clutches.filter((c) => side === "all" || c.side === side);
  const panel = (which, title) => {
    const players = m.players.filter((p) => p.side === which);
    const mine = list.filter((c) => team.get(c.player) === which);
    const won = mine.filter((c) => c.result === "won").length, saved = mine.filter((c) => c.result === "saved").length;
    const lost = mine.length - won;
    const kills = mine.reduce((a, c) => a + c.kills, 0);
    const wonPct = mine.length ? Math.round((won / mine.length) * 100) : 0;
    const cols = players.map((p) => `<div class="cl-col"><div class="cl-name">${esc(p.name)}</div>
      ${mine.filter((c) => c.player === p.steamid).sort((a, b) => a.round - b.round).map((c) => `<div class="cl-card ${c.result}">
        <b>1v${c.vs}</b><span title="Kills in the clutch">☠ ${c.kills}</span><span class="sub">Round ${c.round}</span><em>${c.result.toUpperCase()}</em></div>`).join("")}</div>`).join("");
    return `<section class="panel cl-team"><div class="panel-head"><div class="h3">${title}</div></div>
      <div class="cl-summary">
        <div class="cl-rate"><div class="cl-pcts"><b class="up">${wonPct}%</b><b class="down">${mine.length ? 100 - wonPct : 0}%</b></div>
          <div class="cl-bar"><i style="width:${wonPct}%"></i></div>
          <div class="cl-counts"><span>${won} clutch${won === 1 ? "" : "es"} won</span><span>${lost} clutch${lost === 1 ? "" : "es"} lost${saved ? `<br>${saved} save${saved === 1 ? "" : "s"}` : ""}</span></div></div>
        <div class="cl-kills"><div class="cl-ring">${kills}</div><div><b>Total kills</b><span class="sub">in clutches</span></div></div>
      </div>
      <div class="cl-cols">${cols || `<div class="empty">No clutches.</div>`}</div></section>`;
  };
  body.innerHTML = `<div class="seg side-seg">${[["all", "Overall"], ["T", "T Side"], ["CT", "CT Side"]].map(([k, l]) => `<button data-side="${k}" class="${side === k ? "on" : ""}">${l}</button>`).join("")}</div>
    <div class="cl-grid">${panel("mine", "My Team")}${panel("enemy", "Enemy Team")}</div>
    <div class="note">A clutch starts when a player is the last one alive on their team. Saved = lost the round but survived.</div>`;
  body.querySelectorAll("[data-side]").forEach((b) => (b.onclick = () => { detailSide.clutches = b.dataset.side; renderClutchTab(body, m, id); }));
}

// HLTV-style summary above the scoreboard: team comparisons, the match's leaders and every
// player's Rating 3.0 against HLTV's Bad / Average / Good bands.
async function renderMatchSummary(el, m, id) {
  const d = await loadDetails(id);
  const me = state.index.me;
  const teams = { mine: m.players.filter((p) => p.side === "mine"), enemy: m.players.filter((p) => p.side === "enemy") };
  const avg = (ps, f) => (ps.length ? ps.reduce((a, p) => a + f(p), 0) / ps.length : 0);
  const total = (ps, f) => ps.reduce((a, p) => a + f(p), 0);
  // An averaged stat can also show where you landed: a tick on the same scale (you against the
  // enemy's average), right of the split when you beat your team's average.
  const cmp = (label, a, b, fmt = (x) => x, you = null) => {
    const share = a + b > 0 ? (a / (a + b)) * 100 : 50;
    const at = you != null && you + b > 0 ? Math.min(98.5, Math.max(1.5, (you / (you + b)) * 100)) : null;
    return `<div class="hs-row"><b class="${a > b ? "up" : a < b ? "down" : ""}">${fmt(a)}${you != null ? `<small class="hs-you-v" title="Yours">you ${fmt(you)}</small>` : ""}</b><span>${label}</span><b class="${b > a ? "up" : b < a ? "down" : ""}">${fmt(b)}</b>
      <div class="hs-split-bar"><i style="width:${share.toFixed(1)}%"></i><i></i>${at != null ? `<em class="hs-you-tick ${you >= a ? "above" : "below"}" style="left:${at.toFixed(1)}%" title="You ${fmt(you)} · your team ${fmt(a)}"></em>` : ""}</div></div>`;
  };
  const mine = m.players.find((p) => p.steamid === me);
  const myHs = mine && mine.counts.kills ? (mine.counts.headshot_kills / mine.counts.kills) * 100 : null;
  const multi = (p) => (p.counts.multikill_rounds || []).slice(2).reduce((a, n) => a + n, 0);
  const hsPct = (ps) => { const k = total(ps, (p) => p.counts.kills); return k ? (total(ps, (p) => p.counts.headshot_kills) / k) * 100 : 0; };
  const awp = new Map();
  for (const k of d?.kills || []) if (k.weapon === "awp" && !k.team_kill) awp.set(k.attacker, (awp.get(k.attacker) || 0) + 1);
  const leader = (label, f, fmt = (x) => x, extra = null) => {
    const p = [...m.players].sort((a, b) => f(b) - f(a))[0];
    if (!p || !(f(p) > 0)) return "";
    return `<div class="hs-leader ${p.side} ${p.steamid === me ? "me" : ""}">${avatarHtml(p.steamid, 34)}<div class="hs-leader-who"><b>${label}</b><span>${esc(p.name)}</span></div>${extra ? `<span class="hs-leader-x">${extra(p)}</span>` : ""}<em>${fmt(f(p))}</em></div>`;
  };
  // The match's MVP (best Rating 3.0), FACEIT's way: who, the rating, then swing, ADR, K/D/A, HS%.
  const mvp = [...m.players].sort((a, b) => r3(b.derived) - r3(a.derived))[0];
  const mvpHtml = (p) => {
    const r = r3(p.derived), c = p.counts, sw = p.derived.swing || 0;
    return `<section class="hs-mvp ${p.side} ${p.steamid === me ? "me" : ""}">
      <div class="hs-mvp-top">
        ${avatarHtml(p.steamid, 40)}
        <div class="hs-mvp-who"><b>${esc(p.name)}</b><div class="hs-mvp-rank">${rankHtml(p, m._roster)}</div></div>
        <div class="hs-mvp-rating" title="HLTV Rating 3.0"><span class="rchip ${ratingClass(r)}">${f2(r)}<i style="width:${Math.min(100, (r / 2) * 100)}%"></i></span><b class="${ratingClass(r)}">${esc(ratingWord(r))}</b></div>
        <div class="hs-mvp-tag"><span class="star">★</span>MVP</div>
      </div>
      <div class="hs-mvp-stats">
        <div><b class="${sw > 0 ? "up" : sw < 0 ? "down" : ""}">${fmtSwing(sw)}</b><span>Swing</span></div>
        <div><b>${f1(p.derived.adr)}</b><span>ADR</span></div>
        <div><b>${c.kills}/${c.deaths}/${c.assists}</b><span>K/D/A</span></div>
        <div><b>${Math.round(p.derived.hs_pct)}%</b><span>Headshot %</span></div>
      </div>
    </section>`;
  };
  const openings = (p) => {
    const won = p.counts.opening_kills, tries = won + p.counts.opening_deaths;
    return `<b>${tries ? Math.round((won / tries) * 100) : 0}%</b> won<br>${tries} attempt${tries === 1 ? "" : "s"}`;
  };
  const players = [...m.players].sort((a, b) => r3(b.derived) - r3(a.derived));
  const top = Math.max(1.5, ...players.map((p) => r3(p.derived) + 0.1));
  // The match's best highlight (rendered ones first) next to the rating chart, the rest below it.
  const names = new Map(m.players.map((p) => [p.steamid, p.name]));
  // The play of the match (anyone's): when it's one of yours, it's that highlight (one clip).
  const potm = m.potm ? (m.highlights || []).find((h) => h.id === m.potm.id) || m.potm : null;
  const hls = [...(m.highlights || [])].sort((a, b) => !!b.clip - !!a.clip || (b.tier || 0) - (a.tier || 0) || (b.hand || 0) - (a.hand || 0));
  const best = hls[0];
  const thumb = (h) => (h.thumb ? `background-image:url('${assetUrl(h.thumb)}')` : "");
  // Under the MVP: the play of the match, with who made it on the picture; hover previews, click plays.
  const potmHtml = (h) => `
      <section class="hs-potm">
        <div class="hs-potm-head"><span class="star">★</span><b>Play of the match</b><span class="grow"></span><span class="sub">round ${h.round}</span></div>
        <div class="hl-card hs-potm-card ${h.clip ? "" : "pending"}" data-hl="${esc(h.id)}" ${clipAttr(h)}>
          <div class="hl-thumb" style="--map-bg:${mapColor(m.map)};${thumb(h)}">
            ${h.clip ? `<span class="play">▶</span>` : `<span class="state">${h.render_error ? esc(h.render_error) : tauri ? `<button class="btn small" data-film-potm>Film it</button>` : "Not filmed yet"}</span>`}
            <span class="potm-who ${h.player === me ? "me" : ""}">${avatarHtml(h.player, 30)}<b>${esc(names.get(h.player) || "")}</b>${h.player === me ? `<em class="hs-you">You</em>` : ""}</span>
            <span class="dur">${fmtClip(h.duration_s)}</span>
            <span class="potm-title">${esc(h.title)}</span>
          </div>
        </div>
      </section>`;
  const hlCard = (h) => `
          <div class="hl-card hs-hl-card ${h.clip ? "" : "pending"}" data-hl="${esc(h.id)}" ${clipAttr(h)}>
            <div class="hl-thumb" style="--map-bg:${mapColor(m.map)};${thumb(h)}">
              ${h.clip ? `<span class="play">▶</span>` : `<span class="state">${h.render_error ? esc(h.render_error) : "Rendering…"}</span>`}
              <span class="dur">${fmtClip(h.duration_s)}</span></div>
            <div class="hs-hl-info"><div class="hl-title">${esc(h.title)}</div>
              <div class="hl-meta"><span>${esc(names.get(h.player) || "")}</span><span>round ${h.round}</span></div>
              <div class="tags">${h.tags.map((t) => tagHtml(t)).join("")}</div></div>
          </div>`;
  const hlPanel = best ? `
      <section class="hs-hl">
        <div class="hs-perf-head"><div class="h3">Highlights</div>${hls.length > 1 ? `<a class="link" href="${matchHref(id, "highlights")}">All ${hls.length}</a>` : ""}</div>
        <div class="hs-hl-row">${hls.slice(0, 4).map(hlCard).join("")}</div>
      </section>` : `
      <section class="hs-hl empty-hl"><div class="h3">Highlights</div><div class="empty small">No highlights this match.</div></section>`;
  const x = (v) => `${(v / top) * 100}%`;
  el.innerHTML = `
        <div class="hs-left">${mvp ? mvpHtml(mvp) : ""}${potm ? potmHtml(potm) : ""}</div>
        <div class="hs-leader-list">
          ${leader("Most kills", (p) => p.counts.kills)}
          ${leader("Most ADR", (p) => p.derived.adr, f1)}
          ${leader("Most opening kills", (p) => p.counts.opening_kills, (x) => x, openings)}
          ${leader("Best KAST", (p) => p.derived.kast, (v) => `${Math.round(v)}%`)}
        </div>
      <section class="hs-card">
        <div class="hs-teams"><b class="mine">My Team</b><span class="sub">Team stats</span><b class="enemy">Enemy Team</b></div>
        ${cmp("Rating 3.0", avg(teams.mine, (p) => r3(p.derived)), avg(teams.enemy, (p) => r3(p.derived)), f2, mine ? r3(mine.derived) : null)}
        ${cmp("ADR", avg(teams.mine, (p) => p.derived.adr), avg(teams.enemy, (p) => p.derived.adr), f1, mine ? mine.derived.adr : null)}
        ${cmp("First kills", total(teams.mine, (p) => p.counts.opening_kills), total(teams.enemy, (p) => p.counts.opening_kills))}
        ${cmp("Trade kills", total(teams.mine, (p) => p.counts.trade_kills), total(teams.enemy, (p) => p.counts.trade_kills))}
        ${cmp("Multi-kill rounds", total(teams.mine, multi), total(teams.enemy, multi))}
        ${cmp("Clutches won", total(teams.mine, (p) => sum(p.counts.clutches_won)), total(teams.enemy, (p) => sum(p.counts.clutches_won)))}
        ${cmp("Utility damage", total(teams.mine, (p) => p.counts.utility_damage), total(teams.enemy, (p) => p.counts.utility_damage))}
        ${cmp("Headshot kills", hsPct(teams.mine), hsPct(teams.enemy), pct0, myHs)}
      </section>
    <section class="hs-perf">
      <div class="hs-perf-head"><div class="h3">Performance · Rating 3.0</div>
        <span class="legend"><i class="mine"></i>My Team <i class="enemy"></i>Enemy Team</span></div>
      <div class="hs-chart">
        <div class="hs-bands"><i class="bad" style="width:${x(0.85)}"></i><i class="avg" style="left:${x(0.85)};width:${(0.3 / top) * 100}%"></i><i class="good" style="left:${x(1.15)};right:0"></i></div>
        ${players.map((p) => `<div class="hs-bar-row ${p.side} ${p.steamid === me ? "me" : ""}" title="${esc(p.name)}: ${f2(r3(p.derived))}"><span>${p.steamid === me ? `<em class="hs-you">You</em>` : ""}${esc(p.name)}</span>
          <div class="hs-track"><i style="width:${x(r3(p.derived))}"></i><b style="left:${x(r3(p.derived))}">${f2(r3(p.derived))}</b></div></div>`).join("")}
        <div class="hs-axis"><span></span><div>${[0, 0.4, 0.85, 1.15, top].map((v) => `<em style="left:${x(v)}">${f2(v)}</em>`).join("")}</div></div>
        <div class="hs-axis words"><span></span><div><em style="left:${x(0.42)}">Bad</em><em style="left:${x(1.0)}">Average</em><em style="left:${x((1.15 + top) / 2)}">Good</em></div></div>
      </div>
    </section>
    ${hlPanel}`;
  // Play from the match's rendered clips.
  state.playlist = [...(potm?.clip ? [potm] : []), ...hls.filter((h) => h.clip)].map((h) => ({ ...h, name: names.get(h.player), match: m }));
  el.querySelector("[data-film-potm]")?.addEventListener("click", async (e) => {
    e.stopPropagation();
    e.target.disabled = true;
    e.target.textContent = "Queued: it films when CS2 is closed";
    await tauri.core.invoke("render_clips", { items: [[m.id, potm.id]] });
  });
  el.querySelectorAll("[data-hl]").forEach((c) => (c.onclick = () => {
    const i = state.playlist.findIndex((h) => h.id === c.dataset.hl);
    if (i >= 0) play(i);
  }));
}

// ---- custom ratings, trends ----------------------------------------------------------------------

// Every stat a custom rating or a trend can use: key, label, group, format. Lower-is-better comes
// from the library benchmarks.
const pct1 = (v) => `${v.toFixed(1)}%`;
const n0 = (v) => `${Math.round(v)}`;
const STAT_CATALOG = [
  ["rating3", "HLTV Rating 3.0", "Overall", f2], ["rws", "RWS", "Overall", f1], ["swing", "Swing / round", "Overall", fmtSwing],
  ["adr", "ADR", "Overall", f1], ["kast", "KAST", "Overall", pct1], ["kd", "K/D", "Overall", f2], ["kpr", "Kills per round", "Overall", f2],
  ["dpr", "Deaths per round", "Overall", f2], ["hs_pct", "Headshot kills %", "Overall", pct0], ["entry_success", "Opening duel success", "Overall", pct0],
  ["entry_attempts", "Opening duel attempts", "Overall", pct0], ["trade_kills_pr", "Trade kills per round", "Overall", f2],
  ["traded_deaths_pct", "Deaths traded", "Overall", pct0], ["multikill_pr", "Multi-kill rounds per round", "Overall", f2],
  ["utility_damage_pr", "Utility damage per round", "Overall", f1], ["flash_assists_pr", "Flash assists per round", "Overall", f2], ["clutch_wins", "Clutches won", "Overall", n0],
  ["spotted_accuracy", "Spotted accuracy", "Aim", pct0], ["ttd_ms", "Time to damage", "Aim", ms0], ["ttk_ms", "Time to kill", "Aim", ms0],
  ["crosshair_deg", "Crosshair placement", "Aim", deg2], ["head_accuracy", "Head accuracy", "Aim", pct0], ["hs_kill_pct", "HS kill %", "Aim", pct0],
  ["first_bullet", "First bullet accuracy", "Aim", pct0], ["spray_accuracy", "Spray accuracy", "Aim", pct0], ["accuracy", "Accuracy (all)", "Aim", pct0],
  ["first_stop", "First bullet stopped (rifles, snipers)", "Movement", pct0], ["stop_ms", "Time to stop", "Movement", ms0],
  ["counter_strafe", "Counter-strafing (rifles)", "Movement", pct0], ["accurate_movement", "Shots while stopped (all guns)", "Movement", pct0],
  ["air_shot_pct", "Shots while jumping", "Movement", pct1], ["air_accuracy", "Accuracy while jumping", "Movement", pct0],
  ["nades_per_round", "Grenades per round", "Utility", f2], ["flash_assist_pct", "Flash assists per flash", "Utility", pct0],
  ["enemies_per_flash", "Enemies flashed per flash", "Utility", f2], ["friends_per_flash", "Friends flashed per flash", "Utility", f2],
  ["blind_time", "Average blind time", "Utility", (v) => `${v.toFixed(1)}s`], ["he_damage_avg", "Damage per HE", "Utility", f1],
  ["he_team_damage_avg", "Team damage per HE", "Utility", f1], ["unused_utility", "Unused utility at death", "Utility", (v) => `$${Math.round(v)}`],
  ["damage", "Total damage", "Activity", n0], ["he_damage", "HE damage", "Activity", n0], ["molotov_damage", "Molotov damage", "Activity", n0],
  ["enemies_flashed", "Enemies flashed", "Activity", n0], ["shots", "Shots fired", "Activity", n0], ["wasted_magazine", "Wasted magazine", "Activity", pct0],
  ["rounds_survived_pct", "Rounds survived", "Activity", pct0],
];
const statInfo = new Map(STAT_CATALOG.map(([k, label, group, fmt]) => [k, { label, group, fmt }]));
const STAT_GROUPS = ["Overall", "Aim", "Movement", "Utility", "Activity"];

// Ratings you build yourself: weighted stats, each against every player in your library.
const DEFAULT_RATINGS = [
  { id: "aim", name: "Aim", leetify: true, parts: { spotted_accuracy: 1, ttd_ms: 1, crosshair_deg: 1, head_accuracy: 1, spray_accuracy: 1, counter_strafe: 1 } },
  { id: "movement", name: "Movement", parts: { first_stop: 35, counter_strafe: 30, stop_ms: 20, air_shot_pct: 15 } },
  { id: "utility", name: "Utility", parts: { nades_per_round: 20, flash_assist_pct: 15, enemies_per_flash: 15, he_damage_avg: 15, blind_time: 10, friends_per_flash: 10, unused_utility: 10, he_team_damage_avg: 5 } },
  { id: "impact", name: "Impact", parts: { swing: 30, adr: 20, entry_success: 15, multikill_pr: 15, kast: 10, clutch_wins: 10 } },
];
let customRatings = DEFAULT_RATINGS;
try { customRatings = JSON.parse(localStorage.getItem("veloxify.ratings") || "null") || DEFAULT_RATINGS; } catch (e) { /* defaults */ }
// Movement used to count every gun's shots (SMGs and pistols are run-and-gun): an unedited one
// moves to the stop stats.
customRatings = customRatings.map((r) => (r.id === "movement" && JSON.stringify(r.parts) === JSON.stringify({ counter_strafe: 40, accurate_movement: 30, air_shot_pct: 20, air_accuracy: 10 }) ? DEFAULT_RATINGS[1] : r));
// The old Aim rating (unedited) becomes Leetify's.
customRatings = customRatings.map((r) => (r.id === "aim" && JSON.stringify(r.parts) === JSON.stringify({ spotted_accuracy: 15, ttd_ms: 15, crosshair_deg: 15, head_accuracy: 10, first_bullet: 10, spray_accuracy: 10, ttk_ms: 10, counter_strafe: 10, hs_kill_pct: 5 }) ? DEFAULT_RATINGS[0] : r));
const saveRatings = () => { try { localStorage.setItem("veloxify.ratings", JSON.stringify(customRatings)); } catch (e) { /* not saved */ } };

// A custom rating for one set of stats: the weighted average standard score, as 0-100 (50 = the
// average player in your library). Needs at least half the weight to have data.
function customRating(r, stats) {
  if (r.leetify) return leetifyAim(stats);
  let sum = 0, w = 0, total = 0;
  for (const [k, weight] of Object.entries(r.parts)) {
    if (!(weight > 0)) continue;
    total += weight;
    const z = zOf(k, stats[k]);
    if (z == null) continue;
    sum += z * weight;
    w += weight;
  }
  return w > 0 && w >= total / 2 ? Math.round(phi(sum / w) * 100) : null;
}

async function loadMyStats() {
  if (state.myStats === undefined) {
    try {
      const r = await fetch(assetUrl("my_stats.json"), { cache: "no-store" });
      state.myStats = r.ok ? await r.json() : [];
    } catch (e) { state.myStats = []; }
    state.myStatsById = new Map(state.myStats.map((x) => [x.id, x.stats || {}]));
  }
  return state.myStats;
}

// A metric's value for one of your matches: a stat, or "rating:<id>" for a custom rating.
function metricValue(metric, stats) {
  if (metric.startsWith("rating:")) {
    const r = customRatings.find((x) => x.id === metric.slice(7));
    return r ? customRating(r, stats) : null;
  }
  return stats[metric] ?? null;
}
const metricLabel = (metric) => (metric.startsWith("rating:") ? `${customRatings.find((x) => x.id === metric.slice(7))?.name || "Rating"} rating` : statInfo.get(metric)?.label || metric);
const metricFmt = (metric) => (metric.startsWith("rating:") ? n0 : statInfo.get(metric)?.fmt || f2);
// Where a trend's "average" line sits: 1.00 for HLTV ratings, 50 for custom ratings, else the library mean.
const metricBaseline = (metric) => (metric === "rating3" ? 1 : metric.startsWith("rating:") ? 50 : state.benchmarks?.[metric]?.mean ?? null);

// ---- periods and buckets -------------------------------------------------------------------------

const TREND_DEFAULTS = { metric: "rating3", period: "year", from: "", to: "" };
let trend = { ...TREND_DEFAULTS };
try { trend = { ...TREND_DEFAULTS, ...JSON.parse(localStorage.getItem("veloxify.trends") || "{}") }; } catch (e) { /* defaults */ }
const saveTrend = () => { try { localStorage.setItem("veloxify.trends", JSON.stringify(trend)); } catch (e) { /* not saved */ } };
const PERIODS = [["week", "Week"], ["month", "Month"], ["3m", "3 months"], ["year", "12 months"], ["all", "All time"], ["custom", "Dates"]];

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const startOfWeek = (d) => { const x = startOfDay(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
const startOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), 1);

// The buckets a period is shown in: days for a week or month, weeks for 3 months, months beyond.
function periodBuckets(period, firstTs) {
  const now = new Date();
  let from, to = now, unit;
  if (period === "week") { from = new Date(now - 6 * 864e5); unit = "day"; }
  else if (period === "month") { from = new Date(now - 29 * 864e5); unit = "day"; }
  else if (period === "3m") { from = new Date(now.getFullYear(), now.getMonth() - 3, now.getDate()); unit = "week"; }
  else if (period === "year") { from = new Date(now.getFullYear(), now.getMonth() - 11, 1); unit = "month"; }
  else if (period === "custom" && trend.from && trend.to) {
    const day = (iso) => { const [y, mo, d] = iso.split("-").map(Number); return new Date(y, mo - 1, d); }; // local midnight
    from = day(trend.from); to = new Date(day(trend.to).getTime() + 864e5 - 1);
    const days = (to - from) / 864e5;
    unit = days <= 31 ? "day" : days <= 180 ? "week" : "month";
  } else { from = firstTs ? new Date(firstTs * 1000) : new Date(now.getFullYear(), now.getMonth() - 11, 1); unit = "month"; }
  const start = unit === "day" ? startOfDay(from) : unit === "week" ? startOfWeek(from) : startOfMonth(from);
  const out = [];
  for (let d = start; d <= to && out.length < 400; ) {
    const next = unit === "day" ? new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)
      : unit === "week" ? new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7) : new Date(d.getFullYear(), d.getMonth() + 1, 1);
    const label = unit === "month" ? `${MONTHS[d.getMonth()]}${d.getMonth() === 0 || !out.length ? ` ${String(d.getFullYear()).slice(2)}` : ""}`
      : `${d.getDate()} ${MONTHS[d.getMonth()]}`;
    out.push({ from: d.getTime() / 1000, to: next.getTime() / 1000, label, long: unit === "month" ? `${MONTHS[d.getMonth()]} ${d.getFullYear()}` : unit === "week" ? `Week of ${d.getDate()} ${MONTHS[d.getMonth()]}` : fmtDate(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`) });
    d = next;
  }
  return { buckets: out, unit };
}

// Your matches (by the profile's source filter) averaged per bucket, weighted by rounds.
function trendPoints(metric, buckets, myStats) {
  const src = prof.source;
  return buckets.map((b) => {
    const ms = myStats.filter((m) => m.ts >= b.from && m.ts < b.to && (src === "all" || m.source === src));
    let s = 0, w = 0;
    for (const m of ms) {
      const v = metricValue(metric, m.stats);
      if (v == null) continue;
      s += v * (m.rounds || 1);
      w += m.rounds || 1;
    }
    return { ...b, n: ms.length, value: w ? s / w : null, wins: ms.filter((m) => m.result === "win").length };
  });
}

// One series over time: 2px line, ringed markers, a dashed "average" reference, recessive grid,
// labels only on the latest, best and worst points, native tooltips on every point.
function lineChart(points, { fmt, baseline, lowerBetter = false, height = 230, tip = null }) {
  tip = tip || ((p) => `${p.long}: ${fmt(p.value)} · ${p.n} match${p.n === 1 ? "" : "es"} (${p.wins}-${p.n - p.wins})`);
  const pts = points.map((p, i) => ({ ...p, i })).filter((p) => p.value != null);
  if (!pts.length) return `<div class="empty small">No matches in this period.</div>`;
  const W = 1000, H = height, L = 46, R = 16, T = 18, B = 34;
  const vals = pts.map((p) => p.value).concat(baseline != null ? [baseline] : []);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = (hi - lo || Math.abs(hi) * 0.1 || 1) * 0.15;
  lo -= pad; hi += pad;
  const n = points.length;
  const x = (i) => L + (n === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (n - 1));
  const y = (v) => T + ((hi - v) * (H - T - B)) / (hi - lo);
  const ticks = Array.from({ length: 4 }, (_, k) => lo + ((k + 0.5) * (hi - lo)) / 4);
  const grid = ticks.map((t) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text class="axis" x="${L - 8}" y="${y(t) + 4}" text-anchor="end">${fmt(t)}</text>`).join("");
  const ref = baseline != null ? `<line class="ref" x1="${L}" x2="${W - R}" y1="${y(baseline)}" y2="${y(baseline)}"/>` : "";
  // Line segments only between neighbouring buckets that both have data.
  let path = "";
  pts.forEach((p, k) => { path += `${k && pts[k - 1].i === p.i - 1 ? "L" : "M"}${x(p.i).toFixed(1)},${y(p.value).toFixed(1)} `; });
  const best = pts.reduce((a, b) => ((lowerBetter ? b.value < a.value : b.value > a.value) ? b : a));
  const worst = pts.reduce((a, b) => ((lowerBetter ? b.value > a.value : b.value < a.value) ? b : a));
  const last = pts[pts.length - 1];
  const labelled = new Set([last, best, worst]);
  const every = Math.max(1, Math.ceil(n / 12));
  const xl = points.map((p, i) => (i % every === 0 || i === n - 1 ? `<text class="axis" x="${x(i)}" y="${H - 10}" text-anchor="middle">${esc(p.label)}</text>` : "")).join("");
  const dots = pts.map((p) => `<g class="pt-g"><title>${esc(tip(p))}</title>
    <rect class="hit" x="${x(p.i) - 14}" y="${T}" width="28" height="${H - T - B}"/>
    <circle class="pt" cx="${x(p.i)}" cy="${y(p.value)}" r="5"/>
    ${labelled.has(p) ? `<text class="val" x="${x(p.i)}" y="${y(p.value) - 11}" text-anchor="middle">${fmt(p.value)}</text>` : ""}</g>`).join("");
  return `<svg class="trend-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Trend">${grid}${ref}<path class="line" d="${path}"/>${dots}${xl}</svg>`;
}

// Bars above/below zero (ELO change per bucket), green up, red down, labelled with the change.
function changeBars(points, { height = 120 }) {
  const pts = points.map((p, i) => ({ ...p, i }));
  if (!pts.some((p) => p.value != null)) return "";
  const W = 1000, H = height, L = 46, R = 16, T = 14, B = 24;
  const m = Math.max(10, ...pts.map((p) => Math.abs(p.value || 0)));
  const n = pts.length, slot = (W - L - R) / n, bw = Math.min(46, slot * 0.6);
  const zero = T + (H - T - B) / 2, scale = (H - T - B) / 2 / m;
  const bars = pts.filter((p) => p.value != null && p.value !== 0).map((p) => {
    const cx = L + slot * (p.i + 0.5), h = Math.abs(p.value) * scale, up = p.value > 0;
    const yTop = up ? zero - h : zero;
    return `<g><title>${esc(p.long)}: ${p.value > 0 ? "+" : ""}${p.value} ELO</title>
      <rect x="${cx - bw / 2}" y="${yTop}" width="${bw}" height="${Math.max(1, h)}" rx="3" fill="${up ? WIN : LOSS}"/>
      ${n <= 30 ? `<text class="val" x="${cx}" y="${up ? yTop - 4 : yTop + h + 12}" text-anchor="middle">${p.value > 0 ? "+" : ""}${p.value}</text>` : ""}</g>`;
  }).join("");
  return `<svg class="trend-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="ELO change"><line class="grid" x1="${L}" x2="${W - R}" y1="${zero}" y2="${zero}"/>${bars}</svg>`;
}

// FACEIT ELO after every match in the period, oldest first (one dot per match).
function eloMatches(from, to) {
  return (state.faceit?.matches || [])
    .filter((m) => m.elo && (m.finished_ts || m.started_ts) >= from && (m.finished_ts || m.started_ts) < to)
    .sort((a, b) => (a.finished_ts || a.started_ts) - (b.finished_ts || b.started_ts))
    .map((m) => {
      const d = new Date((m.started_ts || m.finished_ts) * 1000);
      const day = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
      const res = m.result === "win" ? "W" : m.result === "loss" ? "L" : "T";
      return { label: day, long: `${mapName(m.map)} · ${day} ${fmtTime(d.toISOString())} · ${res} ${m.score_mine}-${m.score_theirs}`, value: m.elo, change: m.elo_delta ?? null, n: 1, wins: res === "W" ? 1 : 0 };
    });
}

function metricOptions(selected) {
  const custom = customRatings.map((r) => `<option value="rating:${esc(r.id)}" ${selected === `rating:${r.id}` ? "selected" : ""}>${esc(r.name)} rating</option>`).join("");
  return `<optgroup label="Your ratings">${custom}</optgroup>${STAT_GROUPS.map((g) => `<optgroup label="${g}">${STAT_CATALOG.filter((s) => s[2] === g)
    .map(([k, label]) => `<option value="${k}" ${selected === k ? "selected" : ""}>${esc(label)}</option>`).join("")}</optgroup>`).join("")}`;
}

// The profile's Progress section: any metric over a chosen period, and FACEIT ELO by period.
async function renderTrends(el) {
  const [my] = await Promise.all([loadMyStats(), loadBenchmarks()]);
  const { buckets, unit } = periodBuckets(trend.period, my[0]?.ts);
  const pts = trendPoints(trend.metric, buckets, my);
  const fmt = metricFmt(trend.metric);
  const lowerBetter = !!state.benchmarks?.[trend.metric]?.lower_is_better;
  const withData = pts.filter((p) => p.value != null);
  const per = { day: "day", week: "week", month: "month" }[unit];
  const change = withData.length >= 2 ? withData[withData.length - 1].value - withData[0].value : null;
  const elo = buckets.length ? eloMatches(buckets[0].from, buckets[buckets.length - 1].to) : [];
  const hasElo = elo.length > 0;
  el.innerHTML = `
    <section class="panel trends">
      <div class="panel-head"><div><div class="h3">Progress</div><div class="sub">${esc(metricLabel(trend.metric))} per ${per}${prof.source !== "all" ? ` · ${prof.source === "faceit" ? "FACEIT" : "Premier"} only` : ""}</div></div><span class="grow"></span>
        <select id="trend-metric">${metricOptions(trend.metric)}</select>
        <div class="seg">${PERIODS.map(([k, l]) => `<button data-period="${k}" class="${trend.period === k ? "on" : ""}">${l}</button>`).join("")}</div>
        ${trend.period === "custom" ? `<span class="dates"><input type="date" id="trend-from" value="${trend.from}"> – <input type="date" id="trend-to" value="${trend.to}"></span>` : ""}
      </div>
      <div class="trend-body">${lineChart(pts, { fmt, baseline: metricBaseline(trend.metric), lowerBetter })}</div>
      <div class="trend-strip">${withData.map((p) => `<div class="trend-cell" title="${p.n} match${p.n === 1 ? "" : "es"} (${p.wins}-${p.n - p.wins})"><span>${esc(p.long)}</span><b>${fmt(p.value)}</b><em>${p.n} match${p.n === 1 ? "" : "es"}</em></div>`).join("")}</div>
      ${change != null ? `<div class="note">From ${esc(withData[0].long)} to ${esc(withData[withData.length - 1].long)}: <b class="${(lowerBetter ? change < 0 : change > 0) ? "up" : change === 0 ? "" : "down"}">${change > 0 ? "+" : ""}${fmt(change)}</b>. Each ${per} averages its matches, weighted by rounds. Dashed line: ${trend.metric === "rating3" ? "1.00 (average)" : trend.metric.startsWith("rating:") ? "50 (the average player in your library)" : "the average player in your library"}.</div>` : ""}
    </section>
    ${hasElo ? `<section class="panel trends">
      <div class="panel-head"><div><div class="h3">FACEIT ELO</div><div class="sub">Every match in this period: ${elo.length} game${elo.length === 1 ? "" : "s"}, ${(() => { const net = elo.reduce((a, p) => a + (p.change || 0), 0); return `${net > 0 ? "+" : ""}${net} ELO`; })()}</div></div></div>
      <div class="trend-body">${lineChart(elo, { fmt: n0, baseline: null, tip: (p) => `${p.long} · ${p.value.toLocaleString("en-US")} ELO${p.change != null ? ` (${p.change > 0 ? "+" : ""}${p.change})` : ""}` })}</div>
      <div class="trend-body">${changeBars(elo.map((p) => ({ ...p, value: p.change })), {})}</div>
    </section>` : ""}`;
  el.querySelector("#trend-metric").onchange = (e) => { trend.metric = e.target.value; saveTrend(); renderTrends(el); };
  el.querySelectorAll("[data-period]").forEach((b) => (b.onclick = () => {
    trend.period = b.dataset.period;
    if (trend.period === "custom" && !trend.from) {
      const d = new Date(), f = new Date(d.getFullYear(), d.getMonth() - 1, d.getDate());
      const iso = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
      trend.from = iso(f); trend.to = iso(d);
    }
    saveTrend(); renderTrends(el);
  }));
  for (const id of ["trend-from", "trend-to"]) {
    const inp = el.querySelector(`#${id}`);
    if (inp) inp.onchange = () => { trend[id === "trend-from" ? "from" : "to"] = inp.value; saveTrend(); renderTrends(el); };
  }
}

// Your custom ratings over the profile's selection (last N matches, source).
async function renderMyRatings(el) {
  const [my] = await Promise.all([loadMyStats(), loadBenchmarks()]);
  const list = my.filter((m) => prof.source === "all" || m.source === prof.source);
  const sel = prof.last ? list.slice(-prof.last) : list;
  const avg = (r) => {
    // Leetify's Aim over a period: the period's average stats, judged as a whole.
    if (r.leetify) return leetifyAim(meanStats(sel), sel.length > 1);
    const v = sel.map((m) => customRating(r, m.stats)).filter((x) => x != null);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  el.innerHTML = `<section class="panel my-ratings"><div class="panel-head"><div class="h3">Your ratings</div><span class="sub">50 = the average player in your library</span><span class="grow"></span><a class="btn ghost" href="#/ratings">Edit ratings</a></div>
    <div class="my-ratings-row">${customRatings.map((r) => {
      const v = avg(r);
      const band = v == null ? "" : bandOf(v / 100);
      return `<a class="my-rating" href="#/ratings/${esc(r.id)}">${dial(v == null ? "–" : Math.round(v), (v || 0) / 100, r.name, v == null ? "No data" : BAND_WORDS[band] || "", 110, v == null ? "" : GRADE_COLORS[Number(band.slice(1))])}</a>`;
    }).join("")}</div></section>`;
}

// ---- rating builder --------------------------------------------------------------------------------

let editingRating = null;
async function renderRatingBuilder(view, id) {
  const [my] = await Promise.all([loadMyStats(), loadBenchmarks()]);
  const recent = my.slice(-30);
  let r = customRatings.find((x) => x.id === (id || editingRating)) || customRatings[0];
  editingRating = r?.id;
  const yourValue = (rr) => {
    const v = recent.map((m) => customRating(rr, m.stats)).filter((x) => x != null);
    return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
  };
  // How each stat pulls your rating: your average standard score over the last 30 matches.
  const yourZ = (k) => {
    const zs = recent.map((m) => zOf(k, m.stats[k])).filter((z) => z != null);
    return zs.length ? zs.reduce((a, b) => a + b, 0) / zs.length : null;
  };
  const yourAvg = (k) => {
    const vs = recent.map((m) => m.stats[k]).filter((v) => v != null);
    return vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : null;
  };
  const total = r ? Object.values(r.parts).reduce((a, b) => a + (b > 0 ? b : 0), 0) : 0;
  const used = new Set(r ? Object.keys(r.parts) : []);
  view.innerHTML = `
    <div class="profile-head"><div><div class="h2">Profile</div><div class="h1">Custom ratings</div></div><a class="btn ghost" href="#/profile">◀ Back to profile</a></div>
    <div class="rb-grid">
      <section class="panel rb-list">
        <div class="panel-head"><div class="h3">Your ratings</div></div>
        ${customRatings.map((x) => `<button class="rb-item ${x.id === r?.id ? "on" : ""}" data-pick="${esc(x.id)}"><span>${esc(x.name)}</span><b>${yourValue(x) ?? "–"}</b></button>`).join("")}
        <div class="rb-actions"><button class="btn" id="rb-new">+ New rating</button><button class="btn ghost" id="rb-reset" title="Put back Aim, Movement, Utility and Impact as they came">Reset to defaults</button></div>
        <div class="note">A rating weighs stats you pick. Each stat is compared with every player-match in your library (lower is better where that makes sense, like time to damage), then the weighted average becomes a 0–100 score: 50 is the average player, about 84 is one standard deviation better.</div>
      </section>
      ${r ? `<section class="panel rb-edit">
        <div class="panel-head"><input class="rb-name" id="rb-name" value="${esc(r.name)}" maxlength="32" aria-label="Rating name"><span class="grow"></span>
          <div class="rb-you"><span class="sub">You, last ${recent.length} matches</span><b>${yourValue(r) ?? "–"}</b></div>
          <button class="btn ghost" id="rb-delete">Delete</button></div>
        <table class="rb-table"><thead><tr><th>Stat</th><th>Weight</th><th>Share</th><th>You (avg)</th><th title="How this stat pulls your rating: your average against the library">Pull</th><th></th></tr></thead><tbody>
        ${Object.entries(r.parts).map(([k, w]) => {
          const info = statInfo.get(k) || { label: k, group: "", fmt: f2 };
          const z = yourZ(k), a = yourAvg(k);
          const lower = state.benchmarks?.[k]?.lower_is_better;
          return `<tr><td><b>${esc(info.label)}</b><span class="sub"> ${esc(info.group)}${lower ? " · lower is better" : ""}</span></td>
            <td class="rb-w"><input type="range" min="0" max="100" step="1" value="${w}" data-w="${k}"><input type="number" min="0" max="100" value="${w}" data-wn="${k}"></td>
            <td>${total ? Math.round((Math.max(0, w) / total) * 100) : 0}%</td>
            <td>${a == null ? "–" : info.fmt(a)}</td>
            <td>${z == null ? "–" : `<span class="pull"><i class="${z >= 0 ? "pos" : "neg"}" style="width:${Math.min(50, Math.abs(z) * 25)}%;${z >= 0 ? "left:50%" : `right:50%`}"></i></span>`}</td>
            <td><button class="icon-btn" data-remove="${k}" title="Remove">✕</button></td></tr>`;
        }).join("")}
        </tbody></table>
        <div class="rb-add"><select id="rb-add"><option value="">+ Add a stat…</option>${STAT_GROUPS.map((g) => `<optgroup label="${g}">${STAT_CATALOG.filter((s) => s[2] === g && !used.has(s[0])).map(([k, label]) => `<option value="${k}">${esc(label)}</option>`).join("")}</optgroup>`).join("")}</select></div>
      </section>` : `<section class="panel rb-edit"><div class="empty">No ratings. Make one with + New rating.</div></section>`}
    </div>`;
  // Edited: no longer Leetify's formula (it takes your weights and the library's averages).
  const rerender = () => { if (r?.leetify) delete r.leetify; saveRatings(); renderRatingBuilder(view, editingRating); };
  view.querySelectorAll("[data-pick]").forEach((b) => (b.onclick = () => { editingRating = b.dataset.pick; location.hash = `#/ratings/${encodeURIComponent(editingRating)}`; }));
  view.querySelector("#rb-new").onclick = () => {
    const nid = `r${Date.now().toString(36)}`;
    customRatings = [...customRatings, { id: nid, name: "New rating", parts: {} }];
    editingRating = nid;
    saveRatings();
    location.hash = `#/ratings/${nid}`;
  };
  view.querySelector("#rb-reset").onclick = () => {
    if (!confirm("Put back the default ratings (Aim, Movement, Utility, Impact)? Ratings you made are removed.")) return;
    customRatings = JSON.parse(JSON.stringify(DEFAULT_RATINGS));
    editingRating = customRatings[0].id;
    rerender();
  };
  if (!r) return;
  view.querySelector("#rb-name").onchange = (e) => { r.name = e.target.value.trim() || r.name; rerender(); };
  view.querySelector("#rb-delete").onclick = () => {
    if (!confirm(`Delete the "${r.name}" rating?`)) return;
    customRatings = customRatings.filter((x) => x !== r);
    editingRating = customRatings[0]?.id || null;
    rerender();
  };
  // Sliders update their number live; the table re-renders when you let go.
  view.querySelectorAll("[data-w]").forEach((inp) => {
    inp.oninput = () => { view.querySelector(`[data-wn="${inp.dataset.w}"]`).value = inp.value; };
    inp.onchange = () => { r.parts[inp.dataset.w] = Number(inp.value); rerender(); };
  });
  view.querySelectorAll("[data-wn]").forEach((inp) => (inp.onchange = () => { r.parts[inp.dataset.wn] = Math.max(0, Math.min(100, Number(inp.value) || 0)); rerender(); }));
  view.querySelectorAll("[data-remove]").forEach((b) => (b.onclick = () => { delete r.parts[b.dataset.remove]; rerender(); }));
  view.querySelector("#rb-add").onchange = (e) => { if (e.target.value) { r.parts[e.target.value] = 20; rerender(); } };
}

// Match page: everyone's custom ratings in this match.
async function renderRatingsTab(body, m, id) {
  const [d] = await Promise.all([loadDetails(id), loadBenchmarks()]);
  if (!d) return noDetails(body);
  const rows = detailRows(m, d).map((r) => ({ ...r, s: { ...r.s, ...coreStatsOf(r.p) } }));
  const cols = customRatings.map((cr) => ({
    key: `rating:${cr.id}`, label: esc(cr.name), tip: `Your "${cr.name}" rating: ${Object.entries(cr.parts).map(([k, w]) => `${statInfo.get(k)?.label || k} ${w}`).join(", ")}`,
    value: (r) => customRating(cr, r.s), cell: (r) => `<td>${ratingChip(customRating(cr, r.s))}</td>`,
  }));
  if (!detailSorts.ratings || !cols.some((c) => c.key === detailSorts.ratings.key)) detailSorts.ratings = { key: cols[0]?.key, desc: true };
  const draw = () => {
    teamTables(body, m, rows, cols, detailSorts.ratings, draw);
    const note = document.createElement("div");
    note.className = "note";
    note.innerHTML = `Your own ratings, built in <a class="link" href="#/ratings">Custom ratings</a>. 50 = the average player in your library.`;
    body.appendChild(note);
  };
  if (!cols.length) { body.innerHTML = `<div class="empty">No custom ratings yet. <a class="link" href="#/ratings">Make one</a>.</div>`; return; }
  draw();
}

// The same core stats the library benchmarks use, from a scoreboard row.
function coreStatsOf(p) {
  const c = p.counts, d = p.derived, rounds = Math.max(1, c.rounds), openings = c.opening_kills + c.opening_deaths;
  const s = { rating3: r3(d), rws: d.rws, swing: d.swing || 0, adr: d.adr, kast: d.kast, kd: d.kd, kpr: d.kpr, dpr: d.dpr, hs_pct: d.hs_pct,
    entry_attempts: (openings * 100) / rounds, trade_kills_pr: c.trade_kills / rounds, multikill_pr: sum(c.multikill_rounds.slice(2)) / rounds,
    utility_damage_pr: c.utility_damage / rounds, flash_assists_pr: c.flash_assists / rounds, clutch_wins: sum(c.clutches_won) };
  if (openings) s.entry_success = (c.opening_kills * 100) / openings;
  if (c.deaths) s.traded_deaths_pct = (c.traded_deaths * 100) / c.deaths;
  return s;
}

// ---- match page: timeline events (FACEIT-style) ------------------------------------------------

// CS2's own radar for a map and where game coordinates land on it (extracted by the app).
async function loadRadar(map) {
  state.radars = state.radars || new Map();
  if (!state.radars.has(map)) {
    let meta = null;
    try {
      const r = await fetch(assetUrl(`radars/${map}.json`), { cache: "no-store" });
      if (r.ok) meta = await r.json();
    } catch (e) { /* no radar */ }
    state.radars.set(map, meta);
  }
  return state.radars.get(map);
}

const TEAM_COLOR = { mine: "var(--accent)", enemy: "#f0a030" };
const ROUND_ICONS = {
  kill: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2C7 2 3.5 5.6 3.5 10.2c0 2.6 1.2 4.6 3 5.9V19c0 .6.4 1 1 1h1.5v-2h2v2h2v-2h2v2H16.5c.6 0 1-.4 1-1v-2.9c1.8-1.3 3-3.3 3-5.9C20.5 5.6 17 2 12 2zm-3.2 11.3a2 2 0 110-4 2 2 0 010 4zm6.4 0a2 2 0 110-4 2 2 0 010 4z"/></svg>',
  defuse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 20l7-7M9 4l3 3-2 2 3 3 2-2 3 3"/><path d="M14 10l6-6"/></svg>',
  bomb: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M11 6a7 7 0 107 7 7 7 0 00-7-7zm7.6-2.6l-1.9 1.9 1.4 1.4 1.9-1.9zM14 3h2v2h-2z"/></svg>',
  time: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2M9 2h6"/></svg>',
};
// How a round ended, from CS2's round-end reason.
function roundEnd(r) {
  const why = (r.reason || "").toLowerCase();
  if (why.includes("defused") || r.defused) return ["defuse", "Bomb defused"];
  if (why.includes("bomb") || why.includes("target_bombed") || r.exploded) return ["bomb", "Bomb exploded"];
  if (why.includes("saved") || why.includes("time")) return ["time", "Time ran out"];
  return ["kill", "All enemies eliminated"];
}
const mmss = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}s`;

const timeline = { round: 1, tab: "kills", event: null, hidden: new Set(), zoom: 1, pan: [0, 0] };

async function renderTimelineTab(body, m, id) {
  const [d, radar] = await Promise.all([loadDetails(id), loadRadar(m.map)]);
  if (!d) return noDetails(body);
  if (timeline.matchId !== id) Object.assign(timeline, { matchId: id, round: 1, event: null, hidden: new Set(), zoom: 1, pan: [0, 0] });
  const names = new Map(m.players.map((p) => [p.steamid, p.name]));
  const team = new Map(m.players.map((p) => [p.steamid, p.side]));
  const rounds = d.rounds;
  const round = rounds.find((r) => r.number === timeline.round) || rounds[0];
  const nr = round.number;

  const strip = roundStripHtml(rounds, nr);

  // Teams with each player's round.
  const rp = new Map((round.players || []).map((p) => [p.steamid, p]));
  const sideOf = (side) => (side === "mine" ? round.mine_side : round.mine_side === "T" ? "CT" : "T");
  const teamPanel = (side) => {
    const won = round.winner === side;
    const score = side === "mine" ? m.score_mine : m.score_theirs;
    const players = m.players.filter((p) => p.side === side).sort((a, b) => (rp.get(b.steamid)?.swing || 0) - (rp.get(a.steamid)?.swing || 0));
    return `<section class="tl-team ${side}">
      <div class="tl-team-head"><span class="mp-badge ${won ? "win" : "loss"}">${won ? "W" : "L"}</span><b>${side === "mine" ? "My Team" : "Enemy Team"}</b>
        <span class="tl-side ${sideOf(side) === "T" ? "t" : "ct"}">${sideOf(side)}</span><span class="grow"></span><em>${String(score).padStart(2, "0")}</em></div>
      <table><thead><tr><th></th><th class="left">Players</th><th>Swing</th><th>DMG</th><th>K/D/A</th></tr></thead><tbody>
      ${players.map((p) => {
        const s = rp.get(p.steamid);
        const sw = s ? s.swing : null;
        return `<tr class="${p.steamid === state.index.me ? "me" : ""}"><td><input type="checkbox" data-player="${p.steamid}" ${timeline.hidden.has(p.steamid) ? "" : "checked"} aria-label="Show ${esc(p.name)} on the map"></td>
          <td class="left tl-pname">${avatarHtml(p.steamid, 22)}<span>${esc(p.name)}</span></td>
          <td class="${sw == null ? "" : sw > 0.05 ? "up" : sw < -0.05 ? "down" : ""}">${sw == null ? "–" : `${sw > 0 ? "+" : ""}${sw.toFixed(2)}%`}</td>
          <td>${s ? s.damage : "–"}</td><td>${s ? `${s.kills}/${s.deaths}/${s.assists}` : "–"}</td></tr>`;
      }).join("")}</tbody></table></section>`;
  };

  // Events this round (players unticked are left out).
  const visible = (sid) => !timeline.hidden.has(sid);
  const kills = d.kills.filter((k) => k.round === nr && !k.team_kill && (visible(k.attacker) || visible(k.victim)));
  const nades = (d.grenades || []).filter((g) => g.round === nr && visible(g.player)).sort((a, b) => a.t - b.t);
  const events = timeline.tab === "kills" ? kills : nades;
  const sel = timeline.event != null && timeline.event < events.length ? timeline.event : null;

  // Map overlay in radar pixels.
  const size = radar?.size || 1024;
  const at = (xy) => (radar && xy ? [(xy[0] - radar.pos_x) / radar.scale, (radar.pos_y - xy[1]) / radar.scale] : null);
  const label = (x, y, text, color, dx) => {
    const w = Math.max(40, text.length * 8.2 + 16), lx = dx > 0 ? x + 14 : x - 14 - w;
    return `<g class="tl-label"><rect x="${lx}" y="${y - 13}" width="${w}" height="26" rx="5"/><text x="${lx + w / 2}" y="${y + 5}" text-anchor="middle" fill="${color}">${esc(text)}</text></g>`;
  };
  let overlay = "";
  if (timeline.tab === "kills") {
    kills.forEach((k, i) => {
      if (sel != null && sel !== i) return;
      const a = at(k.attacker_xy), v = at(k.victim_xy);
      const ac = TEAM_COLOR[team.get(k.attacker)] || "#ccc", vc = TEAM_COLOR[team.get(k.victim)] || "#ccc";
      if (a && v) overlay += `<line class="tl-shot" x1="${a[0]}" y1="${a[1]}" x2="${v[0]}" y2="${v[1]}"/>`;
      if (a) overlay += `<circle class="tl-killer" cx="${a[0]}" cy="${a[1]}" r="9" fill="${ac}"/>`;
      if (v) overlay += `<g class="tl-victim" stroke="${vc}"><path d="M${v[0] - 7},${v[1] - 7}L${v[0] + 7},${v[1] + 7}M${v[0] + 7},${v[1] - 7}L${v[0] - 7},${v[1] + 7}"/></g>`;
      if (sel === i) {
        const dir = a && v ? Math.sign(a[0] - v[0]) || 1 : 1;
        if (a) overlay += label(a[0], a[1], names.get(k.attacker) || "", ac, dir);
        if (v) overlay += label(v[0], v[1], names.get(k.victim) || "", vc, -dir);
      }
    });
  } else {
    const R = { smoke: 144, molotov: 120, flash: 28, he: 60 };
    nades.forEach((g, i) => {
      if (sel != null && sel !== i) return;
      const p = at(g.xy);
      if (!p) return;
      const r = R[g.kind] / (radar?.scale || 5);
      overlay += `<circle class="tl-nade ${g.kind}" cx="${p[0]}" cy="${p[1]}" r="${r}"/>`;
      if (sel === i) overlay += label(p[0], p[1], names.get(g.player) || "", TEAM_COLOR[team.get(g.player)] || "#ccc", 1);
    });
  }
  const NADE = { smoke: ["smokegrenade", "Smoke"], molotov: ["molotov", "Molotov"], flash: ["flashbang", "Flashbang"], he: ["hegrenade", "HE grenade"] };
  const who = (sid) => `<b style="color:${TEAM_COLOR[team.get(sid)] || "var(--text)"}">${esc(names.get(sid) || "World")}</b>`;
  const list = timeline.tab === "kills"
    ? kills.map((k, i) => `<button class="tl-ev ${sel === i ? "on" : ""}" data-ev="${i}"><div>${who(k.attacker)}${weaponIcon(k.weapon)}${k.headshot ? `<span class="hs" title="Headshot">◎</span>` : ""}${who(k.victim)}</div><span>${mmss(k.t)}</span></button>`).join("")
    : nades.map((g, i) => `<button class="tl-ev ${sel === i ? "on" : ""}" data-ev="${i}"><div>${who(g.player)}${weaponIcon(NADE[g.kind][0])}<span class="sub">${NADE[g.kind][1]}</span></div><span>${mmss(g.t)}</span></button>`).join("");
  const clip = m.highlights.find((h) => h.round === nr && h.clip);
  const [endIcon, endWhy] = roundEnd(round);

  body.innerHTML = `
    <section class="tl-strip">${strip}</section>
    <div class="tl-bar"><b>Round ${nr}</b><span class="sub">${round.winner === "mine" ? "Your team" : "Enemy team"} won · ${endWhy}${round.plant ? ` · bomb planted at ${esc(round.plant[1].replace("Bombsite", "site "))} (${mmss(round.plant[0])})` : ""}</span><span class="grow"></span>
      ${clip ? `<button class="btn primary" id="tl-clip">▶ Watch ${esc(clip.title)}</button>` : ""}</div>
    <div class="tl-main">
      <div class="tl-teams">${teamPanel(round.winner === "mine" ? "mine" : "enemy")}${teamPanel(round.winner === "mine" ? "enemy" : "mine")}</div>
      <section class="tl-map">
        <input class="tl-zoom" type="range" min="1" max="3" step="0.1" value="${timeline.zoom}" aria-label="Zoom" orient="vertical">
        <div class="tl-viewport">
          <div class="tl-canvas" style="transform:translate(${timeline.pan[0]}px,${timeline.pan[1]}px) scale(${timeline.zoom})">
            ${radar ? `<img src="${assetUrl(`radars/${m.map}.png`)}" alt="${esc(mapName(m.map))} radar" draggable="false">` : `<div class="tl-noradar">Radar not available for ${esc(mapName(m.map))} yet</div>`}
            <svg viewBox="0 0 ${size} ${size}" aria-hidden="true">${overlay}</svg>
          </div>
        </div>
      </section>
      <section class="tl-events">
        <div class="tl-tabs"><button data-tltab="kills" class="${timeline.tab === "kills" ? "on" : ""}">Kills</button><button data-tltab="utility" class="${timeline.tab === "utility" ? "on" : ""}">Utility</button></div>
        <button class="tl-ev all ${sel == null ? "on" : ""}" data-ev="all"><b>Entire Round</b><span>${events.length} event${events.length === 1 ? "" : "s"}</span></button>
        <div class="tl-list">${list || `<div class="empty small">Nothing this round.</div>`}</div>
      </section>
    </div>`;

  const rerender = () => renderTimelineTab(body, m, id);
  body.querySelectorAll("[data-round]").forEach((b) => (b.onclick = () => { timeline.round = Number(b.dataset.round); timeline.event = null; rerender(); }));
  body.querySelectorAll("[data-tltab]").forEach((b) => (b.onclick = () => { timeline.tab = b.dataset.tltab; timeline.event = null; rerender(); }));
  body.querySelectorAll("[data-ev]").forEach((b) => (b.onclick = () => { timeline.event = b.dataset.ev === "all" ? null : Number(b.dataset.ev); rerender(); }));
  body.querySelectorAll("[data-player]").forEach((c) => (c.onchange = () => {
    if (c.checked) timeline.hidden.delete(c.dataset.player); else timeline.hidden.add(c.dataset.player);
    timeline.event = null;
    rerender();
  }));
  body.querySelector("#tl-clip")?.addEventListener("click", () => {
    const list = m.highlights.filter((h) => h.clip).map((h) => ({ ...h, name: names.get(h.player), match: m }));
    state.playlist = list;
    play(list.findIndex((h) => h.id === clip.id));
  });
  // Zoom with the slider or the wheel; drag to move around.
  const canvas = body.querySelector(".tl-canvas"), zoom = body.querySelector(".tl-zoom"), vp = body.querySelector(".tl-viewport");
  const apply = () => { canvas.style.transform = `translate(${timeline.pan[0]}px,${timeline.pan[1]}px) scale(${timeline.zoom})`; zoom.value = timeline.zoom; };
  zoom.oninput = () => { timeline.zoom = Number(zoom.value); if (timeline.zoom === 1) timeline.pan = [0, 0]; apply(); };
  vp.onwheel = (e) => { e.preventDefault(); timeline.zoom = Math.max(1, Math.min(3, timeline.zoom - Math.sign(e.deltaY) * 0.2)); if (timeline.zoom === 1) timeline.pan = [0, 0]; apply(); };
  vp.onpointerdown = (e) => {
    if (timeline.zoom === 1) return;
    const start = [e.clientX - timeline.pan[0], e.clientY - timeline.pan[1]];
    vp.setPointerCapture(e.pointerId);
    vp.onpointermove = (ev) => { timeline.pan = [ev.clientX - start[0], ev.clientY - start[1]]; apply(); };
    vp.onpointerup = () => { vp.onpointermove = null; };
  };
}

// ---- whiff analyzer: the clip with your crosshair, spray control and movement in sync ---------------

const SPEEDS = [0.25, 0.5, 1];
let waSpeed = 0.5;
try { waSpeed = Number(localStorage.getItem("veloxify.whiffSpeed")) || 0.5; } catch (e) { /* default */ }

// Builds the analyzer above the lowlight's breakdown. `l.trace` holds every tick from a second
// before the first shot to the death (64 per second).
function whiffAnalyzer(l, m, VCOL) {
  const tr = l.trace;
  if (!tr || !tr.look?.length) return "";
  return `
    <section class="wa">
      <div class="wa-video">
        ${l.clip ? `<video id="wa-video" src="${assetUrl(l.clip)}" playsinline preload="auto"></video>`
          : `<div class="wa-novideo"><b>No clip yet</b><span>The panels below replay the moment from the demo. Render the clip to watch it alongside.</span></div>`}
        <div class="wa-controls">
          <button class="btn primary" id="wa-play">▶ Play</button>
          <div class="seg" id="wa-speeds">${SPEEDS.map((s) => `<button data-speed="${s}" class="${s === waSpeed ? "on" : ""}">${s}x</button>`).join("")}</div>
          <input type="range" id="wa-scrub" min="0" max="${tr.look.length - 1}" value="0" step="1" aria-label="Moment">
          <span class="wa-time" id="wa-time"></span>
          ${l.clip ? volumeControlHtml("wa-vol") : ""}
        </div>
      </div>
      <div class="wa-panels">
        <div class="wa-panel"><div class="h2">Your crosshair vs ${esc(l.killer_name)}</div><svg id="wa-target" viewBox="0 0 320 320" role="img" aria-label="Your crosshair and bullets on his body"></svg>
          <div class="sub">Line = your crosshair's path · ✕ = where the next bullet would go (crosshair + recoil) · dots = bullets fired.</div></div>
        <div class="wa-panel"><div class="h2">Spray control: recoil vs your pull</div><svg id="wa-spray" viewBox="0 0 280 320" role="img" aria-label="The gun's recoil against your mouse pull"></svg>
          <div class="sub" id="wa-spray-note">Grey = where recoil pushed the bullets. Blue = your mouse pull, flipped: on top of the grey means you countered it perfectly.</div></div>
        <div class="wa-panel"><div class="h2">Movement</div>
          <div class="wa-keys" id="wa-keys">
            <span></span><kbd data-k="1">W</kbd><span></span>
            <kbd data-k="4">A</kbd><kbd data-k="2">S</kbd><kbd data-k="8">D</kbd>
            <kbd data-k="128" class="wide">Shift</kbd><kbd data-k="32" class="wide">Ctrl</kbd><kbd data-k="16" class="wide">Space</kbd>
          </div>
          <div class="wa-speedline"><b id="wa-speed-now">0</b> u/s <span id="wa-speed-state"></span></div>
          <svg id="wa-speedgraph" viewBox="0 0 300 120" role="img" aria-label="Your speed over the moment"></svg>
          <div class="sub">Accurate below ${Math.round(tr.accurate_speed)} u/s (34% of the gun's max speed).</div></div>
      </div>
    </section>`;
}

function wireWhiffAnalyzer(view, l, VCOL) {
  const tr = l.trace;
  if (!tr || !tr.look?.length) return;
  const n = tr.look.length;
  const seg = l.segments?.[0] || [tr.start_tick, tr.start_tick + n];
  // Shots by trace index, with their verdicts.
  const shotIdx = (l.shot_details || []).map((s) => ({ ...s, i: Math.round(l.death_tick - s.t * 64) - tr.start_tick })).filter((s) => s.i >= 0 && s.i < n);
  const firstShot = shotIdx.length ? Math.min(...shotIdx.map((s) => s.i)) : 0;
  const video = view.querySelector("#wa-video"), scrub = view.querySelector("#wa-scrub"), playBtn = view.querySelector("#wa-play");
  const target = view.querySelector("#wa-target"), spray = view.querySelector("#wa-spray"), graph = view.querySelector("#wa-speedgraph");

  // Recoil, in degrees on screen (x right, y up): the demo's own aim punch where it records it
  // (Premier), else this gun's usual pattern learned from Premier demos (FACEIT demos don't record
  // it), else unknown. Bullets go where you look plus twice the punch.
  const wrap = (a) => ((a + 540) % 360) - 180;
  const hasAngles = tr.view?.length === n && tr.punch?.length === n;
  const demoPunch = hasAngles && tr.punch.some(([a, b]) => a || b);
  const pattern = hasAngles && !demoPunch ? state.recoil?.[(l.weapon || "").replace(/^weapon_/, "")] : null;
  const recoilFrom = demoPunch ? "demo" : pattern ? "pattern" : hasAngles ? null : "legacy";
  const bulletAt = new Array(n).fill(-1);
  for (const s of shotIdx.slice().sort((a, b) => a.i - b.i)) for (let j = s.i; j < n; j++) bulletAt[j] = s.bullet - 1;
  const recoil = recoilFrom === "demo" ? tr.punch.map(([py, pp]) => [-2 * py, -2 * pp])
    : recoilFrom === "pattern" ? bulletAt.map((k) => { const [pp, py] = k < 0 ? [0, 0] : pattern[Math.min(k, pattern.length - 1)]; return [-2 * py, -2 * pp]; })
    : recoilFrom === "legacy" ? tr.aim.map((a, i) => [a[0] - tr.look[i][0], a[1] - tr.look[i][1]]) : null;
  // Where the bullets went on him (cm): the crosshair plus the recoil at his distance. The demo's
  // own punch is already in the trace; a learned pattern is added here.
  const distCm = (l.distance_m || 10) * 100;
  const cmOf = (deg) => Math.tan((deg * Math.PI) / 180) * distCm;
  const aim = recoilFrom === "pattern" ? tr.look.map(([x, y], i) => [x + cmOf(recoil[i][0]), y + cmOf(recoil[i][1])]) : tr.aim;
  const shotAt = (s) => (s.off_x_cm == null ? null : recoilFrom === "pattern" ? [s.off_x_cm + cmOf(recoil[s.i][0]), s.off_y_cm + cmOf(recoil[s.i][1])] : [s.off_x_cm, s.off_y_cm]);

  // Target view scale: fit his body and what the crosshair did around the spray.
  const near = tr.look.slice(Math.max(0, firstShot - 16)).concat(aim.slice(Math.max(0, firstShot - 16)));
  const ext = Math.min(300, Math.max(110, ...near.map(([x, y]) => Math.max(Math.abs(x), Math.abs(y) * 0.8)).map((v) => v * 1.1)));
  const TW = 320, sc = (TW / 2 - 12) / ext, cx = TW / 2, cy = 120;
  const X = (x) => Math.max(6, Math.min(TW - 6, cx + x * sc)), Y = (y) => Math.max(6, Math.min(314, cy - y * sc));
  const body = `<circle cx="${cx}" cy="${cy}" r="${13 * sc}" class="tg-body"/>
    <rect x="${cx - 24 * sc}" y="${cy + 18 * sc}" width="${48 * sc}" height="${80 * sc}" rx="${8 * sc}" class="tg-body"/>
    <rect x="${cx - 20 * sc}" y="${cy + 98 * sc}" width="${17 * sc}" height="${70 * sc}" rx="${5 * sc}" class="tg-body"/>
    <rect x="${cx + 3 * sc}" y="${cy + 98 * sc}" width="${17 * sc}" height="${70 * sc}" rx="${5 * sc}" class="tg-body"/>`;

  // Spray, in degrees on screen (x right, y up): where recoil pushed the bullets (twice the punch),
  // and your mouse movement since the first shot, flipped so countering it overlaps the recoil.
  // From raw view angles when the trace has them (independent of how he moved); else relative to him.
  const v0 = hasAngles ? tr.view[firstShot] : tr.look[firstShot];
  const pull = hasAngles ? tr.view.map(([y, p]) => [wrap(y - v0[0]), p - v0[1]]) : tr.look.map((p) => [-(p[0] - v0[0]), -(p[1] - v0[1])]);
  const unit = hasAngles ? 0.35 : 8; // "off" threshold: degrees, or cm relative to him
  const sprayPts = (recoil || []).slice(firstShot).concat(pull.slice(firstShot));
  const sext = Math.max(hasAngles ? 3 : 40, ...sprayPts.map(([x, y]) => Math.max(Math.abs(x) * 1.6, Math.abs(y))));
  // Both climb from the bottom like a CS spray chart: recoil pushes bullets up, pulling down counters it.
  const SW = 280, SH = 320, ssc = (SH - 40) / sext, scx = SW / 2, scy = SH - 20;
  const SX = (x) => scx + x * ssc, SY = (y) => scy - y * ssc;

  const maxSpeed = Math.max(250, ...tr.speed);
  const GW = 300, GH = 120;
  const gx = (i) => 6 + (i / Math.max(1, n - 1)) * (GW - 12), gy = (v) => GH - 10 - (v / maxSpeed) * (GH - 20);
  const speedPath = tr.speed.map((v, i) => `${i ? "L" : "M"}${gx(i).toFixed(1)},${gy(v).toFixed(1)}`).join(" ");
  const shotMarks = shotIdx.map((s) => `<line x1="${gx(s.i)}" x2="${gx(s.i)}" y1="${GH - 10}" y2="${GH - 4}" stroke="${VCOL[s.verdict] || "#8a8f98"}" stroke-width="3"/>`).join("");

  const draw = (i) => {
    i = Math.max(0, Math.min(n - 1, Math.round(i)));
    scrub.value = i;
    const fired = shotIdx.filter((s) => s.i <= i);
    // Target view.
    const from = Math.max(0, i - 40);
    const trail = tr.look.slice(from, i + 1).map(([x, y], k) => `${k ? "L" : "M"}${X(x).toFixed(1)},${Y(y).toFixed(1)}`).join(" ");
    const [ax, ay] = aim[i];
    target.innerHTML = `<line x1="${cx}" y1="0" x2="${cx}" y2="320" class="tg-axis"/><line x1="0" y1="${cy}" x2="${TW}" y2="${cy}" class="tg-axis"/>${body}
      <path d="${trail}" class="wa-trail"/>
      ${fired.map((s) => { const p = shotAt(s); return p ? `<g class="tg-shot"><circle cx="${X(p[0])}" cy="${Y(p[1])}" r="8" fill="${VCOL[s.verdict] || "#8a8f98"}"/><text x="${X(p[0])}" y="${Y(p[1]) + 4}" text-anchor="middle">${s.bullet}</text></g>` : ""; }).join("")}
      ${recoil ? `<path d="M${X(ax) - 7},${Y(ay) - 7}L${X(ax) + 7},${Y(ay) + 7}M${X(ax) + 7},${Y(ay) - 7}L${X(ax) - 7},${Y(ay) + 7}" class="wa-cross"/>` : ""}
      <circle cx="${X(tr.look[i][0])}" cy="${Y(tr.look[i][1])}" r="4" class="wa-look"/>`;
    // Spray control (only once the spray has started).
    if (i >= firstShot) {
      const r = recoil ? recoil.slice(firstShot, i + 1) : null, p = pull.slice(firstShot, i + 1);
      const path = (pts) => pts.map(([x, y], k) => `${k ? "L" : "M"}${SX(x).toFixed(1)},${SY(y).toFixed(1)}`).join(" ");
      // Bullets sit on the recoil line, or on your pull when the recoil isn't known.
      const marks = recoil || pull;
      spray.innerHTML = `<line x1="${scx}" y1="8" x2="${scx}" y2="${SH - 8}" class="tg-axis"/>
        ${r ? `<path d="${path(r)}" class="wa-recoil"/>` : ""}<path d="${path(p)}" class="wa-pull"/>
        ${fired.map((s) => { const q = marks[s.i]; return q ? `<circle cx="${SX(q[0])}" cy="${SY(q[1])}" r="5" fill="${VCOL[s.verdict] || "#8a8f98"}"><title>Bullet ${s.bullet}</title></circle>` : ""; }).join("")}`;
      const note = view.querySelector("#wa-spray-note");
      if (!r) {
        note.textContent = "This demo doesn't record recoil and there's no learned pattern for this gun yet (it's learned from Premier demos in your library). Blue = your mouse pull; dots = bullets (green hit).";
      } else if (r.length > 8) {
        // Running read on the pull: compare where you pulled to where recoil went.
        const last = r.length - 1;
        const dy = p[last][1] - r[last][1], dx = p[last][0] - r[last][0];
        const parts = [];
        if (Math.abs(dy) > unit * 1.5) parts.push(dy < 0 ? "pulling down too little (bullets rise over him)" : "pulling down too much (bullets drop under him)");
        if (Math.abs(dx) > unit * 1.5) parts.push(dx > 0 ? "pulling too far left (bullets drift left of him)" : "pulling too far right (bullets drift right of him)");
        const at = fired.length ? `At bullet ${fired[fired.length - 1].bullet}` : "Right now";
        note.textContent = (parts.length ? `${at}: ${parts.join(", ")}.` : `${at}: your pull matches the recoil.`)
          + (recoilFrom === "pattern" ? " (Recoil = this gun's usual pattern from your Premier demos; FACEIT demos don't record it.)" : "");
      }
    } else {
      spray.innerHTML = `<text x="${scx}" y="${SH / 2}" text-anchor="middle" class="wa-wait">Spray starts at bullet 1</text>`;
    }
    // Movement.
    const k = tr.keys[i] || 0;
    view.querySelectorAll("#wa-keys kbd").forEach((el) => el.classList.toggle("on", (k & Number(el.dataset.k)) !== 0));
    const v = tr.speed[i] || 0, air = tr.air[i];
    view.querySelector("#wa-speed-now").textContent = Math.round(v);
    const st = view.querySelector("#wa-speed-state");
    st.textContent = air ? "in the air" : v <= tr.accurate_speed ? "accurate" : "too fast to be accurate";
    st.className = air || v > tr.accurate_speed ? "down" : "up";
    graph.innerHTML = `<line x1="6" x2="${GW - 6}" y1="${gy(tr.accurate_speed)}" y2="${gy(tr.accurate_speed)}" class="sp-acc"/>
      <path d="${speedPath}" class="sp-line"/>${shotMarks}<line x1="${gx(i)}" x2="${gx(i)}" y1="4" y2="${GH - 4}" class="wa-cursor"/>`;
    view.querySelector("#wa-time").textContent = `${((i - (n - 1)) / 64).toFixed(2)} s to death`;
  };

  // Video drives the panels; without a clip, a timer replays the trace.
  const tickOfVideo = () => seg[0] + (video.currentTime * 64) - tr.start_tick;
  let timer = null, idx = 0;
  const setSpeed = (s) => {
    waSpeed = s;
    try { localStorage.setItem("veloxify.whiffSpeed", String(s)); } catch (e) { /* not saved */ }
    view.querySelectorAll("[data-speed]").forEach((b) => b.classList.toggle("on", Number(b.dataset.speed) === s));
    if (video) video.playbackRate = s;
  };
  view.querySelectorAll("[data-speed]").forEach((b) => (b.onclick = () => setSpeed(Number(b.dataset.speed))));
  if (video) {
    wireVolume(view.querySelector("#wa-vol"), video);
    video.playbackRate = waSpeed;
    // Start a moment before the first shot.
    video.addEventListener("loadedmetadata", () => { video.currentTime = Math.max(0, (tr.start_tick - seg[0]) / 64); }, { once: true });
    const loop = () => { draw(tickOfVideo()); if (!video.paused) requestAnimationFrame(loop); };
    video.addEventListener("play", () => { playBtn.textContent = "❚❚ Pause"; requestAnimationFrame(loop); });
    video.addEventListener("pause", () => { playBtn.textContent = "▶ Play"; draw(tickOfVideo()); });
    video.addEventListener("seeked", () => draw(tickOfVideo()));
    playBtn.onclick = () => (video.paused ? video.play() : video.pause());
    scrub.oninput = () => { video.pause(); video.currentTime = Math.max(0, (Number(scrub.value) + tr.start_tick - seg[0]) / 64); draw(Number(scrub.value)); };
  } else {
    const stop = () => { clearInterval(timer); timer = null; playBtn.textContent = "▶ Play"; };
    playBtn.onclick = () => {
      if (timer) return stop();
      if (idx >= n - 1) idx = 0;
      playBtn.textContent = "❚❚ Pause";
      timer = setInterval(() => { idx += 1; draw(idx); if (idx >= n - 1) stop(); }, 1000 / (64 * waSpeed));
    };
    scrub.oninput = () => { stop(); idx = Number(scrub.value); draw(idx); };
  }
  draw(0);
}

// ---- match page: grenade lineups ----------------------------------------------------------------

const lineups = { kinds: new Set(["smoke", "molotov", "flash", "he"]), setOnly: true, team: "all", player: "", sel: null, zoom: 1, pan: [0, 0] };
const NADE_INFO = { smoke: ["Smokes", "smokegrenade", "#cfd3d8"], molotov: ["Molotovs", "molotov", "#f06e28"], flash: ["Flashes", "flashbang", "#ffffff"], he: ["HEs", "hegrenade", "#e2445f"] };
const TECH = { stand: "Standing", jump: "Jump-throw", crouch: "Crouching", walk: "Walking", run: "Running" };
const CLICK = { left: "left click", right: "right click (underhand)", both: "left + right (middle)" };

// Callout names near a spot, from where CS2 placed the players in this match's kills.
function calloutFinder(d) {
  const pts = [];
  for (const k of d.kills) {
    if (k.attacker_xy && k.attacker_place) pts.push([k.attacker_xy, k.attacker_place]);
    if (k.victim_xy && k.victim_place) pts.push([k.victim_xy, k.victim_place]);
  }
  return (xy) => {
    let best = null, bd = 450 * 450;
    for (const [p, name] of pts) {
      const dd = (p[0] - xy[0]) ** 2 + (p[1] - xy[1]) ** 2;
      if (dd < bd) { bd = dd; best = name; }
    }
    return best ? best.replace(/([a-z])([A-Z])/g, "$1 $2").replace("Bombsite", "Site ") : "";
  };
}

async function renderLineupsTab(body, m, id) {
  const [d, radar, mapLineups] = await Promise.all([loadDetails(id), loadRadar(m.map), loadMapLineups(m.map), loadLineups()]);
  // The library-wide lineup each throw belongs to (its video).
  const lineupOf = (t) => mapLineups?.by_throw?.[`${id}@${t.tick}`];
  const lineupCount = (lid) => mapLineups?.lineups?.find((l) => l.id === lid)?.count || 0;
  if (!d) return noDetails(body);
  if (!d.throws) { body.innerHTML = `<div class="empty">Lineups need this match analyzed again; Veloxify does that in the background while CS2 is closed.</div>`; return; }
  if (lineups.matchId !== id) Object.assign(lineups, { matchId: id, sel: null, player: "", zoom: 1, pan: [0, 0] });
  const names = new Map(m.players.map((p) => [p.steamid, p.name]));
  const team = new Map(m.players.map((p) => [p.steamid, p.side]));
  const callout = calloutFinder(d);
  const all = d.throws.filter((t) => !lineups.setOnly || (mapLineups?.by_throw ? lineupOf(t) : t.set));
  // The same lineup thrown again (same spot, same aim, same landing) counts once, with how often.
  const groups = [];
  for (const t of all.slice().sort((a, b) => a.round - b.round || a.t - b.t)) {
    const g = groups.find((x) => x.kind === t.kind && x.player === t.player && Math.hypot(x.from[0] - t.from[0], x.from[1] - t.from[1]) < 32
      && Math.hypot(x.to[0] - t.to[0], x.to[1] - t.to[1]) < 120 && Math.abs(x.pitch - t.pitch) < 2 && Math.abs(((x.yaw - t.yaw + 540) % 360) - 180) < 2);
    if (g) g.rounds.push(t.round); else groups.push({ ...t, rounds: [t.round] });
  }
  const shown = groups.filter((g) => lineups.kinds.has(g.kind) && (lineups.team === "all" || team.get(g.player) === lineups.team) && (!lineups.player || g.player === lineups.player));
  const sel = lineups.sel != null && lineups.sel < shown.length ? lineups.sel : null;
  const size = radar?.size || 1024;
  const at = (xy) => (radar ? [(xy[0] - radar.pos_x) / radar.scale, (radar.pos_y - xy[1]) / radar.scale] : null);
  const R = { smoke: 144, molotov: 120, flash: 40, he: 70 };
  const overlay = shown.map((g, i) => {
    const a = at(g.from), b = at(g.to);
    if (!a || !b) return "";
    const dim = sel != null && sel !== i;
    const tc = TEAM_COLOR[team.get(g.player)] || "#ccc";
    const r = R[g.kind] / (radar?.scale || 5);
    return `<g class="ln ${g.kind} ${dim ? "dim" : ""} ${sel === i ? "on" : ""}" data-ln="${i}">
      <line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" class="ln-path"/>
      <circle cx="${b[0]}" cy="${b[1]}" r="${r}" class="ln-land"/>
      <circle cx="${a[0]}" cy="${a[1]}" r="6" fill="${tc}" class="ln-from"/>
      ${g.rounds.length > 1 ? `<text x="${b[0]}" y="${b[1] + 4}" text-anchor="middle" class="ln-count">×${g.rounds.length}</text>` : ""}
      <title>${esc(names.get(g.player) || "")}: ${NADE_INFO[g.kind][0].slice(0, -1)} ${esc(callout(g.from))} → ${esc(callout(g.to))}</title></g>`;
  }).join("");
  const counts = Object.fromEntries(Object.keys(NADE_INFO).map((k) => [k, groups.filter((g) => g.kind === k).length]));
  const s = sel != null ? shown[sel] : null;
  const setpos = s ? `setpos ${s.from[0].toFixed(2)} ${s.from[1].toFixed(2)} ${s.from[2].toFixed(2)};setang ${s.pitch.toFixed(2)} ${s.yaw.toFixed(2)} 0` : "";
  const players = m.players.slice().sort((a, b) => (a.side === b.side ? a.name.localeCompare(b.name) : a.side === "mine" ? -1 : 1));
  body.innerHTML = `
    <div class="ln-bar">
      <div class="chips">${Object.entries(NADE_INFO).map(([k, [label, w]]) => `<button class="chip ${lineups.kinds.has(k) ? "on" : ""}" data-kind="${k}">${weaponIcon(w)} ${label} <span class="sub">${counts[k]}</span></button>`).join("")}</div>
      <label class="check"><input type="checkbox" id="ln-set" ${lineups.setOnly ? "checked" : ""}> Lineups only (instant smokes and set lineups)</label>
      <div class="seg" id="ln-team">${[["all", "Both teams"], ["mine", "My team"], ["enemy", "Enemy"]].map(([k, l]) => `<button data-team="${k}" class="${lineups.team === k ? "on" : ""}">${l}</button>`).join("")}</div>
      <select id="ln-player"><option value="">Everyone</option>${players.map((p) => `<option value="${p.steamid}" ${lineups.player === p.steamid ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select>
    </div>
    <div class="ln-main">
      <section class="tl-map">
        <input class="tl-zoom" type="range" min="1" max="3" step="0.1" value="${lineups.zoom}" aria-label="Zoom" orient="vertical">
        <div class="tl-viewport"><div class="tl-canvas" style="transform:translate(${lineups.pan[0]}px,${lineups.pan[1]}px) scale(${lineups.zoom})">
          ${radar ? `<img src="${assetUrl(`radars/${m.map}.png`)}" alt="${esc(mapName(m.map))} radar" draggable="false">` : `<div class="tl-noradar">Radar not available for ${esc(mapName(m.map))} yet</div>`}
          <svg viewBox="0 0 ${size} ${size}">${overlay}</svg></div></div>
      </section>
      <section class="tl-events ln-side">
        ${s ? `<div class="ln-detail">
          ${(() => { const lid = lineupOf(s), c = lid && lineupClip(lid); return c?.clip ? `<video class="ln-video" src="${assetUrl(c.clip)}" controls autoplay muted loop playsinline></video>`
            : lid && tauri ? `<div class="gn-novideo"><b>No video yet</b><span>${esc(lineupWaitText(lineupCount(lid)))}</span><button class="btn primary" id="ln-film" data-lid="${esc(lid)}">Film this lineup now</button></div>` : ""; })()}
          <div class="ln-title">${weaponIcon(NADE_INFO[s.kind][1])}<b>${esc(callout(s.from) || "Spot")} → ${esc(callout(s.to) || "landing")}</b></div>
          <div class="sub">${esc(names.get(s.player) || "")} · ${s.side} · round${s.rounds.length > 1 ? "s" : ""} ${s.rounds.join(", ")} · ${mmss(s.t)}</div>
          <ul class="ln-facts"><li>${TECH[s.technique] || s.technique}, ${CLICK[s.click] || s.click}</li>
            <li>Stood still ${s.still_s.toFixed(2)} s, aim moved ${s.aim_moved_deg.toFixed(1)}° before the throw</li>
            <li>Thrown ${Math.round(Math.hypot(s.to[0] - s.from[0], s.to[1] - s.from[1]))} units</li></ul>
          <div class="ln-cmd"><code>${esc(setpos)}</code><button class="btn" id="ln-copy">Copy</button></div>
          <div class="sub">Paste in the console on a practice server (sv_cheats 1) to stand exactly here, aiming exactly here.</div>
          <button class="btn ghost" id="ln-back">◀ All lineups</button></div>` : ""}
        <div class="tl-list">${shown.map((g, i) => `<button class="tl-ev ln-ev ${sel === i ? "on" : ""}" data-ln="${i}">
          ${(() => { const lid = lineupOf(g), c = lid && lineupClip(lid); return c?.clip ? `<div class="hl-card gn-thumb small" data-clip="${esc(c.clip)}"><div class="hl-thumb" style="${c.thumb ? `background-image:url('${assetUrl(c.thumb)}')` : ""}"><span class="play">▶</span></div></div>` : ""; })()}
          <div>${weaponIcon(NADE_INFO[g.kind][1])}<b style="color:${TEAM_COLOR[team.get(g.player)]}">${esc(names.get(g.player) || "")}</b>${g.rounds.length > 1 ? `<span class="ln-x">×${g.rounds.length}</span>` : ""}</div>
          <span>${esc(callout(g.from) || "?")} → ${esc(callout(g.to) || "?")} · R${g.rounds[0]} ${mmss(g.t)} · ${TECH[g.technique] || g.technique}</span></button>`).join("") || `<div class="empty small">No lineups with these filters.</div>`}</div>
      </section>
    </div>
    <div class="note">A set lineup: the thrower stood still (or jump-threw from a standstill), held their aim on a spot and threw it a fair way. Throws on the move or snap flashes are left out unless you untick "Set lineups only".</div>`;

  const rerender = () => renderLineupsTab(body, m, id);
  body.querySelectorAll("[data-kind]").forEach((b) => (b.onclick = () => { const k = b.dataset.kind; if (lineups.kinds.has(k)) lineups.kinds.delete(k); else lineups.kinds.add(k); lineups.sel = null; rerender(); }));
  body.querySelector("#ln-set").onchange = (e) => { lineups.setOnly = e.target.checked; lineups.sel = null; rerender(); };
  body.querySelectorAll("[data-team]").forEach((b) => (b.onclick = () => { lineups.team = b.dataset.team; lineups.sel = null; rerender(); }));
  body.querySelector("#ln-player").onchange = (e) => { lineups.player = e.target.value; lineups.sel = null; rerender(); };
  body.querySelectorAll("[data-ln]").forEach((el) => (el.onclick = () => { lineups.sel = Number(el.dataset.ln); rerender(); }));
  body.querySelector("#ln-back")?.addEventListener("click", () => { lineups.sel = null; rerender(); });
  body.querySelector("#ln-copy")?.addEventListener("click", (e) => { navigator.clipboard?.writeText(setpos); e.target.textContent = "Copied"; });
  body.querySelector("#ln-film")?.addEventListener("click", async (e) => { e.target.disabled = true; e.target.textContent = "Queued: it films when CS2 is closed"; await tauri.core.invoke("render_lineups", { ids: [e.target.dataset.lid] }); });
  const canvas = body.querySelector(".tl-canvas"), zoom = body.querySelector(".tl-zoom"), vp = body.querySelector(".tl-viewport");
  const apply = () => { canvas.style.transform = `translate(${lineups.pan[0]}px,${lineups.pan[1]}px) scale(${lineups.zoom})`; zoom.value = lineups.zoom; };
  zoom.oninput = () => { lineups.zoom = Number(zoom.value); if (lineups.zoom === 1) lineups.pan = [0, 0]; apply(); };
  vp.onwheel = (e) => { e.preventDefault(); lineups.zoom = Math.max(1, Math.min(3, lineups.zoom - Math.sign(e.deltaY) * 0.2)); if (lineups.zoom === 1) lineups.pan = [0, 0]; apply(); };
  vp.onpointerdown = (e) => {
    if (lineups.zoom === 1 || e.target.closest("[data-ln]")) return;
    const start = [e.clientX - lineups.pan[0], e.clientY - lineups.pan[1]];
    vp.setPointerCapture(e.pointerId);
    vp.onpointermove = (ev) => { lineups.pan = [ev.clientX - start[0], ev.clientY - start[1]]; apply(); };
    vp.onpointerup = () => { vp.onpointermove = null; };
  };
}

// ---- match page: 2D replay ------------------------------------------------------------------------

async function loadReplay(id) {
  state.replays = state.replays || new Map();
  if (!state.replays.has(id)) {
    let r = null;
    try {
      const res = await fetch(assetUrl(`matches/${id}.replay.json.gz`), { cache: "no-store" });
      if (res.ok) {
        const stream = res.body.pipeThrough(new DecompressionStream("gzip"));
        r = JSON.parse(await new Response(stream).text());
      }
    } catch (e) { /* not built yet */ }
    state.replays.set(id, r);
  }
  return state.replays.get(id);
}

// The round strip (halves, how each round ended), shared by the timeline and the replay.
function roundStripHtml(rounds, nr) {
  const halves = [];
  for (const r of rounds) {
    const h = r.number <= 12 ? "First half" : r.number <= 24 ? "Second half" : `Overtime ${Math.floor((r.number - 25) / 6) + 1} · half ${Math.floor(((r.number - 25) % 6) / 3) + 1}`;
    if (!halves.length || halves[halves.length - 1].name !== h) halves.push({ name: h, rounds: [] });
    halves[halves.length - 1].rounds.push(r);
  }
  return halves.map((h) => {
    const last = h.rounds[h.rounds.length - 1];
    return `<div class="tl-half" style="flex:${h.rounds.length} 1 0"><div class="tl-half-head"><span>${esc(h.name.toUpperCase())}</span><b><i class="mine">${last.score_mine}</i>:<i class="enemy">${last.score_theirs}</i></b></div>
      <div class="tl-tiles" style="grid-template-columns:repeat(${h.rounds.length},minmax(30px,1fr))">${h.rounds.map((r) => {
        const [icon, why] = roundEnd(r);
        return `<button class="tl-tile ${r.winner} ${r.number === nr ? "on" : ""}" data-round="${r.number}" title="Round ${r.number}: ${r.winner === "mine" ? "your team" : "enemy"} won (${why}) · ${r.score_mine}-${r.score_theirs}">
          <b>${r.number}</b><span>${ROUND_ICONS[icon]}</span></button>`;
      }).join("")}</div></div>`;
  }).join(`<div class="tl-sep"></div>`);
}

const replay = { round: 1, t: 0, speed: 1, playing: false, names: true, weapons: true };
let replayRaf = null;

const ROUND_S = 115, BOMB_S = 40, KILL_LINE_S = 1.2;
const SKULL = `<path d="M0 -8a7 7 0 0 0 -7 7c0 2.6 1.3 4.2 3 5v3h8v-3c1.7 -0.8 3 -2.4 3 -5a7 7 0 0 0 -7 -7z" fill="currentColor" stroke="#0b0b0b" stroke-width="1.5"/>
  <circle cx="-2.6" cy="-1" r="1.7" fill="#0b0b0b"/><circle cx="2.6" cy="-1" r="1.7" fill="#0b0b0b"/>`;

async function renderReplayTab(body, m, id) {
  cancelAnimationFrame(replayRaf);
  const [d, radar, rp] = await Promise.all([loadDetails(id), loadRadar(m.map), loadReplay(id)]);
  if (!d || !rp) { body.innerHTML = `<div class="empty">This match's 2D replay isn't built yet. Veloxify builds it in the background while CS2 is closed.</div>`; return; }
  if (replay.matchId !== id) Object.assign(replay, { matchId: id, round: 1, t: 0, playing: false });
  const round = d.rounds.find((r) => r.number === replay.round) || d.rounds[0];
  const rr = rp.rounds.find((r) => r.number === round.number);
  if (!rr) { body.innerHTML = `<div class="empty">No replay data for round ${round.number}.</div>`; return; }
  const names = new Map(m.players.map((p) => [p.steamid, p.name]));
  const team = new Map(m.players.map((p) => [p.steamid, p.side]));
  const ids = rp.players;
  const stride = rp.stride || 4; // newer replays add the weapon each player holds
  const blinds = (d.blinds || []).filter((b) => b.round === round.number);
  const offset = (round.live_tick - rr.start) / 64; // replay frames start a few ticks before the round goes live
  const duration = (rr.frames.length - 1) * rp.step / 64 - offset;
  const kills = d.kills.filter((k) => k.round === round.number && !k.team_kill);
  const nades = (d.grenades || []).filter((g) => g.round === round.number);
  const throws = (d.throws || []).filter((t) => t.round === round.number);
  const size = radar?.size || 1024;
  const at = (x, y) => (radar ? [(x - radar.pos_x) / radar.scale, (radar.pos_y - y) / radar.scale] : [0, 0]);
  const plant = round.plant ? { t: round.plant[0], who: round.plant[2] } : null;
  const LAST = { smoke: 18, molotov: 7, flash: 0.5, he: 0.6 };
  const R = { smoke: 144, molotov: 120, flash: 60, he: 90 };

  body.innerHTML = `
    <section class="tl-strip">${roundStripHtml(d.rounds, round.number)}</section>
    <div class="rp-main">
      <section class="rp-teams" id="rp-teams"></section>
      <section class="rp-stage">
        <div class="tl-map"><div class="rp-clock" id="rp-clock"><span>Round ${round.number}</span><b></b></div><div class="tl-viewport rp-viewport"><div class="tl-canvas">
          ${radar ? `<img src="${assetUrl(`radars/${m.map}.png`)}" alt="${esc(mapName(m.map))} radar" draggable="false">` : `<div class="tl-noradar">Radar not available</div>`}
          <svg viewBox="0 0 ${size} ${size}" id="rp-svg"></svg></div></div></div>
        <div class="rp-controls">
          <button class="btn primary" id="rp-play">${replay.playing ? "❚❚" : "▶"}</button>
          <div class="seg" id="rp-speeds">${[0.5, 1, 2, 4].map((s) => `<button data-rspeed="${s}" class="${replay.speed === s ? "on" : ""}">${s}x</button>`).join("")}</div>
          <div class="rp-track">
            ${plant ? `<i class="rp-postplant" style="left:${(plant.t / duration) * 100}%"></i><i class="rp-mark plant" style="left:${(plant.t / duration) * 100}%" title="Bomb planted ${mmss(plant.t)}"></i>` : ""}
            ${kills.map((k) => `<i class="rp-mark kill" style="left:${(k.t / duration) * 100}%;background:${TEAM_COLOR[team.get(k.attacker)] || "#ccc"}" title="${esc(names.get(k.attacker) || "World")} killed ${esc(names.get(k.victim) || "")} · ${mmss(k.t)}"></i>`).join("")}
            <input type="range" id="rp-scrub" min="0" max="${duration.toFixed(2)}" step="0.05" value="${replay.t}" aria-label="Round time">
          </div>
          <span class="rp-time" id="rp-time"></span>
          <label class="check"><input type="checkbox" id="rp-names" ${replay.names ? "checked" : ""}> Names</label>
          ${stride >= 5 ? `<label class="check"><input type="checkbox" id="rp-guns" ${replay.weapons ? "checked" : ""}> Weapons</label>` : ""}
        </div>
      </section>
      <section class="tl-events rp-feed"><div class="h3" style="padding:4px 6px 8px">Round ${round.number} kills</div>
        <div class="tl-list">${kills.map((k, i) => `<button class="tl-ev" data-kt="${k.t}" data-ki="${i}"><div><b style="color:${TEAM_COLOR[team.get(k.attacker)] || "#ccc"}">${esc(names.get(k.attacker) || "World")}</b>${weaponIcon(k.weapon)}${k.headshot ? `<span class="hs">◎</span>` : ""}<b style="color:${TEAM_COLOR[team.get(k.victim)] || "#ccc"}">${esc(names.get(k.victim) || "")}</b></div><span>${mmss(k.t)}</span></button>`).join("") || `<div class="empty small">No kills.</div>`}</div>
      </section>
    </div>`;

  const svg = body.querySelector("#rp-svg"), scrub = body.querySelector("#rp-scrub"), timeEl = body.querySelector("#rp-time"), teamsEl = body.querySelector("#rp-teams"), playBtn = body.querySelector("#rp-play");
  fitMapToScreen(body.querySelector(".rp-stage"), body.querySelector(".rp-controls"));
  const lerpYaw = (a, b, f) => a + ((((b - a) % 360) + 540) % 360 - 180) * f;
  // Everyone at round time t (interpolated between samples).
  const stateAt = (t) => {
    const fpos = Math.max(0, (t + offset) * 64 / rp.step);
    const f0 = Math.min(rr.frames.length - 1, Math.floor(fpos)), f1 = Math.min(rr.frames.length - 1, f0 + 1), w = fpos - f0;
    const a = rr.frames[f0], b = rr.frames[f1];
    return ids.map((sid, i) => {
      const o = i * stride;
      const hp = a[o + 3];
      const weapon = stride >= 5 && a[o + 4] >= 0 ? rp.weapons[a[o + 4]] : null;
      const lerp = (k) => a[o + k] + (b[o + k] - a[o + k]) * (b[o + 3] > 0 ? w : 0);
      return { sid, x: lerp(0), y: lerp(1), yaw: lerpYaw(a[o + 2], b[o + 2], b[o + 3] > 0 ? w : 0), hp, weapon };
    });
  };
  const draw = () => {
    const t = replay.t;
    const ps = stateAt(t);
    let out = "";
    // Grenades: thrown (dashed path until it goes off), then smoke/fire/flash/HE where it landed.
    for (const th of throws) {
      const g = nades.find((n) => n.player === th.player && n.kind === th.kind && n.t >= th.t && n.t - th.t < 12);
      const end = g ? g.t : th.t + 2;
      if (t >= th.t && t < end) {
        if (th.path?.length > 1) {
          // Its real flight (a point every 4 ticks): the trail so far and the grenade itself.
          const k = Math.min(th.path.length - 1, Math.floor(((t - th.t) * 64) / 4));
          const pts = th.path.slice(0, k + 1).map(([x, y]) => at(x, y));
          out += `<polyline points="${pts.map((p) => p.join(",")).join(" ")}" class="rp-throw ${th.kind}"/>
            <circle cx="${pts[pts.length - 1][0]}" cy="${pts[pts.length - 1][1]}" r="4.5" class="rp-proj ${th.kind}"/>`;
        } else {
          const [ax, ay] = at(th.from[0], th.from[1]), [bx, by] = at(th.to[0], th.to[1]);
          const f = Math.min(1, (t - th.t) / Math.max(0.3, end - th.t));
          out += `<line x1="${ax}" y1="${ay}" x2="${ax + (bx - ax) * f}" y2="${ay + (by - ay) * f}" class="rp-throw ${th.kind}"/>`;
        }
      }
    }
    for (const g of nades) {
      if (t >= g.t && t < g.t + LAST[g.kind]) {
        const [x, y] = at(g.xy[0], g.xy[1]);
        const fade = g.kind === "smoke" ? Math.min(1, (g.t + LAST.smoke - t) / 2) : 1;
        out += `<circle cx="${x}" cy="${y}" r="${R[g.kind] / (radar?.scale || 5)}" class="rp-nade ${g.kind}" style="opacity:${fade}"/>`;
      }
    }
    // Bomb, once planted: where the planter stood.
    if (plant && t >= plant.t) {
      const pl = stateAt(plant.t).find((p) => p.sid === plant.who);
      if (pl) { const [x, y] = at(pl.x, pl.y); out += `<g class="rp-bomb"><rect x="${x - 8}" y="${y - 8}" width="16" height="16" rx="3"/><text x="${x}" y="${y + 5}" text-anchor="middle">C4</text></g>`; }
    }
    // Kills: a line from the killer to the victim for a moment; then a skull where they fell.
    for (const k of kills.filter((k) => k.t <= t && t < k.t + KILL_LINE_S && k.attacker_xy && k.victim_xy)) {
      const [ax, ay] = at(k.attacker_xy[0], k.attacker_xy[1]), [vx, vy] = at(k.victim_xy[0], k.victim_xy[1]);
      out += `<line x1="${ax}" y1="${ay}" x2="${vx}" y2="${vy}" class="rp-killline" stroke="${TEAM_COLOR[team.get(k.attacker)] || "#ccc"}" style="opacity:${1 - (t - k.t) / KILL_LINE_S}"/>`;
    }
    for (const k of kills.filter((k) => k.t <= t && k.victim_xy)) {
      const [x, y] = at(k.victim_xy[0], k.victim_xy[1]);
      out += `<g class="rp-skull" transform="translate(${x} ${y})" style="color:${TEAM_COLOR[team.get(k.victim)] || "#888"}">${SKULL}</g>`;
    }
    // Live players: dot, view direction, name.
    for (const p of ps) {
      if (p.hp <= 0) continue;
      const [x, y] = at(p.x, p.y);
      const c = TEAM_COLOR[team.get(p.sid)] || "#ccc";
      const rad = (p.yaw * Math.PI) / 180;
      // Flashed: a white glow that fades as the blindness wears off.
      const bl = blinds.find((b) => b.player === p.sid && t >= b.t && t < b.t + b.secs);
      const glow = bl ? `<circle cx="${x}" cy="${y}" r="15" class="rp-blind" style="opacity:${(0.25 + 0.75 * (1 - (t - bl.t) / bl.secs)).toFixed(2)}"/>` : "";
      const gun = replay.weapons && p.weapon ? `<image href="${assetUrl(`weapons/${p.weapon}.svg`)}" x="${x - 14}" y="${y + 11}" width="28" height="12" class="rp-gun"/>` : "";
      out += `<g class="rp-p">${glow}<line x1="${x}" y1="${y}" x2="${x + Math.cos(rad) * 20}" y2="${y - Math.sin(rad) * 20}" class="rp-look"/>
        <circle cx="${x}" cy="${y}" r="9" fill="${c}" class="rp-dot"/>${gun}
        ${replay.names ? `<text x="${x}" y="${y - 14}" text-anchor="middle" class="rp-name">${esc(names.get(p.sid) || "")}</text>` : ""}</g>`;
    }
    svg.innerHTML = out;
    // Side panel: HP per player.
    teamsEl.innerHTML = ["mine", "enemy"].map((side) => `<div class="rp-team ${side}"><div class="h3">${side === "mine" ? "My Team" : "Enemy Team"} <span class="tl-side ${(side === "mine" ? round.mine_side : round.mine_side === "T" ? "CT" : "T") === "T" ? "t" : "ct"}">${side === "mine" ? round.mine_side : round.mine_side === "T" ? "CT" : "T"}</span></div>
      ${ps.filter((p) => team.get(p.sid) === side).sort((a, b) => b.hp - a.hp).map((p) => `<div class="rp-pl ${p.hp <= 0 ? "dead" : ""}"><span>${esc(names.get(p.sid) || "")}</span><i style="width:${p.hp}%;background:${TEAM_COLOR[side]}"></i><b>${p.hp > 0 ? p.hp : "✕"}</b></div>`).join("")}</div>`).join("");
    scrub.value = t;
    timeEl.textContent = `${mmss(Math.max(0, t)).replace("s", "")} / ${mmss(duration).replace("s", "")}`;
    // The round clock (1:55 down), or the bomb timer once it's planted.
    const clock = body.querySelector("#rp-clock b");
    if (plant && t >= plant.t) {
      clock.textContent = `${Math.max(0, BOMB_S - (t - plant.t)).toFixed(1)}`;
      clock.className = "bomb";
    } else {
      const left = Math.max(0, ROUND_S - Math.max(0, t));
      clock.textContent = `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, "0")}`;
      clock.className = "";
    }
    body.querySelectorAll("[data-kt]").forEach((b) => b.classList.toggle("on", Number(b.dataset.kt) <= t));
  };
  let last = null;
  const tick = (now) => {
    if (!replay.playing) return;
    if (last != null) replay.t = Math.min(duration, replay.t + ((now - last) / 1000) * replay.speed);
    last = now;
    draw();
    if (replay.t >= duration) { replay.playing = false; playBtn.textContent = "▶"; return; }
    replayRaf = requestAnimationFrame(tick);
  };
  const setPlaying = (on) => {
    replay.playing = on;
    playBtn.textContent = on ? "❚❚" : "▶";
    last = null;
    if (on) { if (replay.t >= duration) replay.t = 0; replayRaf = requestAnimationFrame(tick); } else cancelAnimationFrame(replayRaf);
  };
  playBtn.onclick = () => setPlaying(!replay.playing);
  body.querySelectorAll("[data-rspeed]").forEach((b) => (b.onclick = () => { replay.speed = Number(b.dataset.rspeed); body.querySelectorAll("[data-rspeed]").forEach((x) => x.classList.toggle("on", x === b)); }));
  scrub.oninput = () => { replay.t = Number(scrub.value); draw(); };
  body.querySelector("#rp-names").onchange = (e) => { replay.names = e.target.checked; draw(); };
  body.querySelector("#rp-guns")?.addEventListener("change", (e) => { replay.weapons = e.target.checked; draw(); });
  body.querySelectorAll("[data-kt]").forEach((b) => (b.onclick = () => { replay.t = Math.max(0, Number(b.dataset.kt) - 2); draw(); }));
  body.querySelectorAll("[data-round]").forEach((b) => (b.onclick = () => { replay.round = Number(b.dataset.round); replay.t = 0; replay.playing = false; renderReplayTab(body, m, id); }));
  draw();
  if (replay.playing) setPlaying(true);
}

// ---- highlights ---------------------------------------------------------------------------------

async function renderHighlights(body, ids) {
  // Only you (and players you opted in) have highlights; everyone else is stats-only.
  const groups = [];
  for (const id of ids) {
    const m = await loadMatch(id, true); // clips appear while the renderer works
    const names = new Map(m.players.map((p) => [p.steamid, p.name]));
    const list = m.highlights.map((h) => ({ ...h, name: names.get(h.player), match: m }));
    if (list.length) groups.push({ m, list });
  }
  state.playlist = groups.flatMap((g) => g.list.filter((h) => h.clip));
  if (!groups.length) { body.innerHTML = `<div class="empty">No highlights detected.</div>`; return; }
  // While clips are still rendering, refresh this list every few seconds (not while a clip plays).
  clearTimeout(state.refreshTimer);
  if (groups.some((g) => g.list.some((h) => !h.clip && !h.render_error))) {
    state.refreshTimer = setTimeout(() => {
      if (document.body.contains(body) && document.getElementById("player").hidden) renderHighlights(body, ids);
    }, 5000);
  }
  body.innerHTML = `
    ${groups.map(({ m, list }) => `
      <div class="hl-group">
        ${ids.length > 1 ? `<div class="h2">${esc(mapName(m.map))} · ${m.score_mine}-${m.score_theirs} · ${fmtTime(m.played_at)}</div>` : ""}
        <div class="hl-grid">${list.map((h) => `
          <div class="hl-card ${h.clip ? "" : "pending"}" data-hl="${esc(h.id)}" ${clipAttr(h)}>
            <div class="hl-thumb" style="--map-bg:${mapColor(m.map)};${h.thumb ? `background-image:url('${assetUrl(h.thumb)}')` : ""}">
              ${h.clip ? `<span class="play">▶</span>` : `<span class="state">${h.render_error ? esc(h.render_error) : "Rendering…"}</span>`}
              <span class="dur">${fmtClip(h.duration_s)}</span>
            </div>
            <div class="hl-info">
              <div class="hl-title">${esc(h.title)}</div>
              <div class="hl-meta"><span>${esc(h.name || "")}</span><span>${esc(mapName(m.map))} · round ${h.round}</span></div>
              <div class="tags">${h.tags.map((t) => tagHtml(t)).join("")}</div>
            </div>
          </div>`).join("")}
        </div>
      </div>`).join("")}`;
  body.querySelectorAll("[data-hl]").forEach((c) => (c.onclick = () => {
    const i = state.playlist.findIndex((h) => h.id === c.dataset.hl);
    if (i >= 0) play(i);
  }));
}

// ---- volume -----------------------------------------------------------------------------------------

const SPEAKER = {
  off: `<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M3 9v6h4l5 5V4L7 9H3z"/><path d="M16 9l5 6M21 9l-5 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  on: `<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M3 9v6h4l5 5V4L7 9H3z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
};

// One volume for every clip in the app (the clip player, the whiff analyzer, unmuted previews),
// remembered. Starts at half: clips are loud.
const clipVolume = { level: 0.5, muted: false };
try { Object.assign(clipVolume, JSON.parse(localStorage.getItem("veloxify.clipVolume") || "{}")); } catch (e) { /* defaults */ }
const saveVolume = () => { try { localStorage.setItem("veloxify.clipVolume", JSON.stringify(clipVolume)); } catch (e) { /* not remembered */ } };
const applyVolume = (v) => { v.volume = clipVolume.level; v.muted = clipVolume.muted; };
const volumeControlHtml = (id) => `<div class="vol" id="${id}"><button class="vol-btn" title="Mute"></button><input type="range" min="0" max="1" step="0.05" aria-label="Volume"></div>`;
function wireVolume(el, video) {
  if (!el || !video) return;
  const btn = el.querySelector("button"), range = el.querySelector("input");
  const paint = () => {
    const silent = clipVolume.muted || clipVolume.level === 0;
    btn.innerHTML = silent ? SPEAKER.off : SPEAKER.on;
    btn.title = silent ? "Unmute" : "Mute";
    range.value = clipVolume.muted ? 0 : clipVolume.level;
  };
  applyVolume(video);
  paint();
  btn.onclick = () => {
    clipVolume.muted = !clipVolume.muted;
    if (!clipVolume.muted && clipVolume.level === 0) clipVolume.level = 0.5;
    applyVolume(video); saveVolume(); paint();
  };
  range.oninput = () => {
    clipVolume.level = Number(range.value);
    clipVolume.muted = clipVolume.level === 0;
    applyVolume(video); saveVolume(); paint();
  };
}
// The clip player's own controls change the same volume.
{
  const pv = document.getElementById("player-video");
  applyVolume(pv);
  pv.addEventListener("volumechange", () => { clipVolume.level = pv.volume; clipVolume.muted = pv.muted; saveVolume(); });
}

// ---- hover previews (like YouTube thumbnails) ------------------------------------------------------

// Hovering a highlight plays it in place; muted unless you unmute it (remembered).
const clipAttr = (h) => (h.clip ? `data-clip="${esc(h.clip)}"` : "");
let previewMuted = true;
try { previewMuted = localStorage.getItem("veloxify.previewMuted") !== "0"; } catch (e) { /* default: muted */ }
let previewTimer = null;

function startPreview(card) {
  if (!card.matches(":hover") || card.querySelector(".hl-preview")) return;
  const thumb = card.querySelector(".hl-thumb");
  if (!thumb) return;
  const v = document.createElement("video");
  v.className = "hl-preview";
  Object.assign(v, { src: assetUrl(card.dataset.clip), muted: previewMuted, loop: true, playsInline: true, preload: "auto", volume: clipVolume.level });
  const mute = document.createElement("button");
  mute.className = "hl-mute";
  const paint = () => { mute.innerHTML = previewMuted ? SPEAKER.off : SPEAKER.on; mute.title = previewMuted ? "Unmute previews" : "Mute previews"; };
  paint();
  mute.onclick = (e) => {
    e.stopPropagation(); // not a click on the card (that opens the player)
    previewMuted = !previewMuted;
    v.muted = previewMuted;
    try { localStorage.setItem("veloxify.previewMuted", previewMuted ? "1" : "0"); } catch (err) { /* not remembered */ }
    paint();
  };
  thumb.classList.add("previewing");
  thumb.append(v, mute);
  v.play().catch(() => { v.muted = true; v.play().catch(() => {}); }); // sound may need a click first
}
function stopPreview(card) {
  card.querySelector(".hl-thumb")?.classList.remove("previewing");
  card.querySelectorAll(".hl-preview, .hl-mute").forEach((el) => {
    if (el.tagName === "VIDEO") { el.pause(); el.removeAttribute("src"); el.load(); }
    el.remove();
  });
}
document.addEventListener("mouseover", (e) => {
  const card = e.target.closest?.(".hl-card[data-clip]");
  if (!card || card.querySelector(".hl-preview")) return;
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => startPreview(card), 300); // passing over a card doesn't start it
});
document.addEventListener("mouseout", (e) => {
  const card = e.target.closest?.(".hl-card[data-clip]");
  if (!card || card.contains(e.relatedTarget)) return;
  clearTimeout(previewTimer);
  stopPreview(card);
});
// Opening the player stops any preview.
document.addEventListener("click", (e) => { const card = e.target.closest?.(".hl-card[data-clip]"); if (card) stopPreview(card); }, true);

function setPlayerSpeed(s) {
  const v = document.getElementById("player-video");
  v.playbackRate = s;
  v.defaultPlaybackRate = s;
  document.querySelectorAll("#player-speeds [data-pspeed]").forEach((b) => b.classList.toggle("on", Number(b.dataset.pspeed) === s));
}
document.querySelectorAll("#player-speeds [data-pspeed]").forEach((b) => (b.onclick = () => setPlayerSpeed(Number(b.dataset.pspeed))));

function play(i) {
  const h = state.playlist[i];
  if (!h) return;
  state.playing = i;
  document.getElementById("player").hidden = false;
  document.getElementById("player-title").textContent = h.title;
  document.getElementById("player-sub").textContent = `${h.name} · ${mapName(h.match.map)} · round ${h.round}`;
  const v = document.getElementById("player-video");
  v.src = assetUrl(h.clip);
  applyVolume(v);
  // Lowlights open in slow motion (the speed you last chose in the whiff analyzer); highlights at 1x.
  setPlayerSpeed(h.kind && h.reason != null ? waSpeed : 1);
  v.play().catch(() => {});
}

function closePlayer() {
  const v = document.getElementById("player-video");
  v.pause(); v.removeAttribute("src"); v.load();
  document.getElementById("player").hidden = true;
}

// ---- profile ------------------------------------------------------------------------------------

const PROFILE_DEFAULTS = { last: 30, source: "all" };
let prof = { ...PROFILE_DEFAULTS };
try { prof = { ...PROFILE_DEFAULTS, ...JSON.parse(localStorage.getItem("veloxify.profile") || "{}") }; } catch (e) { /* defaults */ }
// FACEIT and Premier have their own sections now: everything else covers all your matches.
prof.source = "all";
const WIN = "#3aa58f", LOSS = "#e2445f"; // validated pair on the #161616 card (CVD-safe)

// Rating bands (HLTV-style scale, 1.00 = average).
const ratingWord = (r) => (r >= 1.2 ? "Great" : r >= 1.05 ? "Good" : r >= 0.95 ? "Average" : r >= 0.85 ? "Subpar" : "Poor");
const scoreWord = (x) => (x >= 75 ? "Great" : x >= 60 ? "Good" : x >= 40 ? "Average" : x >= 25 ? "Subpar" : "Poor");

function dial(value, frac, label, sub, size = 150, color = "", subClass = "") {
  const r = size / 2 - 10, c = 2 * Math.PI * r, f = Math.max(0, Math.min(1, frac));
  return `
    <div class="dial" style="width:${size}px">
      <svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="${esc(label)} ${esc(value)}">
        <circle cx="${size / 2}" cy="${size / 2}" r="${r}" class="dial-track"/>
        <circle cx="${size / 2}" cy="${size / 2}" r="${r}" class="dial-fill" ${color ? `style="stroke:${color}"` : ""} stroke-dasharray="${(c * f).toFixed(1)} ${c.toFixed(1)}"
          transform="rotate(-90 ${size / 2} ${size / 2})"/>
      </svg>
      <div class="dial-value" style="font-size:${size / 4.6}px">${value}</div>
      <div class="dial-label">${esc(label)}</div>
      ${sub ? `<div class="dial-sub ${subClass}">${esc(sub)}</div>` : ""}
    </div>`;
}

function formChart(form) {
  if (!form.length) return "";
  const w = 900, h = 170, pad = 28, n = form.length, gap = 2;
  form = form.map((f) => ({ ...f, rating2: f.rating3 || f.rating2 }));
  const max = Math.max(1.6, ...form.map((f) => f.rating2));
  const bw = (w - pad) / n - gap, y = (v) => h - 20 - (v / max) * (h - 34);
  const bars = form.map((f, i) => {
    const x = pad + i * (bw + gap), top = y(f.rating2), bh = h - 20 - top;
    const tip = `${mapName(f.map)} · ${relDay(f.played_at.slice(0, 10))} · ${f.result === "win" ? "W" : f.result === "loss" ? "L" : "T"} · HLTV 3.0 ${f2(f.rating2)} · ${f1(f.adr)} ADR`;
    return `<g class="bar" data-tip="${esc(tip)}" data-m="${esc(f.match_id)}">
      <rect class="hit" x="${x - gap / 2}" y="6" width="${bw + gap}" height="${h - 26}"/>
      <path d="M${x},${top + bh} v${-(bh - 4)} q0,-4 4,-4 h${bw - 8} q4,0 4,4 v${bh - 4} z" fill="${f.result === "win" ? WIN : LOSS}"/></g>`;
  }).join("");
  const ref = y(1);
  return `
    <div class="form-chart">
      <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Rating per match">
        ${bars}
        <line x1="${pad}" x2="${w}" y1="${ref}" y2="${ref}" class="ref"/>
        <text x="0" y="${ref + 4}" class="axis">1.00</text>
      </svg>
      <div class="tooltip" hidden></div>
    </div>`;
}

// Rating graphs on the profile (FACEIT ELO, Premier rating), oldest to newest: one dot per match,
// and on hover a card with that match (result, map, rating and swing from the demo, K/D/A, rating).
// Points: { value, delta, result, mine, theirs, map, ts, libId, kills, deaths, assists, adr }.
const rankCharts = {};
function rankChart(kind, list) {
  const ms = list.slice().reverse();
  if (ms.length < 2) return "";
  const lo = Math.min(...ms.map((m) => m.value)), hi = Math.max(...ms.map((m) => m.value)), span = Math.max(30, hi - lo);
  // Percent of the box: a little room at the edges so the end dots aren't cut.
  const x = (i) => 1.5 + (i * 97) / (ms.length - 1);
  const y = (e) => 10 + ((hi + (span - (hi - lo)) / 2 - e) / span) * 78;
  const pts = ms.map((m, i) => {
    const lib = state.byId?.get(m.libId);
    const line = lib && !lib.stats_only ? lib.line : null;
    return { m, x: x(i), y: y(m.value), rating: line ? r3(line) : null, swing: line ? line.swing || 0 : null };
  });
  rankCharts[kind] = pts;
  const line = pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
  return `
    <div class="elo-chart" data-kind="${kind}">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="${kind === "faceit" ? "FACEIT ELO" : "Premier rating"} over your last ${ms.length} matches">
        <defs><linearGradient id="fill-${kind}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" style="stop-color:var(--accent)" stop-opacity="0.3"/><stop offset="1" style="stop-color:var(--accent)" stop-opacity="0"/></linearGradient></defs>
        <path class="area" style="fill:url(#fill-${kind})" d="${line} L${pts[pts.length - 1].x.toFixed(2)},100 L${pts[0].x.toFixed(2)},100 Z"/>
        <path class="line" d="${line}" vector-effect="non-scaling-stroke"/>
      </svg>
      ${pts.map((p, i) => `<i class="elo-dot ${p.m.result}" data-i="${i}" style="left:${p.x.toFixed(2)}%;top:${p.y.toFixed(2)}%"></i>`).join("")}
      <div class="elo-tip" hidden></div>
    </div>`;
}

function rankTipHtml(kind, p) {
  const m = p.m, d = new Date(m.ts * 1000);
  const when = `${WEEKDAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const row = (label, v) => `<div class="et-row"><span>${label}</span><b>${v}</b></div>`;
  const delta = m.delta;
  const rank = kind === "faceit" ? `<span class="et-elo">${levelBadge(levelFor(m.value), 18)}${m.value.toLocaleString("en-US")}</span>` : premierChip(m.value);
  return `<div class="et-date">${esc(when.toUpperCase())}</div>
    <div class="et-res"><span class="wl ${m.result}">${m.result === "win" ? "W" : m.result === "loss" ? "L" : "T"}</span><b class="${m.result}">${m.mine}</b><span class="sub">:</span><span>${m.theirs}</span><span class="et-map">${mapIcon(m.map)}${esc(mapName(m.map))}</span></div>
    ${p.rating != null ? row("Rating 3.0", `<span class="rchip ${ratingClass(p.rating)}">${f2(p.rating)}<i style="width:${Math.min(100, (p.rating / 2) * 100)}%"></i></span>`) : ""}
    ${p.swing != null ? row("Swing", `<span class="${p.swing > 0 ? "up" : p.swing < 0 ? "down" : ""}">${fmtSwing(p.swing)}</span>`) : ""}
    ${row("K/D/A", `${m.kills} / ${m.deaths} / ${m.assists}`)}
    ${row("ADR", f1(m.adr || 0))}
    ${row(kind === "faceit" ? "ELO" : "Premier", rank)}
    ${delta != null ? row(kind === "faceit" ? "Elo change" : "Rating change", `<span class="${delta >= 0 ? "up" : "down"}">${delta >= 0 ? "↑" : "↓"} ${Math.abs(delta).toLocaleString("en-US")}</span>`) : ""}
    ${p.rating == null ? `<div class="et-note">Rating and swing come from the demo.</div>` : ""}`;
}

function wireRankCharts(root) {
  root.querySelectorAll(".elo-chart[data-kind]").forEach((el) => {
    const kind = el.dataset.kind, pts = rankCharts[kind];
    if (!pts?.length) return;
    const tip = el.querySelector(".elo-tip"), dots = [...el.querySelectorAll(".elo-dot")];
    let on = -1;
    const show = (i) => {
      if (i === on) return;
      on = i;
      dots.forEach((d, k) => d.classList.toggle("on", k === i));
      const p = pts[i];
      tip.innerHTML = rankTipHtml(kind, p);
      tip.hidden = false;
      // Beside the dot, on whichever side has room; never off the chart.
      const w = el.clientWidth, dx = (p.x / 100) * w, tw = tip.offsetWidth;
      tip.style.left = `${dx + 14 + tw <= w ? dx + 14 : Math.max(0, dx - 14 - tw)}px`;
      tip.style.top = `${Math.max(-8, Math.min((p.y / 100) * el.clientHeight - 40, el.clientHeight - tip.offsetHeight))}px`;
    };
    // The nearest match to the pointer, so the dots don't have to be hit exactly.
    el.addEventListener("mousemove", (e) => {
      const r = el.getBoundingClientRect(), vx = ((e.clientX - r.left) / r.width) * 100;
      let best = 0;
      pts.forEach((p, i) => { if (Math.abs(p.x - vx) < Math.abs(pts[best].x - vx)) best = i; });
      show(best);
    });
    el.addEventListener("mouseleave", () => { on = -1; tip.hidden = true; dots.forEach((d) => d.classList.remove("on")); });
    // A dot opens its match (when it's in the library).
    el.addEventListener("click", () => {
      const p = pts[on];
      if (p && state.byId?.has(p.m.libId)) location.hash = `#/match/${p.m.libId}`;
    });
  });
}

// The stats under a rating graph, over the same matches: rating 3.0 and swing (from demos), average
// K/D/A, K/D, ADR, HS% and win rate, then `extra` tiles.
function rankStats(list, extra = []) {
  const n = list.length || 1;
  const k = sum(list.map((m) => m.kills)), dth = sum(list.map((m) => m.deaths)), a = sum(list.map((m) => m.assists)), hs = sum(list.map((m) => m.hs || 0));
  const adr = sum(list.map((m) => m.adr || 0)) / n;
  const wins = list.filter((m) => m.result === "win").length;
  const lines = list.map((m) => state.byId?.get(m.libId)).filter((m) => m && !m.stats_only).map((m) => m.line);
  const rating = lines.length ? sum(lines.map((l) => r3(l))) / lines.length : null;
  const swing = lines.length ? sum(lines.map((l) => l.swing || 0)) / lines.length : null;
  return `<div class="fc-stats">
      ${rating != null ? `<div class="kpi" title="Average of the ${lines.length} of these matches whose demo is analyzed"><div class="v"><span class="rchip ${ratingClass(rating)}">${f2(rating)}<i style="width:${Math.min(100, (rating / 2) * 100)}%"></i></span></div><div class="l">Rating 3.0 · swing <span class="${swing > 0 ? "up" : swing < 0 ? "down" : ""}">${fmtSwing(swing)}</span></div></div>` : ""}
      <div class="kpi"><div class="v">${Math.round(k / n)} / ${Math.round(dth / n)} / ${Math.round(a / n)}</div><div class="l">K/D/A</div></div>
      <div class="kpi"><div class="v">${dth ? f2(k / dth) : "–"}</div><div class="l">K/D</div></div>
      <div class="kpi"><div class="v">${f1(adr)}</div><div class="l">ADR</div></div>
      <div class="kpi"><div class="v">${k ? Math.round((hs / k) * 100) : 0}%</div><div class="l">HS%</div></div>
      <div class="kpi"><div class="v">${Math.round((wins / n) * 100)}%</div><div class="l">Win rate</div></div>
      ${extra.map(([v, l]) => `<div class="kpi"><div class="v">${v}</div><div class="l">${l}</div></div>`).join("")}
    </div>`;
}

// Elo change on the left, wins and losses on the right, over the chart (as on FACEIT).
const rankHead = (label, change, wins, losses) => `
    <div class="fc-chart-head">
      <span class="sub">${label} <b class="${change >= 0 ? "up" : "down"}">${change >= 0 ? "+" : ""}${change.toLocaleString("en-US")}</b></span>
      <span class="fc-wl"><span class="wl win">W</span><b class="up">${wins}</b><span class="sub">/</span><span class="wl loss">L</span><b class="down">${losses}</b></span>
    </div>`;
const periodLabel = (n, shown) => (n ? `Last <b class="fc-n">${shown}</b> matches` : `All <b class="fc-n">${shown}</b> matches`);

// FACEIT, like FACEIT shows it: the matches with an ELO in the chosen period (league matches have
// none and aren't counted), the ELO change across them, wins and losses.
function faceitPanel(last) {
  const f = state.faceit;
  const head = (extra = "") => `<div class="panel-head"><div class="h3">FACEIT</div><span class="grow"></span>${extra}</div>`;
  if (!f) return `${head()}<div class="fc-msg">Looking up your FACEIT account. Veloxify finds it from your Steam account; there's nothing to connect.</div>`;
  if (!f.player_id) {
    return `${head()}<div class="fc-msg">No FACEIT account is linked to this Steam account. If you play FACEIT on a different account, add its nickname in <a class="link" href="#/settings">Settings</a>.</div>`;
  }
  const recent = f.matches.filter((m) => m.elo).slice(0, last || Infinity).map((m) => ({
    value: m.elo, delta: m.elo_delta, result: m.result, mine: m.score_mine, theirs: m.score_theirs, map: m.map, ts: m.started_ts || m.finished_ts,
    libId: faceitLibId(m), kills: m.kills, deaths: m.deaths, assists: m.assists, adr: m.adr, hs: m.headshots,
  }));
  const change = recent.length > 1 ? recent[0].value - recent[recent.length - 1].value : 0;
  const wins = recent.filter((m) => m.result === "win").length;
  const lobby = f.matches.filter((m) => m.elo && m.team_elo && m.enemy_elo).slice(0, last || Infinity).map((m) => (m.team_elo + m.enemy_elo) / 2);
  const avgElo = lobby.length ? Math.round(sum(lobby) / lobby.length) : 0;
  const L = f.lifetime || {};
  return `
    ${head(`<span class="sub">${periodLabel(last, recent.length)}${avgElo ? ` · <span class="fc-avg" title="Average ELO of everyone in these matches">${levelBadge(levelFor(avgElo), 18)}<b>${avgElo.toLocaleString("en-US")}</b> avg match ELO</span>` : ""}</span>`)}
    <div class="fc-summary">
      ${f.avatar ? `<img class="fc-avatar" src="${esc(f.avatar)}" alt="">` : ""}
      ${levelBadge(f.level, 46)}
      <div class="who"><span class="elo">${f.elo.toLocaleString("en-US")}</span><span class="sub">${esc(f.nickname)}${f.region ? ` · ${esc(f.region)}` : ""}</span></div>
    </div>
    ${rankHead("Elo change", change, wins, recent.length - wins)}
    ${rankChart("faceit", recent)}
    ${rankStats(recent, [[(L.matches || 0).toLocaleString("en-US"), "Lifetime matches"]])}`;
}

// Premier, the same way: your Premier matches (with a rating) in the chosen period.
function premierPanel(last) {
  const head = (extra = "") => `<div class="panel-head"><div class="h3">Premier</div><span class="grow"></span>${extra}</div>`;
  const all = (state.all || []).filter((m) => m.source === "valve" && m.premier).sort((a, b) => b.played_ts - a.played_ts);
  if (!all.length) {
    return `${head()}<div class="fc-msg">No Premier matches yet. After you play one, Veloxify downloads it from Valve once you close CS2.</div>`;
  }
  const recent = all.slice(0, last || Infinity).map((m) => {
    const l = m.line || {};
    return {
      value: m.premier, delta: m.premier_delta, result: m.result, mine: m.score_mine, theirs: m.score_theirs, map: m.map, ts: m.played_ts,
      libId: m.id, kills: l.kills || 0, deaths: l.deaths || 0, assists: l.assists || 0, adr: l.adr || 0, hs: ((l.hs_pct || 0) * (l.kills || 0)) / 100,
    };
  });
  const change = recent.length > 1 ? recent[0].value - recent[recent.length - 1].value : 0;
  const wins = recent.filter((m) => m.result === "win").length;
  const peak = Math.max(...all.map((m) => m.premier));
  return `
    ${head(`<span class="sub">${periodLabel(last, recent.length)}</span>`)}
    <div class="fc-summary big-chip">${premierChip(all[0].premier)}<div class="who"><span class="sub">as of ${esc(fmtDate(all[0].played_at.slice(0, 10)))}</span></div></div>
    ${rankHead("Rating change", change, wins, recent.length - wins)}
    ${recent.length > 1 ? rankChart("premier", recent) : `<div class="fc-msg">The graph starts after your second Premier match.</div>`}
    ${rankStats(recent, [[premierChip(peak), "Peak rating"]])}`;
}

function renderProfile(view) {
  const ps = state.index.profiles || [];
  const p = ps.find((x) => x.last === prof.last && x.source === "all") || ps.find((x) => x.source === "all") || ps[0];
  const seg = (key, opts) => `<div class="seg" data-pkey="${key}">${opts.map(([v, label]) =>
    `<button data-v="${v}" class="${String(prof[key]) === String(v) ? "on" : ""}">${label}</button>`).join("")}</div>`;
  if (!p) { view.innerHTML = `<div class="empty">No FACEIT or Premier matches yet.</div>`; return; }
  const d = p.derived, c = p.counts;
  const premier = state.index.premier;
  const top = (state.index.highlights || []).filter((h) => h.clip).sort((a, b) => b.hand - a.hand || b.score - a.score).slice(0, 4);
  const bars = p.components.map((k) => `
    <div class="skill" data-key="${k.key}">
      <div class="skill-row">
        <span class="skill-name">${esc(k.name)}${k.key === "aim" ? ' <span class="beta" title="Reaction time and crosshair placement are coming; for now Aim uses accuracy, head accuracy and headshot kills.">beta</span>' : ""}</span>
        <span class="skill-value">${k.key === "opening" || k.key === "clutch" ? esc(k.value) : Math.round(k.score)}</span>
      </div>
      <div class="skill-track" title="${esc(k.name)}: ${Math.round(k.score)} (50 = average player in your lobbies)">
        <div class="skill-fill" style="width:${k.score}%"></div><div class="skill-tick"></div>
      </div>
      <div class="skill-detail" hidden>
        <table class="sb mini"><thead><tr><th>Stat</th><th>You</th><th>Lobby avg</th></tr></thead>
        <tbody>${k.details.map(([l, y, a]) => `<tr><td>${esc(l)}</td><td>${esc(y)}</td><td>${esc(a)}</td></tr>`).join("")}</tbody></table>
      </div>
    </div>`).join("");

  view.innerHTML = `
    <div class="profile-head">
      <div class="profile-id">${avatarHtml(state.index.me, 64)}<div><div class="h2">Profile</div><div class="h1" style="display:flex;align-items:center;gap:10px">${esc(state.faceit?.nickname || state.index.me_name || "You")}${state.faceit?.level ? `<span class="rank-chip faceit" title="FACEIT level ${state.faceit.level} · ${(state.faceit.elo || 0).toLocaleString("en-US")} ELO">${levelBadge(state.faceit.level, 24)}<b>${(state.faceit.elo || 0).toLocaleString("en-US")}</b></span>` : ""}${premier ? premierChip(premier[0]) : ""}</div></div></div>
      <div class="profile-controls">${seg("last", [[10, "Last 10"], [30, "Last 30"], [50, "Last 50"], [0, "All time"]])}
        <a class="btn ghost" href="#/crosshairs" title="Every crosshair you've played with, and your favorites">${XH_ICON} Crosshairs</a></div>
    </div>
    <div class="profile-grid">
      <section class="panel skills">
        <div class="panel-head"><div class="h2">Data from ${p.last ? `last ${p.matches}` : `all ${p.matches}`} matches</div>
          <span class="sub grow" style="text-align:right">50 = average player in your lobbies ▏</span></div>
        <div class="skills-body">${bars}</div>
      </section>
      <section class="panel dials">
        <div class="dials-row">
          ${dial(f2(r3(d)), (r3(d) - 0.4) / 1.2, "HLTV Rating 3.0", ratingWord(r3(d)), 150, GRADE_COLORS[gradeOf("rating", r3(d))], ratingClass(r3(d)))}
          ${dial(f1(d.rws), d.rws / 20, "RWS", ["Great", "Good", "Average", "Below average", "Poor"][gradeOf("rws", d.rws)], 150, GRADE_COLORS[gradeOf("rws", d.rws)], gradeClass("rws", d.rws))}
          ${dial(`${Math.round(p.win_rate * 100)}%`, p.win_rate, "Win rate", `${p.wins}-${p.matches - p.wins}`, 150, GRADE_COLORS[gradeOf("win", p.win_rate)], gradeClass("win", p.win_rate))}
          <div class="side-dials">
            ${dial(f2(r3(p.t)), (r3(p.t) - 0.4) / 1.2, "T rating", "", 86, "var(--t)")}
            ${dial(f2(r3(p.ct)), (r3(p.ct) - 0.4) / 1.2, "CT rating", "", 86, "var(--ct)")}
            ${dial(fmtSwing(d.swing || 0), ((d.swing || 0) + 3) / 6, "Swing / round", "", 86, GRADE_COLORS[gradeOf("swing", d.swing || 0)])}
          </div>
        </div>
        <div class="stack">
          <div class="stack-labels"><span><b>${Math.round(p.solo * 100)}%</b> Solo</span><span><b>${Math.round(p.stack_2_4 * 100)}%</b> 2–4 stack</span><span><b>${Math.round(p.stack_5 * 100)}%</b> 5 stack</span></div>
          <div class="stack-bar"><i style="width:${p.solo * 100}%"></i><i style="width:${p.stack_2_4 * 100}%"></i><i style="width:${p.stack_5 * 100}%"></i></div>
        </div>
      </section>
    </div>
    <div class="profile-grid lower">
      <section class="panel faceit">${faceitPanel(prof.last)}</section>
      <section class="panel faceit premier">${premierPanel(prof.last)}</section>
    </div>
    <section class="panel tiles-wide">
      <div class="panel-head"><div class="h3">All your matches</div><span class="grow"></span><span class="sub">${p.last ? `last ${p.matches}` : `all ${p.matches}`}, FACEIT and Premier</span></div>
      <div class="tiles">
        ${[["K/D", f2(d.kd)], ["ADR", f1(d.adr)], ["KAST", `${f1(d.kast)}%`], ["HS%", `${Math.round(d.hs_pct)}%`],
          ["Swing / round", fmtSwing(d.swing || 0)], ["Accuracy", `${f1(d.accuracy)}%`], ["Entries", `${c.opening_kills}-${c.opening_deaths}`],
          ["Multi-kills", `${c.multikill_rounds.slice(2).reduce((a, b) => a + b, 0)}`]].map(([l, v]) =>
          `<div class="kpi"><div class="v">${v}</div><div class="l">${l}</div></div>`).join("")}
      </div>
    </section>
    <div id="my-ratings"></div>
    <div id="trends"></div>
    <section class="panel form">
      <div class="panel-head"><div class="h2">Form · HLTV Rating 3.0 per match</div><span class="grow"></span>
        <span class="legend"><i style="background:${WIN}"></i>Win <i style="background:${LOSS}"></i>Loss</span></div>
      ${formChart(p.form)}
    </section>
    ${top.length ? `<section class="profile-top"><div class="hero-head"><div class="h2">Top highlights</div><a class="btn ghost" href="#/clips/highlights">All highlights</a></div>
      <div class="hl-grid">${top.map((h) => cardHtml(h)).join("")}</div></section>` : ""}`;

  renderMyRatings(view.querySelector("#my-ratings"));
  renderTrends(view.querySelector("#trends"));
  view.querySelectorAll(".seg[data-pkey]").forEach((el) => el.querySelectorAll("button").forEach((b) => (b.onclick = () => {
    const k = el.dataset.pkey;
    prof[k] = k === "last" ? Number(b.dataset.v) : b.dataset.v;
    try { localStorage.setItem("veloxify.profile", JSON.stringify(prof)); } catch (e) { /* not persisted */ }
    renderProfile(view);
  })));
  wireRankCharts(view);
  view.querySelectorAll(".skill").forEach((el) => (el.onclick = () => { const det = el.querySelector(".skill-detail"); det.hidden = !det.hidden; }));
  const chart = view.querySelector(".form-chart");
  if (chart) {
    const tip = chart.querySelector(".tooltip");
    chart.querySelectorAll(".bar").forEach((b) => {
      b.addEventListener("mouseenter", () => { tip.textContent = b.dataset.tip; tip.hidden = false; b.classList.add("hover"); });
      b.addEventListener("mousemove", (e) => { const r = chart.getBoundingClientRect(); tip.style.left = `${e.clientX - r.left + 12}px`; tip.style.top = `${e.clientY - r.top - 30}px`; });
      b.addEventListener("mouseleave", () => { tip.hidden = true; b.classList.remove("hover"); });
      b.addEventListener("click", () => { const m = summaryOf(b.dataset.m); if (m) location.hash = matchHref(m.id); });
    });
  }
  view.querySelectorAll(".profile-top [data-hl]").forEach((c2) => (c2.onclick = () => {
    state.playlist = top.map(toPlayItem);
    play(state.playlist.findIndex((h) => h.id === c2.dataset.hl));
  }));
}

// ---- Grenades: every lineup across your demos ----------------------------------------------------

// lineups.json (each map's totals; built from every match's throws, the same lineup grouped and
// counted), each map's lineups (lineups/<map>.json, loaded when needed) and the videos made so far.
// Your names for map areas and lineups (callouts.json in the library): { maps: { de_ancient:
// { places: { Outside: "Elbow" }, names: { <lineup id>: "CT Instant Elbow Smoke" } } } }.
async function loadCallouts() {
  if (!state.callouts) {
    try { state.callouts = await (await fetch(assetUrl("callouts.json"), { cache: "no-store" })).json(); } catch (e) { state.callouts = null; }
    state.callouts = state.callouts && state.callouts.maps ? state.callouts : { maps: {} };
  }
  return state.callouts;
}
function mapCallouts(map) {
  const c = state.callouts || { maps: {} };
  const m = (c.maps[map] = c.maps[map] || {});
  // Your names for areas and lineups, your favorite lineups, and the ones you removed (misses).
  m.places = m.places || {};
  m.names = m.names || {};
  m.favorites = m.favorites || [];
  m.removed = m.removed || [];
  return m;
}
async function saveCallouts() {
  if (tauri) await tauri.core.invoke("save_callouts", { callouts: state.callouts });
}
// An area's name: yours, else the default (NA) callout, else CS2's own name spaced out.
const areaName = (d, map, place) => (place ? mapCallouts(map).places[place] || d.callouts?.[place] || placeName2(place) : "");
// Every lineup's name on a map: yours, else "CT Instant Elbow Smoke" / "T Window Smoke", with
// the spawn or where it's thrown from when two would read the same.
function lineupNames(d, map) {
  const KIND = { smoke: "Smoke", molotov: "Molotov", flash: "Flash", he: "HE" };
  const base = (l) => `${l.side} ${l.category === "instant" ? "Instant " : ""}${l.to_place ? `${areaName(d, map, l.to_place)} ` : ""}${KIND[l.kind] || "HE"}`;
  const seen = new Map();
  for (const l of d.lineups) seen.set(base(l), (seen.get(base(l)) || 0) + 1);
  const taken = new Map(), out = new Map(), mine = mapCallouts(map).names;
  for (const l of d.lineups) {
    let name = base(l);
    if (seen.get(name) > 1) name = l.category === "instant" && l.spawn ? `${name} · Spawn ${l.spawn}` : l.from_place ? `${name} from ${areaName(d, map, l.from_place)}` : name;
    const n = (taken.get(name) || 0) + 1;
    taken.set(name, n);
    out.set(l.id, mine[l.id] || (n > 1 ? `${name} #${n}` : name));
  }
  return out;
}

// Where players stand on a map (from Match insights), to spot grenades that land anywhere else.
async function loadStandGrid(map) {
  state.standGrids = state.standGrids || new Map();
  if (!state.standGrids.has(map)) {
    let g = null;
    try { g = await (await fetch(assetUrl(`insights/${map}.grid.json`), { cache: "no-store" })).json(); } catch (e) { /* not built yet */ }
    state.standGrids.set(map, g && g.matches >= 15 && g.grid?.w ? g.grid : null);
  }
  return state.standGrids.get(map);
}
// A smoke or molotov landing where nobody stands (a roof, a ledge): likely a miss.
function offGround(grid, l) {
  if (!grid || !["smoke", "molotov"].includes(l.kind)) return false;
  const cx = Math.floor((l.to[0] - grid.x0) / grid.cell), cy = Math.floor((l.to[1] - grid.y0) / grid.cell);
  for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) {
    const x = cx + dx, y = cy + dy;
    if (x >= 0 && y >= 0 && x < grid.w && y < grid.h && grid.data[y * grid.w + x] >= 0) return false;
  }
  return true;
}

async function loadMapLineups(map) {
  state.mapLineups = state.mapLineups || new Map();
  if (!state.mapLineups.has(map)) {
    let d = null;
    try { d = await (await fetch(assetUrl(`lineups/${map}.json`), { cache: "no-store" })).json(); } catch (e) { /* not built yet */ }
    state.mapLineups.set(map, d);
  }
  return state.mapLineups.get(map);
}
async function loadLineups(force = false) {
  if (!state.lineups || force) {
    try { state.lineups = await (await fetch(assetUrl("lineups.json"), { cache: "no-store" })).json(); } catch (e) { state.lineups = null; }
    if (force) state.mapLineups = new Map();
  }
  try {
    state.lineupClips = tauri ? await tauri.core.invoke("lineup_clips") : await (await fetch(assetUrl("lineup_clips.json"), { cache: "no-store" })).json();
  } catch (e) { state.lineupClips = state.lineupClips || {}; }
  return state.lineups;
}
const NADE_KINDS = [["smoke", "Smokes", "smokegrenade"], ["molotov", "Molotovs", "molotov"], ["flash", "Flashes", "flashbang"], ["he", "HEs", "hegrenade"]];
const grenades = { kinds: new Set(["smoke", "molotov", "flash", "he"]), category: "instant", side: "all", min: 2, spawn: null, videoOnly: false, favOnly: false, showRemoved: false, sel: null, zoom: 1, pan: [0, 0], map: null };
const placeName2 = (s) => (s || "").replace(/([a-z])([A-Z])/g, "$1 $2").replace("Bombsite", "Site ");
const lineupClip = (id) => state.lineupClips?.[id];
// A lineup's thumbnail: its video's frame (plays on hover) or a placeholder.
function lineupThumb(l, cls = "") {
  const c = lineupClip(l.id);
  if (c?.clip) return `<div class="hl-card gn-thumb ${cls}" data-clip="${esc(c.clip)}" data-lineup="${esc(l.id)}"><div class="hl-thumb" style="${c.thumb ? `background-image:url('${assetUrl(c.thumb)}')` : ""}"><span class="play">▶</span></div></div>`;
  return `<div class="gn-thumb none ${cls}" title="${c?.error ? esc(c.error) : "No video yet"}"><span>${c?.too_old ? "Old demos only" : c?.error ? "No video" : "No video yet"}</span></div>`;
}

async function renderGrenades(view, map) {
  const L = await loadLineups();
  if (!L || !Object.keys(L.maps || {}).length) {
    view.innerHTML = `<div class="empty">No grenade lineups yet. They're collected from your match demos as Veloxify analyzes them.</div>`;
    return;
  }
  if (map && L.maps[map]) {
    const [d, , stand] = await Promise.all([loadMapLineups(map), loadCallouts(), loadStandGrid(map)]);
    if (d) { d.stand = stand; return renderGrenadeMap(view, d, map); }
  }
  // Every map: its picture, how many lineups of each grenade, videos ready.
  const maps = Object.entries(L.maps).map(([m, d]) => ({ m, d, total: Object.values(d.counts).reduce((a, b) => a + b, 0) })).sort((a, b) => b.total - a.total);
  const videosOn = (m) => Object.entries(state.lineupClips || {}).filter(([id, c]) => id.startsWith(`${m}-`) && c.clip).length;
  view.innerHTML = `
    <div class="gn-head"><div><div class="h1">Lineups</div><div class="sub">Instant smokes from spawn and set lineups thrown in your matches, each counted once however often it was thrown, most thrown first. Grenades thrown on the move aren't lineups and aren't listed. Pick a map.</div></div></div>
    <div class="gn-maps">${maps.map(({ m, d, total }) => {
      const videos = videosOn(m);
      return `<a class="gn-map" href="#/grenades/${esc(m)}">
        <div class="gn-map-pic" style="background-image:url('${assetUrl(`mapshots/${m}.png`)}')"><div class="gn-map-name">${mapIcon(m)}<b>${esc(mapName(m))}</b></div></div>
        <div class="gn-map-counts">${NADE_KINDS.map(([k, , icon]) => `<span title="${esc(k)} lineups">${weaponIcon(icon)}<b>${d.counts[k] || 0}</b></span>`).join("")}</div>
        <div class="gn-map-foot"><span>${d.instant || 0} instant smokes</span><span>${total - (d.instant || 0)} set lineups</span><span>${videos} videos</span></div></a>`;
    }).join("")}</div>`;
}

function renderGrenadeMap(view, d, map) {
  if (grenades.map !== map) Object.assign(grenades, { map, sel: null, zoom: 1, pan: [0, 0] });
  // A map without instant smokes opens on its set lineups.
  if (grenades.category === "instant" && !d.lineups.some((l) => l.category === "instant")) grenades.category = "set";
  const instantView = grenades.category === "instant";
  const fromSpawn = (l) => !grenades.spawn || (l.category === "instant" && `${l.side}:${l.spawn}` === grenades.spawn);
  const mc = mapCallouts(map), isFav = (l) => mc.favorites.includes(l.id), isRemoved = (l) => mc.removed.includes(l.id);
  const nRemoved = d.lineups.filter(isRemoved).length;
  if (!nRemoved) grenades.showRemoved = false;
  const shown = d.lineups.filter((l) => l.category === grenades.category && (instantView || grenades.kinds.has(l.kind)) && fromSpawn(l)
    && (grenades.side === "all" || l.side === grenades.side) && l.count >= grenades.min && (!grenades.videoOnly || lineupClip(l.id)?.clip)
    && (!grenades.favOnly || isFav(l)) && isRemoved(l) === grenades.showRemoved);
  const sel = shown.find((l) => l.id === grenades.sel) || null;
  const names = lineupNames(d, map);
  const nm = (l) => names.get(l.id) || l.name;
  loadRadar(map).then((radar) => {
    const size = radar?.size || 1024;
    const at = (x, y) => (radar ? [(x - radar.pos_x) / radar.scale, (radar.pos_y - y) / radar.scale] : [0, 0]);
    const R = { smoke: 144, molotov: 120, flash: 40, he: 70 };
    const maxN = Math.max(1, ...shown.map((l) => l.count));
    const arcs = shown.map((l) => {
      // A flight picked up only near its end still starts at the throw spot.
      const flight = l.path?.length > 1 ? l.path : [[...l.to, 0]];
      const whole = Math.hypot(flight[0][0] - l.from[0], flight[0][1] - l.from[1]) < 150 ? flight : [l.from, ...flight];
      const pts = whole.map(([x, y]) => at(x, y));
      const [fx, fy] = at(l.from[0], l.from[1]), [tx, ty] = at(l.to[0], l.to[1]);
      const on = sel?.id === l.id, dim = sel && !on;
      const wdt = 1.2 + 2.2 * Math.sqrt(l.count / maxN);
      return `<g class="gn-ln ${l.kind} ${on ? "on" : ""} ${dim ? "dim" : ""}" data-gl="${esc(l.id)}">
        <polyline points="${pts.map((p) => p.join(",")).join(" ")}" class="gn-arc" style="stroke-width:${on ? 3.5 : wdt}"/>
        <circle cx="${tx}" cy="${ty}" r="${R[l.kind] / (radar?.scale || 5)}" class="gn-land"/>
        ${l.count > 1 ? `<text x="${tx}" y="${ty + 4}" text-anchor="middle" class="gn-count">${l.count}</text>` : ""}
        <title>${esc(nm(l))} · ${l.count}× · ${esc(areaName(d, map, l.from_place))} → ${esc(areaName(d, map, l.to_place))}</title></g>`;
    }).join("");
    // Where each is thrown from, on top of the arcs so it can be clicked too (a wider ring than it looks).
    const froms = shown.map((l) => {
      const [fx, fy] = at(l.from[0], l.from[1]);
      const on = sel?.id === l.id, dim = sel && !on;
      return `<g class="gn-from-g ${on ? "on" : ""} ${dim ? "dim" : ""}" data-gl="${esc(l.id)}"><circle cx="${fx}" cy="${fy}" r="12" class="gn-hit"/>
        <circle cx="${fx}" cy="${fy}" r="${on ? 8 : 5}" class="gn-from ${l.side === "T" ? "t" : "ct"}"/><title>${esc(nm(l))} · thrown from ${esc(areaName(d, map, l.from_place) || "here")}</title></g>`;
    }).join("");
    // Spawn spots that instant smokes are thrown from (the others would only be clutter).
    const spawns = grenades.category === "instant" || sel?.category === "instant" ? Object.entries(d.spawns || {}).flatMap(([side, list]) => (grenades.side === "all" || grenades.side === side ? list.map((p, i) => {
      const [x, y] = at(p[0], p[1]);
      const n = d.lineups.filter((l) => l.category === "instant" && l.side === side && l.spawn === i + 1).length;
      if (!n) return "";
      return `<g class="gn-spawn ${side === "T" ? "t" : "ct"} ${(sel?.spawn === i + 1 && sel?.side === side) || grenades.spawn === `${side}:${i + 1}` ? "on" : ""}" data-spawn="${side}:${i + 1}"><circle cx="${x}" cy="${y}" r="9"/><text x="${x}" y="${y + 3.5}" text-anchor="middle">${i + 1}</text>
        <title>${side} spawn ${i + 1}: ${n ? `${n} instant smoke${n === 1 ? "" : "s"} from here` : "no instant smokes from here yet"}</title></g>`;
    }) : [])).join("") : "";
    const svg = view.querySelector("#gn-svg");
    if (svg) svg.innerHTML = arcs + froms + spawns;
    if (svg) svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
    view.querySelectorAll("[data-gl]").forEach((g) => (g.onclick = () => { grenades.sel = g.dataset.gl; renderGrenadeMap(view, d, map); }));
    // A spawn spot: its instant smokes (the most thrown one open).
    view.querySelectorAll("[data-spawn]").forEach((g) => (g.onclick = () => {
      const key = g.dataset.spawn;
      grenades.spawn = grenades.spawn === key ? null : key;
      grenades.category = "instant";
      const top = d.lineups.filter((l) => l.category === "instant" && `${l.side}:${l.spawn}` === key).sort((a, b) => b.count - a.count)[0];
      grenades.sel = grenades.spawn && top ? top.id : null;
      renderGrenadeMap(view, d, map);
    }));
  });

  const tagList = (l) => Object.entries(l.tags || {}).sort((a, b) => b[1] - a[1]);
  const setpos = sel ? `setpos ${sel.from[0].toFixed(2)} ${sel.from[1].toFixed(2)} ${sel.from[2].toFixed(2)};setang ${sel.pitch.toFixed(2)} ${sel.yaw.toFixed(2)} 0` : "";
  const clip = sel ? lineupClip(sel.id) : null;
  const counts = Object.fromEntries(NADE_KINDS.map(([k]) => [k, d.lineups.filter((l) => l.kind === k && l.category === "set").length]));
  const nInstant = d.lineups.filter((l) => l.category === "instant").length;
  const kindIcon = (k) => weaponIcon(NADE_KINDS.find((x) => x[0] === k)?.[2] || "smokegrenade");
  const sub = (l) => `${esc(areaName(d, map, l.from_place) || "?")} → ${esc(areaName(d, map, l.to_place) || "?")}`;
  view.innerHTML = `
    <a class="day-back" href="#/grenades">◀ All maps</a>
    <div class="gn-maphead" style="--shot:url('${assetUrl(`mapshots/${map}.png`)}')">${mapIcon(map)}<div><div class="h1">${esc(mapName(map))} lineups</div>
      <div class="sub">${nInstant} instant smoke${nInstant === 1 ? "" : "s"} and ${d.lineups.length - nInstant} set lineup${d.lineups.length - nInstant === 1 ? "" : "s"} from ${d.matches} match${d.matches === 1 ? "" : "es"}</div></div></div>
    <div class="ln-bar">
      <div class="seg" id="gn-cat">${[["instant", `Instant smokes <span class="sub">${nInstant}</span>`], ["set", `Set lineups <span class="sub">${d.lineups.length - nInstant}</span>`]].map(([k, l]) => `<button data-cat="${k}" class="${grenades.category === k ? "on" : ""}">${l}</button>`).join("")}</div>
      ${instantView ? "" : `<div class="chips">${NADE_KINDS.map(([k, label, icon]) => `<button class="chip ${grenades.kinds.has(k) ? "on" : ""}" data-kind="${k}">${weaponIcon(icon)} ${label} <span class="sub">${counts[k]}</span></button>`).join("")}</div>`}
      <div class="seg" id="gn-side">${[["all", "Both"], ["T", "T"], ["CT", "CT"]].map(([k, l]) => `<button data-side="${k}" class="${grenades.side === k ? "on" : ""}">${l}</button>`).join("")}</div>
      <label class="gn-min">Thrown at least <select id="gn-min">${[2, 3, 5, 10].map((n) => `<option value="${n}" ${grenades.min === n ? "selected" : ""}>${n}×</option>`).join("")}</select></label>
      ${grenades.spawn ? `<button class="chip on" id="gn-spawn-clear" title="Show every spawn">${esc(grenades.spawn.replace(":", " spawn "))} ✕</button>` : ""}
      <label class="gn-min"><input type="checkbox" id="gn-vid" ${grenades.videoOnly ? "checked" : ""}> Only with video</label>
      <button class="chip ${grenades.favOnly ? "on" : ""}" id="gn-fav-only" title="Only your favorite lineups">${ICONS.star} Favorites <span class="sub">${mc.favorites.filter((id) => d.lineups.some((l) => l.id === id)).length}</span></button>
      ${nRemoved ? `<button class="chip ${grenades.showRemoved ? "on" : ""}" id="gn-removed" title="Lineups you removed; open one to put it back">Removed <span class="sub">${nRemoved}</span></button>` : ""}
      ${tauri ? `<button class="btn ghost" id="gn-callouts">${grenades.calloutsOpen ? "Done" : "Callouts"}</button>` : ""}
    </div>
    ${grenades.calloutsOpen ? `<section class="panel gn-callouts"><div class="panel-head"><div class="h3">${esc(mapName(map))} callouts</div><span class="grow"></span><span class="sub">Rename an area and every lineup thrown from or landing there uses your name</span></div>
      <div class="gn-callout-list">${Object.keys(d.callouts || {}).sort().map((place) => `<label class="gn-callout"><span class="sub">${esc(placeName2(place))}</span><input data-place="${esc(place)}" value="${esc(areaName(d, map, place))}" maxlength="40"></label>`).join("")}</div></section>` : ""}
    <div class="gn-main">
      <section class="tl-map"><div class="tl-viewport"><div class="tl-canvas" style="transform:translate(${grenades.pan[0]}px,${grenades.pan[1]}px) scale(${grenades.zoom})">
        <img src="${assetUrl(`radars/${map}.png`)}" alt="${esc(mapName(map))} radar" draggable="false"><svg id="gn-svg" viewBox="0 0 1024 1024"></svg></div></div>
        <input class="tl-zoom" type="range" min="1" max="3" step="0.1" value="${grenades.zoom}" aria-label="Zoom" orient="vertical"></section>
      <section class="gn-side">
        ${sel ? `<div class="gn-detail">
          <div class="gn-video">${clip?.clip ? `<video id="gn-video" src="${assetUrl(clip.clip)}" controls autoplay muted loop playsinline></video>`
            : clip?.too_old ? `<div class="gn-novideo"><b>No video</b><span>Every time this was thrown, it was in a demo from before a CS2 update, and CS2 can't play those demos any more. It gets a video the next time it's thrown in one of your matches.</span></div>`
            : `<div class="gn-novideo">${clip?.error ? `<b>No video</b><span>${esc(clip.error)}</span>` : `<b>No video yet</b><span>${esc(lineupWaitText(sel.count))}</span>`}${tauri ? `<button class="btn primary" id="gn-render">Film this lineup now</button>` : ""}</div>`}</div>
          <div class="gn-title">${kindIcon(sel.kind)}${grenades.renaming ? `<input class="gn-rename-in" id="gn-rename-in" value="${esc(nm(sel))}" maxlength="60" aria-label="Lineup name">` : `<b>${esc(nm(sel))}</b>`}${sel.spawn ? `<span class="gn-spawnchip">Spawn #${sel.spawn}</span>` : ""}<span class="gn-x">×${sel.count}</span>
            ${tauri ? `<button class="btn ghost small gn-star ${isFav(sel) ? "on" : ""}" id="gn-fav" title="${isFav(sel) ? "Remove from favorites" : "Add to favorites"}">${ICONS.star}</button>` : ""}
            ${tauri ? `<button class="btn ghost small" id="gn-rename">${grenades.renaming ? "Save" : "Rename"}</button>${mapCallouts(map).names[sel.id] && !grenades.renaming ? `<button class="btn ghost small" id="gn-rename-reset" title="Back to the automatic name">Reset</button>` : ""}` : ""}</div>
          <div class="sub">${sub(sel)} · ${sel.side} · thrown ${sel.count} time${sel.count === 1 ? "" : "s"} in ${sel.matches} match${sel.matches === 1 ? "" : "es"} by ${sel.throwers} player${sel.throwers === 1 ? "" : "s"} · about ${Math.round(sel.t)} seconds into the round</div>
          <div class="gn-tags">${tagList(sel).map(([t, n]) => `<span class="tag ${t === sel.technique ? "main" : ""}">${esc(t)}${n < sel.count ? ` ${n}×` : ""}</span>`).join("")}<span class="tag">${esc(({ left: "Left click", right: "Right click", both: "Left + right click" })[sel.click] || sel.click)}</span></div>
          ${offGround(d.stand, sel) ? `<div class="note gn-miss-note">This lands where no player ever stands in your matches (a roof or a ledge), so it's probably a miss. If it is, press Remove below.</div>` : ""}
          ${sel.aim_count ? `<div class="sub gn-aim">Most common crosshair placement: <b>${sel.aim_count} of ${sel.count}</b> throws${sel.other_aims ? ` · ${sel.other_aims} other placement${sel.other_aims === 1 ? "" : "s"} seen` : ""}. The aim below, and the video, are that one.</div>` : ""}
          <div class="ln-cmd"><code>${esc(setpos)}</code><button class="btn" id="gn-copy">Copy</button></div>
          <div class="sub">Paste in the console on a practice server (sv_cheats 1) to stand and aim exactly like this.</div>
          <div class="gn-ex"><div class="h3">Thrown by</div>${sel.examples.map((e) => `<a href="${matchHref(e.match_id, "lineups")}">${esc(e.name || "someone")} · round ${e.round}</a>`).join("")}</div>
          <div class="gn-detail-foot"><button class="btn ghost" id="gn-back">◀ All lineups</button>
            ${tauri ? `<button class="btn ghost" id="gn-remove" title="${isRemoved(sel) ? "Show it in the list again" : "Hide a lineup that's really a miss (or one you don't want); you can put it back"}">${isRemoved(sel) ? "Put back" : "Remove"}</button>` : ""}</div></div>` : ""}
        <div class="gn-list">${shown.map((l) => `<button class="gn-item ${sel?.id === l.id ? "on" : ""}" data-gl="${esc(l.id)}">
          ${lineupThumb(l)}
          <div class="gn-item-body"><div class="gn-item-title">${kindIcon(l.kind)}${isFav(l) ? `<span class="gn-fav-mark" title="Favorite">${ICONS.star}</span>` : ""}<b>${esc(nm(l))}</b>${offGround(d.stand, l) ? `<span class="tag gn-miss" title="It lands where no player ever stands (a roof or a ledge): probably a miss. Open it and press Remove if so.">Maybe a miss</span>` : ""}${l.spawn ? `<span class="gn-spawnchip">Spawn #${l.spawn}</span>` : ""}<span class="gn-x">×${l.count}</span></div>
            <div class="sub">${sub(l)} · ${l.side}</div><div class="gn-item-tag">${esc(l.technique)}</div></div></button>`).join("") || `<div class="empty small">No lineups with these filters.</div>`}</div>
      </section>
    </div>
    ${d.misses ? `<div class="note">${d.misses} throw${d.misses === 1 ? "" : "s"} that missed (landed off the map, or somewhere a lineup from that spot rarely lands) ${d.misses === 1 ? "is" : "are"} left out.</div>` : ""}
    <div class="note">Instant smokes: smokes thrown in the first two seconds of the round from where the thrower spawned; spawn numbers are the spawn spots on that side of the map. Set lineups: lined up first (standing still with the crosshair held, or a run from a standstill into a jump throw), then thrown. A lineup counts when it was thrown at least twice from the same spot to the same place, whoever threw it.</div>`;

  const rerender = () => renderGrenadeMap(view, d, map);
  view.querySelectorAll("[data-kind]").forEach((b) => (b.onclick = () => { const k = b.dataset.kind; if (grenades.kinds.has(k)) grenades.kinds.delete(k); else grenades.kinds.add(k); grenades.sel = null; rerender(); }));
  view.querySelectorAll("[data-cat]").forEach((b) => (b.onclick = () => { grenades.category = b.dataset.cat; grenades.spawn = null; grenades.sel = null; rerender(); }));
  view.querySelectorAll("[data-side]").forEach((b) => (b.onclick = () => { grenades.side = b.dataset.side; grenades.spawn = null; grenades.sel = null; rerender(); }));
  view.querySelector("#gn-spawn-clear")?.addEventListener("click", () => { grenades.spawn = null; grenades.sel = null; rerender(); });
  view.querySelector("#gn-min").onchange = (e) => { grenades.min = Number(e.target.value); grenades.sel = null; rerender(); };
  view.querySelector("#gn-vid").onchange = (e) => { grenades.videoOnly = e.target.checked; grenades.sel = null; rerender(); };
  view.querySelector("#gn-callouts")?.addEventListener("click", () => { grenades.calloutsOpen = !grenades.calloutsOpen; rerender(); });
  view.querySelector("#gn-fav-only").onclick = () => { grenades.favOnly = !grenades.favOnly; grenades.sel = null; rerender(); };
  view.querySelector("#gn-removed")?.addEventListener("click", () => { grenades.showRemoved = !grenades.showRemoved; grenades.sel = null; rerender(); });
  view.querySelector("#gn-fav")?.addEventListener("click", async () => {
    mc.favorites = isFav(sel) ? mc.favorites.filter((id) => id !== sel.id) : [...mc.favorites, sel.id];
    await saveCallouts();
    rerender();
  });
  view.querySelector("#gn-remove")?.addEventListener("click", async () => {
    mc.removed = isRemoved(sel) ? mc.removed.filter((id) => id !== sel.id) : [...mc.removed, sel.id];
    grenades.sel = null;
    await saveCallouts();
    rerender();
  });
  view.querySelectorAll("[data-place]").forEach((i) => (i.onchange = async () => {
    const v = i.value.trim(), place = i.dataset.place, places = mapCallouts(map).places;
    if (!v || v === (d.callouts?.[place] || placeName2(place))) delete places[place]; else places[place] = v;
    await saveCallouts();
    rerender();
  }));
  const saveName = async () => {
    const input = view.querySelector("#gn-rename-in");
    const v = input?.value.trim(), mine = mapCallouts(map).names;
    grenades.renaming = false;
    if (v) mine[sel.id] = v; else delete mine[sel.id];
    await saveCallouts();
    rerender();
  };
  view.querySelector("#gn-rename")?.addEventListener("click", () => { if (grenades.renaming) saveName(); else { grenades.renaming = true; rerender(); view.querySelector("#gn-rename-in")?.select(); } });
  view.querySelector("#gn-rename-in")?.addEventListener("keydown", (e) => { if (e.key === "Enter") saveName(); if (e.key === "Escape") { grenades.renaming = false; rerender(); } });
  view.querySelector("#gn-rename-reset")?.addEventListener("click", async () => { delete mapCallouts(map).names[sel.id]; await saveCallouts(); rerender(); });
  view.querySelectorAll(".gn-item[data-gl]").forEach((b) => (b.onclick = (e) => { if (e.target.closest(".hl-card")) return; grenades.sel = b.dataset.gl; rerender(); }));
  view.querySelectorAll(".gn-item .hl-card").forEach((c) => (c.onclick = (e) => { e.stopPropagation(); grenades.sel = c.dataset.lineup; rerender(); }));
  // Pointing at a lineup in the list lights it up on the map (and fades the rest).
  const svgEl = view.querySelector("#gn-svg");
  const light = (id) => {
    if (!svgEl) return;
    svgEl.classList.toggle("hovering", !!id);
    svgEl.querySelectorAll("[data-gl]").forEach((g) => {
      g.classList.toggle("hl", g.dataset.gl === id);
      // On top of the others, so nothing covers it.
      if (g.dataset.gl === id) g.parentNode.appendChild(g);
    });
  };
  view.querySelectorAll(".gn-item[data-gl]").forEach((b) => {
    b.addEventListener("mouseenter", () => light(b.dataset.gl));
    b.addEventListener("mouseleave", () => light(null));
  });
  view.querySelector("#gn-back")?.addEventListener("click", () => { grenades.sel = null; rerender(); });
  view.querySelector("#gn-copy")?.addEventListener("click", (e) => { navigator.clipboard?.writeText(setpos); e.target.textContent = "Copied"; });
  view.querySelector("#gn-render")?.addEventListener("click", async (e) => { e.target.disabled = true; e.target.textContent = "Queued: it films when CS2 is closed"; await tauri.core.invoke("render_lineups", { ids: [sel.id] }); });
  const v = view.querySelector("#gn-video");
  if (v) applyVolume(v), (v.muted = true);
  const canvas = view.querySelector(".tl-canvas"), zoom = view.querySelector(".tl-zoom"), vp = view.querySelector(".tl-viewport");
  const apply = () => { canvas.style.transform = `translate(${grenades.pan[0]}px,${grenades.pan[1]}px) scale(${grenades.zoom})`; zoom.value = grenades.zoom; };
  zoom.oninput = () => { grenades.zoom = Number(zoom.value); if (grenades.zoom === 1) grenades.pan = [0, 0]; apply(); };
  vp.onwheel = (e) => { e.preventDefault(); grenades.zoom = Math.max(1, Math.min(3, grenades.zoom - Math.sign(e.deltaY) * 0.2)); if (grenades.zoom === 1) grenades.pan = [0, 0]; apply(); };
  vp.onpointerdown = (e) => {
    if (grenades.zoom === 1 || e.target.closest("[data-gl],[data-spawn]")) return;
    const start = [e.clientX - grenades.pan[0], e.clientY - grenades.pan[1]];
    vp.setPointerCapture(e.pointerId);
    vp.onpointermove = (ev) => { grenades.pan = [ev.clientX - start[0], ev.clientY - start[1]]; apply(); };
    vp.onpointerup = () => { vp.onpointermove = null; };
  };
  // Videos appear as Veloxify films them.
  clearTimeout(state.lineupTimer);
  state.lineupTimer = setTimeout(async () => {
    if (!document.body.contains(view.querySelector(".gn-main"))) return;
    const before = JSON.stringify(state.lineupClips || {});
    await loadLineups();
    if (JSON.stringify(state.lineupClips || {}) !== before && document.getElementById("player").hidden && !view.querySelector("#gn-video:not([paused])")) rerender();
  }, 15000);
}

// ---- crosshairs -------------------------------------------------------------------------------------

// Every crosshair seen in your matches (crosshairs.json, written as demos are read): each match's
// players' codes, and each code read into CS2's pixel crosshair with the code CS2 imports today.
async function loadCrosshairs(force = false) {
  if (!state.xh || force) {
    try { state.xh = await (await fetch(assetUrl("crosshairs.json"), { cache: "no-store" })).json(); } catch (e) { state.xh = null; }
    state.xh = state.xh && state.xh.codes ? state.xh : { matches: {}, codes: {} };
    try { state.xhFav = await (await fetch(assetUrl("crosshair_favorites.json"), { cache: "no-store" })).json(); } catch (e) { state.xhFav = null; }
    if (!Array.isArray(state.xhFav)) state.xhFav = [];
  }
  return state.xh;
}
const xhOf = (code) => state.xh?.codes?.[code] || null;
const xhFav = (code) => state.xhFav?.find((f) => f.code === code);
async function saveXhFav() {
  if (tauri) await tauri.core.invoke("save_crosshair_favorites", { favorites: state.xhFav });
}
const XH_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 3v6M12 15v6M3 12h6M15 12h6"/></svg>`;
const XH_STYLES = ["Dynamic cross", "Dynamic circle", "Dynamic cross (legacy)", "Static circle", "Static cross", "Static cross (shot feedback)", "Dot only", "Dynamic quad", "Static square", "Static quad"];

// The crosshair as it looks on a 1080p screen (`zoom` times bigger), centred in a `size` box.
function xhSvg(c, size = 40, zoom = 1) {
  if (!c) return `<svg class="xh-svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true"><text x="50%" y="58%" text-anchor="middle" class="xh-none">?</text></svg>`;
  // Sizes are pixels at the code's screen height; CS2 scales them to the real one.
  const k = 1080 / (c.screen_height || 1080);
  const px = (v) => Math.round(v * k);
  const L = px(c.length) * zoom, T = Math.max(1, px(c.thickness)) * zoom, inner = (px(c.gap) / 2) * zoom;
  const fill = `rgba(${c.color[0]},${c.color[1]},${c.color[2]},${(c.color[3] / 255).toFixed(2)})`;
  const oc = c.outline_color || [0, 0, 0, 255];
  const line = `rgba(${oc[0]},${oc[1]},${oc[2]},${((oc[3] / 255) * (c.outline === 2 ? 0.5 : 1)).toFixed(2)})`;
  const o = c.outline ? zoom : 0;
  const cx = size / 2, cy = size / 2;
  const rects = [], strokes = [];
  const style = c.style;
  if (style === 1 || style === 3) {
    strokes.push([inner + L / 2, T]);
  } else if (style === 8) {
    const h = inner + L / 2;
    rects.push([cx - h - T / 2, cy - h - T / 2, 2 * h + T, T], [cx - h - T / 2, cy + h - T / 2, 2 * h + T, T], [cx - h - T / 2, cy - h - T / 2, T, 2 * h + T], [cx + h - T / 2, cy - h - T / 2, T, 2 * h + T]);
  } else if (style !== 6) {
    rects.push([cx + inner, cy - T / 2, L, T], [cx - inner - L, cy - T / 2, L, T], [cx - T / 2, cy + inner, T, L]);
    if (!c.t_style) rects.push([cx - T / 2, cy - inner - L, T, L]);
  }
  // Quad (7 dynamic, 9 static): the four lines turned 45 degrees, an X.
  const quad = style === 7 || style === 9;
  const lines = rects.length;
  if (c.dot || style === 6) rects.push([cx - T / 2, cy - T / 2, T, T]);
  const r = (x, y, w, h, f) => `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="${f}"/>`;
  const turn = (html) => (quad ? `<g transform="rotate(45 ${cx} ${cy})">${html}</g>` : html);
  const outline = (list) => list.map(([x, y, w, h]) => r(x - o, y - o, w + 2 * o, h + 2 * o, line)).join("");
  const outlines = o ? turn(outline(rects.slice(0, lines))) + outline(rects.slice(lines)) + strokes.map(([rad, w]) => `<circle cx="${cx}" cy="${cy}" r="${rad}" fill="none" stroke="${line}" stroke-width="${w + 2 * o}"/>`).join("") : "";
  const fills = (list) => list.map(([x, y, w, h]) => r(x, y, w, h, fill)).join("");
  return `<svg class="xh-svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" shape-rendering="${quad ? "geometricPrecision" : "crispEdges"}" aria-hidden="true">${outlines}
    ${turn(fills(rects.slice(0, lines)))}${fills(rects.slice(lines))}${strokes.map(([rad, w]) => `<circle cx="${cx}" cy="${cy}" r="${rad}" fill="none" stroke="${fill}" stroke-width="${w}"/>`).join("")}</svg>`;
}

// The scoreboard's crosshair cell: the preview (opens the crosshair) and a copy button.
function xhCell(code, who) {
  if (!code) return `<td class="xh-cell"><span class="sub" title="Not read yet: Veloxify re-reads this match's demo in the background">—</span></td>`;
  const c = xhOf(code);
  return `<td class="xh-cell"><button class="xh-prev" data-xh="${esc(code)}" data-xh-who="${esc(who)}" title="${esc(who)}'s crosshair (2× size): click for more">${xhSvg(c, 34, 2)}</button>
    <button class="xh-copy" data-xh-copy="${esc(c?.cs2 || code)}" title="Copy the code (CS2: Settings > Crosshair > Import)">Copy</button></td>`;
}

async function copyXh(code, btn) {
  try { await navigator.clipboard.writeText(code); } catch (e) { /* the button says so */ }
  if (btn) { const t = btn.textContent; btn.textContent = "Copied"; setTimeout(() => (btn.textContent = t), 1400); }
}

async function recordingCrosshair() {
  if (!tauri) return "";
  if (!settingsData) settingsData = await tauri.core.invoke("get_settings");
  return settingsData.render.own_crosshair ? "own" : settingsData.render.crosshair || "";
}
async function useInRecordings(code) {
  if (!tauri) return;
  if (!settingsData) settingsData = await tauri.core.invoke("get_settings");
  settingsData.render.crosshair = code === "own" ? "" : code;
  settingsData.render.own_crosshair = code === "own";
  await saveSettings();
}

// A crosshair up close: what it is and what you can do with it.
async function openXh(code, who = "") {
  await loadCrosshairs();
  const c = xhOf(code);
  document.getElementById("xh-modal")?.remove();
  const el = document.createElement("div");
  el.id = "xh-modal";
  el.className = "xh-modal";
  const recording = await recordingCrosshair();
  const paint = () => {
    const fav = xhFav(code);
    el.innerHTML = `<div class="xh-box" role="dialog" aria-label="Crosshair">
      <div class="xh-head"><div><div class="h3">${esc(fav?.name || (who ? `${who}'s crosshair` : "Crosshair"))}</div>
        <div class="sub">${c ? `${esc(XH_STYLES[c.style] || "Crosshair")} · length ${c.length}, gap ${c.gap}, thickness ${c.thickness}${c.dot ? ", dot" : ""}${c.outline ? ", outline" : ""} · sizes for a ${c.screen_height}-line screen` : "Veloxify can't read this code"}</div></div>
        <button class="icon-btn" id="xh-close" aria-label="Close">✕</button></div>
      <div class="xh-stage">${xhSvg(c, 220, 4)}<span class="xh-scale">4× zoom</span><div class="xh-actual">${xhSvg(c, 64, 1)}<span>Actual size</span></div></div>
      ${c?.format === "csgo" ? `<div class="note">This code is from before CS2's September 2026 crosshair update, which CS2 no longer imports. Veloxify converted it to the new pixel crosshair: close, but not guaranteed to match exactly.</div>` : ""}
      <div class="xh-code"><code>${esc(c?.cs2 || code)}</code><button class="btn" id="xh-copy">Copy</button></div>
      <div class="sub">In CS2: Settings > Crosshair > Import, then paste.</div>
      <div class="xh-actions">
        ${tauri && c ? `<button class="btn primary" id="xh-apply">Use in my CS2</button>` : ""}
        <button class="btn ${fav ? "on" : ""}" id="xh-fav">${ICONS.star} ${fav ? "Favorited" : "Favorite"}</button>
        ${tauri && c ? `<button class="btn ${recording === code ? "on" : ""}" id="xh-rec">${recording === code ? "Recording with it" : "Use in recordings"}</button>` : ""}
      </div>
      <div class="sub" id="xh-msg"></div></div>`;
    el.querySelector("#xh-close").onclick = () => el.remove();
    el.querySelector("#xh-copy").onclick = (e) => copyXh(c?.cs2 || code, e.currentTarget);
    el.querySelector("#xh-fav").onclick = async () => {
      if (fav) state.xhFav = state.xhFav.filter((f) => f.code !== code);
      else state.xhFav.unshift({ code, name: who ? `${who}'s crosshair` : "", by: who, added: Math.floor(Date.now() / 1000) });
      await saveXhFav();
      paint();
      document.dispatchEvent(new Event("xh-changed"));
    };
    el.querySelector("#xh-apply")?.addEventListener("click", async (e) => {
      const msg = el.querySelector("#xh-msg");
      e.currentTarget.disabled = true;
      try {
        await tauri.core.invoke("apply_crosshair", { code });
        msg.innerHTML = `<b class="up">Done.</b> It's your crosshair the next time you start CS2. (Your previous settings are backed up next to them.)`;
      } catch (err) {
        msg.innerHTML = `<b class="down">Not set:</b> ${esc(err)}`;
        e.currentTarget.disabled = false;
      }
    });
    el.querySelector("#xh-rec")?.addEventListener("click", async () => {
      await useInRecordings(code);
      paint();
      document.dispatchEvent(new Event("xh-changed"));
    });
  };
  paint();
  el.addEventListener("click", (e) => { if (e.target === el) el.remove(); });
  document.body.appendChild(el);
}
// Crosshair buttons anywhere on the page.
document.addEventListener("click", (e) => {
  const p = e.target.closest("[data-xh]");
  if (p) { e.preventDefault(); openXh(p.dataset.xh, p.dataset.xhWho || ""); return; }
  const c = e.target.closest("[data-xh-copy]");
  if (c) { e.preventDefault(); copyXh(c.dataset.xhCopy, c); }
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") document.getElementById("xh-modal")?.remove(); });

// Your crosshairs: favorites, every one you've played with (newest first), and the ones others
// in your matches use most.
async function renderCrosshairs(view) {
  const X = await loadCrosshairs(true);
  const me = state.index.me;
  const recording = await recordingCrosshair();
  const tsOf = (id) => summaryOf(id)?.played_ts || 0;
  const mine = new Map();
  for (const [id, players] of Object.entries(X.matches)) {
    const code = players[me];
    if (!code) continue;
    const ts = tsOf(id);
    const e = mine.get(code) || { code, first: ts, last: ts, n: 0, last_id: id };
    e.n++;
    if (ts < e.first) e.first = ts;
    if (ts >= e.last) { e.last = ts; e.last_id = id; }
    mine.set(code, e);
  }
  const history = [...mine.values()].sort((a, b) => b.last - a.last);
  // Others' crosshairs, by how many players used them.
  const users = new Map();
  for (const [id, players] of Object.entries(X.matches)) {
    for (const [sid, code] of Object.entries(players)) {
      if (sid === me || !code) continue;
      const u = users.get(code) || { code, players: new Set() };
      u.players.add(sid);
      users.set(code, u);
    }
  }
  const popular = [...users.values()].filter((u) => u.players.size >= 2).sort((a, b) => b.players.size - a.players.size).slice(0, 12);
  const day = (ts) => (ts ? new Date(ts * 1000).toLocaleDateString([], { month: "short", day: "numeric", year: new Date(ts * 1000).getFullYear() !== new Date().getFullYear() ? "numeric" : undefined }) : "");
  const card = (code, title, sub) => {
    const c = xhOf(code);
    return `<div class="xh-card ${recording === code ? "rec" : ""}">
      <button class="xh-card-prev" data-xh="${esc(code)}">${xhSvg(c, 96, 2)}</button>
      <div class="xh-card-body"><b>${esc(title)}</b><span class="sub">${sub}</span>
        <div class="xh-card-actions"><button class="btn small" data-xh-copy="${esc(c?.cs2 || code)}">Copy</button><button class="btn small ghost" data-xh="${esc(code)}">More</button>
        ${xhFav(code) ? `<span class="xh-star" title="Favorite">${ICONS.star}</span>` : ""}${recording === code ? `<span class="tag main">Recording with it</span>` : ""}</div></div></div>`;
  };
  const current = history[0];
  view.innerHTML = `
    <a class="day-back" href="#/profile">◀ Profile</a>
    <div class="gn-head"><div><div class="h1">Crosshairs</div><div class="sub">Every crosshair you've played with, read from your demos, plus your favorites. Copy one to import it in CS2, put it straight in your CS2 settings, or record your clips with it.</div></div></div>
    ${!Object.keys(X.matches).length ? `<div class="empty">No crosshairs yet. Veloxify reads them from your demos in the background (after you close CS2), newest matches first.</div>` : ""}
    ${current ? `<section class="panel xh-current"><div class="panel-head"><div class="h3">Your crosshair now</div><span class="grow"></span><span class="sub">From your latest match</span></div>${card(current.code, "Current", `Since ${day(current.first)} · ${current.n} match${current.n === 1 ? "" : "es"}`)}</section>` : ""}
    <section class="panel"><div class="panel-head"><div class="h3">Favorites</div><span class="grow"></span><span class="sub">Star a crosshair (yours or anyone's from a match page) to keep it here</span></div>
      <div class="xh-grid">${state.xhFav.map((f) => card(f.code, f.name || "Favorite", f.by ? `From ${esc(f.by)}` : "")).join("") || `<div class="empty small">No favorites yet.</div>`}</div></section>
    <section class="panel"><div class="panel-head"><div class="h3">Your history</div><span class="grow"></span><span class="sub">${history.length} crosshair${history.length === 1 ? "" : "s"}</span></div>
      <div class="xh-grid">${history.map((h, i) => card(h.code, i === 0 ? "Current" : day(h.last), `${day(h.first)}${h.first !== h.last ? ` – ${day(h.last)}` : ""} · ${h.n} match${h.n === 1 ? "" : "es"}`)).join("") || `<div class="empty small">None read yet.</div>`}</div></section>
    ${popular.length ? `<section class="panel"><div class="panel-head"><div class="h3">Popular in your matches</div><span class="grow"></span><span class="sub">Used by the most players you've played with or against</span></div>
      <div class="xh-grid">${popular.map((u) => card(u.code, `${u.players.size} players`, "")).join("")}</div></section>` : ""}
    <section class="panel"><div class="panel-head"><div class="h3">In your recordings</div></div>
      <div class="set-row"><div class="lbl"><b>${recording === "own" ? "Each player's own crosshair" : recording ? "A crosshair you picked" : "Clean default"}</b><span>Clips and lineup videos are recorded with this. Pick one above (More > Use in recordings), or switch back here.</span></div>
        ${tauri ? `<div class="seg"><button data-rec="" class="${!recording ? "on" : ""}">Clean default</button><button data-rec="own" class="${recording === "own" ? "on" : ""}">Player's own</button></div>` : ""}</div></section>`;
  view.querySelectorAll("[data-rec]").forEach((b) => (b.onclick = async () => { await useInRecordings(b.dataset.rec); renderCrosshairs(view); }));
  const again = () => { if (location.hash.startsWith("#/crosshairs")) renderCrosshairs(view); };
  document.removeEventListener("xh-changed", state.xhListener || (() => {}));
  state.xhListener = again;
  document.addEventListener("xh-changed", again);
}

// ---- match insights ---------------------------------------------------------------------------------

// Every round of every match on a map (insights/<map>.json, built in the background from each
// match's 2D replay): who stood where and when, what they bought, the kills, damage, grenades and
// the bomb. The page asks questions of it: tendencies by round type, "if this, then what",
// strats, plants, entries, lurks and timings. Times are tenths of a second since the round went live.
const INS_KINDS = [["pistol", "Pistol"], ["eco", "Eco"], ["force", "Force buy"], ["full", "Full buy"]];
const INS_VIEWS = [["overview", "Overview"], ["ask", "Ask"], ["positions", "Positions"], ["strats", "Strats"], ["plants", "Plants"], ["paths", "Paths"], ["utility", "Utility"]];
const INS_WHO = [["opp", "Opponents"], ["us", "Your team"], ["all", "Everyone"]];
const NADE_NAMES = ["Smoke", "Molotov", "Flash", "HE", "Decoy"];
const SIDE_WORD = { T: "T", C: "CT" };
const ins = { map: null, side: "T", kinds: [], who: "opp", src: "all", view: "overview", t: 200, conds: [], sel: null, zoom: 1, pan: [0, 0], line: null, drawing: false, pathTab: "entries" };
try { Object.assign(ins, JSON.parse(localStorage.getItem("veloxify.insights") || "{}"), { sel: null, drawing: false }); } catch (e) { /* defaults */ }
const saveIns = () => { try { localStorage.setItem("veloxify.insights", JSON.stringify({ side: ins.side, kinds: ins.kinds, who: ins.who, src: ins.src, view: ins.view, t: ins.t, conds: ins.conds, line: ins.line, pathTab: ins.pathTab })); } catch (e) { /* not saved */ } };

// "1:42" on the round clock for a time since the round went live.
const clockOf = (tenths) => { const s = Math.max(0, Math.round(ROUND_S - tenths / 10)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const pctOf = (a, b) => (b ? Math.round((100 * a) / b) : 0);
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

async function loadInsightsIndex() {
  try { return await (await fetch(assetUrl("insights/index.json"), { cache: "no-store" })).json(); } catch (e) { return null; }
}
async function loadInsights(map) {
  state.insights = state.insights || new Map();
  if (!state.insights.has(map)) {
    let D = null;
    try { D = await (await fetch(assetUrl(`insights/${map}.json`), { cache: "no-store" })).json(); } catch (e) { /* not built yet */ }
    if (D) prepInsights(D);
    state.insights.set(map, D);
  }
  return state.insights.get(map);
}

// Per round: whose side is whose, and quick lookups.
function prepInsights(D) {
  const U = D.path_unit || 4;
  D.U = U;
  for (const r of D.rounds) {
    const mt = D.matches[r.m];
    r.match = mt;
    r.team = { T: [], C: [] };
    [...r.sides].forEach((s, p) => { if (s === "T" || s === "C") r.team[s].push(p); });
    // Your team's side this round (most of that side's players on your team).
    const mineOn = (s) => r.team[s].filter((p) => mt.players[p]?.mine).length * 2 > r.team[s].length;
    r.ours = mineOn("T") ? "T" : mineOn("C") ? "C" : null;
    r.firstKill = r.kills[0] || null;
    r.contact = r.hurts.find((h) => h[1] >= 0 && r.sides[h[1]] !== r.sides[h[2]])?.[0] ?? r.firstKill?.[0] ?? null;
  }
  // Place grid: which callout any spot on the map belongs to.
  const g = D.grid;
  D.placeAt = (x, y) => {
    if (!g || !g.w) return -1;
    const cx = Math.floor((x - g.x0) / g.cell), cy = Math.floor((y - g.y0) / g.cell);
    for (let r = 0; r <= 2; r++) {
      for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x2 = cx + dx, y2 = cy + dy;
        if (x2 < 0 || y2 < 0 || x2 >= g.w || y2 >= g.h) continue;
        const v = g.data[y2 * g.w + x2];
        if (v >= 0) return v;
      }
    }
    return -1;
  };
  // Each place's middle (for its label) and its cells (to outline it).
  D.placeCells = new Map();
  if (g && g.w) g.data.forEach((v, i) => {
    if (v < 0) return;
    if (!D.placeCells.has(v)) D.placeCells.set(v, []);
    D.placeCells.get(v).push([g.x0 + (i % g.w) * g.cell, g.y0 + Math.floor(i / g.w) * g.cell]);
  });
  D.placeMid = new Map([...D.placeCells].map(([v, cells]) => {
    const mx = sum(cells.map((c) => c[0])) / cells.length, my = sum(cells.map((c) => c[1])) / cells.length;
    // The cell nearest the middle (an L-shaped area's middle can be outside it).
    const best = cells.reduce((a, c) => (Math.hypot(c[0] - mx, c[1] - my) < Math.hypot(a[0] - mx, a[1] - my) ? c : a));
    return [v, [best[0] + g.cell / 2, best[1] + g.cell / 2, cells.length]];
  }));
  // Bombsite middles: where bombs are planted (else the site's cells).
  D.sites = [0, 1].map((s) => {
    const ps = D.rounds.filter((r) => r.plant?.[2] === s).map((r) => [r.plant[3], r.plant[4]]);
    if (ps.length) return [sum(ps.map((p) => p[0])) / ps.length, sum(ps.map((p) => p[1])) / ps.length];
    const pl = D.places.indexOf(s ? "BombsiteB" : "BombsiteA");
    return D.placeMid.get(pl)?.slice(0, 2) || null;
  });
}

// Where player p was at time t (tenths): [x, y] or null (dead / not yet).
function posAt(D, r, p, t) {
  const path = r.paths[p];
  const i = Math.round(t / 5);
  if (!path || 2 * i + 1 >= path.length) return null;
  return [path[2 * i] * D.U, path[2 * i + 1] * D.U];
}
// The callout player p was in at time t, or -1.
function placeAt(r, p, t) {
  const a = r.areas[p];
  if (!a || !a.length) return -1;
  if (r.death[p] >= 0 && t >= r.death[p]) return -1;
  let pl = -1;
  for (let i = 0; i < a.length; i += 2) { if (a[i + 1] > t) break; pl = a[i]; }
  return pl;
}
// When player p first entered any of `places` within [from, to] (tenths), or null.
function enteredAt(r, p, places, from = 0, to = 1e9) {
  const a = r.areas[p];
  if (!a) return null;
  const end = r.death[p] >= 0 ? r.death[p] : r.end;
  for (let i = 0; i < a.length; i += 2) {
    const start = a[i + 1], stop = i + 3 < a.length ? a[i + 3] : end;
    if (places.has(a[i]) && stop >= from && start <= to) return Math.max(start, from);
  }
  return null;
}

// The rounds the page's filters keep, for side S's perspective.
function insRounds(D, S, opts = {}) {
  const who = opts.who ?? ins.who, kinds = opts.kinds ?? ins.kinds, src = opts.src ?? ins.src;
  return D.rounds.filter((r) => {
    if (!r.team[S].length) return false;
    if (src !== "all" && r.match.source !== src) return false;
    if (who === "opp" && r.ours === S) return false;
    if (who === "us" && r.ours !== S) return false;
    if (kinds.length && !kinds.includes(r.kind[S === "T" ? 0 : 1])) return false;
    return true;
  });
}

// ---- conditions ("Ask") ----
// area: {type, count: "any"|"2"|"3"|"4"|"5"|"none", side, place, by (tenths or null)}
// nade: {type, side, kind, target: "lineup:<id>" | "place:<i>" | "", by}
// first: {type, side, place (-1 = anywhere)}
// plant: {type, site: 0 | 1 | -1 (no plant)}
function condMatch(D, r, c, L) {
  if (c.type === "area") {
    const team = r.team[c.side] || [];
    const places = new Set([Number(c.place)]);
    const by = c.by ?? 1e9;
    const n = team.filter((p) => enteredAt(r, p, places, 0, by) !== null).length;
    if (c.count === "none") return n === 0;
    const need = c.count === "any" ? 1 : Number(c.count);
    return n >= need;
  }
  if (c.type === "nade") {
    const by = c.by ?? 1e9;
    return r.nades.some((nd) => {
      if (nd[0] > by || nd[2] !== Number(c.kind) || r.sides[nd[1]] !== c.side) return false;
      if (!c.target) return true;
      if (c.target.startsWith("lineup:")) return L?.by_throw?.[`${r.match.id}@${nd[7]}`] === c.target.slice(7);
      if (c.target.startsWith("place:")) return D.placeAt(nd[5], nd[6]) === Number(c.target.slice(6));
      return true;
    });
  }
  if (c.type === "first") {
    const k = r.firstKill;
    if (!k || k[1] < 0) return false;
    if (r.sides[k[1]] !== c.side) return false;
    // Where it happened: where the victim stood.
    return Number(c.place) < 0 || D.placeAt(k[7], k[8]) === Number(c.place);
  }
  if (c.type === "plant") {
    const site = Number(c.site);
    return site < 0 ? !r.plant : r.plant?.[2] === site;
  }
  return true;
}

// What happened in a set of rounds: plants, wins, contact, opening kills.
function outcomes(D, rounds, S) {
  const n = rounds.length;
  const plantA = rounds.filter((r) => r.plant?.[2] === 0).length, plantB = rounds.filter((r) => r.plant?.[2] === 1).length;
  const wins = rounds.filter((r) => r.win === S).length;
  const openT = rounds.filter((r) => r.firstKill && r.firstKill[1] >= 0 && r.sides[r.firstKill[1]] === "T").length;
  const withOpen = rounds.filter((r) => r.firstKill && r.firstKill[1] >= 0).length;
  const contact = median(rounds.map((r) => r.contact).filter((x) => x != null));
  const plantT = median(rounds.filter((r) => r.plant).map((r) => r.plant[0]));
  return { n, plantA, plantB, none: n - plantA - plantB, wins, openT, withOpen, contact, plantT };
}

// A bar of where the bomb went: A, B, no plant.
function plantBar(o, base) {
  if (!o.n) return "";
  const seg = (k, v, cls, label) => (v ? `<i class="${cls}" style="width:${(100 * v) / o.n}%" title="${label}: ${v} of ${o.n} rounds"></i>` : "");
  const delta = (v, bv) => (base && base.n ? ((d) => (Math.abs(d) >= 3 ? ` <span class="${d > 0 ? "up" : "down"}">${d > 0 ? "+" : ""}${d}</span>` : ""))(pctOf(v, o.n) - pctOf(bv, base.n)) : "");
  return `<div class="ins-bar">${seg("a", o.plantA, "a", "Planted A")}${seg("b", o.plantB, "b", "Planted B")}${seg("n", o.none, "n", "No plant")}</div>
    <div class="ins-legend"><span><i class="a"></i>A <b>${pctOf(o.plantA, o.n)}%</b>${delta(o.plantA, base?.plantA)}</span><span><i class="b"></i>B <b>${pctOf(o.plantB, o.n)}%</b>${delta(o.plantB, base?.plantB)}</span><span><i class="n"></i>No plant <b>${pctOf(o.none, o.n)}%</b>${delta(o.none, base?.none)}</span></div>`;
}

// A short sentence for a condition.
function condText(D, c, L, nameOf, lnames) {
  const by = c.by != null ? ` by ${clockOf(c.by)}` : "";
  if (c.type === "area") {
    const who = { any: "Someone", none: "Nobody", 2: "2+", 3: "3+", 4: "4+", 5: "All 5" }[c.count] || "Someone";
    return `${who} of the ${SIDE_WORD[c.side]} ${c.count === "none" ? "goes" : c.count === "any" ? "goes" : "go"} to ${nameOf(Number(c.place))}${by}`;
  }
  if (c.type === "nade") {
    const what = c.target?.startsWith("lineup:") ? lnames.get(c.target.slice(7)) || "a lineup" : c.target?.startsWith("place:") ? `a ${NADE_NAMES[c.kind].toLowerCase()} into ${nameOf(Number(c.target.slice(6)))}` : `a ${NADE_NAMES[c.kind].toLowerCase()}`;
    return `The ${SIDE_WORD[c.side]} throw ${what}${by}`;
  }
  if (c.type === "first") return `The first kill is by the ${SIDE_WORD[c.side]}${Number(c.place) >= 0 ? ` in ${nameOf(Number(c.place))}` : ""}`;
  if (c.type === "plant") return Number(c.site) < 0 ? "The bomb isn't planted" : `The bomb is planted at ${Number(c.site) ? "B" : "A"}`;
  return "";
}

// ---- the page ----
async function renderInsights(view, map) {
  const idx = await loadInsightsIndex();
  const maps = Object.entries(idx?.maps || {}).filter(([, c]) => c.matches > 0).sort((a, b) => b[1].rounds - a[1].rounds);
  const waiting = sum(Object.values(idx?.maps || {}).map((c) => c.waiting || 0));
  if (!maps.length) {
    view.innerHTML = `<div class="gn-head"><div><div class="h1">Match insights</div><div class="sub">How players in your matches play each map: where they go and when, by round type, what follows what, strats, plants and entries.</div></div></div>
      <div class="empty">Not ready yet. Veloxify is re-reading your demos for this in the background${waiting ? ` (${waiting} matches to go)` : ""}, while CS2 is closed. Check back in a while.</div>`;
    return;
  }
  const has = (m) => maps.some(([x]) => x === m);
  if (!map || !has(map)) map = ins.map && has(ins.map) ? ins.map : maps[0][0];
  if (ins.map !== map) Object.assign(ins, { map, sel: null, zoom: 1, pan: [0, 0], line: null });
  const [D, L] = await Promise.all([loadInsights(map), loadMapLineups(map), loadCallouts()]);
  if (!D) { view.innerHTML = `<div class="empty">No insights for ${esc(mapName(map))} yet.</div>`; return; }
  insPage(view, D, L || {}, map, maps, idx.maps[map]?.waiting || 0);
}

function insPage(view, D, L, map, maps, waiting) {
  const S = ins.side, O = S === "T" ? "C" : "T";
  const nameOf = (pl) => (pl >= 0 ? areaName(L, map, D.places[pl]) : "somewhere");
  const lnames = L.lineups ? lineupNames(L, map) : new Map();
  const base = insRounds(D, S);
  const rerender = () => { saveIns(); insPage(view, D, L, map, maps, waiting); };
  const segBtns = (key, opts, val) => opts.map(([k, l]) => `<button data-${key}="${k}" class="${String(val) === String(k) ? "on" : ""}">${l}</button>`).join("");
  const nMatches = new Set(base.map((r) => r.m)).size;
  view.innerHTML = `
    <div class="ins-head"><div><div class="h1">Match insights</div>
      <div class="sub">${esc(mapName(map))}: ${base.length} ${SIDE_WORD[S]}-side round${base.length === 1 ? "" : "s"} from ${nMatches} match${nMatches === 1 ? "" : "es"}${waiting ? ` · ${waiting} match${waiting === 1 ? "" : "es"} being re-read in the background` : ""}</div></div></div>
    <div class="ins-maps">${maps.map(([m, c]) => `<a class="ins-map ${m === map ? "on" : ""}" href="#/insights/${esc(m)}">${mapIcon(m)}<b>${esc(mapName(m))}</b><span class="sub">${c.matches}</span></a>`).join("")}</div>
    <div class="ln-bar ins-filters">
      <div class="seg" title="Whose side to look at">${segBtns("side", [["T", "T side"], ["C", "CT side"]], S)}</div>
      <div class="chips" title="Round types (by what that side bought)">${INS_KINDS.map(([k, l]) => `<button class="chip ${ins.kinds.includes(k) ? "on" : ""}" data-kind="${k}">${l}</button>`).join("")}</div>
      <div class="seg" title="Whose rounds">${segBtns("who", INS_WHO, ins.who)}</div>
      <div class="seg">${segBtns("src", [["all", "All"], ["faceit", "FACEIT"], ["valve", "Premier"]], ins.src)}</div>
    </div>
    <nav class="ins-tabs">${INS_VIEWS.map(([k, l]) => `<button data-view="${k}" class="${ins.view === k ? "on" : ""}">${l}</button>`).join("")}</nav>
    <div class="gn-main ins-main">
      <section class="tl-map"><div class="tl-viewport"><div class="tl-canvas" style="transform:translate(${ins.pan[0]}px,${ins.pan[1]}px) scale(${ins.zoom})">
        <img src="${assetUrl(`radars/${map}.png`)}" alt="${esc(mapName(map))} radar" draggable="false"><canvas id="ins-heat" width="512" height="512"></canvas><svg id="ins-svg" viewBox="0 0 1024 1024"></svg></div></div>
        <input class="tl-zoom" type="range" min="1" max="3" step="0.1" value="${ins.zoom}" aria-label="Zoom" orient="vertical">
        <div class="ins-clock" id="ins-clock"></div></section>
      <section class="gn-side ins-side" id="ins-side"></section>
    </div>
    <div class="note">Round types are by what that side bought (average equipment value per player): eco under $1,600, force buy under $3,900, full buy above; pistol rounds are each half's first. "Opponents" are the teams you played against, "Your team" is you and your teammates. Callouts use your names from the Grenades page.</div>`;

  view.querySelectorAll("[data-side]").forEach((b) => (b.onclick = () => { ins.side = b.dataset.side; ins.sel = null; rerender(); }));
  view.querySelectorAll("[data-who]").forEach((b) => (b.onclick = () => { ins.who = b.dataset.who; rerender(); }));
  view.querySelectorAll("[data-src]").forEach((b) => (b.onclick = () => { ins.src = b.dataset.src; rerender(); }));
  view.querySelectorAll("[data-kind]").forEach((b) => (b.onclick = () => {
    const k = b.dataset.kind;
    ins.kinds = ins.kinds.includes(k) ? ins.kinds.filter((x) => x !== k) : [...ins.kinds, k];
    rerender();
  }));
  view.querySelectorAll("[data-view]").forEach((b) => (b.onclick = () => { ins.view = b.dataset.view; ins.sel = null; ins.drawing = false; rerender(); }));
  wireInsMap(view);

  const ctx = { view, D, L, map, S, O, base, nameOf, lnames, rerender };
  loadRadar(map).then((radar) => {
    ctx.radar = radar;
    ctx.at = (x, y) => (radar ? [(x - radar.pos_x) / radar.scale, (radar.pos_y - y) / radar.scale] : [0, 0]);
    ctx.world = (px, py) => (radar ? [px * radar.scale + radar.pos_x, radar.pos_y - py * radar.scale] : [0, 0]);
    const side = view.querySelector("#ins-side");
    if (ins.view === "ask") insAsk(ctx, side);
    else if (ins.view === "positions") insPositions(ctx, side);
    else if (ins.view === "strats") insStrats(ctx, side);
    else if (ins.view === "plants") insPlants(ctx, side);
    else if (ins.view === "paths") insPaths(ctx, side);
    else if (ins.view === "utility") insUtility(ctx, side);
    else insOverview(ctx, side);
  });
}

// Zoom and pan like the grenades map.
function wireInsMap(view) {
  const canvas = view.querySelector(".tl-canvas"), zoom = view.querySelector(".tl-zoom"), vp = view.querySelector(".tl-viewport");
  const apply = () => { canvas.style.transform = `translate(${ins.pan[0]}px,${ins.pan[1]}px) scale(${ins.zoom})`; zoom.value = ins.zoom; };
  zoom.oninput = () => { ins.zoom = Number(zoom.value); if (ins.zoom === 1) ins.pan = [0, 0]; apply(); };
  vp.onwheel = (e) => { e.preventDefault(); ins.zoom = Math.max(1, Math.min(3, ins.zoom - Math.sign(e.deltaY) * 0.2)); if (ins.zoom === 1) ins.pan = [0, 0]; apply(); };
  vp.onpointerdown = (e) => {
    if (ins.drawing || ins.zoom === 1 || e.target.closest("[data-pl],[data-hl]")) return;
    const start = [e.clientX - ins.pan[0], e.clientY - ins.pan[1]];
    vp.setPointerCapture(e.pointerId);
    vp.onpointermove = (ev) => { ins.pan = [ev.clientX - start[0], ev.clientY - start[1]]; apply(); };
    vp.onpointerup = () => { vp.onpointermove = null; };
  };
}

// A heat map of points (world units) on the radar canvas.
function drawHeat(ctx, pts, palette = "heat") {
  const cv = ctx.view.querySelector("#ins-heat");
  if (!cv) return;
  const g = cv.getContext("2d");
  const W = cv.width;
  g.clearRect(0, 0, W, W);
  if (!pts.length) return;
  const R = 9;
  // Normalise: the busiest spot reaches full strength.
  const bins = new Map();
  const px = pts.map(([x, y]) => { const [a, b] = ctx.at(x, y); return [a / 2, b / 2]; });
  for (const [a, b] of px) { const k = `${Math.floor(a / R)},${Math.floor(b / R)}`; bins.set(k, (bins.get(k) || 0) + 1); }
  const top = Math.max(...bins.values());
  const tpl = document.createElement("canvas");
  tpl.width = tpl.height = 2 * R;
  const t = tpl.getContext("2d");
  const grad = t.createRadialGradient(R, R, 0, R, R, R);
  grad.addColorStop(0, "rgba(0,0,0,1)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  t.fillStyle = grad;
  t.fillRect(0, 0, 2 * R, 2 * R);
  g.globalAlpha = Math.min(1, 1.6 / top);
  for (const [a, b] of px) g.drawImage(tpl, a - R, b - R);
  g.globalAlpha = 1;
  const img = g.getImageData(0, 0, W, W), d = img.data;
  const stops = palette === "red" ? [[0, [255, 120, 90]], [1, [255, 40, 40]]] : palette === "green" ? [[0, [120, 255, 160]], [1, [30, 220, 90]]]
    : [[0, [40, 170, 200]], [0.35, [60, 220, 140]], [0.65, [255, 220, 40]], [1, [255, 60, 30]]];
  const col = (v) => {
    for (let i = 1; i < stops.length; i++) if (v <= stops[i][0]) {
      const [a0, c0] = stops[i - 1], [a1, c1] = stops[i], f = (v - a0) / (a1 - a0 || 1);
      return c0.map((c, j) => c + (c1[j] - c) * f);
    }
    return stops[stops.length - 1][1];
  };
  for (let i = 0; i < d.length; i += 4) {
    const v = d[i + 3] / 255;
    if (!v) continue;
    // The faintest spots stay clear, so the busy ones stand out.
    if (v < 0.07) { d[i + 3] = 0; continue; }
    const [r, gg, b] = col(Math.min(1, v));
    d[i] = r; d[i + 1] = gg; d[i + 2] = b; d[i + 3] = Math.round(30 + 190 * Math.min(1, v));
  }
  g.putImageData(img, 0, 0);
}

// The round clock under the map: a slider (and play) for the time the heat map shows.
function insClock(ctx, onChange, label = "Where they are at") {
  const el = ctx.view.querySelector("#ins-clock");
  el.innerHTML = `<button class="btn ghost small" id="ins-play" aria-label="Play">▶</button><span class="sub">${label}</span><b id="ins-clock-t">${clockOf(ins.t)}</b>
    <input type="range" id="ins-t" min="0" max="1100" step="5" value="${ins.t}" aria-label="Round clock">`;
  const input = el.querySelector("#ins-t"), out = el.querySelector("#ins-clock-t");
  const set = (t) => { ins.t = t; input.value = t; out.textContent = clockOf(t); onChange(t); };
  input.oninput = () => set(Number(input.value));
  input.onchange = saveIns;
  let timer = null;
  el.querySelector("#ins-play").onclick = (e) => {
    if (timer) { clearInterval(timer); timer = null; e.currentTarget.textContent = "▶"; return; }
    e.currentTarget.textContent = "❚❚";
    timer = setInterval(() => { if (!document.body.contains(el)) return clearInterval(timer); set(ins.t >= 1100 ? 0 : ins.t + 10); }, 120);
  };
  set(ins.t);
}

// Everyone on side S at time t in these rounds.
function pointsAt(ctx, rounds, S, t) {
  const pts = [];
  for (const r of rounds) for (const p of r.team[S]) { const q = posAt(ctx.D, r, p, t); if (q) pts.push(q); }
  return pts;
}

// Callout labels (and click targets) on the map; `hl` places are outlined.
function drawPlaces(ctx, { hl = new Set(), labels = true, extra = "" } = {}) {
  const svg = ctx.view.querySelector("#ins-svg");
  if (!svg) return;
  const D = ctx.D, cell = D.grid.cell / (ctx.radar?.scale || 5);
  const fills = [...hl].map((pl) => (D.placeCells.get(pl) || []).map(([x, y]) => { const [a, b] = ctx.at(x, y + D.grid.cell); return `<rect x="${a.toFixed(1)}" y="${b.toFixed(1)}" width="${cell.toFixed(1)}" height="${cell.toFixed(1)}"/>`; }).join("")).join("");
  const big = [...D.placeMid].filter(([, [, , n]]) => n >= 12);
  svg.innerHTML = `<g class="ins-hl">${fills}</g>${extra}${labels ? big.map(([pl, [x, y]]) => { const [a, b] = ctx.at(x, y); return `<text class="ins-pl ${hl.has(pl) ? "on" : ""}" x="${a.toFixed(0)}" y="${b.toFixed(0)}" text-anchor="middle" data-pl="${pl}">${esc(ctx.nameOf(pl))}</text>`; }).join("") : ""}`;
}

// Clicking the map picks the callout there.
function onMapPlace(ctx, fn) {
  const svg = ctx.view.querySelector("#ins-svg");
  svg.onclick = (e) => {
    if (ins.drawing) return;
    const label = e.target.closest("[data-pl]");
    if (label) return fn(Number(label.dataset.pl));
    const box = svg.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * 1024, py = ((e.clientY - box.top) / box.height) * 1024;
    const [x, y] = ctx.world(px, py);
    const pl = ctx.D.placeAt(x, y);
    if (pl >= 0) fn(pl);
  };
}

// The share of rounds side S had someone in each place at time t (±1 s), and how many.
function placeShares(ctx, rounds, S, t) {
  const by = new Map();
  for (const r of rounds) {
    const seen = new Map();
    for (const p of r.team[S]) {
      let pl = -1;
      for (const dt of [0, -10, 10]) { pl = placeAt(r, p, t + dt); if (pl >= 0) break; }
      if (pl >= 0) seen.set(pl, (seen.get(pl) || 0) + 1);
    }
    for (const [pl, n] of seen) { const e = by.get(pl) || { pl, rounds: 0, players: 0 }; e.rounds++; e.players += n; by.set(pl, e); }
  }
  return [...by.values()].sort((a, b) => b.rounds - a.rounds);
}

// One place's story for side S: how often, when they get there, what happens.
function placeStory(ctx, rounds, S, pl) {
  const set = new Set([pl]);
  const arrive = [], contact = [];
  const withIt = [];
  for (const r of rounds) {
    const ts = r.team[S].map((p) => enteredAt(r, p, set)).filter((x) => x !== null);
    if (!ts.length) continue;
    withIt.push(r);
    arrive.push(Math.min(...ts));
    // First damage dealt or taken by someone while there.
    const h = r.hurts.find((h) => h[1] >= 0 && r.sides[h[1]] !== r.sides[h[2]] && ((r.sides[h[2]] === S && placeAt(r, h[2], h[0]) === pl) || (r.sides[h[1]] === S && placeAt(r, h[1], h[0]) === pl)));
    if (h) contact.push(h[0]);
  }
  const without = rounds.filter((r) => !withIt.includes(r));
  return { n: withIt.length, of: rounds.length, arrive: median(arrive), contact: median(contact), withIt, without, oWith: outcomes(ctx.D, withIt, S), oWithout: outcomes(ctx.D, without, S) };
}

// ---- Overview: the strongest patterns first ----
function insOverview(ctx, el) {
  const { D, S, base, nameOf } = ctx;
  if (!base.length) { el.innerHTML = `<div class="empty small">No rounds with these filters.</div>`; drawPlaces(ctx); return; }
  insClock(ctx, (t) => drawHeat(ctx, pointsAt(ctx, base, S, t)));
  drawPlaces(ctx);
  onMapPlace(ctx, (pl) => { ins.view = "positions"; ins.sel = pl; ctx.rerender(); });
  const cards = [];
  // Pistol rounds.
  const pistols = insRounds(D, S, { kinds: ["pistol"] });
  if (pistols.length >= 4) {
    const o = outcomes(D, pistols, S);
    const strats = stratGroups(ctx, pistols, "T").slice(0, 3);
    cards.push(`<div class="ins-card" data-go="strats" data-kinds="pistol"><div class="ins-card-h">Pistol rounds <span class="sub">${pistols.length} rounds</span></div>
      ${plantBar(o)}<div class="sub">${SIDE_WORD[S]} win ${pctOf(o.wins, o.n)}%${o.plantT != null ? ` · bombs usually down by ${clockOf(o.plantT)}` : ""}</div>
      ${strats.length ? `<ol class="ins-list">${strats.map((g) => `<li><b>${esc(g.name)}</b> <span class="sub">${g.rounds.length}× · ${pctOf(g.rounds.length, pistols.length)}%</span></li>`).join("")}</ol>` : ""}</div>`);
  }
  // Tells: where the Ts are early says where they're going.
  const tells = S === "T" ? tellsOf(ctx, base) : [];
  if (tells.length) cards.push(`<div class="ins-card" data-go="ask"><div class="ins-card-h">Tells <span class="sub">where the T are early says where they hit</span></div>
    <ul class="ins-list">${tells.slice(0, 4).map((x) => `<li data-tell='${esc(JSON.stringify(x.cond))}'>${x.html}</li>`).join("")}</ul></div>`);
  // Timings.
  const shares = placeShares(ctx, base, S, 250).filter((x) => x.rounds >= base.length * 0.2).slice(0, 6);
  const timing = shares.map((x) => ({ ...x, story: placeStory(ctx, base, S, x.pl) })).filter((x) => x.story.arrive != null);
  if (timing.length) cards.push(`<div class="ins-card" data-go="positions"><div class="ins-card-h">Timings <span class="sub">when the ${SIDE_WORD[S]} usually get there</span></div>
    <table class="ins-table"><thead><tr><th>Area</th><th>Rounds</th><th>Arrive</th><th>First contact</th></tr></thead><tbody>
    ${timing.map((x) => `<tr data-place="${x.pl}"><td>${esc(nameOf(x.pl))}</td><td>${pctOf(x.story.n, x.story.of)}%</td><td>${clockOf(x.story.arrive)}</td><td>${x.story.contact != null ? clockOf(x.story.contact) : "—"}</td></tr>`).join("")}</tbody></table></div>`);
  // Plants.
  const plants = plantSpots(ctx, base).slice(0, 4);
  if (S === "T" && plants.length) cards.push(`<div class="ins-card" data-go="plants"><div class="ins-card-h">Where they plant <span class="sub">${base.filter((r) => r.plant).length} plants</span></div>
    <ol class="ins-list">${plants.map((p) => `<li><b>${esc(p.name)}</b> <span class="sub">${p.rounds.length}× · win ${pctOf(p.rounds.filter((r) => r.win === "T").length, p.rounds.length)}%</span></li>`).join("")}</ol></div>`);
  // Executes.
  const ex = S === "T" ? executes(ctx, base).slice(0, 3) : [];
  if (ex.length) cards.push(`<div class="ins-card" data-go="strats"><div class="ins-card-h">Common executes <span class="sub">smokes thrown together before a site take</span></div>
    <ol class="ins-list">${ex.map((x) => `<li><b>${esc(x.name)}</b> <span class="sub">${x.rounds.length}× · win ${pctOf(x.rounds.filter((r) => r.win === "T").length, x.rounds.length)}%</span></li>`).join("")}</ol></div>`);
  // CT setups.
  if (S === "C") {
    const setups = stratGroups(ctx, base, "C").slice(0, 4);
    if (setups.length) cards.push(`<div class="ins-card" data-go="strats"><div class="ins-card-h">CT setups <span class="sub">where the 5 CTs are at ${clockOf(250)}</span></div>
      <ol class="ins-list">${setups.map((g) => `<li><b>${esc(g.name)}</b> <span class="sub">${g.rounds.length}× · CT win ${pctOf(g.rounds.filter((r) => r.win === "C").length, g.rounds.length)}%</span></li>`).join("")}</ol></div>`);
  }
  // Entries.
  const entries = S === "T" ? siteEntries(ctx, base) : [];
  for (const site of [0, 1]) {
    const list = entries.filter((e) => e.site === site);
    if (list.length < 4) continue;
    const routes = groupBy(list, (e) => e.from);
    cards.push(`<div class="ins-card" data-go="paths"><div class="ins-card-h">Into ${site ? "B" : "A"} <span class="sub">where the first T comes in from</span></div>
      <ol class="ins-list">${routes.slice(0, 4).map(([from, es]) => `<li><b>${esc(nameOf(from))}</b> <span class="sub">${pctOf(es.length, list.length)}% · ${clockOf(median(es.map((e) => e.t)))} · entry wins ${pctOf(es.filter((e) => e.won).length, es.length)}%</span></li>`).join("")}</ol></div>`);
  }
  el.innerHTML = `<div class="ins-cards">${cards.join("") || `<div class="empty small">Not enough rounds for patterns yet.</div>`}</div>`;
  el.querySelectorAll("[data-go]").forEach((c) => (c.onclick = (e) => {
    const tell = e.target.closest("[data-tell]");
    if (tell) { ins.conds = JSON.parse(tell.dataset.tell); ins.view = "ask"; ctx.rerender(); return; }
    const row = e.target.closest("[data-place]");
    if (row) { ins.view = "positions"; ins.sel = Number(row.dataset.place); ctx.rerender(); return; }
    if (c.dataset.kinds) ins.kinds = [c.dataset.kinds];
    ins.view = c.dataset.go;
    ctx.rerender();
  }));
}

function groupBy(list, key) {
  const m = new Map();
  for (const x of list) { const k = key(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
  return [...m].sort((a, b) => b[1].length - a[1].length);
}

// Places whose early presence moves the T's plant the most.
function tellsOf(ctx, rounds) {
  const { D, nameOf } = ctx;
  if (rounds.length < 20) return [];
  const by = 300; // by 1:25
  const counts = new Map();
  for (const r of rounds) {
    const seen = new Set();
    for (const p of r.team.T) for (let i = 0; i < (r.areas[p] || []).length; i += 2) if (r.areas[p][i + 1] <= by && r.areas[p][i] >= 0) seen.add(r.areas[p][i]);
    for (const pl of seen) counts.set(pl, (counts.get(pl) || 0) + 1);
  }
  const out = [];
  for (const [pl, n] of counts) {
    if (n < 6 || n > rounds.length - 6) continue;
    const cond = { type: "area", count: "any", side: "T", place: pl, by };
    const yes = rounds.filter((r) => condMatch(D, r, cond));
    const no = rounds.filter((r) => !yes.includes(r));
    const oy = outcomes(D, yes, "T"), on = outcomes(D, no, "T");
    for (const [site, k] of [[0, "plantA"], [1, "plantB"]]) {
      const a = oy[k] / oy.n, b = on[k] / on.n;
      const lift = a - b;
      if (Math.abs(lift) < 0.15) continue;
      const score = Math.abs(lift) * Math.sqrt(Math.min(oy.n, on.n));
      const html = lift > 0
        ? `When the T are in <b>${esc(nameOf(pl))}</b> by ${clockOf(by)}, they plant <b>${site ? "B" : "A"} ${Math.round(a * 100)}%</b> of the time <span class="sub">(${Math.round(b * 100)}% otherwise · ${oy.n} rounds)</span>`
        : `When nobody's in <b>${esc(nameOf(pl))}</b> by ${clockOf(by)}, the T plant <b>${site ? "B" : "A"} ${Math.round(b * 100)}%</b> of the time <span class="sub">(${Math.round(a * 100)}% when someone is · ${on.n} rounds)</span>`;
      out.push({ score, html, cond: [lift > 0 ? cond : { ...cond, count: "none" }] });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

// ---- strats: where a side's 5 players are early, and where the round goes ----
// Each player's region at 25 s: A side, B side or mid (nearer neither site).
function regionOf(D, x, y) {
  const [a, b] = D.sites;
  if (!a || !b) return "Mid";
  const da = Math.hypot(x - a[0], y - a[1]), db = Math.hypot(x - b[0], y - b[1]);
  if (da < db * 0.65) return "A";
  if (db < da * 0.65) return "B";
  return "Mid";
}
function stratGroups(ctx, rounds, S, at = 250) {
  const { D, nameOf } = ctx;
  const groups = new Map();
  for (const r of rounds) {
    const regions = { A: 0, Mid: 0, B: 0 }, places = new Map();
    let alive = 0;
    for (const p of r.team[S]) {
      const q = posAt(D, r, p, at);
      if (!q) continue;
      alive++;
      regions[regionOf(D, q[0], q[1])]++;
      const pl = placeAt(r, p, at);
      if (pl >= 0) places.set(pl, (places.get(pl) || 0) + 1);
    }
    if (alive < 4) continue;
    // The shape of it: stacked on a site, split between both, or spread (default).
    const { A: nA, B: nB, Mid: nM } = regions;
    let name = nA >= 4 ? `${nA}-man A` : nB >= 4 ? `${nB}-man B` : nA >= 2 && nB >= 2 ? `Split ${nA} A / ${nB} B` : nM >= 3 ? "Mid control" : nA === 3 ? "A-heavy default" : nB === 3 ? "B-heavy default" : "Default";
    if (S === "T") {
      // And where it went: a rush (bomb down in 40 s), a normal take, a late one, or no plant.
      const site = r.plant ? (r.plant[2] ? "B" : "A") : null;
      name += !site ? " → no plant" : r.plant[0] < 400 ? ` → rush ${site}` : r.plant[0] > 750 ? ` → late ${site}` : ` → ${site}`;
    }
    if (!groups.has(name)) groups.set(name, { name, rounds: [], places: new Map() });
    const g = groups.get(name);
    g.rounds.push(r);
    for (const [pl, n] of places) g.places.set(pl, (g.places.get(pl) || 0) + n);
  }
  return [...groups.values()].filter((g) => g.rounds.length >= 2).sort((a, b) => b.rounds.length - a.rounds.length).map((g) => ({
    ...g, where: [...g.places].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([pl, n]) => `${Math.round(n / g.rounds.length * 10) / 10} ${nameOf(pl)}`).join(", "),
  }));
}

// Smokes the T threw together right before taking a site.
function executes(ctx, rounds) {
  const { D, L, nameOf } = ctx;
  const sets = new Map();
  for (const r of rounds) {
    if (!r.plant) continue;
    const site = r.plant[2];
    const siteName = site ? "BombsiteB" : "BombsiteA";
    const sitePl = new Set([D.places.indexOf(siteName)]);
    const entry = Math.min(...r.team.T.map((p) => enteredAt(r, p, sitePl) ?? 1e9));
    const t0 = entry < 1e9 ? entry : r.plant[0];
    const smokes = r.nades.filter((n) => n[2] === 0 && r.sides[n[1]] === "T" && n[0] >= t0 - 150 && n[0] <= t0 + 30);
    if (smokes.length < 2) continue;
    // Each smoke by where it lands (its lineup's landing callout when it's a known lineup).
    const names = [...new Set(smokes.map((n) => {
      const l = L.lineups?.find((x) => x.id === L.by_throw?.[`${r.match.id}@${n[7]}`]);
      return l?.to_place ? areaName(L, ctx.map, l.to_place) : nameOf(D.placeAt(n[5], n[6]));
    }))].sort();
    const key = `${site ? "B" : "A"}: ${names.join(" + ")}`;
    if (!sets.has(key)) sets.set(key, { name: `${site ? "B" : "A"} execute: ${names.join(" + ")} smokes`, rounds: [] });
    sets.get(key).rounds.push(r);
  }
  return [...sets.values()].filter((x) => x.rounds.length >= 2).sort((a, b) => b.rounds.length - a.rounds.length);
}

function insStrats(ctx, el) {
  const { D, S, base } = ctx;
  const groups = stratGroups(ctx, base, S);
  const ex = S === "T" ? executes(ctx, base) : [];
  const sel = groups.find((g) => g.name === ins.sel) || ex.find((g) => g.name === ins.sel) || null;
  const paint = (rounds, hlPlayers = S) => {
    const lines = [];
    for (const r of rounds.slice(0, 60)) for (const p of r.team[hlPlayers]) {
      const path = r.paths[p];
      if (!path) continue;
      const pts = [];
      for (let i = 0; i < Math.min(path.length, 2 * 2 * 45); i += 2) pts.push(ctx.at(path[i] * D.U, path[i + 1] * D.U).map((v) => v.toFixed(0)).join(","));
      lines.push(`<polyline points="${pts.join(" ")}" class="ins-path ${hlPlayers === "T" ? "t" : "ct"}"/>`);
    }
    drawPlaces(ctx, { extra: `<g class="ins-paths">${lines.join("")}</g>`, labels: true });
  };
  ctx.view.querySelector("#ins-clock").innerHTML = `<span class="sub">Paths over the first 45 seconds of each round in the group (up to 60 rounds)</span>`;
  drawHeat(ctx, []);
  paint(sel ? sel.rounds : []);
  const winOf = (g) => pctOf(g.rounds.filter((r) => r.win === S).length, g.rounds.length);
  const item = (g, i) => `<button class="ins-item ${sel?.name === g.name ? "on" : ""}" data-g="${i}"><div><b>${esc(g.name)}</b>${g.where ? `<div class="sub">usually ${esc(g.where)}</div>` : ""}</div>
    <span class="ins-n">${g.rounds.length}×<small>${pctOf(g.rounds.length, base.length)}% · win ${winOf(g)}%</small></span></button>`;
  const all = [...groups, ...ex];
  el.innerHTML = `<div class="ins-intro sub">${S === "T" ? `How the T split up 25 seconds in (${clockOf(250)}: A side, mid or B side) and where the bomb went, most common first.` : `Where the CTs stand ${clockOf(250)}, most common setups first.`} Point at one to see its paths; pick round types above (pistol rounds!).</div>
    <div class="ins-items">${groups.map((g, i) => item(g, i)).join("") || `<div class="empty small">Not enough rounds yet.</div>`}</div>
    ${ex.length ? `<div class="h3 ins-sub">Executes</div><div class="ins-items">${ex.map((g, i) => item(g, groups.length + i)).join("")}</div>` : ""}
    ${sel ? roundList(ctx, sel.rounds) : ""}`;
  el.querySelectorAll("[data-g]").forEach((b) => {
    const g = all[Number(b.dataset.g)];
    b.onmouseenter = () => paint(g.rounds);
    b.onmouseleave = () => paint(sel ? sel.rounds : []);
    b.onclick = () => { ins.sel = sel?.name === g.name ? null : g.name; ctx.rerender(); };
  });
  wireRoundList(el);
}

// Rounds to open in the 2D replay.
function roundList(ctx, rounds) {
  const rows = [...rounds].sort((a, b) => b.match.ts - a.match.ts).slice(0, 40);
  return `<div class="h3 ins-sub">Rounds <span class="sub">${rounds.length}${rounds.length > rows.length ? `, newest ${rows.length}` : ""}</span></div>
    <div class="ins-rounds">${rows.map((r) => `<button class="ins-round" data-rmatch="${esc(r.match.id)}" data-rnum="${r.n}" title="Open in the 2D replay">
      <span>${new Date(r.match.ts * 1000).toLocaleDateString([], { month: "short", day: "numeric" })}</span><span>Round ${r.n}</span>
      <span class="${r.win === ctx.S ? "up" : "down"}">${r.win === "T" ? "T win" : "CT win"}</span><span class="sub">${r.plant ? `planted ${r.plant[2] ? "B" : "A"}` : ""}</span></button>`).join("")}</div>`;
}
function wireRoundList(el) {
  el.querySelectorAll("[data-rmatch]").forEach((b) => (b.onclick = () => {
    Object.assign(replay, { matchId: b.dataset.rmatch, round: Number(b.dataset.rnum), t: 0, playing: false });
    location.hash = matchHref(b.dataset.rmatch, "replay");
  }));
}

// ---- Ask: conditions and what follows ----
function insAsk(ctx, el) {
  const { D, L, S, base, nameOf, lnames } = ctx;
  const conds = ins.conds || [];
  const rounds = base.filter((r) => conds.every((c) => condMatch(D, r, c, L)));
  const o = outcomes(D, rounds, S), b = outcomes(D, base, S);
  const placeOpts = [...D.placeMid.keys()].filter((pl) => D.placeMid.get(pl)[2] >= 6).sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  const opt = (v, l, cur) => `<option value="${esc(v)}" ${String(cur) === String(v) ? "selected" : ""}>${esc(l)}</option>`;
  const times = [null, 50, 100, 150, 200, 250, 300, 400, 500, 600, 800];
  const timeSel = (c, i) => `<select data-ci="${i}" data-f="by">${times.map((t) => opt(t ?? "", t == null ? "any time" : `by ${clockOf(t)}`, c.by ?? "")).join("")}</select>`;
  const sideSel = (c, i) => `<select data-ci="${i}" data-f="side">${opt("T", "T", c.side)}${opt("C", "CT", c.side)}</select>`;
  const row = (c, i) => {
    let body = "";
    if (c.type === "area") body = `<select data-ci="${i}" data-f="count">${[["any", "Someone"], ["2", "2+"], ["3", "3+"], ["4", "4+"], ["5", "All 5"], ["none", "Nobody"]].map(([v, l]) => opt(v, l, c.count)).join("")}</select> of the ${sideSel(c, i)} in
      <select data-ci="${i}" data-f="place">${placeOpts.map((pl) => opt(pl, nameOf(pl), c.place)).join("")}</select> ${timeSel(c, i)}`;
    if (c.type === "nade") {
      const ls = (L.lineups || []).filter((l) => l.side === (c.side === "C" ? "CT" : "T") && NADE_NAMES.indexOf({ smoke: "Smoke", molotov: "Molotov", flash: "Flash", he: "HE" }[l.kind]) === Number(c.kind)).slice(0, 40);
      body = `The ${sideSel(c, i)} throw a <select data-ci="${i}" data-f="kind">${NADE_NAMES.slice(0, 4).map((n, k) => opt(k, n.toLowerCase(), c.kind)).join("")}</select>
        <select data-ci="${i}" data-f="target">${opt("", "anywhere", c.target)}${ls.map((l) => opt(`lineup:${l.id}`, `${lnames.get(l.id) || l.id} (${l.count}×)`, c.target)).join("")}${placeOpts.map((pl) => opt(`place:${pl}`, `into ${nameOf(pl)}`, c.target)).join("")}</select> ${timeSel(c, i)}`;
    }
    if (c.type === "first") body = `The first kill is by the ${sideSel(c, i)} <select data-ci="${i}" data-f="place">${opt(-1, "anywhere", c.place)}${placeOpts.map((pl) => opt(pl, `in ${nameOf(pl)}`, c.place)).join("")}</select>`;
    if (c.type === "plant") body = `The bomb <select data-ci="${i}" data-f="site">${opt(0, "is planted at A", c.site)}${opt(1, "is planted at B", c.site)}${opt(-1, "isn't planted", c.site)}</select>`;
    return `<div class="ins-cond">${i ? `<span class="ins-and">and</span>` : `<span class="ins-and">If</span>`}<div class="ins-cond-body">${body}</div><button class="icon-btn" data-del="${i}" aria-label="Remove">✕</button></div>`;
  };
  // Openings: where the first kill happens in these rounds.
  const openings = groupBy(rounds.filter((r) => r.firstKill), (r) => ctx.D.placeAt(r.firstKill[7], r.firstKill[8])).slice(0, 4);
  const examples = askExamples(ctx);
  el.innerHTML = `<div class="ins-intro sub">Build a situation and see what usually follows, compared with every ${SIDE_WORD[S]}-side round under the filters above. Click a callout on the map to add it.</div>
    <div class="ins-examples"><span class="sub">Try:</span>${examples.map(([label], i) => `<button class="chip" data-ex="${i}">${esc(label)}</button>`).join("")}</div>
    <div class="ins-conds">${conds.map(row).join("") || `<div class="sub">No conditions yet: these are all ${base.length} rounds.</div>`}</div>
    <div class="ins-add"><span class="sub">Add:</span><button class="btn small" data-add="area">Players in an area</button><button class="btn small" data-add="nade">A grenade</button><button class="btn small" data-add="first">The first kill</button><button class="btn small" data-add="plant">The bomb</button>${conds.length ? `<button class="btn small ghost" data-clear>Clear</button>` : ""}</div>
    <div class="ins-result">
      <div class="ins-big"><b>${o.n}</b> round${o.n === 1 ? "" : "s"} <span class="sub">${conds.length ? `${pctOf(o.n, b.n)}% of ${b.n}` : ""}</span></div>
      ${o.n ? `<div class="h3 ins-sub">Where the bomb goes</div>${plantBar(o, conds.length ? b : null)}
      <div class="ins-stats"><div><b>${pctOf(o.wins, o.n)}%</b><span>${SIDE_WORD[S]} win${conds.length ? ` <i class="${pctOf(o.wins, o.n) >= pctOf(b.wins, b.n) ? "up" : "down"}">${pctOf(o.wins, o.n) - pctOf(b.wins, b.n) >= 0 ? "+" : ""}${pctOf(o.wins, o.n) - pctOf(b.wins, b.n)}</i>` : ""}</span></div>
        <div><b>${o.contact != null ? clockOf(o.contact) : "—"}</b><span>first contact</span></div>
        <div><b>${pctOf(o.openT, o.withOpen)}%</b><span>opening kills by T</span></div>
        <div><b>${o.plantT != null ? clockOf(o.plantT) : "—"}</b><span>bomb down by</span></div></div>
      ${openings.length ? `<div class="h3 ins-sub">Where the first kill happens</div><ul class="ins-list">${openings.map(([pl, rs]) => `<li><b>${esc(nameOf(pl))}</b> <span class="sub">${pctOf(rs.length, o.n)}%</span></li>`).join("")}</ul>` : ""}
      ${roundList(ctx, rounds)}` : `<div class="empty small">No rounds match. Loosen a condition.</div>`}
    </div>`;
  const heatSide = { v: S };
  insClock(ctx, (t) => drawHeat(ctx, pointsAt(ctx, rounds, heatSide.v, t)), `Where the ${SIDE_WORD[S]} are in these rounds at`);
  const condPlaces = new Set(conds.filter((c) => c.type === "area").map((c) => Number(c.place)));
  drawPlaces(ctx, { hl: condPlaces });
  onMapPlace(ctx, (pl) => { ins.conds = [...conds, { type: "area", count: "any", side: S, place: pl, by: 300 }]; ctx.rerender(); });
  el.querySelectorAll("[data-add]").forEach((btn) => (btn.onclick = () => {
    const t = btn.dataset.add;
    const def = { area: { type: "area", count: "any", side: "T", place: placeOpts[0], by: 300 }, nade: { type: "nade", side: "T", kind: 0, target: "", by: 200 }, first: { type: "first", side: "T", place: -1 }, plant: { type: "plant", site: 0 } }[t];
    ins.conds = [...conds, def];
    ctx.rerender();
  }));
  el.querySelector("[data-clear]")?.addEventListener("click", () => { ins.conds = []; ctx.rerender(); });
  el.querySelectorAll("[data-ex]").forEach((b) => (b.onclick = () => { ins.conds = examples[Number(b.dataset.ex)][1]; ctx.rerender(); }));
  el.querySelectorAll("[data-del]").forEach((btn) => (btn.onclick = () => { ins.conds = conds.filter((_, i) => i !== Number(btn.dataset.del)); ctx.rerender(); }));
  el.querySelectorAll("select[data-ci]").forEach((s) => (s.onchange = () => {
    const c = { ...conds[Number(s.dataset.ci)] }, f = s.dataset.f;
    c[f] = f === "by" ? (s.value === "" ? null : Number(s.value)) : ["place", "kind", "site"].includes(f) ? Number(s.value) : s.value;
    if (f === "kind" || f === "side") c.target = "";
    ins.conds = conds.map((x, i) => (i === Number(s.dataset.ci) ? c : x));
    ctx.rerender();
  }));
  wireRoundList(el);
}

// ---- Positions: where they are, when, and what each area means ----
function insPositions(ctx, el) {
  const { D, S, base, nameOf } = ctx;
  const selected = () => (typeof ins.sel === "number" ? ins.sel : null);
  const sel0 = selected();
  const paintSide = () => {
    const sel = selected();
    const shares = placeShares(ctx, base, S, ins.t).slice(0, 14);
    const story = sel != null ? placeStory(ctx, base, S, sel) : null;
    el.innerHTML = `${story ? `<div class="ins-detail"><div class="ins-card-h">${esc(nameOf(sel))} <button class="icon-btn" id="ins-unsel" aria-label="Close">✕</button></div>
      <div class="ins-stats"><div><b>${pctOf(story.n, story.of)}%</b><span>of rounds someone goes</span></div><div><b>${story.arrive != null ? clockOf(story.arrive) : "—"}</b><span>usually there by</span></div>
        <div><b>${story.contact != null ? clockOf(story.contact) : "—"}</b><span>first contact there</span></div><div><b>${pctOf(story.oWith.wins, story.oWith.n)}%</b><span>${SIDE_WORD[S]} win when they go</span></div></div>
      ${S === "T" || true ? `<div class="h3 ins-sub">Bomb when someone's there</div>${plantBar(story.oWith, outcomes(D, base, S))}<div class="h3 ins-sub">When nobody is</div>${plantBar(story.oWithout)}` : ""}
      <button class="btn small" id="ins-ask-place">Ask: what happens when they go here?</button></div>` : ""}
      <div class="ins-intro sub">At <b>${clockOf(ins.t)}</b>: the share of ${SIDE_WORD[S]}-side rounds with someone in each area (and how many there). Click an area on the map or the list.</div>
      <table class="ins-table"><thead><tr><th>Area</th><th>Rounds</th><th>Players</th></tr></thead><tbody>
      ${shares.map((x) => `<tr data-place="${x.pl}" class="${x.pl === sel ? "on" : ""}"><td>${esc(nameOf(x.pl))}</td><td><span class="ins-mini"><i style="width:${pctOf(x.rounds, base.length)}%"></i></span>${pctOf(x.rounds, base.length)}%</td><td>${(x.players / x.rounds).toFixed(1)}</td></tr>`).join("")}</tbody></table>`;
    el.querySelectorAll("[data-place]").forEach((r) => (r.onclick = () => { ins.sel = Number(r.dataset.place); paintSide(); drawPlaces(ctx, { hl: new Set([ins.sel]) }); }));
    el.querySelector("#ins-unsel")?.addEventListener("click", () => { ins.sel = null; ctx.rerender(); });
    el.querySelector("#ins-ask-place")?.addEventListener("click", () => { ins.conds = [{ type: "area", count: "any", side: S, place: sel, by: null }]; ins.view = "ask"; ctx.rerender(); });
  };
  insClock(ctx, (t) => { drawHeat(ctx, pointsAt(ctx, base, S, t)); clearTimeout(ctx.posTimer); ctx.posTimer = setTimeout(paintSide, 60); });
  drawPlaces(ctx, { hl: sel0 != null ? new Set([sel0]) : new Set() });
  onMapPlace(ctx, (pl) => { ins.sel = pl; drawPlaces(ctx, { hl: new Set([pl]) }); paintSide(); });
}

// ---- Plants: spots and afterplants ----
// Plants grouped into spots (within ~110 units), named: the most common on a site is its default,
// others by the callout they lean towards (or your name for them).
function plantSpots(ctx, rounds) {
  const { D, map, nameOf } = ctx;
  // Plants on the bombsite (a few positions in the data land off it: left out).
  const sitePls = [D.places.indexOf("BombsiteA"), D.places.indexOf("BombsiteB")];
  const near = (x, y, pl) => [[0, 0], [60, 0], [-60, 0], [0, 60], [0, -60]].some(([dx, dy]) => D.placeAt(x + dx, y + dy) === pl);
  const plants = rounds.filter((r) => r.plant && r.plant[2] >= 0).map((r) => ({ r, x: r.plant[3], y: r.plant[4], site: r.plant[2] }))
    .filter((p) => sitePls[p.site] < 0 || near(p.x, p.y, sitePls[p.site]));
  const groups = [];
  for (const p of plants) {
    const g = groups.find((g) => g.site === p.site && Math.hypot(g.x - p.x, g.y - p.y) < 140);
    if (g) { g.list.push(p); g.x += (p.x - g.x) / g.list.length; g.y += (p.y - g.y) / g.list.length; } else groups.push({ site: p.site, x: p.x, y: p.y, list: [p] });
  }
  groups.sort((a, b) => b.list.length - a.list.length);
  const named = mapCallouts(map).plants || [];
  const known = PLANT_SPOTS[map] || [];
  const firstOfSite = new Set();
  for (const g of groups) {
    const site = g.site ? "B" : "A";
    const mine = named.find((n) => Math.hypot(n.x - g.x, n.y - g.y) < 140);
    const k = known.find((n) => n.site === site && Math.hypot(n.x - g.x, n.y - g.y) < 160);
    if (mine) g.name = mine.name;
    else if (k) g.name = k.name;
    else if (!firstOfSite.has(site)) g.name = `${site} default`;
    else {
      // After the callout it's closest to, the way players name plants ("Long plant").
      let best = -1, bd = 1e9;
      for (const [pl, cells] of D.placeCells) {
        if (pl === sitePls[g.site]) continue;
        for (const [x, y] of cells) { const d = Math.hypot(x + D.grid.cell / 2 - g.x, y + D.grid.cell / 2 - g.y); if (d < bd) { bd = d; best = pl; } }
      }
      g.name = best >= 0 && bd < 700 ? `${nameOf(best)} plant` : `${site} site`;
    }
    firstOfSite.add(site);
  }
  // Groups with the same name are one spot (a corner of the site, say).
  const spots = [];
  for (const g of groups) {
    const s = spots.find((s) => s.name === g.name && s.site === g.site);
    if (s) { s.list.push(...g.list); s.x = sum(s.list.map((q) => q.x)) / s.list.length; s.y = sum(s.list.map((q) => q.y)) / s.list.length; } else spots.push({ ...g, list: [...g.list] });
  }
  return spots.filter((s) => s.list.length >= 2).map((s) => ({ ...s, rounds: s.list.map((p) => p.r) })).sort((a, b) => b.rounds.length - a.rounds.length);
}
// Named plant spots people use (rough positions; the nearest plant group gets the name).
const PLANT_SPOTS = {};

function insPlants(ctx, el) {
  const { D, map, S, base, nameOf } = ctx;
  const spots = plantSpots(ctx, base);
  const total = sum(spots.map((s) => s.rounds.length));
  const sel = spots.find((s) => `${s.site}:${Math.round(s.x)}:${Math.round(s.y)}` === ins.sel) || null;
  const key = (s) => `${s.site}:${Math.round(s.x)}:${Math.round(s.y)}`;
  // Afterplant: where the T are 10 seconds after the plant (selected spot, else all plants).
  const after = (sel ? sel.rounds : spots.flatMap((s) => s.rounds));
  const aPts = [];
  const aPlaces = new Map();
  for (const r of after) for (const p of r.team.T) {
    const t = r.plant[0] + 100;
    const q = posAt(D, r, p, t);
    if (!q) continue;
    aPts.push(q);
    const pl = placeAt(r, p, t);
    if (pl >= 0) { const e = aPlaces.get(pl) || { n: 0, wins: 0, rounds: new Set() }; e.n++; e.rounds.add(r); aPlaces.set(pl, e); }
  }
  const aList = [...aPlaces].map(([pl, e]) => ({ pl, n: e.n, rounds: [...e.rounds], wins: [...e.rounds].filter((r) => r.win === "T").length })).sort((a, b) => b.n - a.n).slice(0, 8);
  drawHeat(ctx, aPts, "heat");
  const dots = spots.map((s, i) => {
    const [x, y] = ctx.at(s.x, s.y), r = 5 + 10 * Math.sqrt(s.rounds.length / Math.max(1, spots[0]?.rounds.length || 1));
    const label = sel === s || (!sel && i < 6);
    return `<g class="ins-plant ${sel === s ? "on" : ""}" data-hl="${esc(key(s))}"><circle cx="${x}" cy="${y}" r="${r.toFixed(1)}"/>${label ? `<text x="${x}" y="${(y - r - 4).toFixed(0)}" text-anchor="middle">${esc(s.name)} · ${s.rounds.length}</text>` : ""}<title>${esc(s.name)}: ${s.rounds.length} plants</title></g>`;
  }).join("");
  drawPlaces(ctx, { extra: dots, labels: false });
  ctx.view.querySelector("#ins-clock").innerHTML = `<span class="sub">Dots: plant spots (bigger = more). Heat: where the T are 10 seconds after ${sel ? "planting there" : "planting"}.</span>`;
  ctx.view.querySelector("#ins-svg").onclick = (e) => { const g = e.target.closest("[data-hl]"); if (g) { ins.sel = ins.sel === g.dataset.hl ? null : g.dataset.hl; ctx.rerender(); } };
  el.innerHTML = `<div class="ins-intro sub">Where the bomb gets planted (${total} plants${S === "C" ? ", against these CTs" : ""}) and where the T play after. Click a spot to see its afterplant; rename a spot to what you call it.</div>
    <div class="ins-items">${spots.slice(0, 14).map((s) => `<button class="ins-item ${sel === s ? "on" : ""}" data-spot="${esc(key(s))}"><div><b>${esc(s.name)}</b><div class="sub">${s.site ? "B" : "A"} site · T win ${pctOf(s.rounds.filter((r) => r.win === "T").length, s.rounds.length)}%</div></div>
      <span class="ins-n">${s.rounds.length}×<small>${pctOf(s.rounds.length, total)}%</small></span></button>`).join("") || `<div class="empty small">No plants with these filters.</div>`}</div>
    ${sel && tauri ? `<div class="ins-rename"><input id="ins-spot-name" value="${esc(sel.name)}" maxlength="40" aria-label="Spot name"><button class="btn small" id="ins-spot-save">Rename</button></div>` : ""}
    ${aList.length ? `<div class="h3 ins-sub">Afterplant: where the T play ${sel ? `after a ${esc(sel.name)} plant` : "after planting"}</div>
      <table class="ins-table"><thead><tr><th>Area</th><th>Players</th><th>T win</th></tr></thead><tbody>${aList.map((a) => `<tr><td>${esc(nameOf(a.pl))}</td><td>${pctOf(a.n, sum(aList.map((x) => x.n)))}%</td><td>${pctOf(a.wins, a.rounds.length)}%</td></tr>`).join("")}</tbody></table>` : ""}
    ${sel ? roundList(ctx, sel.rounds) : ""}`;
  el.querySelectorAll("[data-spot]").forEach((b) => (b.onclick = () => { ins.sel = ins.sel === b.dataset.spot ? null : b.dataset.spot; ctx.rerender(); }));
  el.querySelector("#ins-spot-save")?.addEventListener("click", async () => {
    const v = el.querySelector("#ins-spot-name").value.trim();
    const mc = mapCallouts(map);
    mc.plants = (mc.plants || []).filter((n) => Math.hypot(n.x - sel.x, n.y - sel.y) >= 140);
    if (v) mc.plants.push({ x: Math.round(sel.x), y: Math.round(sel.y), name: v });
    await saveCallouts();
    ctx.rerender();
  });
  wireRoundList(el);
}

// ---- Paths: site entries, lurks, and crossings of a line you draw ----
// The first T into each site: where they came from, when, and whether they won the entry duel.
function siteEntries(ctx, rounds) {
  const { D } = ctx;
  const out = [];
  for (const site of [0, 1]) {
    const pl = D.places.indexOf(site ? "BombsiteB" : "BombsiteA");
    if (pl < 0) continue;
    const set = new Set([pl]);
    for (const r of rounds) {
      let first = null;
      for (const p of r.team.T) { const t = enteredAt(r, p, set); if (t !== null && (!first || t < first.t)) first = { p, t }; }
      if (!first || first.t < 30) continue;
      // Where they were before: the last other callout.
      const a = r.areas[first.p];
      let from = -1;
      for (let i = 0; i < a.length; i += 2) { if (a[i + 1] >= first.t) break; if (a[i] >= 0 && a[i] !== pl) from = a[i]; }
      const kill = r.kills.find((k) => k[0] >= first.t - 20 && k[0] <= first.t + 50 && (k[1] === first.p || k[2] === first.p));
      out.push({ r, site, p: first.p, t: first.t, from, won: kill ? kill[1] === first.p : false, died: kill ? kill[2] === first.p : false });
    }
  }
  return out;
}

// Lurkers: a T far (1,200+ units) from every teammate for 10+ seconds in the first minute.
function lurks(ctx, rounds) {
  const { D } = ctx;
  const out = [];
  for (const r of rounds) for (const p of r.team.T) {
    let run = 0, best = null, start = 0;
    for (let t = 50; t <= 600; t += 10) {
      const q = posAt(D, r, p, t);
      if (!q) break;
      const mates = r.team.T.filter((o) => o !== p).map((o) => posAt(D, r, o, t)).filter(Boolean);
      const far = mates.length >= 2 && mates.every((m) => Math.hypot(m[0] - q[0], m[1] - q[1]) > 1200);
      if (far) { if (!run) start = t; run += 10; if (run >= 100 && (!best || run > best.len)) best = { start, len: run }; } else run = 0;
    }
    if (!best) continue;
    const mid = best.start + best.len / 2;
    const kills = r.kills.filter((k) => k[1] === p && k[0] >= best.start && k[0] <= best.start + best.len + 100).length;
    const died = r.death[p] >= 0 && r.death[p] <= best.start + best.len + 100;
    out.push({ r, p, start: best.start, len: best.len, place: placeAt(r, p, mid), kills, died });
  }
  return out;
}

// Where paths cross a line (world units): time, how far along it, and jumps there.
function crossings(ctx, rounds, S, line) {
  const { D } = ctx;
  const [[ax, ay], [bx, by]] = line;
  const out = [];
  const inter = (x1, y1, x2, y2) => {
    const d = (x2 - x1) * (by - ay) - (y2 - y1) * (bx - ax);
    if (!d) return null;
    const u = ((ax - x1) * (by - ay) - (ay - y1) * (bx - ax)) / d;
    const v = ((ax - x1) * (y2 - y1) - (ay - y1) * (x2 - x1)) / d;
    return u >= 0 && u <= 1 && v >= 0 && v <= 1 ? [u, v] : null;
  };
  for (const r of rounds) {
    let first = null;
    for (const p of r.team[S]) {
      const path = r.paths[p] || [];
      for (let i = 2; i + 1 < path.length; i += 2) {
        const hit = inter(path[i - 2] * D.U, path[i - 1] * D.U, path[i] * D.U, path[i + 1] * D.U);
        if (!hit) continue;
        const t = ((i - 2) / 2 + hit[0]) * 5;
        const jumped = r.jumps.some((j) => j[1] === p && Math.abs(j[0] - t) <= 10);
        const died = r.death[p] >= 0 && r.death[p] - t <= 30 && r.death[p] >= t;
        const c = { r, p, t, along: hit[1], jumped, died };
        out.push(c);
        if (!first || t < first.t) first = c;
        break; // each player's first crossing
      }
    }
    if (first) first.firstOfRound = true;
  }
  return out;
}

function insPaths(ctx, el) {
  const { D, S, base, nameOf } = ctx;
  const tab = ins.pathTab || "entries";
  drawHeat(ctx, []);
  const pathLine = (r, p, from, to, cls) => {
    const path = r.paths[p] || [];
    const pts = [];
    for (let i = Math.max(0, Math.floor(from / 5) * 2); i < Math.min(path.length, Math.floor(to / 5) * 2 + 2); i += 2) pts.push(ctx.at(path[i] * D.U, path[i + 1] * D.U).map((v) => v.toFixed(0)).join(","));
    return pts.length > 1 ? `<polyline points="${pts.join(" ")}" class="ins-path ${cls}"/>` : "";
  };
  const tabs = `<div class="seg ins-pathtabs">${[["entries", "Site entries"], ["checks", "Checks"], ["lurks", "Lurks"], ["line", "Draw a line"]].map(([k, l]) => `<button data-ptab="${k}" class="${tab === k ? "on" : ""}">${l}</button>`).join("")}</div>`;
  if (tab === "entries") {
    const T = S === "T" ? base : insRounds(D, "T", { who: ins.who === "opp" ? "us" : ins.who === "us" ? "opp" : "all" });
    const es = siteEntries(ctx, T);
    const groups = [0, 1].map((site) => ({ site, list: es.filter((e) => e.site === site), routes: groupBy(es.filter((e) => e.site === site), (e) => e.from) }));
    const selKey = ins.sel;
    const draw = (key) => {
      const shown = es.filter((e) => !key || `${e.site}:${e.from}` === key);
      drawPlaces(ctx, { extra: `<g class="ins-paths">${shown.slice(0, 120).map((e) => pathLine(e.r, e.p, e.t - 60, e.t + 10, e.won ? "won" : e.died ? "lost" : "t")).join("")}</g>` });
    };
    draw(selKey);
    ctx.view.querySelector("#ins-clock").innerHTML = `<span class="sub">The first T's last 6 seconds into the site: <b class="up">won the entry duel</b>, <b class="down">died</b>, or neither.</span>`;
    el.innerHTML = `${tabs}<div class="ins-intro sub">The first T into each site${S === "C" ? " (against these CTs)" : ""}: where they came from, when, and how the entry duel went.</div>
      ${groups.map((g) => g.list.length ? `<div class="h3 ins-sub">Into ${g.site ? "B" : "A"} <span class="sub">${g.list.length} entries</span></div><div class="ins-items">${g.routes.slice(0, 6).map(([from, list]) => `<button class="ins-item ${selKey === `${g.site}:${from}` ? "on" : ""}" data-route="${g.site}:${from}"><div><b>From ${esc(nameOf(from))}</b><div class="sub">usually ${clockOf(median(list.map((e) => e.t)))} · entry duel won ${pctOf(list.filter((e) => e.won).length, list.length)}%, lost ${pctOf(list.filter((e) => e.died).length, list.length)}%</div></div><span class="ins-n">${pctOf(list.length, g.list.length)}%<small>${list.length}×</small></span></button>`).join("")}</div>` : "").join("") || `<div class="empty small">No site entries with these filters.</div>`}`;
    el.querySelectorAll("[data-route]").forEach((b) => {
      b.onmouseenter = () => draw(b.dataset.route);
      b.onmouseleave = () => draw(ins.sel);
      b.onclick = () => { ins.sel = ins.sel === b.dataset.route ? null : b.dataset.route; ctx.rerender(); };
    });
  } else if (tab === "checks") {
    insChecks(ctx, el, tabs);
  } else if (tab === "lurks") {
    const T = S === "T" ? base : insRounds(D, "T", { who: ins.who === "opp" ? "us" : ins.who === "us" ? "opp" : "all" });
    const ls = lurks(ctx, T);
    const byPlace = groupBy(ls, (l) => l.place).filter(([pl]) => pl >= 0);
    const draw = (pl) => drawPlaces(ctx, { extra: `<g class="ins-paths">${ls.filter((l) => pl == null || l.place === pl).slice(0, 100).map((l) => pathLine(l.r, l.p, l.start - 30, l.start + l.len, l.kills ? "won" : l.died ? "lost" : "t")).join("")}</g>` });
    draw(typeof ins.sel === "number" ? ins.sel : null);
    ctx.view.querySelector("#ins-clock").innerHTML = `<span class="sub">Lurk paths: <b class="up">got a kill</b>, <b class="down">died alone</b>, or neither.</span>`;
    el.innerHTML = `${tabs}<div class="ins-intro sub">A lurk: one T 1,200+ units from every teammate for 10 seconds or more in the first minute. ${ls.length} lurks in ${T.length} rounds (${pctOf(new Set(ls.map((l) => l.r)).size, T.length)}% of rounds have one).</div>
      <div class="ins-items">${byPlace.slice(0, 10).map(([pl, list]) => `<button class="ins-item ${ins.sel === pl ? "on" : ""}" data-lurk="${pl}"><div><b>${esc(nameOf(pl))}</b><div class="sub">around ${clockOf(median(list.map((l) => l.start)))} · ${pctOf(list.filter((l) => l.kills).length, list.length)}% get a kill · ${pctOf(list.filter((l) => l.died).length, list.length)}% die</div></div><span class="ins-n">${list.length}×</span></button>`).join("") || `<div class="empty small">No lurks with these filters.</div>`}</div>`;
    el.querySelectorAll("[data-lurk]").forEach((b) => {
      b.onmouseenter = () => draw(Number(b.dataset.lurk));
      b.onmouseleave = () => draw(typeof ins.sel === "number" ? ins.sel : null);
      b.onclick = () => { const pl = Number(b.dataset.lurk); ins.sel = ins.sel === pl ? null : pl; ctx.rerender(); };
    });
  } else {
    const line = ins.line;
    const cs = line ? crossings(ctx, base, S, line) : [];
    const firsts = cs.filter((c) => c.firstOfRound);
    const lineSvg = line ? (() => { const [a, b] = line.map(([x, y]) => ctx.at(x, y)); return `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" class="ins-line"/><circle cx="${a[0]}" cy="${a[1]}" r="4" class="ins-line-end"/><circle cx="${b[0]}" cy="${b[1]}" r="4" class="ins-line-end"/>`; })() : "";
    const dots = cs.slice(0, 300).map((c) => { const [x, y] = [line[0][0] + (line[1][0] - line[0][0]) * c.along, line[0][1] + (line[1][1] - line[0][1]) * c.along]; const [a, b] = ctx.at(x, y); return `<circle cx="${a.toFixed(1)}" cy="${b.toFixed(1)}" r="3" class="ins-cross ${c.jumped ? "jump" : ""} ${c.died ? "died" : ""}"/>`; }).join("");
    drawPlaces(ctx, { extra: lineSvg + dots, labels: true });
    ctx.view.querySelector("#ins-clock").innerHTML = `<span class="sub">${ins.drawing ? "Drag across the map to draw your line (e.g. across a doorway)." : "Dots: where each player crossed (blue = jumped, red = died within 3 seconds)."}</span>`;
    // Time histogram of first crossings, in 5-second bins.
    const bins = new Map();
    for (const c of firsts) { const k = Math.floor(c.t / 50); bins.set(k, (bins.get(k) || 0) + 1); }
    const maxBin = Math.max(1, ...bins.values());
    const thirds = [0, 1, 2].map((i) => cs.filter((c) => Math.min(2, Math.floor(c.along * 3)) === i).length);
    el.innerHTML = `${tabs}<div class="ins-intro sub">Draw a line across a doorway, a choke or a gap and see who crosses it, when, where along it, and whether they jump.</div>
      <div class="ins-add"><button class="btn small ${ins.drawing ? "primary" : ""}" id="ins-draw">${ins.drawing ? "Drawing… drag on the map" : line ? "Draw again" : "Draw a line"}</button>${line ? `<button class="btn small ghost" id="ins-line-clear">Clear</button>` : ""}</div>
      ${line ? `<div class="ins-big"><b>${pctOf(firsts.length, base.length)}%</b> <span class="sub">of ${SIDE_WORD[S]}-side rounds someone crosses (${cs.length} crossings)</span></div>
      ${firsts.length ? `<div class="ins-stats"><div><b>${clockOf(median(firsts.map((c) => c.t)))}</b><span>first cross, usually</span></div><div><b>${pctOf(cs.filter((c) => c.jumped).length, cs.length)}%</b><span>jump</span></div>
        <div><b>${pctOf(cs.filter((c) => c.died).length, cs.length)}%</b><span>die within 3 s</span></div></div>
        <div class="h3 ins-sub">When the first one crosses</div><div class="ins-hist">${[...bins].sort((a, b) => a[0] - b[0]).map(([k, n]) => `<div title="${clockOf(k * 50)}–${clockOf(k * 50 + 50)}: ${n} round${n === 1 ? "" : "s"}"><i style="height:${Math.max(2, Math.round((70 * n) / maxBin))}px"></i><span>${clockOf(k * 50)}</span></div>`).join("")}</div>
        <div class="h3 ins-sub">Where along the line <span class="sub">from the end you started drawing</span></div>
        <div class="ins-stats">${["Start", "Middle", "End"].map((l, i) => `<div><b>${pctOf(thirds[i], cs.length)}%</b><span>${l} third</span></div>`).join("")}</div>
        ${roundList(ctx, [...new Set(firsts.map((c) => c.r))])}` : `<div class="sub">Nobody crossed it in these rounds.</div>`}` : ""}`;
    el.querySelector("#ins-draw").onclick = () => { ins.drawing = true; ctx.rerender(); };
    el.querySelector("#ins-line-clear")?.addEventListener("click", () => { ins.line = null; ctx.rerender(); });
    if (ins.drawing) {
      const svg = ctx.view.querySelector("#ins-svg");
      svg.style.cursor = "crosshair";
      const toWorld = (e) => { const box = svg.getBoundingClientRect(); return ctx.world(((e.clientX - box.left) / box.width) * 1024, ((e.clientY - box.top) / box.height) * 1024); };
      svg.onpointerdown = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const a = toWorld(e);
        svg.setPointerCapture(e.pointerId);
        const tmp = document.createElementNS("http://www.w3.org/2000/svg", "line");
        tmp.setAttribute("class", "ins-line");
        svg.appendChild(tmp);
        const [pa0, pa1] = ctx.at(a[0], a[1]);
        svg.onpointermove = (ev) => { const b = toWorld(ev); const [pb0, pb1] = ctx.at(b[0], b[1]); tmp.setAttribute("x1", pa0); tmp.setAttribute("y1", pa1); tmp.setAttribute("x2", pb0); tmp.setAttribute("y2", pb1); };
        svg.onpointerup = (ev) => {
          svg.onpointermove = null;
          const b = toWorld(ev);
          if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 40) ins.line = [a.map(Math.round), b.map(Math.round)];
          ins.drawing = false;
          ctx.rerender();
        };
      };
    }
    wireRoundList(el);
  }
  el.querySelectorAll("[data-ptab]").forEach((b) => (b.onclick = () => { ins.pathTab = b.dataset.ptab; ins.sel = null; ins.drawing = false; ctx.rerender(); }));
}


// ---- Checks: the spots defenders hold when a site is entered, and which ones get checked ----
function entryChecks(ctx, rounds) {
  const { D, map, nameOf } = ctx;
  const named = mapCallouts(map).spots || [];
  const bySite = [0, 1].map((site) => {
    const holds = [];
    for (const r of rounds) for (const e of r.entries || []) {
      if (e[0] !== site) continue;
      for (let c = 0; c < r.sides.length; c++) {
        if (!(e[5] & (1 << c))) continue;
        const q = posAt(D, r, c, e[2]);
        // Defenders of this site: within reach of it (not a player far across the map).
        const mid = D.sites[site];
        if (q && (!mid || Math.hypot(q[0] - mid[0], q[1] - mid[1]) < 1300)) holds.push({ r, x: q[0], y: q[1], checked: !!(e[4] & (1 << c)), killed: e[3] === c });
      }
    }
    // Spots: holds within ~160 units of each other.
    const spots = [];
    for (const h of holds) {
      const s = spots.find((s) => Math.hypot(s.x - h.x, s.y - h.y) < 160);
      if (s) { s.list.push(h); s.x += (h.x - s.x) / s.list.length; s.y += (h.y - s.y) / s.list.length; } else spots.push({ site, x: h.x, y: h.y, list: [h] });
    }
    const out = spots.filter((s) => s.list.length >= 3).map((s) => ({ ...s, n: s.list.length, checked: s.list.filter((h) => h.checked).length, killed: s.list.filter((h) => h.killed).length }))
      .sort((a, b) => b.n - a.n);
    // Named by callout; spots sharing one get the side of the site they're on ("A Site (north-west)").
    const COMPASS = ["east", "north-east", "north", "north-west", "west", "south-west", "south", "south-east"];
    const mid = D.sites[site] || [0, 0];
    for (const s of out) {
      s.mine = named.find((n) => Math.hypot(n.x - s.x, n.y - s.y) < 150);
      s.base = s.mine ? s.mine.name : nameOf(D.placeAt(s.x, s.y));
    }
    const count = new Map();
    for (const s of out) count.set(s.base, (count.get(s.base) || 0) + 1);
    const seen = new Map();
    for (const s of out) {
      let name = s.base;
      if (!s.mine && count.get(s.base) > 1) {
        const a = Math.atan2(s.y - mid[1], s.x - mid[0]);
        name = `${s.base} (${COMPASS[((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8]})`;
      }
      const k = (seen.get(name) || 0) + 1;
      seen.set(name, k);
      s.name = k > 1 ? `${name} ${k}` : name;
    }
    return out;
  });
  return bySite;
}

function insChecks(ctx, el, tabs) {
  const { D, S, map } = ctx;
  const T = S === "T" ? ctx.base : insRounds(D, "T", { who: ins.who === "opp" ? "us" : ins.who === "us" ? "opp" : "all" });
  const sites = entryChecks(ctx, T);
  const key = (s) => `${s.site}:${Math.round(s.x)}:${Math.round(s.y)}`;
  const all = sites.flat();
  const sel = all.find((s) => key(s) === ins.sel) || null;
  const color = (s) => { const c = s.checked / s.n; return c >= 0.6 ? "#32d35a" : c >= 0.35 ? "#ffc23d" : "#ff3d3d"; };
  const dots = all.map((s) => {
    const [x, y] = ctx.at(s.x, s.y), r = 5 + 9 * Math.sqrt(s.n / Math.max(1, ...all.map((z) => z.n)));
    return `<g class="ins-spot ${sel === s ? "on" : ""}" data-hl="${esc(key(s))}"><circle cx="${x}" cy="${y}" r="${r.toFixed(1)}" style="fill:${color(s)}"/>${sel === s || s.n >= 8 ? `<text x="${x}" y="${(y - r - 3).toFixed(0)}" text-anchor="middle">${esc(s.name)} · ${pctOf(s.checked, s.n)}%</text>` : ""}<title>${esc(s.name)}: held in ${s.n} entries, checked ${pctOf(s.checked, s.n)}%, killed the entrant ${s.killed}×</title></g>`;
  }).join("");
  drawHeat(ctx, []);
  drawPlaces(ctx, { extra: dots, labels: false });
  ctx.view.querySelector("#ins-clock").innerHTML = `<span class="sub">Defender spots when the first T came in: <b class="up">usually checked</b>, <b style="color:var(--gold)">sometimes</b>, <b class="down">rarely checked</b>.</span>`;
  ctx.view.querySelector("#ins-svg").onclick = (e) => { const g = e.target.closest("[data-hl]"); if (g) { ins.sel = ins.sel === g.dataset.hl ? null : g.dataset.hl; ctx.rerender(); } };
  const row = (s) => {
    const missed = s.n - s.checked;
    const risky = s.n >= 6 && s.checked / s.n < 0.35 && s.killed / s.n >= 0.12;
    return `<button class="ins-item ${sel === s ? "on" : ""}" data-spot="${esc(key(s))}"><div><b>${esc(s.name)}</b>${risky ? ` <span class="tag ins-risky">Often missed</span>` : ""}
      <div class="sub">checked ${pctOf(s.checked, s.n)}% · killed the entrant ${pctOf(s.killed, s.n)}%${missed ? ` · ${pctOf(s.list.filter((h) => !h.checked && h.killed).length, Math.max(1, missed))}% of the misses ended in a death` : ""}</div></div>
      <span class="ins-n">${s.n}×<small>held</small></span></button>`;
  };
  el.innerHTML = `${tabs}<div class="ins-intro sub">Where the CTs were when the first T came into a site, and whether the T looked there (aimed within 18° in their first 2 seconds on the site). Rarely checked spots that still kill the entrant are the ones to clear.</div>
    ${sites.map((list, site) => (list.length ? `<div class="h3 ins-sub">${site ? "B" : "A"} site <span class="sub">${list.length} spots</span></div><div class="ins-items">${list.slice(0, 8).map(row).join("")}</div>` : "")).join("") || `<div class="empty small">No entries with these filters yet (older matches join as they're re-read).</div>`}
    ${sel && tauri ? `<div class="ins-rename"><input id="ins-spot-name" value="${esc(sel.name)}" maxlength="40" aria-label="Spot name"><button class="btn small" id="ins-spot-save">Rename</button></div>` : ""}
    ${sel ? roundList(ctx, [...new Set(sel.list.map((h) => h.r))]) : ""}`;
  el.querySelectorAll("[data-spot]").forEach((b) => (b.onclick = () => { ins.sel = ins.sel === b.dataset.spot ? null : b.dataset.spot; ctx.rerender(); }));
  el.querySelector("#ins-spot-save")?.addEventListener("click", async () => {
    const v = el.querySelector("#ins-spot-name").value.trim();
    const mc = mapCallouts(map);
    mc.spots = (mc.spots || []).filter((n) => Math.hypot(n.x - sel.x, n.y - sel.y) >= 150);
    if (v) mc.spots.push({ x: Math.round(sel.x), y: Math.round(sel.y), name: v });
    await saveCallouts();
    ctx.rerender();
  });
  wireRoundList(el);
}

// ---- Utility: when players get to an area, so grenades catch the most ----
const FIRE_DMG = new Set(["inferno", "molotov", "incgrenade"]);
function insUtility(ctx, el) {
  const { D, S, O, base, nameOf } = ctx;
  const sel = typeof ins.sel === "number" ? ins.sel : null;
  drawHeat(ctx, []);
  drawPlaces(ctx, { hl: sel != null ? new Set([sel]) : new Set() });
  onMapPlace(ctx, (pl) => { ins.sel = pl; ctx.rerender(); });
  ctx.view.querySelector("#ins-clock").innerHTML = `<span class="sub">Click an area on the map (or below) to see when the ${SIDE_WORD[S]} get there and what grenades do to them.</span>`;
  if (sel == null) {
    const shares = placeShares(ctx, base, S, 150).slice(0, 10);
    el.innerHTML = `<div class="ins-intro sub">Timing your grenades: pick an area the ${SIDE_WORD[S]} pass through (a choke like banana or a doorway works best).</div>
      <div class="ins-items">${shares.map((x) => `<button class="ins-item" data-place="${x.pl}"><div><b>${esc(nameOf(x.pl))}</b><div class="sub">someone there at ${clockOf(150)} in ${pctOf(x.rounds, base.length)}% of rounds</div></div></button>`).join("")}</div>`;
    el.querySelectorAll("[data-place]").forEach((b) => (b.onclick = () => { ins.sel = Number(b.dataset.place); ctx.rerender(); }));
    return;
  }
  // Players there each second of the first minute, and when they first arrive.
  const secs = 70;
  const present = new Array(secs).fill(0), anyone = new Array(secs).fill(0), arrive = [];
  const set = new Set([sel]);
  for (const r of base) {
    for (let s = 0; s < secs; s++) {
      const n = r.team[S].filter((p) => placeAt(r, p, s * 10) === sel).length;
      present[s] += n;
      if (n) anyone[s]++;
    }
    const ts = r.team[S].map((p) => enteredAt(r, p, set)).filter((x) => x !== null);
    if (ts.length) arrive.push(Math.min(...ts));
  }
  const avg = present.map((n) => n / Math.max(1, base.length));
  const peak = avg.indexOf(Math.max(...avg));
  // Grenade damage they took there, and per grenade thrown in by the other side.
  let heDmg = 0, fireDmg = 0;
  const dmgByS = new Array(secs).fill(0);
  let nades = 0, nadeDmg = 0;
  for (const r of base) {
    for (const h of r.hurts) {
      if (h[1] < 0 || r.sides[h[2]] !== S || r.sides[h[1]] !== O) continue;
      const w = D.weapons[h[4]] || "";
      const fire = FIRE_DMG.has(w), he = w === "hegrenade";
      if (!fire && !he) continue;
      if (placeAt(r, h[2], h[0]) !== sel) continue;
      if (fire) fireDmg += h[3]; else heDmg += h[3];
      if (h[0] < secs * 10) dmgByS[Math.floor(h[0] / 10)] += h[3];
    }
    for (const nd of r.nades) {
      if (r.sides[nd[1]] !== O || (nd[2] !== 1 && nd[2] !== 3) || ctx.D.placeAt(nd[5], nd[6]) !== sel) continue;
      nades++;
      const fire = nd[2] === 1;
      nadeDmg += sum(r.hurts.filter((h) => h[1] === nd[1] && h[0] >= nd[0] && h[0] <= nd[0] + 90 && (fire ? FIRE_DMG.has(D.weapons[h[4]] || "") : D.weapons[h[4]] === "hegrenade") && r.sides[h[2]] === S).map((h) => h[3]));
    }
  }
  const maxAvg = Math.max(0.01, ...avg);
  const bars = avg.map((v, s) => `<div title="${clockOf(s * 10)}: ${v.toFixed(2)} on average, someone there in ${pctOf(anyone[s], base.length)}% of rounds"><i style="height:${Math.max(1, Math.round((70 * v) / maxAvg))}px" class="${s === peak ? "peak" : ""}"></i>${s % 10 === 0 ? `<span>${clockOf(s * 10)}</span>` : ""}</div>`).join("");
  const throwAt = Math.max(0, peak - 2);
  el.innerHTML = `<div class="ins-detail"><div class="ins-card-h">${esc(nameOf(sel))} <span class="sub">${SIDE_WORD[S]} side · ${base.length} rounds</span><button class="icon-btn" id="ins-unsel" aria-label="Back">✕</button></div>
    <div class="ins-stats"><div><b>${arrive.length ? clockOf(median(arrive)) : "—"}</b><span>first one usually arrives</span></div><div><b>${clockOf(peak * 10)}</b><span>most of them there (${avg[peak].toFixed(1)} on average)</span></div>
      <div><b>${pctOf(arrive.length, base.length)}%</b><span>of rounds someone comes</span></div></div>
    <div class="h3 ins-sub">Players there over the round <span class="sub">(average)</span></div><div class="ins-hist ins-occ">${bars}</div>
    <div class="ins-tip">${arrive.length >= 5 ? `A grenade landing around <b>${clockOf(throwAt * 10)}</b> catches them at their busiest${median(arrive) < peak * 10 - 30 ? `; the first one is usually there earlier, by ${clockOf(median(arrive))}` : ""}.` : "Not enough rounds where they go here yet."}</div>
    <div class="h3 ins-sub">Grenade damage they took here <span class="sub">from the ${SIDE_WORD[O]}</span></div>
    <div class="ins-stats"><div><b>${Math.round(heDmg / Math.max(1, base.length))}</b><span>HE damage a round</span></div><div><b>${Math.round(fireDmg / Math.max(1, base.length))}</b><span>fire damage a round</span></div>
      <div><b>${nades ? Math.round(nadeDmg / nades) : "—"}</b><span>damage per molotov or HE thrown in (${nades})</span></div></div></div>`;
  el.querySelector("#ins-unsel").onclick = () => { ins.sel = null; ctx.rerender(); };
}

// Example questions for Ask, made from this map's own patterns.
function askExamples(ctx) {
  const { D, S, base, nameOf } = ctx;
  const out = [];
  const tells = S === "T" ? tellsOf(ctx, base).slice(0, 2) : [];
  for (const t of tells) out.push([condTextShort(ctx, t.cond[0]), t.cond]);
  const busy = placeShares(ctx, base, S, 300).filter((x) => !/Bombsite/.test(D.places[x.pl] || "")).slice(0, 1)[0];
  if (busy) out.push([`3+ ${SIDE_WORD[S]} in ${nameOf(busy.pl)} by ${clockOf(300)}`, [{ type: "area", count: "3", side: S, place: busy.pl, by: 300 }]]);
  // The T's most common smoke landing spot.
  const land = new Map();
  for (const r of base) for (const n of r.nades) if (n[2] === 0 && r.sides[n[1]] === "T" && n[0] <= 300) { const pl = D.placeAt(n[5], n[6]); if (pl >= 0) land.set(pl, (land.get(pl) || 0) + 1); }
  const top = [...land].sort((a, b) => b[1] - a[1])[0];
  if (top) out.push([`T smoke ${nameOf(top[0])} by ${clockOf(300)}`, [{ type: "nade", side: "T", kind: 0, target: `place:${top[0]}`, by: 300 }]]);
  out.push([`First kill by the CT`, [{ type: "first", side: "C", place: -1 }]]);
  out.push([`Bomb planted at A`, [{ type: "plant", site: 0 }]], [`Bomb planted at B`, [{ type: "plant", site: 1 }]]);
  return out;
}
function condTextShort(ctx, c) {
  if (c.type === "area") return `${c.count === "none" ? "Nobody" : "Someone"} in ${ctx.nameOf(Number(c.place))} by ${clockOf(c.by)}`;
  return "Example";
}

// ---- playstyle ----------------------------------------------------------------------------------------

// Your own tendencies from every round you played (the same insight files as Match insights): who
// you are as a player (your roles, rifler or AWPer, anchor or rotator) and how well you play each,
// your best and worst maps and positions, staying alive, and your duels: how they started, with
// what, and what came before. Everything is compared with the average player in the same rounds.
const ps = { map: "all", side: "all", src: "all", bucket: null, place: null, pos: null, find: {}, finding: false };
try { Object.assign(ps, JSON.parse(localStorage.getItem("veloxify.playstyle") || "{}"), { bucket: null, place: null, pos: null, finding: false }); } catch (e) { /* defaults */ }
const savePs = () => { try { localStorage.setItem("veloxify.playstyle", JSON.stringify({ map: ps.map, side: ps.side, src: ps.src, find: ps.find })); } catch (e) { /* not saved */ } };
const WCLASS = (w) => {
  if (!w) return "other";
  if (["ak47", "m4a1", "m4a1_silencer", "famas", "galilar", "aug", "sg556"].includes(w)) return "rifle";
  if (w === "awp") return "awp";
  if (["ssg08", "g3sg1", "scar20"].includes(w)) return "scout";
  if (["glock", "usp_silencer", "hkp2000", "p250", "fiveseven", "tec9", "cz75a", "deagle", "elite", "revolver"].includes(w)) return "pistol";
  if (["mp9", "mac10", "mp7", "mp5sd", "ump45", "p90", "bizon"].includes(w)) return "smg";
  if (["nova", "xm1014", "sawedoff", "mag7", "m249", "negev"].includes(w)) return "heavy";
  return "other";
};
const WCLASS_NAME = { rifle: "Rifles", awp: "AWP", scout: "Scout", pistol: "Pistols", smg: "SMGs", heavy: "Shotguns and machine guns", other: "Other" };
// Utility on a player before a fight (a kill row's 22 and 23).
const UTIL = { molly: 1, nadeDmg: 2, flashed: 4, teamFlashed: 8 };
const SIDE_NAME = { T: "T", C: "CT" };

// Every fight in these rounds from both players' side (the winner's and the loser's), so yours can
// be compared with the average player's: `who` is "me", "mate" or "opp" (relative to you that round).
// A duel is a fight you both saw coming: the one who died was looking their way as it started. Dying
// while looking elsewhere is being caught off guard, not a duel lost (`duel` false). Matches read before
// Veloxify knew who saw whom have no `fight` and count every kill and death.
function allDuels(sets) {
  const out = [];
  for (const { D, rounds } of sets) for (const r of rounds) {
    const me = r.match.me;
    if (me < 0) continue;
    const mySide = r.sides[me];
    for (const k of r.kills) {
      const a = k[1], v = k[2];
      if (a < 0 || v < 0 || r.sides[a] === r.sides[v]) continue;
      const F = k.length >= 24;
      // The one who died was looking elsewhere (60+ degrees off) as it started.
      const offGuard = F && k[23] > 60;
      for (const won of [true, false]) {
        const p = won ? a : v, side = r.sides[p];
        const [mi, ti] = won ? [0, 1] : [1, 0];
        const myWeapon = D.weapons[won ? k[3] : k[13]] || "";
        const myPos = won ? [k[5], k[6]] : [k[7], k[8]];
        // Who peeked: got 45+ units from where they were in the half second before the first hit.
        const myMove = F && k[14 + mi] >= 45, theirMove = F && k[14 + ti] >= 45;
        out.push({
          D, r, k, p, won, side, who: p === me ? "me" : side === mySide ? "mate" : "opp", t: k[0], dist: k[10],
          myWeapon, theirWeapon: D.weapons[won ? k[13] : k[3]] || "", wclass: WCLASS(myWeapon), height: won ? k[9] : -k[9],
          mySpeed: won ? k[11] : k[12], theirSpeed: won ? k[12] : k[11], hs: won && !!(k[4] & 1), opening: !!(k[4] & 2), trade: !!(k[4] & 4),
          smoke: !!(k[4] & 16), myPos, place: p === me ? D.placeAt(myPos[0], myPos[1]) : -1, afterPlant: !!r.plant && k[0] > r.plant[0],
          alone: r.team[side].every((q) => q === p || (r.death[q] >= 0 && r.death[q] <= k[0])),
          kind: r.kind?.[side === "T" ? 0 : 1] || "",
          fight: F, duel: !offGuard, offGuard,
          start: !F ? null : myMove && !theirMove ? "peeked" : !myMove && theirMove ? "held" : myMove ? "both" : "still",
          myUtil: F ? k[20 + mi] : 0, theirUtil: F ? k[20 + ti] : 0,
          myHp: F ? k[18 + mi] : 0, theirHp: F ? k[18 + ti] : 0,
          firstHit: !F ? null : (k[22] === 0) === won ? "me" : "them",
        });
      }
    }
  }
  return out;
}

// A win rate against the average player's: Excellent .. Poor (needs enough duels to say).
const RATE_GRADES = { g0: "Excellent", g1: "Good", g2: "Average", g3: "Below average", g4: "Poor" };
// `standard` (a GRADES key) grades by the generally accepted marks; otherwise by the average player
// in your matches (and only when the difference is more than chance).
function gradeRate(w, n, avg, standard = null) {
  if (n < 15 || (avg == null && !standard)) return null;
  const a = avg ?? 0.5;
  const diff = w / n - a, z = diff / Math.sqrt(Math.max(0.01, a * (1 - a)) / n);
  if (standard && GRADES[standard]) {
    // Duel marks are for a field where the average wins 50%: measure your edge over the average in
    // this kind of duel (T-side openings are harder for everyone, for example).
    const v = (standard === "open" || standard === "duels") && avg != null ? 50 + 100 * (w / n - avg) : (100 * w) / n;
    const g = `g${gradeOf(standard, v)}`;
    return { g, word: RATE_GRADES[g], z };
  }
  const g = diff >= 0.08 && z >= 2 ? "g0" : diff >= 0.03 && z >= 1 ? "g1" : diff <= -0.08 && z <= -2 ? "g4" : diff <= -0.03 && z <= -1 ? "g3" : "g2";
  return { g, word: RATE_GRADES[g], z };
}
// A number against the average player's in the same role or spot (a rating: 15% better is
// excellent, 5% good). Needs `min` rounds of yours to say.
function gradeVs(v, avg, n, min = 12, lowerBetter = false) {
  if (v == null || avg == null || !avg || n < min) return null;
  const rel = lowerBetter ? avg / Math.max(v, 1e-6) - 1 : v / avg - 1;
  const g = rel >= 0.15 ? "g0" : rel >= 0.05 ? "g1" : rel > -0.05 ? "g2" : rel > -0.15 ? "g3" : "g4";
  return { g, word: RATE_GRADES[g], rel };
}
const gradeChip = (g) => (g ? `<span class="ps-grade ${g.g}">${g.word}</span>` : `<span class="ps-grade na" title="Not enough rounds yet to say">–</span>`);
const isGood = (g) => g && (g.g === "g0" || g.g === "g1");
const isBad = (g) => g && (g.g === "g3" || g.g === "g4");

// HLTV Rating 1.0 from rounds (kills, survival and multi-kills; 1.00 is average). Unlike a whole
// match's rating it can be split by side, position and role.
function rating1(recs) {
  const n = recs.length;
  if (!n) return null;
  const k = sum(recs.map((x) => x.k)), d = recs.filter((x) => x.died).length, mk = sum(recs.map((x) => Math.min(5, x.k) ** 2));
  return (k / n / 0.679 + (0.7 * (n - d)) / n / 0.317 + mk / n / 1.277) / 2.7;
}
function recStats(recs) {
  const n = recs.length;
  if (!n) return { n: 0, rating: null };
  const deaths = recs.filter((x) => x.died), ops = recs.filter((x) => x.op);
  return {
    n, rating: rating1(recs), kpr: sum(recs.map((x) => x.k)) / n, adr: sum(recs.map((x) => x.dmg)) / n,
    surv: 1 - deaths.length / n, win: recs.filter((x) => x.win).length / n,
    first: recs.filter((x) => x.first).length / n, untraded: deaths.filter((x) => !x.traded).length / n,
    alive: sum(recs.map((x) => x.dt ?? x.r.end)) / n / 10,
    open: ops.length ? ops.filter((x) => x.op > 0).length / ops.length : null, opens: ops.length,
  };
}

// A CT's round: anchor (stayed on the site they held at 1:30 until 1:05, or until they died), rotator
// (went to the other site by then) or mid (in the middle of the map at 1:30).
function ctRole(D, r, p) {
  const reg = (t) => { const q = posAt(D, r, p, t); return q ? regionOf(D, q[0], q[1]) : null; };
  const a = reg(250);
  if (!a) return null;
  if (a === "Mid") return "mid";
  for (let t = 300; t <= 650; t += 25) { const b = reg(t); if (!b) break; if (b !== a && b !== "Mid") return "rotator"; }
  return "anchor";
}
// Where a player played the round: the callout they spent the most time in (CT from 1:45 to 1:10,
// T from 1:40 until the plant or 0:55), until they died.
function psPosition(r, p, S) {
  const a = r.areas[p];
  if (!a || !a.length) return -1;
  const from = S === "C" ? 100 : 150;
  let to = S === "C" ? 450 : 600;
  if (r.death[p] >= 0) to = Math.min(to, r.death[p]);
  if (S === "T" && r.plant) to = Math.min(to, r.plant[0]);
  if (to - from < 30) return placeAt(r, p, Math.max(0, to - 5));
  const time = new Map();
  for (let i = 0; i < a.length; i += 2) {
    const s = Math.max(a[i + 1], from), e = Math.min(i + 3 < a.length ? a[i + 3] : to, to);
    if (e > s && a[i] >= 0) time.set(a[i], (time.get(a[i]) || 0) + e - s);
  }
  let best = -1, most = 0;
  for (const [pl, t] of time) if (t > most) { most = t; best = pl; }
  return best;
}

// Every player's round (yours and everyone else's in the same rounds): what they did, where they
// played and in what role, so you can be compared with the average player in the same spot or role.
function psRecords(sets) {
  const out = [];
  for (const set of sets) {
    const { D } = set, ctx = { D };
    const entries = new Map(), lurkers = new Map();
    // Entries: the first T into a site with CTs there to fight (walking into a site that's already
    // empty, after the defenders died elsewhere or rotated, isn't entry fragging).
    for (const r of set.rounds) for (const [, p, , , , present] of r.entries || []) {
      if (!present) continue;
      const m = entries.get(r) || new Map();
      m.set(p, true);
      entries.set(r, m);
    }
    for (const l of lurks(ctx, set.rounds)) { const s = lurkers.get(l.r) || new Set(); s.add(l.p); lurkers.set(l.r, s); }
    for (const r of set.rounds) {
      const deathOf = (p) => (r.death[p] >= 0 ? r.death[p] : 1e9);
      const fk = r.firstKill && r.firstKill[1] >= 0 ? r.firstKill : null;
      for (const S of ["T", "C"]) {
        const team = r.team[S];
        if (!team.length) continue;
        const first = team.reduce((a, b) => (deathOf(b) < deathOf(a) ? b : a));
        for (const p of team) {
          const died = r.death[p] >= 0;
          const death = r.kills.find((k) => k[2] === p);
          let role = null;
          if (S === "T") {
            if (entries.get(r)?.has(p)) role = "entry";
            else if (lurkers.get(r)?.has(p)) role = "lurk";
            else if (r.nades.filter((n) => n[1] === p && (n[2] === 0 || n[2] === 2) && (!r.plant || n[0] < r.plant[0])).length >= 2) role = "support";
          } else role = ctRole(D, r, p);
          out.push({
            set, r, p, S, me: p === r.match.me, role, died, dt: died ? r.death[p] : null, first: died && first === p, win: r.win === S,
            k: r.kills.filter((k) => k[1] === p && k[2] >= 0 && r.sides[k[2]] !== S).length,
            // Traded: whoever killed them died within 5 s.
            traded: !!death && death[1] >= 0 && r.kills.some((k) => k[2] === death[1] && k[0] >= death[0] && k[0] <= death[0] + 50),
            dmg: sum(r.hurts.filter((h) => h[1] === p && h[2] >= 0 && r.sides[h[2]] !== S).map((h) => h[3])),
            op: fk ? (fk[1] === p ? 1 : fk[2] === p ? -1 : 0) : 0,
            pos: psPosition(r, p, S), gun: r.prim && r.prim[p] >= 0 ? WCLASS(D.weapons[r.prim[p]]) : null,
          });
        }
      }
    }
  }
  return out;
}

// Roles: how often you play each (against the average player) and how well (your rating in those
// rounds against the average player's in the same role).
const ROLE_DEFS = [
  ["entry", "T", "Entry fragger", "First T into a site with CTs there to fight", (x) => x.role === "entry"],
  ["lurk", "T", "Lurker", "Alone, far from your team, in the first minute", (x) => x.role === "lurk"],
  ["support", "T", "Support", "Two or more smokes or flashes before the plant (not the entry or a lurker)", (x) => x.role === "support"],
  ["anchor", "C", "Anchor", "Stayed on the site you held at 1:30 until 1:05 (or until you died)", (x) => x.role === "anchor"],
  ["rotator", "C", "Rotator", "Went from one site to the other by 1:05", (x) => x.role === "rotator"],
  ["mid", "C", "Mid / aggressive CT", "In the middle of the map at 1:30", (x) => x.role === "mid"],
  ["rifle", "", "Rifler", "Rounds you played with a rifle", (x) => x.gun === "rifle"],
  ["awp", "", "AWPer", "Rounds you played with the AWP", (x) => x.gun === "awp"],
];
const ROLE_NOUN = { entry: "entry fragger", lurk: "lurker", support: "support player", anchor: "anchor", rotator: "rotator", mid: "mid CT", rifle: "rifler", awp: "AWPer" };
const ROLE_LIKE = { entry: "an entry fragger", lurk: "a lurker", support: "a support player", anchor: "an anchor", rotator: "a rotator", mid: "an aggressive mid CT", rifle: "a rifler", awp: "an AWPer" };
function psRoleStats(recs) {
  return ROLE_DEFS.map(([key, side, name, how, test]) => {
    const pool = recs.filter((x) => !side || x.S === side);
    const mineAll = pool.filter((x) => x.me), othersAll = pool.filter((x) => !x.me);
    const mine = mineAll.filter(test), others = othersAll.filter(test);
    const s = recStats(mine), a = recStats(others);
    const share = mineAll.length ? mine.length / mineAll.length : 0, avgShare = othersAll.length ? others.length / othersAll.length : 0;
    return { key, side, name, how, s, a, share, avgShare, often: avgShare ? share / avgShare : 0, grade: gradeVs(s.rating, a.rating, s.n, 15), mine };
  });
}

// Your maps: rating (these filters), rounds won, and whole matches won.
function psMaps(recs, sets) {
  return sets.map((set) => {
    const mine = recs.filter((x) => x.me && x.set === set);
    const s = recStats(mine);
    const ids = new Set(mine.map((x) => x.r.match.id));
    const rows = (ps.sdata?.rows || []).filter((row) => ids.has(row.id));
    return { set, map: set.map, s, matches: ids.size, w: rows.filter((row) => row.result === "win").length, l: rows.filter((row) => row.result === "loss").length,
      grade: s.n >= 40 ? ((g) => ({ g, word: RATE_GRADES[g] }))(`g${gradeOf("rating", s.rating)}`) : null };
  }).filter((m) => m.s.n >= 20).sort((a, b) => b.s.rating - a.s.rating);
}

// Your positions on one map and side: how you do at each against the average player there.
function psPositions(recs, set, S) {
  const mine = recs.filter((x) => x.me && x.set === set && x.S === S);
  const byPos = new Map();
  for (const o of recs) if (!o.me && o.set === set && o.S === S && o.pos >= 0) { if (!byPos.has(o.pos)) byPos.set(o.pos, []); byPos.get(o.pos).push(o); }
  return groupBy(mine.filter((x) => x.pos >= 0), (x) => x.pos).map(([pos, list]) => {
    const s = recStats(list), a = recStats(byPos.get(pos) || []);
    return { set, S, pos, list, name: areaName(set.L, set.map, set.D.places[pos]), s, a, share: list.length / mine.length, grade: gradeVs(s.rating, a.rating, s.n, 10) };
  }).filter((g) => g.s.n >= 5 && g.a.n >= 20).sort((a, b) => (b.grade?.rel ?? -1) - (a.grade?.rel ?? -1) || b.s.n - a.s.n);
}

// Kinds of duel: [key, group, name, what it means, test, tip, options]. Only duels you both saw
// coming count, except `fights` (opening duels count every first kill, as usual).
const DUEL_GROUPS = ["How the fight started", "Your weapon", "Range and height", "Moments", "Utility, health and the first hit"];
const DUEL_BUCKETS = [
  ["peeked", 0, "You peeked them", "you moved into an enemy holding still", (d) => d.start === "peeked", "Peeking a held angle gives the holder the edge. Jiggle-peek for info first, peek off a flash, or swing together with a teammate so they can't hold one spot."],
  ["held", 0, "They peeked you", "you held still, they moved into you", (d) => d.start === "held", "Holding: keep your crosshair where their head will appear and don't move it. Play off-angles so they can't pre-aim you, and change spots between rounds."],
  ["both", 0, "Both moving", "you ran into each other", (d) => d.start === "both", "When you're both moving, whoever stops and shoots first wins: counter-strafe (tap the opposite key) before the shot."],
  ["still", 0, "Standoff", "you were both holding still", (d) => d.start === "still", "In a standoff, tap the head and don't stay in the open; if you miss, re-peek from somewhere else."],
  ["rifle", 1, "Rifles", "AK, M4, FAMAS, Galil, AUG, SG", (d) => d.wclass === "rifle", "Rifle duels: work on first-bullet accuracy and the first 5-10 bullets of the spray (Practice tab: recoil maps)."],
  ["awp", 1, "AWP", "every AWP duel", (d) => d.wclass === "awp", "AWP: hold one angle without moving the crosshair, and reposition after every shot."],
  ["awp_hold", 1, "AWP holding an angle", "you still with the AWP, they peeked", (d) => d.wclass === "awp" && d.start === "held", "Holding with the AWP: crosshair exactly where they appear, off the common pre-aim spot; shoot as they appear instead of following them."],
  ["awp_peek", 1, "AWP peeking", "you moved into them with the AWP", (d) => d.wclass === "awp" && d.start === "peeked", "Peeking with the AWP: quick-peek for a shot or info and get back, peek off a flash, and don't re-peek the same angle."],
  ["pistol", 1, "Pistols", "", (d) => d.wclass === "pistol", "Pistol duels: one or two taps at the head beat spraying. Move between shots, stop to shoot."],
  ["pistol_long", 1, "Pistols at long range", "1,500+ units", (d) => d.wclass === "pistol" && d.dist >= 1500, "Long range with a pistol: stand still and tap the head, or don't take the fight: get closer or wait for them."],
  ["smg", 1, "SMGs", "", (d) => d.wclass === "smg", "SMGs win up close and on the move; avoid long angles with them."],
  ["close", 2, "Close range", "under 600 units", (d) => d.dist > 0 && d.dist < 600, "Up close, crosshair placement at head height and not over-peeking win fights. Hold tighter angles so they come to you."],
  ["mid", 2, "Mid range", "600 to 1,500 units", (d) => d.dist >= 600 && d.dist < 1500, "At mid range, stop fully before you shoot (counter-strafe) and tap or burst instead of spraying."],
  ["long", 2, "Long range", "1,500+ units", (d) => d.dist >= 1500, "At long range, tap the head with a rifle and don't move while shooting. Avoid long fights with SMGs and pistols."],
  ["above", 2, "You had height", "you were above them", (d) => d.height > 64, ""],
  ["below", 2, "They had height", "they were above you", (d) => d.height < -64, "When enemies are above you, pre-aim higher and use utility to take the high ground away."],
  ["opening", 3, "Opening duels", "the round's first kill", (d) => d.opening, "Opening duels: take them with a flash or a teammate ready to trade; don't dry-peek alone.", { fights: true, standard: "open" }],
  ["t_clear", 3, "T: clearing spots", "you peeked a CT holding an angle, before the plant", (d) => d.side === "T" && d.start === "peeked" && !d.afterPlant, "Clearing spots: check the common spots one at a time (slice the pie) with your crosshair already there, flash before you swing, and have a teammate close enough to trade."],
  ["ct_hold", 3, "CT: holding a push", "a T peeked you, before the plant", (d) => d.side === "C" && d.start === "held" && !d.afterPlant, "Holding as CT: play an angle they don't pre-aim, fall back after the first contact, and let utility slow them down."],
  ["ct_push", 3, "CT: pushing or re-peeking", "you peeked a still T, before the plant", (d) => d.side === "C" && d.start === "peeked" && !d.afterPlant, "Aggressive CT plays: do them early with a flash and get out. Re-peeking the angle you just fought from usually loses."],
  ["afterplant", 3, "After the plant", "T side", (d) => d.afterPlant && d.side === "T", "Afterplants: play crossfires on the bomb with a teammate and use time; you don't need to peek."],
  ["retake", 3, "Retakes", "CT side", (d) => d.afterPlant && d.side === "C", "Retakes: wait for teammates and use utility together instead of going in one by one."],
  ["clutch", 3, "Last one alive", "", (d) => d.alone, "In clutches, take one fight at a time and use sound; isolate duels instead of being seen by two."],
  ["moving_target", 3, "Moving enemies", "they were running", (d) => d.theirSpeed > 130, "Moving targets: lead slightly and keep the crosshair at head height as they cross, instead of flicking after them."],
  ["me_flashed", 4, "You were flashed", "an enemy flash got you", (d) => d.myUtil & UTIL.flashed, "Flashed: turn away or back off and wait it out instead of taking the fight blind. Listen for the flash and turn before it pops."],
  ["me_mollied", 4, "After a molly on you", "an enemy molotov landed by you", (d) => d.myUtil & UTIL.molly, "Mollied out: don't come out where they expect; move to a different angle or fall back."],
  ["them_flashed", 4, "They were flashed", "your team's flash got them", (d) => d.theirUtil & UTIL.flashed, ""],
  ["me_hurt", 4, "You were hurt", "under 50 HP as it started", (d) => d.fight && d.myHp > 0 && d.myHp < 50, "Hurt: avoid taking fights until a teammate can trade, or play a close angle where one hit is enough."],
  ["them_hurt", 4, "They were hurt", "under 50 HP", (d) => d.fight && d.theirHp > 0 && d.theirHp < 50, ""],
  ["hit_first", 4, "You hit first", "you landed the first hit", (d) => d.firstHit === "me", "You hit first and still lost: keep your crosshair on them after the first hit instead of stopping to check, and control the spray."],
  ["hit_second", 4, "They hit first", "they landed the first hit", (d) => d.firstHit === "them", "When they hit you first, get out of their sight or fight back right away; standing still makes it worse."],
];

// The duel finder: your duels of one kind, from the choices.
const FIND_DIMS = [
  ["side", [["", "Any side"], ["T", "T side"], ["C", "CT side"]], (d, v) => d.side === v],
  ["gun", [["", "Any weapon"], ["rifle", "Rifle"], ["awp", "AWP"], ["pistol", "Pistol"], ["smg", "SMG"], ["scout", "Scout"], ["heavy", "Shotgun"]], (d, v) => d.wclass === v],
  ["range", [["", "Any range"], ["close", "Close"], ["mid", "Mid range"], ["long", "Long range"]], (d, v) => (v === "close" ? d.dist > 0 && d.dist < 600 : v === "mid" ? d.dist >= 600 && d.dist < 1500 : d.dist >= 1500)],
  ["start", [["", "Any start"], ["peeked", "You peeked"], ["held", "They peeked you"], ["both", "Both moving"], ["still", "Standoff"]], (d, v) => d.start === v],
  ["util", [["", "Any utility"], ["none", "No utility"], ["me_flashed", "You were flashed"], ["me_mollied", "Molly on you"], ["them_flashed", "They were flashed"]], (d, v) => (v === "none" ? !d.myUtil && !d.theirUtil : v === "me_flashed" ? d.myUtil & UTIL.flashed : v === "me_mollied" ? d.myUtil & UTIL.molly : d.theirUtil & UTIL.flashed)],
  ["kind", [["", "Any round"], ["pistol", "Pistol round"], ["eco", "Eco"], ["force", "Force buy"], ["full", "Full buy"]], (d, v) => d.kind === v],
  ["sit", [["", "Any moment"], ["opening", "Opening duel"], ["before", "Before the plant"], ["afterplant", "After the plant"], ["clutch", "Last alive"]], (d, v) => (v === "opening" ? d.opening : v === "before" ? !d.afterPlant : v === "afterplant" ? d.afterPlant : d.alone)],
];
const findTest = (find) => (d) => FIND_DIMS.every(([key, , test]) => !find[key] || test(d, find[key]));

async function renderPlaystyle(view, map) {
  const idx = await loadInsightsIndex();
  const maps = Object.entries(idx?.maps || {}).filter(([, c]) => c.matches > 0).sort((a, b) => b[1].matches - a[1].matches);
  if (!maps.length) {
    const waiting = sum(Object.values(idx?.maps || {}).map((c) => c.waiting || 0));
    view.innerHTML = `<div class="gn-head"><div><div class="h1">Playstyle</div><div class="sub">Your roles, your duels, your best and worst positions, from every round you played.</div></div></div>
      <div class="empty">Not ready yet. Veloxify is re-reading your demos for this in the background${waiting ? ` (${waiting} matches to go)` : ""}, while CS2 is closed.</div>`;
    return;
  }
  if (map) ps.map = map;
  if (ps.map !== "all" && !idx.maps[ps.map]) ps.map = "all";
  const want = ps.map === "all" ? maps.map(([m]) => m) : [ps.map];
  const [list, Ls] = await Promise.all([Promise.all(want.map((m) => loadInsights(m))), Promise.all(want.map((m) => loadMapLineups(m))), loadCallouts()]);
  const sets = list.map((D, i) => (D ? { D, map: want[i], L: Ls[i] || {}, rounds: D.rounds.filter((r) => r.match.me >= 0 && (ps.src === "all" || r.match.source === ps.src) && (ps.side === "all" || r.sides[r.match.me] === ps.side)) } : null)).filter(Boolean);
  ps.sdata = await loadSessionData();
  const waiting = sum(Object.values(idx?.maps || {}).map((c) => c.waiting || 0));
  psPage(view, maps, sets, waiting);
}

function psPage(view, maps, sets, waiting = 0) {
  const rerender = () => { savePs(); psPage(view, maps, sets, waiting); };
  const rounds = sets.flatMap((s) => s.rounds);
  const everyone = allDuels(sets);
  const fightsMine = everyone.filter((d) => d.who === "me"), fightsOthers = everyone.filter((d) => d.who !== "me");
  const duels = fightsMine.filter((d) => d.duel), others = fightsOthers.filter((d) => d.duel);
  const withFights = fightsMine.filter((d) => d.fight).length;
  const W = duels.filter((d) => d.won).length, Lo = duels.length - W;
  const othersOverall = others.length ? others.filter((d) => d.won).length / others.length : 0.5;
  const recs = psRecords(sets);
  const roles = psRoleStats(recs);
  const sideStats = ["T", "C"].map((S) => ({ S, s: recStats(recs.filter((x) => x.me && x.S === S)), a: recStats(recs.filter((x) => !x.me && x.S === S)) }));
  const oneMap = sets.length === 1 ? sets[0] : null;
  const shownSides = ps.side === "all" ? ["T", "C"] : [ps.side];
  const positions = sets.flatMap((set) => shownSides.flatMap((S) => psPositions(recs, set, S)));
  const mapRows = ps.map === "all" ? psMaps(recs, sets) : [];
  // Each kind of duel: your win rate against the average player's (everyone else in your matches).
  const buckets = DUEL_BUCKETS.map(([key, group, name, sub, test, tip, opts = {}]) => {
    const ds = (opts.fights ? fightsMine : duels).filter(test), w = ds.filter((d) => d.won).length;
    const os = (opts.fights ? fightsOthers : others).filter(test), avg = os.length >= 30 ? os.filter((d) => d.won).length / os.length : null;
    return { key, group, name, sub, tip, ds, w, n: ds.length, rate: ds.length ? w / ds.length : 0, avg, grade: gradeRate(w, ds.length, avg, opts.standard || null) };
  }).filter((b) => b.n >= 6);
  const strong = buckets.filter((b) => isGood(b.grade)).sort((a, b) => b.grade.z - a.grade.z);
  const weak = buckets.filter((b) => isBad(b.grade)).sort((a, b) => a.grade.z - b.grade.z);
  // When nothing's below average: the kinds of duel where you're closest to (or under) it.
  const least = weak.length ? [] : buckets.filter((b) => b.grade && b.n >= 30 && b.tip).sort((a, b) => (a.rate - a.avg) - (b.rate - b.avg)).slice(0, 2);
  const sel = buckets.find((b) => b.key === ps.bucket) || null;
  // Caught off guard: deaths while you were looking the other way.
  const md = fightsMine.filter((d) => d.fight && !d.won), od = fightsOthers.filter((d) => d.fight && !d.won);
  const caught = { n: md.length, k: md.filter((d) => d.offGuard).length, avg: od.length ? od.filter((d) => d.offGuard).length / od.length : null, list: md.filter((d) => d.offGuard) };
  caught.grade = md.length >= 30 ? gradeVs(caught.k / md.length, caught.avg, md.length, 30, true) : null;
  const mk = fightsMine.filter((d) => d.fight && d.won), ok = fightsOthers.filter((d) => d.fight && d.won);
  const surprised = { n: mk.length, k: mk.filter((d) => d.offGuard).length, avg: ok.length ? ok.filter((d) => d.offGuard).length / ok.length : null };
  // The duel finder.
  const finder = findTest(ps.find || {});
  const found = duels.filter(finder), foundAvg = others.filter(finder);
  const findB = { key: "find", name: "Your search", sub: "", tip: "", ds: found, w: found.filter((d) => d.won).length, n: found.length };
  findB.rate = findB.n ? findB.w / findB.n : 0;
  findB.avg = foundAvg.length >= 20 ? foundAvg.filter((d) => d.won).length / foundAvg.length : null;
  findB.grade = gradeRate(findB.w, findB.n, findB.avg);
  const finding = Object.values(ps.find || {}).some(Boolean);
  const profile = psProfile({ roles, sideStats, buckets, positions, mapRows, caught, oneMap });

  const segBtns = (key, opts, val) => opts.map(([k, l]) => `<button data-${key}="${k}" class="${String(val) === String(k) ? "on" : ""}">${l}</button>`).join("");
  const pct = (v) => (v == null ? "—" : `${Math.round(v * 100)}%`);
  const bar = (b) => `<span class="ps-bar" title="Your ${Math.round(b.rate * 100)}%${b.avg != null ? ` · the average player in your matches: ${Math.round(b.avg * 100)}% (the white line)` : ""}"><i style="width:${Math.round(b.rate * 100)}%" class="${isGood(b.grade) ? "good" : isBad(b.grade) ? "bad" : ""}"></i>${b.avg != null ? `<b style="left:${Math.round(b.avg * 100)}%"></b>` : ""}</span>`;
  const bucketBtn = (b) => `<button class="ps-bucket ${sel?.key === b.key ? "on" : ""}" data-bucket="${b.key}"><span class="ps-bucket-name"><b>${esc(b.name)}</b>${b.sub ? `<span class="sub">${esc(b.sub)}</span>` : ""}</span>${bar(b)}<span class="ps-bucket-n">${pctOf(b.w, b.n)}%<small>${b.avg != null ? `avg ${Math.round(b.avg * 100)}% · ` : ""}${b.w}-${b.n - b.w}</small></span>${gradeChip(b.grade)}</button>`;
  const swItem = (b, tip) => `<div class="ps-sw-item" data-bucket="${b.key}">${gradeChip(b.grade)} <b>${esc(b.name)}</b>: you win <b>${pctOf(b.w, b.n)}%</b> <span class="sub">(the average player ${Math.round(b.avg * 100)}%, ${b.n} duels)</span>${tip && b.tip ? `<div class="ps-tip">${esc(b.tip)}</div>` : ""}</div>`;
  // Your rating against the average player's in the same role or spot: "+12%" (raw ratings in
  // small print: they run above or below 1.00 depending on the kind of rounds the role is in).
  const relRating = (x) => {
    if (x.s.rating == null || !x.a.rating) return "—";
    const rel = Math.round(100 * (x.s.rating / x.a.rating - 1));
    return `<span class="${rel >= 5 ? "up" : rel <= -5 ? "down" : ""}">${rel > 0 ? "+" : rel < 0 ? "−" : "±"}${Math.abs(rel)}%</span> <small class="sub">${f2(x.s.rating)} vs ${f2(x.a.rating)}</small>`;
  };
  const roleRow = (r) => `<tr class="${isGood(r.grade) ? "good" : isBad(r.grade) ? "bad" : ""}"><td><b>${esc(r.name)}</b><div class="sub">${esc(r.how)}</div></td>
    <td>${r.s.n ? `${pct(r.share)} <small class="sub">avg ${pct(r.avgShare)}</small>` : `<span class="sub">never</span>`}</td>
    <td>${r.s.n >= 5 ? relRating(r) : "—"}</td>
    <td>${r.s.n >= 5 ? vsAvg(r.s.kpr, r.a.kpr, f2) : "—"}</td>
    <td>${r.s.n >= 5 ? vsAvg(r.s.surv, r.a.surv, pct) : "—"}</td>
    <td>${gradeChip(r.grade)}</td></tr>`;
  const roleGroup = (title, side) => {
    const list = roles.filter((r) => r.side === side && (ps.side === "all" || !side || side === ps.side));
    return list.length ? `<tr class="ps-group"><td colspan="6">${title}</td></tr>${list.map(roleRow).join("")}` : "";
  };
  const posRow = (g, withMap = false) => `<tr class="ps-pos-row ${isGood(g.grade) ? "good" : isBad(g.grade) ? "bad" : ""} ${ps.pos === `${g.set.map}|${g.S}|${g.pos}` ? "on" : ""}" data-pos="${esc(`${g.set.map}|${g.S}|${g.pos}`)}">
    <td><b>${esc(g.name)}</b>${withMap ? ` <span class="sub">${esc(mapName(g.set.map))} ${SIDE_NAME[g.S]}</span>` : ""}</td>
    <td>${g.s.n} <small class="sub">${pct(g.share)}</small></td>
    <td>${relRating(g)}</td><td>${vsAvg(g.s.kpr, g.a.kpr, f2)}</td><td>${vsAvg(g.s.surv, g.a.surv, pct)}</td>
    <td>${vsAvg(g.s.adr, g.a.adr, (v) => Math.round(v))}</td><td>${gradeChip(g.grade)}</td></tr>`;
  const posHead = `<thead><tr><th>Position</th><th>Your rounds</th><th title="Your rating in those rounds against the average player's at the same spot">Rating vs others there</th><th>Kills a round</th><th>Survived</th><th>ADR</th><th></th></tr></thead>`;
  const selPos = positions.find((g) => `${g.set.map}|${g.S}|${g.pos}` === ps.pos) || null;
  const survRow = (label, key, fmt, lowerBetter, hint) => `<tr><td>${label}${hint ? `<div class="sub">${hint}</div>` : ""}</td>${sideStats.filter((x) => shownSides.includes(x.S)).map(({ s, a }) => {
    if (!s.n) return "<td>—</td>";
    const g = gradeVs(s[key], a[key], s.n, 30, lowerBetter);
    return `<td>${vsAvg(s[key], a[key], fmt, lowerBetter)} ${gradeChip(g)}</td>`;
  }).join("")}</tr>`;
  const better = (() => {
    const [t, c] = sideStats;
    if (!t.s.n || !c.s.n || ps.side !== "all") return null;
    const rt = t.s.rating / (t.a.rating || 1), rc = c.s.rating / (c.a.rating || 1);
    return rt > rc + 0.05 ? "T" : rc > rt + 0.05 ? "CT" : null;
  })();

  view.innerHTML = `
    <div class="ins-head"><div><div class="h1">Playstyle</div>
      <div class="sub">From ${rounds.length} rounds you played in ${new Set(rounds.map((r) => r.match.id)).size} matches${ps.map !== "all" ? ` on ${esc(mapName(ps.map))}` : ""}. Who you are as a player, your best and worst maps and positions, and the duels you win and lose. Everything is compared with the average player in your matches.</div></div></div>
    <div class="ins-maps"><a class="ins-map ${ps.map === "all" ? "on" : ""}" href="#/playstyle/all"><b>All maps</b></a>${maps.map(([m, c]) => `<a class="ins-map ${m === ps.map ? "on" : ""}" href="#/playstyle/${esc(m)}">${mapIcon(m)}<b>${esc(mapName(m))}</b><span class="sub">${c.matches}</span></a>`).join("")}</div>
    <div class="ln-bar ins-filters"><div class="seg">${segBtns("side", [["all", "Both sides"], ["T", "T side"], ["C", "CT side"]], ps.side)}</div>
      <div class="seg">${segBtns("src", [["all", "All"], ["faceit", "FACEIT"], ["valve", "Premier"]], ps.src)}</div></div>
    ${waiting ? `<div class="note">Veloxify is re-reading ${waiting} of your matches for the new duel details (who peeked, flashes, mollies), in the background while CS2 is closed. Until then those matches show without them.</div>` : ""}
    ${!rounds.length ? `<div class="empty">No rounds with these filters.</div>` : `
    <section class="panel ps-profile"><div class="panel-head"><div class="h3">Your profile</div><span class="grow"></span><span class="sub">The short version: what you are, and where you're best and worst</span></div>
      <ul class="sv-facts">${profile.map(([cls, html]) => `<li class="${cls}">${html}</li>`).join("") || `<li>Not enough rounds yet.</li>`}</ul></section>
    ${psLately(ps.sdata)}
    <div class="ps-grid">
      <section class="panel"><div class="panel-head"><div class="h3">Your roles</div><span class="grow"></span><span class="sub">How often you play each, and how well against the average player in that role</span></div>
        <table class="ins-table ps-roles-t"><thead><tr><th>Role</th><th>How often</th><th title="Your rating in those rounds against the average player's in the same role">Rating vs the role</th><th>Kills a round</th><th>Survived</th><th></th></tr></thead><tbody>
          ${roleGroup("T side", "T")}${roleGroup("CT side", "C")}${roleGroup("Weapon", "")}</tbody></table>
        <div class="note" style="padding:0 20px 14px;margin:0">Rating vs the role: your rating in those rounds against the average player's in the same role (+10% is 10% better). The raw ratings (HLTV Rating 1.0, small print) run above or below 1.00 because roles come in different kinds of rounds: you're only the entry when your team gets into a site, so everyone's rating in entry rounds is high, and that's why each role is compared with itself. Small numbers elsewhere: the average player in the same role.</div></section>
      <section class="panel"><div class="panel-head"><div class="h3">T or CT? Staying alive</div><span class="grow"></span>${better ? `<span class="tag main">Better on ${better}</span>` : ""}</div>
        <table class="ins-table ps-sides"><thead><tr><th></th>${shownSides.map((S) => `<th>${SIDE_NAME[S]} side</th>`).join("")}</tr></thead><tbody>
          <tr><td>Rounds</td>${sideStats.filter((x) => shownSides.includes(x.S)).map(({ s }) => `<td>${s.n}</td>`).join("")}</tr>
          ${survRow("Rating", "rating", f2, false)}
          ${survRow("Kills per round", "kpr", f2, false)}
          ${survRow("Damage per round", "adr", (v) => Math.round(v), false)}
          ${survRow("Opening duels won", "open", pct, false)}
          ${survRow("Survived", "surv", pct, false)}
          ${survRow("First of your team to die", "first", pct, true, "dying too early")}
          ${survRow("Died without a trade", "untraded", pct, true, "nobody got your killer back within 5 s")}
          ${survRow("Time alive", "alive", (v) => `${Math.round(v)} s`, false, "seconds into the round, on average")}
          ${survRow("Rounds won", "win", pct, false)}</tbody></table>
        <div class="note" style="padding:0 20px 14px;margin:0">Small numbers: the average player on that side in your matches. Green is better than them, red worse.</div></section>
    </div>
    ${mapRows.length > 1 ? `<section class="panel"><div class="panel-head"><div class="h3">Your maps</div><span class="grow"></span><span class="sub">Best first${ps.side !== "all" ? `, ${SIDE_NAME[ps.side]} side only` : ""}</span></div>
      <table class="ins-table ps-maps"><thead><tr><th>Map</th><th>Matches</th><th>Rating</th><th>Kills a round</th><th>ADR</th><th>Survived</th><th>Rounds won</th><th></th></tr></thead><tbody>
        ${mapRows.map((m, i) => `<tr class="${i === 0 ? "good" : i === mapRows.length - 1 ? "bad" : ""}"><td><a class="ps-map-link" href="#/playstyle/${esc(m.map)}">${mapIcon(m.map)}<b>${esc(mapName(m.map))}</b></a></td>
          <td>${m.matches} <small class="sub">${m.w}-${m.l}</small></td><td><b>${f2(m.s.rating)}</b></td><td>${f2(m.s.kpr)}</td><td>${Math.round(m.s.adr)}</td><td>${pct(m.s.surv)}</td><td>${pct(m.s.win)}</td><td>${gradeChip(m.grade)}</td></tr>`).join("")}</tbody></table></section>` : ""}
    <section class="panel"><div class="panel-head"><div class="h3">${oneMap ? `Your positions on ${esc(mapName(oneMap.map))}` : "Your best and worst positions"}</div><span class="grow"></span><span class="sub">Where you played the round (the callout you spent the most time in), against the average player there</span></div>
      ${oneMap ? shownSides.map((S) => { const list = positions.filter((g) => g.S === S); return `<div class="h3 ins-sub">${SIDE_NAME[S]} side</div>${list.length ? `<table class="ins-table ps-pos">${posHead}<tbody>${list.map((g) => posRow(g)).join("")}</tbody></table>` : `<div class="sub" style="padding:0 20px 12px">Not enough rounds yet.</div>`}`; }).join("")
        : (() => { const graded = positions.filter((g) => g.grade && g.s.n >= 15); const best = graded.filter((g) => g.grade.rel > 0).sort((a, b) => b.grade.rel - a.grade.rel).slice(0, 6); const worst = graded.filter((g) => g.grade.rel < 0).sort((a, b) => a.grade.rel - b.grade.rel).slice(0, 6);
          return `<div class="h3 ins-sub ps-good">Best</div>${best.length ? `<table class="ins-table ps-pos">${posHead}<tbody>${best.map((g) => posRow(g, true)).join("")}</tbody></table>` : `<div class="sub" style="padding:0 20px 12px">Nothing clearly above the average player yet.</div>`}
            <div class="h3 ins-sub ps-bad">Worst</div>${worst.length ? `<table class="ins-table ps-pos">${posHead}<tbody>${worst.map((g) => posRow(g, true)).join("")}</tbody></table>` : `<div class="sub" style="padding:0 20px 12px">Nothing below the average player.</div>`}
            <div class="note" style="padding:0 20px 14px;margin:0">Pick a map above to see all your positions on it.</div>`; })()}
      ${selPos ? psPosRounds(selPos) : `<div class="sub" style="padding:0 20px 16px">Click a position to see those rounds and open them in the 2D replay.</div>`}
    </section>
    <section class="panel"><div class="panel-head"><div class="h3">Your duels</div><span class="grow"></span><span class="sub">${W} won, ${Lo} lost: <b>${pctOf(W, duels.length)}%</b> ${gradeChip(gradeRate(W, duels.length, othersOverall, "duels"))} (the average player in your matches: ${Math.round(othersOverall * 100)}%)</span></div>
      <div class="ps-def">A duel is a fight you both saw coming: you won it if you got the kill, lost it if they did. Dying while you were looking the other way isn't a duel lost, it's being caught off guard (below). The white line on each bar is the average player.${withFights < fightsMine.length ? ` <span class="sub">${fightsMine.length - withFights} of your fights are from matches not re-read yet: they count as duels, without who peeked or utility.</span>` : ""}</div>
      ${caught.n >= 20 ? `<div class="ps-caught ${isBad(caught.grade) ? "bad" : isGood(caught.grade) ? "good" : ""}"><b>Caught off guard:</b> ${caught.k} of your ${caught.n} deaths (${pctOf(caught.k, caught.n)}%) came while you were looking the other way <span class="sub">(the average player ${pct(caught.avg)})</span> ${gradeChip(caught.grade)}
        ${isBad(caught.grade) ? `<div class="ps-tip">Check the spots you pass with your crosshair, listen for footsteps, and don't turn your back on an angle that isn't cleared.</div>` : ""}
        <div class="sub">You caught them off guard in ${pctOf(surprised.k, surprised.n)}% of your kills (the average player ${pct(surprised.avg)}).</div></div>` : ""}
      <div class="ps-sw">
        <div><div class="h3 ps-good">Strengths</div>${strong.slice(0, 4).map((b) => swItem(b, false)).join("") || `<div class="sub">Nothing clearly above the average player yet.</div>`}</div>
        <div><div class="h3 ps-bad">Weaknesses</div>${weak.slice(0, 4).map((b) => swItem(b, true)).join("")
          || `<div class="sub">Nothing below the average player. Your least strong, where there's most to gain:</div>${least.map((b) => swItem(b, true)).join("")}`}</div>
      </div>
      <div class="ps-find"><span class="h3">Find a kind of duel</span>${FIND_DIMS.map(([key, opts]) => `<select data-find="${key}">${opts.map(([v, l]) => `<option value="${v}" ${(ps.find?.[key] || "") === v ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`).join("")}
        ${finding ? `<button class="btn ghost" data-find-clear>Clear</button>` : ""}</div>
      ${finding ? `<div class="ps-buckets ps-found">${findB.n ? bucketBtn({ ...findB, name: "Duels like this", sub: `${findB.n} of yours` }) : `<div class="sub">None of your duels match.</div>`}</div>` : ""}
      ${DUEL_GROUPS.map((g, gi) => { const list = buckets.filter((b) => b.group === gi); return list.length ? `<div class="h3 ins-sub">${esc(g)}</div><div class="ps-buckets">${list.map(bucketBtn).join("")}</div>` : ""; }).join("")}
      ${sel ? psDuelList(sel) : finding && ps.bucket === "find" ? psDuelList(findB) : `<div class="sub" style="padding:0 20px 16px">Click a kind of duel to see every one of them and open it in the 2D replay.</div>`}
    </section>
    ${oneMap ? `<section class="panel"><div class="panel-head"><div class="h3">Where you fight on ${esc(mapName(oneMap.map))}</div><span class="grow"></span><span class="sub">${sel ? esc(sel.name) : "All your duels"} (green: kills, red: deaths)</span></div>
      <div class="ps-spots"><div class="tl-map ps-map"><div class="tl-viewport"><div class="tl-canvas"><img src="${assetUrl(`radars/${oneMap.map}.png`)}" alt="" draggable="false"><svg id="ps-svg" viewBox="0 0 1024 1024"></svg></div></div></div>
        <div>${(() => { const fav = psFavorites(oneMap, ps.side); return fav.length ? `<div class="h3 ins-sub">Where you usually are <span class="sub">at ${clockOf(250)}</span></div><ul class="ins-list">${fav.slice(0, 8).map((f) => `<li><b>${esc(areaName(oneMap.L, oneMap.map, oneMap.D.places[f.pl]))}</b> <span class="sub">${pctOf(f.n, f.of)}% of rounds · you win ${pctOf(f.wins, f.n)}% of them</span></li>`).join("")}</ul>` : ""; })()}</div></div></section>` : ""}`}
    <div class="note">Distances are in game units (a player is about 72 tall). A fight starts with its first hit. You peeked if you got 45 units or more from where you were in the half second before it (a swing out of cover); you held if you stayed put (strafing in place still counts as holding). Positions and roles need 5 or more of your rounds to show and 10 to 15 to be graded.</div>`;

  view.querySelectorAll("[data-side]").forEach((b) => (b.onclick = () => { ps.side = b.dataset.side; renderPlaystyle(view, ps.map); }));
  view.querySelectorAll("[data-src]").forEach((b) => (b.onclick = () => { ps.src = b.dataset.src; renderPlaystyle(view, ps.map); }));
  view.querySelectorAll("[data-bucket]").forEach((b) => (b.onclick = () => { ps.bucket = ps.bucket === b.dataset.bucket ? null : b.dataset.bucket; rerender(); }));
  view.querySelectorAll("[data-pos]").forEach((b) => (b.onclick = () => { ps.pos = ps.pos === b.dataset.pos ? null : b.dataset.pos; rerender(); }));
  view.querySelectorAll("[data-find]").forEach((s) => (s.onchange = () => { ps.find = { ...(ps.find || {}), [s.dataset.find]: s.value }; ps.bucket = "find"; rerender(); }));
  view.querySelector("[data-find-clear]")?.addEventListener("click", () => { ps.find = {}; if (ps.bucket === "find") ps.bucket = null; rerender(); });
  wireRoundList(view);
  if (oneMap) loadRadar(oneMap.map).then((radar) => {
    const svg = view.querySelector("#ps-svg");
    if (!svg || !radar) return;
    const at = (x, y) => [(x - radar.pos_x) / radar.scale, (radar.pos_y - y) / radar.scale];
    const shown = sel ? sel.ds : ps.bucket === "find" ? findB.ds : duels;
    svg.innerHTML = shown.slice(0, 600).map((d) => { const [x, y] = at(d.myPos[0], d.myPos[1]); return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4" class="ps-dot ${d.won ? "won" : "lost"}"/>`; }).join("");
  });
}

// The short version, in sentences: [class, html], good and bad things marked.
function psProfile({ roles, sideStats, buckets, positions, mapRows, caught }) {
  const out = [];
  const pct = (v) => `${Math.round(v * 100)}%`;
  for (const side of ["T", "C"]) {
    const list = roles.filter((r) => r.side === side && r.s.n >= 12);
    if (!list.length) continue;
    const S = SIDE_NAME[side];
    const top = [...list].sort((a, b) => b.often - a.often)[0];
    const by = (r) => Math.abs(Math.round(100 * (r.s.rating / r.a.rating - 1)));
    if (top.often >= 1.15) {
      const g = top.grade, like = ROLE_LIKE[top.key];
      const how = !g ? "" : g.rel >= 0.05 ? `, and you're good at it: <b>${by(top)}% better</b> than the average ${ROLE_NOUN[top.key]}`
        : g.rel <= -0.05 ? `, but you're <b>${by(top)}% worse</b> at it than the average ${ROLE_NOUN[top.key]}`
        : `, about as well as the average ${ROLE_NOUN[top.key]}`;
      out.push([isGood(g) ? "good" : isBad(g) ? "bad" : "", `On ${S} you play most like <b>${like}</b>: ${pct(top.share)} of your ${S} rounds, the average player ${pct(top.avgShare)}${how}.`]);
    } else if (side === "C") {
      // Every CT round is one of these: say which you play most.
      const common = [...list].sort((a, b) => b.share - a.share)[0];
      const VERB = { anchor: "anchor a site", rotator: "rotate between sites", mid: "play mid" };
      const g = common.grade;
      out.push([isGood(g) ? "good" : isBad(g) ? "bad" : "", `On CT you mostly <b>${VERB[common.key]}</b> (${pct(common.share)} of your CT rounds, about as often as the average player)${g ? (g.rel >= 0.05 ? `, <b>${by(common)}% better</b> than the average ${ROLE_NOUN[common.key]}` : g.rel <= -0.05 ? `, <b>${by(common)}% worse</b> than the average ${ROLE_NOUN[common.key]}` : `, about as well as the average ${ROLE_NOUN[common.key]}`) : ""}.`]);
    } else out.push(["", `On ${S} you don't lean to one role: a flexible player.`]);
    const best = list.filter((r) => r.grade && r.key !== top.key && r.grade.rel >= 0.08).sort((a, b) => b.grade.rel - a.grade.rel)[0];
    if (best) out.push(["good", `You're at your best on ${S} as <b>${ROLE_LIKE[best.key]}</b>: <b>${by(best)}% better</b> than the average ${ROLE_NOUN[best.key]} (${best.s.n} rounds).`]);
  }
  // Rifler or AWPer.
  const rifle = roles.find((r) => r.key === "rifle"), awp = roles.find((r) => r.key === "awp");
  if (rifle && awp && rifle.s.n + awp.s.n >= 30) {
    const awpShare = awp.s.n / (rifle.s.n + awp.s.n);
    const kind = awpShare >= 0.4 ? "an <b>AWPer</b>" : awpShare >= 0.15 ? "a <b>rifler who also AWPs</b>" : "a <b>rifler</b>";
    let html = `You're ${kind}: ${pct(1 - awpShare)} of your rifle and AWP rounds are with a rifle`;
    const r = rifle.s.n >= 15 ? rifle : null, a = awp.s.n >= 15 ? awp : null;
    if (r) html += ` (rating ${f2(r.s.rating)}, the average rifler ${f2(r.a.rating)})`;
    if (a) html += `; with the AWP your rating is ${f2(a.s.rating)} (the average AWPer ${f2(a.a.rating)})`;
    out.push(["", `${html}.${r && a && r.grade && a.grade ? (r.grade.rel > a.grade.rel + 0.08 ? " You play better with a rifle." : a.grade.rel > r.grade.rel + 0.08 ? " You play better with the AWP." : "") : ""}`]);
  }
  // Maps.
  // Best and worst map: from maps with 5+ matches.
  const enough = mapRows.filter((m) => m.matches >= 5);
  if (enough.length >= 2) {
    const b = enough[0], w = enough[enough.length - 1];
    out.push(["good", `Your best map is <b>${esc(mapName(b.map))}</b> (rating ${f2(b.s.rating)}, won ${b.w} of ${b.matches} matches).`]);
    out.push(["bad", `Your worst map is <b>${esc(mapName(w.map))}</b> (rating ${f2(w.s.rating)}, won ${w.w} of ${w.matches} matches).`]);
  }
  // Positions.
  const graded = positions.filter((g) => g.grade && g.s.n >= 15);
  const bestPos = graded.filter((g) => g.grade.rel >= 0.1).sort((a, b) => b.grade.rel - a.grade.rel)[0];
  const worstPos = graded.filter((g) => g.grade.rel <= -0.1).sort((a, b) => a.grade.rel - b.grade.rel)[0];
  const posName = (g) => `<b>${esc(g.name)}</b> on ${esc(mapName(g.set.map))} ${SIDE_NAME[g.S]}`;
  const posBy = (g) => Math.abs(Math.round(100 * (g.s.rating / g.a.rating - 1)));
  if (bestPos) out.push(["good", `Your best position: ${posName(bestPos)}, <b>${posBy(bestPos)}% better</b> than the average player there (${bestPos.s.n} rounds).`]);
  if (worstPos) out.push(["bad", `Your weakest position: ${posName(worstPos)}, <b>${posBy(worstPos)}% worse</b> than the average player there (${worstPos.s.n} rounds).`]);
  // Duels.
  const open = buckets.find((b) => b.key === "opening");
  if (open?.grade) out.push([isGood(open.grade) ? "good" : isBad(open.grade) ? "bad" : "", `You win <b>${pctOf(open.w, open.n)}%</b> of your opening duels (the average player ${Math.round(open.avg * 100)}%): <b>${open.grade.word.toLowerCase()}</b>.`]);
  const ranked = buckets.filter((b) => b.grade && b.key !== "opening" && b.n >= 25);
  const bestDuel = ranked.filter((b) => isGood(b.grade)).sort((a, b) => b.grade.z - a.grade.z)[0];
  const worstDuel = ranked.filter((b) => isBad(b.grade)).sort((a, b) => a.grade.z - b.grade.z)[0];
  if (bestDuel) out.push(["good", `Your best duels: <b>${esc(bestDuel.name)}</b> (${bestDuel.sub ? `${esc(bestDuel.sub)}; ` : ""}you win ${pctOf(bestDuel.w, bestDuel.n)}%, the average player ${Math.round(bestDuel.avg * 100)}%).`]);
  if (worstDuel) out.push(["bad", `Your worst duels: <b>${esc(worstDuel.name)}</b> (${worstDuel.sub ? `${esc(worstDuel.sub)}; ` : ""}you win ${pctOf(worstDuel.w, worstDuel.n)}%, the average player ${Math.round(worstDuel.avg * 100)}%).`]);
  // Staying alive.
  for (const { S, s, a } of sideStats) {
    if (s.n < 40) continue;
    const g = gradeVs(s.first, a.first, s.n, 40, true);
    if (isBad(g)) out.push(["bad", `On ${SIDE_NAME[S]} you're the first of your team to die in <b>${pct(s.first)}</b> of rounds (the average player ${pct(a.first)}): you die too early.`]);
    else if (isGood(g)) out.push(["good", `On ${SIDE_NAME[S]} you stay alive well: the first of your team to die in only ${pct(s.first)} of rounds (the average player ${pct(a.first)}).`]);
  }
  if (isBad(caught.grade)) out.push(["bad", `${pctOf(caught.k, caught.n)}% of your deaths come while you're looking the other way (the average player ${pct(caught.avg)}): you get caught off guard more than most.`]);
  return out;
}

// Lately (your last 15 matches against the ones before) and what goes with you playing better:
// across all your matches, whatever the filters above.
function psLately(data) {
  if (!data || data.rows.length < 25) return "";
  const recent = [...data.rows].sort((a, b) => b.ts - a.ts).slice(0, 15).map((r) => r.id);
  const j = judgeSession(data, recent);
  const notice = noticed(data).slice(0, 6);
  const list = (ps) => ps.slice(0, 3).map((p) => `${p.words}${SIZE_WORD(p.z)}`).join(", ");
  const head = !j || j.few ? "" : j.verdict === "good" ? `You're playing <b class="up">${j.pct}% better</b> lately than before.` : j.verdict === "bad" ? `You're playing <b class="down">${Math.abs(j.pct)}% worse</b> lately than before.` : `Lately you're playing about the same as before${Math.abs(j.pct) >= 1 ? ` (${j.pct > 0 ? "+" : ""}${j.pct}%)` : ""}.`;
  return `<div class="ps-grid"><section class="panel"><div class="panel-head"><div class="h3">Lately</div><span class="grow"></span><span class="sub">Your last 15 matches against the ones before (all maps)</span></div>
      <div class="ps-lately">${head ? `<div class="ps-lately-head">${head} <span class="sub">HLTV 3.0 ${f2(j.rating.v)}, before ${f2(j.rating.b)}</span></div>` : ""}
        ${j && !j.few && j.better.length ? `<div><span class="up">Improving:</span> ${list(j.better)}.</div>` : ""}
        ${j && !j.few && j.worse.length ? `<div><span class="down">Slipping:</span> ${list(j.worse)}.</div>` : ""}
        ${j && !j.few && !j.better.length && !j.worse.length ? `<div class="sub">No part of your game has moved clearly either way.</div>` : ""}
        ${j && !j.few ? j.worse.filter((p) => p.z <= -1.5 && SESS_TIPS[p.key]).slice(0, 2).map((p) => `<div class="ps-tip"><b>Work on ${esc(p.words)}:</b> ${esc(SESS_TIPS[p.key])}</div>`).join("") : ""}</div></section>
    <section class="panel"><div class="panel-head"><div class="h3">What helps you</div><span class="grow"></span><span class="sub">What goes with you playing better or worse</span></div>
      <ul class="ps-helps">${notice.map((n) => `<li>${noticedText(n)}</li>`).join("") || `<li class="sub">Nothing stands out clearly yet.</li>`}</ul>
      <div class="note" style="padding:0 20px 14px;margin:0">Compares your HLTV 3.0 across your matches by time of day, how far into a session, who you queued with, map and crosshair. From now on Veloxify also records your resolution, sensitivity and mouse each time you close CS2, and practice you start from the Practice tab; tag sessions in their Notes ("Tired", "New mouse"...) and those show up here too.</div></section></div>`;
}

// A value next to the average player's: colored when clearly better or worse (with a grade for rates).
function vsAvg(v, avg, fmt, lowerBetter = false, n = 0, standard = null) {
  if (v == null) return "—";
  if (avg == null) return fmt(v);
  const rel = avg ? (v - avg) / Math.abs(avg) : 0, good = lowerBetter ? rel < -0.05 : rel > 0.05, bad = lowerBetter ? rel > 0.05 : rel < -0.05;
  const g = n ? gradeRate(Math.round(v * n), n, avg, standard) : standard ? ((x) => ({ g: x, word: RATE_GRADES[x] }))(`g${gradeOf(standard, v)}`) : null;
  return `<span class="${good ? "up" : bad ? "down" : ""}">${fmt(v)}</span> <small class="sub">avg ${fmt(avg)}</small>${g ? ` <span class="ps-grade ${g.g}">${g.word}</span>` : ""}`;
}

// One kind of duel, newest first, each opening its round in the 2D replay.
function psDuelList(b) {
  const rows = [...b.ds].sort((a, x) => x.r.match.ts - a.r.match.ts || x.t - a.t).slice(0, 40);
  const START = { peeked: "you peeked", held: "they peeked you", both: "both moving", still: "standoff" };
  return `<div class="ps-duels"><div class="h3 ins-sub">${esc(b.name)} <span class="sub">${b.n} duels${b.n > rows.length ? `, newest ${rows.length}` : ""}</span></div>
    ${rows.map((d) => `<button class="ins-round" data-rmatch="${esc(d.r.match.id)}" data-rnum="${d.r.n}" title="Open the round in the 2D replay">
      <span class="${d.won ? "up" : "down"}">${d.won ? "Won" : "Lost"}</span><span>${esc(mapName(d.D.map))} · ${new Date(d.r.match.ts * 1000).toLocaleDateString([], { month: "short", day: "numeric" })} · round ${d.r.n} · ${clockOf(d.t)}</span>
      <span class="sub">${esc(d.myWeapon ? weaponName(d.myWeapon) : "?")} vs ${esc(d.theirWeapon ? weaponName(d.theirWeapon) : "?")} · ${d.dist} units${d.start ? ` · ${START[d.start]}` : ""}${d.myUtil & UTIL.flashed ? " · you were flashed" : ""}${d.myUtil & UTIL.molly ? " · molly on you" : ""}${d.theirUtil & UTIL.flashed ? " · they were flashed" : ""}${d.fight && d.myHp < 100 && d.myHp > 0 ? ` · you had ${d.myHp} HP` : ""}${d.offGuard ? (d.won ? " · they were looking away" : " · you were looking away") : ""}${d.hs ? " · headshot" : ""}</span></button>`).join("")}</div>`;
}

// The rounds you played at one position, newest first.
function psPosRounds(g) {
  const rows = [...g.list].sort((a, b) => b.r.match.ts - a.r.match.ts || b.r.n - a.r.n).slice(0, 20);
  return `<div class="ps-duels"><div class="h3 ins-sub">${esc(g.name)} <span class="sub">${esc(mapName(g.set.map))} ${SIDE_NAME[g.S]} · ${g.s.n} rounds, round won ${pctOf(Math.round(g.s.win * g.s.n), g.s.n)}%${g.s.n > rows.length ? ` · newest ${rows.length}` : ""}</span></div>
    ${rows.map((x) => `<button class="ins-round" data-rmatch="${esc(x.r.match.id)}" data-rnum="${x.r.n}" title="Open the round in the 2D replay">
      <span class="${x.win ? "up" : "down"}">${x.win ? "Won" : "Lost"}</span><span>${new Date(x.r.match.ts * 1000).toLocaleDateString([], { month: "short", day: "numeric" })} · round ${x.r.n}${((k) => (k ? ` · ${{ pistol: "pistol round", eco: "eco", force: "force buy", full: "full buy" }[k] || k}` : ""))(x.r.kind?.[x.S === "T" ? 0 : 1])}</span>
      <span class="sub">${x.k} kill${x.k === 1 ? "" : "s"}, ${Math.round(x.dmg)} damage · ${x.died ? `died at ${clockOf(x.dt)}${x.first ? " (first of your team)" : ""}${x.traded ? ", traded" : ""}` : "survived"}</span></button>`).join("")}</div>`;
}

// Where you usually are 25 seconds in, on one map.
function psFavorites(set, side) {
  const by = new Map();
  const rounds = set.rounds.filter((r) => side === "all" || r.sides[r.match.me] === side);
  for (const r of rounds) {
    const pl = placeAt(r, r.match.me, 250);
    if (pl < 0) continue;
    const e = by.get(pl) || { pl, n: 0, wins: 0, of: rounds.length };
    e.n++;
    if (r.win === r.sides[r.match.me]) e.wins++;
    by.set(pl, e);
  }
  return [...by.values()].sort((a, b) => b.n - a.n);
}

// ---- mechanics --------------------------------------------------------------------------------------

// Mechanics: how good your movement, aim, utility and gamesense are, stat by stat and match by
// match, against the average player in your matches. Leetify-style cards: a chart per stat (green
// where you beat the average, red where you fall short), this period against the one before, a
// grade and how to improve. Each section gets a score: 50 is the average player in your matches.
const mech = { n: 30, map: "all", src: "all" };
try { Object.assign(mech, JSON.parse(localStorage.getItem("veloxify.mechanics") || "{}")); } catch (e) { /* defaults */ }
const saveMech = () => { try { localStorage.setItem("veloxify.mechanics", JSON.stringify(mech)); } catch (e) { /* not saved */ } };

const mPct = (v) => `${Math.round(v)}%`;
const mPct1 = (v) => `${v.toFixed(1)}%`;
const mMs = (v) => `${Math.round(v)} ms`;
// Stats per section. `src` "stats": from each match's analysis (my_stats.json, compared with every
// player-match in your library); "game": from the match insights (every player in your matches).
const MECH_SECTIONS = [
  { key: "movement", name: "Movement", icon: "⇄", blurb: "Stopping to shoot with rifles and snipers. SMGs, pistols and shotguns are run-and-gun guns, so they don't count.", stats: [
    { key: "first_stop", name: "First bullet stopped", fmt: mPct, what: "The first bullet of each fight with a rifle or sniper, fired stopped (under 34% of the gun's top speed). Fired on the move, it goes wide.",
      tip: "Stop before the first bullet: tap the opposite movement key, then click. When contact surprises you mid-run, stop first, then shoot.", practice: "aimbotz" },
    { key: "stop_ms", name: "Time to stop", fmt: mMs, lower: true, what: "How long you take to go from running to stopped before a fight's first bullet. A clean counter-strafe takes about 100 ms; letting go of the keys takes much longer.",
      tip: "Counter-strafe instead of letting go: A then a tap of D, D then a tap of A. Practice the rhythm in a deathmatch until it's automatic.", practice: "warmupserver" },
    { key: "counter_strafe", name: "Counter-strafing", fmt: mPct, what: "Rifle shots at a spotted enemy fired stopped (under 34% of top speed), first bullets and the rest.",
      tip: "Shoot only when stopped; between bursts, strafe and stop again before the next one.", practice: "aimbotz" },
    { key: "air_shot_pct", name: "Shots in the air", fmt: mPct1, lower: true, what: "Shots at a spotted enemy fired while jumping or falling. Almost every gun is wildly inaccurate in the air.",
      tip: "Land, stop, then shoot. Jump-peek for information only, without firing.", practice: "kz" },
  ] },
  { key: "aim", name: "Aim", icon: "◎", blurb: "Where your bullets go, how fast you get on target, and your spray.", sprays: true, stats: [
    { key: "head_accuracy", name: "Headshot accuracy", fmt: mPct, what: "Of your hits on enemies, those in the head (AWP excluded).", tip: "Keep your crosshair at head height everywhere you walk, and aim for the head first.", practice: "aimbotz" },
    { key: "spotted_accuracy", name: "Accuracy (enemy spotted)", fmt: mPct, what: "Your shots that hit while an enemy was in view.", tip: "Fewer bullets, better aimed: tap and burst at range instead of spraying.", practice: "aimbotz" },
    { key: "accuracy", name: "Accuracy (all shots)", fmt: mPct, what: "All your shots that hit, wallbangs and spam included.", tip: "Spray through smokes and walls only when you know someone's there.", practice: "aimbotz" },
    { key: "first_bullet", name: "First bullet accuracy", fmt: mPct, what: "How often the first bullet of a fight hits (recoil reset; shotguns and snipers excluded).", tip: "Stop, then shoot: most missed first bullets are fired moving or before the crosshair settles.", practice: "aimbotz" },
    { key: "spray_accuracy", name: "Spray accuracy", fmt: mPct, what: "Rifle bullets in sprays (3+ shots) that hit.", tip: "Learn the first 10 bullets of the AK and M4 spray: pull down, then follow the pattern (the charts above).", practice: "aimbotz" },
    { key: "crosshair_deg", name: "Crosshair placement", fmt: (v) => `${v.toFixed(2)}°`, lower: true, what: "How far your crosshair moved from seeing an enemy to hitting them. Lower means it was already where they appeared.",
      tip: "Pre-aim the spots enemies come from, at head height, as you move. Yprac's prefire routes drill exactly this.", practice: "yprac" },
    { key: "ttd_ms", name: "Time to damage", fmt: mMs, lower: true, what: "From seeing an enemy to your first hit (fights under a second).", tip: "Good crosshair placement shortens it more than fast flicks do.", practice: "aimbotz" },
    { key: "hs_kill_pct", name: "Headshot kills", fmt: mPct, what: "Of your kills, those with a headshot.", tip: "Head height, always.", practice: "aimbotz" },
  ] },
  { key: "utility", name: "Utility", icon: "✸", blurb: "Your grenades: flashes that blind enemies and not teammates, damage, and not dying with them.", stats: [
    { key: "flash_assist_pct", name: "Flashes leading to kills", fmt: mPct1, what: "Your flashes after which a teammate (or you) killed a flashed enemy.", tip: "Flash for a teammate who's about to peek, and pop it right as they go.", practice: "utility" },
    { key: "enemies_per_flash", name: "Enemies flashed per flash", fmt: f2, what: "Enemies blinded (over 1.1 s) per flash you throw.", tip: "Pop-flash over walls and corners so it explodes as it comes into view.", practice: "utility" },
    { key: "friends_per_flash", name: "Teammates flashed per flash", fmt: f2, lower: true, what: "Teammates you blind per flash.", tip: "Call your flashes, and throw them where your teammates aren't looking.", practice: "utility" },
    { key: "blind_time", name: "Blind time per flashed enemy", fmt: (v) => `${v.toFixed(2)} s`, what: "How long your flashes blind the enemies they catch.", tip: "Flashes that pop in front of the enemy blind longest: aim for their face, not the wall behind them.", practice: "utility" },
    { key: "he_damage_avg", name: "Damage per HE", fmt: f1, what: "Enemy damage per HE grenade you throw.", tip: "Throw HEs at stacked enemies or after a flash, and twice with a teammate.", practice: "utility" },
    { key: "utility_damage_pr", name: "Utility damage per round", fmt: f1, what: "Damage from your HEs and molotovs, per round.", tip: "Molotov common spots before taking a site, and HE enemies who are already hurt.", practice: "utility" },
    { key: "nades_per_round", name: "Grenades per round", fmt: f2, what: "Grenades thrown per round.", tip: "Buy and use a full set of utility every gun round.", practice: "utility" },
    { key: "unused_utility", name: "Utility unused at death", fmt: (v) => `$${Math.round(v)}`, lower: true, what: "The value of the grenades still on you when you die.", tip: "Use your grenades before you take a fight: dying with utility is money thrown away.", practice: "utility" },
  ] },
  { key: "gamesense", name: "Gamesense", icon: "✦", blurb: "Smart play: not getting caught, not dying first or alone, not chasing kills, clutching and staying steady.", game: true, stats: [
    { key: "caught", src: "game", name: "Caught off guard", fmt: mPct, lower: true, what: "Your deaths while you were looking the other way (60°+ away from your killer as the fight started).",
      tip: "Check the spots you walk past, listen for footsteps, and don't turn your back on an angle that isn't cleared." },
    { key: "first_death", src: "game", name: "First of your team to die", fmt: mPct, lower: true, what: "Rounds in which you died before any teammate.",
      tip: "Take the first fight only with a teammate close enough to trade, or with utility; otherwise let the round come to you." },
    { key: "untraded", src: "game", name: "Died without a trade", fmt: mPct, lower: true, what: "Your deaths where nobody got your killer within 5 seconds.",
      tip: "Play close enough to a teammate that they can trade you, and fight where they can see." },
    { key: "advantage", src: "game", name: "Died with the numbers", fmt: mPct, lower: true, what: "Your deaths while your team had two or more players more than the enemy: chasing kills, or peeking when you didn't need to.",
      tip: "When you're ahead, play for time and crossfires and let them come to you." },
    { key: "solo", src: "game", name: "Sites taken alone", fmt: mPct, lower: true, what: "Of the sites you were first into on T, those you went into with no teammate within 1,000 units and none fighting anywhere else at the time (a lurk timed with your team's hit doesn't count).",
      tip: "Go in with your team, or time a lurk with their hit: a solo entry is a 1v3 more often than not." },
    { key: "trade_kill_success_pct", name: "Trading teammates", fmt: mPct, what: "When a teammate near you died, how often you killed their killer within 5 seconds.",
      tip: "Stay one swing away from your entry fragger and swing as soon as they're hit." },
  ] },
];
const MECH_PRACTICE = { aimbotz: "Aim Botz", warmupserver: "an FFA deathmatch", kz: "a KZ map", yprac: "Yprac Hub", utility: "your own nade practice" };
// The Profile's bands (Great 90+, Good 70+, Average 30+, Subpar 10+, Poor).
const mechGradeOf = (score) => (score == null ? null : ((g) => ({ g, word: BAND_WORDS[g] }))(bandOf(score / 100)));

// A per-match score (0-100) from a standard score: 50 is the average player.
const zScore = (z) => (z == null ? null : phi(Math.max(-3, Math.min(3, z))) * 100);

// Gamesense from the match insights, per player and match (yours and everyone else's).
function mechGame(sets, ids) {
  const acc = new Map();
  const get = (r, p) => {
    const key = `${r.match.id}|${p}`;
    let a = acc.get(key);
    if (!a) {
      a = { id: r.match.id, me: p === r.match.me, rounds: 0, deaths: 0, first: 0, untraded: 0, fights: 0, caught: 0, adv: 0, entries: 0, solo: 0, cw: [0, 0, 0, 0, 0, 0], ca: [0, 0, 0, 0, 0, 0], after: [], normal: [] };
      acc.set(key, a);
    }
    return a;
  };
  for (const set of sets) {
    const { D } = set, ctx = { D };
    const byMatch = new Map();
    for (const r of D.rounds) if (r.match.me >= 0 && ids.has(r.match.id)) { if (!byMatch.has(r.match.id)) byMatch.set(r.match.id, []); byMatch.get(r.match.id).push(r); }
    for (const rounds of byMatch.values()) {
      rounds.sort((a, b) => a.n - b.n);
      const lost = new Map(); // rounds each player's side has lost in a row
      for (const r of rounds) {
        const deathOf = (p) => (r.death[p] >= 0 ? r.death[p] : 1e9);
        const aliveAt = (S, t) => r.team[S].filter((q) => deathOf(q) > t).length;
        for (const S of ["T", "C"]) {
          const team = r.team[S], other = S === "T" ? "C" : "T";
          if (!team.length) continue;
          const order = [...team].sort((a, b) => deathOf(a) - deathOf(b));
          for (const p of team) {
            const a = get(r, p);
            a.rounds++;
            const kills = r.kills.filter((k) => k[1] === p && k[2] >= 0 && r.sides[k[2]] !== S).length;
            const died = r.death[p] >= 0;
            ((lost.get(p) || 0) >= 3 ? a.after : a.normal).push({ k: kills, died });
            if (!died) continue;
            a.deaths++;
            if (order[0] === p) a.first++;
            const death = r.kills.find((k) => k[2] === p);
            const traded = !!death && death[1] >= 0 && r.kills.some((k) => k[2] === death[1] && k[0] >= death[0] && k[0] <= death[0] + 50);
            if (!traded) a.untraded++;
            if (death && death.length >= 24 && death[1] >= 0) { a.fights++; if (death[23] > 60) a.caught++; }
            if (aliveAt(S, r.death[p] - 1) - aliveAt(other, r.death[p] - 1) >= 2) a.adv++;
          }
          // The clutch: the last one alive, against however many enemies were left then.
          if (team.length >= 2) {
            const last = order[order.length - 1], before = order[order.length - 2];
            const tc = deathOf(before);
            if (tc < 1e9 && deathOf(last) > tc) {
              const vs = aliveAt(other, tc);
              if (vs >= 1 && vs <= 5) { const a = get(r, last); a.ca[vs]++; if (r.win === S) a.cw[vs]++; }
            }
          }
        }
        // Sites taken alone: the first T in, no teammate within 1,000 units, nobody else fighting.
        for (const e of siteEntries(ctx, [r])) {
          const a = get(r, e.p);
          a.entries++;
          const me = posAt(D, r, e.p, e.t);
          const near = r.team.T.some((q) => q !== e.p && (() => { const o = posAt(D, r, q, e.t); return o && me && Math.hypot(o[0] - me[0], o[1] - me[1]) < 1000; })());
          const busy = r.hurts.some((h) => h[0] >= e.t - 50 && h[0] <= e.t + 20 && h[1] !== e.p && h[2] !== e.p && ((h[1] >= 0 && r.sides[h[1]] === "T") || r.sides[h[2]] === "T"));
          if (!near && !busy) a.solo++;
        }
        for (const p of [...r.team.T, ...r.team.C]) lost.set(p, r.win === r.sides[p] ? 0 : (lost.get(p) || 0) + 1);
      }
    }
  }
  return [...acc.values()];
}
// One player-match's gamesense value per stat (null when there's too little to say).
const MECH_GAME_VAL = {
  caught: (a) => (a.fights >= 3 ? (100 * a.caught) / a.fights : null),
  first_death: (a) => (a.rounds >= 8 ? (100 * a.first) / a.rounds : null),
  untraded: (a) => (a.deaths >= 4 ? (100 * a.untraded) / a.deaths : null),
  advantage: (a) => (a.deaths >= 4 ? (100 * a.adv) / a.deaths : null),
  solo: (a) => (a.entries >= 2 ? (100 * a.solo) / a.entries : null),
};
// Pooled over a period: the same, from the totals.
const MECH_GAME_POOL = {
  caught: ["caught", "fights"], first_death: ["first", "rounds"], untraded: ["untraded", "deaths"], advantage: ["adv", "deaths"], solo: ["solo", "entries"],
};

async function renderMechanics(view) {
  view.innerHTML = `<div class="ins-head"><div><div class="h1">Mechanics</div><div class="sub">Reading your matches…</div></div></div>`;
  const [rows, bench, spray, recoil, idx] = await Promise.all([
    loadMyStats(), loadBenchmarks(),
    (async () => { try { const r = await fetch(assetUrl("my_spray.json"), { cache: "no-store" }); return r.ok ? await r.json() : {}; } catch (e) { return {}; } })(),
    loadRecoil(), loadInsightsIndex(),
  ]);
  const maps = Object.keys(idx?.maps || {});
  const sets = (await Promise.all(maps.map((m) => loadInsights(m)))).map((D, i) => (D ? { D, map: maps[i] } : null)).filter(Boolean);
  mechPage(view, { rows: rows || [], bench: bench || {}, spray: spray || {}, recoil: recoil || {}, sets });
}

function mechPage(view, data) {
  const rerender = () => { saveMech(); mechPage(view, data); };
  const all = data.rows.map((r) => ({ ...r, map: summaryOf(r.id)?.map || "" })).filter((r) => r.map && (mech.src === "all" || r.source === mech.src));
  const mapsHere = [...new Set(all.map((r) => r.map))].sort((a, b) => all.filter((r) => r.map === b).length - all.filter((r) => r.map === a).length);
  if (mech.map !== "all" && !mapsHere.includes(mech.map)) mech.map = "all";
  const rows = all.filter((r) => mech.map === "all" || r.map === mech.map).sort((a, b) => a.ts - b.ts);
  const n = mech.n || 30;
  const cur = rows.slice(-n), prev = rows.slice(-2 * n, -n);
  const ids = new Set(rows.map((r) => r.id));
  const game = mechGame(data.sets, ids);
  const myGame = new Map(game.filter((a) => a.me).map((a) => [a.id, a]));
  const others = game.filter((a) => !a.me);

  // Each stat: its per-match values (this period), period values, the average player's, a score.
  const statOf = (s) => {
    if (s.src === "game") {
      const val = MECH_GAME_VAL[s.key];
      const dist = others.map(val).filter((v) => v != null);
      const dm = mean(dist), dsd = dist.length > 1 ? Math.sqrt(mean(dist.map((v) => (v - dm) ** 2))) : 0;
      const [num, den] = MECH_GAME_POOL[s.key];
      const pool = (list) => { const g = list.map((r) => myGame.get(r.id)).filter(Boolean); const d = sum(g.map((a) => a[den])); return d ? (100 * sum(g.map((a) => a[num]))) / d : null; };
      const avgDen = sum(others.map((a) => a[den]));
      const series = cur.map((r) => ({ r, v: myGame.get(r.id) ? val(myGame.get(r.id)) : null })).filter((x) => x.v != null);
      const scores = dsd ? series.map((x) => zScore(((x.v - dm) / dsd) * (s.lower ? -1 : 1))) : [];
      const score = scores.length >= 3 ? mean(scores) : null;
      return { s, series, cur: pool(cur), prev: pool(prev), avg: avgDen ? (100 * sum(others.map((a) => a[num]))) / avgDen : null, score, n: series.length };
    }
    const b = data.bench[s.key];
    const series = cur.map((r) => ({ r, v: r.stats?.[s.key] })).filter((x) => x.v != null && !Number.isNaN(x.v));
    const periodMean = (list) => { const v = list.map((r) => r.stats?.[s.key]).filter((x) => x != null && !Number.isNaN(x)); return v.length ? mean(v) : null; };
    // As the Profile's ratings: each match's standard score against every player in your library.
    const scores = series.map((x) => zScore(zOf(s.key, x.v))).filter((v) => v != null);
    const score = scores.length >= 3 ? mean(scores) : null;
    return { s, series, cur: periodMean(cur), prev: periodMean(prev), avg: b?.mean ?? null, score, n: series.length, missing: cur.length - series.length };
  };
  const sections = MECH_SECTIONS.map((sec) => {
    const stats = sec.stats.map(statOf);
    const extra = [];
    if (sec.key === "gamesense") extra.push(mechClutch(game, cur, prev), mechTilt(game, cur, prev));
    const scored = [...stats, ...extra].filter((x) => x && x.score != null);
    // Movement, aim and utility: the Profile's rating of the same name, so both pages agree.
    const rating = customRatings.find((r) => r.id === sec.key);
    const rated = rating ? cur.map((r) => customRating(rating, r.stats || {})).filter((v) => v != null) : [];
    const score = rated.length >= 3 ? mean(rated) : scored.length ? mean(scored.map((x) => x.score)) : null;
    return { sec, stats, extra: extra.filter(Boolean), score };
  });
  const sprays = mechSprays(data.spray, data.recoil, cur);
  const waiting = cur.filter((r) => r.stats?.first_stop == null && r.stats?.counter_strafe != null).length;
  const segBtns = (key, opts, val) => opts.map(([k, l]) => `<button data-${key}="${k}" class="${String(val) === String(k) ? "on" : ""}">${l}</button>`).join("");
  const period = (list) => (list.length ? `${new Date(list[0].ts * 1000).toLocaleDateString([], { month: "short", day: "numeric" })} – ${new Date(list[list.length - 1].ts * 1000).toLocaleDateString([], { month: "short", day: "numeric" })}` : "");

  view.innerHTML = `
    <div class="ins-head"><div><div class="h1">Mechanics</div>
      <div class="sub">How good your movement, aim, utility and gamesense are, stat by stat, against the average player in your matches. Scores: 50 is the average player; higher is better.</div></div></div>
    <div class="ln-bar ins-filters mc-filters">
      <div class="seg">${segBtns("mn", [[10, "Last 10"], [30, "Last 30"], [60, "Last 60"], [100, "Last 100"]], n)}</div>
      <div class="seg">${segBtns("msrc", [["all", "All"], ["faceit", "FACEIT"], ["valve", "Premier"]], mech.src)}</div>
      <select class="mc-map" data-mmap><option value="all">All maps</option>${mapsHere.map((m) => `<option value="${esc(m)}" ${m === mech.map ? "selected" : ""}>${esc(mapName(m))}</option>`).join("")}</select>
      <span class="sub">This period: ${cur.length} match${cur.length === 1 ? "" : "es"} (${period(cur)})${prev.length ? ` · before: ${prev.length} (${period(prev)})` : ""}</span>
    </div>
    ${waiting ? `<div class="note">${waiting} of these matches don't have the new movement stats yet (first bullet stopped, time to stop) or your spray pull: Veloxify is re-reading their demos in the background, while CS2 is closed.</div>` : ""}
    ${!cur.length ? `<div class="empty">No analyzed matches with these filters yet.</div>` : `
    <div class="mc-scores">${sections.map(({ sec, score }) => { const g = mechGradeOf(score); return `<a class="mc-score ${g?.g || ""}" href="#/mechanics" data-jump="${sec.key}">
      <span class="mc-ring ${g?.g || ""}" style="--p:${score == null ? 0 : Math.round(score)}"><b>${score == null ? "–" : Math.round(score)}</b></span>
      <span><b>${esc(sec.name)}</b><span class="sub">${g ? g.word : "Not enough yet"}</span></span></a>`; }).join("")}</div>
    ${sections.map(({ sec, stats, extra, score }) => `<section class="mc-section" id="mc-${sec.key}">
      <div class="mc-sec-head"><div class="h2">${esc(sec.name)}</div>${score != null ? `<span class="ps-grade ${mechGradeOf(score).g}">${Math.round(score)} · ${mechGradeOf(score).word}</span>` : ""}<span class="sub">${esc(sec.blurb)}</span></div>
      ${sec.sprays ? mechSprayHtml(sprays) : ""}
      ${stats.map((st) => mechCard(st, sec.key)).join("")}
      ${extra.map((x) => x.html).join("")}
    </section>`).join("")}`}
    <div class="note">Each chart is your last ${n} matches, one point per match; the dashed line is the average player in your matches (every player in every match in your library). Click a point to open that match. Scores are the Profile's ratings (Movement, Aim, Utility; you can change what goes into them under Profile → Edit ratings): each match's stats against every player in your library, averaged. Great 90+, Good 70+, Average 30+, Subpar 10+, Poor under 10.</div>`;

  view.querySelectorAll("[data-mn]").forEach((b) => (b.onclick = () => { mech.n = Number(b.dataset.mn); rerender(); }));
  view.querySelectorAll("[data-msrc]").forEach((b) => (b.onclick = () => { mech.src = b.dataset.msrc; rerender(); }));
  view.querySelector("[data-mmap]")?.addEventListener("change", (e) => { mech.map = e.target.value; rerender(); });
  view.querySelectorAll("[data-jump]").forEach((a) => (a.onclick = (e) => { e.preventDefault(); view.querySelector(`#mc-${a.dataset.jump}`)?.scrollIntoView({ behavior: "smooth" }); }));
  mechWireCharts(view);
}
const mean = (a) => (a.length ? sum(a) / a.length : null);

// A stat card: the chart (one point per match) and the summary.
function mechCard(st, secKey) {
  const { s, series, score } = st;
  const g = mechGradeOf(score);
  const fmt = (v) => (v == null ? "–" : s.fmt(v));
  const delta = st.cur != null && st.prev != null ? st.cur - st.prev : null;
  const better = delta == null ? null : s.lower ? delta < 0 : delta > 0;
  return `<div class="mc-card">
    <div class="mc-chart-wrap">${series.length >= 2 ? mechChart(series, st.avg, s, `${secKey}-${s.key}`) : `<div class="mc-nochart sub">${series.length ? "One match so far" : "Not measured yet in these matches"}</div>`}</div>
    <div class="mc-sum">
      <div class="mc-name">${esc(s.name)}</div>
      <div class="mc-grade ${g?.g || ""}">${g ? g.word : "–"}</div>
      <div class="mc-nums">
        <div><b>${fmt(st.cur)}</b><span>This period</span></div>
        <div><b>${fmt(st.avg)}</b><span>Average player</span></div>
        <div><b class="${better == null ? "" : better ? "up" : "down"}">${fmt(st.prev)}</b><span>Period before</span></div>
      </div>
      <div class="mc-what">${esc(s.what)}</div>
      ${g && (g.g === "g3" || g.g === "g4" || g.g === "g2") && s.tip ? `<div class="ps-tip"><b>How to improve:</b> ${esc(s.tip)}${s.practice && MECH_PRACTICE[s.practice] ? ` <a href="#/practice">Practice: ${esc(MECH_PRACTICE[s.practice])} →</a>` : ""}</div>` : ""}
    </div></div>`;
}

// Smooth line through points (Catmull-Rom as cubic Béziers).
function smoothPath(pts) {
  if (pts.length < 2) return "";
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6], c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}
// The chart: your value per match, the average player's as a dashed line, green where you beat
// it and red where you fall short. Hover for the match; click to open it.
function mechChart(series, avg, s, id) {
  const W = 1000, H = 200, PX = 4, PY = 14;
  const vals = series.map((x) => x.v).concat(avg == null ? [] : [avg]);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = (hi - lo) * 0.12 || Math.abs(hi) * 0.1 || 1;
  lo -= pad; hi += pad;
  const X = (i) => PX + (i * (W - 2 * PX)) / (series.length - 1), Y = (v) => PY + ((hi - v) / (hi - lo)) * (H - 2 * PY);
  const pts = series.map((x, i) => [X(i), Y(x.v)]);
  const line = smoothPath(pts);
  const ya = avg == null ? H : Y(avg);
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${ya.toFixed(1)} L${pts[0][0].toFixed(1)},${ya.toFixed(1)} Z`;
  const upGood = !s.lower;
  const ticks = [hi - pad, (hi + lo) / 2, lo + pad];
  const tips = series.map((x) => ({ id: x.r.id, label: `${mapName(x.r.map)} · ${new Date(x.r.ts * 1000).toLocaleDateString([], { month: "short", day: "numeric" })}`, v: s.fmt(x.v) }));
  return `<div class="mc-chart" data-tips="${esc(JSON.stringify(tips))}" data-n="${series.length}">
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="${esc(s.name)}, one point per match">
      <defs><clipPath id="up-${id}"><rect x="0" y="0" width="${W}" height="${Math.max(0, ya)}"/></clipPath><clipPath id="dn-${id}"><rect x="0" y="${ya}" width="${W}" height="${Math.max(0, H - ya)}"/></clipPath></defs>
      ${avg == null ? "" : `<path d="${area}" clip-path="url(#up-${id})" class="mc-fill ${upGood ? "good" : "bad"}"/><path d="${area}" clip-path="url(#dn-${id})" class="mc-fill ${upGood ? "bad" : "good"}"/>
      <line x1="0" x2="${W}" y1="${ya.toFixed(1)}" y2="${ya.toFixed(1)}" class="mc-avg" vector-effect="non-scaling-stroke"/>`}
      <path d="${line}" class="mc-line" vector-effect="non-scaling-stroke"/>
    </svg>
    <div class="mc-ticks">${ticks.map((v) => `<span style="top:${((Y(v) / H) * 100).toFixed(1)}%">${esc(s.fmt(v))}</span>`).join("")}</div>
    <div class="mc-dots">${pts.map(([x, y], i) => `<i style="left:${((x / W) * 100).toFixed(2)}%;top:${((y / H) * 100).toFixed(2)}%" data-i="${i}"></i>`).join("")}</div>
    <div class="mc-tip" hidden></div></div>`;
}
function mechWireCharts(view) {
  view.querySelectorAll(".mc-chart").forEach((c) => {
    const tips = JSON.parse(c.dataset.tips || "[]"), n = tips.length, tip = c.querySelector(".mc-tip"), dots = c.querySelectorAll(".mc-dots i");
    const at = (e) => { const r = c.getBoundingClientRect(); return Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left) / r.width) * (n - 1)))); };
    c.onmousemove = (e) => {
      const i = at(e), d = dots[i];
      dots.forEach((x) => x.classList.toggle("on", x === d));
      tip.hidden = false;
      tip.innerHTML = `<b>${esc(tips[i].v)}</b> <span>${esc(tips[i].label)}</span>`;
      tip.style.left = d.style.left;
      tip.style.top = d.style.top;
    };
    c.onmouseleave = () => { tip.hidden = true; dots.forEach((x) => x.classList.remove("on")); };
    c.onclick = (e) => { const t = tips[at(e)]; if (t) location.hash = matchHref(t.id); };
  });
}

// Clutches: won against what the average player wins from the same 1vXs.
function mechClutch(game, cur, prev) {
  const rates = [0, 1, 2, 3, 4, 5].map((x) => { const a = sum(game.filter((g) => !g.me).map((g) => g.ca[x])), w = sum(game.filter((g) => !g.me).map((g) => g.cw[x])); return x && a >= 20 ? w / a : CLUTCH_AVG[x]; });
  const totals = (list) => { const ids = new Set(list.map((r) => r.id)), mine = game.filter((g) => g.me && ids.has(g.id)); return [[0, 1, 2, 3, 4, 5].map((x) => sum(mine.map((g) => g.cw[x]))), [0, 1, 2, 3, 4, 5].map((x) => sum(mine.map((g) => g.ca[x])))]; };
  const [cw, ca] = totals(cur), [pw, pa] = totals(prev);
  const g = clutchGrade(cw, ca, rates), gp = clutchGrade(pw, pa, rates);
  if (!g) return null;
  const z = (() => { let e = 0, v = 0; for (let x = 1; x <= 5; x++) { e += ca[x] * rates[x]; v += ca[x] * rates[x] * (1 - rates[x]); } return v > 0 ? (g.w - e) / Math.sqrt(v) : 0; })();
  const score = zScore(z);
  const grade = mechGradeOf(score);
  const cells = [1, 2, 3, 4, 5].map((x) => {
    const gx = clutchGrade(cw.map((v, i) => (i === x ? v : 0)), ca.map((v, i) => (i === x ? v : 0)), rates);
    return `<div class="mc-cl ${gx ? gx.g : ""}"><span>1v${x}</span><b>${ca[x] ? `${cw[x]}/${ca[x]}` : "–"}</b><small>${ca[x] ? `${pctOf(cw[x], ca[x])}%` : ""} · avg ${Math.round(rates[x] * 100)}%</small></div>`;
  }).join("");
  return { score, html: `<div class="mc-card mc-special"><div class="mc-chart-wrap"><div class="mc-cls">${cells}</div></div>
    <div class="mc-sum"><div class="mc-name">Clutching</div><div class="mc-grade ${grade.g}">${grade.word}</div>
      <div class="mc-nums"><div><b>${g.w}/${g.n}</b><span>Won this period</span></div><div><b>${f1(g.expected)}</b><span>The average player would win</span></div><div><b>${gp ? `${gp.w}/${gp.n}` : "–"}</b><span>Period before</span></div></div>
      <div class="mc-what">As the last one alive, against however many enemies were left. Each 1vX is compared with what the average player in your matches wins.</div>
      ${grade.g === "g3" || grade.g === "g4" ? `<div class="ps-tip"><b>How to improve:</b> take one fight at a time, use the bomb and the clock, and listen: isolate duels instead of being seen by two.</div>` : ""}</div></div>` };
}
// Tilt: how you play after your team loses 3 rounds in a row, against your usual (and the average
// player's drop in the same spot).
function mechTilt(game, cur) {
  const ids = new Set(cur.map((r) => r.id));
  const mine = game.filter((g) => g.me && ids.has(g.id)), others = game.filter((g) => !g.me);
  const rate = (list) => rating1(list);
  const myAfter = mine.flatMap((g) => g.after), myNormal = mine.flatMap((g) => g.normal);
  const oAfter = others.flatMap((g) => g.after), oNormal = others.flatMap((g) => g.normal);
  if (myAfter.length < 15 || !myNormal.length) return null;
  const mine1 = rate(myAfter) / rate(myNormal) - 1, avg1 = rate(oAfter) / rate(oNormal) - 1;
  const score = Math.max(0, Math.min(100, 50 + 250 * (mine1 - avg1) * Math.min(1, myAfter.length / 40)));
  const grade = mechGradeOf(score);
  const pc = (v) => `${v >= 0 ? "+" : ""}${Math.round(v * 100)}%`;
  return { score, html: `<div class="mc-card mc-special"><div class="mc-chart-wrap"><div class="mc-tilt">
      <div><span>Your usual rounds</span><b>${f2(rate(myNormal))}</b></div><div><span>After 3+ lost in a row</span><b class="${mine1 >= avg1 ? "up" : "down"}">${f2(rate(myAfter))}</b><small>${pc(mine1)}</small></div><div><span>The average player after 3+ lost</span><b>${pc(avg1)}</b></div></div></div>
    <div class="mc-sum"><div class="mc-name">Staying steady (tilt)</div><div class="mc-grade ${grade.g}">${grade.word}</div>
      <div class="mc-nums"><div><b>${pc(mine1)}</b><span>Your rating after a losing streak</span></div><div><b>${pc(avg1)}</b><span>The average player's</span></div><div><b>${myAfter.length}</b><span>Rounds after a streak</span></div></div>
      <div class="mc-what">Your rating (HLTV 1.0, from rounds) in the rounds after your team lost 3 or more in a row, against your other rounds. Everyone drops a little; less than the average player is good.</div>
      ${grade.g === "g3" || grade.g === "g4" ? `<div class="ps-tip"><b>How to improve:</b> after a losing streak, reset: play a standard round with your team, talk less about the last round, and don't force hero plays.</div>` : ""}</div></div>` };
}
// Your spray per rifle this period: your average mouse pull per bullet against the gun's recoil.
const SPRAY_GUNS = ["ak47", "m4a1", "m4a1_silencer", "famas", "galilar", "aug", "sg556"];
function mechSprays(spray, recoil, cur) {
  const out = [];
  for (const w of SPRAY_GUNS) {
    const pattern = recoil?.[w];
    const sumRows = [];
    for (const r of cur) {
      const row = spray?.[r.id]?.[w];
      if (!row) continue;
      row.forEach((b, k) => { const s = (sumRows[k] = sumRows[k] || [0, 0, 0]); s[0] += b[0]; s[1] += b[1]; s[2] += b[2]; });
    }
    const sprays = sumRows[0]?.[2] || 0;
    if (!pattern || sprays < 10) continue;
    // Your line goes as far as 6 or more of your sprays reach.
    let reach = sumRows.findIndex((b) => !b || b[2] < 6);
    if (reach < 0) reach = sumRows.length;
    const len = Math.min(reach, pattern.length);
    if (len < 4) continue;
    // Degrees: where the recoil pushes the bullets (twice the punch; x right, y the climb), the
    // gun's whole pattern; and your pull, which countering it perfectly lands on the same points.
    const full = pattern.map(([pp, py]) => [-2 * py, -2 * pp]);
    const rec = full.slice(0, len);
    const you = sumRows.slice(0, len).map(([p, y, c]) => [y / c, p / c]);
    // Control: how closely your pull down follows the recoil from the 4th bullet on (before that
    // the recoil is too small to measure against). Sideways is left out: following a moving
    // enemy moves it too.
    const from = Math.min(3, len - 1);
    let err = 0, size = 0, early = 0;
    for (let i = from; i < len; i++) {
      err += Math.abs(you[i][1] - rec[i][1]);
      size += Math.abs(rec[i][1]);
      if (i + 1 < pattern.length) early += Math.abs(you[i][1] + 2 * pattern[i + 1][0]);
    }
    const control = size ? Math.max(0, Math.min(100, 100 * (1 - err / size))) : null;
    // Where it goes wrong: a bullet ahead of the recoil (pulling early), too little or too much
    // pull, or drifting to one side.
    const late = you.slice(from), lateRec = rec.slice(from);
    const dy = mean(late.map((p, i) => p[1] - lateRec[i][1])), dx = mean(late.map((p, i) => p[0] - lateRec[i][0]));
    const notes = [];
    if (early < err * 0.6 && dy > 0) notes.push("you pull down about a bullet early, ahead of the recoil (so your bullets drop below the target)");
    else if (Math.abs(dy) > 0.6) notes.push(dy < 0 ? "you pull down too little (your bullets climb)" : "you pull down too much (your bullets drop)");
    if (Math.abs(dx) > 0.6) notes.push(dx < 0 ? "you drift left of the pattern" : "you drift right of the pattern");
    out.push({ w, full, rec, you, sprays, bullets: len, control, note: notes.join("; ") });
  }
  return out;
}
function mechSprayHtml(list) {
  if (!list.length) return `<div class="note">Your spray patterns show here once your demos are re-read (Veloxify reads your mouse pull in every rifle spray) and you've sprayed a rifle 10+ times this period.</div>`;
  return `<div class="mc-sprays">${list.map((g) => {
    // Like a spray chart: from the top down as the gun climbs, then its sideways sweeps.
    const pts = g.full.concat(g.you);
    const ys = pts.map((p) => p[1]), xs = pts.map((p) => p[0]);
    const SW = 220, SH = 260;
    const sc = Math.min((SH - 28) / Math.max(2, Math.max(...ys) - Math.min(0, ...ys)), (SW - 24) / Math.max(2, Math.max(...xs) - Math.min(...xs)));
    const cx = SW / 2 - ((Math.max(...xs) + Math.min(...xs)) / 2) * sc, top = 14 - Math.min(0, ...ys) * sc;
    const P = ([x, y]) => [cx + x * sc, top + y * sc];
    const path = (arr) => arr.map((p, i) => { const [x, y] = P(p); return `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`; }).join("");
    const dots = (arr, cls) => arr.map((p) => { const [x, y] = P(p); return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.2" class="${cls}"/>`; }).join("");
    const grade = g.control == null ? null : mechGradeOf(g.control >= 80 ? 92 : g.control >= 65 ? 75 : g.control >= 45 ? 50 : g.control >= 30 ? 20 : 5);
    return `<div class="mc-spray"><div class="mc-spray-h"><b>${esc(weaponName(g.w))}</b>${g.control != null ? `<span class="ps-grade ${grade.g}" title="How closely your pull down follows the recoil, bullets 4 to ${g.bullets}">${Math.round(g.control)}% control</span>` : ""}</div>
      <svg viewBox="0 0 ${SW} ${SH}" role="img" aria-label="${esc(weaponName(g.w))}: the gun's spray pattern against your pull"><path d="${path(g.full)}" class="mc-rec"/>${dots(g.full, "mc-rec-dot")}<path d="${path(g.you)}" class="mc-you"/>${dots(g.you, "mc-you-dot")}</svg>
      <div class="mc-legend"><span><i class="you"></i>You</span><span><i class="rec"></i>${esc(weaponName(g.w))}</span><span class="sub">${g.sprays} sprays · your line: ${g.bullets} bullets</span></div>
      ${g.note ? `<div class="ps-tip">From the 4th bullet, ${esc(g.note)}.</div>` : `<div class="sub">Your pull follows the recoil.</div>`}</div>`;
  }).join("")}</div>`;
}
// ---- ESEA league ------------------------------------------------------------------------------------

// "S59 NA Open9-10 East A - Regular Season" (a FACEIT league game's competition) -> its parts.
function leagueOf(comp) {
  const m = /^S(\d+)\s+(\S+)\s+(.+?)\s+-\s+(.+)$/.exec(comp || "");
  if (!m) return null;
  const [division, ...conf] = m[3].split(" ");
  return { season: m[1], region: m[2], division, conference: conf.join(" "), stage: m[4] };
}
const ESEA_MARK = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 2.5l2.5 6.4h6.8l-5.5 4 2.1 6.6L12 15.6l-5.9 3.9 2.1-6.6-5.5-4h6.8z"/></svg>`;
const leagueLogo = () => (state.league?.league?.avatar ? `<img src="${esc(state.league.league.avatar)}" alt="ESEA">` : ESEA_MARK);
// The ESEA badge where a league game has no ELO: season and division, like FACEIT's match list.
function leagueChip(comp, link = false) {
  const l = leagueOf(comp);
  if (!l) return "";
  const tag = link ? "a" : "span";
  return `<${tag} class="esea-chip" ${link ? `href="#/league"` : ""} title="ESEA League · Season ${l.season} · ${esc(l.division)} ${esc(l.conference)} · ${esc(l.stage)}">${ESEA_MARK}<span><b>S${l.season}</b><i>${esc(l.division)} ${esc(l.conference)}</i></span></${tag}>`;
}

// The league data (the app fetches it from FACEIT and caches it; the preview reads the cache).
async function loadLeague(force = false) {
  if (state.league && !force) return state.league;
  try {
    state.league = tauri ? await tauri.core.invoke("league_info", { force }) : await (await fetch(assetUrl("league.json"), { cache: "no-store" })).json();
  } catch (e) { state.league = state.league || null; }
  return state.league;
}

const leagueView = { sort: "kr", desc: true, shown: 25, allStandings: false, everyone: false, teamSort: "rating3", teamDesc: true };
const STANDINGS_TOP = 10;
const LEADERS_TOP = 25;
// The conference table: [key, header, format, tooltip].
const DIV_COLS = [
  ["matches", "Games", (v) => v, "League matches played"],
  ["rating1", "Rating 1.0", (v) => v.toFixed(2), "HLTV Rating 1.0 from FACEIT's numbers (kills, survival and multi-kill rounds per round; 1.00 is average)"],
  ["kr", "K/R", (v) => v.toFixed(2), "Kills per round"],
  ["kd", "K/D", (v) => v.toFixed(2), "Kills per death"],
  ["adr", "ADR", (v) => v.toFixed(1), "Damage per round"],
  ["hs", "HS%", (v) => `${Math.round(v)}%`, "Kills that were headshots"],
  ["kills", "K", (v) => v, "Kills"],
  ["deaths", "D", (v) => v, "Deaths"],
  ["multi", "3K+", (v) => v, "Rounds with 3 kills or more"],
  ["first_kills", "Openers", (v) => v, "First kill of the round"],
  ["clutches", "Clutches", (v) => v, "1v1 and 1v2 won"],
  ["sniper_kills", "Sniper", (v) => v, "Kills with the AWP or Scout"],
  ["pistol_kills", "Pistol", (v) => v, "Kills with pistols"],
];
// Season leaders: [title, value of a player, format, what it means]. Qualified players only.
const AWARDS = [
  ["Best rating", (p) => p.rating1, (v) => v.toFixed(2), "HLTV Rating 1.0"],
  ["Most kills", (p) => p.kills, (v) => `${v} kills`, "Season total"],
  ["Best K/R", (p) => p.kr, (v) => v.toFixed(2), "Kills per round"],
  ["Highest ADR", (p) => p.adr, (v) => v.toFixed(1), "Damage per round"],
  ["Best AWPer", (p) => p.sniper_kills, (v) => `${v} kills`, "Most kills with the AWP or Scout"],
  ["Best rifler", (p) => (p.sniper_kills / Math.max(1, p.kills) < 0.15 ? p.rating1 : -1), (v) => v.toFixed(2), "Best rating among players with under 15% of their kills from snipers"],
  ["Best pistol player", (p) => p.pistol_kills / p.matches, (v) => `${v.toFixed(1)} a game`, "Kills with pistols per game"],
  ["Entry king", (p) => p.first_kills / p.matches, (v) => `${v.toFixed(1)} a game`, "Opening kills per game"],
  ["Clutch king", (p) => p.clutches, (v) => `${v} won`, "1v1 and 1v2 clutches won"],
  ["Headshot machine", (p) => (p.kills >= 15 ? p.hs : -1), (v) => `${Math.round(v)}%`, "Headshot share (15+ kills)"],
  ["Utility damage", (p) => p.utility_damage / p.rounds, (v) => `${v.toFixed(1)} a round`, "Grenade damage per round"],
  ["Multi-kill rounds", (p) => p.multi, (v) => `${v} rounds`, "Rounds with 3 kills or more"],
];

// Every player in the conference (FACEIT's per-match stats, read once per match and cached).
async function loadDivision() {
  if (state.division && Date.now() - state.divisionAt < 10 * 60 * 1000) return state.division;
  try {
    state.division = tauri ? await tauri.core.invoke("league_division") : null;
    state.divisionAt = Date.now();
  } catch (e) { state.division = state.division || null; }
  return state.division;
}

// The conference table and the season leaders, once the division's stats are in.
function renderDivision(el, D, L, rosterIds, st) {
  if (!D) {
    el.innerHTML = `<section class="panel lg-section"><div class="empty small">Couldn't read the conference's match stats from FACEIT. Try Refresh in a bit.</div></section>`;
    return;
  }
  const players = D.players.map((p) => ({ ...p, clutches: (p.v1_wins || 0) + (p.v2_wins || 0) }));
  const qualified = players.filter((p) => p.eligible);
  const pool = leagueView.everyone ? players : qualified;
  const key = leagueView.sort;
  const sorted = pool.slice().sort((a, b) => ((b[key] ?? 0) - (a[key] ?? 0)) * (leagueView.desc ? 1 : -1) || b.kills - a.kills);
  const shown = sorted.slice(0, leagueView.shown);
  const minNote = `${D.min_games} of ${D.season_games} game${D.season_games === 1 ? "" : "s"} played or more (${Math.round(D.min_share * 100)}%)`;
  const awards = AWARDS.map(([title, val, fmt, what]) => {
    const top = qualified.map((p) => ({ p, v: val(p) })).filter((x) => Number.isFinite(x.v) && x.v >= 0).sort((a, b) => b.v - a.v).slice(0, 3);
    if (!top.length) return "";
    const [w, ...rest] = top;
    return `<div class="lg-award ${rosterIds.has(w.p.id) ? "me" : ""}"><div class="lg-award-t">${esc(title)}</div>
      <div class="lg-award-w"><b>${esc(w.p.nickname)}</b><span>${esc(w.p.team)}</span></div>
      <div class="lg-award-v">${fmt(w.v)}</div>
      <div class="lg-award-rest">${rest.map((x, i) => `<span>${i + 2}. ${esc(x.p.nickname)} · ${fmt(x.v)}</span>`).join("")}</div>
      <div class="lg-award-what">${esc(what)}</div></div>`;
  }).join("");
  const partial = D.busy || D.teams_read < D.teams
    ? `<div class="ml-note">So far ${D.teams_read} of ${D.teams} teams' matches are read (FACEIT limits how fast Veloxify can ask). The rest load the next time you open this page.</div>` : "";
  el.innerHTML = `${partial}
    <section class="panel lg-section"><div class="panel-head"><div class="h3">Season leaders</div><span class="grow"></span><span class="sub">Players with ${minNote}</span></div>
      ${qualified.length ? `<div class="lg-awards">${awards}</div>` : `<div class="empty small">No one has played enough games yet.</div>`}</section>
    <section class="panel lg-section"><div class="panel-head"><div class="h3">Stat leaders</div><span class="grow"></span>
        <label class="check"><input type="checkbox" id="lg-everyone" ${leagueView.everyone ? "checked" : ""}> Include players under ${D.min_games} game${D.min_games === 1 ? "" : "s"}</label></div>
      <div class="sub" style="padding:0 20px 8px">${leagueView.everyone ? `Everyone who played` : `Players with ${minNote}`} in ${esc(st.division_name || "the division")} ${esc(st.conference_name || "")}, from ${D.matches_read} league match${D.matches_read === 1 ? "" : "es"}. Click a column to sort.</div>
      <div class="table-wrap"><table class="lg-table lg-leaders"><thead><tr><th>#</th><th class="left">Player</th>${DIV_COLS.map(([k, t, , tip]) => `<th data-lsort="${k}" title="${esc(tip)}" class="${key === k ? "on" : ""}">${t}${key === k ? (leagueView.desc ? " ↓" : " ↑") : ""}</th>`).join("")}</tr></thead>
        <tbody>${shown.map((p, i) => `<tr class="${rosterIds.has(p.id) ? "me" : ""} ${p.eligible ? "" : "dim"}"><td>${i + 1}</td><td class="left"><b>${esc(p.nickname)}</b><span class="lg-team-name">${esc(p.team)}</span></td>${DIV_COLS.map(([k, , fmt]) => `<td class="${key === k ? "on" : ""}">${fmt(p[k] ?? 0)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
      ${sorted.length > LEADERS_TOP ? `<button class="btn ghost lg-more" id="lg-more">${leagueView.shown > LEADERS_TOP ? `Show top ${LEADERS_TOP}` : `View all ${sorted.length} players`}</button>` : ""}</section>
    <div class="note">Rating 1.0 is HLTV's original rating, worked out from FACEIT's numbers for every league match. HLTV Rating 3.0 and Round Swing need each match's demo, so here they're only in Team stats (your own matches).</div>`;
  const again = () => renderDivision(el, D, L, rosterIds, st);
  el.querySelector("#lg-everyone").onchange = (e) => { leagueView.everyone = e.target.checked; again(); };
  el.querySelector("#lg-more")?.addEventListener("click", () => { leagueView.shown = leagueView.shown > LEADERS_TOP ? LEADERS_TOP : 100000; again(); });
  el.querySelectorAll("[data-lsort]").forEach((th) => (th.onclick = () => { const k = th.dataset.lsort; leagueView.desc = leagueView.sort === k ? !leagueView.desc : true; leagueView.sort = k; again(); }));
}

async function renderLeague(view) {
  view.innerHTML = `<div class="empty">Loading your league from FACEIT…</div>`;
  const L = await loadLeague();
  if (!L) { view.innerHTML = `<div class="empty">Couldn't reach FACEIT for your league. Try again in a bit.</div>`; return; }
  if (L.none) { view.innerHTML = `<div class="empty">No ESEA league games in your FACEIT history yet.</div>`; return; }
  const st = L.standing || {};
  const me = state.index.me;
  const pl = st.placement || {};
  const mine = L.standings.find((t) => t.premade_team_id === L.team_id);
  const place = mine ? (mine.rank_start === mine.rank_end || !mine.rank_end ? `#${mine.rank_start}` : `#${mine.rank_start}–${mine.rank_end}`)
    : pl.left ? (pl.right && pl.right !== pl.left ? `#${pl.left}–${pl.right}` : `#${pl.left}`) : "";
  const standingOf = (premade) => L.standings.find((t) => t.premade_team_id === premade);
  const rosterIds = new Set((L.roster || []).map((r) => r.user_id));
  const when = (iso) => { if (!iso) return ""; const d = new Date(iso); return `${d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })} ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`; };
  const roleOf = (r) => ({ player: "Player", substitute: "Sub", coach: "Coach" }[r.game_role] || r.game_role || "");
  const rankOf = (r) => ({ leader: "Captain", officer: "Officer" }[r.team_role] || "");

  // Your league matches: played (linked to the match page when the demo is in your library) and coming up.
  const libIds = new Set(state.all.map((m) => m.id));
  const opponent = (them) => {
    const t = standingOf(them.premade_team_id);
    return `<span class="lg-opp">${t?.avatar_url ? `<img class="lg-tav" src="${esc(t.avatar_url)}" alt="">` : `<span class="lg-tav none"></span>`}<span><b>${esc(them.name || "TBD")}</b>${t ? `<small>${t.won || 0}-${t.lost || 0} · #${t.rank_start}</small>` : ""}</span></span>`;
  };
  const scoutBtn = (them, big) => (them.premade_team_id ? `<a class="btn ${big ? "primary" : "ghost small"} lg-scout" href="#/scout/${esc(them.premade_team_id)}" title="Their record, maps, map bans, players and demos">${ICONS.star} Analyze team</a>` : "");
  const matchRow = (g, done) => {
    const us = g.factions.find((f) => f.premade_team_id === L.team_id) || {};
    const them = g.factions.find((f) => f.premade_team_id !== L.team_id) || {};
    const id = `faceit-${g.id.replace(/^1-/, "")}-m1`;
    const forfeit = (g.started_time || "").startsWith("1970");
    const won = done && g.winning_team_premade_id === L.team_id;
    const map = g.maps_picked?.[0]?.name || "";
    const mapId = map ? `de_${map.toLowerCase().replace(/\s+/g, "")}` : "";
    const href = libIds.has(id) ? matchHref(id) : null;
    if (!done) {
      const at = new Date(g.scheduled_time);
      return `<div class="lg-match next">
        <span class="lg-when"><span class="lg-next">Upcoming</span><b class="lg-count" data-at="${at.getTime()}">${countdown(at.getTime())}</b><small>${when(g.scheduled_time)}</small></span>
        ${opponent(them)}
        ${scoutBtn(them, true)}
      </div>`;
    }
    return `<${href ? `a href="${href}"` : "div"} class="lg-match ${won ? "win" : "loss"}">
      <span class="lg-when">${fcDate(new Date(forfeit ? g.scheduled_time : g.started_time || g.scheduled_time))}</span>
      <span class="ml-score"><span class="wl ${won ? "win" : "loss"}">${won ? "W" : "L"}</span><span><b class="${won ? "win" : "loss"}">${us.match_score ?? ""}</b> : <span class="theirs">${them.match_score ?? ""}</span></span>${forfeit ? `<small class="sub">forfeit</small>` : ""}</span>
      ${opponent(them)}
      <span class="lg-map">${map ? `${mapIcon(mapId)}<span>${esc(map)}</span>` : ""}</span>
      ${scoutBtn(them, false)}
    </${href ? "a" : "div"}>`;
  };
  const finished = [...(L.finished || [])].sort((a, b) => new Date(b.started_time || b.scheduled_time) - new Date(a.started_time || a.scheduled_time));

  // Your team's stats from the league demos in your library (the session scoreboard's numbers).
  const leagueMatches = state.all.filter((m) => leagueOf(m.faceit?.competition)?.season === leagueOf(L.competition)?.season && leagueOf(m.faceit?.competition));
  const withDemo = leagueMatches.filter((m) => !m.stats_only);
  const entries = await Promise.all(withDemo.map((m) => loadMatch(m.id)));
  const team = sumPlayers(entries, me).filter((p) => p.mine > 0);
  const TCOLS = [["name", "Player"], ["maps", "Maps"], ["wins", "W-L"], ["rating3", "HLTV 3.0"], ["rws", "RWS"], ["swing", "Swing"], ["kills", "K"], ["deaths", "D"], ["assists", "A"], ["kd", "K/D"], ["adr", "ADR"], ["kast", "KAST"], ["hs", "HS%"]];
  const tval = (p, k) => ({ name: p.name.toLowerCase(), kills: p.c.kills || 0, deaths: p.c.deaths || 0, assists: p.c.assists || 0 }[k] ?? p[k] ?? 0);
  team.sort((a, b) => { const x = tval(a, leagueView.teamSort), y = tval(b, leagueView.teamSort); return (typeof x === "string" ? x.localeCompare(y) : x - y) * (leagueView.teamDesc ? -1 : 1); });
  const tcell = (p, k) => {
    switch (k) {
      case "name": return `<td class="left">${avatarHtml(p.steamid, 24)}<span>${esc(p.name)}</span>${p.is_me ? ` <span class="sc-you">You</span>` : ""}</td>`;
      case "wins": return `<td>${p.wins}-${p.maps - p.wins}</td>`;
      case "rating3": return `<td><span class="mp-rating ${ratingClass(p.rating3)}">${f2(p.rating3)}</span></td>`;
      case "rws": return `<td class="${gradeClass("rws", p.rws)}">${f1(p.rws)}</td>`;
      case "swing": return `<td class="${p.swing > 0 ? "up" : p.swing < 0 ? "down" : ""}">${fmtSwing(p.swing)}</td>`;
      case "kd": return `<td>${f2(p.kd)}</td>`;
      case "adr": return `<td>${f1(p.adr)}</td>`;
      case "kast": return `<td>${Math.round(p.kast)}%</td>`;
      case "hs": return `<td>${Math.round(p.hs)}%</td>`;
      default: return `<td>${tval(p, k)}</td>`;
    }
  };

  // Standings: your team pinned on top, then the top 10 (or everyone).
  const standRow = (t, pinned) => { const tb = t.tie_breakers || {}; const diff = (t.won || 0) - (t.lost || 0); return `<tr class="${t.premade_team_id === L.team_id ? "me" : ""} ${pinned ? "pinned" : ""}">
          <td>${t.rank_start === t.rank_end ? t.rank_start : `${t.rank_start}–${t.rank_end}`}</td>
          <td class="left">${t.avatar_url ? `<img class="lg-tav" src="${esc(t.avatar_url)}" alt="">` : `<span class="lg-tav none"></span>`}<span>${esc(t.name)}</span>${pinned ? `<span class="sc-you">Your team</span>` : ""}</td>
          <td><span class="lg-cc">${esc(t.country_code || "")}</span></td><td>${t.matches || 0}</td><td>${t.won || 0}</td><td>${t.lost || 0}</td>
          <td class="${diff > 0 ? "up" : diff < 0 ? "down" : ""}">${diff > 0 ? "+" : ""}${diff}</td><td>${tb.rounds_won ?? 0}-${tb.rounds_lost ?? 0}</td><td><b>${t.points || 0}</b></td></tr>`; };
  const standShown = leagueView.allStandings ? L.standings : L.standings.slice(0, STANDINGS_TOP);

  view.innerHTML = `
    <section class="lg-hero">
      <div class="lg-logo">${leagueLogo()}</div>
      <div class="lg-title">
        <div class="sub">${esc(L.league.name || "ESEA League")} · Season ${esc(L.league.season || "")}</div>
        <div class="h1">${L.team.avatar ? `<img class="lg-team-av" src="${esc(L.team.avatar)}" alt="">` : ""}${esc(L.team.name || "Your team")}</div>
        <div class="lg-div"><b>${esc(st.division_name || "")}</b> · ${esc(st.conference_name || "")} · ${esc(st.stage_name || "")} · ${esc(st.region_name || "")}</div>
      </div>
      <div class="lg-nums">
        <div><b><span class="up">${st.wins ?? mine?.won ?? 0}</span>-<span class="down">${st.losses ?? mine?.lost ?? 0}</span></b><span>Record</span></div>
        <div><b>${place || "–"}</b><span>of ${L.standings.length} teams</span></div>
        <div><b>${mine?.points ?? 0}</b><span>Points</span></div>
      </div>
      <button class="btn ghost" id="lg-refresh">Refresh</button>
    </section>
    ${L.stale ? `<div class="ml-note">Showing what Veloxify saved last time: FACEIT couldn't be reached (${esc(L.stale)}).</div>` : ""}
    <div class="lg-grid">
      <section class="panel"><div class="panel-head"><div class="h3">Roster</div><span class="grow"></span><span class="sub">${(L.roster || []).length} members</span></div>
        <div class="lg-roster">${(L.roster || []).map((r) => `<div class="lg-member">${r.avatar_img ? `<img src="${esc(r.avatar_img)}" alt="">` : `<span class="lg-noav"></span>`}
          <div><b>${esc(r.user_name)}</b><span>${roleOf(r)}${rankOf(r) ? ` · ${rankOf(r)}` : ""}</span></div></div>`).join("")}</div></section>
      <section class="panel"><div class="panel-head"><div class="h3">League matches</div></div>
        <div class="lg-matches">${(L.scheduled || []).map((g) => matchRow(g, false)).join("")}${finished.map((g) => matchRow(g, true)).join("") || `<div class="empty small">No league matches played yet.</div>`}</div></section>
    </div>
    <section class="panel lg-section"><div class="panel-head"><div class="h3">Team stats</div><span class="grow"></span><span class="sub">From ${withDemo.length} of ${leagueMatches.length} league match${leagueMatches.length === 1 ? "" : "es"} with a demo in your library</span></div>
      ${team.length ? `<div class="table-wrap"><table class="lg-table"><thead><tr>${TCOLS.map(([k, t]) => `<th data-tsort="${k}" class="${leagueView.teamSort === k ? "on" : ""} ${k === "name" ? "left" : ""}">${t}${leagueView.teamSort === k ? (leagueView.teamDesc ? " ↓" : " ↑") : ""}</th>`).join("")}</tr></thead>
        <tbody>${team.map((p) => `<tr class="${p.is_me ? "me" : ""}">${TCOLS.map(([k]) => tcell(p, k)).join("")}</tr>`).join("")}</tbody></table></div>`
        : `<div class="empty small">Get the demos of your league matches (Match history → Get demos) and your team's stats show here.</div>`}</section>
    <section class="panel lg-section"><div class="panel-head"><div class="h3">Standings</div><span class="grow"></span><span class="sub">${esc(st.division_name || "")} ${esc(st.conference_name || "")} · ${esc(st.stage_name || "")}</span></div>
      <div class="lg-standings-wrap"><table class="lg-table lg-standings"><thead><tr><th>#</th><th class="left">Team</th><th>Country</th><th>Matches</th><th>Won</th><th>Lost</th><th>+/-</th><th>Rounds</th><th>Points</th></tr></thead>
        <tbody>${mine ? standRow(mine, true) : ""}${standShown.map((t) => standRow(t, false)).join("")}</tbody></table></div>
      ${L.standings.length > STANDINGS_TOP ? `<button class="btn ghost lg-more" id="lg-stand-all">${leagueView.allStandings ? `Show top ${STANDINGS_TOP}` : `View all standings (${L.standings.length} teams)`}</button>` : ""}</section>
    <div id="lg-division"><section class="panel lg-section"><div class="empty small">Reading every league match in your conference from FACEIT… FACEIT only allows a request every so often, so the first time takes a few minutes; after that only new matches are read.</div></section></div>
    <div class="note">Standings and match stats from FACEIT's public league pages, refreshed every 20 minutes (or with Refresh). Team stats come from your own demos: HLTV Rating 3.0, RWS and Swing the same way as the rest of Veloxify.</div>`;

  view.querySelector("#lg-refresh").onclick = async (e) => { e.target.disabled = true; e.target.textContent = "Refreshing…"; await loadLeague(true); renderLeague(view); };
  tickCountdowns(view);
  view.querySelectorAll(".lg-scout").forEach((b) => b.addEventListener("click", (e) => e.stopPropagation()));
  view.querySelector("#lg-stand-all")?.addEventListener("click", () => { leagueView.allStandings = !leagueView.allStandings; renderLeague(view); });
  const divEl = view.querySelector("#lg-division");
  loadDivision().then((D) => { if (document.body.contains(divEl)) renderDivision(divEl, D, L, rosterIds, st); });
  view.querySelectorAll("[data-tsort]").forEach((th) => (th.onclick = () => { const k = th.dataset.tsort; leagueView.teamDesc = leagueView.teamSort === k ? !leagueView.teamDesc : k !== "name"; leagueView.teamSort = k; renderLeague(view); }));
}

// "in 4d 6h 12m" until a time (then "Starting", and "Live" for the next couple of hours).
function countdown(at) {
  const ms = at - Date.now();
  if (ms <= 0) return ms > -3 * 3600e3 ? "Live" : "Started";
  const m = Math.floor(ms / 60e3), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return d ? `in ${d}d ${h}h ${mm}m` : h ? `in ${h}h ${pad2(mm)}m` : mm ? `in ${mm}m` : "Starting";
}
// Keeps the countdowns on the page current (every 20 s while it's shown).
function tickCountdowns(root) {
  const tick = () => {
    const els = [...root.querySelectorAll(".lg-count[data-at]")];
    if (!els.length || !document.body.contains(root)) return;
    els.forEach((el) => (el.textContent = countdown(Number(el.dataset.at))));
    setTimeout(tick, 20e3);
  };
  setTimeout(tick, 20e3);
}

// ---- scouting a league team -----------------------------------------------------------------------

async function loadScout(team) {
  if (tauri) return tauri.core.invoke("league_scout", { teamId: team });
  const r = await fetch(assetUrl(`scout/${team}.json`), { cache: "no-store" });
  if (!r.ok) throw new Error("no scout file");
  return r.json();
}

// Rating 1.0 from FACEIT's per-player totals (as the division tables), and the rest of a player's line.
function scoutLine(t) {
  const r = Math.max(1, t.rounds), k = t.kills || 0, d = t.deaths || 0;
  const k1 = Math.max(0, k - 2 * (t.k2 || 0) - 3 * (t.k3 || 0) - 4 * (t.k4 || 0) - 5 * (t.k5 || 0));
  const rating = (k / r / 0.679 + 0.7 * (Math.max(0, r - d) / r) / 0.317 + (k1 + 4 * (t.k2 || 0) + 9 * (t.k3 || 0) + 16 * (t.k4 || 0) + 25 * (t.k5 || 0)) / r / 1.277) / 2.7;
  return { ...t, rating, kd: k / Math.max(1, d), adr: (t.damage || 0) / r, kr: k / r, hs: k ? ((t.headshots || 0) / k) * 100 : 0,
    entry: t.entry_tries ? (t.entry_wins || 0) / t.entry_tries : null, entryRate: (t.entry_tries || 0) / r, awp: k ? (t.sniper_kills || 0) / k : 0 };
}

// The scout: everything about a team before you play them, as a scout would put it.
async function renderScout(view, team) {
  view.innerHTML = `<a class="day-back" href="#/league">◀ ESEA</a><div class="empty">Scouting the team on FACEIT… The first time takes a minute or two (FACEIT allows a request a second); after that it's quick.</div>`;
  let S, L;
  try { [S, L] = await Promise.all([loadScout(team), loadLeague().catch(() => null)]); } catch (e) {
    view.innerHTML = `<a class="day-back" href="#/league">◀ ESEA</a><div class="empty">Couldn't scout this team: ${esc(String(e))}</div>`;
    return;
  }
  const P = S.profile || {};
  const name = P.name || "Team";
  const st = L?.standings?.find((t) => t.premade_team_id === team);
  // Played league matches from their side.
  const games = (S.matches || []).map((m) => {
    const fs = Object.entries(m.teams || {});
    const [usF, us] = fs.find(([, t]) => t.id === team) || fs[0] || [];
    const [themF, them] = fs.find(([f]) => f !== usF) || [];
    const a = m.score?.[usF]?.score ?? 0, b = m.score?.[themF]?.score ?? 0;
    const vetoes = (m.vetoes || []).map((v) => ({ ...v, ours: v.by === usF }));
    return { m, usF, us: us || {}, them: them || {}, won: a > b, a, b, map: m.map, when: new Date(m.started || m.finished), vetoes };
  }).sort((x, y) => y.when - x.when);
  const W = games.filter((g) => g.won).length;
  // Maps: record, rounds, who left it in.
  const maps = {};
  for (const g of games) {
    const r = (maps[g.map] ||= { map: g.map, w: 0, l: 0, rf: 0, ra: 0, n: 0 });
    r.n++; g.won ? r.w++ : r.l++; r.rf += g.a; r.ra += g.b;
  }
  const mapRows = Object.values(maps).sort((x, y) => y.n - x.n || y.w - x.w);
  // Bans: how often they remove each map, and their first ban.
  const bans = {}, firsts = {}, theyFaced = {};
  for (const g of games) {
    const ours = g.vetoes.filter((v) => v.ours && v.status === "drop").sort((x, y) => x.round - y.round);
    ours.forEach((v, i) => { bans[v.map] = (bans[v.map] || 0) + 1; if (i === 0) firsts[v.map] = (firsts[v.map] || 0) + 1; });
    g.vetoes.filter((v) => !v.ours && v.status === "drop").forEach((v) => (theyFaced[v.map] = (theyFaced[v.map] || 0) + 1));
  }
  const vetoGames = games.filter((g) => g.vetoes.length).length;
  const pool = [...new Set([...Object.keys(bans), ...Object.keys(theyFaced), ...Object.keys(maps)])].filter(Boolean);
  const neverBanned = vetoGames >= 2 ? pool.filter((m) => !bans[m]) : [];
  // Players: their league totals.
  const tot = {};
  for (const g of games) {
    for (const mp of g.m.stats || []) {
      const side = (mp.teams || []).find((t) => t.name === g.us.name) || (mp.teams || []).find((t) => (t.players || []).some((p) => (g.us.roster || []).some((r) => r.id === p.playerId)));
      for (const p of side?.players || []) {
        const t = (tot[p.playerId] ||= { id: p.playerId, nickname: p.nickname, rounds: 0, maps: 0 });
        t.maps++; t.rounds += Number(mp.rounds) || 0;
        for (const [key, field] of [["i6", "kills"], ["i7", "assists"], ["i8", "deaths"], ["i13", "headshots"], ["i40", "k2"], ["i14", "k3"], ["i15", "k4"], ["i16", "k5"], ["i20", "damage"], ["i21", "entry_tries"], ["i22", "entry_wins"], ["i23", "v1_tries"], ["i24", "v1_wins"], ["i30", "utility_damage"], ["i35", "first_kills"], ["i39", "sniper_kills"]]) {
          t[field] = (t[field] || 0) + (Number(p[key]) || 0);
        }
      }
    }
  }
  const avatarOf = new Map();
  for (const g of games) for (const r of g.us.roster || []) { avatarOf.set(r.id, r.avatar); }
  for (const mbr of P.members || []) if (mbr.avatar) avatarOf.set(mbr.id, mbr.avatar);
  const players = Object.values(tot).map(scoutLine).sort((a, b) => b.rating - a.rating);
  const regulars = players.filter((p) => p.maps >= Math.max(1, Math.ceil(games.length * 0.5)));
  // Each member's recent FACEIT form.
  const form = (uid) => {
    const list = (S.form?.[uid] || []).filter((x) => x.map);
    if (!list.length) return null;
    const won = list.filter((x) => String(x.won) === "1").length;
    const kd = list.reduce((a, x) => a + (Number(x.kd) || 0), 0) / list.length;
    const adr = list.reduce((a, x) => a + (Number(x.adr) || 0), 0) / list.length;
    const elo = Number(list.find((x) => x.elo)?.elo) || null;
    const byMap = {};
    for (const x of list) byMap[x.map] = (byMap[x.map] || 0) + 1;
    const fav = Object.entries(byMap).sort((a, b) => b[1] - a[1]).slice(0, 3);
    return { n: list.length, won, kd, adr, elo, fav };
  };
  // Seasons.
  const seasons = (S.seasons || []).flatMap((l) => (l.league_seasons_info || []).map((x) => ({ ...x, league: l.league_name })))
    .sort((a, b) => Number(b.season_number) - Number(a.season_number));
  const stageText = (s) => (s.season_standings || []).map((x) => `${x.stage_name}: <b>${x.wins}-${x.losses}</b>${x.placement?.left ? ` (#${x.placement.left}${x.placement.right && x.placement.right !== x.placement.left ? `–${x.placement.right}` : ""})` : ""}`).join(" · ");
  // The report: what to look out for.
  const tips = [];
  const last = seasons.find((x) => (x.season_standings || []).some((y) => Number(y.wins) + Number(y.losses) > 0) && x !== seasons[0]);
  if (last) tips.push(`Last season (S${last.season_number}) they played ${esc((last.season_standings[0] || {}).division_name || "")} ${esc((last.season_standings[0] || {}).conference_name || "")}: ${stageText(last)}.`);
  const topFirst = Object.entries(firsts).sort((a, b) => b[1] - a[1])[0];
  if (topFirst && vetoGames >= 2) tips.push(`First ban: <b>${esc(mapName(topFirst[0]))}</b> in ${topFirst[1]} of ${vetoGames} map votes.`);
  const always = Object.entries(bans).filter(([, n]) => n >= Math.max(2, vetoGames * 0.75)).map(([m]) => mapName(m));
  if (always.length) tips.push(`They almost always ban <b>${esc(always.join(", "))}</b>.`);
  if (neverBanned.length) tips.push(`They never banned <b>${esc(neverBanned.map(mapName).join(", "))}</b>: expect to play one of these.`);
  const most = mapRows[0];
  if (most && most.n >= 3) tips.push(`They play <b>${esc(mapName(most.map))}</b> the most: ${most.n} of ${games.length} maps (${most.w}-${most.l}).`);
  const best = mapRows.filter((r) => r.n >= 2).sort((a, b) => b.w / b.n - a.w / a.n || b.n - a.n)[0];
  if (best) tips.push(`Best map: <b>${esc(mapName(best.map))}</b> (${best.w}-${best.l}, rounds ${best.rf}-${best.ra}).`);
  const worst = mapRows.filter((r) => r.n >= 2 && r.l > r.w).sort((a, b) => a.w / a.n - b.w / b.n)[0];
  if (worst) tips.push(`They struggle on <b>${esc(mapName(worst.map))}</b> (${worst.w}-${worst.l}).`);
  if (regulars[0]) tips.push(`Their star: <b>${esc(regulars[0].nickname)}</b>, rating ${f2(regulars[0].rating)} with ${f1(regulars[0].adr)} ADR${regulars[0].awp > 0.3 ? `, their AWPer (${Math.round(regulars[0].awp * 100)}% of kills with a sniper)` : ""}.`);
  const awper = regulars.find((p) => p.awp > 0.3 && p !== regulars[0]);
  if (awper) tips.push(`AWPer: <b>${esc(awper.nickname)}</b> (${Math.round(awper.awp * 100)}% of kills with a sniper).`);
  const entry = [...regulars].sort((a, b) => b.entryRate - a.entryRate)[0];
  if (entry && entry.entry_tries >= 5) tips.push(`<b>${esc(entry.nickname)}</b> takes most opening duels (${Math.round(entry.entryRate * 100)}% of rounds, wins ${Math.round((entry.entry || 0) * 100)}%).`);
  const weak = regulars.length >= 4 ? regulars[regulars.length - 1] : null;
  if (weak && weak.rating < 0.95) tips.push(`Weakest link: <b>${esc(weak.nickname)}</b> (rating ${f2(weak.rating)}).`);

  const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : "–");
  const recent = games.filter((g) => Date.now() - g.when < 28 * 86400e3 && (g.m.demo_urls || []).length);
  view.innerHTML = `
    <a class="day-back" href="#/league">◀ ESEA</a>
    <section class="lg-hero sc-hero">
      ${P.avatar ? `<img class="sc-av" src="${esc(P.avatar)}" alt="">` : `<span class="sc-av none"></span>`}
      <div class="lg-title">
        <div class="sub">Scouting report${P.country ? ` · ${esc(P.country.toUpperCase())}` : ""}${P.created_at ? ` · team since ${esc(new Date(P.created_at).toLocaleDateString("en-US", { month: "short", year: "numeric" }))}` : ""}</div>
        <div class="h1">${esc(name)}${P.nickname && P.nickname !== name ? ` <span class="sub">${esc(P.nickname)}</span>` : ""}</div>
        ${seasons[0] ? `<div class="lg-div">S${esc(seasons[0].season_number)} · ${stageText(seasons[0])}</div>` : ""}
      </div>
      <div class="lg-nums">
        <div><b><span class="up">${W}</span>-<span class="down">${games.length - W}</span></b><span>League maps</span></div>
        ${st ? `<div><b>#${st.rank_start}</b><span>in your conference</span></div><div><b>${st.points || 0}</b><span>Points</span></div>` : ""}
      </div>
      ${tauri ? `<button class="btn primary" id="sc-demos" ${recent.length ? "" : "disabled"} title="FACEIT keeps demos about a month">${ICONS.download} Get their demos${recent.length ? ` (${recent.length})` : ""}</button>` : ""}
    </section>
    ${S.busy ? `<div class="ml-note">FACEIT asked Veloxify to slow down; the rest is read next time you open this.</div>` : ""}
    <section class="panel sc-report"><div class="panel-head"><div class="h3">What to look out for</div><span class="grow"></span><span class="sub">From ${games.length} league map${games.length === 1 ? "" : "s"} and their players' recent FACEIT games</span></div>
      ${tips.length ? `<ul>${tips.map((t) => `<li>${t}</li>`).join("")}</ul>` : `<div class="empty small">Not enough league matches yet to say much.</div>`}</section>
    <div class="lg-grid">
      <section class="panel"><div class="panel-head"><div class="h3">Maps</div><span class="grow"></span><span class="sub">League maps, and how they vote</span></div>
        <table class="lg-table"><thead><tr><th class="left">Map</th><th>Played</th><th>W-L</th><th>Rounds</th><th>They banned</th><th>First ban</th><th>Others banned</th></tr></thead>
        <tbody>${pool.sort((a, b) => (maps[b]?.n || 0) - (maps[a]?.n || 0) || (bans[a] || 0) - (bans[b] || 0)).map((m) => { const r = maps[m]; return `<tr>
          <td class="left">${mapIcon(m)}<span>${esc(mapName(m))}</span></td><td>${r?.n || 0}</td>
          <td>${r ? `<span class="up">${r.w}</span>-<span class="down">${r.l}</span>` : "–"}</td><td>${r ? `${r.rf}-${r.ra}` : "–"}</td>
          <td>${bans[m] ? `${bans[m]} of ${vetoGames}` : "never"}</td><td>${firsts[m] || ""}</td><td>${theyFaced[m] || 0}</td></tr>`; }).join("")}</tbody></table></section>
      <section class="panel"><div class="panel-head"><div class="h3">Seasons</div></div>
        <div class="sc-seasons">${seasons.map((x) => `<div class="sc-season"><b>S${esc(x.season_number)}</b><span>${esc((x.season_standings[0] || {}).division_name || "")} ${esc((x.season_standings[0] || {}).conference_name || "")}</span><span>${stageText(x)}</span></div>`).join("") || `<div class="empty small">No seasons found.</div>`}</div></section>
    </div>
    <section class="panel lg-section" id="sc-strats"><div class="panel-head"><div class="h3">Setups and strategies</div><span class="grow"></span><span class="sub">From their demos</span></div>
      <div class="sc-strat-body"><div class="empty small">${tauri ? `Get their demos (button at the top), then <button class="btn small" id="sc-read">Read their demos</button> to see how they set up on CT and where they go on T.` : "Read in the app from their demos."}</div></div></section>
    <section class="panel lg-section"><div class="panel-head"><div class="h3">Players</div><span class="grow"></span><span class="sub">League totals (FACEIT's stats), then each player's last FACEIT games</span></div>
      <div class="table-wrap"><table class="lg-table"><thead><tr><th class="left">Player</th><th>Maps</th><th>Rating 1.0</th><th>K/D</th><th>ADR</th><th>HS%</th><th>Opening duels</th><th>1v1s</th><th>Sniper kills</th><th>Utility dmg</th><th>Recent FACEIT</th><th class="left">Plays most</th></tr></thead>
      <tbody>${players.map((p) => { const fm = form(p.id); return `<tr>
        <td class="left">${avatarOf.get(p.id) ? `<img class="lg-tav" src="${esc(avatarOf.get(p.id))}" alt="">` : `<span class="lg-tav none"></span>`}<span>${esc(p.nickname)}</span>${p.awp > 0.3 ? ` <span class="tag">AWP</span>` : ""}${p === entry && entry.entry_tries >= 5 ? ` <span class="tag">Entry</span>` : ""}</td>
        <td>${p.maps}</td><td><span class="mp-rating ${ratingClass(p.rating)}">${f2(p.rating)}</span></td><td>${f2(p.kd)}</td><td>${f1(p.adr)}</td><td>${Math.round(p.hs)}%</td>
        <td>${p.entry_tries ? `${p.entry_wins}/${p.entry_tries}` : "–"}</td><td>${p.v1_tries ? `${p.v1_wins}/${p.v1_tries}` : "–"}</td><td>${p.sniper_kills || 0}</td><td>${p.utility_damage || 0}</td>
        <td>${fm ? `${fm.elo ? `${levelBadge(levelFor(fm.elo), 16)} ${fm.elo.toLocaleString("en-US")} · ` : ""}${pct(fm.won, fm.n)} wins · K/D ${f2(fm.kd)}` : "–"}</td>
        <td class="left">${fm ? fm.fav.map(([m, n]) => `${esc(mapName(m))} <span class="sub">${n}</span>`).join(", ") : "–"}</td></tr>`; }).join("") || `<tr><td colspan="12" class="sub">No league stats yet.</td></tr>`}</tbody></table></div></section>
    <section class="panel lg-section"><div class="panel-head"><div class="h3">League matches</div><span class="grow"></span><span class="sub">Bans in order; FACEIT keeps demos about a month</span></div>
      <div class="lg-matches">${games.map((g) => `<div class="lg-match ${g.won ? "win" : "loss"}">
        <span class="lg-when">${fcDate(g.when)}</span>
        <span class="ml-score"><span class="wl ${g.won ? "win" : "loss"}">${g.won ? "W" : "L"}</span><span><b class="${g.won ? "win" : "loss"}">${g.a}</b> : <span class="theirs">${g.b}</span></span></span>
        <span class="lg-opp">${g.them.avatar ? `<img class="lg-tav" src="${esc(g.them.avatar)}" alt="">` : `<span class="lg-tav none"></span>`}<span>vs <b>${esc(g.them.name || "")}</b></span></span>
        <span class="lg-map">${mapIcon(g.map)}<span>${esc(mapName(g.map))}</span></span>
        <span class="sc-vetoes">${g.vetoes.filter((v) => v.status === "drop").sort((x, y) => x.round - y.round).map((v) => `<span class="sc-veto ${v.ours ? "ours" : ""}" title="${v.ours ? esc(name) : "Opponent"} banned ${esc(mapName(v.map))}">${esc(mapName(v.map))}</span>`).join("")}</span>
      </div>`).join("") || `<div class="empty small">No league matches found.</div>`}</div></section>
    <div class="note">From FACEIT's public league, match and stats pages; cached, and read again after 6 hours. Rating 1.0 is HLTV's original formula on FACEIT's numbers. Get their demos to have Veloxify read their setups and strategies.</div>`;
  view.querySelector("#sc-demos")?.addEventListener("click", (e) => {
    e.target.disabled = true;
    e.target.textContent = "Downloading through FACEIT…";
    getDemos(recent.map((g) => g.m.id));
  });
  const stratBody = view.querySelector("#sc-strats .sc-strat-body");
  const readDemos = async (btn) => {
    if (btn) { btn.disabled = true; btn.textContent = "Reading their demos… (a few seconds each)"; }
    try {
      const list = await tauri.core.invoke("scout_demos", { teamId: team });
      if (document.body.contains(stratBody)) stratBody.innerHTML = strategiesHtml(list, name);
    } catch (e) {
      if (document.body.contains(stratBody)) stratBody.innerHTML = `<div class="empty small">${esc(String(e))}</div>`;
    }
  };
  view.querySelector("#sc-read")?.addEventListener("click", (e) => readDemos(e.target));
}

// A team's setups and strategies from their demos (scout_demos' rounds), map by map: CT setups by
// kind of round (A · mid · B), pushes, T sites, plant timing, and each side's record.
function strategiesHtml(list, name) {
  const ok = list.filter((x) => x.rounds?.length);
  if (!ok.length) return `<div class="empty small">${list.length ? "Couldn't read their demos." : "None of their demos are downloaded yet: Get their demos first."}</div>`;
  const byMap = {};
  for (const x of ok) (byMap[x.map] ||= []).push(x);
  const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : "–");
  const setupName = (s) => `${s.A} A · ${s.Mid} mid · ${s.B} B`;
  const top = (rounds, key, n = 3) => {
    const c = {};
    for (const r of rounds) { const k = key(r); if (k) c[k] = (c[k] || 0) + 1; }
    return Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, n);
  };
  const mmss = (t) => `${Math.floor(t / 60)}:${pad2(Math.round(t % 60))}`;
  return Object.entries(byMap).sort((a, b) => b[1].length - a[1].length).map(([map, games]) => {
    const rounds = games.flatMap((g) => g.rounds);
    const ct = rounds.filter((r) => r.side === "CT"), t = rounds.filter((r) => r.side === "T");
    const gun = (r) => r.buy === "full" || r.buy === "force";
    const ctLine = (list, label) => {
      if (!list.length) return "";
      const ts = top(list, (r) => setupName(r.setup));
      return `<div class="sc-strat-row"><span>${label}</span><b>${ts.map(([k, n]) => `${esc(k)} <span class="sub">${n}/${list.length}</span>`).join(" · ")}</b></div>`;
    };
    const tLine = (list, label) => {
      if (!list.length) return "";
      const a = list.filter((r) => r.plant?.site === "A").length, b = list.filter((r) => r.plant?.site === "B").length;
      return `<div class="sc-strat-row"><span>${label}</span><b>A ${pct(a, list.length)} · B ${pct(b, list.length)} · no plant ${pct(list.length - a - b, list.length)}</b></div>`;
    };
    const gunCt = ct.filter(gun), gunT = t.filter(gun);
    const pushes = gunCt.filter((r) => r.pushed > 0).length;
    const plants = t.filter((r) => r.plant?.t != null);
    const avgPlant = plants.length ? plants.reduce((s, r) => s + r.plant.t, 0) / plants.length : null;
    const fast = t.filter((r) => r.fast).length;
    // Where the pushes go (the places of the pushed players).
    const pushPlaces = top(gunCt.flatMap((r) => (r.spots || []).filter((sp) => sp.zone === "Mid")), (sp) => sp.place, 2);
    return `<div class="sc-strat">
      <div class="sc-strat-head">${mapIcon(map)}<b>${esc(mapName(map))}</b><span class="sub">${games.length} demo${games.length === 1 ? "" : "s"} · CT ${ct.filter((r) => r.won).length}-${ct.filter((r) => !r.won).length} · T ${t.filter((r) => r.won).length}-${t.filter((r) => !r.won).length}</span></div>
      <div class="sc-strat-cols">
        <div><div class="h4">CT side</div>
          ${ctLine(ct.filter((r) => r.buy === "pistol"), "Pistol rounds")}
          ${ctLine(gunCt, "Gun rounds")}
          ${ctLine(ct.filter((r) => r.buy === "eco"), "Ecos")}
          ${gunCt.length ? `<div class="sc-strat-row"><span>Pushes</span><b>someone pushes forward in ${pct(pushes, gunCt.length)} of gun rounds${pushPlaces.length ? ` <span class="sub">(mid players often at ${esc(pushPlaces.map(([p]) => p).join(", "))})</span>` : ""}</b></div>` : ""}
        </div>
        <div><div class="h4">T side</div>
          ${tLine(t.filter((r) => r.buy === "pistol"), "Pistol rounds")}
          ${tLine(gunT, "Gun rounds")}
          ${avgPlant != null ? `<div class="sc-strat-row"><span>Plants</span><b>average ${mmss(avgPlant)} into the round · fast hits (under 0:35) ${pct(fast, t.length)}</b></div>` : ""}
        </div>
      </div>
    </div>`;
  }).join("") + `<div class="note">Setups: where their CTs stand 20 seconds into the round (on A, on B, or in between: mid). Gun rounds include force buys. ${ok.length} of their demos read.</div>`;
}

// ---- match history --------------------------------------------------------------------------

let mh = { source: "all", result: "all", map: "all", shown: 50 };
// Match history's sort (newest first unless a column was clicked), kept between visits.
let mhSort = { key: "date", desc: true };
try { mhSort = { ...mhSort, ...JSON.parse(localStorage.getItem("veloxify.historySort") || "{}") }; } catch (e) { /* newest first */ }

// Every match: library matches and FACEIT's stats-only ones (see mergeFaceit).
function historyRows() {
  return state.all.map((m) => {
    const fm = m.faceit;
    return {
      id: m.id, demo: !m.stats_only, date: m.played_at.slice(0, 10), source: m.source, map: m.map, result: m.result,
      when: parseLocal(m.played_at), mine: m.score_mine, theirs: m.score_theirs, line: m.line, hl: m.highlight_count, duration: m.duration_s || 0,
      elo: m.elo ?? fm?.elo ?? null,
      delta: m.source === "faceit" ? m.elo_delta ?? fm?.elo_delta ?? null : m.premier_delta ?? null,
      premier: m.premier ?? null, placement: !!fm?.calibrating, competition: fm?.competition || "",
      room: m.source === "faceit" ? fm?.match_id || m.id.replace(/^faceit-/, "1-").replace(/-m\d+$/, "") : null,
    };
  }).sort((a, b) => b.when - a.when);
}

// Every column the match history can show ([key, header, width]); Columns picks which, dragging a
// header moves one (saved). The buttons stay last.
const HIST_COLS = [["date", "Date", "112px"], ["score", "Score", "112px"], ["elo", "ELO / Premier", "minmax(170px, 1.3fr)"], ["rating", "HLTV 3.0", "92px"],
  ["rws", "RWS", "56px"], ["kda", "K/D/A", "108px"], ["adr", "ADR", "64px"], ["map", "Map", "minmax(140px, 1fr)"],
  ["kills", "Kills", "52px"], ["deaths", "Deaths", "58px"], ["assists", "Assists", "60px"], ["kd", "K/D", "56px"], ["kr", "K/R", "56px"], ["hs", "HS%", "56px"],
  ["kast", "KAST", "60px"], ["swing", "Swing", "70px"], ["rating2", "Rating 2.0", "84px"], ["rating1", "Rating 1.0", "84px"], ["multi", "2K / 3K / 4K / 5K", "120px"],
  ["fk", "First kills", "72px"], ["fd", "First deaths", "80px"], ["trades", "Trade kills", "76px"], ["clutch", "Clutches", "70px"], ["ud", "Utility dmg", "80px"],
  ["ef", "Flashed", "62px"], ["fa", "Flash assists", "86px"], ["mvps", "MVPs", "52px"], ["acc", "Accuracy", "70px"], ["dmg", "Damage", "68px"], ["rounds", "Rounds", "60px"],
  ["length", "Length", "64px"], ["source", "Source", "82px"], ["aim", "Aim", "72px"], ["util", "Utility", "72px"]];
const HIST_DEFAULT = ["date", "score", "elo", "rating", "swing", "rws", "kda", "aim", "util", "adr", "map"];
const HIST_GROUPS = [["Match", ["date", "score", "elo", "map", "source", "rounds", "length"]], ["Ratings", ["rating", "rating2", "rating1", "rws", "swing", "aim", "util"]],
  ["Kills and damage", ["kda", "kills", "deaths", "assists", "kd", "kr", "hs", "adr", "dmg", "kast", "mvps"]], ["Multi-kills, openings, clutches", ["multi", "fk", "fd", "trades", "clutch"]],
  ["Utility and aim", ["ud", "ef", "fa", "acc"]]];
const histCols = () => {
  // Swing became a default column: put it next to HLTV 3.0 in a layout saved before (once).
  try {
    if (!localStorage.getItem("veloxify.historyCols.swing")) {
      localStorage.setItem("veloxify.historyCols.swing", "1");
      const saved = JSON.parse(localStorage.getItem("veloxify.historyCols") || "null");
      const list = Array.isArray(saved) ? saved : saved?.cols;
      if (Array.isArray(list) && !list.includes("swing")) {
        list.splice(list.includes("rating") ? list.indexOf("rating") + 1 : list.length, 0, "swing");
        savePickedCols("veloxify.historyCols", HIST_COLS, list);
      }
    }
    // Aim and Utility became default columns: right after K/D/A in a layout saved before (once).
    if (!localStorage.getItem("veloxify.historyCols.aim")) {
      localStorage.setItem("veloxify.historyCols.aim", "1");
      const saved = JSON.parse(localStorage.getItem("veloxify.historyCols") || "null");
      const list = Array.isArray(saved) ? saved : saved?.cols;
      if (Array.isArray(list)) {
        const add = ["aim", "util"].filter((k) => !list.includes(k));
        list.splice(list.includes("kda") ? list.indexOf("kda") + 1 : list.length, 0, ...add);
        savePickedCols("veloxify.historyCols", HIST_COLS, list);
      }
    }
  } catch (e) { /* defaults */ }
  return pickedCols("veloxify.historyCols", HIST_COLS, HIST_DEFAULT);
};
// The column editor for match lists (match history, a session's matches).
function editHistCols(btn, rerender) {
  openColPicker(btn, {
    catalog: HIST_COLS.map(([k, l]) => [k, l]), groups: HIST_GROUPS, cols: histCols(),
    onChange: (list) => { savePickedCols("veloxify.historyCols", HIST_COLS, list); rerender(); },
    onReset: () => { try { localStorage.removeItem("veloxify.historyCols"); } catch (err) { /* nothing saved */ } rerender(); },
  });
}
const histTemplate = (cols) => `${cols.map((k) => HIST_COLS.find((c) => c[0] === k)[2]).join(" ")} 96px`;
// The narrowest a row can be: with many columns the list scrolls sideways, every row as wide.
const histMinWidth = (cols) => sum(cols.map((k) => parseInt(/(\d+)px/.exec(HIST_COLS.find((c) => c[0] === k)[2])[1], 10))) + 96 + 12 * cols.length + 28;
const histGridStyle = (cols) => `grid-template-columns:${histTemplate(cols)};min-width:${histMinWidth(cols)}px`;

// A match's value in a column, for sorting the list by it (null: no data, always last).
function histSortValue(r, k) {
  const l = r.line, demo = l && !l.faceit_only;
  const counted = (f) => (demo && l.rounds ? l[f] ?? null : null);
  switch (k) {
    case "date": return +r.when;
    case "score": return r.mine - r.theirs;
    case "elo": return r.elo ?? r.premier ?? null;
    case "rating": return demo ? r3(l) : null;
    case "rws": case "kast": case "swing": case "rating2": case "rating1": return demo ? l[k] ?? null : null;
    case "kda": case "kills": return l?.kills ?? null;
    case "deaths": return l?.deaths ?? null;
    case "assists": return l?.assists ?? null;
    case "adr": return l?.adr ?? null;
    case "kd": return l ? l.kd ?? (l.deaths ? l.kills / l.deaths : l.kills) : null;
    case "kr": return l?.kpr ?? null;
    case "hs": return l?.hs_pct ?? null;
    case "mvps": return l?.mvps ?? null;
    case "aim": case "util": {
      const st = state.myStatsById?.get(r.id);
      return st ? customRating(ratingDef(k === "aim" ? "aim" : "utility"), st) : null;
    }
    // Bigger multi-kills count for more: a 5K above any number of 2Ks.
    case "multi": return demo && l.multi ? (l.multi[2] || 0) + 10 * (l.multi[3] || 0) + 100 * (l.multi[4] || 0) + 1000 * (l.multi[5] || 0) : null;
    case "fk": return counted("opening_kills");
    case "fd": return counted("opening_deaths");
    case "trades": return counted("trade_kills");
    case "clutch": return counted("clutches_won");
    case "ud": return counted("utility_damage");
    case "ef": return counted("enemies_flashed");
    case "fa": return counted("flash_assists");
    case "acc": return counted("accuracy");
    case "dmg": return counted("damage");
    case "rounds": return r.mine + r.theirs;
    case "length": return r.duration || null;
    case "map": return mapName(r.map);
    case "source": return r.source;
    default: return null;
  }
}
// Sorted by `sort` ({ key, desc }), matches without a value last either way; ties stay newest first.
function sortHistory(rows, sort) {
  if (!sort?.key) return rows;
  const dir = sort.desc ? -1 : 1;
  return rows.map((r) => ({ r, v: histSortValue(r, sort.key) })).sort((a, b) => {
    if (a.v == null || b.v == null) return (a.v == null) - (b.v == null);
    const c = typeof a.v === "string" ? a.v.localeCompare(b.v) : a.v - b.v;
    return c * dir;
  }).map((x) => x.r);
}

// The match list with your columns (Match history, and each session's matches). With `sort`, the
// headers show which column it's sorted by.
function historyTable(rows, cols, sort = null) {
  return `<div class="ml-table"><div class="ml-grid ml-head" style="${histGridStyle(cols)}">
      ${cols.map((k) => `<div data-col="${k}" class="${sort?.key === k ? "on" : ""}" title="${sort ? "Click to sort, drag to move" : "Drag to move"}">${k === "rating" ? `<span class="ic">${ICONS.rating}</span>` : ""}${esc(HIST_COLS.find((c) => c[0] === k)[1])}${sort?.key === k ? `<span class="ml-sort">${sort.desc ? "↓" : "↑"}</span>` : ""}</div>`).join("")}<div class="ml-addcol-cell"><button class="ml-addcol" data-addcol title="Add, remove or move columns">+ Columns</button></div>
    </div>
    ${rows.map((r) => historyRow(r, cols)).join("")}</div>`;
}

function historyRow(r, cols) {
  const l = r.line;
  const demo = l && !l.faceit_only; // FACEIT's own numbers cover only some columns
  const na = `<span class="ml-num na">–</span>`;
  const num = (v, txt, grade) => (v == null || Number.isNaN(v) ? na : `<span class="ml-num ${grade ? gradeClass(grade, v) : ""}">${txt ?? v}</span>`);
  const cell = (k) => {
    switch (k) {
      case "date": return `<div class="ml-date">${fcDate(r.when)}</div>`;
      case "score": return `<div class="ml-score"><span class="wl ${r.result}">${r.result === "win" ? "W" : r.result === "loss" ? "L" : "T"}</span><span><b class="${r.result}">${r.mine}</b> : <span class="theirs">${r.theirs}</span></span></div>`;
      case "elo": return `<div class="ml-elo">${r.source === "faceit"
        ? r.elo ? `${levelBadge(levelFor(r.elo))}<span>${r.elo.toLocaleString("en-US")}</span>${deltaHtml(r.delta)}` : leagueOf(r.competition) ? leagueChip(r.competition) : r.placement ? `<span class="none" title="FACEIT shows no ELO during a new season's placement matches">Placement match</span>` : `<span class="none">–</span>`
        : r.source === "valve" ? r.premier ? `${premierChip(r.premier)}${deltaHtml(r.delta)}` : `<span class="none">Unranked</span>` : `<span class="none">–</span>`}</div>`;
      case "rating": { const rv = demo ? r3(l) : null; return `<div>${rv ? `<span class="rchip ${ratingClass(rv)}" title="HLTV Rating 3.0 (estimated from the demo)">${f2(rv)}<i style="width:${Math.min(100, (rv / 2) * 100)}%"></i></span>` : `<span class="rchip na" title="Needs the demo">–</span>`}</div>`; }
      case "rws": return `<div>${demo ? num(l.rws, f1(l.rws), "rws") : na}</div>`;
      case "kda": return `<div class="ml-num">${l ? `${l.kills} / ${l.deaths} / ${l.assists}` : "–"}</div>`;
      case "adr": return `<div>${l?.adr != null ? num(l.adr, f1(l.adr), "adr") : na}</div>`;
      case "map": return `<div class="ml-map">${mapIcon(r.map)}<span>${esc(mapName(r.map))}</span></div>`;
      case "kills": return `<div>${l ? num(l.kills) : na}</div>`;
      case "deaths": return `<div>${l ? num(l.deaths) : na}</div>`;
      case "assists": return `<div>${l ? num(l.assists) : na}</div>`;
      case "kd": { const v = l ? l.kd ?? (l.deaths ? l.kills / l.deaths : l.kills) : null; return `<div>${v != null ? num(v, f2(v), "kd") : na}</div>`; }
      case "kr": return `<div>${l?.kpr ? num(l.kpr, f2(l.kpr), "kpr") : na}</div>`;
      case "hs": return `<div>${l?.hs_pct != null ? num(l.hs_pct, `${Math.round(l.hs_pct)}%`) : na}</div>`;
      case "kast": return `<div>${demo ? num(l.kast, `${Math.round(l.kast)}%`, "kast") : na}</div>`;
      case "swing": return `<div>${demo ? num(l.swing || 0, fmtSwing(l.swing || 0), "swing") : na}</div>`;
      case "rating2": return `<div>${demo && l.rating2 ? num(l.rating2, f2(l.rating2), "rating") : na}</div>`;
      case "rating1": return `<div>${demo && l.rating1 ? num(l.rating1, f2(l.rating1), "rating") : na}</div>`;
      case "aim": case "util": {
        const st = state.myStatsById?.get(r.id);
        return rateCell(st ? customRating(ratingDef(k === "aim" ? "aim" : "utility"), st) : null, "div");
      }
      case "multi": return `<div class="ml-num">${demo && l.multi ? l.multi.slice(2).join(" / ") : "–"}</div>`;
      case "fk": return `<div>${demo && l.rounds ? num(l.opening_kills) : na}</div>`;
      case "fd": return `<div>${demo && l.rounds ? num(l.opening_deaths) : na}</div>`;
      case "trades": return `<div>${demo && l.rounds ? num(l.trade_kills) : na}</div>`;
      case "clutch": return `<div>${demo && l.rounds ? num(l.clutches_won, `${l.clutches_won}/${l.clutches}`) : na}</div>`;
      case "ud": return `<div>${demo && l.rounds ? num(l.utility_damage) : na}</div>`;
      case "ef": return `<div>${demo && l.rounds ? num(l.enemies_flashed) : na}</div>`;
      case "fa": return `<div>${demo && l.rounds ? num(l.flash_assists) : na}</div>`;
      case "mvps": return `<div>${l?.mvps != null ? num(l.mvps) : na}</div>`;
      case "acc": return `<div>${demo && l.rounds ? num(l.accuracy, `${Math.round(l.accuracy)}%`) : na}</div>`;
      case "dmg": return `<div>${demo && l.rounds ? num(l.damage) : na}</div>`;
      case "rounds": return `<div>${num(r.mine + r.theirs)}</div>`;
      case "length": return `<div>${r.duration ? num(r.duration, fmtDur(r.duration)) : na}</div>`;
      case "source": return `<div class="ml-num">${r.source === "faceit" ? "FACEIT" : r.source === "valve" ? "Premier" : esc(r.source)}</div>`;
      default: return "<div></div>";
    }
  };
  const actions = r.demo
    ? `<button class="sqbtn ${r.hl ? "hl" : "dim"}" data-act="hl" title="${r.hl ? `${r.hl} highlight${r.hl === 1 ? "" : "s"}` : "No highlights in this match"}">${ICONS.star}${r.hl}</button>`
    : `<button class="sqbtn" data-act="demo" title="Get the demo: Veloxify opens the match room, you click FACEIT's download, Veloxify does the rest">${ICONS.download}</button>`;
  return `
    <div class="ml-grid ml-row ${r.result} clickable" style="${histGridStyle(cols)}" data-id="${esc(r.id)}" data-href="${matchHref(r.id)}" ${r.room ? `data-room="${esc(r.room)}"` : ""}>
      ${cols.map(cell).join("")}
      <div class="ml-actions">${actions}${r.room ? `<button class="sqbtn" data-act="room" title="Open the match room on FACEIT">${ICONS.external}</button>` : ""}</div>
    </div>`;
}

function renderMatchHistory(view) {
  const all = historyRows();
  const cols = histCols();
  // Your Aim and Utility per match need your per-match stats and the library's averages.
  if ((cols.includes("aim") || cols.includes("util")) && !state.myStatsById) {
    Promise.all([loadMyStats(), loadBenchmarks()]).then(([ms]) => {
      state.myStatsById = new Map((ms || []).map((x) => [x.id, x.stats || {}]));
      if (document.body.contains(view)) renderMatchHistory(view);
    });
  }
  const rows = sortHistory(all.filter((r) => (mh.source === "all" || r.source === mh.source) && (mh.result === "all" || r.result === mh.result) && (mh.map === "all" || r.map === mh.map)), mhSort);
  const maps = [...new Set(all.map((r) => r.map))].sort();
  const missing = all.filter((r) => !r.demo).length;
  const seg = (key, opts) => `<div class="seg" data-mkey="${key}">${opts.map(([v, label]) =>
    `<button data-v="${v}" class="${mh[key] === v ? "on" : ""}">${label}</button>`).join("")}</div>`;
  view.innerHTML = `
    <section class="fc-card">
      <div class="fc-head">
        <div class="h1">Match history</div>
        <span class="sub">${rows.length} matches</span>
        <span class="grow"></span>
        ${demoButton(missingDemos(state.all), "btn primary")}
        <button class="btn ghost small" id="mh-cols" title="Pick the stats each match shows">${COLS_ICON} Columns</button>
        <div class="fc-filters">
          ${seg("source", [["all", "All"], ["faceit", "FACEIT"], ["valve", "Premier"]])}
          ${seg("result", [["all", "All"], ["win", "Wins"], ["loss", "Losses"]])}
          <select id="mhmap"><option value="all">All maps</option>${maps.map((m) => `<option value="${m}" ${mh.map === m ? "selected" : ""}>${esc(mapName(m))}</option>`).join("")}</select>
        </div>
      </div>
      ${historyTable(rows.slice(0, mh.shown), cols, mhSort)}
      ${rows.length > mh.shown ? `<div style="text-align:center;margin-top:12px"><button class="btn" id="mhmore">Show more</button></div>` : ""}
      ${missing ? `<div class="ml-note">${missing} FACEIT match${missing === 1 ? "" : "es"} without a demo show FACEIT's stats only. Get the demo (download button) and Veloxify adds the rating, RWS, highlights and lowlights. FACEIT keeps demos for a few weeks.</div>` : ""}
    </section>`;
  view.querySelectorAll(".seg[data-mkey]").forEach((el) => el.querySelectorAll("button").forEach((b) => (b.onclick = () => { mh[el.dataset.mkey] = b.dataset.v; mh.shown = 50; renderMatchHistory(view); })));
  view.querySelector("#mhmap").onchange = (e) => { mh.map = e.target.value; mh.shown = 50; renderMatchHistory(view); };
  const setCols = (list) => { savePickedCols("veloxify.historyCols", HIST_COLS, list); renderMatchHistory(view); };
  wireColDrag([...view.querySelectorAll(".ml-head [data-col]")], () => cols, setCols);
  // Click a header to sort by it (highest first; again for lowest; names A to Z first).
  view.querySelectorAll(".ml-head [data-col]").forEach((th) => (th.onclick = () => {
    const k = th.dataset.col;
    mhSort = mhSort.key === k ? { key: k, desc: !mhSort.desc } : { key: k, desc: !["map", "source"].includes(k) };
    try { localStorage.setItem("veloxify.historySort", JSON.stringify(mhSort)); } catch (e) { /* not kept */ }
    renderMatchHistory(view);
  }));
  view.querySelectorAll("#mh-cols, [data-addcol]").forEach((b) => (b.onclick = (e) => { e.stopPropagation(); editHistCols(e.currentTarget, () => renderMatchHistory(view)); }));
  const more = view.querySelector("#mhmore");
  if (more) more.onclick = () => { mh.shown += 50; renderMatchHistory(view); };
  view.querySelectorAll(".ml-row").forEach((row) => (row.onclick = (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "room") return openFaceitRoom(row.dataset.room);
    if (act === "demo") return getDemos([row.dataset.room]);
    if (!row.dataset.href) return;
    location.hash = act === "hl" ? `${row.dataset.href}/highlights` : row.dataset.href;
  }));
}

// ---- practice ----------------------------------------------------------------------------------

const ACTIVE_MAPS = ["de_mirage", "de_inferno", "de_dust2", "de_nuke", "de_ancient", "de_anubis", "de_train", "de_overpass"];
// Only what pros are documented using (researched Oct 2026; ids checked against Steam's API).
const PRACTICE_PRESETS = [
  { id: "aimbotz", name: "Aim Botz", desc: "Bots standing or moving: taps, short bursts, flicks, switching guns. 10-20 minutes or 500-1,000 kills.",
    pros: "s1mple (up to 20 min a day), NiKo (500-1,000 kills before games)", kind: "workshop", target: "3070244462", mode: "none", fixes: ["aim", "late_stop", "moving", "moved_mid_spray", "spray"] },
  { id: "warmupserver", name: "FFA deathmatch · WarmupServer", desc: "Clean community FFA DM servers (NA, EU, SEA), no skins or extras. Opens their server list; join one, or add its address below to launch it in one click next time.",
    pros: "NiKo and m0NESY (Falcons); \"most active (and former) pros\" per ProSettings", kind: "link", target: "https://warmupserver.net/", fixes: ["aim", "late_stop", "moving", "spray"] },
  { id: "kz", name: "KZ movement warm-up", desc: "kz_checkmate: jumps and strafes for 10 minutes to wake up movement before playing. (Pros don't say which KZ maps; this is one of the two most played in CS2.)",
    pros: "donk (10 min of KZ before matches, no aim maps), ZywOo (KZ and surf instead of individual aim practice)", kind: "workshop", target: "3070194623", mode: "none", fixes: ["jumping"] },
  { id: "kz2", name: "KZ movement warm-up · Grotto", desc: "kz_grotto: the other most-played CS2 KZ map, a shorter climb.", pros: "As above (donk, ZywOo)", kind: "workshop", target: "3121168339", mode: "none", fixes: [] },
  { id: "yprac", name: "Yprac Hub · prefires and utility", desc: "Prefire routes to clear every angle, plus 1,400+ smoke, flash, molotov and HE lineups on all active maps. Pick the map you're about to play.",
    pros: "Reported in pro map prep; no named player on record", kind: "workshop", target: "3070715607", mode: "none", fixes: ["aim"] },
  { id: "utility", name: "Your own nade practice", desc: "Local server with the standard practice setup: no bots, infinite ammo, grenade trajectories, bullet impacts, buy anywhere, endless round.",
    pros: "The standard setup teams use to practice utility", kind: "map", target: "de_mirage", mode: "practice", pickMap: true, fixes: [] },
];
let practiceMaps = {};

function practiceCustom() {
  return (settingsData?.settings?.practice || []).map((p) => ({ ...p, custom: true }));
}

async function renderPractice(view) {
  if (tauri && !settingsData) settingsData = await tauri.core.invoke("get_settings");
  const custom = practiceCustom();
  // What your lowlights say to work on.
  const recent = (state.index.lowlights || []).filter((l) => l.played_ts > Date.now() / 1000 - 30 * DAY_S);
  const counts = {};
  for (const l of recent) counts[l.reason] = (counts[l.reason] || 0) + 1;
  const top = Object.entries(counts).filter(([r]) => r !== "unknown" && r !== "unlucky").sort((a, b) => b[1] - a[1])[0];
  const suggested = top ? PRACTICE_PRESETS.filter((p) => p.fixes.includes(top[0])) : [];
  const card = (p) => `
    <div class="pr-card ${suggested.includes(p) ? "suggested" : ""}" data-id="${esc(p.id)}">
      <div class="pr-top"><b>${esc(p.name)}</b><span class="src">${p.kind === "workshop" ? "WORKSHOP" : p.kind === "server" ? "SERVER" : p.kind === "link" ? "COMMUNITY DM" : "LOCAL"}</span>
        ${suggested.includes(p) ? `<span class="pr-sug">Suggested</span>` : ""}</div>
      <div class="sub">${esc(p.desc || (p.kind === "server" ? p.target : `${p.target}${p.mode && p.mode !== "none" ? " · " + p.mode : ""}`))}</div>
      ${p.pros ? `<div class="pr-pros"><b>Used by</b> ${esc(p.pros)}</div>` : ""}
      <div class="pr-actions">
        ${p.pickMap ? `<select data-map="${esc(p.id)}">${ACTIVE_MAPS.map((m) => `<option value="${m}" ${(practiceMaps[p.id] || p.target) === m ? "selected" : ""}>${esc(mapName(m))}</option>`).join("")}</select>` : ""}
        ${p.hsToggle ? `<label class="check"><input type="checkbox" data-hs="${esc(p.id)}"> Headshots only</label>` : ""}
        <span class="grow"></span>
        ${p.custom ? `<button class="btn ghost" data-del="${esc(p.id)}">Remove</button>` : ""}
        <button class="btn primary" data-launch="${esc(p.id)}">${p.kind === "link" ? "Open server list" : "Launch"}</button>
      </div>
    </div>`;
  view.innerHTML = `
    <div class="profile-head"><div><div class="h2">One click into CS2</div><div class="h1">Practice</div></div><span class="saved" id="pr-msg"></span></div>
    ${top ? `<div class="why-tip" style="margin:0 0 16px"><b>From your lowlights:</b> most misses in the last 30 days were <b>${esc((LL_REASONS[top[0]] || [top[0]])[0].toLowerCase())}</b> (${top[1]} of ${recent.length}). ${esc(LL_TIPS[top[0]] || "")}</div>` : ""}
    <div class="pr-grid">${PRACTICE_PRESETS.map(card).join("")}${custom.map(card).join("")}</div>
    <section class="panel" style="margin-top:20px">
      <div class="panel-head"><div class="h3">Add your own</div><span class="sub">a Workshop map, any map with practice settings, or a community deathmatch / retake server</span></div>
      <div class="pr-form">
        <input type="text" id="pr-name" placeholder="Name (e.g. WarmupServer NA #1)">
        <select id="pr-kind"><option value="workshop">Workshop map (id)</option><option value="map">Map (e.g. de_mirage)</option><option value="server">Server (address:port)</option></select>
        <input type="text" id="pr-target" placeholder="3070244462 · de_mirage · 1.2.3.4:27015">
        <select id="pr-mode"><option value="none">Load as it is</option><option value="practice">Practice settings</option><option value="deathmatch">Bot deathmatch</option></select>
        <textarea id="pr-cmds" rows="2" placeholder="Extra console commands, one per line (optional)"></textarea>
        <button class="btn primary" id="pr-add" ${tauri ? "" : "disabled"}>Add</button>
      </div>
      <div class="note" style="margin:0 20px 16px">Launches go through Steam like a desktop shortcut. Practice settings are written to <code>cfg/veloxify_practice.cfg</code>; if a map resets them, run <code>exec veloxify_practice</code> in the console. If CS2 is already open, Veloxify copies the commands for you to paste instead.</div>
    </section>`;
  const msg = (t, bad) => { const el = view.querySelector("#pr-msg"); el.textContent = t; el.style.color = bad ? "var(--loss)" : ""; el.classList.add("on"); clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove("on"), 6000); };
  view.querySelectorAll("[data-map]").forEach((s) => (s.onchange = () => { practiceMaps[s.dataset.map] = s.value; }));
  view.querySelectorAll("[data-launch]").forEach((b) => (b.onclick = async () => {
    const p = [...PRACTICE_PRESETS, ...custom].find((x) => x.id === b.dataset.launch);
    if (p.kind === "link") {
      if (tauri) tauri.core.invoke("open_link", { url: p.target });
      else window.open(p.target, "_blank");
      return;
    }
    const launch = { kind: p.kind, target: practiceMaps[p.id] || p.target, mode: p.mode || "none", headshot_only: !!view.querySelector(`[data-hs="${p.id}"]`)?.checked, commands: p.commands || "" };
    if (!tauri) return msg("Launching works in the desktop app.", true);
    b.disabled = true;
    try {
      const r = await tauri.core.invoke("launch_practice", { launch });
      if (r.launched) msg(`Starting CS2: ${p.name}`);
      else {
        try { await navigator.clipboard.writeText(r.console); } catch (e) { /* shown below */ }
        msg(`CS2 is already open. Copied to paste in the console: ${r.console}`);
      }
    } catch (e) { msg(String(e), true); }
    b.disabled = false;
  }));
  view.querySelectorAll("[data-del]").forEach((b) => (b.onclick = async () => {
    const list = (settingsData.settings.practice || []).filter((p) => p.id !== b.dataset.del);
    settingsData.settings.practice = list;
    await tauri.core.invoke("save_practice", { presets: list });
    renderPractice(view);
  }));
  view.querySelector("#pr-add").onclick = async () => {
    const name = view.querySelector("#pr-name").value.trim(), target = view.querySelector("#pr-target").value.trim();
    if (!name || !target) return msg("Give it a name and a map, Workshop id or server address.", true);
    const p = { id: `c${Date.now()}`, name, kind: view.querySelector("#pr-kind").value, target, mode: view.querySelector("#pr-mode").value, commands: view.querySelector("#pr-cmds").value };
    const list = [...(settingsData.settings.practice || []), p];
    settingsData.settings.practice = list;
    await tauri.core.invoke("save_practice", { presets: list });
    renderPractice(view);
  };
}

// ---- session page ------------------------------------------------------------------------------

// Everyone's stats summed over a session's matches. Rates and ratings are per round, so the
// session value is the round-weighted average of the matches (HLTV computes it the same way).
function sumPlayers(entries, me) {
  const by = new Map();
  for (const m of entries) {
    for (const p of m.players) {
      const c = p.counts, d = p.derived;
      const rounds = c.rounds || 0;
      let a = by.get(p.steamid);
      if (!a) {
        a = { steamid: p.steamid, name: p.name, maps: 0, wins: 0, rounds: 0, mine: 0, enemy: 0, party: false, c: {}, w: { rating3: 0, rws: 0, adr: 0, kast: 0, swing: 0 },
          t: { rounds: 0, rating3: 0 }, ct: { rounds: 0, rating3: 0 }, results: [] };
        by.set(p.steamid, a);
      }
      a.name = p.name;
      a.maps += 1;
      a.rounds += rounds;
      a.wins += c.wins || 0;
      a[p.side === "mine" ? "mine" : "enemy"] += 1;
      a.party = a.party || p.party;
      a.results.push({ id: m.id, map: m.map, won: (c.wins || 0) > 0 });
      for (const [k, v] of Object.entries(c)) {
        if (typeof v === "number") a.c[k] = (a.c[k] || 0) + v;
        else if (Array.isArray(v)) a.c[k] = (a.c[k] || v.map(() => 0)).map((x, i) => x + (v[i] || 0));
      }
      for (const k of Object.keys(a.w)) a.w[k] += (k === "rating3" ? r3(d) : d[k] || 0) * rounds;
      for (const side of ["t", "ct"]) {
        const sc = p[side] || {};
        if (sc.rounds) {
          a[side].rounds += sc.rounds;
          // Side rating from side counts isn't stored per match; approximate with the match rating
          // weighted by side rounds when side ratings aren't available.
          a[side].rating3 += (p[side + "_rating3"] ?? r3(d)) * sc.rounds;
        }
      }
    }
  }
  const out = [...by.values()].map((a) => {
    const c = a.c, r = Math.max(1, a.rounds);
    return {
      ...a,
      rating3: a.w.rating3 / r, rws: a.w.rws / r, adr: a.w.adr / r, kast: a.w.kast / r, swing: a.w.swing / r,
      t_rating: a.t.rounds ? a.t.rating3 / a.t.rounds : null, ct_rating: a.ct.rounds ? a.ct.rating3 / a.ct.rounds : null,
      kd: (c.kills || 0) / Math.max(1, c.deaths || 0), kr: (c.kills || 0) / r, hs: c.kills ? (100 * (c.headshot_kills || 0)) / c.kills : 0,
      is_me: a.steamid === me,
    };
  });
  return out.sort((x, y) => y.rating3 - x.rating3);
}

let sessionView = { sort: "rating3", desc: true };

async function renderSession(view, date, idx) {
  // The matches table can show your Aim and Utility per match.
  await Promise.all([loadMyStats(), loadBenchmarks()]);
  const day = dayOf(date);
  const sess = day?.sessions[idx];
  if (!sess) { view.innerHTML = `<div class="empty">No session on ${esc(date)}</div>`; return; }
  const summaries = sess.match_ids.map(summaryOf);
  const withDemo = summaries.filter((m) => !m.stats_only);
  // How you played against your usual, and what goes with it.
  const sdata = await loadSessionData();
  const skey = sess.match_ids[0];
  const sobj = sdata.sessions.find((x) => x.key === skey);
  const judged = judgeSession(sdata, sess.match_ids);
  const here = new Set(sess.match_ids.map((id) => sdata.byId.get(id)).filter(Boolean).flatMap((r) => Object.entries(matchFactors(sdata, r)).map(([f, v]) => `${f}|${v}`)));
  const notice = noticed(sdata).filter((n) => here.has(`${n.f}|${n.v}`)).slice(0, 3);
  const entries = await Promise.all(withDemo.map((m) => loadMatch(m.id)));
  const me = state.index.me;
  const players = sumPlayers(entries, me);
  // Your highlights this session, best first (the player plays them in this order).
  const sessHls = entries
    .flatMap((m) => (m.highlights || []).filter((h) => String(h.player) === String(me)).map((h) => ({ ...h, match: m, name: m.players.find((p) => String(p.steamid) === String(me))?.name || "" })))
    .sort((a, b) => (b.hand || 0) - (a.hand || 0) || (b.score || 0) - (a.score || 0));
  // Duels in pistol rounds (each half's first): kills and deaths, from the match details.
  const dets = await Promise.all(withDemo.map((m) => loadDetails(m.id)));
  const pistolDuels = new Map();
  for (const d of dets) {
    const rs = d?.rounds || [];
    if (!rs.length) continue;
    const pistols = new Set([rs[0].number]);
    const second = rs.find((r) => r.number > rs[0].number && r.number <= 30 && r.mine_side && r.mine_side !== rs[0].mine_side);
    if (second) pistols.add(second.number);
    for (const r of rs) if (pistols.has(r.number)) for (const q of r.players || []) {
      const a = pistolDuels.get(q.steamid) || [0, 0];
      a[0] += q.kills || 0;
      a[1] += q.deaths || 0;
      pistolDuels.set(q.steamid, a);
    }
  }
  for (const q of players) q.pistolDuels = pistolDuels.get(q.steamid) || [0, 0];
  const meRow = players.find((p) => p.is_me);
  // Cards: you and your confirmed party (never teammates who just happened to be in your games).
  const party = players.filter((p) => !p.is_me && p.mine > 0 && p.party);
  const cards = [meRow, ...party].filter(Boolean).slice(0, 5);
  // How you queued: you plus the party members on your team, per match; the session's most common.
  const QUEUE = ["", "Solo queue", "Duo queue", "3-stack", "4-stack", "5-stack"];
  const SHORT = ["", "solo", "duo", "3-stack", "4-stack", "5-stack"];
  const sizes = entries.map((m) => Math.min(5, 1 + m.players.filter((p) => p.party && p.side === "mine" && p.steamid !== me).length));
  const bySize = new Map();
  for (const n of sizes) bySize.set(n, (bySize.get(n) || 0) + 1);
  const queueTop = [...bySize.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0];
  const queueMix = bySize.size > 1 ? [...bySize.entries()].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${c} ${SHORT[n]}`).join(" · ") : "";
  const w = sess.wins, l = sess.losses;
  const first = summaries[0], last = summaries[summaries.length - 1];
  // First start to last finish (a FACEIT-only match without room data counts as ~40 minutes).
  const minutes = Math.round((last.played_ts + (last.duration_s || 2400) - first.played_ts) / 60);
  const dayIdx = state.days.findIndex((d) => d.date === date);
  const prevSess = idx > 0 ? `#/session/${date}/${idx - 1}` : dayIdx > 0 ? `#/session/${state.days[dayIdx - 1].date}/${state.days[dayIdx - 1].sessions.length - 1}` : null;
  const nextSess = idx < day.sessions.length - 1 ? `#/session/${date}/${idx + 1}` : dayIdx >= 0 && dayIdx < state.days.length - 1 ? `#/session/${state.days[dayIdx + 1].date}/0` : null;

  const bar = (label, v, color, lo = 0.4, hi = 1.8) => {
    if (v == null) return "";
    const f = Math.max(0, Math.min(1, (v - lo) / (hi - lo))), mid = (1 - lo) / (hi - lo);
    return `<div class="sc-bar"><div class="sc-bar-h"><span>${label}</span><b class="${ratingClass(v)}">${f2(v)}</b></div>
      <div class="sc-track"><i style="width:${f * 100}%;background:${color}"></i><span style="left:${mid * 100}%"></span></div></div>`;
  };
  const card = (p) => `
    <div class="sc-card ${p.is_me ? "me" : ""}">
      <div class="sc-name">${avatarHtml(p.steamid, 32)}<b>${esc(p.name)}</b>${p.is_me ? `<span class="sc-you">You</span>` : ""}<span class="grow"></span>
        <span class="sc-wl"><span class="up">${p.wins}</span>:<span class="down">${p.maps - p.wins}</span></span></div>
      ${bar("HLTV Rating 3.0", p.rating3, "var(--accent)")}
      ${bar("T side", p.t_rating, "var(--t)")}
      ${bar("CT side", p.ct_rating, "var(--ct)")}
      <div class="sc-stats">
        <div><b class="${gradeClass("rws", p.rws)}">${f1(p.rws)}</b><span>RWS</span></div>
        <div><b class="${gradeClass("adr", p.adr)}">${f1(p.adr)}</b><span>ADR</span></div>
        <div><b class="${gradeClass("kd", p.kd)}">${f2(p.kd)}</b><span>K/D</span></div>
        <div><b>${fmtSwing(p.swing)}</b><span>Swing</span></div>
      </div>
      <div class="sc-maps">${p.results.map((r) => `<span class="${r.won ? "up" : "down"}" title="${esc(mapName(r.map))}">${r.won ? "W" : "L"}</span>`).join("")}</div>
    </div>`;

  // Full session scoreboard.
  const COLS = [
    ["name", "Player"], ["maps", "Maps"], ["wins", "W-L"], ["rating3", "HLTV 3.0"], ["swing", "Swing"], ["rws", "RWS"], ["kills", "K"], ["deaths", "D"], ["assists", "A"],
    ["diff", "+/-"], ["kd", "K/D"], ["adr", "ADR"], ["kr", "K/R"], ["kast", "KAST"], ["hs", "HS%"], ["k2", "2K"], ["k3", "3K"], ["k4", "4K"], ["k5", "5K"],
    ["mvps", "MVPs"], ["entries", "Entries"], ["pistol", "Pistol rounds"], ["eco", "Eco kills"], ["clutch", "Clutches"],
    ["c1", "1v1"], ["c2", "1v2"], ["c3", "1v3"], ["c4", "1v4"], ["c5", "1v5"],
  ];
  // Won-lost with the percentage, colored by the usual marks for duels (`open` or `duels`).
  const wlCell = (w, l, marks, what) => {
    const n = w + l;
    if (!n) return `<td class="zero">–</td>`;
    const pct = (100 * w) / n;
    return `<td class="${n >= 3 ? gradeClass(marks, pct) : ""}" title="${esc(what)}: won ${w} of ${n} (${Math.round(pct)}%)">${w}-${l} <small>(${Math.round(pct)}%)</small></td>`;
  };
  const rates = sdata.clutchRates || CLUTCH_AVG;
  const clutchArr = (p, k) => p.c[k] || [0, 0, 0, 0, 0, 0];
  // One 1vX (or all of them, x = 0): "2/5 (40%)", colored against the average player.
  const clutchCell = (p, x) => {
    const won = clutchArr(p, "clutches_won"), att = clutchArr(p, "clutches_attempted");
    const only = (arr) => (x ? arr.map((v, i) => (i === x ? v : 0)) : arr);
    const g = clutchGrade(only(won), only(att), rates);
    if (!g) return `<td class="zero">–</td>`;
    const avg = x ? `the average player in your matches wins ${Math.round(rates[x] * 100)}% of 1v${x}s` : `the average player would have won ${f1(g.expected)} of these`;
    return `<td class="${g.g}" title="${x ? `1v${x}: ` : ""}won ${g.w} of ${g.n} (${pctOf(g.w, g.n)}%); ${avg}">${g.w}/${g.n} <small>(${pctOf(g.w, g.n)}%)</small></td>`;
  };
  const val = (p, k) => ({
    name: p.name.toLowerCase(), kills: p.c.kills || 0, deaths: p.c.deaths || 0, assists: p.c.assists || 0, diff: (p.c.kills || 0) - (p.c.deaths || 0),
    k2: (p.c.multikill_rounds || [])[2] || 0, k3: (p.c.multikill_rounds || [])[3] || 0, k4: (p.c.multikill_rounds || [])[4] || 0, k5: (p.c.multikill_rounds || [])[5] || 0,
    mvps: p.c.mvps || 0, eco: p.c.eco_kills || 0, clutch: sum(p.c.clutches_won || []),
    entries: (p.c.opening_kills || 0) + (p.c.opening_deaths || 0) ? (p.c.opening_kills || 0) / ((p.c.opening_kills || 0) + (p.c.opening_deaths || 0)) : -1,
    pistol: p.pistolDuels && p.pistolDuels[0] + p.pistolDuels[1] ? p.pistolDuels[0] / (p.pistolDuels[0] + p.pistolDuels[1]) : -1,
    ...(/^c[1-5]$/.test(k) ? { [k]: ((x) => (clutchArr(p, "clutches_attempted")[x] ? clutchArr(p, "clutches_won")[x] / clutchArr(p, "clutches_attempted")[x] : -1))(Number(k[1])) } : {}),
  }[k] ?? p[k] ?? 0);
  // Only the players who were in the session with you: you and your party.
  const rows = players.filter((p) => p.is_me || (p.party && p.mine > 0))
    .sort((a, b) => {
      const x = val(a, sessionView.sort), y = val(b, sessionView.sort);
      return (typeof x === "string" ? x.localeCompare(y) : x - y) * (sessionView.desc ? -1 : 1);
    });
  const cell = (p, k) => {
    switch (k) {
      case "name": return `<td>${esc(p.name)}${p.is_me ? ` <span class="sc-you">You</span>` : ""}</td>`;
      case "wins": return `<td>${p.wins}-${p.maps - p.wins}</td>`;
      case "rating3": return `<td class="rating ${ratingClass(p.rating3)}">${f2(p.rating3)}</td>`;
      case "rws": return `<td class="${gradeClass("rws", p.rws)}">${f1(p.rws)}</td>`;
      case "diff": { const d = val(p, "diff"); return `<td class="${d > 0 ? "up" : d < 0 ? "down" : ""}">${d > 0 ? "+" : ""}${d}</td>`; }
      case "kd": case "kr": return `<td class="${gradeClass(k === "kd" ? "kd" : "kpr", p[k])}">${f2(p[k])}</td>`;
      case "adr": return `<td class="${gradeClass("adr", p.adr)}">${f1(p.adr)}</td>`;
      case "kast": return `<td>${f1(p.kast)}%</td>`;
      case "hs": return `<td>${Math.round(p.hs)}%</td>`;
      case "clutch": return clutchCell(p, 0);
      case "entries": return wlCell(p.c.opening_kills || 0, p.c.opening_deaths || 0, "open", "Opening duels (the round's first kill)");
      case "pistol": return wlCell(p.pistolDuels?.[0] || 0, p.pistolDuels?.[1] || 0, "duels", "Duels in pistol rounds");
      case "c1": case "c2": case "c3": case "c4": case "c5": return clutchCell(p, Number(k[1]));
      case "swing": return `<td>${fmtSwing(p.swing)}</td>`;
      default: return `<td>${val(p, k)}</td>`;
    }
  };
  const statsOnly = summaries.length - withDemo.length;
  view.innerHTML = `
    <div class="sess-head">
      <div class="sess-box"><span class="sess-w">${w}W</span><span class="sess-sep">:</span><span class="sess-l">${l}L</span><span class="sub">/ ${summaries.length} match${summaries.length === 1 ? "" : "es"}</span></div>
      ${queueTop ? `<div class="sess-box sess-queue" title="Who was in your party: FACEIT's party data, or (Premier) players on your team in two or more of the session's matches"><span class="ic">${ICONS.party}</span><b>${QUEUE[queueTop]}</b>${queueMix ? `<span class="sub">${esc(queueMix)}</span>` : ""}</div>` : ""}
      <div class="sess-box"><b>${fmtDate(date)}</b><span class="sub">${fmtTime(first.played_at)}–${fmtTime(last.played_at)} · ${fmtSpan(minutes)}</span></div>
      <span class="grow"></span>
      ${prevSess ? `<a class="btn ghost" href="${prevSess}">◀ Previous session</a>` : ""}
      <a class="btn ghost" href="#/sessions" title="Every session on a calendar, colored by how you played">${ICONS.calendar} Calendar</a>
      ${nextSess ? `<a class="btn ghost" href="${nextSess}">Next session ▶</a>` : ""}
    </div>
    <div class="sv-verdicts">${objectiveHtml(meRow, sdata)}${verdictHtml(judged)}</div>
    ${cards.length ? `<div class="sc-row">${cards.map(card).join("")}</div>` : `<div class="empty">No demos for this session yet.</div>`}
    ${(() => {
      // Then your highlights on the left half, what we noticed (and setup changes) on the right.
      const side = `${notice.length ? `<section class="panel sv-noticed"><div class="panel-head"><div class="h3">What we noticed</div><span class="grow"></span><span class="sub">Things true of you in all your matches that showed this session too</span></div>
        <ul>${notice.map((n) => `<li>${noticedText(n)}</li>`).join("")}</ul></section>` : ""}${sobj ? setupHtml(sdata, sobj) : ""}`;
      return sessHls.length || side ? `<div class="sv-mid">${sessHls.length ? `<div class="sv-top">${sessHighlightsHtml(sessHls, date)}</div>` : "<div></div>"}<div class="sv-mid-side">${side}</div></div>` : "";
    })()}
    ${statsOnly ? `<div class="ml-note" style="margin:0 0 14px">${statsOnly} match${statsOnly === 1 ? "" : "es"} without a demo yet (FACEIT stats only) aren't in these totals. ${demoButton(missingDemos(summaries, 3650), "btn")}</div>` : ""}
    <section class="panel" style="margin-bottom:20px">
      <div class="panel-head"><div class="h3">Session scoreboard</div><span class="sub">you${rows.length > 1 ? " and your party" : ""}, all ${withDemo.length} match${withDemo.length === 1 ? "" : "es"} added up</span></div>
      <div class="sc-table"><table class="sb">
        <thead><tr>${COLS.map(([k, t]) => `<th data-sort="${k}" class="sortable ${sessionView.sort === k ? "on" : ""}">${t}${sessionView.sort === k ? (sessionView.desc ? " ▾" : " ▴") : ""}</th>`).join("")}</tr></thead>
        <tbody>${rows.map((p) => `<tr class="${p.is_me ? "me" : p.party ? "party" : ""}">${COLS.map(([k]) => cell(p, k)).join("")}</tr>`).join("")}</tbody>
      </table></div>
      <div class="note">Your party: who FACEIT says queued with you, or (Premier, which doesn't record parties) teammates in two or more of the session's matches. HLTV 3.0, RWS, ADR, KAST and Swing are per round, so session values weight each match by its rounds. Entries: opening duels (the round's first kill) won-lost. Pistol rounds: your kills and deaths in each half's first round. Eco kills: on players with under $2,000 of equipment (not pistol rounds).
        Colors: green is good, red is poor. K/D, K/R and ADR against the usual marks (ADR 82+ is good, 95+ excellent); clutches against what the average player in your matches wins from the same 1vXs (about ${Math.round(rates[1] * 100)}% of 1v1s, ${Math.round(rates[2] * 100)}% of 1v2s, ${Math.round(rates[3] * 100)}% of 1v3s), so a few clutches lean average until the difference is clear.</div>
    </section>
    <section class="fc-card" style="margin-bottom:20px">
      <div class="fc-head"><div class="h3">Matches</div></div>
      ${historyTable(historyRows().filter((r) => sess.match_ids.includes(r.id)).sort((a, b) => a.when - b.when), histCols())}
    </section>
    ${baselineHtml(judged, sdata)}
    ${notesHtml(sdata, skey)}`;
  view.querySelectorAll("th[data-sort]").forEach((th) => (th.onclick = () => {
    const k = th.dataset.sort;
    sessionView.desc = sessionView.sort === k ? !sessionView.desc : k !== "name";
    sessionView.sort = k;
    renderSession(view, date, idx);
  }));
  wireColDrag([...view.querySelectorAll(".ml-head [data-col]")], histCols, (list) => { savePickedCols("veloxify.historyCols", HIST_COLS, list); renderSession(view, date, idx); });
  view.querySelectorAll("[data-addcol]").forEach((b) => (b.onclick = (e) => { e.stopPropagation(); editHistCols(e.currentTarget, () => renderSession(view, date, idx)); }));
  wireNotes(view, sdata, skey);
  view.querySelectorAll(".sv-top [data-hl]").forEach((c) => (c.onclick = () => {
    state.playlist = sessHls.filter((h) => h.clip);
    const i = state.playlist.findIndex((h) => h.id === c.dataset.hl);
    if (i >= 0) play(i);
  }));
  view.querySelectorAll(".ml-row").forEach((row) => (row.onclick = (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "room") return openFaceitRoom(row.dataset.room);
    if (act === "demo") return getDemos([row.dataset.room]);
    location.hash = act === "hl" ? `${row.dataset.href}/highlights` : row.dataset.href;
  }));
}

// ---- sessions: how you played, against your own baseline ------------------------------------------

// Everything a session's verdict is made from: your per-match stats (aim, movement, utility...),
// your duels (insights/me.json), crosshairs, the setup you played with, practice and your notes.
async function loadSessionData(force = false) {
  if (state.sessData && !force) return state.sessData;
  const json = async (rel, fallback) => { try { const r = await fetch(assetUrl(rel), { cache: "no-store" }); return r.ok ? await r.json() : fallback; } catch (e) { return fallback; } };
  const [myStats, bench, me, , setups, practice, notes, lobbyClutches] = await Promise.all([
    loadMyStats(), loadBenchmarks(), json("insights/me.json", null), loadCrosshairs(),
    json("settings_log.json", []), json("practice_log.json", []), json("session_notes.json", {}), json("lobby_clutches.json", null),
  ]);
  const duels = me?.matches || {};
  const statsById = new Map((myStats || []).map((m) => [m.id, m]));
  const meId = state.index.me;
  // One row per match you have a demo for, with what it says about the session it was in.
  const sessions = allSessions();
  const rows = [];
  for (const s of sessions) s.ids.forEach((id, i) => {
    const ms = statsById.get(id), sum = summaryOf(id);
    if (!ms || !sum) return;
    rows.push({ id, ts: ms.ts, rounds: ms.rounds || 1, stats: ms.stats || {}, duels: duels[id] || null, map: sum.map, result: sum.result, party: sum.party_size || 0,
      xh: state.xh?.matches?.[id]?.[meId] || "", session: s.key, nInSession: i + 1, hour: new Date((sum.played_ts || ms.ts) * 1000).getHours() });
  });
  state.sessData = { rows, byId: new Map(rows.map((r) => [r.id, r])), sessions, bench: bench || {}, setups: setups || [], practice: practice || [], notes: notes && typeof notes === "object" ? notes : {}, clutchRates: clutchRates(lobbyClutches) };
  return state.sessData;
}

// How often the average player in your matches wins each 1vX (index 1-5), from everyone else's
// clutches (`lobby_clutches.json`); until that's written, what it was over a few thousand clutches.
const CLUTCH_AVG = [0, 0.6, 0.23, 0.045, 0.005, 0.005];
function clutchRates(lobby) {
  return CLUTCH_AVG.map((fallback, x) => {
    const a = lobby?.attempted?.[x] || 0;
    return x && a >= 30 ? lobby.won[x] / a : fallback;
  });
}
// Clutches won against what the average player would have won from the same 1vXs: Excellent ..
// Poor (`g0`..`g4`). Small samples lean average: it takes a clear difference to color one.
function clutchGrade(won, att, rates) {
  let expected = 0, varc = 0, w = 0, n = 0;
  for (let x = 1; x <= 5; x++) {
    const a = att[x] || 0, p = rates[x];
    expected += a * p; varc += a * p * (1 - p); w += won[x] || 0; n += a;
  }
  if (!n) return null;
  const z = varc > 0 ? (w - expected) / Math.sqrt(varc) : 0;
  return { g: z >= 2 ? "g0" : z >= 0.75 ? "g1" : z <= -2 ? "g4" : z <= -0.75 ? "g3" : "g2", w, n, expected };
}

// Every session (oldest first): its matches, when, and a key that stays the same (its first match).
function allSessions() {
  const out = [];
  for (const d of state.days) d.sessions.forEach((s, idx) => {
    const ms = s.match_ids.map(summaryOf).filter(Boolean);
    if (!ms.length) return;
    const last = ms[ms.length - 1];
    out.push({ key: s.match_ids[0], date: d.date, idx, ids: s.match_ids, wins: s.wins, losses: s.losses, start: ms[0].played_ts, end: last.played_ts + (last.duration_s || 2400) });
  });
  return out;
}

// What a session is judged on: groups of stats (lower-is-better ones count the other way).
const SESS_GROUPS = [
  ["aim", "aim", ["spotted_accuracy", "ttd_ms", "crosshair_deg", "head_accuracy", "first_bullet", "spray_accuracy"]],
  ["movement", "movement", ["counter_strafe", "accurate_movement", "air_shot_pct"]],
  ["utility", "utility", ["nades_per_round", "utility_damage_pr", "enemies_per_flash", "flash_assist_pct", "friends_per_flash", "unused_utility"]],
  ["opening", "opening duels", ["entry_success"]],
  ["trading", "trading", ["trade_kills_pr", "traded_deaths_pct"]],
  ["fragging", "fragging", ["kpr", "adr", "multikill_pr", "hs_pct"]],
  ["survival", "staying alive", ["dpr", "rounds_survived_pct", "kast"]],
];
// Duel kinds from your duels: [key, words, how to read it from a match's duels].
const SESS_DUELS = [
  ["rifle", "rifle duels", (d) => d.by_weapon?.rifle], ["awp", "AWP duels", (d) => d.by_weapon?.awp], ["pistol", "pistol duels", (d) => d.by_weapon?.pistol],
  ["afterplant", "afterplants", (d) => d.afterplant], ["retake", "retakes", (d) => d.retake], ["moving", "duels on the move", (d) => d.moving],
  ["peeked", "your peeks", (d) => d.peeked], ["held", "holding angles", (d) => d.held],
];
const SESS_TIPS = {
  aim: "Warm up before you queue: 10 minutes of aim_botz or a deathmatch (Practice tab), and keep your crosshair at head height.",
  movement: "Counter-strafe: tap the opposite key so you're standing still when you shoot.",
  utility: "Use your grenades: a flash for every entry, smokes to cross, and don't die with utility in your pockets.",
  opening: "Take opening duels with a flash or a teammate ready to trade, or let someone else open and trade them.",
  trading: "Play close enough to a teammate to trade them, and swing right after they die.",
  fragging: "Look for fights you start on your terms: pre-aim common spots and peek with a teammate.",
  survival: "Too many early deaths: hold safer angles and don't take duels you don't need, especially on CT.",
  rifle: "Rifle duels: stop fully, tap or burst at range, and control the first 5–10 bullets of your spray.",
  awp: "AWP: hold one angle without moving the crosshair, and reposition after every shot.",
  pistol: "Pistols: one or two taps at the head beat spraying; move between shots, stop to shoot.",
  afterplant: "Afterplants: play crossfires on the bomb with a teammate and use the time; you don't need to peek.",
  retake: "Retakes: wait for your teammates and go in together with utility.",
  moving: "You lost duels while running: stop before you shoot.",
  peeked: "Peeking held angles: jiggle-peek for info first, peek off a flash, or swing together with a teammate.",
  held: "Holding angles: keep your crosshair where their head will appear, and play spots they don't pre-aim.",
};

const wmean = (rows, k) => {
  let w = 0, s = 0;
  for (const r of rows) { const v = r.stats[k]; if (v == null || Number.isNaN(v)) continue; w += r.rounds; s += v * r.rounds; }
  return w ? s / w : null;
};
const sdOf = (rows, k) => {
  const vs = rows.map((r) => r.stats[k]).filter((v) => v != null && !Number.isNaN(v));
  if (vs.length < 3) return null;
  const m = sum(vs) / vs.length;
  return Math.sqrt(sum(vs.map((v) => (v - m) ** 2)) / (vs.length - 1)) || null;
};
const duelSum = (rows, get) => rows.reduce((a, r) => { const x = r.duels ? get(r.duels) : null; return x ? [a[0] + x[0], a[1] + x[1]] : a; }, [0, 0]);

// A session against your baseline (every other match of yours): the overall verdict, each part
// of your game, and the facts behind them.
function judgeSession(data, ids) {
  const mine = ids.map((id) => data.byId.get(id)).filter(Boolean);
  if (!mine.length) return null;
  const others = data.rows.filter((r) => !ids.includes(r.id));
  if (others.length < 5) return { mine, few: true };
  const n = mine.length;
  const lower = (k) => !!data.bench[k]?.lower_is_better;
  const stat = (k) => {
    const v = wmean(mine, k), b = wmean(others, k), sd = sdOf(others, k);
    if (v == null || b == null || !sd) return null;
    const z = Math.max(-4, Math.min(4, ((v - b) / (sd / Math.sqrt(n))) * (lower(k) ? -1 : 1)));
    return { k, v, b, z };
  };
  const rating = stat("rating3");
  const pct = rating ? Math.round(((rating.v / rating.b) - 1) * 100) : 0;
  // Where it ranks among your sessions (by HLTV 3.0), against sessions about as long (one big
  // match isn't a session of ten).
  const minLen = Math.min(3, n);
  const sessRating = (sids) => { const rs = sids.map((id) => data.byId.get(id)).filter(Boolean); return rs.length >= minLen ? wmean(rs, "rating3") : null; };
  const all = (data.sessions || []).map((s) => sessRating(s.ids)).filter((v) => v != null).sort((a, b) => b - a);
  const mineR = wmean(mine, "rating3");
  const rank = mineR != null && all.length >= 5 ? { pos: all.filter((v) => v > mineR + 1e-9).length + 1, of: all.length, minLen } : null;
  const verdict = !rating ? "even" : rating.z >= 1 && pct >= 5 ? "good" : rating.z <= -1 && pct <= -5 ? "bad" : "even";
  // Each part of your game: the average of its stats' scores.
  const parts = [];
  for (const [key, words, keys] of SESS_GROUPS) {
    const ss = keys.map(stat).filter(Boolean);
    if (!ss.length) continue;
    parts.push({ key, words, z: sum(ss.map((x) => x.z)) / ss.length, stats: ss });
  }
  for (const [key, words, get] of SESS_DUELS) {
    const [w, l] = duelSum(mine, get), [bw, bl] = duelSum(others, get);
    if (w + l < 5 || bw + bl < 20) continue;
    const p = w / (w + l), bp = bw / (bw + bl);
    const z = Math.max(-4, Math.min(4, (p - bp) / Math.sqrt((bp * (1 - bp)) / (w + l))));
    parts.push({ key, words, z, duel: { w, l, p, bp } });
  }
  const better = parts.filter((p) => p.z >= 1).sort((a, b) => b.z - a.z);
  const worse = parts.filter((p) => p.z <= -1).sort((a, b) => a.z - b.z);
  // The facts: the numbers behind the biggest differences.
  const facts = [];
  const pc = (x) => `${Math.round(x)}%`;
  const fact = (key, z, text) => facts.push({ key, z, text });
  const D = (get) => duelSum(mine, get), B = (get) => duelSum(others, get);
  const [ow, ol] = D((d) => d.opening), [bow, bol] = B((d) => d.opening);
  if (ow + ol >= 3) {
    const lostRounds = sum(mine.map((r) => r.duels?.opening_lost_round_lost || 0)), wonRounds = sum(mine.map((r) => r.duels?.opening_won_round_won || 0));
    const z = parts.find((p) => p.key === "opening")?.z ?? 0;
    fact("opening", z, `You won <b>${ow} of ${ow + ol}</b> opening duels (${pc((100 * ow) / (ow + ol))}; you usually win ${pc((100 * bow) / Math.max(1, bow + bol))}).${ol >= 3 && lostRounds >= 2 ? ` ${lostRounds} of the ${ol} you lost cost your team the round.` : ""}${ow >= 3 && wonRounds >= 2 ? ` ${wonRounds} of your ${ow} opening kills became round wins.` : ""}`);
  }
  const awp = sum(mine.map((r) => r.duels?.awp_kills || 0)), awpOpen = sum(mine.map((r) => r.duels?.awp_opening_kills || 0));
  const awpBase = sum(others.map((r) => r.duels?.awp_kills || 0)) / Math.max(1, others.length);
  if (awp >= 5) fact("awp", (awp / n - awpBase) / Math.max(1, Math.sqrt(awpBase || 1)), `Your AWP got <b>${awp} kills</b>${awpOpen ? `, ${awpOpen} of them opening kills` : ""} (you usually get ${awpBase.toFixed(1)} a match).`);
  const s = Object.fromEntries(parts.flatMap((p) => p.stats || []).map((x) => [x.k, x]));
  if (s.spotted_accuracy || s.ttd_ms) {
    const a = s.spotted_accuracy, t = s.ttd_ms;
    fact("aim", parts.find((p) => p.key === "aim")?.z ?? 0, [a && `You hit <b>${pc(a.v)}</b> of your shots at enemies you could see (usually ${pc(a.b)})`, t && `found your targets in <b>${Math.round(t.v)} ms</b> (usually ${Math.round(t.b)} ms)`].filter(Boolean).join(" and ") + ".");
  }
  if (s.counter_strafe) {
    const [mw, ml] = D((d) => d.moving);
    fact("movement", parts.find((p) => p.key === "movement")?.z ?? 0, `You counter-strafed <b>${pc(s.counter_strafe.v)}</b> of your rifle shots (usually ${pc(s.counter_strafe.b)})${ml >= 3 ? `, and were running in ${ml} of the duels you lost` : ""}.`);
  }
  if (s.nades_per_round) fact("utility", parts.find((p) => p.key === "utility")?.z ?? 0, `You threw <b>${s.nades_per_round.v.toFixed(1)}</b> grenades a round (usually ${s.nades_per_round.b.toFixed(1)})${s.utility_damage_pr ? ` for ${s.utility_damage_pr.v.toFixed(1)} utility damage a round (usually ${s.utility_damage_pr.b.toFixed(1)})` : ""}.`);
  if (s.kpr && s.adr) fact("fragging", parts.find((p) => p.key === "fragging")?.z ?? 0, `<b>${s.kpr.v.toFixed(2)}</b> kills a round and <b>${s.adr.v.toFixed(0)}</b> ADR (usually ${s.kpr.b.toFixed(2)} and ${s.adr.b.toFixed(0)}).`);
  if (s.trade_kills_pr) fact("trading", parts.find((p) => p.key === "trading")?.z ?? 0, `${s.trade_kills_pr.v.toFixed(2)} trade kills a round (usually ${s.trade_kills_pr.b.toFixed(2)})${s.traded_deaths_pct ? `, and ${pc(s.traded_deaths_pct.v)} of your deaths were traded (usually ${pc(s.traded_deaths_pct.b)})` : ""}.`);
  for (const p of parts.filter((p) => p.duel)) fact(p.key, p.z, `You won <b>${p.duel.w} of ${p.duel.w + p.duel.l}</b> ${p.words} (${pc(100 * p.duel.p)}; usually ${pc(100 * p.duel.bp)}).`);
  const [cw, ca] = D((d) => d.clutch);
  if (ca >= 2) fact("clutch", cw >= 2 ? 1.5 : 0, `You were the last one alive ${ca} times and won ${cw}.`);
  facts.sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
  return { mine, n, rating, pct, verdict, parts, better, worse, facts, baseline: others, rank };
}

const SIZE_WORD = (z) => (Math.abs(z) >= 3 ? " (by a lot)" : Math.abs(z) >= 2 ? "" : " (slightly)");
// A grade by the usual marks, for an average over n matches: averages swing less than single
// matches, so the marks move toward the middle (by 1/sqrt(n), up to 4 matches' worth): holding a
// number over a long session is rarer than hitting it once.
function sessGrade(kind, v, n) {
  const t = GRADES[kind];
  if (!t || v == null) return "g2";
  const f = 1 / Math.sqrt(Math.min(Math.max(n || 1, 1), 4)), mid = (t[1] + t[2]) / 2;
  return `g${t.map((x) => mid + (x - mid) * f).filter((x) => v < x).length}`;
}

// The session's best moments, front and center: the top one big, the next four beside it.
function sessHighlightsHtml(list, date) {
  const card = (h, big) => `
    <div class="hl-card sh-card ${big ? "big" : ""} ${h.clip ? "" : "pending"}" data-hl="${esc(h.id)}" ${clipAttr(h)}>
      <div class="hl-thumb" style="--map-bg:${mapColor(h.match.map)};${h.thumb ? `background-image:url('${assetUrl(h.thumb)}')` : ""}">
        ${h.clip ? `<span class="play">▶</span>` : `<span class="state">${h.render_error ? esc(h.render_error) : "Filming soon"}</span>`}
        <span class="dur">${fmtClip(h.duration_s)}</span>
      </div>
      <div class="hl-info"><div class="hl-title">${esc(h.title)}</div>
        <div class="hl-meta"><span>${esc(mapName(h.match.map))} · round ${h.round}</span></div>
        ${big ? `<div class="tags">${h.tags.map((t) => tagHtml(t)).join("")}</div>` : ""}</div>
    </div>`;
  const [top, ...rest] = list;
  return `<section class="sh-wrap"><div class="sh-head"><div class="h3">Your top highlights</div><span class="grow"></span>
      <a class="sub" href="#/day/${esc(date)}/o/x/highlights">All ${list.length} from this day →</a></div>
    <div class="sh-grid">${card(top, true)}${rest.length ? `<div class="sh-rest">${rest.slice(0, 4).map((h) => card(h, false)).join("")}</div>` : ""}</div></section>`;
}

// How the session went objectively: against the usual marks for any player, not your own average.
function objectiveHtml(p, data) {
  if (!p || !p.rounds) return "";
  const n = p.maps || 1;
  const pct0 = (v) => `${Math.round(v)}%`;
  const ok = p.c.opening_kills || 0, od = p.c.opening_deaths || 0;
  const [pw, pl] = p.pistolDuels || [0, 0];
  const cg = clutchGrade(p.c.clutches_won || [], p.c.clutches_attempted || [], data?.clutchRates || CLUTCH_AVG);
  const stats = [
    ["HLTV 3.0", f2(p.rating3), sessGrade("rating", p.rating3, n), 3],
    ["K/D", f2(p.kd), sessGrade("kd", p.kd, n), 2],
    ["ADR", f1(p.adr), sessGrade("adr", p.adr, n), 2],
    ["Kills a round", f2(p.kr), sessGrade("kpr", p.kr, n), 1],
    ["Swing", fmtSwing(p.swing), sessGrade("swing", p.swing, n), 1],
    ["KAST", pct0(p.kast), sessGrade("kast", p.kast, n), 1],
    ok + od >= 4 ? ["Opening duels", `${pct0((100 * ok) / (ok + od))} (${ok}-${od})`, sessGrade("open", (100 * ok) / (ok + od), n), 1] : null,
    pw + pl >= 4 ? ["Pistol rounds", `${pct0((100 * pw) / (pw + pl))} (${pw}-${pl})`, sessGrade("duels", (100 * pw) / (pw + pl), n), 1] : null,
    cg && cg.n >= 3 ? ["Clutches", `${cg.w}/${cg.n} (the average player: ${f1(cg.expected)})`, cg.g, 1] : null,
  ].filter(Boolean);
  const excellent = stats.filter((x) => x[2] === "g0"), good = stats.filter((x) => x[2] === "g1");
  const rg = stats[0][2];
  const tier = rg === "g0" && excellent.length >= Math.max(5, Math.ceil(stats.length * 0.75)) ? ["fire", "You were on fire this session."]
    : rg === "g0" || (rg === "g1" && excellent.length >= 3) ? ["great", "You played great this session."]
    : rg === "g1" ? ["good", "You played good this session."]
    : rg === "g2" ? ["even", "You played okay this session."]
    : rg === "g3" ? ["rough", "You played bad this session."]
    : ["rough", "You played terrible this session."];
  const order = { g0: 0, g1: 1, g2: 2, g3: 3, g4: 4 };
  const chips = [...stats].sort((a, b) => order[a[2]] - order[b[2]] || b[3] - a[3]);
  const over = n > 1 ? ` over ${n} matches (holding numbers across a whole session is much harder than in one match, so the marks allow for it)` : "";
  const sub = excellent.length ? `${excellent.length} of your ${stats.length} main stats were excellent${good.length ? `, ${good.length} more good` : ""}, by the usual marks for any player${over}.`
    : `By the usual marks for any player${over}, not your own average.`;
  return `<div class="sv-obj ${tier[0]}"><div class="sv-obj-head"><b>${tier[1]}</b></div>
    <div class="sub">${sub}</div>
    <div class="sv-obj-chips">${chips.map(([label, v, g]) => `<span class="sv-obj-chip ${g}"><span>${esc(label)}</span><b>${esc(v)}</b><i class="ps-grade ${g}">${RATE_GRADES[g]}</i></span>`).join("")}</div></div>`;
}

const ordinal = (n) => `${n}${["th", "st", "nd", "rd"][(n % 100 > 10 && n % 100 < 14) || n % 10 > 3 ? 0 : n % 10]}`;
function verdictHtml(j) {
  if (!j) return `<div class="sv-box"><div class="sv-head">No demos for this session yet</div><div class="sub">Get the demos and Veloxify tells you how you played compared with your usual.</div></div>`;
  if (j.few) return `<div class="sv-box"><div class="sv-head">Not enough matches yet</div><div class="sub">After a few more matches with demos, Veloxify compares each session with your usual.</div></div>`;
  const r = j.rating;
  const head = j.verdict === "good" ? `You played <b>${j.pct}% better</b> than your average session.`
    : j.verdict === "bad" ? `You played <b>${Math.abs(j.pct)}% worse</b> than your average session.`
    : `About your average session${Math.abs(j.pct) >= 1 ? ` (${j.pct > 0 ? "+" : ""}${j.pct}%)` : ""}: within your normal ups and downs.`;
  const list = (ps) => ps.slice(0, 3).map((p) => `${p.words}${SIZE_WORD(p.z)}`);
  const join = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}` : xs[0] || "");
  const parts = [
    j.better.length ? `<span class="up">Better than usual:</span> ${join(list(j.better))}.` : "",
    j.worse.length ? `<span class="down">Worse than usual:</span> ${join(list(j.worse))}.` : "",
    !j.better.length && !j.worse.length ? "Every part of your game was close to your usual." : "",
  ].filter(Boolean);
  const facts = j.facts.filter((f) => Math.abs(f.z) >= 1).slice(0, 4);
  const shown = facts.length ? facts : j.facts.slice(0, 2);
  const tips = j.worse.filter((p) => p.z <= -1.5 && SESS_TIPS[p.key]).slice(0, 2);
  return `<div class="sv-box ${j.verdict}">
    <div class="sv-dot ${j.verdict}"></div>
    <div class="sv-body"><div class="sv-head">${head}</div>
      <div class="sv-sub">HLTV 3.0 <b>${f2(r.v)}</b> against your usual ${f2(r.b)}, over ${j.n} match${j.n === 1 ? "" : "es"}${j.n < 3 ? " (one or two matches swing a lot)" : ""}.${j.rank ? ` Your ${j.rank.pos === 1 ? "<b>best</b>" : `<b>${ordinal(j.rank.pos)} best</b>`} session of ${j.rank.of}${j.rank.minLen > 1 ? ` with ${j.rank.minLen}+ matches` : ""}.` : ""}</div>
      <div class="sv-parts">${parts.map((p) => `<div>${p}</div>`).join("")}</div>
      ${shown.length ? `<ul class="sv-facts">${shown.map((f) => `<li class="${f.z >= 1 ? "good" : f.z <= -1 ? "bad" : ""}">${f.text}</li>`).join("")}</ul>` : ""}
      ${tips.length ? `<div class="sv-tips">${tips.map((p) => `<div><b>Work on ${esc(p.words)}:</b> ${esc(SESS_TIPS[p.key])}</div>`).join("")}</div>` : ""}
    </div></div>`;
}

// Your usual numbers next to this session's.
const BASE_STATS = [["rating3", "HLTV 3.0", f2], ["kpr", "Kills / round", f2], ["dpr", "Deaths / round", f2], ["adr", "ADR", (v) => v.toFixed(0)], ["kast", "KAST", (v) => `${Math.round(v)}%`],
  ["hs_pct", "Headshot %", (v) => `${Math.round(v)}%`], ["entry_success", "Opening duels won", (v) => `${Math.round(v)}%`], ["trade_kills_pr", "Trade kills / round", f2],
  ["spotted_accuracy", "Accuracy at visible enemies", (v) => `${Math.round(v)}%`], ["ttd_ms", "Time to damage", (v) => `${Math.round(v)} ms`], ["crosshair_deg", "Crosshair placement", (v) => `${v.toFixed(1)}°`],
  ["counter_strafe", "Counter-strafing", (v) => `${Math.round(v)}%`], ["nades_per_round", "Grenades / round", (v) => v.toFixed(1)], ["utility_damage_pr", "Utility damage / round", (v) => v.toFixed(1)]];
function baselineHtml(j, data) {
  if (!j || j.few) return "";
  const lower = (k) => !!data.bench[k]?.lower_is_better;
  // One row: this session, your usual, the difference, and how good this session's number is.
  const tr = (label, now, usual, diff, cls, grade = null, extra = "") => `<tr><td>${label}</td><td><b>${now}</b>${extra ? ` <small class="sub">${extra}</small>` : ""}${grade ? ` <i class="ps-grade ${grade}">${RATE_GRADES[grade]}</i>` : ""}</td><td>${usual}</td><td class="${cls}">${diff}</td></tr>`;
  const row = ([k, label, fmt]) => {
    const v = wmean(j.mine, k), b = wmean(j.baseline, k);
    if (v == null || b == null) return "";
    const better = lower(k) ? v < b : v > b, rel = b ? (v - b) / Math.abs(b) : 0;
    const diff = Math.abs(rel) < 0.005 ? "same" : `${rel > 0 ? "+" : "−"}${Math.abs(Math.round(rel * 100))}%`;
    return tr(label, fmt(v), fmt(b), diff, Math.abs(rel) < 0.03 ? "" : better ? "up" : "down", gradeOfStat(k, v));
  };
  // How good a value is: by the generally accepted marks where there are some, else against every
  // player-match in your lobbies.
  const STD = { rating3: "rating", kpr: "kpr", adr: "adr", kast: "kast", hs_pct: "hs", entry_success: "open" };
  const gradeOfStat = (k, v) => (STD[k] ? sessGrade(STD[k], v, j.n) : bandOf(standing(k, v)) || null);
  const duelRow = (label, get) => {
    const [w, l] = duelSum(j.mine, get), [bw, bl] = duelSum(j.baseline, get);
    if (w + l < 3 || bw + bl < 10) return "";
    const pnow = w / (w + l), bp = bw / (bw + bl), d = Math.round(100 * (pnow - bp));
    return tr(label, `${Math.round(100 * pnow)}%`, `${Math.round(100 * bp)}%`, d ? `${d > 0 ? "+" : "−"}${Math.abs(d)} pts` : "same", Math.abs(pnow - bp) < 0.03 ? "" : pnow > bp ? "up" : "down", null, `${w}-${l}`);
  };
  const wins = j.mine.filter((r) => r.result === "win").length, bwins = j.baseline.filter((r) => r.result === "win").length;
  const wr = wins / j.n, bwr = bwins / j.baseline.length, wd = Math.round(100 * (wr - bwr));
  return `<section class="panel sv-base"><div class="panel-head"><div class="h3">This session against your usual</div><span class="grow"></span><span class="sub">Your usual: your average over your other ${j.baseline.length} matches</span></div>
    <table class="ins-table sv-cmp"><thead><tr><th></th><th>This session</th><th>Your usual</th><th>Difference</th></tr></thead><tbody>
      ${tr("Matches won", `${Math.round(100 * wr)}%`, `${Math.round(100 * bwr)}%`, wd ? `${wd > 0 ? "+" : "−"}${Math.abs(wd)} pts` : "same", Math.abs(wd) < 3 ? "" : wd > 0 ? "up" : "down", j.n >= 3 ? sessGrade("win", wr, j.n) : null, `${wins}-${j.n - wins}`)}
      ${BASE_STATS.map(row).join("")}
      ${duelRow("Rifle duels won", (d) => d.by_weapon?.rifle)}${duelRow("AWP duels won", (d) => d.by_weapon?.awp)}${duelRow("Pistol duels won", (d) => d.by_weapon?.pistol)}
      ${duelRow("Afterplant duels won", (d) => d.afterplant)}${duelRow("Retake duels won", (d) => d.retake)}
    </tbody></table>
    <div class="note" style="padding:0 20px 14px;margin:0">The grade is for this session's number by the usual marks for any player (or, without one, against every player in your matches); the difference is against your own average.</div></section>`;
}

// ---- what we noticed: what goes with you playing better or worse ----
// Each match gets its factors (time of day, how far into the session, party, crosshair, map, your
// setup, practice before, your session tags); a factor value that's clearly better or worse than
// your usual is worth telling.
const NOTE_TAGS = ["Warmed up", "No warm-up", "Tired", "Tilted", "Focused", "New mouse", "New settings", "New crosshair", "Played with friends"];
function setupAt(data, ts) {
  // The setup recorded when CS2 closed after this session (or the latest before it).
  let best = null;
  for (const e of data.setups) if (e.ts <= ts + 6 * 3600) best = e;
  return best && ts - best.ts < 14 * 86400 ? best : null;
}
function matchFactors(data, r) {
  const sess = data.sessions.find((s) => s.key === r.session);
  const notes = data.notes[r.session] || {};
  const setup = sess ? setupAt(data, sess.end) : null;
  const practiced = sess && data.practice.some((p) => p.ts <= sess.start && p.ts >= sess.start - 3 * 3600);
  const hour = r.hour;
  return {
    time: hour >= 5 && hour < 12 ? "in the morning" : hour < 18 && hour >= 12 ? "in the afternoon" : hour >= 18 && hour < 24 ? "in the evening" : "late at night (after midnight)",
    match: r.nInSession <= 2 ? "in your first two matches" : r.nInSession <= 4 ? "in matches 3 and 4" : "from your 5th match on",
    party: r.party ? ["", "solo", "in a duo", "in a 3-stack", "in a 4-stack", "in a 5-stack"][r.party] : null,
    map: `on ${mapName(r.map)}`,
    crosshair: r.xh ? r.xh : null,
    resolution: setup?.resolution ? `at ${setup.resolution}${setup.aspect && setup.aspect !== "16:9" ? ` (${setup.aspect})` : ""}` : null,
    sensitivity: setup?.sensitivity ? `at sensitivity ${setup.sensitivity}` : null,
    mouse: setup?.mice?.length ? `with your ${setup.mice.join(" / ")}` : null,
    practice: sess && data.practice.length ? (practiced ? "after practicing in Veloxify's Practice tab" : "without practicing first") : null,
    ...Object.fromEntries((notes.tags || []).map((t) => [`tag:${t}`, `in sessions you tagged "${t}"`])),
  };
}
function noticed(data) {
  const rows = data.rows.filter((r) => r.stats.rating3 != null);
  if (rows.length < 15) return [];
  const all = wmean(rows, "rating3"), sd = sdOf(rows, "rating3") || 0.3;
  const groups = new Map();
  for (const r of rows) for (const [f, v] of Object.entries(matchFactors(data, r))) {
    if (v == null) continue;
    const key = `${f}|${v}`;
    if (!groups.has(key)) groups.set(key, { f, v, rows: [] });
    groups.get(key).rows.push(r);
  }
  // Tags: compare tagged sessions with untagged ones.
  const out = [];
  for (const g of groups.values()) {
    const n = g.rows.length;
    if (n < 4 || n > rows.length - 4) continue;
    const rest = rows.filter((r) => !g.rows.includes(r));
    const m = wmean(g.rows, "rating3"), o = wmean(rest, "rating3");
    const z = (m - o) / (sd * Math.sqrt(1 / n + 1 / rest.length));
    const pct = Math.round((m / o - 1) * 100);
    if (Math.abs(z) < 1.6 || Math.abs(pct) < 5) continue;
    out.push({ ...g, n, m, o, z, pct, all });
  }
  return out.sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
}
function noticedText(x) {
  const how = x.pct > 0 ? `<b class="up">${x.pct}% better</b>` : `<b class="down">${Math.abs(x.pct)}% worse</b>`;
  if (x.f === "crosshair") return `You play ${how} with this crosshair <span class="xh-inline" data-xh="${esc(x.v)}">${xhSvg(xhOf(x.v), 26, 2)}</span> <span class="sub">(HLTV 3.0 ${f2(x.m)} over ${x.n} matches, ${f2(x.o)} otherwise)</span>`;
  return `You play ${how} ${esc(x.v)} <span class="sub">(HLTV 3.0 ${f2(x.m)} over ${x.n} matches, ${f2(x.o)} otherwise)</span>`;
}

// Your notes and tags for a session.
function notesHtml(data, key) {
  const n = data.notes[key] || {};
  return `<section class="panel sv-notes"><div class="panel-head"><div class="h3">Notes</div><span class="grow"></span><span class="sub">Anything that might have mattered: a new mouse, new settings, how you felt</span></div>
    <div class="sv-notes-body"><div class="chips">${NOTE_TAGS.map((t) => `<button class="chip ${(n.tags || []).includes(t) ? "on" : ""}" data-tag="${esc(t)}">${esc(t)}</button>`).join("")}</div>
      <textarea id="sv-note" rows="3" placeholder="Switched to a new mouse, tried 4:3 stretched, played after the gym…" ${tauri ? "" : "disabled"}>${esc(n.text || "")}</textarea>
      <div class="sub">Tags show up in "What we noticed" once you've used them on a few sessions.</div></div></section>`;
}
function wireNotes(view, data, key) {
  const save = async () => { if (tauri) await tauri.core.invoke("save_session_notes", { notes: data.notes }); };
  const entry = () => (data.notes[key] = data.notes[key] || { tags: [], text: "" });
  view.querySelectorAll(".sv-notes [data-tag]").forEach((b) => (b.onclick = async () => {
    const e = entry(), t = b.dataset.tag;
    e.tags = e.tags.includes(t) ? e.tags.filter((x) => x !== t) : [...e.tags, t];
    b.classList.toggle("on", e.tags.includes(t));
    await save();
  }));
  const ta = view.querySelector("#sv-note");
  if (ta) ta.onchange = async () => { entry().text = ta.value.trim(); await save(); };
}

// The setup you played this session with (from when you closed CS2 after it).
function setupHtml(data, sess) {
  const s = setupAt(data, sess.end);
  const xhs = [...new Set(sess.ids.map((id) => data.byId.get(id)?.xh).filter(Boolean))];
  if (!s && !xhs.length) return "";
  return `<div class="sv-setup">${xhs.map((c) => `<span class="sv-chip" data-xh="${esc(c)}" title="Your crosshair this session">${xhSvg(xhOf(c), 22, 2)} Crosshair</span>`).join("")}
    ${s ? `<span class="sv-chip">${esc(s.resolution)}${s.aspect !== "16:9" ? ` ${esc(s.aspect)}` : ""} · ${esc(s.display)}${s.refresh_hz ? ` · ${s.refresh_hz} Hz` : ""}</span><span class="sv-chip">Sensitivity ${esc(s.sensitivity)}</span>${s.mice?.length ? `<span class="sv-chip">${esc(s.mice.join(" / "))}</span>` : ""}` : ""}</div>`;
}

// ---- Previous sessions: a calendar with a dot per session ----
const calView = { month: null };
async function renderSessionCalendar(view) {
  const data = await loadSessionData();
  const sessions = data.sessions;
  if (!sessions.length) { view.innerHTML = `<div class="empty">No sessions yet.</div>`; return; }
  const last = new Date(sessions[sessions.length - 1].start * 1000);
  const month = calView.month || [last.getFullYear(), last.getMonth()];
  calView.month = month;
  const [y, mo] = month;
  const first = new Date(y, mo, 1), days = new Date(y, mo + 1, 0).getDate();
  const byDay = new Map();
  for (const s of sessions) {
    const d = new Date(s.start * 1000);
    if (d.getFullYear() !== y || d.getMonth() !== mo) continue;
    const k = d.getDate();
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(s);
  }
  const verdictOf = (s) => { const j = judgeSession(data, s.ids); return !j ? { cls: "none", t: "No demos" } : j.few ? { cls: "none", t: "Not enough matches yet" } : { cls: j.verdict, t: j.verdict === "even" ? "About your average" : `${j.pct > 0 ? "+" : ""}${j.pct}% vs your average`, j }; };
  const cells = [];
  for (let i = 0; i < first.getDay(); i++) cells.push(`<div class="cal-cell empty"></div>`);
  const counts = { good: 0, even: 0, bad: 0 };
  for (let d = 1; d <= days; d++) {
    const list = byDay.get(d) || [];
    const dots = list.map((s) => { const v = verdictOf(s); if (counts[v.cls] != null) counts[v.cls]++; return `<a class="cal-sess ${v.cls}" href="#/session/${s.date}/${s.idx}" title="${s.wins}W ${s.losses}L · ${esc(v.t)}"><i></i><span>${s.wins}-${s.losses}</span></a>`; }).join("");
    cells.push(`<div class="cal-cell ${list.length ? "has" : ""}"><span class="cal-day">${d}</span>${dots}</div>`);
  }
  const step = (dm) => { const t = new Date(y, mo + dm, 1); calView.month = [t.getFullYear(), t.getMonth()]; renderSessionCalendar(view); };
  const firstS = new Date(sessions[0].start * 1000);
  const canPrev = y > firstS.getFullYear() || (y === firstS.getFullYear() && mo > firstS.getMonth());
  const canNext = y < last.getFullYear() || (y === last.getFullYear() && mo < last.getMonth());
  const total = counts.good + counts.even + counts.bad;
  view.innerHTML = `
    <div class="ins-head"><div><div class="h1">Sessions</div><div class="sub">Every session, colored by how you played against your usual: <b class="up">better</b>, <b style="color:var(--gold)">about average</b>, <b class="down">worse</b>. Click one to open it.</div></div><span class="grow"></span><a class="btn" href="#/latest">Latest session</a></div>
    <section class="panel cal">
      <div class="cal-nav"><button class="btn ghost" id="cal-prev" ${canPrev ? "" : "disabled"}>◀</button><div class="h2">${MONTHS[mo]} ${y}</div><button class="btn ghost" id="cal-next" ${canNext ? "" : "disabled"}>▶</button>
        <span class="grow"></span>${total ? `<span class="sub">${counts.good} better · ${counts.even} average · ${counts.bad} worse</span>` : ""}</div>
      <div class="cal-grid">${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => `<div class="cal-h">${d}</div>`).join("")}${cells.join("")}</div>
    </section>`;
  view.querySelector("#cal-prev").onclick = () => step(-1);
  view.querySelector("#cal-next").onclick = () => step(1);
}

// ---- lowlights ----------------------------------------------------------------------------------

// Lowlight kinds and reasons, as the analysis names them.
const LL_KINDS = [["all", "All"], ["back", "Missed back"], ["awp", "AWP"], ["scout", "Scout"], ["spray:rifle", "Rifle spray"], ["spray:smg", "SMG spray"], ["pistol:pistol", "Pistol"], ["pistol:deagle", "Deagle"]];
const LL_REASONS = {
  late_stop: ["Late counter-strafe", "movement"], moved_mid_spray: ["Moved mid-spray", "movement"], moving: ["Shooting on the move", "movement"],
  jumping: ["Jump shot", "movement"], unscoped: ["Shot before scoping", "aim"], quickscope: ["Scope not settled", "aim"], spray: ["Spray control", "spray"], aim: ["Aim", "aim"], unlucky: ["Unlucky", "unlucky"], unknown: ["Missed", "unknown"],
};
const LL_GROUPS = [["movement", "Movement", "var(--t)"], ["spray", "Spray control", "#c084fc"], ["aim", "Aim", "#ff5252"], ["unlucky", "Unlucky", "#8a8f98"]];
// What to practice for each reason (used by Practice later).
const LL_TIPS = {
  late_stop: "Counter-strafe drills: tap the opposite key and only fire once you've stopped.",
  moved_mid_spray: "Hold still once a spray starts; if you need to move, stop shooting first.",
  moving: "Stop before you shoot: counter-strafe, or walk-peek with the shift key.",
  jumping: "Don't jump-shoot rifles; jump only to reposition.",
  unscoped: "Scope in fully before you shoot; the AWP and Scout are only accurate once the zoom settles.",
  quickscope: "Give the scope a split second (about 0.15 s) to settle before you click.",
  spray: "Spray control: practice the first 10 bullets of the pattern against a wall, then on bots.",
  aim: "Crosshair placement: pre-aim head height where enemies appear, so the first bullet needs no flick.",
  unlucky: "Nothing mechanical to fix; it was spread.",
};
let ll = { kind: "all", reason: "all", source: "all", sort: "worst" };
try { ll = { ...ll, ...JSON.parse(localStorage.getItem("veloxify.lowlights") || "{}") }; } catch (e) { /* defaults */ }

function lowlightCard(l) {
  const [reasonText, group] = LL_REASONS[l.reason] || LL_REASONS.unknown;
  const groupColor = (LL_GROUPS.find((g) => g[0] === group) || [])[2] || "var(--muted)";
  return `
    <a class="ll-card" href="#/clips/lowlights/${encodeURIComponent(l.match_id)}/${encodeURIComponent(l.id)}">
      <div class="ll-top"><span class="ll-dot" style="background:${groupColor}"></span><b>${esc(l.title)}</b><span class="grow"></span>
        <span class="sub">${l.shots} shot${l.shots === 1 ? "" : "s"} · ${l.hits} hit${l.hits === 1 ? "" : "s"}</span></div>
      <div class="ll-verdict">${esc(l.verdict)}</div>
      <div class="tags">${(l.tags || []).map((t) => `<span class="tag ${t === reasonText ? "reason" : ""}">${esc(t)}</span>`).join("")}</div>
      <div class="hl-meta"><span>${esc(mapName(l.map))} · ${l.score_mine}-${l.score_theirs}</span><span>${relDay(l.played_at.slice(0, 10))}</span><span>${esc(l.source_label || "")}</span><span>vs ${esc(l.killer_name || "")}</span></div>
    </a>`;
}

function renderLowlightsTab(view) {
  const all = state.index.lowlights || [];
  const save = () => { try { localStorage.setItem("veloxify.lowlights", JSON.stringify(ll)); } catch (e) { /* not persisted */ } };
  const sources = [...new Set(all.map((l) => l.source_label).filter(Boolean))].sort();
  const kindOk = (l) => {
    if (ll.kind === "all") return true;
    const [kind, cls] = ll.kind.split(":");
    return l.kind === kind && (!cls || l.weapon_class === cls);
  };
  const list = all.filter((l) => kindOk(l) && (ll.reason === "all" || (LL_REASONS[l.reason] || [])[1] === ll.reason) && (ll.source === "all" || l.source_label === ll.source))
    .sort((a, b) => (ll.sort === "worst" ? b.severity - a.severity || b.played_ts - a.played_ts : b.played_ts - a.played_ts));
  // Why you lose duels: reasons over the last 30 days.
  const recent = all.filter((l) => l.played_ts > Date.now() / 1000 - 30 * DAY_S);
  const counts = LL_GROUPS.map(([g]) => recent.filter((l) => (LL_REASONS[l.reason] || [])[1] === g).length);
  const total = sum(counts) || 1;
  const topReasons = Object.entries(recent.reduce((acc, l) => ((acc[l.reason] = (acc[l.reason] || 0) + 1), acc), {})).sort((a, b) => b[1] - a[1]);
  const seg = (key, opts) => `<div class="seg" data-lkey="${key}">${opts.map(([v, label]) => `<button data-v="${v}" class="${ll[key] === v ? "on" : ""}">${label}</button>`).join("")}</div>`;
  view.innerHTML = `
    <section class="panel" style="margin-bottom:20px">
      <div class="panel-head"><div class="h3">Why you lose duels</div><span class="sub">last 30 days · ${recent.length} lowlight${recent.length === 1 ? "" : "s"}</span></div>
      ${recent.length ? `
      <div class="why-bar">${LL_GROUPS.map(([g, , c], i) => counts[i] ? `<i style="width:${(100 * counts[i]) / total}%;background:${c}" title="${counts[i]} ${g}"></i>` : "").join("")}</div>
      <div class="why-legend">${LL_GROUPS.map(([g, label, c], i) => `<span><i style="background:${c}"></i><b>${Math.round((100 * counts[i]) / total)}%</b> ${label}</span>`).join("")}</div>
      ${topReasons.length && topReasons[0][0] !== "unknown" ? `<div class="why-tip"><b>Work on first:</b> ${esc((LL_REASONS[topReasons[0][0]] || [""])[0])} (${topReasons[0][1]} of ${recent.length}). ${esc(LL_TIPS[topReasons[0][0]] || "")}</div>` : ""}`
      : `<div class="fc-msg">No lowlights in the last 30 days.</div>`}
    </section>
    <section class="panel browser">
      <div class="controls">
        ${seg("kind", LL_KINDS)}
        <label>Reason <select id="ll-reason"><option value="all">All</option>${LL_GROUPS.map(([g, label]) => `<option value="${g}" ${ll.reason === g ? "selected" : ""}>${label}</option>`).join("")}</select></label>
        <label>Source <select id="ll-source"><option value="all">All</option>${sources.map((s) => `<option value="${esc(s)}" ${ll.source === s ? "selected" : ""}>${esc(s)}</option>`).join("")}</select></label>
        <span class="grow"></span>
        ${seg("sort", [["worst", "Worst first"], ["recent", "Newest"]])}
      </div>
      <div class="browser-body">${list.length ? `<div class="ll-grid">${list.map(lowlightCard).join("")}</div>` : `<div class="empty">No lowlights match these filters.</div>`}</div>
    </section>`;
  view.querySelectorAll(".seg[data-lkey]").forEach((el) => el.querySelectorAll("button").forEach((b) => (b.onclick = () => { ll[el.dataset.lkey] = b.dataset.v; save(); renderLowlightsTab(view); })));
  view.querySelector("#ll-reason").onchange = (e) => { ll.reason = e.target.value; save(); renderLowlightsTab(view); };
  view.querySelector("#ll-source").onchange = (e) => { ll.source = e.target.value; save(); renderLowlightsTab(view); };
}

// One lowlight: where every bullet went (his view), your speed at each shot, and the verdict.
async function renderLowlight(view, matchId, id) {
  const [m] = await Promise.all([loadMatch(matchId, true), loadRecoil()]);
  const l = (m.lowlights || []).find((x) => x.id === id);
  if (!l) { view.innerHTML = `<div class="empty">That lowlight isn't in this match any more.</div>`; return; }
  const [reasonText, group] = LL_REASONS[l.reason] || LL_REASONS.unknown;
  const groupColor = (LL_GROUPS.find((g) => g[0] === group) || [])[2] || "var(--muted)";
  const shots = l.shot_details || [];
  const VCOL = { hit: "#2fd36f", unscoped: "#ff5252", quickscope: "#ff5252", moving: "var(--t)", jumping: "var(--t)", aim: "#ff5252", high: "#c084fc", low: "#c084fc", drift: "#c084fc", spread: "#8a8f98", "": "#8a8f98" };
  const VTEXT = { hit: "Hit", unscoped: "Not scoped in", quickscope: "Fired before the scope settled", moving: "Moving", jumping: "In the air", aim: "Aim off", high: "Over his head (didn't pull down)", low: "Under him (pulled too far)", drift: "Drifted sideways", spread: "On him; spread missed", "": "No tick data" };
  // Target view (his view at his distance), in cm around his head.
  const pts = shots.filter((s) => s.off_x_cm != null);
  const extent = Math.min(420, Math.max(110, ...pts.map((s) => Math.max(Math.abs(s.off_x_cm), Math.abs(s.off_y_cm) * 0.8)).map((v) => v * 1.15)));
  const W = 320, H = 300, sc = (W / 2 - 14) / extent, cx = W / 2, cy = 96;
  const X = (x) => cx + x * sc, Y = (y) => cy - y * sc;
  const clampX = (x) => Math.max(10, Math.min(W - 10, x)), clampY = (y) => Math.max(10, Math.min(H - 10, y));
  const body = `
    <circle cx="${X(0)}" cy="${Y(0)}" r="${13 * sc}" class="tg-body"/>
    <rect x="${X(-24)}" y="${Y(-18)}" width="${48 * sc}" height="${80 * sc}" rx="${8 * sc}" class="tg-body"/>
    <rect x="${X(-20)}" y="${Y(-98)}" width="${17 * sc}" height="${70 * sc}" rx="${5 * sc}" class="tg-body"/>
    <rect x="${X(3)}" y="${Y(-98)}" width="${17 * sc}" height="${70 * sc}" rx="${5 * sc}" class="tg-body"/>`;
  const dots = pts.map((s) => {
    const x = clampX(X(s.off_x_cm)), y = clampY(Y(s.off_y_cm));
    return `<g class="tg-shot" data-tip="Bullet ${s.bullet}: ${esc(VTEXT[s.verdict] || s.verdict)} · ${s.speed != null ? Math.round(s.speed) + " u/s" : ""}">
      <circle cx="${x}" cy="${y}" r="9" fill="${VCOL[s.verdict] || "#8a8f98"}"/><text x="${x}" y="${y + 4}" text-anchor="middle">${s.bullet}</text></g>`;
  }).join("");
  // Speed at each shot vs the speed below which the gun is accurate.
  const SW = 420, SH = 210, pad = 34;
  const maxSpeed = Math.max(250, ...shots.map((s) => s.speed || 0));
  const tMax = Math.max(0.5, ...shots.map((s) => s.t)) + 0.1;
  const sx = (t) => pad + ((tMax - t) / tMax) * (SW - pad - 10), sy = (v) => SH - 24 - (v / maxSpeed) * (SH - 44);
  const acc = shots[0]?.accurate_speed || 70;
  const speedPath = shots.filter((s) => s.speed != null).map((s, i) => `${i ? "L" : "M"}${sx(s.t).toFixed(1)},${sy(s.speed).toFixed(1)}`).join(" ");
  const speedDots = shots.filter((s) => s.speed != null).map((s) => `<circle cx="${sx(s.t)}" cy="${sy(s.speed)}" r="5.5" fill="${VCOL[s.verdict] || "#8a8f98"}"><title>Bullet ${s.bullet}: ${Math.round(s.speed)} u/s</title></circle>`).join("");
  const where = (s) => {
    if (s.off_x_cm == null) return "–";
    const h = Math.abs(s.off_x_cm) >= 3 ? `${Math.round(Math.abs(s.off_x_cm))} cm ${s.off_x_cm > 0 ? "right" : "left"}` : "";
    const v = Math.abs(s.off_y_cm) >= 3 ? `${Math.round(Math.abs(s.off_y_cm))} cm ${s.off_y_cm > 0 ? "above" : "below"}` : "";
    return [h, v].filter(Boolean).join(", ") || "on his head";
  };
  view.innerHTML = `
    <a class="day-back" href="#/clips/lowlights">◀ Lowlights</a>
    <section class="panel">
      <div class="panel-head" style="flex-wrap:wrap">
        <div class="h3">${esc(l.title)}</div>
        <span class="ll-chip" style="--c:${groupColor}">${esc(reasonText)}</span>
        <span class="sub">${esc(mapName(m.map))} · ${m.score_mine}-${m.score_theirs} · ${relDay(m.played_at.slice(0, 10))} · vs ${esc(l.killer_name)}${l.distance_m ? ` · ${Math.round(l.distance_m)} m` : ""}</span>
        <span class="grow"></span>
        ${l.clip ? `<button class="btn primary" id="ll-watch">${ICONS.star.replace("currentColor", "currentColor")} Watch</button>`
          : tauri ? `<button class="btn primary" id="ll-render" title="Veloxify renders it in the background as soon as CS2 is free">Render clip</button>` : ""}
        <a class="btn ghost" href="${matchHref(matchId, "lowlights")}">Open match</a>
        ${tauri ? `<button class="btn ghost" id="ll-delete">Delete</button>` : ""}
      </div>
      <div class="ll-verdict big">${esc(l.verdict)}</div>
      ${LL_TIPS[l.reason] ? `<div class="why-tip"><b>Work on:</b> ${esc(LL_TIPS[l.reason])} <a class="link" href="#/practice">Practice this</a></div>` : ""}
      ${whiffAnalyzer(l, m, VCOL)}
      <div class="ll-panels">
        <div class="ll-panel">
          <div class="h2">Where your bullets went · his view${l.distance_m ? `, ${Math.round(l.distance_m)} m` : ""}</div>
          ${pts.length ? `<svg viewBox="0 0 ${W} ${H}" class="tg" role="img" aria-label="Where each bullet went relative to his body">
            <line x1="${cx}" y1="0" x2="${cx}" y2="${H}" class="tg-axis"/><line x1="0" y1="${cy}" x2="${W}" y2="${cy}" class="tg-axis"/>
            ${body}${dots}</svg>
            <div class="sub">Dot = where your crosshair plus recoil pointed for that bullet. Off-screen bullets sit on the edge.</div>`
            : `<div class="fc-msg">No aim data for this one.</div>`}
        </div>
        <div class="ll-panel">
          <div class="h2">Your speed at each shot</div>
          <svg viewBox="0 0 ${SW} ${SH}" class="sp" role="img" aria-label="Your speed at each shot against the accurate speed">
            <line x1="${pad}" x2="${SW - 6}" y1="${sy(acc)}" y2="${sy(acc)}" class="sp-acc"/>
            <text x="${pad + 4}" y="${sy(acc) + 12}" class="sp-acc-t">accurate below ${Math.round(acc)} u/s</text>
            <line x1="${pad}" x2="${SW - 6}" y1="${SH - 24}" y2="${SH - 24}" class="sp-base"/>
            <text x="${pad - 6}" y="${sy(maxSpeed) + 4}" text-anchor="end" class="sp-ax">${Math.round(maxSpeed)}</text>
            <text x="${pad - 6}" y="${SH - 20}" text-anchor="end" class="sp-ax">0</text>
            <text x="${SW - 6}" y="${SH - 6}" text-anchor="end" class="sp-ax">you die</text>
            <path d="${speedPath}" class="sp-line"/>${speedDots}
          </svg>
        </div>
      </div>
      <div class="ll-legend">${[["hit", "Hit"], ["moving", "Moving / jumping"], ["high", "Spray off"], ["aim", "Aim off"], ["spread", "On him, spread"]].map(([k, t]) => `<span><i style="background:${VCOL[k]}"></i>${t}</span>`).join("")}</div>
      <table class="sb ll-shots">
        <thead><tr><th>Bullet</th><th>Before death</th><th>Speed</th><th>Where it went</th><th>Verdict</th></tr></thead>
        <tbody>${shots.map((s) => `<tr><td>${s.bullet}</td><td>${s.t.toFixed(2)} s</td>
          <td class="${s.speed != null && s.speed > s.accurate_speed ? "loss-text" : ""}">${s.speed != null ? Math.round(s.speed) + " u/s" : "–"}</td>
          <td>${esc(where(s))}</td><td><span class="ll-dot" style="background:${VCOL[s.verdict] || "#8a8f98"}"></span> ${esc(VTEXT[s.verdict] || s.verdict)}</td></tr>`).join("")}</tbody>
      </table>
      <div class="note">Speeds and angles come from the demo at 64 ticks a second; CS2 fires between ticks, so treat degrees and milliseconds as close, not exact.</div>
    </section>`;
  wireWhiffAnalyzer(view, l, VCOL);
  const watch = view.querySelector("#ll-watch");
  if (watch) watch.onclick = () => { state.playlist = [{ ...l, name: "You", match: { map: m.map } }]; play(0); };
  const rend = view.querySelector("#ll-render");
  if (rend) rend.onclick = () => {
    tauri.core.invoke("render_clips", { items: [[matchId, l.id]] });
    rend.disabled = true;
    rend.textContent = "Queued: renders when CS2 is free";
  };
  const del = view.querySelector("#ll-delete");
  if (del) del.onclick = async () => {
    if (confirm("Delete this lowlight for good?")) { await tauri.core.invoke("delete_clips", { ids: [l.id] }); location.hash = "#/clips/lowlights"; }
  };
  const tip = document.createElement("div");
  tip.className = "tooltip"; tip.hidden = true;
  const svg = view.querySelector(".tg");
  if (svg) {
    svg.parentElement.style.position = "relative";
    svg.parentElement.appendChild(tip);
    svg.querySelectorAll(".tg-shot").forEach((g) => {
      g.addEventListener("mouseenter", () => { tip.textContent = g.dataset.tip; tip.hidden = false; });
      g.addEventListener("mousemove", (e) => { const r = svg.parentElement.getBoundingClientRect(); tip.style.left = `${e.clientX - r.left + 12}px`; tip.style.top = `${e.clientY - r.top - 28}px`; });
      g.addEventListener("mouseleave", () => { tip.hidden = true; });
    });
  }
}

// ---- clips: highlights, lowlights, montages ------------------------------------------------------

function renderClips(view, sub) {
  const tabs = [["highlights", "Highlights", (state.index.highlights || []).length], ["lowlights", "Lowlights", (state.index.lowlights || []).length], ["montages", "Montages", null]];
  view.innerHTML = `
    <div class="clips-head">
      <div class="h1">Clips</div>
      <nav class="subtabs">${tabs.map(([k, t, n]) => `<a href="#/clips/${k}" class="${sub === k ? "on" : ""}">${t}${n != null ? ` <span class="sub">${n}</span>` : ""}</a>`).join("")}</nav>
    </div>
    <div id="clips-sound"></div>
    <div id="clips-body"></div>`;
  renderSilentClips(view.querySelector("#clips-sound"));
  const body = view.querySelector("#clips-body");
  if (sub === "lowlights") return renderLowlightsTab(body);
  if (sub === "montages") return renderMontages(body);
  return renderHighlightsTab(body);
}

// Clips recorded without sound (no silent audio device for CS2 then): say so, and record them
// again once there is one.
async function renderSilentClips(el) {
  const n = [...(state.index.highlights || []), ...(state.index.lowlights || [])].filter((c) => c.clip && c.no_audio).length;
  if (!n || !tauri) { el.innerHTML = ""; return; }
  const device = await tauri.core.invoke("silent_audio_device");
  el.innerHTML = `<div class="ml-note silent-note"><span><b>${n} clip${n === 1 ? " was" : "s were"} recorded without sound.</b> ${device
    ? `CS2's sound can be recorded now (through ${esc(device)}).`
    : `This PC has no silent audio device to record CS2's sound through. Install the free <b>VB-CABLE</b> (vb-audio.com/Cable), restart your PC, and record them again here.`}</span>
    ${device ? `<button class="btn primary" id="rerender-silent">Record them again with sound</button>` : ""}</div>`;
  el.querySelector("#rerender-silent")?.addEventListener("click", async (e) => {
    e.target.disabled = true;
    const k = await tauri.core.invoke("rerender_silent_clips");
    e.target.textContent = `${k} clip${k === 1 ? "" : "s"} queued: they're recorded again when CS2 is closed`;
  });
}

// Montages are coming: pick a folder or preset, order the clips, add music and transitions, and
// Veloxify renders one video. For now, this shows what you can build them from.
function renderMontages(view) {
  const folders = state.curation?.folders || [];
  const hl = state.index.highlights || [];
  view.innerHTML = `
    <section class="panel montage-soon">
      <div class="panel-head"><div class="h3">Montages</div><span class="pr-sug">Coming soon</span></div>
      <div class="fc-msg">Turn a folder or a preset into one edited video: order the clips, pick transitions and music, add an intro card, and Veloxify renders it in the background like any other clip.
      Until then, <b>Export for montage</b> on a folder copies its clips, in order, to <code>Videos\\Veloxify</code> for your own editor.</div>
      <div class="montage-sources">
        ${folders.map((f) => `<div class="montage-src"><b>${esc(f.name)}</b><span class="sub">${f.items.length} clip${f.items.length === 1 ? "" : "s"} · folder</span><button class="btn" disabled>Make montage</button></div>`).join("")}
        ${PRESETS.map(([k, label, fn]) => `<div class="montage-src"><b>${esc(label)}</b><span class="sub">${hl.filter(fn).filter(playable).length} clips · preset</span><button class="btn" disabled>Make montage</button></div>`).join("")}
      </div>
    </section>`;
}

// ---- highlights tab ---------------------------------------------------------------------------

const DAY_S = 86400;
const TYPE_FILTERS = [
  ["ace", "ACE", (h) => h.tags.includes("ACE")],
  ["4k", "4K", (h) => h.tags.includes("4K")],
  ["3k", "3K", (h) => h.tags.includes("3K")],
  ["clutch", "Clutch", (h) => h.tags.some((t) => t.endsWith("clutch"))],
  ["flashy", "Flashy", (h) => h.hand % 100 >= 25 || h.tags.some((t) => /noscope|knife|grenade impact|jumping|collateral|ninja/.test(t))],
];
const playable = (h) => !!h.clip;
// Highlight-browser entries carry their match context inline; the player expects this shape.
const toPlayItem = (h) => ({ ...h, name: h.player_name, match: { map: h.map } });

function lastSessionIds() {
  const day = state.days[state.days.length - 1];
  return new Set(day ? day.sessions[day.sessions.length - 1].match_ids : []);
}

function inWhen(h) {
  const now = Date.now() / 1000;
  switch (browser.when) {
    case "session": return lastSessionIds().has(h.match_id);
    case "7d": return h.played_ts >= now - 7 * DAY_S;
    case "30d": return h.played_ts >= now - 30 * DAY_S;
    case "custom": {
      const d = h.played_at.slice(0, 10);
      return (!browser.from || d >= browser.from) && (!browser.to || d <= browser.to);
    }
    default: return true;
  }
}

// Ready-made collections of your best moments by kind.
const PRESETS = [
  ["pistol", "Best pistol rounds", (h) => h.pistol_round],
  ["deag", "One-deags", (h) => h.weapon_class === "deagle" && h.headshots > 0],
  ["awp", "AWP", (h) => h.weapon_class === "awp"],
  ["clutch", "Clutches", (h) => h.clutch_vs > 0],
  ["rifle", "Rifle multi-kills", (h) => h.weapon_class === "rifle" && h.kills >= 2],
  ["entry", "Entries", (h) => h.entry],
];
const sourceLabel = (h) => h.source_label || (h.source === "valve" ? "Premier" : h.source === "faceit" ? "FACEIT" : "Other");
const folderOf = (id) => (state.curation?.folders || []).find((f) => f.id === id);

function filtered() {
  const folder = browser.folder ? folderOf(browser.folder) : null;
  const preset = PRESETS.find((p) => p[0] === browser.preset);
  let list = state.index.highlights.filter((h) =>
    (!folder || folder.items.includes(h.id))
    && inWhen(h) && (browser.source === "all" || sourceLabel(h) === browser.source) && (browser.map === "all" || h.map === browser.map)
    && (!browser.types.length || TYPE_FILTERS.some(([k, , f]) => browser.types.includes(k) && f(h)))
    && (!preset || preset[2](h))
    && browser.tags.every((t) => h.tags.includes(t))
    && (!browser.playableOnly || playable(h))
    && !(browser.hideEco && h.tags.includes(ECO_TAG)));
  const best = (a, b) => b.hand - a.hand || b.score - a.score;
  if (folder) return list.sort((a, b) => folder.items.indexOf(a.id) - folder.items.indexOf(b.id));
  if (browser.preset === "clutch") list.sort((a, b) => b.clutch_vs - a.clutch_vs || best(a, b));
  else if (browser.sort === "best") list.sort(best);
  else if (browser.sort === "newest") list.sort((a, b) => b.played_ts - a.played_ts || best(a, b));
  else list.sort((a, b) => a.played_ts - b.played_ts || a.round - b.round);
  return list;
}

function heroPicks() {
  const now = Date.now() / 1000;
  const since = { week: now - 7 * DAY_S, month: now - 30 * DAY_S, all: 0 }[browser.heroPeriod] ?? 0;
  return state.index.highlights.filter((h) => playable(h) && h.played_ts >= since)
    .sort((a, b) => b.hand - a.hand || b.score - a.score).slice(0, 5);
}

function cardHtml(h, big = false) {
  const when = `${relDay(h.played_at.slice(0, 10))}`;
  return `
    <div class="hl-card ${h.clip ? "" : "pending"} ${big ? "big" : ""}" data-hl="${esc(h.id)}" ${clipAttr(h)}>
      <div class="hl-thumb" style="--map-bg:${mapColor(h.map)};${h.thumb ? `background-image:url('${assetUrl(h.thumb)}')` : ""}">
        ${h.clip ? `<span class="play">▶</span>` : `<span class="state">${h.render_error ? "Demo too old to replay" : "Rendering…"}</span>`}
        <span class="dur">${fmtClip(h.duration_s)}</span>
        <span class="src-chip src ${h.source}">${esc(sourceLabel(h).toUpperCase())}</span>
        ${tauri ? `<button class="card-menu" data-menu="${esc(h.id)}" title="Folders and delete" aria-label="More">⋯</button>` : ""}
      </div>
      <div class="hl-info">
        <div class="hl-title">${esc(h.title)}</div>
        <div class="hl-meta"><span>${esc(mapName(h.map))} · ${h.score_mine}-${h.score_theirs}</span><span>${when}</span></div>
        <div class="tags">${h.tags.map((t) => tagHtml(t)).join("")}</div>
      </div>
    </div>`;
}

// The ⋯ menu on a clip: add to a folder (or a new one), remove from this folder, delete.
function wireCardMenus(view, inFolder) {
  view.querySelectorAll("[data-menu]").forEach((b) => (b.onclick = (e) => {
    e.stopPropagation();
    document.querySelectorAll(".menu-pop").forEach((m) => m.remove());
    const id = b.dataset.menu;
    const folders = state.curation?.folders || [];
    const pop = document.createElement("div");
    pop.className = "menu-pop";
    pop.innerHTML = `
      <div class="menu-h">Add to folder</div>
      ${folders.map((f) => `<button data-add="${esc(f.id)}" ${f.items.includes(id) ? "disabled" : ""}>${esc(f.name)}${f.items.includes(id) ? " ✓" : ""}</button>`).join("")}
      <button data-new>+ New folder…</button>
      ${inFolder ? `<hr><button data-remove>Remove from “${esc(inFolder.name)}”</button>` : ""}
      <hr><button data-delete class="danger">Delete clip…</button>`;
    document.body.appendChild(pop);
    const r = b.getBoundingClientRect();
    pop.style.left = `${Math.min(r.left, window.innerWidth - 240)}px`;
    pop.style.top = `${r.bottom + 4 + window.scrollY}px`;
    pop.onclick = async (ev) => {
      ev.stopPropagation();
      const t = ev.target.closest("button");
      if (!t || t.disabled) return;
      pop.remove();
      if (t.dataset.add) await tauri.core.invoke("edit_folder", { id: t.dataset.add, add: [id] });
      else if (t.hasAttribute("data-new")) {
        const name = prompt("New folder name:");
        if (name && name.trim()) await tauri.core.invoke("create_folder", { name, items: [id] });
      } else if (t.hasAttribute("data-remove")) await tauri.core.invoke("edit_folder", { id: inFolder.id, remove: [id] });
      else if (t.hasAttribute("data-delete")) {
        if (confirm("Delete this clip for good? Its video file is removed and it won't be rendered again.")) await tauri.core.invoke("delete_clips", { ids: [id] });
      }
    };
    setTimeout(() => document.addEventListener("click", () => pop.remove(), { once: true }), 0);
  }));
}

function renderHighlightsTab(view) {
  const hero = heroPicks();
  const list = filtered();
  const maps = [...new Set(state.index.highlights.map((h) => h.map))].sort();
  const sources = [...new Set(state.index.highlights.map(sourceLabel))].sort((a, b) => (a === "FACEIT" ? -1 : b === "FACEIT" ? 1 : a.localeCompare(b)));
  const tagCounts = {};
  for (const h of state.index.highlights) for (const t of h.tags) tagCounts[t] = (tagCounts[t] || 0) + 1;
  const topTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 18).map(([t]) => t);
  for (const t of browser.tags) if (!topTags.includes(t)) topTags.push(t);
  const folders = state.curation?.folders || [];
  const folder = browser.folder ? folderOf(browser.folder) : null;
  const seg = (key, opts) => `<div class="seg" data-key="${key}">${opts.map(([v, label]) =>
    `<button data-v="${v}" class="${browser[key] === v ? "on" : ""}">${label}</button>`).join("")}</div>`;
  const heroLabel = { week: "this week", month: "this month", all: "ever" }[browser.heroPeriod];

  // Group by day when browsing chronologically.
  let grid = "";
  if (browser.sort === "best") {
    grid = `<div class="hl-grid">${list.map((h) => cardHtml(h)).join("")}</div>`;
  } else {
    let day = null;
    for (const h of list) {
      const d = h.played_at.slice(0, 10);
      if (d !== day) {
        grid += `${day ? "</div>" : ""}<div class="day-head">${fmtDate(d)}</div><div class="hl-grid">`;
        day = d;
      }
      grid += cardHtml(h);
    }
    if (day) grid += "</div>";
  }

  // Filters beyond the top bar that are on (they live behind the Filters button).
  const activeFilters = (browser.preset ? 1 : 0) + browser.types.length + browser.tags.length + (browser.hideEco ? 1 : 0) + (browser.playableOnly === BROWSER_DEFAULTS.playableOnly ? 0 : 1);
  view.innerHTML = `
    <section class="hero">
      <div class="hero-head">
        <div><div class="h2">Your best</div><div class="h1">Top highlights ${heroLabel}</div></div>
        ${seg("heroPeriod", [["week", "This week"], ["month", "This month"], ["all", "All time"]])}
      </div>
      ${hero.length ? `<div class="hero-grid">${hero.map((h, i) => cardHtml(h, i === 0)).join("")}</div>`
        : `<div class="empty">No playable highlights ${heroLabel} yet. They appear here as soon as a session is rendered.</div>`}
    </section>
    <section class="panel browser">
      <div class="controls">
        <label>Sort ${seg("sort", [["best", "Best"], ["newest", "Newest"], ["oldest", "Oldest"]])}</label>
        <label>When ${seg("when", [["session", "Last session"], ["7d", "7 days"], ["30d", "30 days"], ["all", "All time"], ["custom", "Dates"]])}</label>
        ${browser.when === "custom" ? `<span class="dates"><input type="date" id="from" value="${browser.from}"> – <input type="date" id="to" value="${browser.to}"></span>` : ""}
        <label>Source <select id="source"><option value="all">All</option>${sources.map((s) => `<option value="${esc(s)}" ${browser.source === s ? "selected" : ""}>${esc(s)}</option>`).join("")}</select></label>
        <label>Map <select id="map"><option value="all">All maps</option>${maps.map((m) => `<option value="${m}" ${browser.map === m ? "selected" : ""}>${esc(mapName(m))}</option>`).join("")}</select></label>
        <button class="btn ghost filters-btn ${browser.filtersOpen ? "on" : ""}" id="filters-btn">Filters${activeFilters ? ` <span class="badge">${activeFilters}</span>` : ""} ${browser.filtersOpen ? "▴" : "▾"}</button>
        <span class="grow"></span>
        <span class="sub">${list.length} highlight${list.length === 1 ? "" : "s"}</span>
        ${activeFilters ? `<button class="btn ghost" id="reset">Reset filters</button>` : ""}
      </div>
      <div class="filters-panel" ${browser.filtersOpen ? "" : "hidden"}>
      <div class="controls folders-bar">
        <span class="h2">Folders</span>
        <button class="chip ${!folder ? "on" : ""}" data-folder="">All highlights</button>
        ${folders.map((f) => `<button class="chip ${folder?.id === f.id ? "on" : ""}" data-folder="${esc(f.id)}">${esc(f.name)} <span class="sub">${f.items.length}</span></button>`).join("")}
        ${tauri ? `<button class="chip" id="new-folder">+ New folder</button>` : ""}
        ${folder && tauri ? `<span class="grow"></span><button class="btn" id="export-folder" title="Copies the clips, in order, to Videos\\Veloxify\\${esc(folder.name)}">Export for montage</button>
          <button class="btn ghost" id="rename-folder">Rename</button><button class="btn ghost" id="delete-folder">Delete folder</button>` : ""}
      </div>
      <div class="controls">
        <span class="h2">Presets</span>
        <div class="chips">${PRESETS.map(([k, label]) => `<button class="chip ${browser.preset === k ? "on" : ""}" data-preset="${k}">${label}</button>`).join("")}</div>
      </div>
      <div class="controls">
        <div class="chips">${TYPE_FILTERS.map(([k, label]) => `<button class="chip ${browser.types.includes(k) ? "on" : ""}" data-type="${k}">${label}</button>`).join("")}</div>
        <label class="check"><input type="checkbox" id="playable" ${browser.playableOnly ? "checked" : ""}> Playable only</label>
        <label class="check" title="Hide highlights where most of the kills were on players who'd saved (under $2,000 of equipment)"><input type="checkbox" id="hide-eco" ${browser.hideEco ? "checked" : ""}> Hide vs eco</label>
      </div>
      <div class="controls">
        <span class="h2">Tags</span>
        <div class="chips">${topTags.map((t) => `<button class="chip ${browser.tags.includes(t) ? "on" : ""}" data-tag="${esc(t)}">${esc(t)}</button>`).join("")}</div>
      </div>
      </div>
      <div class="browser-body">${list.length ? grid : `<div class="empty">Nothing matches these filters.</div>`}</div>
    </section>`;

  const rerender = () => { saveBrowser(); renderHighlightsTab(view); };
  view.querySelector("#filters-btn").onclick = () => { browser.filtersOpen = !browser.filtersOpen; rerender(); };
  view.querySelectorAll(".seg").forEach((el) => el.querySelectorAll("button").forEach((b) => (b.onclick = () => { browser[el.dataset.key] = b.dataset.v; rerender(); })));
  view.querySelectorAll("[data-type]").forEach((b) => (b.onclick = () => {
    const k = b.dataset.type;
    browser.types = browser.types.includes(k) ? browser.types.filter((x) => x !== k) : [...browser.types, k];
    rerender();
  }));
  view.querySelector("#map").onchange = (e) => { browser.map = e.target.value; rerender(); };
  view.querySelector("#source").onchange = (e) => { browser.source = e.target.value; rerender(); };
  view.querySelectorAll("[data-preset]").forEach((b) => (b.onclick = () => { browser.preset = browser.preset === b.dataset.preset ? "" : b.dataset.preset; rerender(); }));
  view.querySelectorAll("[data-tag]").forEach((b) => (b.onclick = () => {
    const t = b.dataset.tag;
    browser.tags = browser.tags.includes(t) ? browser.tags.filter((x) => x !== t) : [...browser.tags, t];
    rerender();
  }));
  view.querySelectorAll("[data-folder]").forEach((b) => (b.onclick = () => { browser.folder = b.dataset.folder; rerender(); }));
  const nf = view.querySelector("#new-folder");
  if (nf) nf.onclick = async () => {
    const name = prompt("Folder name (e.g. Best moments, ESEA S60 montage):");
    if (name && name.trim()) { browser.folder = await tauri.core.invoke("create_folder", { name, items: [] }); saveBrowser(); }
  };
  const ex = view.querySelector("#export-folder");
  if (ex) ex.onclick = async () => {
    ex.disabled = true;
    try { const [, n] = await tauri.core.invoke("export_folder", { id: folder.id }); ex.textContent = `Exported ${n} clip${n === 1 ? "" : "s"}`; }
    catch (err) { ex.textContent = `Export failed: ${err}`; }
  };
  const rn = view.querySelector("#rename-folder");
  if (rn) rn.onclick = () => { const name = prompt("Rename folder:", folder.name); if (name && name.trim()) tauri.core.invoke("edit_folder", { id: folder.id, name }); };
  const df = view.querySelector("#delete-folder");
  if (df) df.onclick = () => {
    if (confirm(`Delete the folder "${folder.name}"? The clips stay in your library.`)) { browser.folder = ""; saveBrowser(); tauri.core.invoke("edit_folder", { id: folder.id, delete: true }); }
  };
  wireCardMenus(view, folder);
  view.querySelector("#playable").onchange = (e) => { browser.playableOnly = e.target.checked; rerender(); };
  view.querySelector("#hide-eco").onchange = (e) => { browser.hideEco = e.target.checked; rerender(); };
  view.querySelector("#reset")?.addEventListener("click", () => { browser = { ...BROWSER_DEFAULTS, heroPeriod: browser.heroPeriod, folder: browser.folder, filtersOpen: browser.filtersOpen }; rerender(); });
  for (const id of ["from", "to"]) {
    const el = view.querySelector(`#${id}`);
    if (el) el.onchange = (e) => { browser[id] = e.target.value; rerender(); };
  }
  // Clicking a hero card plays the hero reel; clicking in the browser plays the filtered list.
  view.querySelectorAll(".hero [data-hl]").forEach((c) => (c.onclick = () => {
    state.playlist = hero.map(toPlayItem);
    play(state.playlist.findIndex((h) => h.id === c.dataset.hl));
  }));
  view.querySelectorAll(".browser [data-hl]").forEach((c) => (c.onclick = () => {
    state.playlist = list.filter(playable).map(toPlayItem);
    const i = state.playlist.findIndex((h) => h.id === c.dataset.hl);
    if (i >= 0) play(i);
  }));
}

// ---- settings -----------------------------------------------------------------------------------

// Theme presets (colors mirror styles.css; used for the swatches) and the saved choice.
const THEMES = [
  { id: "faceit", name: "Dark", bg: "#0f0f0f", card: "#1c1c1c", accent: "#1ea7e1" },
  { id: "purple", name: "Purple", bg: "#121019", card: "#211d2e", accent: "#8b5cf6" },
  { id: "csgo", name: "CS:GO classic", bg: "#16191c", card: "#252a2f", accent: "#e9a93a" },
  { id: "cs2", name: "CS2 slate", bg: "#12161b", card: "#222a33", accent: "#7fb2e8" },
  { id: "oled", name: "Pure black", bg: "#000000", card: "#121212", accent: "#1ea7e1" },
];
// Dark text on light accents, white on dark ones.
function onAccent(hex) {
  const n = parseInt(hex.slice(1), 16), c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.04 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] > 0.3 ? "#04121a" : "#ffffff";
}
function loadTheme() {
  try { return { preset: "faceit", accent: "", ...JSON.parse(localStorage.getItem("veloxify.theme") || "{}") }; } catch (e) { return { preset: "faceit", accent: "" }; }
}
function applyTheme(t) {
  const el = document.documentElement;
  if (t.preset && t.preset !== "faceit") el.dataset.theme = t.preset; else delete el.dataset.theme;
  if (t.accent) {
    el.style.setProperty("--accent", t.accent);
    el.style.setProperty("--on-accent", onAccent(t.accent));
  } else {
    el.style.removeProperty("--accent");
    el.style.removeProperty("--on-accent");
  }
  try { localStorage.setItem("veloxify.theme", JSON.stringify(t)); } catch (e) { /* applies for this session only */ }
}

function appearancePanel() {
  const t = loadTheme();
  const preset = THEMES.find((x) => x.id === t.preset) || THEMES[0];
  return `
      <section class="panel">
        <div class="panel-head"><div class="h3">Appearance</div></div>
        <div class="themes">${THEMES.map((x) => `
          <button class="theme ${x.id === preset.id ? "on" : ""}" data-theme-id="${x.id}">
            <span class="sw" style="background:${x.bg}"><i style="background:${x.card}"></i><i style="background:${x.accent}"></i></span>
            <b>${x.name}</b>
          </button>`).join("")}
        </div>
        <div class="set-row"><div class="lbl"><b>Accent color</b><span>Active tabs, buttons, dials and charts. ${t.accent ? "Custom" : `The ${esc(preset.name)} default`}.</span></div>
          <input type="color" id="accent-pick" value="${t.accent || preset.accent}">
          <button class="btn ghost" id="accent-reset" ${t.accent ? "" : "disabled"}>Reset</button></div>
      </section>`;
}

function wireAppearance(view) {
  view.querySelectorAll("[data-theme-id]").forEach((b) => (b.onclick = () => {
    applyTheme({ ...loadTheme(), preset: b.dataset.themeId });
    renderSettings(view);
  }));
  const pick = view.querySelector("#accent-pick");
  pick.oninput = () => applyTheme({ ...loadTheme(), accent: pick.value }); // live while dragging
  pick.onchange = () => renderSettings(view);
  view.querySelector("#accent-reset").onclick = () => { applyTheme({ ...loadTheme(), accent: "" }); renderSettings(view); };
}

let settingsData = null;
const PREVIEW_SETTINGS = {
  settings: { watch_dirs: ["C:\\Users\\you\\Downloads"], auto_render: true, auto_lowlights: true, faceit_enabled: true, faceit_nickname: "", selectivity: "solid-plays", max_per_match: 6, start_with_windows: false, steamid64: null },
  detected_steamid: null, steam_name: null, version: "preview", clips: 0, clip_bytes: 0,
  render: { height: 1080, fps: 60, transition: "cut", killfeed_only: true, own_crosshair: false, xray: false, audio: true },
};
const fmtBytes = (b) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);

function faceitAccountRow() {
  const f = state.faceit;
  const right = tauri ? `<button class="btn" id="faceit-refresh">Refresh</button>` : "";
  if (!f) return `<div class="set-row"><div class="lbl"><b>FACEIT</b><span>Looking up the account linked to your Steam account…</span></div>${right}</div>`;
  if (!f.player_id) return `<div class="set-row"><div class="lbl"><b>FACEIT</b><span>No FACEIT account is linked to this Steam account. Enter your FACEIT nickname below if you use a different one.</span></div>${right}</div>`;
  const when = f.fetched_at ? new Date(f.fetched_at * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
  return `<div class="set-row">${f.avatar ? `<img class="fc-avatar" src="${esc(f.avatar)}" alt="">` : ""}${levelBadge(f.level, 32)}
    <div class="lbl"><b>${esc(f.nickname)} · ${f.elo.toLocaleString("en-US")} ELO</b><span>Found from your Steam account${when ? ` · updated ${when}` : ""}</span></div>${right}</div>`;
}

// Veloxify's Ko-fi page ("https://ko-fi.com/<name>"): the Support button shows once it's set.
const KOFI_URL = "https://ko-fi.com/jdwede";
const KOFI_CUP = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M4 6h13a4 4 0 0 1 0 8h-1.1A6 6 0 0 1 10 19H9a5 5 0 0 1-5-5V6zm12 2v4h1a2 2 0 0 0 0-4h-1z"/><path fill="#ff5e5b" d="M10.1 9.2c.7-.8 2-.7 2.5.2.5.8.1 1.7-.6 2.4L10 13.6 8 11.8c-.7-.7-1.1-1.6-.6-2.4.5-.9 1.8-1 2.5-.2z"/></svg>`;

async function renderSettings(view) {
  document.querySelector('[data-nav="settings"]').classList.add("active");
  settingsData = tauri ? await tauri.core.invoke("get_settings") : JSON.parse(JSON.stringify(PREVIEW_SETTINGS));
  await loadCrosshairs();
  const s = settingsData.settings, r = settingsData.render;
  const steamid = settingsData.detected_steamid; // text: a number this big would be rounded
  const sw = (key, on) => `<label class="switch"><input type="checkbox" data-key="${key}" ${on ? "checked" : ""} ${tauri ? "" : "disabled"}><i></i></label>`;
  const seg = (key, val, opts) => `<div class="seg" data-key="${key}">${opts.map(([v, l]) => `<button data-v="${v}" class="${String(val) === String(v) ? "on" : ""}" ${tauri ? "" : "disabled"}>${l}</button>`).join("")}</div>`;
  const row = (title, desc, control) => `<div class="set-row"><div class="lbl"><b>${title}</b>${desc ? `<span>${desc}</span>` : ""}</div>${control}</div>`;
  const folders = s.watch_dirs.map((d, i) => `<div class="folder"><code title="${esc(d)}">${esc(d)}</code>${tauri ? `<button class="btn ghost" data-remove="${i}">Remove</button>` : ""}</div>`).join("")
    || `<div class="folder sub">No extra folders. Demos from Get demos are found automatically; add a folder here only if you keep other demos somewhere (e.g. Downloads).</div>`;
  view.innerHTML = `
    <div class="profile-head"><div><div class="h2">Veloxify ${esc(settingsData.version)}</div><div class="h1">Settings</div></div><span class="saved" id="saved">Saved</span>
      ${KOFI_URL ? `<button class="kofi" id="kofi" title="Veloxify is free. If it helps you, you can buy me a coffee.">${KOFI_CUP}Support Veloxify on Ko-fi</button>` : ""}</div>
    ${tauri ? "" : `<div class="preview-note">Preview: settings can be changed in the desktop app.</div>`}
    <div class="settings">
      <section class="panel">
        <div class="panel-head"><div class="h3">Accounts</div></div>
        ${row("Steam", steamid ? `${esc(settingsData.steam_name || "Logged-in account")} · ${steamid}` : "Log in to Steam so Veloxify knows whose highlights to make.", "")}
        <div id="faceit-account">${faceitAccountRow()}</div>
        ${row("Use FACEIT data", "Level, ELO and your full FACEIT match list, found from your Steam account. No login or API key.", sw("faceit_enabled", s.faceit_enabled))}
        ${row("FACEIT demos", "Get demos downloads every missing demo in one click through Veloxify's own FACEIT window. If FACEIT ever asks you to sign in, do it once there: it's a separate browser profile, so your Chrome and FACEIT client stay signed in, and Veloxify never sees your password. FACEIT's human check runs normally; once in a while it may ask you to tick a box.", tauri ? `<button class="btn" id="faceit-sign-in">Sign in to FACEIT</button>` : "")}
        ${row("Premier matches", "After you close CS2, Veloxify asks Valve for your recent matches through your Steam and downloads the new Premier and Competitive demos, so you don't have to download them in CS2's Watch tab. While it asks (a few seconds), Steam shows you in CS2.", sw("premier_auto", s.premier_auto ?? true))}
        ${row("FACEIT nickname", "Only needed if your account isn't found automatically.", `<input type="text" data-key="faceit_nickname" value="${esc(s.faceit_nickname)}" placeholder="Found automatically" ${tauri ? "" : "disabled"}>`)}
      </section>
      ${appearancePanel()}
      <section class="panel">
        <div class="panel-head"><div class="h3">Highlights</div></div>
        ${row("Make highlights automatically", "After you close CS2, new demos are read and your best moments rendered in the background.", sw("auto_render", s.auto_render))}
        ${row("Wait after you play", "Veloxify doesn't start CS2 to film (or check Valve for Premier matches) until this long after CS2 was last open, so it never gets in the way between games. Your new matches still show up right away. Film now in the status skips the wait.",
          seg("film_wait_min", s.film_wait_min ?? 60, [[0, "Don't wait"], [30, "30 min"], [60, "1 hour"], [120, "2 hours"]]))}
        ${row("Capture lowlights too", "After the highlights, your 3 worst deaths from each match of the latest session are rendered too, for the whiff analyzer. Others render when you press Watch.", sw("auto_lowlights", s.auto_lowlights ?? true))}
        ${row("Film grenade lineups", `After your clips, Veloxify films the lineups from your demos for the Lineups page (the thrower's view, then the grenade until it goes off): the ones thrown ${LINEUP_AUTO_MIN} or more times, most thrown first. It makes way whenever new matches or clips need filming. Any other lineup films when you open it and press “Film this lineup now”.`, sw("auto_lineups", s.auto_lineups ?? true))}
        ${row("Which moments", "Best only: 3K+, aces, clutches and other always-moments. Solid plays adds 2Ks that mattered and reaction flicks. Everything adds plain 2Ks.",
          seg("selectivity", s.selectivity, [["highlights-only", "Best only"], ["solid-plays", "Solid plays"], ["everything", "Everything"]]))}
        ${row("Clips per match", "The most clips kept from one match; the best ones win.", `<input type="number" data-key="max_per_match" min="1" max="20" value="${s.max_per_match}" ${tauri ? "" : "disabled"}>`)}
      </section>
      <section class="panel">
        <div class="panel-head"><div class="h3">Clip look</div><span class="grow"></span><span class="sub">For clips rendered from now on</span></div>
        ${row("Resolution", "", seg("height", r.height, [[720, "720p"], [1080, "1080p"], [1440, "1440p"]]))}
        ${row("Frame rate", "", seg("fps", r.fps, [[30, "30 fps"], [60, "60 fps"]]))}
        ${row("Between parts", "How the parts of one highlight are joined.", seg("transition", r.transition, [["cut", "Cut"], ["fade", "Fade"]]))}
        ${row("HUD", "Kill feed only is the clean Allstar look.", seg("killfeed_only", r.killfeed_only, [[true, "Kill feed only"], [false, "Full HUD"]]))}
        ${row("Crosshair", `A clean small cross, each player's own, or one you picked on the <a class="link" href="#/crosshairs">Crosshairs</a> page.${r.crosshair && !r.own_crosshair ? `<span class="xh-inline" data-xh="${esc(r.crosshair)}">${xhSvg(xhOf(r.crosshair), 30)}</span>` : ""}`,
          seg("xh_mode", r.own_crosshair ? "own" : r.crosshair ? "picked" : "default", [["default", "Clean default"], ["own", "Player's own"], ...(r.crosshair ? [["picked", "Picked"]] : [])]))}
        ${row("X-ray", "Show players through walls.", sw("xray", r.xray))}
        ${row("Game audio", `CS2's sound only, never Discord or music. <span id="audio-device"></span>`, sw("audio", r.audio))}
      </section>
      <section class="panel">
        <div class="panel-head"><div class="h3">Demo folders</div><span class="grow"></span>${tauri ? `<button class="btn" id="add-folder">Add folder</button>` : ""}</div>
        <div class="sub" style="padding:0 20px 8px">New demos in these folders are imported automatically.</div>
        ${folders}
        <div class="panel-head" style="border-top:1px solid var(--line);margin-top:12px"><div class="h3">App</div></div>
        ${row("Library", "Clips, match data and saved demos.", tauri ? `<button class="btn" id="open-lib">Open folder</button>` : "")}
        <div id="storage"></div>
        ${row("Start with Windows", "Starts in the tray, ready to process your games. It never runs anything while CS2 is open.", sw("start_with_windows", s.start_with_windows))}
        ${row("Debug log", "Something not working? This saves a text file on your Desktop with what Veloxify did recently: its version, where it found Steam and CS2, and any errors. Send it to whoever is helping you. It has your Steam ID and match IDs, never passwords or cookies.", `<button class="btn" id="debug-log">Save debug log</button>`)}
      </section>
    </div>`;
  view.querySelector("#kofi")?.addEventListener("click", () => (tauri ? tauri.core.invoke("open_link", { url: KOFI_URL }) : window.open(KOFI_URL, "_blank")));
  wireAppearance(view); // works in the preview too (saved in this browser)
  if (!tauri) return;

  const RENDER_KEYS = ["height", "fps", "transition", "killfeed_only", "own_crosshair", "xray", "audio"];
  const set = (key, value) => {
    if (key === "xh_mode") {
      settingsData.render.own_crosshair = value === "own";
      if (value === "default") settingsData.render.crosshair = "";
      saveSettings();
      return;
    }
    if (["height", "fps", "max_per_match", "film_wait_min"].includes(key)) value = Number(value);
    if (["killfeed_only", "own_crosshair"].includes(key) && typeof value === "string") value = value === "true";
    (RENDER_KEYS.includes(key) ? settingsData.render : settingsData.settings)[key] = value;
    saveSettings();
  };
  view.querySelectorAll(".switch input").forEach((i) => (i.onchange = () => set(i.dataset.key, i.checked)));
  view.querySelectorAll(".seg[data-key]").forEach((el) => el.querySelectorAll("button").forEach((b) => (b.onclick = () => {
    el.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    set(el.dataset.key, b.dataset.v);
  })));
  view.querySelectorAll("input[type=text], input[type=number]").forEach((i) => (i.onchange = () => set(i.dataset.key, i.value)));
  view.querySelectorAll("[data-remove]").forEach((b) => (b.onclick = () => {
    settingsData.settings.watch_dirs.splice(Number(b.dataset.remove), 1);
    saveSettings().then(() => renderSettings(view));
  }));
  view.querySelector("#add-folder").onclick = async () => {
    const dir = await tauri.core.invoke("pick_folder");
    if (dir && !settingsData.settings.watch_dirs.includes(dir)) {
      settingsData.settings.watch_dirs.push(dir);
      await saveSettings();
      renderSettings(view);
    }
  };
  view.querySelector("#open-lib").onclick = () => tauri.core.invoke("open_library");
  view.querySelector("#faceit-sign-in").onclick = () => tauri.core.invoke("faceit_sign_in");
  view.querySelector("#debug-log").onclick = async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    b.textContent = "Saving…";
    try {
      await tauri.core.invoke("save_debug_log");
      b.textContent = "Saved to your Desktop";
    } catch (err) {
      b.textContent = "Couldn't save it";
      b.title = String(err);
    }
    setTimeout(() => { b.disabled = false; b.textContent = "Save debug log"; }, 4000);
  };
  renderStorage(view.querySelector("#storage"));
  tauri.core.invoke("silent_audio_device").then((d) => {
    const el = view.querySelector("#audio-device");
    if (el) el.innerHTML = d ? `Recorded through ${esc(d)}, so you don't hear it.` : `<b class="down">No silent audio device on this PC, so clips have no sound.</b> Install the free VB-CABLE (vb-audio.com/Cable) and restart your PC.`;
  });
  wireFaceitRefresh();
}

// How much space each kind of file takes, and the limits that keep it in check.
async function renderStorage(el) {
  const u = await tauri.core.invoke("storage_usage");
  const s = settingsData.settings;
  const total = u.highlight_bytes + u.lowlight_bytes + u.demo_bytes + u.data_bytes || 1;
  const parts = [["Highlight clips", u.highlight_bytes, u.highlight_clips, "var(--accent)"], ["Lowlight clips", u.lowlight_bytes, u.lowlight_clips, "#c084fc"],
    ["Demos", u.demo_bytes, u.demos, "var(--t)"], ["Match data", u.data_bytes, null, "#8a8f98"]];
  el.innerHTML = `
    <div class="set-row" style="display:block">
      <div class="lbl"><b>Storage · ${fmtBytes(total)}</b></div>
      <div class="why-bar" style="margin:10px 0">${parts.map(([, b, , c]) => (b ? `<i style="width:${(100 * b) / total}%;background:${c}"></i>` : "")).join("")}</div>
      <div class="why-legend" style="padding:0">${parts.map(([l, b, n, c]) => `<span><i style="background:${c}"></i>${l}: <b>${fmtBytes(b)}</b>${n != null ? ` · ${n}` : ""}</span>`).join("")}</div>
    </div>
    <div class="set-row"><div class="lbl"><b>Limit for clips</b><span>Over the limit, the oldest clips go first; clips in a folder are never removed. Removed clips can be rendered again. 0 = no limit.</span></div>
      <input type="number" min="0" step="1" data-key="max_clips_gb" value="${s.max_clips_gb || 0}"> GB</div>
    <div class="set-row"><div class="lbl"><b>Limit for demos</b><span>Demo files Veloxify has already imported (e.g. in Downloads); the oldest go first, never one from the last day. Other files are never touched. Without its demo, a match's clips can't be rendered again. 0 = no limit.</span></div>
      <input type="number" min="0" step="1" data-key="max_demos_gb" value="${s.max_demos_gb || 0}"> GB</div>
    <div class="set-row"><div class="lbl"><b>Clean up now</b><span>Applies the limits right away (also happens automatically after each session).</span></div>
      <button class="btn" id="cleanup">Clean up</button></div>`;
  el.querySelectorAll("input[type=number]").forEach((i) => (i.onchange = () => { settingsData.settings[i.dataset.key] = Number(i.value) || 0; saveSettings(); }));
  el.querySelector("#cleanup").onclick = async (e) => {
    const [c, d] = await tauri.core.invoke("clean_up_storage");
    e.target.textContent = c + d ? `Removed ${c} clip${c === 1 ? "" : "s"}, ${d} demo${d === 1 ? "" : "s"}` : "Already under the limits";
    renderStorage(el);
  };
}

function wireFaceitRefresh() {
  const b = document.getElementById("faceit-refresh");
  if (b) b.onclick = () => { b.disabled = true; b.textContent = "Refreshing…"; tauri.core.invoke("refresh_faceit"); };
}

async function saveSettings() {
  const s = settingsData.settings;
  const update = {
    watch_dirs: s.watch_dirs, auto_render: s.auto_render, auto_lowlights: s.auto_lowlights ?? true, auto_lineups: s.auto_lineups ?? true, premier_auto: s.premier_auto ?? true, film_wait_min: Number(s.film_wait_min ?? 60), faceit_enabled: s.faceit_enabled, faceit_nickname: s.faceit_nickname,
    selectivity: s.selectivity, max_per_match: Number(s.max_per_match) || 6, start_with_windows: s.start_with_windows,
    max_clips_gb: Number(s.max_clips_gb) || 0, max_demos_gb: Number(s.max_demos_gb) || 0, render: settingsData.render,
  };
  const saved = document.getElementById("saved");
  try {
    await tauri.core.invoke("save_settings", { update });
    if (saved) { saved.textContent = "Saved"; saved.style.color = ""; }
  } catch (e) {
    if (saved) { saved.textContent = `Not saved: ${e}`; saved.style.color = "var(--loss)"; }
  }
  if (saved) { saved.classList.add("on"); clearTimeout(saved._t); saved._t = setTimeout(() => saved.classList.remove("on"), 1800); }
}

// ---- wiring -------------------------------------------------------------------------------------

document.getElementById("player-close").onclick = closePlayer;
// Theater mode, remembered between clips (and sessions, where storage is available).
const setTheater = (on) => {
  document.getElementById("player").classList.toggle("theater", on);
  try { localStorage.setItem("veloxify.theater", on ? "1" : "0"); } catch (e) { /* storage unavailable */ }
};
try { setTheater(localStorage.getItem("veloxify.theater") === "1"); } catch (e) { /* default view */ }
document.getElementById("player-theater").onclick = () => setTheater(!document.getElementById("player").classList.contains("theater"));
document.getElementById("player").addEventListener("click", (e) => { if (e.target.id === "player") closePlayer(); });
document.getElementById("player-prev").onclick = () => play(state.playing - 1);
document.getElementById("player-next").onclick = () => play(state.playing + 1);
document.getElementById("player-video").addEventListener("ended", () => play(state.playing + 1));
document.getElementById("player-folder").onclick = () => tauri?.core.invoke("show_in_folder", { rel: state.playlist[state.playing]?.clip });
// Copy for Discord: a copy under your upload limit with the Veloxify mark, on the clipboard. While
// Veloxify films, a second click pauses the filming for it (it carries on after).
{
  const size = document.getElementById("player-discord-size");
  try { size.value = localStorage.getItem("veloxify.discordMb") || "20"; } catch (e) { /* default */ }
  size.onchange = () => { try { localStorage.setItem("veloxify.discordMb", size.value); } catch (e) { /* not saved */ } };
  let pauseOk = 0;
  const label = "Copy for Discord";
  document.getElementById("player-discord").onclick = async (e) => {
    const btn = e.currentTarget, rel = state.playlist[state.playing]?.clip;
    if (!tauri || !rel || btn.disabled) return;
    const make = () => tauri.core.invoke("copy_for_discord", { rel, limitMb: Number(size.value) || 20 });
    let paused = false;
    btn.disabled = true;
    btn.textContent = "Making the Discord copy…";
    try {
      let r;
      try {
        r = await make();
      } catch (err) {
        if (String(err) !== "filming" || Date.now() > pauseOk) throw err;
        btn.textContent = "Pausing the filming…";
        await tauri.core.invoke("stop_rendering");
        paused = true;
        for (let i = 0; i < 90 && (await tauri.core.invoke("get_status")).state === "rendering"; i++) await new Promise((res) => setTimeout(res, 1000));
        btn.textContent = "Making the Discord copy…";
        r = await make();
      }
      btn.textContent = `Copied: ${r.mb.toFixed(1)} MB, ${r.height}p. Paste it in Discord (Ctrl+V)`;
      setTimeout(() => (btn.textContent = label), 6000);
    } catch (err) {
      const m = String(err);
      if (m === "filming") {
        pauseOk = Date.now() + 8000;
        btn.textContent = "Veloxify is filming. Click again to pause it and copy";
        setTimeout(() => { if (Date.now() >= pauseOk) btn.textContent = label; }, 8200);
      } else {
        btn.textContent = m === "playing" ? "Not while you're playing CS2" : "Couldn't make the copy";
        if (m !== "playing") console.error(err);
        setTimeout(() => (btn.textContent = label), 4000);
      }
    } finally {
      if (paused) tauri.core.invoke("resume_filming");
      btn.disabled = false;
    }
  };
}
document.getElementById("player-copy").onclick = async (e) => {
  const btn = e.currentTarget;
  try {
    await tauri?.core.invoke("copy_file", { rel: state.playlist[state.playing]?.clip });
    btn.textContent = "Copied";
  } catch (err) {
    btn.textContent = "Copy failed";
  }
  setTimeout(() => (btn.textContent = "Copy file"), 1500);
};

// ---- live status and library updates from the background worker --------------------------------

const CAPTURE_WHAT = { highlights: "Highlight", lowlights: "Lowlight", clips: "Clip", lineups: "Grenade lineup" };

function showStatus(st) {
  const el = document.getElementById("status");
  if (!st) return;
  const busy = st.state === "importing" || st.state === "rendering";
  el.classList.toggle("busy", busy);
  el.textContent = st.state === "rendering" && st.total ? `${CAPTURE_WHAT[st.kind] || "Clip"}s ${Math.min(st.done + 1, st.total)} of ${st.total}`
    : st.state === "importing" && st.total ? `Reading matches ${st.done + 1}/${st.total}`
    : st.state === "waiting" ? "Playing · clips after CS2 closes"
    : st.state === "error" ? "Needs attention" : "Up to date";
  el.title = st.message || "";
  // While CS2 is busy rendering, the status doubles as a stop button; while filming waits after
  // you played, as a "film now" button.
  const waitTill = st.state === "idle" && st.wait_until > Date.now() / 1000 ? new Date(st.wait_until * 1000) : null;
  if (waitTill) {
    el.textContent = `Films at ${waitTill.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · Film now`;
    el.title = "Veloxify waits a while after you play before it starts CS2 to film (you may only be between games). Click to film now. The wait is in Settings.";
  }
  el.classList.toggle("stoppable", st.state === "rendering");
  el.classList.toggle("filmable", !!waitTill);
  el.onclick = st.state === "rendering" ? () => tauri?.core.invoke("stop_rendering") : waitTill ? () => { tauri?.core.invoke("film_now"); el.textContent = "Filming soon"; } : null;
  if (st.state === "rendering") el.title = `CS2 is filming ${(CAPTURE_WHAT[st.kind] || "clip").toLowerCase()}s in the background. Click to stop and hand CS2 back.`;
}

const demoRunActive = () => !!(live.queue?.items?.length && !live.queue.finished && !live.queue.cancelled);

// Match rows while Get demos runs: a ring that fills as the current demo downloads (spinning
// while FACEIT gets it ready), a clock for the ones still to come, a check once downloaded, a
// cross if FACEIT no longer has it. Repainted on every queue update and whenever a page renders.
const RING_C = 2 * Math.PI * 9;
const DL_TITLES = {
  now: "Downloading",
  paused: "Paused while CS2 is open",
  queued: "Waiting to download",
  done: "Downloaded: analyzed once the rest are in",
  failed: "FACEIT doesn't have this demo any more",
};
function demoRowState(room) {
  const q = live.queue;
  if (!q?.items?.length || q.cancelled) return "";
  const i = q.items.findIndex((it) => it.match_id === room);
  if (i < 0) return "";
  if ((q.skipped || []).includes(room)) return "failed";
  if (i < q.pos) return "done";
  if (q.finished) return "";
  return i === q.pos ? (q.paused ? "paused" : "now") : "queued";
}
function paintDemoRows() {
  const q = live.queue;
  document.querySelectorAll('.ml-row[data-room] [data-act="demo"]').forEach((btn) => {
    const s = demoRowState(btn.closest(".ml-row").dataset.room);
    if (btn.dataset.dl !== s) {
      btn.dataset.dl = s;
      btn.className = `sqbtn${s ? ` dl-${s}` : ""}`;
      btn.innerHTML = s === "now" || s === "paused"
        ? `<svg class="dl-ring" viewBox="0 0 24 24" aria-hidden="true"><circle class="track" cx="12" cy="12" r="9"/><circle class="fill" cx="12" cy="12" r="9" stroke-dasharray="${RING_C.toFixed(2)}" stroke-dashoffset="${RING_C.toFixed(2)}"/></svg>`
        : s === "queued" ? ICONS.clock : s === "done" ? ICONS.check : s === "failed" ? ICONS.cross : ICONS.download;
    }
    btn.title = DL_TITLES[s] || (demoRunActive() ? "Get demos is already running" : "Get the demo");
    if (s === "now" || s === "paused") {
      const frac = Math.max(0, Math.min(1, q.progress || 0));
      // Before the download starts (opening the match, FACEIT's check): a spinning quarter ring.
      btn.classList.toggle("spin", s === "now" && frac === 0);
      btn.querySelector(".fill").style.strokeDashoffset = (RING_C * (1 - (frac > 0 ? frac : 0.25))).toFixed(2);
      if (s === "now" && frac > 0) btn.title = `Downloading: ${Math.round(frac * 100)}%`;
    }
  });
}

// The big banner under the top bar: what Veloxify is doing right now (downloading demos, then
// analyzing them, then capturing clips) with progress, or what needs you.
const live = { queue: null, status: null };
let bannerKey = "";
// Filming time: how long this batch has run, and about how long is left (from how fast the clips
// done so far went; about 40 s a clip until the first is done).
function filmTime(st) {
  if (!st?.since) return "";
  const el = Math.max(0, Date.now() / 1000 - st.since);
  const clock = (s) => (s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:` : `${Math.floor(s / 60)}:`) + String(Math.floor(s % 60)).padStart(2, "0");
  let left = "";
  if (st.total) {
    const per = st.done >= 1 ? el / st.done : 40;
    const rest = Math.max(0, per * (st.total - st.done) - (st.done >= 1 ? 0 : el));
    left = rest >= 30 ? ` · about ${rest < 90 ? "1 minute" : rest < 3600 ? `${Math.round(rest / 60)} minutes` : `${(rest / 3600).toFixed(1)} hours`} left` : st.done < st.total ? " · almost done" : "";
  }
  return `${clock(el)} elapsed${left}`;
}
let filmTicker = null;

function renderBanner() {
  const el = document.getElementById("banner");
  if (!el) return;
  // While filming, the elapsed time ticks every second.
  if (live.status?.state === "rendering" && live.status?.since) {
    if (!filmTicker) filmTicker = setInterval(renderBanner, 1000);
  } else if (filmTicker) {
    clearInterval(filmTicker);
    filmTicker = null;
  }
  const q = live.queue, st = live.status;
  const total = q?.items?.length || 0;
  let b = null;
  if (total && !q.finished && !q.cancelled) {
    b = {
      kind: q.message ? "warn" : q.paused ? "paused" : "busy",
      title: q.paused ? "Demo downloads paused" : "Downloading demos",
      count: `${Math.min(q.pos, total)}/${total}`,
      frac: (q.pos + (q.paused ? 0 : q.progress || 0)) / total,
      note: q.message || (q.paused ? "CS2 is open. Downloads continue when you close it." : ""),
      actions: [
        ...(q.message ? [["Show FACEIT window", () => tauri.core.invoke("faceit_sign_in")]] : []),
        ["Cancel", () => tauri.core.invoke("demo_queue", { action: "cancel" })],
      ],
    };
  } else if (st?.state === "details" && st.total) {
    const hl = (st.message || "").startsWith("Updating highlights");
    b = { kind: "busy", title: hl ? "Updating your highlights" : "Re-reading your matches", count: `${Math.min(st.done + 1, st.total)}/${st.total}`, frac: st.done / st.total,
      note: hl ? "An update changed what makes a highlight (one taps, kills after the round ended), so each match is looked at once more (only while CS2 is closed). Clips that changed are filmed again." : "An update added new stats, so each match's demo is read once more (about 5 seconds each, only while CS2 is closed).", actions: [] };
  } else if (st?.state === "importing" && st.total) {
    b = { kind: "busy", title: "Analyzing matches", count: `${Math.min(st.done + 1, st.total)}/${st.total}`, frac: st.done / st.total, actions: [] };
  } else if (st?.state === "rendering") {
    const what = CAPTURE_WHAT[st.kind] || "Clip";
    // "Filming Set Smoke #4": what's being recorded right now.
    const now = /^Filming \D/.test(st.message || "") ? st.message.slice("Filming ".length) : "";
    b = {
      kind: "rec",
      title: st.total ? `${what} capture in progress` : `Starting ${what.toLowerCase()} capture`,
      count: st.total ? `${Math.min(st.done + 1, st.total)}/${st.total}` : "",
      frac: st.total ? st.done / st.total : 0,
      note: [filmTime(st), now && `Now filming: ${now}`, st.kind === "lineups" && st.more ? `Most thrown first, ${st.total} at a time · ${st.more} more after this batch` : ""].filter(Boolean).join(" · "),
      actions: [["Stop", () => tauri.core.invoke("stop_rendering")]],
    };
  } else if (st?.state === "error") {
    b = { kind: "warn", title: "Needs attention", count: "", frac: null, note: st.message, actions: [] };
  }
  if (!b) { el.hidden = true; bannerKey = ""; syncStickyTop(); return; }
  el.hidden = false;
  el.className = `banner ${b.kind} ${bannerMin() ? "min" : ""}`;
  // Built once per kind of banner; progress updates in place (so buttons aren't swapped mid-click).
  const key = b.kind + b.actions.map((a) => a[0]).join();
  if (key !== bannerKey) {
    bannerKey = key;
    el.innerHTML = `<div class="banner-in">
      <div class="banner-main"><div class="banner-top"><span class="banner-dot"></span><b class="banner-title"></b><span class="banner-count"></span><div class="banner-bar"><i></i></div></div>
        <div class="banner-note"></div></div>
      ${b.kind === "rec" ? `<img class="banner-preview" alt="What CS2 is recording" hidden>` : ""}${b.actions.map((a, i) => `<button class="banner-btn" data-i="${i}">${esc(a[0])}</button>`).join("")}<button class="banner-btn banner-size" aria-label="Minimize or restore the banner"></button></div>`;
  }
  el.querySelectorAll(".banner-btn[data-i]").forEach((btn) => (btn.onclick = b.actions[btn.dataset.i][1]));
  const size = el.querySelector(".banner-size");
  // A caret: up to make the banner small, down to bring it back.
  size.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${bannerMin() ? "M6 9l6 6 6-6" : "M6 15l6-6 6 6"}"/></svg>`;
  size.title = bannerMin() ? "Show the full banner" : "Make the banner smaller";
  size.onclick = () => {
    try { localStorage.setItem("veloxify.bannerMin", bannerMin() ? "0" : "1"); } catch (e) { /* not remembered */ }
    renderBanner();
  };
  el.querySelector(".banner-title").textContent = b.title;
  el.querySelector(".banner-count").textContent = b.count;
  const bar = el.querySelector(".banner-bar");
  bar.hidden = b.frac == null;
  bar.firstElementChild.style.width = `${Math.max(0, Math.min(1, b.frac || 0)) * 100}%`;
  const note = el.querySelector(".banner-note");
  note.textContent = b.note || "";
  note.hidden = !b.note;
  syncStickyTop();
  livePreview(b.kind === "rec" ? el.querySelector(".banner-preview") : null);
}

// While CS2 records, the banner shows a small live picture of it (the capture refreshes the
// file about once a second).
let captureTimer = null, captureUrl = null;
function livePreview(img) {
  if (!img || !tauri) {
    clearInterval(captureTimer);
    captureTimer = null;
    return;
  }
  if (captureTimer) return;
  const tick = async () => {
    const pic = document.querySelector(".banner-preview");
    if (!pic) return;
    try {
      const r = await fetch(assetUrl("capture_preview.bmp"), { cache: "no-store" });
      if (!r.ok) throw new Error(String(r.status));
      const url = URL.createObjectURL(await r.blob());
      pic.onload = () => { if (captureUrl) URL.revokeObjectURL(captureUrl); captureUrl = url; };
      pic.src = url;
      pic.hidden = false;
    } catch (e) { pic.hidden = true; }
  };
  tick();
  captureTimer = setInterval(tick, 1000);
}

// The banner can be made small (one line: title, count, a thin bar and Stop); remembered.
function bannerMin() {
  try { return localStorage.getItem("veloxify.bannerMin") === "1"; } catch (e) { return false; }
}

// Sticky rows (the League standings' own team) sit under the top bar and the status banner.
// A map and its controls fully on screen: the map as big as the space below it allows (it's square),
// and when that's too little, the page scrolls it up under the header first. Again on resize.
let fitMapListener = null;
function fitMapToScreen(stage, controls) {
  if (fitMapListener) window.removeEventListener("resize", fitMapListener);
  if (!stage) return;
  const fit = (scroll) => {
    if (!document.body.contains(stage)) { window.removeEventListener("resize", fitMapListener); fitMapListener = null; return; }
    const header = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--sticky-top")) || 60;
    const below = (controls?.offsetHeight || 0) + 20;
    let top = stage.getBoundingClientRect().top;
    if (scroll && window.innerHeight - top - below < 480) {
      window.scrollBy({ top: top - header - 8 });
      top = header + 8;
    }
    stage.style.maxWidth = `${Math.round(Math.max(320, Math.min(900, window.innerHeight - Math.max(top, header + 8) - below)))}px`;
  };
  fitMapListener = () => fit(false);
  window.addEventListener("resize", fitMapListener);
  setTimeout(() => fit(true), 30);
}

function syncStickyTop() {
  const el = document.getElementById("banner");
  const h = el && !el.hidden ? el.offsetHeight : 0;
  document.documentElement.style.setProperty("--sticky-top", `${60 + h}px`);
}

if (tauri) {
  const setQueue = (q) => { live.queue = q; renderBanner(); paintDemoRows(); };
  // Pages re-render their rows: paint them again (paintDemoRows only touches what changed).
  let paintQueued = false;
  new MutationObserver(() => {
    if (paintQueued) return;
    paintQueued = true;
    requestAnimationFrame(() => { paintQueued = false; paintDemoRows(); fillAvatars(document.getElementById("view")); });
  }).observe(document.getElementById("view"), { childList: true, subtree: true });
  const setStatus = (st) => { live.status = st; showStatus(st); renderBanner(); };
  tauri.core.invoke("demo_queue_state").then(setQueue);
  tauri.event.listen("veloxify://demos", (e) => setQueue(e.payload));
  tauri.core.invoke("get_status").then(setStatus);
  tauri.event.listen("veloxify://status", (e) => setStatus(e.payload));
  let pendingReload = false;
  const reload = () => {
    // Don't disturb a playing clip, and don't spend anything on a window that's in the tray.
    if (!document.getElementById("player").hidden || document.hidden) { pendingReload = true; return; }
    if (location.hash.startsWith("#/settings")) {
      // Only the FACEIT account box changes here; re-rendering would drop what's being typed.
      loadIndex().then(() => {
        const box = document.getElementById("faceit-account");
        if (box) { box.innerHTML = faceitAccountRow(); wireFaceitRefresh(); }
      });
      return;
    }
    state.index = null;
    state.matches.clear();
    state.details.clear();
    state.benchmarks = undefined;
    state.myStats = undefined;
    route();
  };
  tauri.event.listen("veloxify://library", reload);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && pendingReload && document.getElementById("player").hidden) { pendingReload = false; reload(); }
  });
  document.getElementById("player-close").addEventListener("click", () => { if (pendingReload) { pendingReload = false; reload(); } });
}
document.addEventListener("keydown", (e) => {
  if (document.getElementById("player").hidden) return;
  if (e.key === "Escape") closePlayer();
  if (e.key === "t" || e.key === "T") setTheater(!document.getElementById("player").classList.contains("theater"));
  if (e.key === "ArrowRight" && e.shiftKey) play(state.playing + 1);
  if (e.key === "ArrowLeft" && e.shiftKey) play(state.playing - 1);
});
window.addEventListener("hashchange", route);
route();
