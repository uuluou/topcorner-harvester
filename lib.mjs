// Pure helpers for the TOPCORNER Flashscore harvester.
// This module has NO runtime dependencies and NO browser imports, so it can
// be unit tested with plain node. All Flashscore page extraction lives in
// harvest.mjs; everything here is deterministic and offline-testable.
//
// WORKER-MIRROR RULES (read from ~/workspace/strata-rounded/src/worker.mjs,
// fsValidateEntry + fsValidStats/fsValidSide/fsValidMissing/fsValidOdds):
// - stats keys MUST be exactly the six FS_STAT_GROUPS, each group an object
//   of SCALARS (null | finite number | string <= 200 chars). The old flat
//   shape {xg:{home,away}} is REJECTED by the worker, as is any extra group.
// - missing items REQUIRE team as a non-empty string. team:null rows are
//   REJECTED (whole batch), so the cleaner drops them, never posts them.
// - lineups sides: formation string <= 50, rating finite number, xi/subs/
//   bench arrays (<= 30) with strict player shapes; explicit null for
//   xi/subs/bench is REJECTED (absent is fine).
// - events: array <= 200, string-ish fields; missing: array <= 60.
// - odds.bookmakers: array <= 50, each {name, markets? object}.
// - home/away: non-empty strings <= 120 chars; matchUrl: https <= 500.
// - xgHome/xgAway: finite numbers 0-15 or null.
// - Unknown TOP-LEVEL fields are STRIPPED (not rejected) by the worker on
//   ingest. playerStats / marketValue / statsHalves / truncated therefore
//   survive locally but do NOT persist until the worker allowlist grows
//   (see PATCH-NOTES.md for the exact worker diff). Side.rating DOES
//   survive, so team average ratings ride in lineups sides.
// - Ingest replies {data:{stored, failed}} with honest counts; the post
//   step gates harvested-marking on stored == sent (see applyPostResult).

