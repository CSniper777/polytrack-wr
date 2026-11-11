/* ============================================================
   CONFIG
   ============================================================ */
const CONFIG = {
  // Leaderboard proxy — forwards to Kodub's PolyTrack server.
  LEADERBOARD_URL: "https://ptproxy.cwcinc.dev/v6/leaderboard",
  // Bump this whenever PolyTrack ships a new version — the leaderboard
  // API is keyed to it. Check https://kodub.itch.io/polytrack/devlog
  GAME_VERSION: "0.6.0",
  // How many rows to show on a track's page.
  LEADERBOARD_AMOUNT: 10,
  TRACKS_FILE: "tracks.json",

  // How many rows each leaderboard page shows.
  LB_PAGE_SIZE: 100,

  // --- Leaderboard auto-refresh ---
  // The leaderboards are re-downloaded at most this often (and a recent copy
  // is kept in the browser, so reloading the page doesn't download it again).
  LB_REFRESH_MINUTES: 5,
  // If an update fails, try again after this many seconds (old data stays visible).
  LB_RETRY_SECONDS: 60,
  // The Refresh button ignores clicks if the data is newer than this.
  LB_MIN_REFRESH_SECONDS: 30,

  // --- "Maps finished" leaderboard (needs every run on every track) ---
  // Runs requested per API call. 500 is the server's maximum.
  FINISH_PAGE_SIZE: 500,
  // Safety cap so one gigantic track can't trigger endless requests.
  // Normally it stops by itself once it has all of a track's runs ("total").
  FINISH_MAX_RUNS_PER_TRACK: 50000,
  // How many tracks are downloaded at the same time (be nice to the proxy).
  FINISH_CONCURRENCY: 4,
};

/* ============================================================
   TRACK DATA
   Loaded from tracks.json at startup. Each entry needs:
     number   - sequential "map number" used in the URL, e.g. #12
     name     - track name
     author   - creator's name
     date     - date it was posted, "YYYY-MM-DD"
     trackId  - the numeric/string track id used by the leaderboard API
     code     - the track code players paste into PolyTrack's importer
   ============================================================ */
let TRACKS = [];

/* ============================================================
   HELPERS
   ============================================================ */
const app = document.getElementById("app");
const toastEl = document.getElementById("toast");

function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toastEl.classList.remove("show"), 1800);
}

function formatTime(ms) {
  const total = Math.round(ms);
  const m = Math.floor(total / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const msRem = total % 1000;
  return `${m}:${String(s).padStart(2, "0")}.${String(msRem).padStart(3, "0")}`;
}

function formatDate(str) {
  const d = new Date(str);
  if (isNaN(d.getTime())) return str;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (err) {}
    document.body.removeChild(ta);
    return ok;
  }
}

