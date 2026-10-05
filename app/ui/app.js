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

const state = { index: null, faceit: null, matches: new Map(), month: null, playlist: [], playing: -1 };
const BROWSER_DEFAULTS = { heroPeriod: "week", sort: "best", when: "all", from: "", to: "", source: "all", map: "all", types: [], playableOnly: true };
let browser = { ...BROWSER_DEFAULTS };
try { browser = { ...BROWSER_DEFAULTS, ...JSON.parse(localStorage.getItem("veloxify.browser") || "{}") }; } catch (e) { /* defaults */ }
const saveBrowser = () => { try { localStorage.setItem("veloxify.browser", JSON.stringify(browser)); } catch (e) { /* not persisted */ } };

// ---- data ----------------------------------------------------------------------------------------

async function loadIndex() {
  const res = await fetch(assetUrl("index.json"), { cache: "no-store" });
  if (!res.ok) throw new Error(`index.json: ${res.status}`);
  state.index = await res.json();
  // FACEIT account and match list (written by the app; absent until the first lookup).
  try {
    const f = await fetch(assetUrl("faceit.json"), { cache: "no-store" });
    state.faceit = f.ok ? await f.json() : null;
  } catch (e) {
    state.faceit = null;
  }
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
    state.matches.set(id, await res.json());
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
const fmtClip = (s) => { const t = Math.round(s); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`; };
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const f1 = (x) => x.toFixed(1);
const f2 = (x) => x.toFixed(2);
const ratingClass = (r) => (r >= 1.1 ? "good" : r < 0.9 ? "bad" : "");
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
  if (parts[0] === "day" && parts[1]) return renderDay(view, parts[1], parts[2] === "m" ? decodeURIComponent(parts[3]) : null, parts[4]);
  if (parts[0] === "latest") {
    const last = state.days[state.days.length - 1];
    if (last) { location.hash = `#/day/${last.date}`; return; }
  }
  if (parts[0] === "settings") return renderSettings(view);
  if (parts[0] === "profile" || !parts.length) {
    document.querySelector('[data-nav="profile"]').classList.add("active");
    return renderProfile(view);
  }
  if (parts[0] === "matches") {
    document.querySelector('[data-nav="matches"]').classList.add("active");
    return renderMatchHistory(view);
  }
  if (parts[0] === "highlights") {
    document.querySelector('[data-nav="highlights"]').classList.add("active");
    return renderHighlightsTab(view);
  }
  document.querySelector('[data-nav="home"]').classList.add("active");
  renderHome(view);
}

// ---- home: calendar + latest session -----------------------------------------------------------

function renderHome(view) {
  const days = new Map(state.days.map((d) => [d.date, d]));
  if (!state.month) {
    const last = state.days[state.days.length - 1];
    const base = last ? new Date(`${last.date}T12:00:00`) : new Date();
    state.month = new Date(base.getFullYear(), base.getMonth(), 1);
  }
  const m = state.month;
  const first = new Date(m.getFullYear(), m.getMonth(), 1);
  const start = new Date(first); start.setDate(1 - ((first.getDay() + 6) % 7)); // weeks start Monday
  const today = iso(new Date());
  let cells = "";
  for (let i = 0; i < 42; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const key = iso(d);
    const day = days.get(key);
    const cls = ["cal-day", d.getMonth() !== m.getMonth() && "other", day && "has", key === today && "today"].filter(Boolean).join(" ");
    let dots = "";
    if (day) {
      const results = day.sessions.flatMap((s) => [...Array(s.wins).fill("win"), ...Array(s.losses).fill("loss")]);
      dots = results.slice(0, 5).map((r) => `<span class="dot ${r}"></span>`).join("");
      if (day.highlight_count) dots += `<span class="dot hl" title="${day.highlight_count} highlights"></span>`;
    }
    cells += `<div class="${cls}" ${day ? `data-day="${key}"` : ""}><span>${d.getDate()}</span><span class="dots">${dots}</span></div>`;
  }
  const dow = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((x) => `<div class="cal-dow">${x}</div>`).join("");
  const monthLabel = m.toLocaleDateString([], { month: "long", year: "numeric" });

  view.innerHTML = `
    <div class="home">
      <section class="panel">
        <div class="cal-head">
          <div class="h1">${monthLabel}</div>
          <button class="btn ghost" id="prev">◀</button>
          <button class="btn ghost" id="todayBtn">Today</button>
          <button class="btn ghost" id="next">▶</button>
        </div>
        <div class="cal-grid">${dow}${cells}</div>
        <div class="cal-legend">
          <span><i class="dot win"></i> Win</span><span><i class="dot loss"></i> Loss</span><span><i class="dot hl"></i> Highlights</span>
        </div>
      </section>
      ${latestPanel()}
    </div>`;
  view.querySelectorAll("[data-day]").forEach((el) => el.addEventListener("click", () => (location.hash = `#/day/${el.dataset.day}`)));
  view.querySelector("#prev").onclick = () => { state.month = new Date(m.getFullYear(), m.getMonth() - 1, 1); renderHome(view); };
  view.querySelector("#next").onclick = () => { state.month = new Date(m.getFullYear(), m.getMonth() + 1, 1); renderHome(view); };
  view.querySelector("#todayBtn").onclick = () => { const t = new Date(); state.month = new Date(t.getFullYear(), t.getMonth(), 1); renderHome(view); };
}

