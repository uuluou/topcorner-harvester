// TOPCORNER Flashscore harvester (patched).
// Runs on GitHub Actions (or locally) with Playwright/Chromium.
// It writes one JSON payload file per run to out/ and updates state.json.
// Posting is done by post-step.mjs (a separate workflow step), which reads
// the POST response {data:{stored, failed}} and amends state.json BEFORE
// the workflow commits it: harvested-marking is gated on stored == sent,
// and upcoming-odds hashes are applied only on post success. The harvester
// itself therefore NEVER trusts a mark it has not seen confirmed.
//
// Flow per run:
//   1. One session cookie, then the TOPCORNER board for yesterday/today/
//      tomorrow (sequential, never parallel, no Origin/Referer headers:
//      the worker gate rejects a pages.dev Origin and passes on cookie).
//   2. For each FINISHED match already in state.json: VERIFY-BEFORE-SKIP
//      via a sessioned model-route read. A row that is absent, or carries
//      neither xG nor any stats (the poisoned-row signature), is unmarked
//      for re-harvest. There is NO terminal give-up: attempts are counted
//      for logging only and a row leaves the retry pool ONLY when storage
//      is verified (post-step read-back). Legacy rows the old code
//      accepted-at-cap re-queue automatically on load (see
//      requeueLegacyCapped in lib.mjs).
//   3. For each unharvested FINISHED match: resolve its Flashscore URL
//      (mapping.json, then state.discovered, then schedule-page discovery
//      with spelling variants) and extract the FULL inventory: full stats
//      page groups (overall + halves), xG/xGOT/xA/goals prevented,
//      lineups (formations, XI with shirt/name/(G)/(C)/rating, used subs
//      with replaced+minute, bench, coaches, missing players only when the
//      section exists), player-stat tables (all categories), events by
//      half, match info, and 1X2 full-time odds.
//   4. For each UPCOMING match today: extract 1X2 full-time odds and post
//      them ONLY when their content hash differs from the last posted hash
//      (change detection kills the every-10-minutes rewrite blowup).
//   5. Clean (worker-mirror null rules), compact to the 256KB entry budget
//      (never dropping xG/formations/ratings/events), validate the whole
//      batch, and write the payload file + a post manifest in its meta.
//      Finished entries that extracted nothing (no stats, xG, events, or
//      lineups) are rejected here as "empty extraction": they stay pooled
//      for retry and are never posted or marked harvested.
//
// Extraction anchors: href patterns, heading/section text, table thead/tbody
// structure, document order. NEVER CSS class names. Fields that cannot be
// read are null/omitted, never invented. Every page interaction is
// defensive: timeouts, one retry on navigation, per-match try/catch.

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeName,
  buildKey,
  resolveMatchUrl,
  linkMatchesFixture,
  nameVariants,
  isFinished,
  isUpcoming,
  dayStr,
  parseTimelineLine,
  groupStatsRows,
  TOP_ICON_ROWS,
  labelToKey,
  filterBatch,
  cleanEntryForWorker,
  compactEntry,
  entryByteSize,
  MAX_ENTRY_BYTES,
  contentHash,
  needsReharvest,
  reharvestDecision,
  requeueLegacyCapped,
  poolFixture,
  classifyNavError,
  detectChallengePage,
  createLoadFailureRecorder,
  gotoWithLogging,
} from "./lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE_URL = process.env.SITE_URL || "https://topcorner.pages.dev";
const TIME_ZONE = process.env.TIME_ZONE || "Africa/Casablanca";
const STATE_PATH = path.join(HERE, "state.json");
const MAPPING_PATH = path.join(HERE, "mapping.json");
const OUT_DIR = path.join(HERE, "out");
const PAGE_TIMEOUT_MS = 60000;

// Per-run load-failure recorder (run #13: 0-valid runs were undiagnosable
// because every sub-page failure was swallowed). Reset in main(); its
// summary lands in payload meta.loadFailures and the run-done line.
const loadFailures = createLoadFailureRecorder();

function loadJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