function trackByNumber(num) {
  return TRACKS.find((t) => String(t.number) === String(num));
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* ============================================================
   RENDER: LIST VIEW
   ============================================================ */
function renderList() {
  document.getElementById("trackCount").textContent = TRACKS.length;

  if (TRACKS.length === 0) {
    app.innerHTML = `
      <div class="empty-state">
        <h3>No tracks yet</h3>
        <p>Tracks are gonna be register as Version 0.7.0 comes out!</p>
      </div>
    `;
    return;
  }

  app.innerHTML = `
    <div class="toolbar">
      <div class="search-box">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input id="searchInput" type="text" placeholder="Search by name, author, or track number…" />
      </div>
      <select id="sortSelect">
        <option value="newest">Newest first</option>
        <option value="oldest">Oldest first</option>
        <option value="name">Name A–Z</option>
        <option value="mostPlayed">Most played</option>
        <option value="leastPlayed">Least played</option>
        <option value="shortest">Shortest first</option>
        <option value="longest">Longest first</option>
      </select>
      <button class="btn ghost" id="unbeatenToggle">🏆 Unbeaten only</button>
      <button class="btn ghost" id="randomBtn">🎲 Random track</button>
    </div>
    <div class="track-grid" id="trackGrid"></div>
  `;

  const grid = document.getElementById("trackGrid");
  const searchInput = document.getElementById("searchInput");
  const sortSelect = document.getElementById("sortSelect");
  const unbeatenToggle = document.getElementById("unbeatenToggle");
  let unbeatenOnly = false;

  async function draw() {
    const q = searchInput.value.trim().toLowerCase();
    const sortMode = sortSelect.value;
    const needsStats = unbeatenOnly || ["mostPlayed", "leastPlayed", "shortest", "longest"].includes(sortMode);

    let stats = wrStore.data; // reuse the saved/cached data if we already have it
    if (needsStats && !stats) {
      grid.innerHTML = `<div class="lb-loading">Fetching run data across ${TRACKS.length} track${TRACKS.length === 1 ? "" : "s"}…</div>`;
      stats = await wrStore.ensure();
      // bail out if the user changed search/sort/toggle while this was loading
      if (!document.getElementById("trackGrid") || sortSelect.value !== sortMode || unbeatenToggle.classList.contains("active") !== unbeatenOnly) return;
    }

    let list = TRACKS.filter((t) =>
      !q ||
      t.name.toLowerCase().includes(q) ||
      t.author.toLowerCase().includes(q) ||
      String(t.number) === q
    );

    if (unbeatenOnly) {
      list = list.filter((t) => (stats?.trackTotals[t.number] ?? null) === 0);
    }

    list = list.slice().sort((a, b) => {
      if (sortMode === "newest") return b.number - a.number;
      if (sortMode === "oldest") return a.number - b.number;
      if (sortMode === "name") return a.name.localeCompare(b.name);
      if (sortMode === "mostPlayed") return (stats?.trackTotals[b.number] || 0) - (stats?.trackTotals[a.number] || 0);
      if (sortMode === "leastPlayed") return (stats?.trackTotals[a.number] || 0) - (stats?.trackTotals[b.number] || 0);
      if (sortMode === "shortest" || sortMode === "longest") {
        const fa = stats?.trackBestFrames[a.number];
        const fb = stats?.trackBestFrames[b.number];
        if (fa === undefined && fb === undefined) return 0;
        if (fa === undefined) return 1; // unbeaten tracks sink to the bottom either way
        if (fb === undefined) return -1;
        return sortMode === "shortest" ? fa - fb : fb - fa;
      }
      return 0;
    });

    if (list.length === 0) {
      grid.innerHTML = `<div class="empty-state"><h3>No tracks match${unbeatenOnly ? " — nothing unbeaten right now" : " that search"}</h3><p>${unbeatenOnly ? "Every track currently has at least one finisher." : "Try a different name, author, or number."}</p></div>`;
      return;
    }

    grid.innerHTML = list.map((t) => {
      const plays = stats ? stats.trackTotals[t.number] : undefined;
      const best = stats ? stats.trackBestFrames[t.number] : undefined;
      const metaBits = [`by ${escapeHtml(t.author)}`, formatDate(t.date)];
      if (plays !== undefined) metaBits.push(plays === 0 ? "unbeaten" : `${plays} run${plays === 1 ? "" : "s"}`);
      if (best !== undefined) metaBits.push(formatTime(best));
      return `
        <a class="track-card" href="#${t.number}">
          <div class="track-num mono">#${t.number}</div>
          <div class="track-info">
            <div class="name">${escapeHtml(t.name)}</div>
            <div class="meta">${metaBits.join(" · ")}</div>
          </div>
          <svg class="chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
        </a>
      `;
    }).join("");
  }

  searchInput.addEventListener("input", draw);
  sortSelect.addEventListener("change", draw);
  unbeatenToggle.addEventListener("click", () => {
    unbeatenOnly = !unbeatenOnly;
    unbeatenToggle.classList.toggle("active", unbeatenOnly);
    draw();
  });
  document.getElementById("randomBtn").addEventListener("click", async () => {
    if (TRACKS.length === 0) return;
    if (!unbeatenOnly) {
      const pick = TRACKS[Math.floor(Math.random() * TRACKS.length)];
      location.hash = `#${pick.number}`;
      return;
    }
    const stats = wrStore.data || (await wrStore.ensure());
    const pool = TRACKS.filter((t) => (stats.trackTotals[t.number] ?? null) === 0);
    if (pool.length === 0) {
      showToast("No unbeaten tracks right now");
      return;
    }
    const pick = pool[Math.floor(Math.random() * pool.length)];
    location.hash = `#${pick.number}`;
  });

  draw();
}

/* ============================================================
   RENDER: DETAIL VIEW
   ============================================================ */
function renderDetail(num) {
  const track = trackByNumber(num);

  if (!track) {
    app.innerHTML = `
      <a class="back-link" href="#">← Back to all tracks</a>
      <div class="empty-state">
        <h3>Track #${escapeHtml(String(num))} not found</h3>
        <p>It may not have been added yet, or the number is wrong.</p>
        <div style="margin-top:16px;"><button class="btn ghost" id="backBtn">Back to list</button></div>
      </div>
    `;
    document.getElementById("backBtn").addEventListener("click", () => (location.hash = "#"));
    return;
  }

  app.innerHTML = `
    <a class="back-link" href="#">← Back to all tracks</a>
    <div class="detail-grid">
      <div class="panel">
        <div class="thumb-wrap">
          <img src="${escapeHtml(track.thumbnail || "thumbnails/default.svg")}" alt="${escapeHtml(track.name)} thumbnail"
               onerror="this.onerror=null;this.src='thumbnails/default.svg';">
        </div>
        <h2 class="track-name">${escapeHtml(track.name)}</h2>
        <div class="author">by ${escapeHtml(track.author)}</div>
        <div class="track-num-small mono">#${track.number}</div>

        <div class="field">
          <label>Posted</label>
          <div class="val">${formatDate(track.date)}</div>
        </div>
        <div class="field">
          <label>Track ID</label>
          <div class="val mono">${escapeHtml(track.trackId)}</div>
        </div>
        <div class="field">
          <label>Track code</label>
          <div class="track-code-box">
            <div class="code mono">${escapeHtml(track.code)}</div>
            <button class="btn" id="copyCodeBtn">Copy</button>
          </div>
        </div>

        <button class="btn ghost" id="copyLinkBtn" style="width:100%;justify-content:center;margin-top:8px;">Copy link to this track</button>
      </div>

      <div class="panel" id="lbPanel">
        <div class="lb-header">
          <h3>Leaderboard</h3>
          <span class="lb-status" id="lbStatus">Loading…</span>
        </div>
        <div id="lbBody"></div>
      </div>
    </div>
  `;

  document.getElementById("copyCodeBtn").addEventListener("click", async () => {
    const ok = await copyToClipboard(track.code);
    showToast(ok ? "Track code copied" : "Couldn't copy — select it manually");
  });
  document.getElementById("copyLinkBtn").addEventListener("click", async () => {
    const url = `${location.origin}${location.pathname}#${track.number}`;
    const ok = await copyToClipboard(url);
    showToast(ok ? "Link copied" : "Couldn't copy — copy from the address bar");
  });

  loadLeaderboard(track);
}

async function loadLeaderboard(track) {
  const statusEl = document.getElementById("lbStatus");
  const bodyEl = document.getElementById("lbBody");

  try {
    const url = `${CONFIG.LEADERBOARD_URL}?version=${encodeURIComponent(CONFIG.GAME_VERSION)}&trackId=${encodeURIComponent(track.trackId)}&skip=0&amount=${CONFIG.LEADERBOARD_AMOUNT}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Server responded ${res.status}`);
    const data = await res.json();
    const entries = data.entries || [];

    if (entries.length === 0) {
      statusEl.textContent = "";
      bodyEl.innerHTML = `<p style="color:var(--text-muted);font-size:14px;">No times recorded yet on this track.</p>`;
      return;
    }

    statusEl.textContent = `${data.total ?? entries.length} run${(data.total ?? entries.length) === 1 ? "" : "s"}`;
    bodyEl.innerHTML = `
      <table class="lb">
        <thead><tr><th>#</th><th>Driver</th><th class="date-col">Set</th><th style="text-align:right;">Time</th></tr></thead>
        <tbody>
          ${entries.map((e, i) => `
            <tr class="${i === 0 ? "top1" : i === 1 ? "top2" : i === 2 ? "top3" : ""}" data-user-id="${escapeHtml(e.userId)}">
              <td class="pos">${i + 1}</td>
              <td>${escapeHtml(e.nickname)}</td>
              <td class="date-col">${formatDate(e.time)}</td>
              <td class="time">${formatTime(e.frames)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;
  } catch (err) {
    statusEl.textContent = "";
    bodyEl.innerHTML = `
      <p style="color:var(--err);font-size:14px;margin-bottom:6px;">Couldn't load the live leaderboard.</p>
      <p style="color:var(--text-muted);font-size:13px;">
        This can happen if the PolyTrack server blocks requests from outside the game, or if the
        Track ID / game version above is out of date. You can also check this track's leaderboard
        directly by opening it in PolyTrack.
      </p>
    `;
  }
}

/* ============================================================
   COUNTRY / DATE HELPERS
   ============================================================ */
function countryName(code) {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(String(code).toUpperCase()) || String(code).toUpperCase();
  } catch (e) {
    return String(code).toUpperCase();
  }
}

