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

const state = { index: null, matches: new Map(), month: null, playlist: [], playing: -1 };

// ---- data ----------------------------------------------------------------------------------------

async function loadIndex() {
  const res = await fetch(assetUrl("index.json"), { cache: "no-store" });
  if (!res.ok) throw new Error(`index.json: ${res.status}`);
  state.index = await res.json();
}

async function loadMatch(id, fresh = false) {
  if (fresh || !state.matches.has(id)) {
    const res = await fetch(assetUrl(`matches/${id}.json`), { cache: "no-store" });
    state.matches.set(id, await res.json());
  }
  return state.matches.get(id);
}

const dayOf = (date) => state.index.days.find((d) => d.date === date);
const summaryOf = (id) => state.index.matches.find((m) => m.id === id);
const dayMatchIds = (day) => day.sessions.flatMap((s) => s.match_ids);

// ---- formatting ----------------------------------------------------------------------------------

const MAPS = {
  de_mirage: ["Mirage", "#8a5a2b"], de_inferno: ["Inferno", "#8c3b2a"], de_nuke: ["Nuke", "#3c6e8f"],
  de_ancient: ["Ancient", "#3f6b3a"], de_anubis: ["Anubis", "#9b7a3c"], de_dust2: ["Dust II", "#a8844c"],
  de_train: ["Train", "#55606b"], de_overpass: ["Overpass", "#4f6e5a"], de_vertigo: ["Vertigo", "#4a5d8f"],
  de_office: ["Office", "#5d6670"], cs_italy: ["Italy", "#8b6a4a"],
};
const mapName = (m) => (MAPS[m] ? MAPS[m][0] : m.replace(/^(de|cs)_/, ""));
const mapColor = (m) => (MAPS[m] ? MAPS[m][1] : "#3b4652");

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const parseLocal = (s) => new Date(s); // backend writes local time without offset
const fmtTime = (s) => parseLocal(s).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const fmtDate = (d) => new Date(`${d}T12:00:00`).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
const fmtDur = (s) => `${Math.round(s / 60)} min`;
const fmtClip = (s) => { const t = Math.round(s); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`; };
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const f1 = (x) => x.toFixed(1);
const f2 = (x) => x.toFixed(2);
const ratingClass = (r) => (r >= 1.1 ? "good" : r < 0.9 ? "bad" : "");
const resultWord = (r) => ({ win: "Victory", loss: "Defeat", tie: "Tied" }[r] || r);
const sum = (a) => a.reduce((x, y) => x + y, 0);

function relDay(date) {
  const today = iso(new Date());
  const y = new Date(); y.setDate(y.getDate() - 1);
  if (date === today) return "Today";
  if (date === iso(y)) return "Yesterday";
  return new Date(`${date}T12:00:00`).toLocaleDateString([], { month: "short", day: "numeric" });
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
    const last = state.index.days[state.index.days.length - 1];
    if (last) { location.hash = `#/day/${last.date}`; return; }
  }
  if (parts[0] === "settings") return renderSettings(view);
  document.querySelector('[data-nav="home"]').classList.add("active");
  renderHome(view);
}

// ---- home: calendar + latest session -----------------------------------------------------------

function renderHome(view) {
  const days = new Map(state.index.days.map((d) => [d.date, d]));
  if (!state.month) {
    const last = state.index.days[state.index.days.length - 1];
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
  const day = state.index.days[state.index.days.length - 1];
  if (!day) return `<section class="panel latest"><div class="empty">No matches yet</div></section>`;
  const me = day.players.find((p) => p.is_me);
  const w = sum(day.sessions.map((s) => s.wins)), l = sum(day.sessions.map((s) => s.losses));
  const party = day.players.filter((p) => !p.is_me).map((p) => esc(p.name)).join(", ") || "Solo";
  return `
    <section class="panel latest">
      <div class="panel-head"><div class="h2">Latest session</div><div class="h1">${relDay(day.date)}</div><div class="sub">${fmtDate(day.date)}</div></div>
      <div class="latest-body">
        <div class="kpis">
          <div class="kpi"><div class="v">${w}-${l}</div><div class="l">Record</div></div>
          <div class="kpi"><div class="v rating ${ratingClass(me.derived.rating2)}">${f2(me.derived.rating2)}</div><div class="l">Rating 2.0 est.</div></div>
          <div class="kpi"><div class="v">${f1(me.derived.adr)}</div><div class="l">ADR</div></div>
        </div>
        <div class="sub">Party: ${party}</div>
        <div class="sub"><span class="star">★</span> ${day.highlight_count} highlights</div>
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
      <a class="mcard ${m.result} ${id === matchId ? "selected" : ""}" href="#/day/${date}/m/${encodeURIComponent(id)}">
        <div class="map-tile" style="--map-bg:${mapColor(m.map)}">${esc(mapName(m.map))}</div>
        <div>
          <div class="mscore">${m.score_mine}<span class="sep">-</span>${m.score_theirs} <span class="src ${m.source}">${m.source === "valve" ? "PREMIER" : m.source.toUpperCase()}</span></div>
          <div class="mmeta">${relDay(date)}, ${fmtTime(m.played_at)}</div>
          <div class="mres ${m.result}">${resultWord(m.result)}${m.highlight_count ? `<span class="hl-badge">★ ${m.highlight_count}</span>` : ""}</div>
        </div>
      </a>`;
  }).join("");
  const w = sum(day.sessions.map((s) => s.wins)), l = sum(day.sessions.map((s) => s.losses));
  view.innerHTML = `
    <a class="day-back" href="#/">◀ Calendar</a>
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
  body.innerHTML = `
    <div class="h2" style="margin-bottom:10px">You${day.players.length > 1 ? " and your party" : ""}</div>
    <table class="sb">
      <thead><tr><th>Player</th><th>Maps</th><th>W-L</th><th>Rating 2.0*</th><th>K-D</th><th>K/D</th><th>ADR</th><th>KAST</th><th>HS%</th><th>Entries</th><th>Clutches</th><th>Multi-kills</th><th>Rating 1.0</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="note">*Rating 2.0 est. uses the public community approximation of HLTV's formula; Rating 1.0 is HLTV's exact published formula.
    Party = teammates who played at least two of the session's matches with you. Totals are summed across matches before rates are computed.</div>`;
}

// ---- match view ---------------------------------------------------------------------------------

async function renderMatch(el, date, id, tab) {
  const m = await loadMatch(id);
  el.innerHTML = `
    <div class="match-head">
      <div class="map-tile" style="--map-bg:${mapColor(m.map)}">${esc(mapName(m.map))}</div>
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

// ---- settings -----------------------------------------------------------------------------------

function renderSettings(view) {
  document.querySelector('[data-nav="settings"]').classList.add("active");
  view.innerHTML = `
    <section class="panel"><div class="panel-head"><div class="h1">Settings</div></div>
      <div class="dbody sub">Render profiles, demo sources (FACEIT / Premier), storage and processing schedule will live here.</div>
    </section>`;
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
    : st.state === "waiting" ? "CS2 running · waiting"
    : st.state === "error" ? "Needs attention" : "Up to date";
  el.title = st.message || "";
}

if (tauri) {
  tauri.core.invoke("get_status").then(showStatus);
  tauri.event.listen("veloxify://status", (e) => showStatus(e.payload));
  let pendingReload = false;
  const reload = () => {
    if (!document.getElementById("player").hidden) { pendingReload = true; return; } // don't disturb a playing clip
    state.index = null;
    state.matches.clear();
    route();
  };
  tauri.event.listen("veloxify://library", reload);
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