function latestPanel() {
  const day = state.days[state.days.length - 1];
  if (!day) return `<section class="panel latest"><div class="empty">No matches yet</div></section>`;
  const me = day.players.find((p) => p.is_me);
  const ms = dayMatchIds(day).map(summaryOf);
  const w = sum(day.sessions.map((s) => s.wins)), l = sum(day.sessions.map((s) => s.losses));
  const party = day.players.filter((p) => !p.is_me).map((p) => esc(p.name)).join(", ") || "Solo";
  const adr = me ? me.derived.adr : sum(ms.map((m) => m.line?.adr || 0)) / Math.max(1, ms.length);
  return `
    <section class="panel latest">
      <div class="panel-head"><div class="h2">Latest session</div><div class="h1">${relDay(day.date)}</div><div class="sub">${fmtDate(day.date)}</div></div>
      <div class="latest-body">
        <div class="kpis">
          <div class="kpi"><div class="v">${w}-${l}</div><div class="l">Record</div></div>
          <div class="kpi"><div class="v rating ${me ? ratingClass(me.derived.rating2) : ""}">${me ? f2(me.derived.rating2) : "–"}</div><div class="l">Rating 2.0 est.</div></div>
          <div class="kpi"><div class="v">${f1(adr)}</div><div class="l">ADR</div></div>
        </div>
        <div class="sub">Party: ${party}</div>
        <div class="sub"><span class="star">★</span> ${day.highlight_count} highlights${day.stats_only ? ` · ${day.stats_only} match${day.stats_only === 1 ? "" : "es"} waiting for the demo` : ""}</div>
        <a class="btn" href="#/day/${day.date}">Open session</a>
      </div>
    </section>`;
}

// ---- day view ------------------------------------------------------------------------------------

