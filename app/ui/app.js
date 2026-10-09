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

const SESSION_GAP_S = 3 * 3600; // same as the backend's session grouping
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
      elo: fm.elo ?? null, elo_delta: fm.elo_delta ?? null, line: { kills: fm.kills, assists: fm.assists, deaths: fm.deaths, adr: fm.adr }, faceit: fm,
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
  kd: [1.3, 1.1, 0.9, 0.75], adr: [95, 82, 70, 60], kast: [80, 73, 66, 58],
  // Round Swing, % per round: 0 is neutral (it's zero-sum).
  swing: [1.5, 0.5, -0.5, -1.5],
};
const GRADE_COLORS = ["#2fd36f", "#9ddb8c", "var(--text)", "#f3a5a0", "#ff5252"];
const gradeOf = (kind, v) => GRADES[kind].filter((t) => v < t).length;
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
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  cross: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8z"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 19h14"/></svg>',
  external: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
  rating: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 12l4-4" stroke-linecap="round"/></svg>',
};
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
  if (parts[0] === "league") {
    document.querySelector('[data-nav="league"]').classList.add("active");
    return renderLeague(view);
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
const nameCell = (p, roster) =>
  `${p.party ? `<span class="mp-party" title="In your party">${ICONS.party}</span>` : ""}${avatarHtml(p.steamid)}${rankHtml(p, roster)}<span class="mp-pname">${esc(p.name)}</span>`;

// ---- match page (Leetify-style): header, scoreboard and the match's sections ------------------

const matchHref = (id, tab) => `#/match/${encodeURIComponent(id)}${tab ? `/${tab}` : ""}`;
const MATCH_SORTS = {
  name: (p) => p.name.toLowerCase(), kills: (p) => p.counts.kills, assists: (p) => p.counts.assists, deaths: (p) => p.counts.deaths,
  kd: (p) => p.derived.kd, adr: (p) => p.derived.adr, kast: (p) => p.derived.kast,
  k2: (p) => p.counts.multikill_rounds[2], k3: (p) => p.counts.multikill_rounds[3], k4: (p) => p.counts.multikill_rounds[4], k5: (p) => p.counts.multikill_rounds[5],
  rws: (p) => p.derived.rws, swing: (p) => p.derived.swing || 0, rating: (p) => r3(p.derived), kr: (p) => p.derived.kpr,
};
const matchSort = { key: "rating", desc: true };

async function renderMatchPage(view, id, tab) {
  const s = summaryOf(id);
  if (!s) { view.innerHTML = `<a class="day-back" href="#/matches">◀ Match history</a><div class="empty">Match not found.</div>`; return; }
  const m = s.stats_only ? null : await loadMatch(id);
  if (m) m._roster = await loadRoster(m);
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
  body.innerHTML = `<div id="mp-summary"></div><div id="mp-board"></div>`;
  renderMatchScoreboard(body.querySelector("#mp-board"), m);
  await renderMatchSummary(body.querySelector("#mp-summary"), m, id);
}

// The scoreboard's columns in their default order; drag a header to reorder (saved).
const BOARD_COLS = [["rating", "HLTV 3.0"], ["rws", "RWS"], ["swing", "Swing"], ["kills", "Kills"], ["assists", "Assists"], ["deaths", "Deaths"], ["kd", "K/D"],
  ["adr", "ADR"], ["kr", "K/R"], ["kast", "KAST"], ["k2", "2K"], ["k3", "3K"], ["k4", "4K"], ["k5", "5K"]];
function boardCols() {
  let saved = [];
  try { saved = JSON.parse(localStorage.getItem("veloxify.boardCols") || "[]"); } catch (e) { /* default order */ }
  const known = new Map(BOARD_COLS);
  const order = saved.filter((k) => known.has(k));
  // Columns added since the order was saved go where they are by default.
  BOARD_COLS.forEach(([k], i) => { if (!order.includes(k)) order.splice(Math.min(i, order.length), 0, k); });
  return order.map((k) => [k, known.get(k)]);
}

// Both teams, Leetify's match-details columns (no Leetify rating), sortable by any column.
function renderMatchScoreboard(body, m) {
  const me = state.index.me;
  const COLS = boardCols();
  const by = MATCH_SORTS[matchSort.key];
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
      case "kr": return `<td>${f2(d.kpr)}</td>`;
      case "kast": return `<td class="${gradeClass("kast", d.kast)}">${Math.round(d.kast)}%</td>`;
      case "rws": return `<td class="${gradeClass("rws", d.rws)}">${f1(d.rws)}</td>`;
      case "swing": return `<td class="${gradeClass("swing", d.swing || 0)}" title="Round Swing: average change in the team's chance to win each round (HLTV Rating 3.0)">${fmtSwing(d.swing || 0)}</td>`;
      case "rating": return `<td><span class="mp-rating ${ratingClass(r3(d))}">${f2(r3(d))}</span></td>`;
      default: return `<td class="${c.multikill_rounds[Number(k[1])] ? "" : "zero"}">${c.multikill_rounds[Number(k[1])]}</td>`;
    }
  };
  const head = (title, won) => `<tr class="mp-team"><th class="mp-name">${title} <span class="mp-badge ${won ? "win" : "loss"}">${won ? "WIN" : m.result === "tie" ? "TIE" : "LOSS"}</span></th>
    ${COLS.map(([k, t]) => `<th data-sort="${k}" draggable="true" title="Click to sort, drag to move" class="${matchSort.key === k ? "on" : ""}">${t}${matchSort.key === k ? (matchSort.desc ? " ↓" : " ↑") : ""}</th>`).join("")}</tr>`;
  const row = (p, won) => `<tr class="${won ? "won" : "lost"} ${p.steamid === me ? "me" : ""}">
    <td class="mp-name">${nameCell(p, m._roster)}</td>
    ${COLS.map(([k]) => cell(p, k)).join("")}</tr>`;
  const mineWon = m.result === "win", theirsWon = m.result === "loss";
  body.innerHTML = `
    <div class="mp-board-wrap"><table class="mp-board">
      <thead>${head("My Team", mineWon)}</thead>
      <tbody>${sorted("mine").map((p) => row(p, mineWon)).join("")}</tbody>
      <thead>${head("Enemy Team", theirsWon)}</thead>
      <tbody>${sorted("enemy").map((p) => row(p, theirsWon)).join("")}</tbody>
    </table></div>
    <div class="note">Kills, assists and deaths come from CS2's end-of-match scoreboard. HLTV 3.0 is estimated from the demo. Click a column to sort, drag it to move it (your order is saved; <a class="link" href="#" id="mp-cols-reset">reset</a>).</div>`;
  body.querySelectorAll("th[data-sort]").forEach((th) => {
    th.onclick = () => {
      const k = th.dataset.sort;
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
      const order = COLS.map(([k]) => k).filter((k) => k !== from);
      order.splice(order.indexOf(to) + (COLS.findIndex(([k]) => k === from) < COLS.findIndex(([k]) => k === to) ? 1 : 0), 0, from);
      try { localStorage.setItem("veloxify.boardCols", JSON.stringify(order)); } catch (err) { /* not saved */ }
      renderMatchScoreboard(body, m);
    };
  });
  body.querySelector("#mp-cols-reset").onclick = (e) => { e.preventDefault(); try { localStorage.removeItem("veloxify.boardCols"); } catch (err) { /* nothing saved */ } renderMatchScoreboard(body, m); };
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
const QUALITY_KEYS = ["flash_assist_pct", "enemies_per_flash", "friends_per_flash", "blind_time", "he_damage_avg", "he_team_damage_avg"];
const aimRating = (s) => ratingFrom(AIM_RATING_KEYS, s);
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
  const row = (r, won) => `<tr class="${won ? "won" : "lost"} ${r.p.steamid === me ? "me" : ""}">
    <td class="mp-name">${nameCell(r.p, m._roster)}</td>
    ${cols.map((c) => c.cell(r, ctx[c.key])).join("")}</tr>`;
  const mineWon = m.result === "win", theirsWon = m.result === "loss", tie = m.result === "tie";
  body.innerHTML = `<div class="mp-board-wrap"><table class="mp-board">
      <thead>${head("My Team", mineWon, tie)}</thead><tbody>${sorted("mine").map((r) => row(r, mineWon)).join("")}</tbody>
      <thead>${head("Enemy Team", theirsWon, tie)}</thead><tbody>${sorted("enemy").map((r) => row(r, theirsWon)).join("")}</tbody>
    </table></div>`;
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
  { key: "aim_rating", label: "Aim Rating", tip: "Your aim stats against every player in your library (50 = average). Accuracy (All) isn't counted.",
    value: (r) => aimRating(r.s), cell: (r) => `<td>${ratingChip(aimRating(r.s))}</td>` },
  { key: "spotted_accuracy", label: "Spotted Accuracy", tip: "When you were firing at a spotted enemy, how many of those shots hit. All hits divided by all shots at the spotted enemy.", value: (r) => r.s.spotted_accuracy, cell: statCell("spotted_accuracy", pct0) },
  { key: "ttd_ms", label: "Time to Damage", lower: true, tip: "Average time from seeing an enemy to first damaging them. Waits over 1 s (holding an angle) are excluded. Not reaction time: it includes accuracy, crosshair placement and fire rate.", value: (r) => r.s.ttd_ms, cell: statCell("ttd_ms", ms0) },
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
  const teams = { mine: m.players.filter((p) => p.side === "mine"), enemy: m.players.filter((p) => p.side === "enemy") };
  const avg = (ps, f) => (ps.length ? ps.reduce((a, p) => a + f(p), 0) / ps.length : 0);
  const total = (ps, f) => ps.reduce((a, p) => a + f(p), 0);
  const cmp = (label, a, b, fmt = (x) => x) => `<div class="hs-row"><span>${label}</span><b class="${a > b ? "up" : a < b ? "down" : ""}">${fmt(a)}</b><i>:</i><b class="${b > a ? "up" : b < a ? "down" : ""}">${fmt(b)}</b></div>`;
  const awp = new Map();
  for (const k of d?.kills || []) if (k.weapon === "awp" && !k.team_kill) awp.set(k.attacker, (awp.get(k.attacker) || 0) + 1);
  const leader = (label, f, fmt = (x) => x) => {
    const p = [...m.players].sort((a, b) => f(b) - f(a))[0];
    if (!p || !(f(p) > 0)) return "";
    return `<div class="hs-leader ${p.side}"><div><b>${esc(p.name)}</b><span>${label}</span></div><em>${fmt(f(p))}</em></div>`;
  };
  const players = [...m.players].sort((a, b) => r3(b.derived) - r3(a.derived));
  const top = Math.max(1.5, ...players.map((p) => r3(p.derived) + 0.1));
  // The match's best highlight (rendered ones first) next to the rating chart, the rest below it.
  const names = new Map(m.players.map((p) => [p.steamid, p.name]));
  const hls = [...(m.highlights || [])].sort((a, b) => !!b.clip - !!a.clip || (b.tier || 0) - (a.tier || 0) || (b.hand || 0) - (a.hand || 0));
  const best = hls[0];
  const thumb = (h) => (h.thumb ? `background-image:url('${assetUrl(h.thumb)}')` : "");
  const hlPanel = best ? `
      <section class="hs-hl">
        <div class="hs-perf-head"><div class="h3">Highlights</div>${hls.length > 1 ? `<a class="link" href="${matchHref(id, "highlights")}">All ${hls.length}</a>` : ""}</div>
        <div class="hs-hl-body ${hls.length > 1 ? "" : "solo"}">
          <div class="hl-card hs-hl-main ${best.clip ? "" : "pending"}" data-hl="${esc(best.id)}" ${clipAttr(best)}>
            <div class="hl-thumb" style="--map-bg:${mapColor(m.map)};${thumb(best)}">
              ${best.clip ? `<span class="play">▶</span>` : `<span class="state">${best.render_error ? esc(best.render_error) : "Rendering…"}</span>`}
              <span class="dur">${fmtClip(best.duration_s)}</span></div>
            <div class="hl-info"><div class="hl-title">${esc(best.title)}</div>
              <div class="hl-meta"><span>${esc(names.get(best.player) || "")}</span><span>round ${best.round}</span></div>
              <div class="tags">${best.tags.map((t) => tagHtml(t)).join("")}</div></div>
          </div>
          ${hls.length > 1 ? `<div class="hs-hl-side">${hls.slice(1, 4).map((h) => `
            <div class="hl-card hs-hl-mini ${h.clip ? "" : "pending"}" data-hl="${esc(h.id)}" ${clipAttr(h)} title="${esc(h.title)}">
              <div class="hl-thumb" style="--map-bg:${mapColor(m.map)};${thumb(h)}">${h.clip ? `<span class="play">▶</span>` : `<span class="state">Rendering…</span>`}<span class="dur">${fmtClip(h.duration_s)}</span></div>
              <div class="hs-hl-t">${esc(h.title)}</div>
            </div>`).join("")}</div>` : ""}
        </div>
      </section>` : `
      <section class="hs-hl empty-hl"><div class="h3">Highlights</div><div class="empty small">No highlights this match.</div></section>`;
  const x = (v) => `${(v / top) * 100}%`;
  el.innerHTML = `
    <div class="hs-wrap">
      <section class="hs-card">
        <div class="hs-teams"><div><b>My Team</b><em class="${m.result === "win" ? "up" : "down"}">${m.score_mine}</em></div>
          <div class="hs-map">${mapIcon(m.map)}<span>${esc(mapName(m.map))}</span></div>
          <div><b>Enemy Team</b><em class="${m.result === "loss" ? "up" : "down"}">${m.score_theirs}</em></div></div>
        ${cmp("Team rating 3.0", avg(teams.mine, (p) => r3(p.derived)), avg(teams.enemy, (p) => r3(p.derived)), f2)}
        ${cmp("First kills", total(teams.mine, (p) => p.counts.opening_kills), total(teams.enemy, (p) => p.counts.opening_kills))}
        ${cmp("Clutches won", total(teams.mine, (p) => sum(p.counts.clutches_won)), total(teams.enemy, (p) => sum(p.counts.clutches_won)))}
      </section>
      <section class="hs-leaders">
        ${leader("Most kills", (p) => p.counts.kills)}
        ${leader("Most damage", (p) => p.derived.adr, f1)}
        ${leader("Most assists", (p) => p.counts.assists)}
        ${d ? leader("Most AWP kills", (p) => awp.get(p.steamid) || 0) : ""}
        ${leader("Most first kills", (p) => p.counts.opening_kills)}
        ${leader("Best rating 3.0", (p) => r3(p.derived), f2)}
      </section>
    </div>
    <div class="hs-split">
    <section class="hs-perf">
      <div class="hs-perf-head"><div class="h3">Performance · Rating 3.0</div>
        <span class="legend"><i class="mine"></i>My Team <i class="enemy"></i>Enemy Team</span></div>
      <div class="hs-chart">
        <div class="hs-bands"><i class="bad" style="width:${x(0.85)}"></i><i class="avg" style="left:${x(0.85)};width:${(0.3 / top) * 100}%"></i><i class="good" style="left:${x(1.15)};right:0"></i></div>
        ${players.map((p) => `<div class="hs-bar-row ${p.side}" title="${esc(p.name)}: ${f2(r3(p.derived))}"><span>${esc(p.name)}</span>
          <div class="hs-track"><i style="width:${x(r3(p.derived))}"></i><b style="left:${x(r3(p.derived))}">${f2(r3(p.derived))}</b></div></div>`).join("")}
        <div class="hs-axis"><span></span><div>${[0, 0.4, 0.85, 1.15, top].map((v) => `<em style="left:${x(v)}">${f2(v)}</em>`).join("")}</div></div>
        <div class="hs-axis words"><span></span><div><em style="left:${x(0.42)}">Bad</em><em style="left:${x(1.0)}">Average</em><em style="left:${x((1.15 + top) / 2)}">Good</em></div></div>
      </div>
    </section>
    ${hlPanel}
    </div>`;
  // Play from the match's rendered clips.
  state.playlist = hls.filter((h) => h.clip).map((h) => ({ ...h, name: names.get(h.player), match: m }));
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
  { id: "aim", name: "Aim", parts: { spotted_accuracy: 15, ttd_ms: 15, crosshair_deg: 15, head_accuracy: 10, first_bullet: 10, spray_accuracy: 10, ttk_ms: 10, counter_strafe: 10, hs_kill_pct: 5 } },
  { id: "movement", name: "Movement", parts: { counter_strafe: 40, accurate_movement: 30, air_shot_pct: 20, air_accuracy: 10 } },
  { id: "utility", name: "Utility", parts: { nades_per_round: 20, flash_assist_pct: 15, enemies_per_flash: 15, he_damage_avg: 15, blind_time: 10, friends_per_flash: 10, unused_utility: 10, he_team_damage_avg: 5 } },
  { id: "impact", name: "Impact", parts: { swing: 30, adr: 20, entry_success: 15, multikill_pr: 15, kast: 10, clutch_wins: 10 } },
];
let customRatings = DEFAULT_RATINGS;
try { customRatings = JSON.parse(localStorage.getItem("veloxify.ratings") || "null") || DEFAULT_RATINGS; } catch (e) { /* defaults */ }
const saveRatings = () => { try { localStorage.setItem("veloxify.ratings", JSON.stringify(customRatings)); } catch (e) { /* not saved */ } };

