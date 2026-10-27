// TOPCORNER Flashscore harvester.
// Runs on GitHub Actions (or locally) with Playwright/Chromium.
// It NEVER posts to any endpoint: it writes one JSON payload file per run
// to out/ and updates state.json. Posting is a separate, later step.
//
// Flow per run:
//   1. Fetch the TOPCORNER board for yesterday/today/tomorrow (session
//      cookie first, then board, sequential, never parallel).
//   2. For each FINISHED match not already in state.json: resolve its
//      Flashscore URL (mapping.json, then state.discovered, then a
//      schedule-page discovery fallback) and extract summary timeline,
//      referee/venue/capacity/attendance, full stats groups, lineups,
//      missing players, coaches, and player-stat rows.
//   3. For each UPCOMING match today: extract odds with bookmaker names
//      exactly as displayed (never invent a bookmaker or a price).
//   4. Validate every entry (per-entry filtering: a bad entry is dropped
//      and reported, good siblings are kept) and write the payload file.
//   5. Update state.json (harvested finished keys, discovered URLs,
//      unresolved fixtures) so re-runs skip finished work.
//
// This script runs on runners with clean egress. It cannot be live-tested
// from the author's VM (which cannot reach Flashscore), so every page
// interaction is defensive: timeouts, one retry on navigation, and a
// per-match try/catch so one failure never kills the run. Fields that
// cannot be read are null, never invented.

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeName,
  buildKey,
  resolveMatchUrl,
  isFinished,
  isUpcoming,
  dayStr,
  parseStatLines,
  parseTimelineLine,
  filterBatch,
} from "./lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE_URL = process.env.SITE_URL || "https://topcorner.bricoamgoun.com";
const TIME_ZONE = process.env.TIME_ZONE || "Africa/Casablanca";
const STATE_PATH = path.join(HERE, "state.json");
const MAPPING_PATH = path.join(HERE, "mapping.json");
const OUT_DIR = path.join(HERE, "out");
const PAGE_TIMEOUT_MS = 60000;

const STAT_LABELS = [
  "Expected goals (xG)",
  "xG on target (xGOT)",
  "Expected assists (xA)",
  "Goals prevented",
  "Ball possession",
  "Big chances",
  "Touches in opposition box",
  "Total shots",
  "Shots on target",
  "Shots off target",
  "Blocked shots",
  "Shots inside the box",
  "Shots outside the box",
  "Hit the woodwork",
  "Headed goals",
  "Corner kicks",
  "Free kicks",
  "Offsides",
  "Passes",
  "Accurate passes",
  "Long passes",
  "Accurate long passes",
  "Passes in final third",
  "Accurate passes in final third",
  "Crosses",
  "Accurate crosses",
  "Key passes",
  "Throw-ins",
  "Fouls",
  "Duels won",
  "Tackles",
  "Tackles won",
  "Interceptions",
  "Clearances",
  "Errors leading to shot",
  "Errors leading to goal",
  "Goalkeeper saves",
  "xGOT faced",
  "Goals conceded",
  "Goal kicks",
  "Big chances scored",
  "Big chances missed",
];

function loadJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

// ---- Board fetching (native fetch, cookie jar by hand) -------------------
async function fetchBoard(date) {
  const sessionRes = await fetch(`${SITE_URL}/api/session`, {
    signal: AbortSignal.timeout(15000),
  });
  if (!sessionRes.ok) throw new Error(`session ${sessionRes.status}`);
  const setCookie = sessionRes.headers.getSetCookie
    ? sessionRes.headers.getSetCookie()
    : [];
  const cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
  const res = await fetch(`${SITE_URL}/api/board?date=${date}`, {
    headers: {
      Cookie: cookie,
      Origin: SITE_URL,
      Referer: `${SITE_URL}/`,
    },
    signal: AbortSignal.timeout(40000),
  });
  if (!res.ok) throw new Error(`board ${date} ${res.status}`);
  const json = await res.json();
  const matches = (json && json.data && json.data.matches) || [];
  return matches;
}

// ---- Small text parsers --------------------------------------------------
function parseMatchInfo(text) {
  const pick = (re) => {
    const m = text.match(re);
    return m ? m[1].trim() : null;
  };
  const num = (re) => {
    const v = pick(re);
    if (!v) return null;
    const n = Number(v.replace(/\s/g, ""));
    return Number.isFinite(n) ? n : null;
  };
  return {
    referee: pick(/REFEREE:\s*([^\n]+)/i),
    venue: pick(/VENUE:\s*([^\n]+)/i),
    capacity: num(/CAPACITY:\s*([\d\s]+)/i),
    attendance: num(/ATTENDANCE:\s*([\d\s]+)/i),
  };
}