// Small flag image (flag emoji don't render on Windows, images always do).
function flagHtml(code) {
  if (!code) return "";
  const c = String(code).toLowerCase();
  if (!/^[a-z]{2}$/.test(c)) return "";
  return `<img class="flag" src="https://flagcdn.com/w40/${c}.png" alt="${c.toUpperCase()}" title="${escapeHtml(countryName(c))}" onerror="this.style.display='none'">`;
}

function timeAgo(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const sec = Math.round((d.getTime() - Date.now()) / 1000);
  const units = [["year", 31536000], ["month", 2592000], ["day", 86400], ["hour", 3600], ["minute", 60]];
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [unit, secs] of units) {
    if (Math.abs(sec) >= secs) return rtf.format(Math.round(sec / secs), unit);
  }
  return "just now";
}

/* ============================================================
   GLOBAL WR LEADERBOARD
   Ranks players by how many tracks they currently hold the #1
   spot on, and also records each track's total run count (reused
   by the track list's "Most/least played" sort). Fetches just the
   top run from every track in TRACKS, in parallel, and caches the
   result for the rest of the session.
   ============================================================ */

async function fetchTrackWinner(track) {
  const url = `${CONFIG.LEADERBOARD_URL}?version=${encodeURIComponent(CONFIG.GAME_VERSION)}&trackId=${encodeURIComponent(track.trackId)}&skip=0&amount=1`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const top = (data.entries || [])[0];
  return {
    trackNumber: track.number,
    trackName: track.name,
    total: data.total || 0,
    winner: top
      ? { userId: top.userId, nickname: top.nickname, frames: top.frames, time: top.time, countryCode: top.countryCode || null }
      : null,
  };
}

async function computeWrData() {
  const results = await Promise.allSettled(TRACKS.map((t) => fetchTrackWinner(t)));

  const players = new Map(); // userId -> { userId, nickname, wins: [] }
  const trackTotals = {}; // trackNumber -> total runs
  const trackBestFrames = {}; // trackNumber -> WR time in ms (absent = unbeaten)
  const records = []; // every track's current WR, newest first once sorted
  let failed = 0;

  results.forEach((r) => {
    if (r.status === "rejected") { failed++; return; }
    const info = r.value;
    trackTotals[info.trackNumber] = info.total;

    const w = info.winner;
    if (!w) return;
    trackBestFrames[info.trackNumber] = w.frames;
    if (!players.has(w.userId)) {
      players.set(w.userId, { userId: w.userId, nickname: w.nickname, countryCode: null, wins: [] });
    }
    const p = players.get(w.userId);
    p.nickname = w.nickname; // keep the freshest nickname seen
    if (w.countryCode) p.countryCode = w.countryCode;
    records.push({ trackNumber: info.trackNumber, trackName: info.trackName, userId: w.userId, nickname: w.nickname, countryCode: w.countryCode, frames: w.frames, time: w.time });
    p.wins.push({ trackNumber: info.trackNumber, trackName: info.trackName, frames: w.frames, time: w.time });
  });

  const list = Array.from(players.values()).sort(
    (a, b) => b.wins.length - a.wins.length || a.nickname.localeCompare(b.nickname)
  );
  records.sort((a, b) => new Date(b.time) - new Date(a.time));

  // Countries ranked by how many WRs their players hold.
  const byCountry = new Map();
  let noCountry = 0;
  records.forEach((r) => {
    if (!r.countryCode) { noCountry++; return; }
    const code = r.countryCode.toLowerCase();
    if (!byCountry.has(code)) byCountry.set(code, { code, wrs: 0, holders: new Set() });
    const c = byCountry.get(code);
    c.wrs++;
    c.holders.add(r.userId);
  });
  const countries = Array.from(byCountry.values())
    .map((c) => ({ code: c.code, name: countryName(c.code), wrs: c.wrs, holders: c.holders.size }))
    .sort((a, b) => b.wrs - a.wrs || b.holders - a.holders || a.name.localeCompare(b.name));

  return { players: list, records, countries, noCountry, trackTotals, trackBestFrames, failed, total: TRACKS.length };
}