// A custom rating for one set of stats: the weighted average standard score, as 0-100 (50 = the
// average player in your library). Needs at least half the weight to have data.
function customRating(r, stats) {
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
  const rerender = () => { saveRatings(); renderRatingBuilder(view, editingRating); };
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
  if (!d) return noDetails(body);
  if (!d.throws) { body.innerHTML = `<div class="empty">Lineups need this match analyzed again; Veloxify does that in the background while CS2 is closed.</div>`; return; }
  if (lineups.matchId !== id) Object.assign(lineups, { matchId: id, sel: null, player: "", zoom: 1, pan: [0, 0] });
  const names = new Map(m.players.map((p) => [p.steamid, p.name]));
  const team = new Map(m.players.map((p) => [p.steamid, p.side]));
  const callout = calloutFinder(d);
  const all = d.throws.filter((t) => (!lineups.setOnly || t.set));
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
      <label class="check"><input type="checkbox" id="ln-set" ${lineups.setOnly ? "checked" : ""}> Set lineups only</label>
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
            : lid && tauri ? `<div class="gn-novideo"><b>No video yet</b><span>Lineups are filmed in the background, most thrown first.</span><button class="btn primary" id="ln-film" data-lid="${esc(lid)}">Film this lineup now</button></div>` : ""; })()}
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