function parseTimeline(text) {
  const events = [];
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim();
    const parsed = parseTimelineLine(line);
    if (!parsed) continue;
    let team = null;
    let player = null;
    let detail = parsed.text;
    const teamHint = parsed.text.match(/\(([^)]+)\)\s*$/);
    if (teamHint && parsed.type !== "goal") {
      team = teamHint[1];
      detail = parsed.text.replace(/\s*\([^)]+\)\s*$/, "").trim();
    }
    if (parsed.type === "goal") {
      const gm = parsed.text.match(/^\d+\s*-\s*\d+\s+(.+?)(?:\s*\(assist\s+([^)]+)\))?\s*$/);
      if (gm) {
        player = gm[1];
        detail = gm[2] ? `assist ${gm[2]}` : null;
      }
    } else if (parsed.type === "yellow" || parsed.type === "red") {
      const cm = parsed.text.match(/^(.+?)\s*-\s*(?:yellow|red) card\s*(?:\(([^)]+)\))?/i);
      if (cm) {
        player = cm[1].replace(/\s*\([^)]+\)\s*$/, "").trim();
        detail = cm[2] || null;
      }
    } else if (parsed.type === "substitution") {
      const sm = parsed.text.match(/^(.+?)\s+in,\s*(.+?)\s+out/i);
      if (sm) {
        player = sm[1];
        detail = `replaces ${sm[2]}`;
      }
    }
    events.push({
      minute: parsed.minute,
      type: parsed.type,
      team,
      player,
      detail,
    });
  }
  return events;
}

function parseLineupsSection(text) {
  const out = {
    home: { formation: null, xi: null, subs: null, bench: null },
    away: { formation: null, xi: null, subs: null, bench: null },
  };
  const formations = [...String(text || "").matchAll(/(?<!\d)(\d-\d-\d)(?!\d)/g)].map(
    (m) => m[1]
  );
  if (formations[0]) out.home.formation = formations[0];
  if (formations[1]) out.away.formation = formations[1];
  const missing = [];
  const missIdx = text.search(/MISSING PLAYERS/i);
  if (missIdx >= 0) {
    const chunk = text.slice(missIdx, missIdx + 2000);
    for (const raw of chunk.split("\n").slice(1, 40)) {
      const line = raw.trim();
      if (!line) continue;
      if (/^(COACH|MARKET VALUE|AGE|HEIGHT|AVG\. RATING|SUBSTITUTES)/i.test(line)) break;
      const m = line.match(/^(.+?)\s*[—–-]\s*(.+)$/);
      if (m) missing.push({ player: m[1].trim(), reason: m[2].trim(), team: null });
    }
  }
  const coachMatch = text.match(/COACHES?:\s*([^\n]+)/i);
  const coaches = coachMatch ? coachMatch[1].split("/").map((s) => s.trim()) : [];
  return {
    lineups: out,
    missing,
    coaches: { home: coaches[0] || null, away: coaches[1] || null },
  };
}

// ---- Page extraction (all best-effort, nulls on absence) -----------------
async function gotoWithRetry(page, url) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT_MS });
    return true;
  } catch {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT_MS });
      return true;
    } catch {
      return false;
    }
  }
}

function statsUrlOf(matchUrl) {
  const m = String(matchUrl || "").match(/^(https:\/\/www\.flashscore\.com\/match\/[^?]+)\?mid=([^&]+)/);
  if (!m) return null;
  return `${m[1]}/summary/stats/overall/?mid=${m[2]}`;
}