export function normalizeName(name) {
  return String(name ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildKey(date, home, away) {
  return `${date}|${normalizeName(home)}|${normalizeName(away)}`;
}

// Build a lookup: every canonical name and every alias maps to its canonical.
export function buildAliasLookup(mapping) {
  const lookup = new Map();
  const aliases = (mapping && mapping.aliases) || {};
  for (const [canonical, variants] of Object.entries(aliases)) {
    lookup.set(normalizeName(canonical), normalizeName(canonical));
    for (const v of variants || []) lookup.set(normalizeName(v), normalizeName(canonical));
  }
  return lookup;
}

// Resolve a board team name to its canonical form, or null when unknown.
export function canonicalTeam(boardName, aliasLookup) {
  const norm = normalizeName(boardName);
  return aliasLookup.get(norm) || null;
}

// Resolve a fixture to a known Flashscore URL.
// Lookup order: (1) exact board-name key in mapping.matches,
// (2) canonical-alias key in mapping.matches,
// (3) previously discovered URL in state.discovered.
// Returns the URL string or null (never throws, never guesses a URL).
export function resolveMatchUrl(fixture, mapping, state) {
  const rawKey = buildKey(fixture.date, fixture.home, fixture.away);
  const matches = (mapping && mapping.matches) || {};
  if (matches[rawKey]) return matches[rawKey];
  const lookup = buildAliasLookup(mapping);
  const canonHome = canonicalTeam(fixture.home, lookup) || normalizeName(fixture.home);
  const canonAway = canonicalTeam(fixture.away, lookup) || normalizeName(fixture.away);
  const canonKey = `${fixture.date}|${canonHome}|${canonAway}`;
  if (matches[canonKey]) return matches[canonKey];
  const discovered = (state && state.discovered) || {};
  if (discovered[rawKey]) return discovered[rawKey];
  if (discovered[canonKey]) return discovered[canonKey];
  return null;
}

export function isFinished(match) {
  const s = match && match.status;
  return !!s && (s.state === "post" || s.completed === true);
}

export function isUpcoming(match) {
  return !!match && !!match.status && match.status.state === "pre";
}

// Dates shifted by n days, formatted YYYY-MM-DD in the given IANA timezone.
export function dayStr(n, timeZone) {
  const d = new Date(Date.now() + n * 86400000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone || "Africa/Casablanca",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

// ---- Discovery spelling variants ---------------------------------------
// Discovery matches schedule-page links by normalized href/text. Board names
// and Flashscore slugs often differ by a club suffix (FC/SC/CF) or a short
// form (AS Roma -> roma). Variants are tried in order; every variant tried
// is logged on unresolved entries so a miss is diagnosable, never silent.
// Variants NEVER invent a URL: they only broaden text matching.
const SUFFIX_TOKENS = new Set(["fc", "sc", "cf", "ac", "as"]);
export function nameVariants(name) {
  const norm = normalizeName(name);
  const out = [];
  const push = (v) => {
    if (v && !out.includes(v)) out.push(v);
  };
  push(norm);
  const toks = norm.split(" ").filter(Boolean);
  // Strip a trailing club suffix: "st louis city sc" -> "st louis city".
  while (toks.length > 1 && SUFFIX_TOKENS.has(toks[toks.length - 1])) {
    toks.pop();
    push(toks.join(" "));
  }
  // Strip a leading club prefix: "cf montreal" -> "montreal".
  const toks2 = norm.split(" ").filter(Boolean);
  while (toks2.length > 1 && SUFFIX_TOKENS.has(toks2[0])) {
    toks2.shift();
    push(toks2.join(" "));
  }
  return out;
}

// Does a schedule link (href + text, normalized) match a fixture under ANY
// spelling variant? Returns the matched variant or null.
export function linkMatchesFixture(linkText, linkHref, fixture) {
  const hay = `${normalizeName(linkText)} ${normalizeName(linkHref)}`;
  for (const v of nameVariants(fixture.home)) {
    if (v && hay.includes(v)) {
      for (const w of nameVariants(fixture.away)) {
        if (w && hay.includes(w)) return { homeVariant: v, awayVariant: w };
      }
    }
  }
  return null;
}

// ---- Stats text parsing -------------------------------------------------
// Known Flashscore stat labels mapped to stable payload keys. Any other
// label falls back to a camelCased version of the label text.
const LABEL_KEYS = {
  "expected goals (xg)": "xg",
  "xg on target (xgot)": "xgot",
  "expected assists (xa)": "xa",
  "goals prevented": "goalsPrevented",
  "ball possession": "possession",
  "big chances": "bigChances",
  "touches in opposition box": "touchesInBox",
  "total shots": "totalShots",
  "shots on target": "shotsOnTarget",
  "shots off target": "shotsOffTarget",
  "blocked shots": "blockedShots",
  "shots inside the box": "shotsInsideBox",
  "shots outside the box": "shotsOutsideBox",
  "hit the woodwork": "hitWoodwork",
  "headed goals": "headedGoals",
  "corner kicks": "corners",
  "yellow cards": "yellowCards",
  "red cards": "redCards",
  "free kicks": "freeKicks",
  "offsides": "offsides",
  "passes": "passes",
  "accurate passes": "accuratePasses",
  "long passes": "longPasses",
  "accurate long passes": "accurateLongPasses",
  "passes in final third": "passesFinalThird",
  "accurate passes in final third": "accurateFinalThird",
  "crosses": "crosses",
  "accurate crosses": "accurateCrosses",
  "key passes": "keyPasses",
  "throw-ins": "throwIns",
  "fouls": "fouls",
  "duels won": "duelsWon",
  "tackles": "tackles",
  "tackles won": "tacklesWon",
  "interceptions": "interceptions",
  "clearances": "clearances",
  "errors leading to shot": "errorsToShot",
  "errors leading to goal": "errorsToGoal",
  "goalkeeper saves": "saves",
  "xgot faced": "xgotFaced",
  "goals conceded": "goalsConceded",
  "goal kicks": "goalKicks",
  "big chances scored": "bigChancesScored",
  "big chances missed": "bigChancesMissed",
};

// Worker-accepted stats groups, in page order. Any other group key in a
// posted entry rejects the WHOLE batch, so the cleaner drops extras.
export const STAT_GROUPS = ["top", "shots", "attack", "passes", "defense", "goalkeeping"];

// Page heading text -> stats group key. Grouping comes from the PAGE's own
// headings, never from a hardcoded label list: a label may move groups.
export function headingToStatGroup(heading) {
  const h = String(heading || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (h.includes("top stats")) return "top";
  if (h === "shots" || h.includes("shots")) return "shots";
  if (h.includes("attack")) return "attack";
  if (h.includes("passes")) return "passes";
  if (h.includes("defense") || h.includes("defence")) return "defense";
  if (h.includes("goalkeeping")) return "goalkeeping";
  return null;
}

// Icon-only rows: the last three TOP STATS rows carry no label, only icons,
// in this fixed document order. Callers map them by POSITION, never by class.
export const TOP_ICON_ROWS = ["corners", "yellowCards", "redCards"];

export function labelToKey(label) {
  const norm = String(label || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (LABEL_KEYS[norm]) return LABEL_KEYS[norm];
  return norm
    .replace(/[^a-z0-9 ]/g, "")
    .split(" ")
    .map((w, i) => (i === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join("");
}

// Parse one stats cell. Returns {value, pct} where pct is present only when
// the cell embeds a percentage ("45 (78%)" -> {value:45, pct:78}; "69%" ->
// {value:69, pct:null}). "-" or "" -> {value:null, pct:null}. Callers emit
// pct as a SEPARATE scalar key (worker groups allow scalars only).
export function parseStatCell(raw) {
  const s = String(raw ?? "").trim();
  if (s === "" || s === "-") return { value: null, pct: null };
  const pctMatch = s.match(/\(\s*(-?\d+(?:\.\d+)?)\s*%\s*\)/);
  const numMatch = s.match(/-?\d+(?:\.\d+)?/);
  const value = numMatch ? Number(numMatch[0]) : null;
  if (pctMatch) return { value, pct: Number(pctMatch[1]) };
  if (/^\s*-?\d+(?:\.\d+)?\s*%\s*$/.test(s)) return { value, pct: null };
  return { value, pct: null };
}

function parseStatValue(raw) {
  const s = String(raw ?? "").trim();
  if (s === "" || s === "-") return null;
  const m = s.match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

// Parse one stats group from raw page text lines (legacy text shape, kept
// for compatibility with the old stats-page fallback).
// Expected line shapes (Flashscore stats view):
//   "Expected goals (xG)" / "0.96" / "0.65"
//   "Expected goals (xG) 0.96 0.65"
// Returns { key: { home, away } } with nulls for unparseable values.
export function parseStatLines(lines, wantedLabels) {
  const out = {};
  const wanted = new Set((wantedLabels || []).map((l) => l.toLowerCase()));
  for (let i = 0; i < lines.length; i++) {
    const line = String(lines[i] || "").trim();
    if (!line) continue;
    const lower = line.toLowerCase();
    let label = null;
    let rest = "";
    if (wanted.has(lower)) {
      label = line;
    } else {
      const m = line.match(/^(.+?)\s+(-?\d+(?:\.\d+)?%?)\s+(-?\d+(?:\.\d+)?%?)\s*$/);
      if (m && wanted.has(m[1].toLowerCase())) {
        label = m[1];
        rest = `${m[2]} ${m[3]}`;
      }
    }
    if (!label) continue;
    let home = null;
    let away = null;
    if (rest) {
      const parts = rest.split(/\s+/);
      home = parseStatValue(parts[0]);
      away = parseStatValue(parts[1]);
    } else {
      home = parseStatValue(lines[i + 1]);
      away = parseStatValue(lines[i + 2]);
    }
    out[labelToKey(label)] = { home, away };
  }
  return out;
}

// Convert DOM-extracted group rows into the worker-accepted scalar shape.
// rows: [{home, label, away}] in document order; iconLabels (optional) maps
// trailing label-less rows by position (TOP STATS icon rows). Output keys
// are `${key}Home` / `${key}Away` (+ `${key}PctHome` / `${key}PctAway` when
// a cell embeds a percentage). Rows with an unmappable label are skipped.
export function groupStatsRows(rows, iconLabels) {
  const out = {};
  const list = rows || [];
  const icons = iconLabels || [];
  let iconIdx = 0;
  // First pass: count trailing label-less rows so icon mapping aligns.
  const trailingBlank = (() => {
    let n = 0;
    for (let i = list.length - 1; i >= 0; i--) {
      if (!String(list[i].label || "").trim()) n++;
      else break;
    }
    return n;
  })();
  const iconStart = list.length - trailingBlank;
  for (let i = 0; i < list.length; i++) {
    const row = list[i];
    let label = String(row.label || "").trim();
    if (!label && i >= iconStart && iconIdx < icons.length) {
      label = null;
      const key = icons[iconIdx++];
      const h = parseStatCell(row.home);
      const a = parseStatCell(row.away);
      out[`${key}Home`] = h.value;
      out[`${key}Away`] = a.value;
      if (h.pct !== null) out[`${key}PctHome`] = h.pct;
      if (a.pct !== null) out[`${key}PctAway`] = a.pct;
      continue;
    }
    if (!label) continue;
    const key = labelToKey(label);
    if (!key) continue;
    const h = parseStatCell(row.home);
    const a = parseStatCell(row.away);
    out[`${key}Home`] = h.value;
    out[`${key}Away`] = a.value;
    if (h.pct !== null) out[`${key}PctHome`] = h.pct;
    if (a.pct !== null) out[`${key}PctAway`] = a.pct;
  }
  return out;
}

// ---- Timeline parsing ---------------------------------------------------
// Classify one timeline line. Input lines look like:
//   "72' 1-0 Mayulu S. (assist Godts M.)"
//   "31' Vitinha (PSG) - yellow card (Tripping)"
//   "57' Godts M. in, Neves J. out (PSG)"
export function parseTimelineLine(line) {
  const m = String(line || "").trim().match(/^(\d+\+?\d*)'\s+(.*)$/);
  if (!m) return null;
  const minute = m[1];
  const text = m[2];
  if (/\d+\s*-\s*\d+/.test(text) && /(goal|assist)/i.test(text)) {
    const score = (text.match(/(\d+\s*-\s*\d+)/) || [])[1] || null;
    return { minute, type: "goal", text, score: score ? score.replace(/\s/g, "") : null };
  }
  if (/yellow card/i.test(text)) return { minute, type: "yellow", text };
  if (/red card/i.test(text)) return { minute, type: "red", text };
  if (/\bin\b/i.test(text) && /\bout\b/i.test(text)) {
    return { minute, type: "substitution", text };
  }
  return { minute, type: "other", text };
}

// ---- Size budget --------------------------------------------------------
// Worker cap: 262144 bytes per entry AFTER normalization (which adds a
// fetchedAt field of ~25 chars). The harvester budgets 262080 so a cleaned
// entry can never trip the worker's entry_too_large rejection.
export const MAX_ENTRY_BYTES = 262080;
export function entryByteSize(entry) {
  try {
    return JSON.stringify(entry).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

// Compaction ladder for an over-budget entry. NEVER drops: overall stats
// groups, xgHome/xgAway, formations, XI, subs (with ratings), events,
// missing, coaches, match info. Drops lowest-value bulk first and records
// every drop in notes; sets truncated:true. Returns null when even the
// protected core exceeds budget (caller drops the entry with a reason).
export function compactEntry(entry, budget) {
  const limit = budget || MAX_ENTRY_BYTES;
  const notes = [];
  const out = JSON.parse(JSON.stringify(entry));
  if (entryByteSize(out) <= limit) return { entry: out, truncated: false, notes };
  const drop = (label, fn) => {
    fn();
    notes.push(label);
    return entryByteSize(out) <= limit;
  };
  // 1. Player-stats categories, lowest value first (top kept longest).
  if (out.playerStats && typeof out.playerStats === "object") {
    for (const cat of ["general", "goalkeeping", "defense", "passes", "attack", "shots"]) {
      if (out.playerStats[cat] !== undefined) {
        delete out.playerStats[cat];
        notes.push(`playerStats.${cat}`);
        if (entryByteSize(out) <= limit) break;
      }
    }
    if (entryByteSize(out) > limit && out.playerStats.top !== undefined) {
      delete out.playerStats;
      notes.push("playerStats");
    }
  }
  if (entryByteSize(out) <= limit) return { entry: out, truncated: true, notes };
  // 2. Half-period stats (overall stays).
  if (out.statsHalves !== undefined) {
    if (drop("statsHalves", () => { delete out.statsHalves; })) return { entry: out, truncated: true, notes };
  }
  // 3. Market value (best-effort field, re-fetchable).
  if (out.marketValue !== undefined) {
    if (drop("marketValue", () => { delete out.marketValue; })) return { entry: out, truncated: true, notes };
  }
  // 4. Bench lists (XI + subs stay).
  if (out.lineups && typeof out.lineups === "object") {
    let changed = false;
    for (const side of ["home", "away"]) {
      if (out.lineups[side] && out.lineups[side].bench !== undefined) {
        delete out.lineups[side].bench;
        changed = true;
      }
    }
    if (changed) {
      notes.push("lineups.bench");
      if (entryByteSize(out) <= limit) return { entry: out, truncated: true, notes };
    }
  }
  // 5. Odds (re-fetchable from the odds page).
  if (out.odds !== undefined) {
    if (drop("odds", () => { delete out.odds; })) return { entry: out, truncated: true, notes };
  }
  // Protected core still over budget: do not silently gut it.
  if (entryByteSize(out) > limit) return null;
  return { entry: out, truncated: true, notes };
}

// ---- Verify-before-skip --------------------------------------------------
// A harvested[] key is only trusted when the live match page actually
// serves its fs row. needsReharvest(fs) mirrors the rule: re-harvest when
// the row is absent, or when it carries neither xG nor any stats (the
// poisoned-row signature: stats/xG extraction returned null but the row
// was still marked harvested). A row with stats but no xG is GOOD (some
// matches genuinely have no xG row); a row with xG but no stats is GOOD.
export function needsReharvest(fs) {
  if (fs === null || fs === undefined) return true;
  const xgPresent =
    (fs.xgHome !== null && fs.xgHome !== undefined) ||
    (fs.xgAway !== null && fs.xgAway !== undefined) ||
    (fs.xg && typeof fs.xg === "object" && (fs.xg.home !== null && fs.xg.home !== undefined || fs.xg.away !== null && fs.xg.away !== undefined));
  const statsPresent = fs.stats && typeof fs.stats === "object" && Object.keys(fs.stats).length > 0;
  return !xgPresent && !statsPresent;
}

// Re-harvest attempt accounting. Returns {attempts, accept} where accept
// means "stop retrying after the cap even though the row is still bad".
export const MAX_REHARVEST_ATTEMPTS = 3;
export function reharvestDecision(attemptsSoFar) {
  const attempts = (attemptsSoFar || 0) + 1;
  return { attempts, accept: attempts >= MAX_REHARVEST_ATTEMPTS };
}

// ---- Change detection (upcoming odds) -----------------------------------
// Stable stringify: object keys sorted recursively, so equal content always
// hashes equal regardless of insertion order.
export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

// FNV-1a 32-bit hex. No dependency, deterministic across runs/runners.
export function contentHash(value) {
  const s = stableStringify(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// ---- Stored-count gating (post-step feedback) ---------------------------
// The post step POSTs a payload, reads {data:{stored, failed}}, and amends
// state.json BEFORE the workflow commits it. Rule: only mark harvested
// when stored == sent. If stored < sent (or the post failed/unparseable),
// NONE of that batch stays harvested, so the whole batch retries next run.
// Unrelated harvested keys are never touched.
export function applyPostResult(state, sentFinishedKeys, stored, sent) {
  const next = {
    ...(state || {}),
    harvested: [...((state && state.harvested) || [])],
  };
  const ok = typeof stored === "number" && typeof sent === "number" && stored === sent;
  if (!ok) {
    const drop = new Set(sentFinishedKeys || []);
    next.harvested = next.harvested.filter((k) => !drop.has(k));
  }
  next.lastPost = {
    at: new Date().toISOString(),
    sent: typeof sent === "number" ? sent : null,
    stored: typeof stored === "number" ? stored : null,
    keptHarvested: ok,
    prunedKeys: ok ? [] : [...(sentFinishedKeys || [])],
  };
  return next;
}

// Apply proposed upcoming-odds hashes ONLY on post success. On failure the
// old hashes stand, so the next run re-posts the same odds (no silent loss).
export function applyOddsHashes(state, proposedHashes, postOk) {
  const next = {
    ...(state || {}),
    oddsHashes: { ...((state && state.oddsHashes) || {}) },
  };
  if (postOk) {
    for (const [k, v] of Object.entries(proposedHashes || {})) next.oddsHashes[k] = v;
  }
  return next;
}

// ---- Payload validation -------------------------------------------------
// Per-entry contract (see README): the writer drops invalid entries and
// reports them, keeping every valid entry in the same batch. The payload
// file therefore always contains only fully valid matches, which makes it
// acceptable to a whole-batch worker too, but the RECOMMENDED worker
// contract for /api/fs/ingest is per-entry results.
//
// WORKER-MIRROR RULE (run #2, 2026-10-27, re-verified against the live
// worker source): the live /api/fs/ingest validator REJECTS explicit null
// for stats, events, lineups sides' xi/subs/bench, missing, coaches and
// odds, even though it ALLOWS null for xgHome/xgAway, referee, venue,
// capacity and attendance, and for coaches.home/away names. The writer
// MUST therefore clean null sections (delete the key) before validating
// or writing, so "valid" here always means "accepted by the worker".
// Two further worker rules the old cleaner missed:
//  (a) stats group keys outside FS_STAT_GROUPS reject the whole batch, and
//      group values must be scalars (a flat {xg:{home,away}} is rejected);
//  (b) missing items REQUIRE team as a non-empty string; team:null rows
//      reject the whole batch, so the cleaner drops them (and counts them).
export function cleanEntryForWorker(e) {
  if (!e || typeof e !== "object") return e;
  const out = { ...e };
  for (const k of ["stats", "events", "lineups", "missing", "coaches", "odds"]) {
    if (out[k] === null) delete out[k];
  }
  // (a) Stats: keep only worker-accepted groups, and only scalar values.
  if (out.stats && typeof out.stats === "object") {
    const s = {};
    for (const g of STAT_GROUPS) {
      const grp = out.stats[g];
      if (grp && typeof grp === "object" && !Array.isArray(grp)) {
        const clean = {};
        for (const [k, v] of Object.entries(grp)) {
          if (v === null || (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && v.length <= 200)) {
            clean[k] = v;
          }
        }
        if (Object.keys(clean).length > 0) s[g] = clean;
      }
    }
    if (Object.keys(s).length > 0) out.stats = s;
    else delete out.stats;
  }
  // (b) Missing: drop rows without a usable team (worker rejects team:null).
  if (Array.isArray(out.missing)) {
    const kept = out.missing.filter(
      (m) => m && typeof m === "object" && typeof m.team === "string" && m.team.trim() !== "" &&
        typeof m.player === "string" && m.player.trim() !== ""
    );
    if (kept.length < out.missing.length) out.droppedMissingTeamUnknown = out.missing.length - kept.length;
    if (kept.length > 0) out.missing = kept;
    else delete out.missing;
  }
  if (out.lineups && typeof out.lineups === "object") {
    const l = { ...out.lineups };
    for (const side of ["home", "away"]) {
      if (l[side] && typeof l[side] === "object") {
        const s = { ...l[side] };
        for (const k of Object.keys(s)) if (s[k] === null) delete s[k];
        l[side] = s;
      } else if (l[side] === null) {
        delete l[side];
      }
    }
    out.lineups = l;
  }
  return out;
}

function isScalar(v) {
  return v === null || (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && v.length <= 200);
}

export function validateMatchEntry(e) {
  const errors = [];
  if (!e || typeof e !== "object") return ["entry is not an object"];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date || "") || Number.isNaN(Date.parse(e.date))) {
    errors.push("date must be a real YYYY-MM-DD date");
  }
  const home = typeof e.home === "string" ? e.home.trim() : "";
  const away = typeof e.away === "string" ? e.away.trim() : "";
  if (!home || home.length > 120) errors.push("home must be a non-empty string <= 120 chars");
  if (!away || away.length > 120) errors.push("away must be a non-empty string <= 120 chars");
  if (e.source !== undefined && e.source !== "flashscore") errors.push('source must be "flashscore"');
  if (e.matchUrl !== undefined && e.matchUrl !== null &&
    (typeof e.matchUrl !== "string" || e.matchUrl.length > 500 || !e.matchUrl.startsWith("https://"))) {
    errors.push("matchUrl must be https <= 500 chars or absent");
  }
  for (const k of ["xgHome", "xgAway"]) {
    const v = e[k];
    if (v !== null && v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 15)) {
      errors.push(`${k} must be null or a finite number 0-15`);
    }
  }
  if (e.stats !== undefined) {
    if (e.stats === null || typeof e.stats !== "object" || Array.isArray(e.stats)) {
      errors.push("stats must be an object or absent (worker rejects null)");
    } else {
      for (const g of Object.keys(e.stats)) {
        if (!STAT_GROUPS.includes(g)) { errors.push(`stats group "${g}" is not worker-accepted`); continue; }
        const grp = e.stats[g];
        if (!grp || typeof grp !== "object" || Array.isArray(grp)) { errors.push(`stats.${g} must be an object`); continue; }
        for (const [k, v] of Object.entries(grp)) {
          if (!isScalar(v)) errors.push(`stats.${g}.${k} must be a scalar (worker rejects objects)`);
        }
      }
    }
  }
  if (e.events !== undefined) {
    if (!Array.isArray(e.events)) errors.push("events must be an array or absent (worker rejects null)");
    else {
      if (e.events.length > 200) errors.push("events must have <= 200 rows (worker cap)");
      for (const ev of e.events) {
        if (!ev || typeof ev !== "object") { errors.push("each event must be an object"); break; }
        for (const k of ["minute", "team", "type", "player", "detail"]) {
          const v = ev[k];
          if (v !== undefined && v !== null && typeof v !== "number" && typeof v !== "string") {
            errors.push(`event.${k} must be a number, string, or null`);
          }
        }
      }
    }
  }
  if (e.missing !== undefined) {
    if (!Array.isArray(e.missing)) errors.push("missing must be an array or absent (worker rejects null)");
    else {
      if (e.missing.length > 60) errors.push("missing must have <= 60 rows (worker cap)");
      for (const m of e.missing) {
        if (!m || typeof m !== "object" || typeof m.team !== "string" || m.team.trim() === "" ||
          typeof m.player !== "string" || m.player.trim() === "") {
          errors.push("each missing row needs non-empty team and player strings (worker rule)");
          break;
        }
        if (m.reason !== undefined && m.reason !== null && typeof m.reason !== "string") {
          errors.push("missing.reason must be a string or null");
        }
      }
    }
  }
  if (e.coaches !== undefined) {
    if (e.coaches === null || typeof e.coaches !== "object") {
      errors.push("coaches must be an object or absent (worker rejects null)");
    } else {
      for (const side of ["home", "away"]) {
        const v = e.coaches[side];
        if (v !== undefined && v !== null && typeof v !== "string") errors.push(`coaches.${side} must be a string or null`);
      }
    }
  }
  if (e.lineups !== undefined && (e.lineups === null || typeof e.lineups !== "object")) {
    errors.push("lineups must be an object or absent (worker rejects null)");
  } else if (e.lineups && typeof e.lineups === "object") {
    for (const side of ["home", "away"]) {
      const s = e.lineups[side];
      if (s === undefined) continue;
      if (s === null || typeof s !== "object") { errors.push(`lineups.${side} must be an object or absent`); continue; }
      if (s.formation !== undefined && s.formation !== null &&
        (typeof s.formation !== "string" || s.formation.length > 50)) errors.push(`lineups.${side}.formation must be a string <= 50 chars or null`);
      if (s.rating !== undefined && s.rating !== null &&
        (typeof s.rating !== "number" || !Number.isFinite(s.rating))) errors.push(`lineups.${side}.rating must be a finite number or null`);
      for (const k of ["xi", "subs", "bench"]) {
        if (s[k] !== undefined && !Array.isArray(s[k])) errors.push(`lineups.${side}.${k} must be an array or absent (worker rejects null)`);
      }
      if (Array.isArray(s.xi)) {
        if (s.xi.length > 30) errors.push(`lineups.${side}.xi must have <= 30 rows (worker cap)`);
        for (const p of s.xi) {
          if (!p || typeof p !== "object" || typeof p.name !== "string" || !p.name || p.name.length > 120) {
            errors.push(`lineups.${side}.xi rows need a name string <= 120 chars`); break;
          }
          if (p.number !== undefined && p.number !== null && typeof p.number !== "number" && typeof p.number !== "string") {
            errors.push(`lineups.${side}.xi number must be a number, string, or null`); break;
          }
          if (p.rating !== undefined && p.rating !== null && (typeof p.rating !== "number" || !Number.isFinite(p.rating))) {
            errors.push(`lineups.${side}.xi rating must be a finite number or null`); break;
          }
          if (p.position !== undefined && p.position !== null && typeof p.position !== "string") {
            errors.push(`lineups.${side}.xi position must be a string or null`); break;
          }
        }
      }
      if (Array.isArray(s.subs)) {
        if (s.subs.length > 30) errors.push(`lineups.${side}.subs must have <= 30 rows (worker cap)`);
        for (const p of s.subs) {
          if (!p || typeof p !== "object" || typeof p.name !== "string" || !p.name || p.name.length > 120) {
            errors.push(`lineups.${side}.subs rows need a name string <= 120 chars`); break;
          }
          if (p.minute !== undefined && p.minute !== null && typeof p.minute !== "number" && typeof p.minute !== "string") {
            errors.push(`lineups.${side}.subs minute must be a number, string, or null`); break;
          }
          if (p.rating !== undefined && p.rating !== null && (typeof p.rating !== "number" || !Number.isFinite(p.rating))) {
            errors.push(`lineups.${side}.subs rating must be a finite number or null`); break;
          }
        }
      }
      if (Array.isArray(s.bench)) {
        if (s.bench.length > 30) errors.push(`lineups.${side}.bench must have <= 30 rows (worker cap)`);
        for (const p of s.bench) {
          if (!p || typeof p !== "object" || typeof p.name !== "string" || !p.name || p.name.length > 120) {
            errors.push(`lineups.${side}.bench rows need a name string <= 120 chars`); break;
          }
        }
      }
    }
  }
  if (e.odds !== undefined) {
    if (e.odds === null || typeof e.odds !== "object") {
      errors.push("odds must be an object or absent (worker rejects null)");
    } else if (e.odds.bookmakers !== undefined) {
      if (!Array.isArray(e.odds.bookmakers)) errors.push("odds.bookmakers must be an array");
      else {
        if (e.odds.bookmakers.length > 50) errors.push("odds.bookmakers must have <= 50 rows (worker cap)");
        for (const b of e.odds.bookmakers) {
          if (!b || typeof b !== "object" || typeof b.name !== "string" || !b.name) {
            errors.push("each odds bookmaker needs a name string"); break;
          }
          if (b.markets !== undefined && (b.markets === null || typeof b.markets !== "object")) {
            errors.push("odds bookmaker markets must be an object"); break;
          }
        }
      }
    }
  }
  // Forward-compatible fields: stripped by the CURRENT worker on ingest (see
  // header), but valid locally so the data is captured for the worker change.
  if (e.playerStats !== undefined && (e.playerStats === null || typeof e.playerStats !== "object")) {
    errors.push("playerStats must be an object or absent");
  }
  if (e.marketValue !== undefined && (e.marketValue === null || typeof e.marketValue !== "object")) {
    errors.push("marketValue must be an object or absent");
  }
  if (e.statsHalves !== undefined && (e.statsHalves === null || typeof e.statsHalves !== "object")) {
    errors.push("statsHalves must be an object or absent");
  }
  if (e.truncated !== undefined && typeof e.truncated !== "boolean") {
    errors.push("truncated must be a boolean");
  }
  if (e.truncatedNotes !== undefined && !Array.isArray(e.truncatedNotes)) {
    errors.push("truncatedNotes must be an array");
  }
  return errors;
}

// Split a batch into valid entries and rejected entries with reasons.
// Good entries are NEVER dropped because of a bad sibling.
export function filterBatch(entries) {
  const valid = [];
  const rejected = [];
  for (let i = 0; i < (entries || []).length; i++) {
    const errors = validateMatchEntry(entries[i]);
    if (errors.length === 0) {
      valid.push(entries[i]);
    } else {
      rejected.push({
        index: i,
        home: entries[i] && entries[i].home,
        away: entries[i] && entries[i].away,
        date: entries[i] && entries[i].date,
        reasons: errors,
      });
    }
  }
  return { valid, rejected };
}