// FACEIT ELO after each recent match, oldest to newest, with hover details.
function eloChart(list) {
  const pts = list.filter((m) => m.elo).slice().reverse();
  if (pts.length < 2) return "";
  const w = 600, h = 110, padL = 38, padR = 8, top = 10, bottom = 18;
  const lo = Math.min(...pts.map((p) => p.elo)), hi = Math.max(...pts.map((p) => p.elo));
  const span = Math.max(40, hi - lo), y0 = lo - span * 0.1, y1 = hi + span * 0.1;
  const x = (i) => padL + (i * (w - padL - padR)) / (pts.length - 1);
  const y = (e) => top + ((y1 - e) * (h - top - bottom)) / (y1 - y0);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.elo).toFixed(1)}`).join(" ");
  const area = `${line} L${x(pts.length - 1).toFixed(1)},${h - bottom} L${x(0).toFixed(1)},${h - bottom} Z`;
  const dots = pts.map((p, i) => `<circle class="pt" cx="${x(i).toFixed(1)}" cy="${y(p.elo).toFixed(1)}" r="3.5" stroke="${p.result === "win" ? WIN : LOSS}"/>`).join("");
  const data = pts.map((p, i) => ({ x: x(i), y: y(p.elo), tip: `${mapName(p.map)} · ${new Date((p.started_ts || p.finished_ts) * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short" })} · ${p.result === "win" ? "W" : "L"} ${p.score_mine}-${p.score_theirs} · ${p.elo.toLocaleString("en-US")}${p.elo_delta != null ? ` (${p.elo_delta >= 0 ? "+" : ""}${p.elo_delta})` : ""}` }));
  return `
    <div class="elo-chart" data-points='${esc(JSON.stringify(data))}' data-w="${w}">
      <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="FACEIT ELO over recent matches">
        <defs><linearGradient id="eloFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" style="stop-color:var(--accent)" stop-opacity="0.28"/><stop offset="1" style="stop-color:var(--accent)" stop-opacity="0"/></linearGradient></defs>
        <text x="0" y="${y(hi) + 4}" class="axis">${hi.toLocaleString("en-US")}</text>
        <text x="0" y="${y(lo) + 4}" class="axis">${lo.toLocaleString("en-US")}</text>
        <path class="area" d="${area}"/><path class="line" d="${line}"/>
        <line class="cross" x1="0" x2="0" y1="${top}" y2="${h - bottom}" visibility="hidden"/>
        ${dots}
      </svg>
      <div class="tooltip" hidden></div>
    </div>`;
}

function wireEloChart(root) {
  const el = root.querySelector(".elo-chart");
  if (!el) return;
  const pts = JSON.parse(el.dataset.points), w = Number(el.dataset.w);
  const svg = el.querySelector("svg"), cross = el.querySelector(".cross"), tip = el.querySelector(".tooltip");
  svg.addEventListener("mousemove", (e) => {
    const r = svg.getBoundingClientRect(), vx = ((e.clientX - r.left) / r.width) * w;
    const p = pts.reduce((a, b) => (Math.abs(b.x - vx) < Math.abs(a.x - vx) ? b : a));
    cross.setAttribute("x1", p.x); cross.setAttribute("x2", p.x); cross.setAttribute("visibility", "visible");
    tip.textContent = p.tip; tip.hidden = false;
    const left = (p.x / w) * r.width + (r.left - el.getBoundingClientRect().left);
    tip.style.left = `${Math.min(left + 12, el.clientWidth - tip.offsetWidth - 4)}px`;
    tip.style.top = "0px";
  });
  svg.addEventListener("mouseleave", () => { cross.setAttribute("visibility", "hidden"); tip.hidden = true; });
}

function faceitPanel() {
  const f = state.faceit;
  const head = (extra = "") => `<div class="panel-head"><div class="h3">FACEIT</div><span class="grow"></span>${extra}</div>`;
  if (!f) return `${head()}<div class="fc-msg">Looking up your FACEIT account. Veloxify finds it from your Steam account; there's nothing to connect.</div>`;
  if (!f.player_id) {
    return `${head()}<div class="fc-msg">No FACEIT account is linked to this Steam account. If you play FACEIT on a different account, add its nickname in <a class="link" href="#/settings">Settings</a>.</div>`;
  }
  const recent = f.matches.slice(0, 30);
  const firstUnrated = recent.findIndex((m) => !m.elo);
  const rated = firstUnrated < 0 ? recent : recent.slice(0, firstUnrated);
  const change = sum(rated.map((m) => m.elo_delta || 0));
  const wins = recent.filter((m) => m.result === "win").length;
  const k = sum(recent.map((m) => m.kills)), dth = sum(recent.map((m) => m.deaths)), hs = sum(recent.map((m) => m.headshots));
  const adr = recent.length ? sum(recent.map((m) => m.adr)) / recent.length : 0;
  const L = f.lifetime || {};
  return `
    ${head(`<span class="sub">Last ${recent.length} matches</span>`)}
    <div class="fc-summary">
      ${f.avatar ? `<img class="fc-avatar" src="${esc(f.avatar)}" alt="">` : ""}
      ${levelBadge(f.level, 46)}
      <div class="who"><span class="elo">${f.elo.toLocaleString("en-US")}</span><span class="sub">${esc(f.nickname)}${f.region ? ` · ${esc(f.region)}` : ""}</span></div>
      <span class="grow"></span>
      <div style="text-align:right"><div class="sub">Elo change${rated.length < recent.length ? `, last ${rated.length}` : ""}</div><div class="h3 ${change >= 0 ? "up" : "down"}">${change >= 0 ? "+" : ""}${change}</div></div>
      <div style="text-align:right"><div class="sub">Record</div><div class="h3"><span class="up">${wins}</span> / <span class="down">${recent.length - wins}</span></div></div>
    </div>
    ${eloChart(rated)}
    <div class="fc-stats">
      <div class="kpi"><div class="v">${dth ? f2(k / dth) : "–"}</div><div class="l">K/D</div></div>
      <div class="kpi"><div class="v">${f1(adr)}</div><div class="l">ADR</div></div>
      <div class="kpi"><div class="v">${k ? Math.round((hs / k) * 100) : 0}%</div><div class="l">HS%</div></div>
      <div class="kpi"><div class="v">${recent.length ? Math.round((wins / recent.length) * 100) : 0}%</div><div class="l">Win rate</div></div>
      <div class="kpi"><div class="v">${(L.matches || 0).toLocaleString("en-US")}</div><div class="l">Lifetime matches</div></div>
      <div class="kpi"><div class="v">${Math.round(L.win_rate || 0)}%</div><div class="l">Lifetime win rate</div></div>
    </div>`;
}

function renderProfile(view) {
  const ps = state.index.profiles || [];
  const p = ps.find((x) => x.last === prof.last && x.source === prof.source) || ps.find((x) => x.source === prof.source) || ps[0];
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
        ${seg("source", [["all", "All"], ["faceit", "FACEIT"], ["valve", "Premier"]])}</div>
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
      <section class="panel faceit">${faceitPanel()}</section>
      <div style="display:grid;gap:20px;align-content:start">
      <section class="panel premier-panel">
        <div class="panel-head"><div class="h3">Premier</div><span class="grow"></span>
          ${premier ? `<span class="sub">as of ${parseLocal(premier[1]).toLocaleDateString("en-GB", { month: "short", year: "numeric" })}</span>` : ""}</div>
        <div class="fc-summary big-chip">${premier ? premierChip(premier[0]) : `<span class="sub">No Premier demo yet. Your rating shows here after your next Premier match.</span>`}</div>
      </section>
      <section class="panel tiles">
        ${[["K/D", f2(d.kd)], ["ADR", f1(d.adr)], ["KAST", `${f1(d.kast)}%`], ["HS%", `${Math.round(d.hs_pct)}%`],
          ["Swing / round", fmtSwing(d.swing || 0)], ["Accuracy", `${f1(d.accuracy)}%`], ["Entries", `${c.opening_kills}-${c.opening_deaths}`],
          ["Multi-kills", `${c.multikill_rounds.slice(2).reduce((a, b) => a + b, 0)}`]].map(([l, v]) =>
          `<div class="kpi"><div class="v">${v}</div><div class="l">${l}</div></div>`).join("")}
      </section>
      </div>
    </div>
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
  wireEloChart(view);
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
const CATEGORY_NAMES = { instant: "Instant", set: "Set", fly: "On the move" };
const grenades = { kinds: new Set(["smoke", "molotov", "flash", "he"]), category: "all", side: "all", min: 2, sel: null, zoom: 1, pan: [0, 0], map: null };
const placeName2 = (s) => (s || "").replace(/([a-z])([A-Z])/g, "$1 $2").replace("Bombsite", "Site ");
const lineupClip = (id) => state.lineupClips?.[id];
// A lineup's thumbnail: its video's frame (plays on hover) or a placeholder.
function lineupThumb(l, cls = "") {
  const c = lineupClip(l.id);
  if (c?.clip) return `<div class="hl-card gn-thumb ${cls}" data-clip="${esc(c.clip)}" data-lineup="${esc(l.id)}"><div class="hl-thumb" style="${c.thumb ? `background-image:url('${assetUrl(c.thumb)}')` : ""}"><span class="play">▶</span></div></div>`;
  return `<div class="gn-thumb none ${cls}" title="${c?.error ? esc(c.error) : "No video yet"}"><span>${c?.error ? "No demo" : "No video yet"}</span></div>`;
}

async function renderGrenades(view, map) {
  const L = await loadLineups();
  if (!L || !Object.keys(L.maps || {}).length) {
    view.innerHTML = `<div class="empty">No grenade lineups yet. They're collected from your match demos as Veloxify analyzes them.</div>`;
    return;
  }
  if (map && L.maps[map]) {
    const d = await loadMapLineups(map);
    if (d) return renderGrenadeMap(view, d, map);
  }
  // Every map: its picture, how many lineups of each grenade, videos ready.
  const maps = Object.entries(L.maps).map(([m, d]) => ({ m, d, total: Object.values(d.counts).reduce((a, b) => a + b, 0) })).sort((a, b) => b.total - a.total);
  const videosOn = (m) => Object.entries(state.lineupClips || {}).filter(([id, c]) => id.startsWith(`${m}-`) && c.clip).length;
  view.innerHTML = `
    <div class="gn-head"><div><div class="h1">Grenades</div><div class="sub">Every lineup thrown in your demos, grouped when it's the same one, most used first. Pick a map.</div></div></div>
    <div class="gn-maps">${maps.map(({ m, d, total }) => {
      const videos = videosOn(m);
      return `<a class="gn-map" href="#/grenades/${esc(m)}">
        <div class="gn-map-pic" style="background-image:url('${assetUrl(`mapshots/${m}.png`)}')"><div class="gn-map-name">${mapIcon(m)}<b>${esc(mapName(m))}</b></div></div>
        <div class="gn-map-counts">${NADE_KINDS.map(([k, , icon]) => `<span title="${esc(k)} lineups">${weaponIcon(icon)}<b>${d.counts[k] || 0}</b></span>`).join("")}</div>
        <div class="gn-map-foot"><span>${total} lineups</span><span>${d.throws} throws · ${d.matches} matches</span><span>${videos} videos</span></div></a>`;
    }).join("")}</div>`;
}

function renderGrenadeMap(view, d, map) {
  if (grenades.map !== map) Object.assign(grenades, { map, sel: null, zoom: 1, pan: [0, 0] });
  const shown = d.lineups.filter((l) => grenades.kinds.has(l.kind) && (grenades.category === "all" ? l.category !== "fly" : l.category === grenades.category)
    && (grenades.side === "all" || l.side === grenades.side) && l.count >= grenades.min);
  const sel = shown.find((l) => l.id === grenades.sel) || null;
  loadRadar(map).then((radar) => {
    const size = radar?.size || 1024;
    const at = (x, y) => (radar ? [(x - radar.pos_x) / radar.scale, (radar.pos_y - y) / radar.scale] : [0, 0]);
    const R = { smoke: 144, molotov: 120, flash: 40, he: 70 };
    const maxN = Math.max(1, ...shown.map((l) => l.count));
    const arcs = shown.map((l) => {
      const pts = (l.path?.length > 1 ? l.path : [l.from, [...l.to, 0]]).map(([x, y]) => at(x, y));
      const [fx, fy] = at(l.from[0], l.from[1]), [tx, ty] = at(l.to[0], l.to[1]);
      const on = sel?.id === l.id, dim = sel && !on;
      const wdt = 1.2 + 2.2 * Math.sqrt(l.count / maxN);
      return `<g class="gn-ln ${l.kind} ${on ? "on" : ""} ${dim ? "dim" : ""}" data-gl="${esc(l.id)}">
        <polyline points="${pts.map((p) => p.join(",")).join(" ")}" class="gn-arc" style="stroke-width:${on ? 3.5 : wdt}"/>
        <circle cx="${tx}" cy="${ty}" r="${R[l.kind] / (radar?.scale || 5)}" class="gn-land"/>
        <circle cx="${fx}" cy="${fy}" r="${on ? 8 : 5}" class="gn-from ${l.side === "T" ? "t" : "ct"}"/>
        ${l.count > 1 ? `<text x="${tx}" y="${ty + 4}" text-anchor="middle" class="gn-count">${l.count}</text>` : ""}
        <title>${esc(l.name)} · ${l.count}× · ${esc(placeName2(l.from_place))} → ${esc(placeName2(l.to_place))}</title></g>`;
    }).join("");
    // Spawn spots (instant lineups start from them).
    const spawns = grenades.category === "instant" || sel?.category === "instant" ? Object.entries(d.spawns || {}).flatMap(([side, list]) => (grenades.side === "all" || grenades.side === side ? list.map((p, i) => {
      const [x, y] = at(p[0], p[1]);
      return `<g class="gn-spawn ${side === "T" ? "t" : "ct"} ${sel?.spawn === i + 1 && sel?.side === side ? "on" : ""}"><circle cx="${x}" cy="${y}" r="9"/><text x="${x}" y="${y + 3.5}" text-anchor="middle">${i + 1}</text></g>`;
    }) : [])).join("") : "";
    const svg = view.querySelector("#gn-svg");
    if (svg) svg.innerHTML = arcs + spawns;
    if (svg) svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
    view.querySelectorAll("[data-gl]").forEach((g) => (g.onclick = () => { grenades.sel = g.dataset.gl; renderGrenadeMap(view, d, map); }));
  });

  const tagList = (l) => Object.entries(l.tags || {}).sort((a, b) => b[1] - a[1]);
  const setpos = sel ? `setpos ${sel.from[0].toFixed(2)} ${sel.from[1].toFixed(2)} ${sel.from[2].toFixed(2)};setang ${sel.pitch.toFixed(2)} ${sel.yaw.toFixed(2)} 0` : "";
  const clip = sel ? lineupClip(sel.id) : null;
  const counts = Object.fromEntries(NADE_KINDS.map(([k]) => [k, d.lineups.filter((l) => l.kind === k && (grenades.category === "all" ? l.category !== "fly" : l.category === grenades.category)).length]));
  const kindIcon = (k) => weaponIcon(NADE_KINDS.find((x) => x[0] === k)?.[2] || "smokegrenade");
  const sub = (l) => `${esc(placeName2(l.from_place) || "?")} → ${esc(placeName2(l.to_place) || "?")}`;
  view.innerHTML = `
    <a class="day-back" href="#/grenades">◀ All maps</a>
    <div class="gn-maphead" style="--shot:url('${assetUrl(`mapshots/${map}.png`)}')">${mapIcon(map)}<div><div class="h1">${esc(mapName(map))} lineups</div>
      <div class="sub">${d.lineups.length} lineups from ${d.throws} throws in ${d.matches} matches</div></div></div>
    <div class="ln-bar">
      <div class="chips">${NADE_KINDS.map(([k, label, icon]) => `<button class="chip ${grenades.kinds.has(k) ? "on" : ""}" data-kind="${k}">${weaponIcon(icon)} ${label} <span class="sub">${counts[k]}</span></button>`).join("")}</div>
      <div class="seg" id="gn-cat">${[["all", "Instant + set"], ["instant", "Instant"], ["set", "Set"], ["fly", "On the move"]].map(([k, l]) => `<button data-cat="${k}" class="${grenades.category === k ? "on" : ""}">${l}</button>`).join("")}</div>
      <div class="seg" id="gn-side">${[["all", "Both"], ["T", "T"], ["CT", "CT"]].map(([k, l]) => `<button data-side="${k}" class="${grenades.side === k ? "on" : ""}">${l}</button>`).join("")}</div>
      <label class="gn-min">Thrown at least <select id="gn-min">${[1, 2, 3, 5, 10].map((n) => `<option value="${n}" ${grenades.min === n ? "selected" : ""}>${n}×</option>`).join("")}</select></label>
    </div>
    <div class="gn-main">
      <section class="tl-map"><div class="tl-viewport"><div class="tl-canvas" style="transform:translate(${grenades.pan[0]}px,${grenades.pan[1]}px) scale(${grenades.zoom})">
        <img src="${assetUrl(`radars/${map}.png`)}" alt="${esc(mapName(map))} radar" draggable="false"><svg id="gn-svg" viewBox="0 0 1024 1024"></svg></div></div>
        <input class="tl-zoom" type="range" min="1" max="3" step="0.1" value="${grenades.zoom}" aria-label="Zoom" orient="vertical"></section>
      <section class="gn-side">
        ${sel ? `<div class="gn-detail">
          <div class="gn-video">${clip?.clip ? `<video id="gn-video" src="${assetUrl(clip.clip)}" controls autoplay muted loop playsinline></video>`
            : `<div class="gn-novideo">${clip?.error ? `<b>No video</b><span>${esc(clip.error)}</span>` : `<b>No video yet</b><span>Veloxify films lineups in the background after your highlights, most thrown first.</span>`}${tauri ? `<button class="btn primary" id="gn-render">Film this lineup now</button>` : ""}</div>`}</div>
          <div class="gn-title">${kindIcon(sel.kind)}<b>${esc(sel.name)}</b>${sel.spawn ? `<span class="gn-spawnchip">Spawn #${sel.spawn}</span>` : ""}<span class="gn-x">×${sel.count}</span></div>
          <div class="sub">${sub(sel)} · ${sel.side} · thrown ${sel.count} time${sel.count === 1 ? "" : "s"} in ${sel.matches} match${sel.matches === 1 ? "" : "es"} by ${sel.throwers} player${sel.throwers === 1 ? "" : "s"} · around ${mmss(sel.t)} into the round</div>
          <div class="gn-tags">${tagList(sel).map(([t, n]) => `<span class="tag ${t === sel.technique ? "main" : ""}">${esc(t)}${n < sel.count ? ` ${n}×` : ""}</span>`).join("")}<span class="tag">${esc(({ left: "Left click", right: "Right click", both: "Left + right click" })[sel.click] || sel.click)}</span></div>
          <div class="ln-cmd"><code>${esc(setpos)}</code><button class="btn" id="gn-copy">Copy</button></div>
          <div class="sub">Paste in the console on a practice server (sv_cheats 1) to stand and aim exactly like this.</div>
          <div class="gn-ex"><div class="h3">Thrown by</div>${sel.examples.map((e) => `<a href="${matchHref(e.match_id, "lineups")}">${esc(e.name || "someone")} · round ${e.round}</a>`).join("")}</div>
          <button class="btn ghost" id="gn-back">◀ All lineups</button></div>` : ""}
        <div class="gn-list">${shown.map((l) => `<button class="gn-item ${sel?.id === l.id ? "on" : ""}" data-gl="${esc(l.id)}">
          ${lineupThumb(l)}
          <div class="gn-item-body"><div class="gn-item-title">${kindIcon(l.kind)}<b>${esc(l.name)}</b>${l.spawn ? `<span class="gn-spawnchip">Spawn #${l.spawn}</span>` : ""}<span class="gn-x">×${l.count}</span></div>
            <div class="sub">${sub(l)} · ${l.side}</div><div class="gn-item-tag">${esc(l.technique)}</div></div></button>`).join("") || `<div class="empty small">No lineups with these filters.</div>`}</div>
      </section>
    </div>
    <div class="note">The same lineup is the same spot (within a few units), the same aim (within about a degree) and the same landing, whoever threw it. Instant: thrown in the first seconds of the round from a spawn spot. Set: lined up (standing still, aim held) before throwing. Spawn numbers are the spawn spots on that side of the map.</div>`;

  const rerender = () => renderGrenadeMap(view, d, map);
  view.querySelectorAll("[data-kind]").forEach((b) => (b.onclick = () => { const k = b.dataset.kind; if (grenades.kinds.has(k)) grenades.kinds.delete(k); else grenades.kinds.add(k); grenades.sel = null; rerender(); }));
  view.querySelectorAll("[data-cat]").forEach((b) => (b.onclick = () => { grenades.category = b.dataset.cat; grenades.sel = null; rerender(); }));
  view.querySelectorAll("[data-side]").forEach((b) => (b.onclick = () => { grenades.side = b.dataset.side; grenades.sel = null; rerender(); }));
  view.querySelector("#gn-min").onchange = (e) => { grenades.min = Number(e.target.value); grenades.sel = null; rerender(); };
  view.querySelectorAll(".gn-item[data-gl]").forEach((b) => (b.onclick = (e) => { if (e.target.closest(".hl-card")) return; grenades.sel = b.dataset.gl; rerender(); }));
  view.querySelectorAll(".gn-item .hl-card").forEach((c) => (c.onclick = (e) => { e.stopPropagation(); grenades.sel = c.dataset.lineup; rerender(); }));
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
    if (grenades.zoom === 1 || e.target.closest("[data-gl]")) return;
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

const leagueView = { sort: "m2", desc: true, shown: 50, teamSort: "rating3", teamDesc: true };
const LEADER_COLS = [["m2", "Wins"], ["m3", "Kills"], ["m5", "Assists"], ["m4", "Deaths"], ["m10", "3K"], ["m11", "4K"], ["m12", "5K"], ["m13", "HS%"], ["m8", "Rounds"], ["k17", "ADR"], ["m14", "K/R"], ["m1", "Matches"]];

async function renderLeague(view) {
  view.innerHTML = `<div class="empty">Loading your league from FACEIT…</div>`;
  const L = await loadLeague();
  if (!L) { view.innerHTML = `<div class="empty">Couldn't reach FACEIT for your league. Try again in a bit.</div>`; return; }
  if (L.none) { view.innerHTML = `<div class="empty">No ESEA league games in your FACEIT history yet.</div>`; return; }
  const st = L.standing || {};
  const me = state.index.me;
  const pl = st.placement || {};
  const place = pl.left ? (pl.left === pl.right ? `#${pl.left}` : `#${pl.left}–${pl.right}`) : "";
  const mine = L.standings.find((t) => t.premade_team_id === L.team_id);
  const rosterIds = new Set((L.roster || []).map((r) => r.user_id));
  const when = (iso) => { if (!iso) return ""; const d = new Date(iso); return `${d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })} ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`; };
  const roleOf = (r) => ({ player: "Player", substitute: "Sub", coach: "Coach" }[r.game_role] || r.game_role || "");
  const rankOf = (r) => ({ leader: "Captain", officer: "Officer" }[r.team_role] || "");

  // Your league matches: played (linked to the match page when the demo is in your library) and coming up.
  const libIds = new Set(state.all.map((m) => m.id));
  const matchRow = (g, done) => {
    const us = g.factions.find((f) => f.premade_team_id === L.team_id) || {};
    const them = g.factions.find((f) => f.premade_team_id !== L.team_id) || {};
    const id = `faceit-${g.id.replace(/^1-/, "")}-m1`;
    const won = done && g.winning_team_premade_id === L.team_id;
    const map = g.maps_picked?.[0]?.name || "";
    const href = libIds.has(id) ? matchHref(id) : null;
    return `<${href ? `a href="${href}"` : "div"} class="lg-match ${done ? (won ? "win" : "loss") : "next"}">
      <span class="lg-when">${when(done ? g.started_time || g.scheduled_time : g.scheduled_time)}</span>
      <span class="lg-vs">vs <b>${esc(them.name || "TBD")}</b></span>
      ${done ? `<span class="lg-score"><b class="${won ? "up" : "down"}">${us.match_score ?? ""}</b>:${them.match_score ?? ""}</span><span class="lg-map">${esc(map)}</span>` : `<span class="lg-score sub">Upcoming</span><span></span>`}
    </${href ? "a" : "div"}>`;
  };

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

  // Every player in the division (FACEIT's league stats).
  const num = (p, k) => Number(p.stats?.[k] ?? 0);
  const leaders = L.players.slice().sort((a, b) => (num(b, leagueView.sort) - num(a, leagueView.sort)) * (leagueView.desc ? 1 : -1) || num(b, "m3") - num(a, "m3"));
  const lfmt = (k, v) => (k === "m13" ? `${Math.round(v)}%` : k === "k17" ? v.toFixed(1) : k === "m14" ? v.toFixed(2) : Math.round(v));

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
        <div class="lg-matches">${(L.scheduled || []).map((g) => matchRow(g, false)).join("")}${(L.finished || []).map((g) => matchRow(g, true)).join("") || `<div class="empty small">No league matches played yet.</div>`}</div></section>
    </div>
    <section class="panel lg-section"><div class="panel-head"><div class="h3">Team stats</div><span class="grow"></span><span class="sub">From ${withDemo.length} of ${leagueMatches.length} league match${leagueMatches.length === 1 ? "" : "es"} with a demo in your library</span></div>
      ${team.length ? `<div class="table-wrap"><table class="lg-table"><thead><tr>${TCOLS.map(([k, t]) => `<th data-tsort="${k}" class="${leagueView.teamSort === k ? "on" : ""} ${k === "name" ? "left" : ""}">${t}${leagueView.teamSort === k ? (leagueView.teamDesc ? " ↓" : " ↑") : ""}</th>`).join("")}</tr></thead>
        <tbody>${team.map((p) => `<tr class="${p.is_me ? "me" : ""}">${TCOLS.map(([k]) => tcell(p, k)).join("")}</tr>`).join("")}</tbody></table></div>`
        : `<div class="empty small">Get the demos of your league matches (Match history → Get demos) and your team's stats show here.</div>`}</section>
    <section class="panel lg-section"><div class="panel-head"><div class="h3">Standings</div><span class="grow"></span><span class="sub">${esc(st.division_name || "")} ${esc(st.conference_name || "")} · ${esc(st.stage_name || "")}</span></div>
      <div class="table-wrap"><table class="lg-table lg-standings"><thead><tr><th>#</th><th class="left">Team</th><th>Country</th><th>Matches</th><th>Won</th><th>Lost</th><th>+/-</th><th>Rounds</th><th>Points</th></tr></thead>
        <tbody>${L.standings.map((t) => { const tb = t.tie_breakers || {}; const diff = (t.won || 0) - (t.lost || 0); return `<tr class="${t.premade_team_id === L.team_id ? "me" : ""}">
          <td>${t.rank_start === t.rank_end ? t.rank_start : `${t.rank_start}–${t.rank_end}`}</td>
          <td class="left">${t.avatar_url ? `<img class="lg-tav" src="${esc(t.avatar_url)}" alt="">` : `<span class="lg-tav none"></span>`}<span>${esc(t.name)}</span></td>
          <td><span class="lg-cc">${esc(t.country_code || "")}</span></td><td>${t.matches || 0}</td><td>${t.won || 0}</td><td>${t.lost || 0}</td>
          <td class="${diff > 0 ? "up" : diff < 0 ? "down" : ""}">${diff > 0 ? "+" : ""}${diff}</td><td>${tb.rounds_won ?? 0}-${tb.rounds_lost ?? 0}</td><td><b>${t.points || 0}</b></td></tr>`; }).join("")}</tbody></table></div></section>
    <section class="panel lg-section"><div class="panel-head"><div class="h3">Stat leaders</div><span class="grow"></span><span class="sub">Every player in ${esc(st.division_name || "the division")} ${esc(st.conference_name || "")} · FACEIT's league stats</span></div>
      <div class="table-wrap"><table class="lg-table lg-leaders"><thead><tr><th>#</th><th class="left">Player</th>${LEADER_COLS.map(([k, t]) => `<th data-lsort="${k}" class="${leagueView.sort === k ? "on" : ""}">${t}${leagueView.sort === k ? (leagueView.desc ? " ↓" : " ↑") : ""}</th>`).join("")}</tr></thead>
        <tbody>${leaders.slice(0, leagueView.shown).map((p, i) => `<tr class="${rosterIds.has(p.id) ? "me" : ""}"><td>${i + 1}</td><td class="left"><b>${esc(p.nickname)}</b></td>${LEADER_COLS.map(([k]) => `<td>${lfmt(k, num(p, k))}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
      ${leaders.length > leagueView.shown ? `<button class="btn ghost lg-more" id="lg-more">Show all ${leaders.length} players</button>` : ""}</section>
    <div class="note">From FACEIT's public league pages, refreshed every 20 minutes (or with Refresh). Team stats come from your own demos: HLTV Rating 3.0, RWS and Swing the same way as the rest of Veloxify.</div>`;

  view.querySelector("#lg-refresh").onclick = async (e) => { e.target.disabled = true; e.target.textContent = "Refreshing…"; await loadLeague(true); renderLeague(view); };
  view.querySelector("#lg-more")?.addEventListener("click", () => { leagueView.shown = 10000; renderLeague(view); });
  view.querySelectorAll("[data-lsort]").forEach((th) => (th.onclick = () => { const k = th.dataset.lsort; leagueView.desc = leagueView.sort === k ? !leagueView.desc : true; leagueView.sort = k; renderLeague(view); }));
  view.querySelectorAll("[data-tsort]").forEach((th) => (th.onclick = () => { const k = th.dataset.tsort; leagueView.teamDesc = leagueView.teamSort === k ? !leagueView.teamDesc : k !== "name"; leagueView.teamSort = k; renderLeague(view); }));
}

// ---- match history --------------------------------------------------------------------------

let mh = { source: "all", result: "all", map: "all", shown: 50 };

// Every match: library matches and FACEIT's stats-only ones (see mergeFaceit).
function historyRows() {
  return state.all.map((m) => {
    const fm = m.faceit;
    return {
      id: m.id, demo: !m.stats_only, date: m.played_at.slice(0, 10), source: m.source, map: m.map, result: m.result,
      when: parseLocal(m.played_at), mine: m.score_mine, theirs: m.score_theirs, line: m.line, hl: m.highlight_count,
      elo: m.elo ?? fm?.elo ?? null,
      delta: m.source === "faceit" ? m.elo_delta ?? fm?.elo_delta ?? null : m.premier_delta ?? null,
      premier: m.premier ?? null, placement: !!fm?.calibrating, competition: fm?.competition || "",
      room: m.source === "faceit" ? fm?.match_id || m.id.replace(/^faceit-/, "1-").replace(/-m\d+$/, "") : null,
    };
  }).sort((a, b) => b.when - a.when);
}

function historyRow(r) {
  const l = r.line;
  const elo = r.source === "faceit"
    ? r.elo ? `${levelBadge(levelFor(r.elo))}<span>${r.elo.toLocaleString("en-US")}</span>${deltaHtml(r.delta)}` : leagueOf(r.competition) ? leagueChip(r.competition) : r.placement ? `<span class="none" title="FACEIT shows no ELO during a new season's placement matches">Placement match</span>` : `<span class="none">–</span>`
    : r.source === "valve"
      ? r.premier ? `${premierChip(r.premier)}${deltaHtml(r.delta)}` : `<span class="none">Unranked</span>`
      : `<span class="none">–</span>`;
  const rv = l ? r3(l) : null;
  const rating = rv
    ? `<span class="rchip ${ratingClass(rv)}" title="HLTV Rating 3.0 (estimated from the demo)">${f2(rv)}<i style="width:${Math.min(100, (rv / 2) * 100)}%"></i></span>`
    : `<span class="rchip na" title="Needs the demo">–</span>`;
  const actions = r.demo
    ? `<button class="sqbtn ${r.hl ? "hl" : "dim"}" data-act="hl" title="${r.hl ? `${r.hl} highlight${r.hl === 1 ? "" : "s"}` : "No highlights in this match"}">${ICONS.star}${r.hl}</button>`
    : `<button class="sqbtn" data-act="demo" title="Get the demo: Veloxify opens the match room, you click FACEIT's download, Veloxify does the rest">${ICONS.download}</button>`;
  return `
    <div class="ml-grid ml-row ${r.result} clickable" data-id="${esc(r.id)}" data-href="${matchHref(r.id)}" ${r.room ? `data-room="${esc(r.room)}"` : ""}>
      <div class="ml-date">${fcDate(r.when)}</div>
      <div class="ml-score"><span class="wl ${r.result}">${r.result === "win" ? "W" : r.result === "loss" ? "L" : "T"}</span><span><b class="${r.result}">${r.mine}</b> : <span class="theirs">${r.theirs}</span></span></div>
      <div class="ml-elo">${elo}</div>
      <div>${rating}</div>
      <div>${l?.rws != null ? `<span class="ml-num ${gradeClass("rws", l.rws)}">${f1(l.rws)}</span>` : `<span class="ml-num na">–</span>`}</div>
      <div class="ml-num">${l ? `${l.kills} / ${l.deaths} / ${l.assists}` : "–"}</div>
      <div class="ml-num">${l ? f1(l.adr) : "–"}</div>
      <div class="ml-map">${mapIcon(r.map)}<span>${esc(mapName(r.map))}</span></div>
      <div class="ml-actions">${actions}${r.room ? `<button class="sqbtn" data-act="room" title="Open the match room on FACEIT">${ICONS.external}</button>` : ""}</div>
    </div>`;
}

function renderMatchHistory(view) {
  const all = historyRows();
  const rows = all.filter((r) => (mh.source === "all" || r.source === mh.source) && (mh.result === "all" || r.result === mh.result) && (mh.map === "all" || r.map === mh.map));
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
        <div class="fc-filters">
          ${seg("source", [["all", "All"], ["faceit", "FACEIT"], ["valve", "Premier"]])}
          ${seg("result", [["all", "All"], ["win", "Wins"], ["loss", "Losses"]])}
          <select id="mhmap"><option value="all">All maps</option>${maps.map((m) => `<option value="${m}" ${mh.map === m ? "selected" : ""}>${esc(mapName(m))}</option>`).join("")}</select>
        </div>
      </div>
      <div class="ml-grid ml-head">
        <div>Date</div><div>Score</div><div></div><div title="HLTV Rating 3.0, estimated from the demo"><span class="ic">${ICONS.rating}</span>HLTV 3.0</div>
        <div>RWS</div><div>K/D/A</div><div>ADR</div><div>Map</div><div></div>
      </div>
      ${rows.slice(0, mh.shown).map(historyRow).join("")}
      ${rows.length > mh.shown ? `<div style="text-align:center;margin-top:12px"><button class="btn" id="mhmore">Show more</button></div>` : ""}
      ${missing ? `<div class="ml-note">${missing} FACEIT match${missing === 1 ? "" : "es"} without a demo show FACEIT's stats only. Get the demo (download button) and Veloxify adds the rating, RWS, highlights and lowlights. FACEIT keeps demos for a few weeks.</div>` : ""}
    </section>`;
  view.querySelectorAll(".seg[data-mkey]").forEach((el) => el.querySelectorAll("button").forEach((b) => (b.onclick = () => { mh[el.dataset.mkey] = b.dataset.v; mh.shown = 50; renderMatchHistory(view); })));
  view.querySelector("#mhmap").onchange = (e) => { mh.map = e.target.value; mh.shown = 50; renderMatchHistory(view); };
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
  const day = dayOf(date);
  const sess = day?.sessions[idx];
  if (!sess) { view.innerHTML = `<div class="empty">No session on ${esc(date)}</div>`; return; }
  const summaries = sess.match_ids.map(summaryOf);
  const withDemo = summaries.filter((m) => !m.stats_only);
  const entries = await Promise.all(withDemo.map((m) => loadMatch(m.id)));
  const me = state.index.me;
  const players = sumPlayers(entries, me);
  const meRow = players.find((p) => p.is_me);
  // Cards: you and your party; solo, every teammate you had this session.
  const party = players.filter((p) => !p.is_me && p.mine > 0 && p.party);
  const cards = [meRow, ...(party.length ? party : players.filter((p) => !p.is_me && p.mine > 0))].filter(Boolean);
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
        <div><b>${f1(p.adr)}</b><span>ADR</span></div>
        <div><b>${f2(p.kd)}</b><span>K/D</span></div>
        <div><b>${fmtSwing(p.swing)}</b><span>Swing</span></div>
      </div>
      <div class="sc-maps">${p.results.map((r) => `<span class="${r.won ? "up" : "down"}" title="${esc(mapName(r.map))}">${r.won ? "W" : "L"}</span>`).join("")}</div>
    </div>`;

  // Full session scoreboard.
  const COLS = [
    ["name", "Player"], ["maps", "Maps"], ["wins", "W-L"], ["rating3", "HLTV 3.0"], ["rws", "RWS"], ["kills", "K"], ["deaths", "D"], ["assists", "A"],
    ["diff", "+/-"], ["kd", "K/D"], ["adr", "ADR"], ["kr", "K/R"], ["kast", "KAST"], ["hs", "HS%"], ["k2", "2K"], ["k3", "3K"], ["k4", "4K"], ["k5", "5K"],
    ["mvps", "MVPs"], ["entries", "Entries"], ["pistol", "Pistol kills"], ["eco", "Eco kills"], ["clutch", "Clutches"], ["swing", "Swing"],
  ];
  const val = (p, k) => ({
    name: p.name.toLowerCase(), kills: p.c.kills || 0, deaths: p.c.deaths || 0, assists: p.c.assists || 0, diff: (p.c.kills || 0) - (p.c.deaths || 0),
    k2: (p.c.multikill_rounds || [])[2] || 0, k3: (p.c.multikill_rounds || [])[3] || 0, k4: (p.c.multikill_rounds || [])[4] || 0, k5: (p.c.multikill_rounds || [])[5] || 0,
    mvps: p.c.mvps || 0, entries: p.c.opening_kills || 0, pistol: p.c.pistol_kills || 0, eco: p.c.eco_kills || 0, clutch: sum(p.c.clutches_won || []),
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
      case "kd": case "kr": return `<td>${f2(p[k])}</td>`;
      case "adr": return `<td>${f1(p.adr)}</td>`;
      case "kast": return `<td>${f1(p.kast)}%</td>`;
      case "hs": return `<td>${Math.round(p.hs)}%</td>`;
      case "clutch": return `<td>${val(p, "clutch")}/${sum(p.c.clutches_attempted || [])}</td>`;
      case "swing": return `<td>${fmtSwing(p.swing)}</td>`;
      default: return `<td>${val(p, k)}</td>`;
    }
  };
  const statsOnly = summaries.length - withDemo.length;
  view.innerHTML = `
    <div class="sess-head">
      <div class="sess-box"><span class="sess-w">${w}W</span><span class="sess-sep">:</span><span class="sess-l">${l}L</span><span class="sub">/ ${summaries.length} match${summaries.length === 1 ? "" : "es"}</span></div>
      <div class="sess-box"><b>${fmtDate(date)}</b><span class="sub">${fmtTime(first.played_at)}–${fmtTime(last.played_at)} · ${fmtSpan(minutes)}</span></div>
      <span class="grow"></span>
      ${prevSess ? `<a class="btn ghost" href="${prevSess}">◀ Previous session</a>` : ""}
      ${nextSess ? `<a class="btn ghost" href="${nextSess}">Next session ▶</a>` : ""}
    </div>
    ${cards.length ? `<div class="sc-row">${cards.map(card).join("")}</div>` : `<div class="empty">No demos for this session yet.</div>`}
    ${statsOnly ? `<div class="ml-note" style="margin:0 0 14px">${statsOnly} match${statsOnly === 1 ? "" : "es"} without a demo yet (FACEIT stats only) aren't in these totals. ${demoButton(missingDemos(summaries, 3650), "btn")}</div>` : ""}
    <section class="fc-card" style="margin-bottom:20px">
      <div class="fc-head"><div class="h3">Matches</div></div>
      <div class="ml-grid ml-head"><div>Date</div><div>Score</div><div></div><div><span class="ic">${ICONS.rating}</span>HLTV 3.0</div><div>RWS</div><div>K/D/A</div><div>ADR</div><div>Map</div><div></div></div>
      ${historyRows().filter((r) => sess.match_ids.includes(r.id)).sort((a, b) => a.when - b.when).map(historyRow).join("")}
    </section>
    <section class="panel">
      <div class="panel-head"><div class="h3">Session scoreboard</div><span class="sub">you${rows.length > 1 ? " and your party" : ""}, all ${withDemo.length} match${withDemo.length === 1 ? "" : "es"} added up</span></div>
      <div class="sc-table"><table class="sb">
        <thead><tr>${COLS.map(([k, t]) => `<th data-sort="${k}" class="sortable ${sessionView.sort === k ? "on" : ""}">${t}${sessionView.sort === k ? (sessionView.desc ? " ▾" : " ▴") : ""}</th>`).join("")}</tr></thead>
        <tbody>${rows.map((p) => `<tr class="${p.is_me ? "me" : p.party ? "party" : ""}">${COLS.map(([k]) => cell(p, k)).join("")}</tr>`).join("")}</tbody>
      </table></div>
      <div class="note">Your party: players who were on your team for at least two of the session's matches. HLTV 3.0, RWS, ADR, KAST and Swing are per round, so session values weight each match by its rounds. Eco kills: on players with under $2,000 of equipment (not pistol rounds).</div>
    </section>`;
  view.querySelectorAll("th[data-sort]").forEach((th) => (th.onclick = () => {
    const k = th.dataset.sort;
    sessionView.desc = sessionView.sort === k ? !sessionView.desc : k !== "name";
    sessionView.sort = k;
    renderSession(view, date, idx);
  }));
  view.querySelectorAll(".ml-row").forEach((row) => (row.onclick = (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "room") return openFaceitRoom(row.dataset.room);
    if (act === "demo") return getDemos([row.dataset.room]);
    location.hash = act === "hl" ? `${row.dataset.href}/highlights` : row.dataset.href;
  }));
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
    <div id="clips-body"></div>`;
  const body = view.querySelector("#clips-body");
  if (sub === "lowlights") return renderLowlightsTab(body);
  if (sub === "montages") return renderMontages(body);
  return renderHighlightsTab(body);
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

async function renderSettings(view) {
  document.querySelector('[data-nav="settings"]').classList.add("active");
  settingsData = tauri ? await tauri.core.invoke("get_settings") : JSON.parse(JSON.stringify(PREVIEW_SETTINGS));
  const s = settingsData.settings, r = settingsData.render;
  const steamid = s.steamid64 || settingsData.detected_steamid;
  const sw = (key, on) => `<label class="switch"><input type="checkbox" data-key="${key}" ${on ? "checked" : ""} ${tauri ? "" : "disabled"}><i></i></label>`;
  const seg = (key, val, opts) => `<div class="seg" data-key="${key}">${opts.map(([v, l]) => `<button data-v="${v}" class="${String(val) === String(v) ? "on" : ""}" ${tauri ? "" : "disabled"}>${l}</button>`).join("")}</div>`;
  const row = (title, desc, control) => `<div class="set-row"><div class="lbl"><b>${title}</b>${desc ? `<span>${desc}</span>` : ""}</div>${control}</div>`;
  const folders = s.watch_dirs.map((d, i) => `<div class="folder"><code title="${esc(d)}">${esc(d)}</code>${tauri ? `<button class="btn ghost" data-remove="${i}">Remove</button>` : ""}</div>`).join("")
    || `<div class="folder sub">No extra folders. Demos from Get demos are found automatically; add a folder here only if you keep other demos somewhere (e.g. Downloads).</div>`;
  view.innerHTML = `
    <div class="profile-head"><div><div class="h2">Veloxify ${esc(settingsData.version)}</div><div class="h1">Settings</div></div><span class="saved" id="saved">Saved</span></div>
    ${tauri ? "" : `<div class="preview-note">Preview: settings can be changed in the desktop app.</div>`}
    <div class="settings">
      <section class="panel">
        <div class="panel-head"><div class="h3">Accounts</div></div>
        ${row("Steam", steamid ? `${esc(settingsData.steam_name || "Logged-in account")} · ${steamid}` : "Log in to Steam so Veloxify knows whose highlights to make.", "")}
        <div id="faceit-account">${faceitAccountRow()}</div>
        ${row("Use FACEIT data", "Level, ELO and your full FACEIT match list, found from your Steam account. No login or API key.", sw("faceit_enabled", s.faceit_enabled))}
        ${row("FACEIT demos", "Get demos downloads every missing demo in one click through Veloxify's own FACEIT window. If FACEIT ever asks you to sign in, do it once there: it's a separate browser profile, so your Chrome and FACEIT client stay signed in, and Veloxify never sees your password. FACEIT's human check runs normally; once in a while it may ask you to tick a box.", tauri ? `<button class="btn" id="faceit-sign-in">Sign in to FACEIT</button>` : "")}
        ${row("FACEIT nickname", "Only needed if your account isn't found automatically.", `<input type="text" data-key="faceit_nickname" value="${esc(s.faceit_nickname)}" placeholder="Found automatically" ${tauri ? "" : "disabled"}>`)}
      </section>
      ${appearancePanel()}
      <section class="panel">
        <div class="panel-head"><div class="h3">Highlights</div></div>
        ${row("Make highlights automatically", "After you close CS2, new demos are read and your best moments rendered in the background.", sw("auto_render", s.auto_render))}
        ${row("Capture lowlights too", "After the highlights, your 3 worst deaths from each match of the latest session are rendered too, for the whiff analyzer. Others render when you press Watch.", sw("auto_lowlights", s.auto_lowlights ?? true))}
        ${row("Film grenade lineups", "After your clips, Veloxify films the lineups from your demos for the Grenades page (the thrower's view, then the grenade until it goes off), most thrown first, about 20 at a time.", sw("auto_lineups", s.auto_lineups ?? true))}
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
        ${row("Crosshair", "", seg("own_crosshair", r.own_crosshair, [[false, "Clean default"], [true, "Player's own"]]))}
        ${row("X-ray", "Show players through walls.", sw("xray", r.xray))}
        ${row("Game audio", "CS2's sound only, never Discord or music.", sw("audio", r.audio))}
      </section>
      <section class="panel">
        <div class="panel-head"><div class="h3">Demo folders</div><span class="grow"></span>${tauri ? `<button class="btn" id="add-folder">Add folder</button>` : ""}</div>
        <div class="sub" style="padding:0 20px 8px">New demos in these folders are imported automatically.</div>
        ${folders}
        <div class="panel-head" style="border-top:1px solid var(--line);margin-top:12px"><div class="h3">App</div></div>
        ${row("Library", "Clips, match data and saved demos.", tauri ? `<button class="btn" id="open-lib">Open folder</button>` : "")}
        <div id="storage"></div>
        ${row("Start with Windows", "Starts in the tray, ready to process your games. It never runs anything while CS2 is open.", sw("start_with_windows", s.start_with_windows))}
      </section>
    </div>`;
  wireAppearance(view); // works in the preview too (saved in this browser)
  if (!tauri) return;

  const RENDER_KEYS = ["height", "fps", "transition", "killfeed_only", "own_crosshair", "xray", "audio"];
  const set = (key, value) => {
    if (["height", "fps", "max_per_match"].includes(key)) value = Number(value);
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
  renderStorage(view.querySelector("#storage"));
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
    watch_dirs: s.watch_dirs, auto_render: s.auto_render, auto_lowlights: s.auto_lowlights ?? true, auto_lineups: s.auto_lineups ?? true, faceit_enabled: s.faceit_enabled, faceit_nickname: s.faceit_nickname,
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

function showStatus(st) {
  const el = document.getElementById("status");
  if (!st) return;
  const busy = st.state === "importing" || st.state === "rendering";
  el.classList.toggle("busy", busy);
  el.textContent = st.state === "rendering" && st.total ? `Rendering ${Math.min(st.done + 1, st.total)} of ${st.total}`
    : st.state === "importing" && st.total ? `Reading matches ${st.done + 1}/${st.total}`
    : st.state === "waiting" ? "Playing · clips after CS2 closes"
    : st.state === "error" ? "Needs attention" : "Up to date";
  el.title = st.message || "";
  // While CS2 is busy rendering, the status doubles as a stop button.
  el.classList.toggle("stoppable", st.state === "rendering");
  el.onclick = st.state === "rendering" ? () => tauri?.core.invoke("stop_rendering") : null;
  if (st.state === "rendering") el.title = "CS2 is rendering your highlights in the background. Click to stop and hand CS2 back.";
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
function renderBanner() {
  const el = document.getElementById("banner");
  if (!el) return;
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
    b = { kind: "busy", title: "Analyzing older matches", count: `${Math.min(st.done + 1, st.total)}/${st.total}`, frac: st.done / st.total, actions: [] };
  } else if (st?.state === "importing" && st.total) {
    b = { kind: "busy", title: "Analyzing matches", count: `${Math.min(st.done + 1, st.total)}/${st.total}`, frac: st.done / st.total, actions: [] };
  } else if (st?.state === "rendering") {
    b = {
      kind: "rec",
      title: st.total ? "Clip capture in progress" : "Starting clip capture",
      count: st.total ? `${Math.min(st.done + 1, st.total)}/${st.total}` : "",
      frac: st.total ? st.done / st.total : 0,
      actions: [["Stop", () => tauri.core.invoke("stop_rendering")]],
    };
  } else if (st?.state === "error") {
    b = { kind: "warn", title: "Needs attention", count: "", frac: null, note: st.message, actions: [] };
  }
  if (!b) { el.hidden = true; bannerKey = ""; return; }
  el.hidden = false;
  el.className = `banner ${b.kind}`;
  // Built once per kind of banner; progress updates in place (so buttons aren't swapped mid-click).
  const key = b.kind + b.actions.map((a) => a[0]).join();
  if (key !== bannerKey) {
    bannerKey = key;
    el.innerHTML = `<div class="banner-in"><span class="banner-dot"></span><b class="banner-title"></b><span class="banner-count"></span>
      <div class="banner-bar"><i></i></div>${b.actions.map((a, i) => `<button class="banner-btn" data-i="${i}">${esc(a[0])}</button>`).join("")}</div>
      <div class="banner-note"></div>`;
  }
  el.querySelectorAll(".banner-btn").forEach((btn) => (btn.onclick = b.actions[btn.dataset.i][1]));
  el.querySelector(".banner-title").textContent = b.title;
  el.querySelector(".banner-count").textContent = b.count;
  const bar = el.querySelector(".banner-bar");
  bar.hidden = b.frac == null;
  bar.firstElementChild.style.width = `${Math.max(0, Math.min(1, b.frac || 0)) * 100}%`;
  const note = el.querySelector(".banner-note");
  note.textContent = b.note || "";
  note.hidden = !b.note;
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