/* ============================================================
   MAPS-FINISHED LEADERBOARD
   Ranks players by how many tracks they have a time on, then by
   their average rank across those tracks (lower is better).
   Needs EVERY run on every track, so it pages through each track's
   leaderboard. Cached for the rest of the session.
   ============================================================ */

// Page sizes to try, biggest first. If the server rejects a size we step
// down to the next one, and remember whichever size finally worked.
let workingPageSize = null;

function candidatePageSizes() {
  const sizes = [CONFIG.FINISH_PAGE_SIZE, 100, 50, 20, 10]
    .filter((n, i, arr) => n <= CONFIG.FINISH_PAGE_SIZE && arr.indexOf(n) === i)
    .sort((a, b) => b - a);
  return workingPageSize ? sizes.filter((n) => n <= workingPageSize) : sizes;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchRunsPage(track, skip) {
  let lastErr = null;
  for (const size of candidatePageSizes()) {
    const url = `${CONFIG.LEADERBOARD_URL}?version=${encodeURIComponent(CONFIG.GAME_VERSION)}&trackId=${encodeURIComponent(track.trackId)}&skip=${skip}&amount=${size}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(url);
        if (res.status === 429) { // rate limited: wait a bit and retry the same size
          lastErr = new Error("HTTP 429 (rate limited)");
          await sleep(1000 * (attempt + 1));
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status} when asking for ${size} runs`);
        const data = await res.json();
        workingPageSize = size;
        return data;
      } catch (err) {
        lastErr = err;
        break; // not a rate limit: try the next smaller page size
      }
    }
  }
  throw lastErr || new Error("Unknown error");
}

async function fetchAllRuns(track) {
  const runs = [];
  let total = Infinity;
  let skip = 0;
  while (skip < total && skip < CONFIG.FINISH_MAX_RUNS_PER_TRACK) {
    const data = await fetchRunsPage(track, skip);
    total = data.total || 0;
    const entries = data.entries || [];
    if (entries.length === 0) break;
    entries.forEach((e, i) => {
      runs.push({ rank: skip + i + 1, userId: e.userId, nickname: e.nickname, countryCode: e.countryCode || null, frames: e.frames, time: e.time });
    });
    skip += entries.length;
  }
  return { runs, total, truncated: total > skip };
}

async function computeFinishData(onProgress) {
  const players = new Map(); // userId -> { userId, nickname, finishes: [] }
  const queue = TRACKS.slice();
  let failed = 0;
  let truncated = 0;
  let done = 0;
  let firstError = null;

  async function worker() {
    while (queue.length) {
      const track = queue.shift();
      try {
        const { runs, total, truncated: cut } = await fetchAllRuns(track);
        if (cut) truncated++;
        const seen = new Set();
        runs.forEach((r) => {
          if (seen.has(r.userId)) return; // only count a player's best entry once per track
          seen.add(r.userId);
          if (!players.has(r.userId)) {
            players.set(r.userId, { userId: r.userId, nickname: r.nickname, countryCode: null, finishes: [] });
          }
          const p = players.get(r.userId);
          p.nickname = r.nickname;
          if (r.countryCode) p.countryCode = r.countryCode;
          p.finishes.push({
            trackNumber: track.number,
            trackName: track.name,
            rank: r.rank,
            totalRuns: total,
            frames: r.frames,
            time: r.time,
          });
        });
      } catch (err) {
        failed++;
        if (!firstError) firstError = `${track.name}: ${err.message}`;
        console.error(`Maps finished: couldn't load track #${track.number} (${track.name})`, err);
      }
      done++;
      if (onProgress) onProgress(done, TRACKS.length);
    }
  }

  const workers = Math.max(1, Math.min(CONFIG.FINISH_CONCURRENCY, TRACKS.length));
  await Promise.all(Array.from({ length: workers }, worker));

  const list = Array.from(players.values()).map((p) => ({
    ...p,
    avgRank: p.finishes.reduce((sum, f) => sum + f.rank, 0) / p.finishes.length,
  }));
  list.sort(
    (a, b) =>
      b.finishes.length - a.finishes.length ||
      a.avgRank - b.avgRank ||
      a.nickname.localeCompare(b.nickname)
  );
  return { players: list, failed, truncated, firstError, total: TRACKS.length };
}

/* ============================================================
   DATA STORES
   The two big datasets (world-record data and the every-run data used by
   "Maps finished") live in a "store" that:
     - keeps the last good copy, also saved in the browser so reloading the
       page shows it instantly instead of downloading everything again,
     - refreshes it in the background every LB_REFRESH_MINUTES while a
       leaderboard page is open, WITHOUT hiding the current list,
     - keeps the old data if a refresh fails.
   ============================================================ */
const refreshMs = () => CONFIG.LB_REFRESH_MINUTES * 60 * 1000;
const retryMs = () => CONFIG.LB_RETRY_SECONDS * 1000;

// Changes whenever tracks.json or the game version changes, which throws
// away the saved copy (it would be out of date).
function tracksSignature() {
  return CONFIG.GAME_VERSION + "|" + TRACKS.map((t) => `${t.number}:${t.trackId}`).join(",");
}