// ---- Board + model fetching (native fetch, one shared cookie) ------------
async function fetchSessionCookie() {
  const res = await fetch(`${SITE_URL}/api/session`, {
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`session ${res.status}`);
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  return setCookie.map((c) => c.split(";")[0]).join("; ");
}

async function fetchBoard(date, cookie) {
  // No Origin/Referer headers: the worker gate rejects a pages.dev Origin
  // (host not in ALLOWED_API_HOSTS) and passes on the cookie alone.
  // This was the run #3 regression: the null fix reintroduced these headers.
  const res = await fetch(`${SITE_URL}/api/board?date=${date}`, {
    headers: { Cookie: cookie },
    signal: AbortSignal.timeout(40000),
  });
  if (!res.ok) throw new Error(`board ${date} ${res.status}`);
  const json = await res.json();
  return (json && json.data && json.data.matches) || [];
}

// Sessioned model-route read for verify-before-skip. Returns the parsed
// JSON or null on any failure (fail-safe: unverifiable keeps harvested).
async function fetchModel(league, id, cookie) {
  try {
    const res = await fetch(`${SITE_URL}/api/model/match/${league}/${id}`, {
      headers: { Cookie: cookie },
      signal: AbortSignal.timeout(40000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ---- Small text parsers (section-anchored, no classes) -------------------
function parseMatchInfo(text) {
  const lines = String(text || "").split("\n");
  let inSection = false;
  const out = { referee: null, venue: null, capacity: null, attendance: null };
  const num = (v) => {
    if (!v) return null;
    const n = Number(v.replace(/\s/g, ""));
    return Number.isFinite(n) ? n : null;
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (/^MATCH INFORMATION/i.test(line)) { inSection = true; continue; }
    if (inSection && /^([A-Z][A-Z ]{2,})\s*$/.test(line) && !/^(REFEREE|VENUE|CAPACITY|ATTENDANCE)/i.test(line)) {
      // A new all-caps heading ends the section (unless it is one of ours).
      if (line.length < 40) { inSection = false; continue; }
    }
    if (!inSection) continue;
    const m = line.match(/^(REFEREE|VENUE|CAPACITY|ATTENDANCE)\s*:?\s*(.+)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (key === "capacity" || key === "attendance") out[key] = num(m[2]);
    else out[key] = m[2].trim();
  }
  return out;
}

// Events from main-page innerText, split by half headings in document order.
// Each event row is classified by parseTimelineLine; goals keep their
// running score, cards keep their reason, subs keep replaced + minute.
function parseEvents(text) {
  const lines = String(text || "").split("\n");
  const events = [];
  let half = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^1st half/i.test(line) || /^first half/i.test(line)) { half = "first"; continue; }
    if (/^2nd half/i.test(line) || /^second half/i.test(line)) { half = "second"; continue; }
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
      text: parsed.text,
      half,
      ...(parsed.score ? { score: parsed.score } : {}),
    });
  }
  return events;
}

// ---- Page navigation -----------------------------------------------------
// One navigation attempt: goto + HTTP-status + challenge checks. A 200
// challenge page and a 4xx/5xx response are BOTH failures here — the old
// code treated any resolved goto as success and then evaluated an empty
// or challenge DOM into silence. Returns { ok, mode } where mode is
// "ok" | "timeout" | "http:<status>" | "challenge" | "nav:<message>".
async function attemptGoto(page, url) {
  let resp = null;
  try {
    resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT_MS });
  } catch (err) {
    return { ok: false, mode: classifyNavError(err) };
  }
  try {
    const status = resp && typeof resp.status === "function" ? resp.status() : null;
    if (status && status >= 400) return { ok: false, mode: `http:${status}` };
  } catch {
    // Status probe failure is not itself a load failure; fall through.
  }
  try {
    const probe = await page.evaluate(challengeProbeEvaluate).catch(() => "");
    if (detectChallengePage(probe)) return { ok: false, mode: "challenge" };
  } catch {
    // Probe failure is not itself a load failure; fall through.
  }
  return { ok: true, mode: "ok" };
}

// Named (not inline) so fake pages in tests can answer by function name.
function challengeProbeEvaluate() {
  return (document.title || "") + "\n" + (document.body ? document.body.innerText || "" : "");
}

// Logged, bounded-retry navigation: attempt 1, then exactly one fresh
// re-navigate on failure (attempt 2), then give up on THIS group and let
// the caller move on. ctx { key, kind } names the match + sub-page in
// every log line; a missing ctx still logs under "unknown" — never silent.
async function gotoWithRetry(page, url, ctx) {
  const key = (ctx && ctx.key) || "unknown";
  const kind = (ctx && ctx.kind) || "unknown";
  return gotoWithLogging(() => attemptGoto(page, url), { key, kind, url }, loadFailures);
}

// Split a Flashscore match URL into its base path + mid. Every derived page
// keeps ?mid= (dropping it lands on a different match or an error page).
function splitMatchUrl(matchUrl) {
  const m = String(matchUrl || "").match(/^(https:\/\/www\.flashscore\.com\/match\/[^?]+)\?mid=([^&]+)/);
  if (!m) return null;
  return { base: m[1], mid: m[2] };
}

function pageUrl(split, suffix) {
  return `${split.base}${suffix}?mid=${split.mid}`;
}

// ---- DOM extractors (self-contained evaluate callbacks: DOM APIs +
// heading text + table structure + document order only, never classes) ------

// Stats page: tables grouped by their nearest preceding heading (or by an
// in-table group subheader row). Returns {group: [{home,label,away}]}.
function statsPageEvaluate() {
  const txt = (el) => ((el.innerText || el.textContent || "").replace(/\s+/g, " ").trim());
  const groupOf = (h) => {
    const s = h.toLowerCase();
    if (s.includes("top stats")) return "top";
    if (s.includes("shots")) return "shots";
    if (s.includes("attack")) return "attack";
    if (s.includes("passes")) return "passes";
    if (s.includes("defense") || s.includes("defence")) return "defense";
    if (s.includes("goalkeeping")) return "goalkeeping";
    return null;
  };
  const heads = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")];
  const groups = {};
  const push = (g, row) => {
    if (!g) return;
    if (!groups[g]) groups[g] = [];
    groups[g].push(row);
  };
  for (const t of document.querySelectorAll("table")) {
    let g = null;
    const cap = t.querySelector("caption");
    if (cap) g = groupOf(txt(cap));
    if (!g) {
      for (const h of heads) {
        if (h.compareDocumentPosition(t) & 4) g = h;
        else break;
      }
      g = g ? groupOf(txt(g)) : null;
    }
    const trs = t.querySelectorAll("tbody tr").length
      ? t.querySelectorAll("tbody tr")
      : t.querySelectorAll("tr");
    for (const tr of trs) {
      const cells = [...tr.querySelectorAll("td,th")];
      if (cells.length === 1) {
        const maybe = groupOf(txt(cells[0]));
        if (maybe) { g = maybe; continue; }
      }
      if (cells.length < 3) continue;
      if (cells.every((c) => c.tagName === "TH")) continue;
      const vals = cells.map((c) => txt(c));
      push(g, { home: vals[0], label: vals[1], away: vals[2] });
    }
  }
  return groups;
}

// Lineups page, missing-players section: blocks in document order. Each
// block is one team's list when the section splits into two blocks; a single
// flat block cannot be attributed, so its rows carry team null (the cleaner
// drops them and counts them — never guessed).
function missingPageEvaluate() {
  const txt = (el) => ((el.innerText || el.textContent || "").replace(/\s+/g, " ").trim());
  const heads = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")];
  let section = null;
  for (const h of heads) {
    if (txt(h).toLowerCase().includes("missing players")) { section = h; break; }
  }
  if (!section) return null;
  // Section root: walk up until an element that contains more than just
  // the heading (i.e. the section body), capped at 4 levels.
  let root = section.parentElement;
  for (let i = 0; i < 4 && root; i++) {
    if (txt(root).length > txt(section).length + 10) break;
    root = root.parentElement;
  }
  if (!root) return null;
  const blocks = [];
  const kids = [...root.children].filter((c) => c !== section && txt(c).length > 0);
  const rowTexts = (el) => {
    const rows = [];
    const trs = el.querySelectorAll("tr");
    if (trs.length) {
      for (const tr of trs) {
        const cells = [...tr.querySelectorAll("td,th")].map((c) => txt(c)).filter(Boolean);
        if (cells.length >= 2) rows.push(cells.join(" - "));
        else if (cells.length === 1) rows.push(cells[0]);
      }
      return rows;
    }
    for (const line of txt(el).split("\n")) {
      const l = line.trim();
      if (l) rows.push(l);
    }
    return rows;
  };
  for (const kid of kids) {
    const rows = rowTexts(kid).filter((r) => !/missing players/i.test(r));
    if (rows.length) blocks.push(rows);
  }
  if (!blocks.length) {
    const body = txt(root).split("\n").map((s) => s.trim()).filter((s) => s && !/missing players/i.test(s));
    if (body.length) blocks.push(body);
  }
  return blocks;
}

// Lineups page, player rows: tables in document order, split into teams by
// the first team-name headings in document order. Returns rows with raw
// cell texts; Node assigns XI/subs/bench by position in each team's list.
function lineupsPlayersEvaluate(homeName, awayName) {
  const txt = (el) => ((el.innerText || el.textContent || "").replace(/\s+/g, " ").trim());
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const hn = norm(homeName);
  const an = norm(awayName);
  const els = [...document.querySelectorAll("body *")];
  let homePos = -1;
  let awayPos = -1;
  for (let i = 0; i < els.length; i++) {
    const t = norm(txt(els[i]));
    if (!t) continue;
    if (homePos < 0 && t === hn) homePos = i;
    if (awayPos < 0 && t === an) awayPos = i;
    if (homePos >= 0 && awayPos >= 0) break;
  }
  const rows = [];
  for (let i = 0; i < els.length; i++) {
    const el = els[i];
    if (el.tagName !== "TR" && el.tagName !== "LI") continue;
    const cells = el.tagName === "TR"
      ? [...el.querySelectorAll("td,th")].map((c) => txt(c))
      : [txt(el)];
    if (cells.length === 0 || cells.every((c) => !c)) continue;
    let team = null;
    if (homePos >= 0 && awayPos >= 0) {
      if (i > homePos && i < awayPos) team = homePos < awayPos ? "home" : "away";
      else if (i > awayPos) team = homePos < awayPos ? "away" : "home";
    }
    rows.push({ team, cells, text: cells.join(" ") });
  }
  return rows;
}

// Player-stats page: thead th names are the columns; tbody rows are data.
// Returns null when no headed table parses (category omitted, never faked).
function playerStatsEvaluate() {
  const txt = (el) => ((el.innerText || el.textContent || "").replace(/\s+/g, " ").trim());
  for (const t of document.querySelectorAll("table")) {
    const ths = [...t.querySelectorAll("thead th")].map((c) => txt(c)).filter(Boolean);
    const trs = [...t.querySelectorAll("tbody tr")];
    if (!ths.length || !trs.length) continue;
    const rows = [];
    for (const tr of trs) {
      const cells = [...tr.querySelectorAll("td,th")].map((c) => txt(c));
      if (cells.length) rows.push(cells);
    }
    if (rows.length) return { columns: ths, rows };
  }
  return null;
}

// Odds page (1X2 full-time only): header tokens 1 / X / 2 identify the
// table; rows are [bookmaker, 1, X, 2]. Bookmaker names exactly as shown.
function oddsPageEvaluate() {
  const txt = (el) => ((el.innerText || el.textContent || "").replace(/\s+/g, " ").trim());
  for (const t of document.querySelectorAll("table")) {
    const trs = [...t.querySelectorAll("tr")];
    if (trs.length < 2) continue;
    const header = [...trs[0].querySelectorAll("th,td")].map((c) => txt(c).toLowerCase());
    if (!(header.includes("1") && header.includes("x") && header.includes("2"))) continue;
    const out = [];
    for (const tr of trs.slice(1)) {
      const cells = [...tr.querySelectorAll("td,th")].map((c) => txt(c));
      if (cells.length < 4) continue;
      if (!cells[0] || cells[0] === "-") continue;
      const prices = cells.slice(1, 4).map((c) => {
        const n = Number(c);
        return Number.isFinite(n) ? n : null;
      });
      if (prices.some((p) => p === null)) continue;
      out.push({ name: cells[0], markets: { "1X2": prices } });
    }
    if (out.length) return out;
  }
  return null;
}

// ---- Node-side shaping of DOM extracts ------------------------------------
function shapeStatsGroups(domGroups) {
  const out = {};
  for (const [group, rows] of Object.entries(domGroups || {})) {
    const scalars = groupStatsRows(rows, group === "top" ? TOP_ICON_ROWS : []);
    if (Object.keys(scalars).length > 0) out[group] = scalars;
  }
  return out;
}

// Text fallback for stats when no tables parse: label -> group membership is
// approximate (page headings are authoritative); used only so a table-less
// render still yields worker-valid grouped scalars instead of nothing.
const FALLBACK_GROUP = {
  xg: "top", xgot: "top", xa: "top", goalsPrevented: "top", possession: "top",
  bigChances: "top", touchesInBox: "top", corners: "top", yellowCards: "top", redCards: "top",
  totalShots: "shots", shotsOnTarget: "shots", shotsOffTarget: "shots", blockedShots: "shots",
  shotsInsideBox: "shots", shotsOutsideBox: "shots", hitWoodwork: "shots", headedGoals: "shots",
  bigChancesScored: "shots", bigChancesMissed: "shots",
  freeKicks: "attack", offsides: "attack", keyPasses: "attack", crosses: "attack",
  accurateCrosses: "attack", throwIns: "attack",
  passes: "passes", accuratePasses: "passes", longPasses: "passes", accurateLongPasses: "passes",
  passesFinalThird: "passes", accurateFinalThird: "passes",
  fouls: "defense", duelsWon: "defense", tackles: "defense", tacklesWon: "defense",
  interceptions: "defense", clearances: "defense", errorsToShot: "defense", errorsToGoal: "defense",
  saves: "goalkeeping", xgotFaced: "goalkeeping", goalsConceded: "goalkeeping", goalKicks: "goalkeeping",
};

function shapeStatsTextFallback(lines) {
  const groups = {};
  let pending = null;
  const flush = () => {
    if (!pending) return;
    const key = labelToKey(pending.label);
    const group = FALLBACK_GROUP[key];
    if (group && key) {
      if (!groups[group]) groups[group] = {};
      groups[group][`${key}Home`] = pending.home;
      groups[group][`${key}Away`] = pending.away;
    }
    pending = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = String(lines[i] || "").trim();
    if (!line) continue;
    const m = line.match(/^(.+?)\s+(-?\d+(?:\.\d+)?%?)\s+(-?\d+(?:\.\d+)?%?)\s*$/);
    if (m && labelToKey(m[1])) {
      flush();
      pending = { label: m[1], home: Number(m[2].replace("%", "")), away: Number(m[3].replace("%", "")) };
      flush();
      continue;
    }
    if (pending === null) {
      // Label on its own line; values follow on the next two lines.
      const home = Number(String(lines[i + 1] || "").replace("%", "").trim());
      const away = Number(String(lines[i + 2] || "").replace("%", "").trim());
      if (labelToKey(line) && Number.isFinite(home) && Number.isFinite(away)) {
        pending = { label: line, home, away };
        flush();
      }
    }
  }
  flush();
  return groups;
}

const POSITION_TOKENS = new Set(["GK", "G", "DF", "D", "CB", "LB", "RB", "LWB", "RWB",
  "MF", "M", "CDM", "CM", "CAM", "LM", "RM", "LW", "RW", "FW", "F", "ST", "CF", "SS"]);

function splitNamePosition(cellText) {
  const parts = String(cellText || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (parts.length >= 2 && POSITION_TOKENS.has(parts[parts.length - 1].toUpperCase())) {
    return { name: parts.slice(0, -1).join(" "), position: parts[parts.length - 1].toUpperCase() };
  }
  const m = String(cellText || "").match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  if (m && POSITION_TOKENS.has(m[2].toUpperCase())) {
    return { name: m[1].trim(), position: m[2].toUpperCase() };
  }
  return { name: String(cellText || "").trim(), position: null };
}

function shapePlayerStats(dom) {
  if (!dom || !dom.columns || !dom.rows) return null;
  const columns = dom.columns.map((c) => labelToKey(c));
  const rows = [];
  for (const cells of dom.rows) {
    if (!cells.length) continue;
    const first = splitNamePosition(cells[0]);
    if (!first.name) continue;
    const row = { player: first.name, ...(first.position ? { position: first.position } : {}) };
    for (let i = 1; i < cells.length && i < dom.columns.length; i++) {
      const key = columns[i];
      if (!key || key === columns[0]) continue;
      const raw = String(cells[i] ?? "").trim();
      if (raw === "" || raw === "-") row[key] = null;
      else {
        const n = Number(raw);
        row[key] = Number.isFinite(n) && /^-?\d+(\.\d+)?$/.test(raw) ? n : raw;
      }
    }
    rows.push(row);
  }
  return rows.length ? { columns: columns.slice(1), rows } : null;
}

// Parse one team's ordered player rows into XI / used subs / bench.
// Document order is the structure: first 11 = XI, rows with substitution
// info after that = used subs, the rest = bench. Fewer than 11 rows means
// the parse failed, not a short lineup: return null rather than invent.
function shapeTeamPlayers(rows) {
  if (!rows || rows.length < 11) return null;
  const parseRow = (r) => {
    const text = r.text || "";
    const markers = {
      goalkeeper: /\(G\)/i.test(text),
      captain: /\(C\)/i.test(text),
    };
    let number = null;
    let name = null;
    let rating = null;
    let minute = null;
    let replaced = null;
    for (const c of r.cells) {
      const cell = String(c || "").trim();
      if (cell === "") continue;
      if (number === null && /^\d{1,2}$/.test(cell)) { number = Number(cell); continue; }
      if (minute === null && /^\d+\+?\d*'$/.test(cell)) { minute = cell; continue; }
      if (rating === null && /^\d{1,2}\.\d$/.test(cell)) { rating = Number(cell); continue; }
      if (name === null && /[A-Za-zÀ-ÿ]/.test(cell)) {
        name = cell.replace(/\s*\((G|C)\)\s*/gi, "").trim();
      }
    }
    const subM = text.match(/^(.+?)\s+in,?\s+(.+?)\s+out/i);
    if (subM) {
      if (!name) name = subM[1].replace(/\s*\((G|C)\)\s*/gi, "").trim();
      replaced = subM[2].replace(/\s*\((G|C)\)\s*/gi, "").trim();
    }
    if (!name) return null;
    return { number, name, rating, minute, replaced, ...markers };
  };
  const parsed = rows.map(parseRow).filter(Boolean);
  if (parsed.length < 11) return null;
  const xi = parsed.slice(0, 11).map((p) => ({
    ...(p.number !== null ? { number: p.number } : {}),
    name: p.name,
    ...(p.rating !== null ? { rating: p.rating } : {}),
    ...(p.goalkeeper ? { goalkeeper: true } : {}),
    ...(p.captain ? { captain: true } : {}),
  }));
  const rest = parsed.slice(11);
  const subs = [];
  const bench = [];
  for (const p of rest) {
    if (p.minute !== null || p.replaced !== null) {
      subs.push({
        name: p.name,
        ...(p.minute !== null ? { minute: p.minute } : {}),
        ...(p.rating !== null ? { rating: p.rating } : {}),
        ...(p.replaced !== null ? { replaced: p.replaced } : {}),
      });
    } else {
      bench.push({ name: p.name, ...(p.rating !== null ? { rating: p.rating } : {}) });
    }
  }
  return { xi, subs, bench };
}

function shapeMissing(blocks) {
  if (!blocks) return null; // Section absent: omit (never infer "none").
  if (blocks.length === 2) {
    const out = [];
    const sides = ["home", "away"];
    for (let s = 0; s < 2; s++) {
      for (const rowText of blocks[s]) {
        const m = rowText.match(/^(.+?)\s*[—–-]\s*(.+)$/);
        if (m) out.push({ team: sides[s], player: m[1].trim(), reason: m[2].trim() });
      }
    }
    return out;
  }
  // Single flat block: rows carry no team label, so they cannot be posted
  // (worker requires team). Return them team-less for the cleaner to drop
  // with a count, rather than attributing them to the wrong team.
  const out = [];
  for (const rowText of blocks[0] || []) {
    const m = rowText.match(/^(.+?)\s*[—–-]\s*(.+)$/);
    if (m) out.push({ team: null, player: m[1].trim(), reason: m[2].trim() });
  }
  return out;
}

// ---- Extraction ------------------------------------------------------------
async function extractStatsPage(page, split, suffix, key) {
  const url = pageUrl(split, suffix);
  const kind = suffix.includes("1st-half")
    ? "stats-1st-half"
    : suffix.includes("2nd-half")
      ? "stats-2nd-half"
      : "stats-overall";
  if (!(await gotoWithRetry(page, url, { key, kind }))) return null;
  await page.waitForTimeout(2500).catch(() => {});
  const dom = await page.evaluate(statsPageEvaluate).catch(() => null);
  const groups = shapeStatsGroups(dom);
  if (Object.keys(groups).length > 0) return groups;
  // Table-less fallback: grouped scalars from page text lines.
  const text = await page.evaluate(() => document.body.innerText).catch(() => "");
  const fallback = shapeStatsTextFallback(text.split("\n"));
  return Object.keys(fallback).length > 0 ? fallback : null;
}

// §4 forward-compatible extraction: half-period stats, market value,
// player-stat tables. Assigns keys ONLY when a sub-page yields data;
// absence stays absent (undefined), never null — the worker rejects
// explicit null for these fields (run #8: whole entries were rejected
// for null playerStats/marketValue/statsHalves, losing core data).
async function extractForwardCompatible(page, split, result, key) {
  const firstHalf = await extractStatsPage(page, split, "/summary/stats/1st-half/", key);
  const secondHalf = await extractStatsPage(page, split, "/summary/stats/2nd-half/", key);
  if (firstHalf || secondHalf) {
    result.statsHalves = {
      ...(firstHalf ? { firstHalf } : {}),
      ...(secondHalf ? { secondHalf } : {}),
    };
  }
  // Market value: best-effort only when € totals render (absence is normal).
  if (await gotoWithRetry(page, pageUrl(split, "/summary/lineups/market-value/"), { key, kind: "market-value" })) {
    await page.waitForTimeout(2500).catch(() => {});
    const text = await page.evaluate(() => document.body.innerText).catch(() => "");
    const totals = [...String(text || "").matchAll(/€\s*([\d.,]+)\s*m/gi)].map((m) => m[0].replace(/\s+/g, ""));
    if (totals.length >= 2) {
      const num = (s) => {
        const n = Number(s.replace(/[€m]/g, "").replace(",", "."));
        return Number.isFinite(n) ? n : null;
      };
      result.marketValue = {
        home: totals[0], away: totals[1],
        homeMillions: num(totals[0]), awayMillions: num(totals[1]),
      };
    }
  }
  // Player-stat tables, all categories (thead th = columns, "-" = null).
  const categories = ["top", "shots", "attack", "passes", "defense", "goalkeeping", "general"];
  const playerStats = {};
  for (const cat of categories) {
    const url = pageUrl(split, `/summary/player-stats/${cat}/`);
    if (!(await gotoWithRetry(page, url, { key, kind: `player-stats:${cat}` }))) continue;
    await page.waitForTimeout(2000).catch(() => {});
    const dom = await page.evaluate(playerStatsEvaluate).catch(() => null);
    const shaped = shapePlayerStats(dom);
    if (shaped) playerStats[cat] = shaped;
  }
  if (Object.keys(playerStats).length) result.playerStats = playerStats;
}

async function extractFinished(page, matchUrl, fixture) {
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
    odds: null,
  };
  const split = splitMatchUrl(matchUrl);
  if (!split) return result;
  const key = buildKey(fixture.date, fixture.home, fixture.away);
  // Main page: events + match info.
  if (await gotoWithRetry(page, matchUrl, { key, kind: "main" })) {
    await page.waitForTimeout(3000).catch(() => {});
    const mainText = await page.evaluate(() => document.body.innerText).catch(() => "");
    const events = parseEvents(mainText);
    if (events.length) result.events = events;
    Object.assign(result, parseMatchInfo(mainText));
  }
  // Full stats page (NEVER the Summary preview: possession differs).
  const overall = await extractStatsPage(page, split, "/summary/stats/overall/", key);
  if (overall) {
    result.stats = overall;
    const top = overall.top || {};
    if (typeof top.xgHome === "number") result.xgHome = top.xgHome;
    if (typeof top.xgAway === "number") result.xgAway = top.xgAway;
  }
  // §4 forward-compatible fields (halves, market value, player stats).
  // Keys are assigned ONLY when the sub-pages yield data — never null.
  await extractForwardCompatible(page, split, result, key);
  // Lineups page: formations, coaches, missing, players.
  if (await gotoWithRetry(page, pageUrl(split, "/summary/lineups/"), { key, kind: "lineups" })) {
    await page.waitForTimeout(3000).catch(() => {});
    const text = await page.evaluate(() => document.body.innerText).catch(() => "");
    const formations = [...String(text || "").matchAll(/(?<!\d)(\d-\d-\d)(?!\d)/g)].map((m) => m[1]);
    const coachMatch = text.match(/COACHES?:\s*([^\n]+)/i);
    const coaches = coachMatch ? coachMatch[1].split("/").map((s) => s.trim()) : [];
    const missingBlocks = await page.evaluate(missingPageEvaluate).catch(() => null);
    const missing = shapeMissing(missingBlocks);
    const playerRows = await page.evaluate(lineupsPlayersEvaluate, fixture.home, fixture.away).catch(() => []);
    const homeRows = (playerRows || []).filter((r) => r.team === "home");
    const awayRows = (playerRows || []).filter((r) => r.team === "away");
    const home = shapeTeamPlayers(homeRows);
    const away = shapeTeamPlayers(awayRows);
    const lineups = {};
    if (formations[0] || home) {
      lineups.home = {
        ...(formations[0] ? { formation: formations[0] } : {}),
        ...(home || { xi: null, subs: null, bench: null }),
      };
      if (lineups.home.xi === null) delete lineups.home.xi;
      if (lineups.home.subs === null) delete lineups.home.subs;
      if (lineups.home.bench === null) delete lineups.home.bench;
    }
    if (formations[1] || away) {
      lineups.away = {
        ...(formations[1] ? { formation: formations[1] } : {}),
        ...(away || { xi: null, subs: null, bench: null }),
      };
      if (lineups.away.xi === null) delete lineups.away.xi;
      if (lineups.away.subs === null) delete lineups.away.subs;
      if (lineups.away.bench === null) delete lineups.away.bench;
    }
    if (Object.keys(lineups).length) result.lineups = lineups;
    if (coaches.length) {
      result.coaches = { home: coaches[0] || null, away: coaches[1] || null };
    }
    if (missing !== null) result.missing = missing;
  }
  // Team average ratings ride in lineups sides (worker-accepted field).
  if (await gotoWithRetry(page, pageUrl(split, "/summary/lineups/avg-rating/"), { key, kind: "avg-rating" })) {
    await page.waitForTimeout(2500).catch(() => {});
    const text = await page.evaluate(() => document.body.innerText).catch(() => "");
    const ratings = [...String(text || "").matchAll(/(?<!\d)(\d\.\d)(?!\d)/g)].map((m) => Number(m[1]));
    if (ratings.length >= 2 && result.lineups) {
      if (result.lineups.home) result.lineups.home.rating = ratings[0];
      if (result.lineups.away) result.lineups.away.rating = ratings[1];
    }
  }
  // RESILIENCE (run #8): all three §4 groups absent at once means the
  // sub-page session degraded, not that the match lacks the data — the
  // core stats above already loaded, so retry the §4 pass once. A
  // persistently absent market value ALONE is normal (no sub-tab bar
  // for some matches); only the all-absent case warns.
  if (result.statsHalves === undefined && result.marketValue === undefined && result.playerStats === undefined) {
    await extractForwardCompatible(page, split, result, key);
  }
  if (result.statsHalves === undefined && result.marketValue === undefined && result.playerStats === undefined) {
    // The §4 pass ran twice and still yielded nothing. Only claim "core
    // data kept" when core actually loaded: run #11 proved the old wording
    // misleading, because an extraction that loaded NOTHING (all sub-page
    // loads failed silently) also reached this line and was posted as an
    // identity-only skeleton. An empty extraction is now rejected by the
    // empty-extraction guard instead of posting.
    const corePresent = result.stats !== null || result.xgHome !== null || result.xgAway !== null ||
      (Array.isArray(result.events) && result.events.length > 0) || result.lineups !== null;
    if (corePresent) {
      console.warn(`forward-compatible fields all absent for ${fixture.home} vs ${fixture.away} (${fixture.date}); core data kept`);
    } else {
      console.warn(`extraction empty for ${fixture.home} vs ${fixture.away} (${fixture.date}); no stats, xG, events or lineups loaded — entry will be rejected as "empty extraction", not posted`);
    }
  }
  // Finished-match odds: 1X2 full-time only (US books; 1xBet never appears).
  const odds = await extractOdds(page, matchUrl, key);
  if (odds) result.odds = odds;
  return result;
}

// Odds page (shared by finished + upcoming): 1X2 full-time table only.
async function extractOdds(page, matchUrl, key) {
  const split = splitMatchUrl(matchUrl);
  if (!split) return null;
  const url = pageUrl(split, "/odds/1x2-odds/full-time/");
  if (!(await gotoWithRetry(page, url, { key, kind: "odds-1x2" }))) return null;
  await page.waitForTimeout(3000).catch(() => {});
  const bookmakers = await page.evaluate(oddsPageEvaluate).catch(() => null);
  if (bookmakers && bookmakers.length) return { bookmakers };
  return null;
}

// Discovery fallback: scan the Flashscore football schedule page for links
// whose href or text matches both team names under ANY spelling variant.
// Returns {url, matched} or null. Every variant tried is logged by the
// caller on unresolved entries so a miss names exactly what was tried.
async function discoverMatchUrl(page, fixture) {
  try {
    const key = buildKey(fixture.date, fixture.home, fixture.away);
    const ok = await gotoWithRetry(page, "https://www.flashscore.com/football/", { key, kind: "discovery-schedule" });
    if (!ok) return null;
    await page.waitForTimeout(4000).catch(() => {});
    const links = await page
      .$$eval('a[href*="/match/football/"]', (els) =>
        els.map((a) => ({ href: a.href, text: (a.innerText || "").trim() }))
      )
      .catch(() => []);
    for (const l of links) {
      const m = linkMatchesFixture(l.text, l.href, fixture);
      if (m) return { url: l.href, matched: m };
    }
    return null;
  } catch {
    return null;
  }
}

// ---- Main ------------------------------------------------------------------
async function main() {
  // Fresh load-failure accounting per run (never carried across runs).
  loadFailures.reset();
  const mapping = loadJson(MAPPING_PATH, { version: 1, aliases: {}, matches: {} });
  let state = loadJson(STATE_PATH, {
    version: 1,
    lastRun: null,
    harvested: [],
    discovered: {},
    pending: [],
    reharvestAttempts: {},
    oddsHashes: {},
  });
  if (!state.reharvestAttempts) state.reharvestAttempts = {};
  if (!state.oddsHashes) state.oddsHashes = {};
  // SELF-HEALING (legacy recovery): rows the old code accepted-at-cap
  // (attempts >= 3, no verifiedStored flag) re-queue automatically here,
  // with zero manual state edits. History is kept in reharvestNote.
  const legacy = requeueLegacyCapped(state);
  state = legacy.state;
  const requeuedKeys = legacy.requeued;
  if (!state.requeuePool) state.requeuePool = [];
  const harvestedSet = new Set(state.harvested || []);
  const dates = [dayStr(-1, TIME_ZONE), dayStr(0, TIME_ZONE), dayStr(1, TIME_ZONE)];
  const cookie = await fetchSessionCookie();
  const fixtures = [];
  let boardsOk = 0;
  for (const date of dates) {
    try {
      const matches = await fetchBoard(date, cookie);
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
  // SELF-HEALING: requeue-pool rows (legacy capped rows + any rows the
  // post step left pooled) re-extract as pseudo-fixtures even when their
  // match is no longer on the 3-day board. Board fixtures win on key
  // collision (same match processed once, via the board path).
  const boardKeys = new Set(fixtures.map((f) => buildKey(f.boardDate, f.home.name, f.away.name)));
  const poolToProcess = [];
  for (const p of state.requeuePool || []) {
    if (!p || !p.key || !p.date || !p.home || !p.away) continue;
    if (boardKeys.has(p.key)) continue;
    poolToProcess.push(p);
  }
  for (const p of poolToProcess) {
    // Pool rows run the SAME finished branch as board rows: poolFixture
    // marks them finished (status post/completed) and the loop below has
    // no fromRequeue branch, so they go through resolveMatchUrl, live
    // discovery, and the full extractFinished inventory. A pool row with
    // no discovered URL lands in `unresolved` and stays pooled — it is
    // NEVER posted as a skeleton (see the empty-extraction guard below).
    const fx = poolFixture(p);
    if (fx) fixtures.push(fx);
  }

  const entries = [];
  const unresolved = [];
  const skipped = [];
  const proposedOddsHashes = {};
  const newFinishedKeys = [];
  // Read-back candidates for post-step verification (league+id required
  // for the model route; entries without them keep stored-count gating).
  const verifyCandidates = [];
  let skippedOddsUnchanged = 0;
  let reharvested = 0;
  const requeued = requeuedKeys.length;
  let unverifiable = 0;
  let browser = null;
  let page = null;
  const needBrowser = poolToProcess.length > 0 || fixtures.some(
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
      const key = buildKey(date, home, away);
      try {
        if (isFinished(f)) {
          // VERIFY-BEFORE-SKIP: never trust harvested[] blindly.
          if (harvestedSet.has(key)) {
            if (f.league && (f.id || f.matchId)) {
              const model = await fetchModel(f.league, f.id || f.matchId, cookie);
              const data = model && model.data;
              if (data && !data.locked) {
                if (!needsReharvest(data.fs)) {
                  // Row is genuinely good: keep harvested, clear attempts.
                  if (state.reharvestAttempts[key] !== undefined) delete state.reharvestAttempts[key];
                  skipped.push(key);
                  continue;
                }
                // SELF-HEALING: no terminal accept. Attempts count only;
                // the row ALWAYS re-enters the retry pool below.
                const decision = reharvestDecision(state.reharvestAttempts[key]);
                state.reharvestAttempts[key] = decision.attempts;
                harvestedSet.delete(key);
                reharvested++;
                // Fall through to re-harvest below.
              } else {
                // Locked, failed fetch, or missing data: fail-safe KEEP.
                unverifiable++;
                skipped.push(key);
                continue;
              }
            } else {
              unverifiable++;
              skipped.push(key);
              continue;
            }
          }
          let url = resolveMatchUrl(fixture, mapping, state);
          if (!url && page) {
            const found = await discoverMatchUrl(page, fixture);
            if (found) {
              url = found.url;
              state.discovered[key] = url;
            }
          }
          if (!url) {
            unresolved.push({
              ...fixture,
              reason: "no flashscore url (mapping + discovery missed)",
              tried: { home: nameVariants(home), away: nameVariants(away) },
            });
            continue;
          }
          const data = await extractFinished(page, url, fixture);
          entries.push({
            date,
            home,
            away,
            xgHome: data.xgHome,
            xgAway: data.xgAway,
            source: "flashscore",
            matchUrl: url,
            stats: data.stats,
            statsHalves: data.statsHalves,
            events: data.events,
            lineups: data.lineups,
            missing: data.missing,
            coaches: data.coaches,
            referee: data.referee,
            venue: data.venue,
            capacity: data.capacity,
            attendance: data.attendance,
            playerStats: data.playerStats,
            marketValue: data.marketValue,
            odds: data.odds,
          });
          // SELF-HEALING: do NOT mark harvested at build time (the run #8
          // poison path: rejected entries stayed harvested). Marking happens
          // below, only for entries that pass validation; post-step then
          // prunes on stored < sent and on read-back failure.
          newFinishedKeys.push(key);
          if (f.league && (f.id || f.matchId)) {
            verifyCandidates.push({ key, league: f.league, id: f.id || f.matchId });
          }
        } else if (isUpcoming(f) && date === dates[1]) {
          let url = resolveMatchUrl(fixture, mapping, state);
          if (!url && page) {
            const found = await discoverMatchUrl(page, fixture);
            if (found) {
              url = found.url;
              state.discovered[buildKey(date, home, away)] = url;
            }
          }
          if (!url) {
            unresolved.push({
              ...fixture,
              reason: "no flashscore url for odds",
              tried: { home: nameVariants(home), away: nameVariants(away) },
            });
            continue;
          }
          const odds = await extractOdds(page, url, key);
          if (!odds) {
            unresolved.push({ ...fixture, reason: "odds page yielded no 1X2 table" });
            continue;
          }
          // CHANGE DETECTION: only post when the odds content changed.
          const hash = contentHash(odds);
          if (state.oddsHashes[key] === hash) {
            skippedOddsUnchanged++;
            continue;
          }
          proposedOddsHashes[key] = hash;
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

  // Clean (worker-mirror rules), compact to budget, then validate.
  // An entry that cannot fit even after compaction is dropped with a
  // reason instead of poisoning the whole batch at the worker.
  const cleaned = entries.map(cleanEntryForWorker);
  const compacted = [];
  const oversize = [];
  let droppedMissingTotal = 0;
  for (const e of cleaned) {
    droppedMissingTotal += e.droppedMissingTeamUnknown || 0;
    delete e.droppedMissingTeamUnknown;
    const c = compactEntry(e, MAX_ENTRY_BYTES);
    if (c === null) {
      oversize.push({ date: e.date, home: e.home, away: e.away, bytes: entryByteSize(e), reason: "protected core exceeds 256KB budget" });
      continue;
    }
    if (c.truncated) {
      c.entry.truncated = true;
      c.entry.truncatedNotes = c.notes;
    }
    compacted.push(c.entry);
  }
  const { valid, rejected } = filterBatch(compacted, newFinishedKeys);
  // EMPTY-EXTRACTION GUARD (pool fix): filterBatch above, given the
  // finished keys, rejects finished entries that extracted nothing (no
  // stats, xG, events, or lineups) with reason "empty extraction". A
  // guard-rejected key is therefore absent from valid, from
  // postFinishedKeys, and from the post manifest, so it is never posted,
  // never marked harvested, and — for pool rows — stays in requeuePool
  // for the next run's retry (post-step only removes succeeded keys).
  // Upcoming odds entries are NOT guarded (their content is `odds`).
  const validKeys = new Set(valid.map((e) => buildKey(e.date, e.home, e.away)));
  const postFinishedKeys = newFinishedKeys.filter((k) => validKeys.has(k));
  // SELF-HEALING: only validated entries join harvestedSet. Rejected
  // entries (and oversize-dropped ones) stay OUT, so they retry next run
  // instead of poisoning harvested[].
  for (const k of postFinishedKeys) harvestedSet.add(k);
  const postVerify = verifyCandidates.filter((v) => validKeys.has(v.key));
  const postOddsHashes = {};
  for (const [k, v] of Object.entries(proposedOddsHashes)) {
    if (validKeys.has(k)) postOddsHashes[k] = v;
  }
  const allRejected = [...rejected, ...oversize.map((o) => ({ ...o, reasons: [o.reason] }))];
  // Load-failure accounting for this run (run #13: without it a 0-valid
  // run was undiagnosable). Lines capped at 100 in meta; the full lines
  // are in the workflow log as console.warn output.
  const loadSummary = loadFailures.summary();

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const payload = {
    generatedAt: new Date().toISOString(),
    runDates: dates,
    matches: valid,
    meta: {
      totalFixtures: fixtures.length,
      skippedFinished: skipped.length,
      skippedOddsUnchanged,
      reharvested,
      requeued,
      unverifiable,
      droppedMissingTeamUnknown: droppedMissingTotal,
      rejected: allRejected,
      unresolved,
      loadFailures: {
        total: loadSummary.total,
        byKind: loadSummary.byKind,
        byMode: loadSummary.byMode,
        recovered: loadSummary.recovered,
        lines: loadFailures.lines.slice(0, 100),
      },
      // Post manifest for post-step.mjs (worker ignores payload.meta;
      // it reads only matches). Do NOT hand-edit: the post step consumes
      // this to gate harvested-marking and odds hashes on stored == sent.
      post: {
        finishedKeys: postFinishedKeys,
        oddsHashes: postOddsHashes,
        // Read-back manifest for post-step.mjs: model-route league+id per
        // valid finished entry. Post-step verifies each via a sessioned
        // model-route read and prunes read-back failures from harvested.
        verify: postVerify,
      },
    },
  };
  const outPath = path.join(OUT_DIR, `payload-${stamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  state.lastRun = new Date().toISOString();
  state.harvested = [...harvestedSet];
  state.pending = unresolved;
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  console.log(
    `run done: ${valid.length} valid, ${allRejected.length} rejected, ${unresolved.length} unresolved, ${skipped.length} skipped, ${skippedOddsUnchanged} odds unchanged, ${reharvested} reharvested, ${requeued} requeued, ${loadSummary.total} load failures (${loadSummary.recovered} recovered) -> ${outPath}`
  );
}

// Exports for ad-hoc verification scripts only. The committed test suite
// deliberately imports lib.mjs alone so `npm test` stays dependency-free
// (no Playwright install, no browser); importing this file requires the
// playwright package. Nothing in the workflow imports these.
export { extractFinished, loadFailures };

// Run only when executed directly (`node harvest.mjs`, the workflow path).
// Importing this file (verification scripts) must not start a harvest.
const isDirectRun = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((err) => {
    console.error(`fatal: ${err && err.stack ? err.stack : err}`);
    process.exit(1);
  });
}
