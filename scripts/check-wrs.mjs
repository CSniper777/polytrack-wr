// Checks the world record of every track and posts to a Discord channel when one is beaten.
// Run automatically by GitHub (see .github/workflows/wr-alerts.yml). Needs Node 18+.
//
// How it works:
//  - It remembers the last world record it saw for every track in data/wr-state.json.
//  - Each run it fetches the current #1 time of every track and compares.
//  - A faster time than the remembered one  ->  Discord message.
//  - The very first run (no state file yet) only remembers the records, it posts nothing,
//    so the channel isn't flooded with old records.
//  - Tracks tagged "PF" in tracks.json are ignored (they don't count for world records).

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

// ---------- settings (read from the environment, see the workflow file) ----------
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL || "";
const SITE_URL = (process.env.SITE_URL || "").replace(/\/+$/, "");
const TRACKS_FILE = process.env.TRACKS_FILE || "tracks.json";
const STATE_FILE = process.env.STATE_FILE || "data/wr-state.json";
const SITE_SCRIPT = process.env.SITE_SCRIPT || "script.js";
const SEND_TEST = process.env.SEND_TEST === "true";
const REQUEST_DELAY_MS = Number(process.env.REQUEST_DELAY_MS ?? 400); // pause between tracks
const MAX_ALERTS_PER_RUN = 10;

// The leaderboard address and game version come from the website's own script.js,
// so there is only one place to update when PolyTrack releases a new version.
async function readSiteSetting(name, fallback) {
  if (process.env[name]) return process.env[name];
  try {
    const text = await readFile(SITE_SCRIPT, "utf8");
    const m = text.match(new RegExp(`${name}:\\s*"([^"]+)"`));
    if (m) return m[1];
  } catch { /* fall through */ }
  return fallback;
}

// ---------- small helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function formatTime(ms) {
  const total = Math.round(ms);
  const m = Math.floor(total / 60000);
  const s = Math.floor((total % 60000) / 1000);
  return `${m}:${String(s).padStart(2, "0")}.${String(total % 1000).padStart(3, "0")}`;
}

function formatGap(ms) {
  const total = Math.round(ms);
  const s = Math.floor(total / 1000);
  return `${s}.${String(total % 1000).padStart(3, "0")}s`;
}

const isPF = (t) => Array.isArray(t.tags) && t.tags.some((x) => String(x).trim().toUpperCase() === "PF");