function makeStore(name, storageKey, compute, serialize, deserialize) {
  const st = {
    name,
    data: null,
    fetchedAt: 0,
    nextAt: 0,
    updating: false,
    progress: null,
    lastError: null,
    changed: true,
    lastJson: null,
    promise: null,
    watch: null, // optional (done, total) callback used by loading screens
  };

  st.restore = function () {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return;
      const obj = JSON.parse(raw);
      if (obj.v !== 1 || obj.sig !== tracksSignature()) return;
      st.data = deserialize(obj.data);
      st.fetchedAt = obj.fetchedAt;
      st.nextAt = st.fetchedAt + refreshMs();
    } catch (e) {
      st.data = null;
    }
  };

  function persist(json) {
    try {
      localStorage.setItem(storageKey, `{"v":1,"sig":${JSON.stringify(tracksSignature())},"fetchedAt":${st.fetchedAt},"data":${json}}`);
    } catch (e) {
      // Storage full or unavailable: the site still works, it just downloads again on reload.
    }
  }

  st.refresh = function () {
    if (st.promise) return st.promise;
    st.updating = true;
    st.progress = null;
    updateTimer();

    st.promise = compute((done, total) => {
      st.progress = { done, total };
      if (st.watch) st.watch(done, total);
      updateTimer();
    })
      .then((fresh) => {
        const old = st.data;
        // Never replace good data with a worse result (e.g. the network dropped mid-update).
        const worse = fresh.total > 0 && (fresh.failed === fresh.total || (old && fresh.failed > old.failed));
        if (old && worse) {
          st.lastError = new Error("Update failed");
          st.nextAt = Date.now() + retryMs();
          st.changed = false;
          return st.data;
        }
        const json = JSON.stringify(serialize(fresh));
        st.changed = json !== st.lastJson;
        st.lastJson = json;
        st.data = fresh;
        st.fetchedAt = Date.now();
        st.lastError = null;
        st.nextAt = st.fetchedAt + (fresh.failed > 0 ? retryMs() : refreshMs());
        persist(json);
        return st.data;
      })
      .catch((err) => {
        console.error(`Couldn't update the ${name} data`, err);
        st.lastError = err;
        st.nextAt = Date.now() + retryMs();
        st.changed = false;
        if (!st.data) throw err;
        return st.data;
      })
      .finally(() => {
        st.updating = false;
        st.progress = null;
        st.promise = null;
        updateTimer();
        onStoreUpdated(st);
      });
    return st.promise;
  };

  // Returns the data we have (even if a little old); only downloads when we have nothing at all.
  st.ensure = async function () {
    if (st.data) return st.data;
    await st.refresh();
    return st.data;
  };

  return st;
}

function serializeFinish(d) {
  return {
    failed: d.failed, truncated: d.truncated, firstError: d.firstError, total: d.total,
    players: d.players.map((p) => [
      p.userId, p.nickname, p.countryCode,
      p.finishes.map((f) => [f.trackNumber, f.rank, f.totalRuns, f.frames, f.time]),
    ]),
  };
}

function deserializeFinish(raw) {
  const names = {};
  TRACKS.forEach((t) => { names[t.number] = t.name; });
  const players = raw.players.map(([userId, nickname, countryCode, fin]) => {
    const finishes = fin.map(([trackNumber, rank, totalRuns, frames, time]) => ({
      trackNumber, trackName: names[trackNumber] || `#${trackNumber}`, rank, totalRuns, frames, time,
    }));
    return { userId, nickname, countryCode, finishes, avgRank: finishes.reduce((sum, f) => sum + f.rank, 0) / finishes.length };
  });
  return { players, failed: raw.failed, truncated: raw.truncated, firstError: raw.firstError, total: raw.total };
}

const wrStore = makeStore("world-record", "ptwr_wr_v1", () => computeWrData(), (d) => d, (d) => d);
const finishStore = makeStore("maps-finished", "ptwr_finish_v1", (onProgress) => computeFinishData(onProgress), serializeFinish, deserializeFinish);

function modeToStore(mode) {
  return mode === "finished" ? finishStore : wrStore;
}