async function renderDay(view, date, matchId, tab) {
  const day = dayOf(date);
  if (!day) { view.innerHTML = `<div class="empty">No matches on ${esc(date)}</div>`; return; }
  const ids = dayMatchIds(day);
  const cards = ids.map((id) => {
    const m = summaryOf(id);
    return `
      <a class="mcard ${m.result} ${id === matchId ? "selected" : ""} ${m.stats_only ? "stats-only" : ""}" href="#/day/${date}/m/${encodeURIComponent(id)}">
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
    <a class="day-back" href="#/calendar">◀ Calendar</a>
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
      <div><div class="k">Time played</div><div class="v">${Math.round(minutes)} min</div></div>
      <div><div class="k">Highlights</div><div class="v"><span class="star">★</span> ${day.highlight_count}</div></div>
    </div>
    ${tabsHtml([["stats", "Stats"], ["highlights", "Highlights"]], tab)}
    <div class="dbody" id="dbody"></div>`;
  el.querySelectorAll("[data-tab]").forEach((b) => (b.onclick = () => (location.hash = `#/day/${day.date}/o/x/${b.dataset.tab}`)));
  const body = el.querySelector("#dbody");
  if (tab === "highlights") return renderHighlights(body, ids);

  const waiting = ids.map(summaryOf).filter((m) => m.stats_only);
  const waitingHtml = waiting.length ? `
    <div class="h2" style="margin:${day.players.length ? "26px" : "0"} 0 10px">Waiting for the demo · stats from FACEIT</div>
    <table class="sb">
      <thead><tr><th>Map</th><th>Time</th><th>Score</th><th>K / D / A</th><th>ADR</th><th>HS%</th><th>ELO</th></tr></thead>
      <tbody>${waiting.map((m) => { const fm = m.faceit; return `<tr class="clickable" data-href="#/day/${day.date}/m/${encodeURIComponent(m.id)}">
        <td>${esc(mapName(m.map))}</td><td>${fmtTime(m.played_at)}</td><td class="${m.result}-text">${m.score_mine}-${m.score_theirs}</td>
        <td>${fm.kills} / ${fm.deaths} / ${fm.assists}</td><td>${f1(fm.adr)}</td><td>${Math.round(fm.hs_pct)}%</td>
        <td>${fm.elo ? `${fm.elo.toLocaleString("en-US")} ${deltaHtml(fm.elo_delta)}` : fm.calibrating ? "Placement" : "–"}</td></tr>`; }).join("")}</tbody>
    </table>
    <div class="note">These join the totals above, with HLTV rating, RWS and highlights, once their demos are processed (after you close CS2).</div>` : "";
  const rows = day.players.map((p) => {
    const c = p.counts, d = p.derived;
    const mk = sum(c.multikill_rounds.slice(2));
    const cw = sum(c.clutches_won), ca = sum(c.clutches_attempted);
    const diff = c.kills - c.deaths;
    return `<tr class="${p.is_me ? "me" : "party"}">
      <td>${esc(p.name)}</td><td>${c.matches}</td><td>${c.wins}-${c.matches - c.wins}</td>
      <td class="rating ${ratingClass(d.rating2)}">${f2(d.rating2)}</td>
      <td>${c.kills}-${c.deaths} <span class="sub">(${diff > 0 ? "+" : ""}${diff})</span></td>
      <td>${f2(d.kd)}</td><td>${f1(d.adr)}</td><td>${f1(d.kast)}%</td><td>${Math.round(d.hs_pct)}%</td>
      <td>${c.opening_kills}-${c.opening_deaths}</td><td>${cw}/${ca}</td><td>${mk}</td><td>${f2(d.rating1)}</td></tr>`;
  }).join("");
  if (!day.players.length) {
    body.innerHTML = waitingHtml;
    wireRowLinks(body);
    return;
  }
  body.innerHTML = `
    <div class="h2" style="margin-bottom:10px">You${day.players.length > 1 ? " and your party" : ""}</div>
    <table class="sb">
      <thead><tr><th>Player</th><th>Maps</th><th>W-L</th><th>Rating 2.0*</th><th>K-D</th><th>K/D</th><th>ADR</th><th>KAST</th><th>HS%</th><th>Entries</th><th>Clutches</th><th>Multi-kills</th><th>Rating 1.0</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="note">*Rating 2.0 est. uses the public community approximation of HLTV's formula; Rating 1.0 is HLTV's exact published formula.
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
          <span>Download it from the match room; Veloxify processes it after you close CS2.</span></div>
        <button class="btn primary" id="open-room">Open match room</button>
      </div>
    </div>`;
  el.querySelector("#open-room").onclick = () => openFaceitRoom(fm.match_id);
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
    ${tabsHtml([["scoreboard", "Scoreboard"], ["highlights", `Highlights (${m.highlights.length})`]], tab)}
    <div class="dbody" id="dbody"></div>`;
  el.querySelectorAll("[data-tab]").forEach((b) => (b.onclick = () => (location.hash = `#/day/${date}/m/${encodeURIComponent(id)}/${b.dataset.tab}`)));
  const body = el.querySelector("#dbody");
  if (tab === "highlights") return renderHighlights(body, [id]);

  const me = state.index.me;
  const team = (side) => m.players.filter((p) => p.side === side).sort((a, b) => b.counts.score - a.counts.score);
  const row = (p) => {
    const c = p.counts, d = p.derived;
    const cls = p.steamid === me ? "me" : p.party ? "party" : "";
    return `<tr class="${cls}"><td>${esc(p.name)}</td><td>${c.kills}</td><td>${c.assists}</td><td>${c.deaths}</td>
      <td>${c.mvps ? `<span class="star">★</span>${c.mvps > 1 ? c.mvps : ""}` : ""}</td><td>${c.score}</td>
      <td>${f1(d.adr)}</td><td>${f1(d.kast)}%</td><td>${Math.round(d.hs_pct)}%</td><td class="rating ${ratingClass(d.rating2)}">${f2(d.rating2)}</td></tr>`;
  };
  body.innerHTML = `
    <table class="sb">
      <thead><tr><th>Player</th><th>K</th><th>A</th><th>D</th><th>★</th><th>Score</th><th>ADR</th><th>KAST</th><th>HS%</th><th>Rating 2.0*</th></tr></thead>
      <tbody>
        <tr class="team-row"><td colspan="10"><span class="big">${m.score_mine}</span>Your team · ${resultWord(m.result)}</td></tr>
        ${team("mine").map(row).join("")}
        <tr class="team-row"><td colspan="10"><span class="big">${m.score_theirs}</span>Enemy team</td></tr>
        ${team("enemy").map(row).join("")}
      </tbody>
    </table>
    <div class="note">K/A/D, MVPs and score come from CS2's own end-of-match scoreboard. ● marks party members.</div>`;
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
          <div class="hl-card ${h.clip ? "" : "pending"}" data-hl="${esc(h.id)}">
            <div class="hl-thumb" style="--map-bg:${mapColor(m.map)};${h.thumb ? `background-image:url('${assetUrl(h.thumb)}')` : ""}">
              ${h.clip ? `<span class="play">▶</span>` : `<span class="state">${h.render_error ? esc(h.render_error) : "Rendering…"}</span>`}
              <span class="dur">${fmtClip(h.duration_s)}</span>
            </div>
            <div class="hl-info">
              <div class="hl-title">${esc(h.title)}</div>
              <div class="hl-meta"><span>${esc(h.name || "")}</span><span>${esc(mapName(m.map))} · round ${h.round}</span></div>
              <div class="tags">${h.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>
            </div>
          </div>`).join("")}
        </div>
      </div>`).join("")}`;
  body.querySelectorAll("[data-hl]").forEach((c) => (c.onclick = () => {
    const i = state.playlist.findIndex((h) => h.id === c.dataset.hl);
    if (i >= 0) play(i);
  }));
}

function play(i) {
  const h = state.playlist[i];
  if (!h) return;
  state.playing = i;
  document.getElementById("player").hidden = false;
  document.getElementById("player-title").textContent = h.title;
  document.getElementById("player-sub").textContent = `${h.name} · ${mapName(h.match.map)} · round ${h.round}`;
  const v = document.getElementById("player-video");
  v.src = assetUrl(h.clip);
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
const WIN = "#3aa58f", LOSS = "#e5533d"; // validated pair on the #161616 card (CVD-safe)

// Rating bands (HLTV-style scale, 1.00 = average).
const ratingWord = (r) => (r >= 1.2 ? "Great" : r >= 1.05 ? "Good" : r >= 0.95 ? "Average" : r >= 0.85 ? "Subpar" : "Poor");
const scoreWord = (x) => (x >= 75 ? "Great" : x >= 60 ? "Good" : x >= 40 ? "Average" : x >= 25 ? "Subpar" : "Poor");

function dial(value, frac, label, sub, size = 150) {
  const r = size / 2 - 10, c = 2 * Math.PI * r, f = Math.max(0, Math.min(1, frac));
  return `
    <div class="dial" style="width:${size}px">
      <svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="${esc(label)} ${esc(value)}">
        <circle cx="${size / 2}" cy="${size / 2}" r="${r}" class="dial-track"/>
        <circle cx="${size / 2}" cy="${size / 2}" r="${r}" class="dial-fill" stroke-dasharray="${(c * f).toFixed(1)} ${c.toFixed(1)}"
          transform="rotate(-90 ${size / 2} ${size / 2})"/>
      </svg>
      <div class="dial-value" style="font-size:${size / 4.6}px">${value}</div>
      <div class="dial-label">${esc(label)}</div>
      ${sub ? `<div class="dial-sub">${esc(sub)}</div>` : ""}
    </div>`;
}

function formChart(form) {
  if (!form.length) return "";
  const w = 900, h = 170, pad = 28, n = form.length, gap = 2;
  const max = Math.max(1.6, ...form.map((f) => f.rating2));
  const bw = (w - pad) / n - gap, y = (v) => h - 20 - (v / max) * (h - 34);
  const bars = form.map((f, i) => {
    const x = pad + i * (bw + gap), top = y(f.rating2), bh = h - 20 - top;
    const tip = `${mapName(f.map)} · ${relDay(f.played_at.slice(0, 10))} · ${f.result === "win" ? "W" : f.result === "loss" ? "L" : "T"} · Rating ${f2(f.rating2)} · ${f1(f.adr)} ADR`;
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
      <div><div class="h2">Profile</div><div class="h1" style="display:flex;align-items:center;gap:10px">${esc(state.faceit?.nickname || state.index.me_name || "You")}${state.faceit?.level ? levelBadge(state.faceit.level, 30) : ""}</div></div>
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
          ${dial(`${Math.round(p.win_rate * 100)}%`, p.win_rate, "Win rate", `${p.wins}-${p.matches - p.wins}`)}
          ${dial(f2(d.rating2), (d.rating2 - 0.4) / 1.2, "Rating 2.0 est.", ratingWord(d.rating2))}
          ${dial(f1(d.rws), d.rws / 20, "RWS", d.rws >= 12 ? "Above average" : d.rws >= 9 ? "Average" : "Below average")}
          <div class="side-dials">
            ${dial(f2(p.t.rating2), (p.t.rating2 - 0.4) / 1.2, "T rating", "", 86)}
            ${dial(f2(p.ct.rating2), (p.ct.rating2 - 0.4) / 1.2, "CT rating", "", 86)}
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
          ["Rating 1.0", f2(d.rating1)], ["Accuracy", `${f1(d.accuracy)}%`], ["Entries", `${c.opening_kills}-${c.opening_deaths}`],
          ["Multi-kills", `${c.multikill_rounds.slice(2).reduce((a, b) => a + b, 0)}`]].map(([l, v]) =>
          `<div class="kpi"><div class="v">${v}</div><div class="l">${l}</div></div>`).join("")}
      </section>
      </div>
    </div>
    <section class="panel form">
      <div class="panel-head"><div class="h2">Form · Rating 2.0 est. per match</div><span class="grow"></span>
        <span class="legend"><i style="background:${WIN}"></i>Win <i style="background:${LOSS}"></i>Loss</span></div>
      ${formChart(p.form)}
    </section>
    ${top.length ? `<section class="profile-top"><div class="hero-head"><div class="h2">Top highlights</div><a class="btn ghost" href="#/highlights">All highlights</a></div>
      <div class="hl-grid">${top.map((h) => cardHtml(h)).join("")}</div></section>` : ""}`;

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
      b.addEventListener("click", () => { const m = summaryOf(b.dataset.m); if (m) location.hash = `#/day/${m.played_at.slice(0, 10)}/m/${encodeURIComponent(m.id)}`; });
    });
  }
  view.querySelectorAll(".profile-top [data-hl]").forEach((c2) => (c2.onclick = () => {
    state.playlist = top.map(toPlayItem);
    play(state.playlist.findIndex((h) => h.id === c2.dataset.hl));
  }));
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
      premier: m.premier ?? null, placement: !!fm?.calibrating,
      room: m.source === "faceit" ? fm?.match_id || m.id.replace(/^faceit-/, "1-").replace(/-m\d+$/, "") : null,
    };
  }).sort((a, b) => b.when - a.when);
}