// Stops player names from breaking Discord's formatting.
const escapeMd = (str) => String(str).replace(/([\\*_~`|>])/g, "\\$1");

// "fr" -> flag emoji
function flagEmoji(code) {
  if (!code || !/^[a-z]{2}$/i.test(code)) return "";
  return String.fromCodePoint(...[...code.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)) + " ";
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
}

// ---------- leaderboard ----------
async function fetchTopRun(leaderboardUrl, version, track) {
  const url = `${leaderboardUrl}?version=${encodeURIComponent(version)}&trackId=${encodeURIComponent(track.trackId)}&skip=0&amount=1`;
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const top = (data.entries || [])[0];
      return top
        ? { userId: top.userId, nickname: top.nickname, countryCode: top.countryCode || null, frames: top.frames, time: top.time }
        : null;
    } catch (err) {
      lastErr = err;
      await sleep(1000 * attempt);
    }
  }
  throw lastErr;
}

// ---------- Discord ----------
async function postToDiscord(payload) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(WEBHOOK, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "PolyTrack World Records", allowed_mentions: { parse: [] }, ...payload }),
    });
    if (res.ok) return;
    if (res.status === 429) {
      const body = await res.json().catch(() => ({}));
      await sleep(Math.ceil((body.retry_after ?? 2) * 1000) + 200);
      continue;
    }
    throw new Error(`Discord answered HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  throw new Error("Discord kept rate-limiting the request");
}

function buildEmbed(alert) {
  const { track, cur, prev, type } = alert;
  const who = `${flagEmoji(cur.countryCode)}**${escapeMd(cur.nickname)}**`;
  const description =
    type === "first"
      ? `${who} set the **first time ever** on this track: **${formatTime(cur.frames)}**`
      : `${who} set **${formatTime(cur.frames)}**, ${formatGap(prev.frames - cur.frames)} faster than ${escapeMd(prev.nickname)}'s ${formatTime(prev.frames)}`;
  const embed = {
    title: `🏆 ${type === "first" ? "First record" : "New world record"} on ${track.name} (#${track.number})`,
    description,
    color: 0xff5a36,
    timestamp: cur.time,
    footer: { text: "PolyTrack World Records" },
  };
  if (SITE_URL) embed.url = `${SITE_URL}/#${track.number}`;
  if (SITE_URL && track.thumbnail && /\.(png|jpe?g|gif|webp)$/i.test(track.thumbnail)) {
    embed.thumbnail = { url: `${SITE_URL}/${track.thumbnail}` };
  }
  return embed;
}

// ---------- main ----------
async function main() {
  if (!WEBHOOK) {
    console.error("DISCORD_WEBHOOK_URL is not set. Add it as a repository secret (see the setup steps).");
    process.exit(1);
  }

  if (SEND_TEST) {
    await postToDiscord({
      embeds: [{
        title: "✅ Webhook works",
        description: "World record alerts will show up in this channel.",
        color: 0x3ed598,
        footer: { text: "PolyTrack World Records" },
      }],
    });
    console.log("Test message sent.");
    return;
  }

  const leaderboardUrl = await readSiteSetting("LEADERBOARD_URL", "https://ptproxy.cwcinc.dev/v6/leaderboard");
  const version = await readSiteSetting("GAME_VERSION", "0.6.0");

  const tracks = (await readJson(TRACKS_FILE, [])).filter((t) => t.trackId && !isPF(t));
  const stateFileExisted = (await readJson(STATE_FILE, null)) !== null;
  const state = (await readJson(STATE_FILE, null)) ?? { tracks: {} };
  const firstRun = !stateFileExisted;

  const alerts = [];
  const nextState = { tracks: { ...state.tracks } };
  let failed = 0;

  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i];
    if (i > 0) await sleep(REQUEST_DELAY_MS);

    let cur;
    try {
      cur = await fetchTopRun(leaderboardUrl, version, track);
    } catch (err) {
      failed++;
      console.error(`#${track.number} ${track.name}: couldn't fetch (${err.message}), keeping the old record`);
      continue;
    }

    const prevEntry = state.tracks[track.trackId];
    const meta = { number: track.number, name: track.name };

    if (!prevEntry) {
      // A track we've never seen: just remember it (never alert for old records).
      nextState.tracks[track.trackId] = { ...meta, wr: cur };
      continue;
    }

    const prev = prevEntry.wr;
    if (cur && !prev) {
      alerts.push({ track, cur, prev: null, type: "first" });
    } else if (cur && prev && cur.frames < prev.frames) {
      alerts.push({ track, cur, prev, type: "beaten" });
    } else if (cur && prev && cur.frames > prev.frames) {
      // The old record disappeared (run removed): quietly adopt the new #1, no alert.
      nextState.tracks[track.trackId] = { ...meta, wr: cur };
    } else if (!cur && prev) {
      // Empty answer for a track that had a record: treat as a glitch, keep what we had.
    } else {
      nextState.tracks[track.trackId] = { ...meta, wr: cur ?? prev ?? null };
    }
  }

  // Send the alerts, oldest first. A failed send keeps the old state so it is retried next run.
  alerts.sort((a, b) => new Date(a.cur.time) - new Date(b.cur.time));
  const toSend = firstRun ? [] : alerts.slice(0, MAX_ALERTS_PER_RUN);
  const skipped = firstRun ? 0 : Math.max(0, alerts.length - MAX_ALERTS_PER_RUN);

  if (firstRun) {
    for (const a of alerts) nextState.tracks[a.track.trackId] = { number: a.track.number, name: a.track.name, wr: a.cur };
  }

  let sent = 0;
  for (const a of toSend) {
    try {
      await postToDiscord({ embeds: [buildEmbed(a)] });
      nextState.tracks[a.track.trackId] = { number: a.track.number, name: a.track.name, wr: a.cur };
      sent++;
      await sleep(600);
    } catch (err) {
      console.error(`Couldn't post the alert for #${a.track.number}: ${err.message} (will retry next run)`);
    }
  }
  if (skipped > 0) {
    try {
      await postToDiscord({ content: `…and ${skipped} more new record${skipped === 1 ? "" : "s"}. Check the site for the full list.` });
      for (const a of alerts.slice(MAX_ALERTS_PER_RUN)) {
        nextState.tracks[a.track.trackId] = { number: a.track.number, name: a.track.name, wr: a.cur };
      }
    } catch (err) {
      console.error(`Couldn't post the summary message: ${err.message}`);
    }
  }

  await mkdir(dirname(STATE_FILE), { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(nextState, null, 2) + "\n");

  console.log(
    `${tracks.length} track(s) checked, ${failed} failed, ${sent} alert(s) sent` +
    (firstRun ? " (first run: records remembered, nothing posted)" : "")
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
