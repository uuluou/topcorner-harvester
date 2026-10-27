// Pure helpers for the TOPCORNER Flashscore harvester.
// This module has NO runtime dependencies and NO browser imports, so it can
// be unit tested with plain node. All Flashscore page extraction lives in
// harvest.mjs; everything here is deterministic and offline-testable.

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

export function labelToKey(label) {
  const norm = String(label || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (LABEL_KEYS[norm]) return LABEL_KEYS[norm];
  return norm
    .replace(/[^a-z0-9 ]/g, "")
    .split(" ")
    .map((w, i) => (i === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join("");
}

function parseStatValue(raw) {
  const s = String(raw ?? "").trim();
  if (s === "" || s === "-") return null;
  const m = s.match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

// Parse one stats group from raw page text lines.
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

// ---- Payload validation -------------------------------------------------
// Per-entry contract (see README): the writer drops invalid entries and
// reports them, keeping every valid entry in the same batch. The payload
// file therefore always contains only fully valid matches, which makes it
// acceptable to a whole-batch worker too, but the RECOMMENDED worker
// contract for /api/fs/ingest is per-entry results.
//
// WORKER-MIRROR RULE (run #2, 2026-10-27): the live /api/fs/ingest
// validator REJECTS explicit null for stats, events, lineups sides'
// xi/subs/bench, missing, coaches and odds, even though it ALLOWS null
// for xgHome/xgAway, referee, venue, capacity and attendance. The writer
// MUST therefore clean null sections (delete the key) before validating
// or writing, so "valid" here always means "accepted by the worker".
export function cleanEntryForWorker(e) {
  if (!e || typeof e !== "object") return e;
  const out = { ...e };
  for (const k of ["stats", "events", "lineups", "missing", "coaches", "odds"]) {
    if (out[k] === null) delete out[k];
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
export function validateMatchEntry(e) {
  const errors = [];
  if (!e || typeof e !== "object") return ["entry is not an object"];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date || "") || Number.isNaN(Date.parse(e.date))) {
    errors.push("date must be a real YYYY-MM-DD date");
  }
  if (!e.home || typeof e.home !== "string") errors.push("home must be a non-empty string");
  if (!e.away || typeof e.away !== "string") errors.push("away must be a non-empty string");
  if (e.source !== "flashscore") errors.push('source must be "flashscore"');
  for (const k of ["xgHome", "xgAway"]) {
    const v = e[k];
    if (v !== null && v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 15)) {
      errors.push(`${k} must be null or a finite number 0-15`);
    }
  }
  if (e.stats !== undefined && (e.stats === null || typeof e.stats !== "object")) {
    errors.push("stats must be an object or absent (worker rejects null)");
  }
  if (e.events !== undefined && !Array.isArray(e.events)) {
    errors.push("events must be an array or absent (worker rejects null)");
  }
  if (e.missing !== undefined && !Array.isArray(e.missing)) {
    errors.push("missing must be an array or absent (worker rejects null)");
  }
  if (e.coaches !== undefined && (e.coaches === null || typeof e.coaches !== "object")) {
    errors.push("coaches must be an object or absent (worker rejects null)");
  }
  if (e.lineups !== undefined && (e.lineups === null || typeof e.lineups !== "object")) {
    errors.push("lineups must be an object or absent (worker rejects null)");
  } else if (e.lineups && typeof e.lineups === "object") {
    for (const side of ["home", "away"]) {
      const s = e.lineups[side];
      if (s === undefined) continue;
      if (s === null || typeof s !== "object") { errors.push(`lineups.${side} must be an object or absent`); continue; }
      for (const k of ["xi", "subs", "bench"]) {
        if (s[k] !== undefined && !Array.isArray(s[k])) errors.push(`lineups.${side}.${k} must be an array or absent (worker rejects null)`);
      }
    }
  }
  if (e.odds !== undefined) {
    if (e.odds === null || typeof e.odds !== "object") {
      errors.push("odds must be an object or absent (worker rejects null)");
    } else if (e.odds.bookmakers !== undefined && !Array.isArray(e.odds.bookmakers)) {
      errors.push("odds.bookmakers must be an array");
    }
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