function historyRow(r) {
  const l = r.line;
  const elo = r.source === "faceit"
    ? r.elo ? `${levelBadge(levelFor(r.elo))}<span>${r.elo.toLocaleString("en-US")}</span>${deltaHtml(r.delta)}` : r.placement ? `<span class="none" title="FACEIT shows no ELO during a new season's placement matches">Placement match</span>` : `<span class="none">–</span>`
    : r.source === "valve"
      ? r.premier ? `${premierChip(r.premier)}${deltaHtml(r.delta)}` : `<span class="none">Unranked</span>`
      : `<span class="none">–</span>`;
  const rating = l?.rating2 != null
    ? `<span class="rchip ${l.rating2 >= 1.3 ? "hi" : ""}" title="HLTV Rating 2.0 (estimated from the demo)">${f2(l.rating2)}<i style="width:${Math.min(100, (l.rating2 / 2) * 100)}%"></i></span>`
    : `<span class="rchip na" title="Needs the demo">–</span>`;
  const actions = r.demo
    ? `<button class="sqbtn ${r.hl ? "hl" : "dim"}" data-act="hl" title="${r.hl ? `${r.hl} highlight${r.hl === 1 ? "" : "s"}` : "No highlights in this match"}">${ICONS.star}${r.hl}</button>`
    : `<button class="sqbtn" data-act="room" title="Download the demo from the match room; Veloxify adds it automatically">${ICONS.download}</button>`;
  return `
    <div class="ml-grid ml-row ${r.result} clickable" data-id="${esc(r.id)}" data-href="#/day/${r.date}/m/${encodeURIComponent(r.id)}" ${r.room ? `data-room="${esc(r.room)}"` : ""}>
      <div class="ml-date">${fcDate(r.when)}</div>
      <div class="ml-score"><span class="wl ${r.result}">${r.result === "win" ? "W" : r.result === "loss" ? "L" : "T"}</span><span><b class="${r.result}">${r.mine}</b> : <span class="theirs">${r.theirs}</span></span></div>
      <div class="ml-elo">${elo}</div>
      <div>${rating}</div>
      <div>${l?.rws != null ? `<span class="ml-num">${f1(l.rws)}</span>` : `<span class="ml-num na">–</span>`}</div>
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
        <div class="fc-filters">
          ${seg("source", [["all", "All"], ["faceit", "FACEIT"], ["valve", "Premier"]])}
          ${seg("result", [["all", "All"], ["win", "Wins"], ["loss", "Losses"]])}
          <select id="mhmap"><option value="all">All maps</option>${maps.map((m) => `<option value="${m}" ${mh.map === m ? "selected" : ""}>${esc(mapName(m))}</option>`).join("")}</select>
        </div>
      </div>
      <div class="ml-grid ml-head">
        <div>Date</div><div>Score</div><div></div><div title="HLTV Rating 2.0, estimated from the demo"><span class="ic">${ICONS.rating}</span>Rating</div>
        <div>RWS</div><div>K/D/A</div><div>ADR</div><div>Map</div><div></div>
      </div>
      ${rows.slice(0, mh.shown).map(historyRow).join("")}
      ${rows.length > mh.shown ? `<div style="text-align:center;margin-top:12px"><button class="btn" id="mhmore">Show more</button></div>` : ""}
      ${missing ? `<div class="ml-note">${missing} FACEIT match${missing === 1 ? "" : "es"} without a demo show FACEIT's stats only. Download a demo from its match room and Veloxify adds the rating, RWS and highlights.</div>` : ""}
    </section>`;
  view.querySelectorAll(".seg[data-mkey]").forEach((el) => el.querySelectorAll("button").forEach((b) => (b.onclick = () => { mh[el.dataset.mkey] = b.dataset.v; mh.shown = 50; renderMatchHistory(view); })));
  view.querySelector("#mhmap").onchange = (e) => { mh.map = e.target.value; mh.shown = 50; renderMatchHistory(view); };
  const more = view.querySelector("#mhmore");
  if (more) more.onclick = () => { mh.shown += 50; renderMatchHistory(view); };
  view.querySelectorAll(".ml-row").forEach((row) => (row.onclick = (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "room") return openFaceitRoom(row.dataset.room);
    if (!row.dataset.href) return;
    location.hash = act === "hl" ? `${row.dataset.href}/highlights` : row.dataset.href;
  }));
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

function filtered() {
  let list = state.index.highlights.filter((h) =>
    inWhen(h) && (browser.source === "all" || h.source === browser.source) && (browser.map === "all" || h.map === browser.map)
    && (!browser.types.length || TYPE_FILTERS.some(([k, , f]) => browser.types.includes(k) && f(h)))
    && (!browser.playableOnly || playable(h)));
  const best = (a, b) => b.hand - a.hand || b.score - a.score;
  if (browser.sort === "best") list.sort(best);
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
    <div class="hl-card ${h.clip ? "" : "pending"} ${big ? "big" : ""}" data-hl="${esc(h.id)}">
      <div class="hl-thumb" style="--map-bg:${mapColor(h.map)};${h.thumb ? `background-image:url('${assetUrl(h.thumb)}')` : ""}">
        ${h.clip ? `<span class="play">▶</span>` : `<span class="state">${h.render_error ? "Demo too old to replay" : "Rendering…"}</span>`}
        <span class="dur">${fmtClip(h.duration_s)}</span>
        <span class="src-chip src ${h.source}">${h.source === "valve" ? "PREMIER" : h.source.toUpperCase()}</span>
      </div>
      <div class="hl-info">
        <div class="hl-title">${esc(h.title)}</div>
        <div class="hl-meta"><span>${esc(mapName(h.map))} · ${h.score_mine}-${h.score_theirs}</span><span>${when}</span></div>
        <div class="tags">${h.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>
      </div>
    </div>`;
}