async function extractFinished(page, matchUrl) {
  const result = {
    xgHome: null,
    xgAway: null,
    stats: null,
    events: null,
    lineups: null,
    missing: null,
    coaches: null,
    referee: null,
    venue: null,
    capacity: null,
    attendance: null,
  };
  if (!(await gotoWithRetry(page, matchUrl))) return result;
  await page.waitForTimeout(3000).catch(() => {});
  const mainText = await page.evaluate(() => document.body.innerText).catch(() => "");
  result.events = parseTimeline(mainText);
  const info = parseMatchInfo(mainText);
  Object.assign(result, info);
  const lineupInfo = parseLineupsSection(mainText);
  result.lineups = lineupInfo.lineups;
  result.missing = lineupInfo.missing;
  result.coaches = lineupInfo.coaches;
  const statsUrl = statsUrlOf(matchUrl);
  if (statsUrl && (await gotoWithRetry(page, statsUrl))) {
    await page.waitForTimeout(3000).catch(() => {});
    const statsText = await page.evaluate(() => document.body.innerText).catch(() => "");
    const lines = statsText.split("\n");
    const parsed = parseStatLines(lines, STAT_LABELS);
    if (parsed && Object.keys(parsed).length > 0) {
      result.stats = parsed;
      if (parsed.xg) {
        result.xgHome = parsed.xg.home;
        result.xgAway = parsed.xg.away;
      }
    }
  }
  return result;
}

async function clickTab(page, label) {
  const candidates = page.getByText(label, { exact: false });
  const count = await candidates.count().catch(() => 0);
  for (let i = 0; i < Math.min(count, 5); i++) {
    try {
      await candidates.nth(i).click({ timeout: 5000 });
      await page.waitForTimeout(2500);
      return true;
    } catch {
      // try the next matching element
    }
  }
  return false;
}

// Odds tables: group rows by bookmaker, keyed by market heading text.
// Only rows actually present on the page are recorded; nothing is guessed.
async function extractOdds(page, matchUrl) {
  if (!(await gotoWithRetry(page, matchUrl))) return null;
  await page.waitForTimeout(3000).catch(() => {});
  await clickTab(page, "ODDS");
  const tables = await page
    .$$eval("table", (els) =>
      els.map((t) => {
        const rows = [...t.querySelectorAll("tr")].map((r) =>
          [...r.querySelectorAll("th,td")].map((c) => (c.innerText || "").trim())
        );
        return rows.filter((r) => r.some((c) => c !== ""));
      })
    )
    .catch(() => []);
  const byBookmaker = new Map();
  for (const rows of tables) {
    if (rows.length < 2) continue;
    const header = rows[0].join(" ").toLowerCase();
    let market = null;
    if (header.includes("1") && header.includes("x") && header.includes("2")) market = "1X2";
    else if (header.includes("over") && header.includes("under")) market = "overUnder";
    else if (header.includes("both teams")) market = "btts";
    else if (header.includes("double chance")) market = "doubleChance";
    else if (header.includes("asian")) market = "asianHandicap";
    else if (header.includes("draw no bet")) market = "drawNoBet";
    else if (header.includes("correct score")) market = "correctScore";
    else if (header.includes("half time")) market = "halfTimeFullTime";
    else if (header.includes("odd") && header.includes("even")) market = "oddEven";
    if (!market) continue;
    for (const row of rows.slice(1)) {
      const name = row[0];
      if (!name || name === "-") continue;
      const prices = row.slice(1).map((p) => {
        const n = Number(p);
        return Number.isFinite(n) ? n : p;
      });
      if (!byBookmaker.has(name)) byBookmaker.set(name, {});
      byBookmaker.get(name)[market] = prices;
    }
  }
  if (byBookmaker.size === 0) return null;
  const bookmakers = [...byBookmaker.entries()].map(([name, markets]) => ({ name, markets }));
  return { bookmakers };
}

// Discovery fallback: scan the Flashscore football schedule page for links
// whose href or text matches both team names. The exact schedule-page URL
// is the one unverified item in this script (see README): if it changes,
// mapping.json stays the reliable path and fixtures land in `unresolved`.
async function discoverMatchUrl(page, fixture) {
  try {
    const ok = await gotoWithRetry(page, "https://www.flashscore.com/football/");
    if (!ok) return null;
    await page.waitForTimeout(4000).catch(() => {});
    const links = await page
      .$$eval('a[href*="/match/football/"]', (els) =>
        els.map((a) => ({ href: a.href, text: (a.innerText || "").trim() }))
      )
      .catch(() => []);
    const home = normalizeName(fixture.home);
    const away = normalizeName(fixture.away);
    for (const l of links) {
      const hay = `${normalizeName(l.text)} ${normalizeName(l.href)}`;
      if (hay.includes(home) && hay.includes(away)) return l.href;
    }
    return null;
  } catch {
    return null;
  }
}