function fmtCountdown(ms) {
  const sec = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

// The little status line above the leaderboard ("Updated 12:03 · next update in 4:32").
function updateTimer() {
  const el = document.getElementById("lbTimer");
  if (!el) return;
  const st = modeToStore(el.dataset.mode);
  el.classList.toggle("is-updating", st.updating);
  if (st.updating) {
    el.textContent = st.progress ? `Updating… ${st.progress.done}/${st.progress.total}` : "Updating…";
  } else if (!st.data) {
    el.textContent = "";
  } else if (st.lastError) {
    el.textContent = `Couldn't update, showing older data · retrying in ${fmtCountdown(st.nextAt - Date.now())}`;
  } else {
    const at = new Date(st.fetchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    el.textContent = `Updated ${at} · next update in ${fmtCountdown(st.nextAt - Date.now())}`;
  }
}

// Called whenever a store finishes updating: redraw the list on screen, in place.
function onStoreUpdated(st) {
  const area = document.getElementById("rankArea");
  if (!area || !st.data || !st.changed) return;
  if (modeToStore(area.dataset.mode) !== st) return;
  showLeaderboard(area.dataset.mode, st.data);
}

// Runs once a second: ticks the countdown and starts the refresh when it hits zero.
// Only refreshes while a leaderboard page is open and the browser tab is visible.
function startScheduler() {
  setInterval(() => {
    updateTimer();
    if (document.visibilityState !== "visible") return;
    const el = document.getElementById("lbTimer");
    if (!el) return;
    const st = modeToStore(el.dataset.mode);
    if (st.data && !st.updating && Date.now() >= st.nextAt) st.refresh().catch(() => {});
  }, 1000);
}

function manualRefresh(mode) {
  const st = modeToStore(mode);
  if (st.updating) return;
  if (st.data && Date.now() - st.fetchedAt < CONFIG.LB_MIN_REFRESH_SECONDS * 1000) {
    showToast("Already up to date");
    return;
  }
  st.refresh().catch(() => {});
}

/* ============================================================
   RENDER: LEADERBOARD VIEW (World records | Maps finished)
   ============================================================ */
function rankClass(i) {
  return i === 0 ? "rank1" : i === 1 ? "rank2" : i === 2 ? "rank3" : "";
}

const LB_MODES = {
  wr: { title: "Most world records", sub: "", placeholder: "Search a player name…" },
  finished: { title: "Most maps finished", sub: "Ties are broken by the lowest average rank.", placeholder: "Search a player name…" },
  countries: { title: "Countries by world records", sub: "Based on the country each record holder has set in game.", placeholder: "Search a country…" },
  latest: { title: "Latest world records", sub: "The most recently set records that are still standing.", placeholder: "Search a player or track…" },
};

// The leaderboard currently on screen: { mode, data }.
// Kept so the search box can re-draw the list without fetching anything again.
let lbView = null;
let lbPage = 0; // current page (0-based) of the leaderboard on screen

function pagerHtml(page, pages, total, size) {
  const opts = Array.from({ length: pages }, (_, i) =>
    `<option value="${i}" ${i === page ? "selected" : ""}>${i * size + 1}–${Math.min((i + 1) * size, total)}</option>`
  ).join("");
  return `
    <div class="pager">
      <button class="btn ghost" data-page-delta="-1" ${page === 0 ? "disabled" : ""}>← Previous</button>
      <label class="pager-info">Showing <select class="lb-select" data-page-select>${opts}</select> of ${total}</label>
      <button class="btn ghost" data-page-delta="1" ${page === pages - 1 ? "disabled" : ""}>Next →</button>
    </div>`;
}

async function renderLeaderboard(mode) {
  const cfg = LB_MODES[mode];
  lbView = null;
  lbPage = 0;
  const tab = (m, label) =>
    `<a class="subtab ${m === mode ? "active" : ""}" href="#leaderboard${m === "wr" ? "" : "/" + m}">${label}</a>`;

  app.innerHTML = `
    <div class="subtabs">
      ${tab("wr", "World records")}${tab("finished", "Maps finished")}${tab("countries", "Countries")}${tab("latest", "Latest records")}
    </div>
    <div class="lb-header">
      <div>
        <h3 style="margin:0;">${cfg.title}</h3>
        ${cfg.sub ? `<div class="lb-sub">${cfg.sub}</div>` : ""}
      </div>
      <div class="lb-actions">
        <span class="lb-timer" id="lbTimer" data-mode="${mode}"></span>
        <button class="btn ghost" id="refreshLbBtn">Refresh</button>
      </div>
    </div>
    <div class="toolbar">
      <div class="search-box">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input id="lbSearch" type="text" placeholder="${cfg.placeholder}" autocomplete="off" />
      </div>
      ${mode === "latest" ? `<select class="lb-select" id="lbSort"><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select>` : ""}
    </div>
    <div id="rankArea" class="lb-loading" data-mode="${mode}"></div>
  `;
  const redrawFromFirstPage = () => { lbPage = 0; drawRankList(); };
  document.getElementById("lbSearch").addEventListener("input", redrawFromFirstPage);
  document.getElementById("lbSort")?.addEventListener("change", redrawFromFirstPage);
  document.getElementById("refreshLbBtn").addEventListener("click", () => manualRefresh(mode));
  await renderLeaderboardView(mode);
}

// Draws the list for the current mode, filtered by the search box.
// Rows keep their real rank even when the list is filtered.
function drawRankList() {
  const area = document.getElementById("rankArea");
  if (!area || !lbView || area.dataset.mode !== lbView.mode) return;
  const { mode, data } = lbView;

  const q = (document.getElementById("lbSearch")?.value || "").trim().toLowerCase();
  const has = (text) => String(text).toLowerCase().includes(q);

  const notes = [];
  if (data.failed > 0) notes.push(`${data.failed} track${data.failed === 1 ? "" : "s"} couldn't be checked (server error) — try Refresh.`);
  if (mode === "finished" && data.truncated > 0) {
    notes.push(`${data.truncated} track${data.truncated === 1 ? " has" : "s have"} more than ${CONFIG.FINISH_MAX_RUNS_PER_TRACK} runs, so only the top ${CONFIG.FINISH_MAX_RUNS_PER_TRACK} finishers were counted there.`);
  }
  if (mode === "countries" && data.noCountry > 0) {
    notes.push(`${data.noCountry} record${data.noCountry === 1 ? " is" : "s are"} held by players who haven't set a country in game, so ${data.noCountry === 1 ? "it isn't" : "they aren't"} counted here.`);
  }
  const notesHtml = notes.map((n) => `<p style="color:var(--text-muted);font-size:12.5px;margin-top:10px;">${n}</p>`).join("");

  let rows = [];
  let noun = "player";

  if (mode === "wr") {
    rows = data.players.map((p, i) => ({ p, rank: i + 1 })).filter(({ p }) => !q || has(p.nickname)).map(({ p, rank }) => `
      <a class="rank-row ${rankClass(rank - 1)}" href="#player/${encodeURIComponent(p.userId)}">
        <div class="rank">${rank}</div>
        <div class="rname">${flagHtml(p.countryCode)}${escapeHtml(p.nickname)}</div>
        <div class="rcount">${p.wins.length}<span>WR${p.wins.length === 1 ? "" : "s"}</span></div>
      </a>`);
  } else if (mode === "finished") {
    rows = data.players.map((p, i) => ({ p, rank: i + 1 })).filter(({ p }) => !q || has(p.nickname)).map(({ p, rank }) => `
      <a class="rank-row ${rankClass(rank - 1)}" href="#finished/${encodeURIComponent(p.userId)}">
        <div class="rank">${rank}</div>
        <div class="rname">${flagHtml(p.countryCode)}${escapeHtml(p.nickname)}</div>
        <div class="ravg">avg rank <b>${p.avgRank.toFixed(2)}</b></div>
        <div class="rcount">${p.finishes.length}<span>/ ${data.total} map${data.total === 1 ? "" : "s"}</span></div>
      </a>`);
  } else if (mode === "countries") {
    noun = "country";
    rows = data.countries.map((c, i) => ({ c, rank: i + 1 })).filter(({ c }) => !q || has(c.name) || has(c.code)).map(({ c, rank }) => `
      <div class="rank-row static ${rankClass(rank - 1)}">
        <div class="rank">${rank}</div>
        <div class="rname">${flagHtml(c.code)}${escapeHtml(c.name)}</div>
        <div class="ravg">${c.holders} player${c.holders === 1 ? "" : "s"}</div>
        <div class="rcount">${c.wrs}<span>WR${c.wrs === 1 ? "" : "s"}</span></div>
      </div>`);
  } else if (mode === "latest") {
    noun = "record";
    const oldestFirst = document.getElementById("lbSort")?.value === "oldest";
    const ordered = oldestFirst ? data.records.slice().reverse() : data.records;
    rows = ordered.filter((r) => !q || has(r.nickname) || has(r.trackName)).map((r) => `
      <a class="wr-row" href="#${r.trackNumber}">
        <div>
          <div class="wname">${escapeHtml(r.trackName)} <span class="wnum">#${r.trackNumber}</span></div>
          <div class="wmeta">${flagHtml(r.countryCode)}<b>${escapeHtml(r.nickname)}</b> · ${formatDate(r.time)} · ${timeAgo(r.time)}</div>
        </div>
        <div class="wtime">${formatTime(r.frames)}</div>
      </a>`);
  }

  area.className = mode === "latest" ? "wr-list" : "rank-list";

  if (rows.length === 0) {
    area.innerHTML = `<div class="empty-state"><h3>No ${noun} matches “${escapeHtml(q)}”</h3><p>Check the spelling, or try a shorter part of the name.</p></div>` + notesHtml;
    return;
  }

  const size = CONFIG.LB_PAGE_SIZE;
  const pages = Math.max(1, Math.ceil(rows.length / size));
  lbPage = Math.min(Math.max(lbPage, 0), pages - 1);
  const pager = pages > 1 ? pagerHtml(lbPage, pages, rows.length, size) : "";
  area.innerHTML = pager + rows.slice(lbPage * size, (lbPage + 1) * size).join("") + pager + notesHtml;

  area.querySelectorAll("[data-page-delta]").forEach((b) =>
    b.addEventListener("click", () => { lbPage += Number(b.dataset.pageDelta); drawRankList(); window.scrollTo(0, 0); })
  );
  area.querySelectorAll("[data-page-select]").forEach((sel) =>
    sel.addEventListener("change", () => { lbPage = Number(sel.value); drawRankList(); window.scrollTo(0, 0); })
  );
}

// Shows data in the list area (or an explanation if there's nothing to show).
function showLeaderboard(mode, data) {
  const area = document.getElementById("rankArea");
  if (!area || area.dataset.mode !== mode) return;

  const emptyState = (html) => {
    lbView = null;
    area.className = "empty-state";
    area.innerHTML = html;
  };

  if (mode === "finished") {
    if (data.failed > 0 && data.failed === data.total) {
      return emptyState(`<h3>Couldn't load any track's runs</h3>
        <p>The leaderboard server returned an error for every track.</p>
        <p class="mono" style="font-size:12px;margin-top:8px;">${escapeHtml(data.firstError || "Unknown error")}</p>
        <p style="margin-top:8px;">Press Refresh to retry, or open DevTools (F12) → Console for details.</p>`);
    }
    if (data.players.length === 0) {
      return emptyState(`<h3>No finished runs yet</h3><p>Once players set times on the archived tracks, they'll show up here.</p>`);
    }
  } else {
    const empty =
      (mode === "wr" && data.players.length === 0) ||
      (mode === "latest" && data.records.length === 0) ||
      (mode === "countries" && data.countries.length === 0);
    if (empty) {
      return emptyState(mode === "countries" && data.records.length > 0
        ? `<h3>No countries yet</h3><p>None of the record holders have set a country in game.</p>`
        : `<h3>No world records found yet</h3><p>Once tracks have runs recorded, they'll show up here.</p>`);
    }
  }

  lbView = { mode, data };
  drawRankList();
}

// Opens a leaderboard: shows what we already have right away (even if a bit old;
// the background refresh will swap in fresh data), or a loading message the very first time.
async function renderLeaderboardView(mode) {
  const st = modeToStore(mode);
  const area = document.getElementById("rankArea");
  if (!area) return;

  if (st.data) {
    showLeaderboard(mode, st.data);
    updateTimer();
    return;
  }

  lbView = null;
  area.className = "lb-loading";
  area.textContent = mode === "finished"
    ? `Fetching every run… 0/${TRACKS.length} tracks done`
    : `Fetching WR holders across ${TRACKS.length} track${TRACKS.length === 1 ? "" : "s"}…`;

  st.watch = (done, total) => {
    const el = document.getElementById("rankArea");
    if (mode === "finished" && el && el.dataset.mode === mode && el.classList.contains("lb-loading")) {
      el.textContent = `Fetching every run… ${done}/${total} track${total === 1 ? "" : "s"} done`;
    }
  };
  try {
    await st.ensure();
  } finally {
    st.watch = null;
  }
  showLeaderboard(mode, st.data);
}

/* ============================================================
   RENDER: PLAYER VIEW (world records)
   ============================================================ */
async function renderPlayer(userId) {
  app.innerHTML = `
    <a class="back-link" href="#leaderboard">← Back to leaderboard</a>
    <div class="lb-loading" id="playerArea">Loading player…</div>
  `;

  const data = await wrStore.ensure();
  const area = document.getElementById("playerArea");
  if (!area) return; // navigated away

  const player = data.players.find((p) => p.userId === userId);

  if (!player) {
    area.className = "empty-state";
    area.innerHTML = `<h3>Player not found</h3><p>They may not hold a WR on any archived track right now.</p>`;
    return;
  }

  const wins = player.wins.slice().sort((a, b) => a.trackNumber - b.trackNumber);

  area.className = "";
  area.innerHTML = `
    <div class="player-header">
      <h2>${flagHtml(player.countryCode)}${escapeHtml(player.nickname)}</h2>
      <span class="wr-count">${wins.length} world record${wins.length === 1 ? "" : "s"}</span>
    </div>
    <div class="wr-list">
      ${wins.map((w) => `
        <a class="wr-row" href="#${w.trackNumber}">
          <div>
            <div class="wname">${escapeHtml(w.trackName)}</div>
            <div class="wmeta">#${w.trackNumber} · ${formatDate(w.time)}</div>
          </div>
          <div class="wtime">${formatTime(w.frames)}</div>
        </a>
      `).join("")}
    </div>
  `;
}

/* ============================================================
   RENDER: PLAYER VIEW (maps finished + rank on each)
   ============================================================ */
async function renderFinishedPlayer(userId) {
  app.innerHTML = `
    <a class="back-link" href="#leaderboard/finished">← Back to maps finished</a>
    <div class="lb-loading" id="playerArea">Loading player…</div>
  `;

  finishStore.watch = (done, total) => {
    const el = document.getElementById("playerArea");
    if (el && el.classList.contains("lb-loading")) el.textContent = `Fetching every run… ${done}/${total} track${total === 1 ? "" : "s"} done`;
  };
  let data;
  try {
    data = await finishStore.ensure();
  } finally {
    finishStore.watch = null;
  }
  const area = document.getElementById("playerArea");
  if (!area) return; // navigated away

  const player = data.players.find((p) => p.userId === userId);

  if (!player) {
    area.className = "empty-state";
    area.innerHTML = `<h3>Player not found</h3><p>They haven't set a time on any archived track.</p>`;
    return;
  }

  const finishes = player.finishes.slice().sort((a, b) => a.trackNumber - b.trackNumber);

  area.className = "";
  area.innerHTML = `
    <div class="player-header">
      <h2>${flagHtml(player.countryCode)}${escapeHtml(player.nickname)}</h2>
      <span class="wr-count">${finishes.length} map${finishes.length === 1 ? "" : "s"} finished · avg rank ${player.avgRank.toFixed(2)}</span>
    </div>
    <div class="wr-list">
      ${finishes.map((f) => `
        <a class="wr-row" href="#${f.trackNumber}">
          <div>
            <div class="wname">${escapeHtml(f.trackName)}</div>
            <div class="wmeta">#${f.trackNumber} · rank <b>${f.rank}</b> of ${f.totalRuns} · ${formatDate(f.time)}</div>
          </div>
          <div class="wtime">${formatTime(f.frames)}</div>
        </a>
      `).join("")}
    </div>
  `;
}

/* ============================================================
   ROUTER
   ============================================================ */
function setActiveTab(hash) {
  const tracksTab = document.getElementById("navTracks");
  const lbTab = document.getElementById("navLeaderboard");
  if (!tracksTab || !lbTab) return;
  const onLeaderboardSide =
    hash === "leaderboard" || hash.startsWith("leaderboard/") ||
    hash.startsWith("player/") || hash.startsWith("finished/");
  tracksTab.classList.toggle("active", !onLeaderboardSide);
  lbTab.classList.toggle("active", onLeaderboardSide);
}

function route() {
  const hash = decodeURIComponent(location.hash.replace("#", "").trim());
  setActiveTab(hash);

  if (!hash) {
    renderList();
  } else if (hash === "leaderboard" || hash.startsWith("leaderboard/")) {
    const mode = hash === "leaderboard" ? "wr" : hash.slice("leaderboard/".length);
    renderLeaderboard(LB_MODES[mode] ? mode : "wr");
  } else if (hash.startsWith("player/")) {
    renderPlayer(hash.slice("player/".length));
  } else if (hash.startsWith("finished/")) {
    renderFinishedPlayer(hash.slice("finished/".length));
  } else {
    renderDetail(hash);
  }
  window.scrollTo(0, 0);
}

/* ============================================================
   STARTUP — load tracks.json, then start the router
   ============================================================ */
async function init() {
  try {
    const res = await fetch(CONFIG.TRACKS_FILE);
    if (!res.ok) throw new Error(`Could not load ${CONFIG.TRACKS_FILE} (${res.status})`);
    TRACKS = await res.json();
  } catch (err) {
    app.innerHTML = `
      <div class="empty-state">
        <h3>Couldn't load ${CONFIG.TRACKS_FILE}</h3>
        <p>
          If you just opened this file directly (file://), your browser is blocking the request.<br>
          Run a local server from this folder — e.g. <code class="mono">python3 -m http.server</code> —
          then open <code class="mono">http://localhost:8000</code>, or upload these files to any web host.
        </p>
      </div>
    `;
    console.error(err);
    return;
  }
  wrStore.restore();
  finishStore.restore();
  startScheduler();
  window.addEventListener("hashchange", route);
  route();
}

init();