function renderHighlightsTab(view) {
  const hero = heroPicks();
  const list = filtered();
  const maps = [...new Set(state.index.highlights.map((h) => h.map))].sort();
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
        <label>Source ${seg("source", [["all", "All"], ["faceit", "FACEIT"], ["valve", "Premier"]])}</label>
        <label>Map <select id="map"><option value="all">All maps</option>${maps.map((m) => `<option value="${m}" ${browser.map === m ? "selected" : ""}>${esc(mapName(m))}</option>`).join("")}</select></label>
      </div>
      <div class="controls">
        <div class="chips">${TYPE_FILTERS.map(([k, label]) => `<button class="chip ${browser.types.includes(k) ? "on" : ""}" data-type="${k}">${label}</button>`).join("")}</div>
        <label class="check"><input type="checkbox" id="playable" ${browser.playableOnly ? "checked" : ""}> Playable only</label>
        <span class="grow"></span>
        <span class="sub">${list.length} highlight${list.length === 1 ? "" : "s"}</span>
        <button class="btn ghost" id="reset">Reset filters</button>
      </div>
      <div class="browser-body">${list.length ? grid : `<div class="empty">Nothing matches these filters.</div>`}</div>
    </section>`;

  const rerender = () => { saveBrowser(); renderHighlightsTab(view); };
  view.querySelectorAll(".seg").forEach((el) => el.querySelectorAll("button").forEach((b) => (b.onclick = () => { browser[el.dataset.key] = b.dataset.v; rerender(); })));
  view.querySelectorAll("[data-type]").forEach((b) => (b.onclick = () => {
    const k = b.dataset.type;
    browser.types = browser.types.includes(k) ? browser.types.filter((x) => x !== k) : [...browser.types, k];
    rerender();
  }));
  view.querySelector("#map").onchange = (e) => { browser.map = e.target.value; rerender(); };
  view.querySelector("#playable").onchange = (e) => { browser.playableOnly = e.target.checked; rerender(); };
  view.querySelector("#reset").onclick = () => { browser = { ...BROWSER_DEFAULTS, heroPeriod: browser.heroPeriod }; rerender(); };
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
  { id: "faceit", name: "FACEIT dark", bg: "#0f0f0f", card: "#1c1c1c", accent: "#ff5500" },
  { id: "purple", name: "Purple", bg: "#121019", card: "#211d2e", accent: "#8b5cf6" },
  { id: "csgo", name: "CS:GO classic", bg: "#16191c", card: "#252a2f", accent: "#e9a93a" },
  { id: "cs2", name: "CS2 slate", bg: "#12161b", card: "#222a33", accent: "#7fb2e8" },
  { id: "oled", name: "Pure black", bg: "#000000", card: "#121212", accent: "#ff5500" },
];
function loadTheme() {
  try { return { preset: "faceit", accent: "", ...JSON.parse(localStorage.getItem("veloxify.theme") || "{}") }; } catch (e) { return { preset: "faceit", accent: "" }; }
}
function applyTheme(t) {
  const el = document.documentElement;
  if (t.preset && t.preset !== "faceit") el.dataset.theme = t.preset; else delete el.dataset.theme;
  if (t.accent) el.style.setProperty("--accent", t.accent); else el.style.removeProperty("--accent");
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
  settings: { watch_dirs: ["C:\\Users\\you\\Downloads"], auto_render: true, faceit_enabled: true, faceit_nickname: "", selectivity: "solid-plays", max_per_match: 6, start_with_windows: false, steamid64: null },
  detected_steamid: null, steam_name: null, version: "preview", clips: 0, clip_bytes: 0,
  render: { height: 1080, fps: 60, transition: "cut", hide_fps_counter: true, killfeed_only: true, own_crosshair: false, xray: false, audio: true },
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
    || `<div class="folder sub">No folders. Add your browser's download folder so FACEIT demos are picked up.</div>`;
  view.innerHTML = `
    <div class="profile-head"><div><div class="h2">Veloxify ${esc(settingsData.version)}</div><div class="h1">Settings</div></div><span class="saved" id="saved">Saved</span></div>
    ${tauri ? "" : `<div class="preview-note">Preview: settings can be changed in the desktop app.</div>`}
    <div class="settings">
      <section class="panel">
        <div class="panel-head"><div class="h3">Accounts</div></div>
        ${row("Steam", steamid ? `${esc(settingsData.steam_name || "Logged-in account")} · ${steamid}` : "Log in to Steam so Veloxify knows whose highlights to make.", "")}
        <div id="faceit-account">${faceitAccountRow()}</div>
        ${row("Use FACEIT data", "Level, ELO and your full FACEIT match list, found from your Steam account. No login or API key.", sw("faceit_enabled", s.faceit_enabled))}
        ${row("FACEIT nickname", "Only needed if your account isn't found automatically.", `<input type="text" data-key="faceit_nickname" value="${esc(s.faceit_nickname)}" placeholder="Found automatically" ${tauri ? "" : "disabled"}>`)}
      </section>
      ${appearancePanel()}
      <section class="panel">
        <div class="panel-head"><div class="h3">Highlights</div></div>
        ${row("Make highlights automatically", "After you close CS2, new demos are read and your best moments rendered in the background.", sw("auto_render", s.auto_render))}
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
        ${row("Hide Steam FPS counter", "Covers Steam's in-game FPS counter if you have it on.", sw("hide_fps_counter", r.hide_fps_counter))}
      </section>
      <section class="panel">
        <div class="panel-head"><div class="h3">Demo folders</div><span class="grow"></span>${tauri ? `<button class="btn" id="add-folder">Add folder</button>` : ""}</div>
        <div class="sub" style="padding:0 20px 8px">New demos in these folders are imported automatically.</div>
        ${folders}
        <div class="panel-head" style="border-top:1px solid var(--line);margin-top:12px"><div class="h3">App</div></div>
        ${row("Library", `${settingsData.clips} clips · ${fmtBytes(settingsData.clip_bytes)}`, tauri ? `<button class="btn" id="open-lib">Open folder</button>` : "")}
        ${row("Start with Windows", "Starts in the tray, ready to process your games. It never runs anything while CS2 is open.", sw("start_with_windows", s.start_with_windows))}
      </section>
    </div>`;
  wireAppearance(view); // works in the preview too (saved in this browser)
  if (!tauri) return;

  const RENDER_KEYS = ["height", "fps", "transition", "killfeed_only", "own_crosshair", "xray", "audio", "hide_fps_counter"];
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
  wireFaceitRefresh();
}

function wireFaceitRefresh() {
  const b = document.getElementById("faceit-refresh");
  if (b) b.onclick = () => { b.disabled = true; b.textContent = "Refreshing…"; tauri.core.invoke("refresh_faceit"); };
}

async function saveSettings() {
  const s = settingsData.settings;
  const update = {
    watch_dirs: s.watch_dirs, auto_render: s.auto_render, faceit_enabled: s.faceit_enabled, faceit_nickname: s.faceit_nickname,
    selectivity: s.selectivity, max_per_match: Number(s.max_per_match) || 6, start_with_windows: s.start_with_windows, render: settingsData.render,
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

if (tauri) {
  tauri.core.invoke("get_status").then(showStatus);
  tauri.event.listen("veloxify://status", (e) => showStatus(e.payload));
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