// ---- Main ------------------------------------------------------------------
async function main() {
  const mapping = loadJson(MAPPING_PATH, { version: 1, aliases: {}, matches: {} });
  const state = loadJson(STATE_PATH, {
    version: 1,
    lastRun: null,
    harvested: [],
    discovered: {},
    pending: [],
  });
  const harvestedSet = new Set(state.harvested || []);
  const dates = [dayStr(-1, TIME_ZONE), dayStr(0, TIME_ZONE), dayStr(1, TIME_ZONE)];
  const fixtures = [];
  let boardsOk = 0;
  for (const date of dates) {
    try {
      const matches = await fetchBoard(date);
      boardsOk++;
      for (const m of matches) fixtures.push({ ...m, boardDate: date });
    } catch (err) {
      console.error(`board ${date} failed: ${err.message}`);
    }
  }
  if (boardsOk === 0) {
    console.error("no board could be fetched; aborting run");
    process.exit(1);
  }

  const entries = [];
  const unresolved = [];
  const skipped = [];
  let browser = null;
  let page = null;
  const needBrowser = fixtures.some(
    (f) => (isFinished(f) && !harvestedSet.has(buildKey(f.boardDate, f.home.name, f.away.name))) ||
      (isUpcoming(f) && f.boardDate === dates[1])
  );
  if (needBrowser) {
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    const context = await browser.newContext();
    page = await context.newPage();
  }

  try {
    for (const f of fixtures) {
      const date = f.boardDate;
      const home = f.home && f.home.name;
      const away = f.away && f.away.name;
      if (!home || !away) continue;
      const fixture = { date, home, away, league: f.league, leagueName: f.leagueName };
      try {
        if (isFinished(f)) {
          const key = buildKey(date, home, away);
          if (harvestedSet.has(key)) {
            skipped.push(key);
            continue;
          }
          let url = resolveMatchUrl(fixture, mapping, state);
          if (!url && page) {
            url = await discoverMatchUrl(page, fixture);
            if (url) state.discovered[key] = url;
          }
          if (!url) {
            unresolved.push({ ...fixture, reason: "no flashscore url (mapping + discovery missed)" });
            continue;
          }
          const data = await extractFinished(page, url);
          entries.push({
            date,
            home,
            away,
            xgHome: data.xgHome,
            xgAway: data.xgAway,
            source: "flashscore",
            matchUrl: url,
            stats: data.stats,
            events: data.events,
            lineups: data.lineups,
            missing: data.missing,
            coaches: data.coaches,
            referee: data.referee,
            venue: data.venue,
            capacity: data.capacity,
            attendance: data.attendance,
            odds: null,
          });
          harvestedSet.add(key);
        } else if (isUpcoming(f) && date === dates[1]) {
          let url = resolveMatchUrl(fixture, mapping, state);
          if (!url && page) {
            url = await discoverMatchUrl(page, fixture);
            if (url) state.discovered[buildKey(date, home, away)] = url;
          }
          if (!url) {
            unresolved.push({ ...fixture, reason: "no flashscore url for odds" });
            continue;
          }
          const odds = await extractOdds(page, url);
          entries.push({
            date,
            home,
            away,
            xgHome: null,
            xgAway: null,
            source: "flashscore",
            matchUrl: url,
            stats: null,
            events: null,
            lineups: null,
            missing: null,
            coaches: null,
            referee: null,
            venue: null,
            capacity: null,
            attendance: null,
            odds,
          });
        }
      } catch (err) {
        console.error(`fixture ${date} ${home} vs ${away} failed: ${err.message}`);
        unresolved.push({ ...fixture, reason: `extraction error: ${err.message}` });
      }
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  const { valid, rejected } = filterBatch(entries);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const payload = {
    generatedAt: new Date().toISOString(),
    runDates: dates,
    matches: valid,
    meta: {
      totalFixtures: fixtures.length,
      skippedFinished: skipped.length,
      rejected,
      unresolved,
    },
  };
  const outPath = path.join(OUT_DIR, `payload-${stamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  state.lastRun = new Date().toISOString();
  state.harvested = [...harvestedSet];
  state.pending = unresolved;
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  console.log(
    `run done: ${valid.length} valid, ${rejected.length} rejected, ${unresolved.length} unresolved, ${skipped.length} skipped -> ${outPath}`
  );
}

main().catch((err) => {
  console.error(`fatal: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
