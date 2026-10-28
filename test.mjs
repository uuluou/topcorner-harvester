// Unit tests for the harvester helpers (lib.mjs). Plain node:test, no
// framework, no network, no browser. Run: npm test
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeName,
  buildKey,
  buildAliasLookup,
  canonicalTeam,
  resolveMatchUrl,
  linkMatchesFixture,
  nameVariants,
  isFinished,
  isUpcoming,
  parseStatLines,
  parseTimelineLine,
  groupStatsRows,
  TOP_ICON_ROWS,
  parseStatCell,
  validateMatchEntry,
  filterBatch,
  cleanEntryForWorker,
  entryByteSize,
  MAX_ENTRY_BYTES,
  compactEntry,
  contentHash,
  stableStringify,
  needsReharvest,
  reharvestDecision,
  applyPostResult,
  applyOddsHashes,
} from "./lib.mjs";

const MAPPING = {
  version: 1,
  aliases: {
    psg: ["paris saint germain", "paris sg"],
    flamengo: ["flamengo rj"],
    "atletico mineiro": ["atletico-mg"],
  },
  matches: {
    "2026-10-26|paris saint germain|lyon":
      "https://www.flashscore.com/match/football/lyon-2akflumR/psg-CjhkPw0k/?mid=zyZq2xcL",
    "2026-10-26|psg|lyon":
      "https://www.flashscore.com/match/football/lyon-2akflumR/psg-CjhkPw0k/?mid=zyZq2xcL",
  },
};

describe("normalization", () => {
  it("lowercases, strips diacritics and punctuation, collapses spaces", () => {
    assert.equal(normalizeName("Atlético Mineiro"), "atletico mineiro");
    assert.equal(normalizeName("  Paris   Saint-Germain "), "paris saint germain");
    assert.equal(normalizeName("Flamengo RJ"), "flamengo rj");
  });
  it("builds stable keys", () => {
    assert.equal(buildKey("2026-10-26", "Paris Saint-Germain", "Lyon"), "2026-10-26|paris saint germain|lyon");
  });
});

describe("alias matching", () => {
  const lookup = buildAliasLookup(MAPPING);
  it("maps variants to canonical", () => {
    assert.equal(canonicalTeam("Paris Saint-Germain", lookup), "psg");
    assert.equal(canonicalTeam("PSG", lookup), "psg");
    assert.equal(canonicalTeam("Flamengo RJ", lookup), "flamengo");
    assert.equal(canonicalTeam("Atletico-MG", lookup), "atletico mineiro");
  });
  it("returns null for unknown teams (never guesses)", () => {
    assert.equal(canonicalTeam("Unknown FC", lookup), null);
  });
  it("resolves exact key, then canonical key, then discovered, else null", () => {
    const state = { discovered: { "2026-10-27|abha|al faisaly": "https://example.invalid/m" } };
    assert.equal(
      resolveMatchUrl({ date: "2026-10-26", home: "Paris Saint-Germain", away: "Lyon" }, MAPPING, state),
      "https://www.flashscore.com/match/football/lyon-2akflumR/psg-CjhkPw0k/?mid=zyZq2xcL"
    );
    assert.equal(
      resolveMatchUrl({ date: "2026-10-26", home: "PSG", away: "Lyon" }, MAPPING, state),
      "https://www.flashscore.com/match/football/lyon-2akflumR/psg-CjhkPw0k/?mid=zyZq2xcL"
    );
    assert.equal(
      resolveMatchUrl({ date: "2026-10-27", home: "Abha", away: "Al Faisaly" }, MAPPING, state),
      "https://example.invalid/m"
    );
    assert.equal(
      resolveMatchUrl({ date: "2026-10-27", home: "Nobody", away: "No FC" }, MAPPING, state),
      null
    );
  });
});

describe("match states", () => {
  it("finished only on post/completed, upcoming only on pre", () => {
    assert.equal(isFinished({ status: { state: "post" } }), true);
    assert.equal(isFinished({ status: { state: "pre" } }), false);
    assert.equal(isUpcoming({ status: { state: "pre" } }), true);
    assert.equal(isUpcoming({ status: { state: "in" } }), false);
  });
});

describe("stats text parsing", () => {
  it("parses same-line and split-line shapes", () => {
    const lines = [
      "Expected goals (xG) 0.96 0.65",
      "Ball possession",
      "69%",
      "31%",
      "Total shots 17 8",
    ];
    const out = parseStatLines(lines, ["Expected goals (xG)", "Ball possession", "Total shots"]);
    assert.deepEqual(out.xg, { home: 0.96, away: 0.65 });
    assert.deepEqual(out.possession, { home: 69, away: 31 });
    assert.deepEqual(out.totalShots, { home: 17, away: 8 });
  });
});

describe("timeline parsing", () => {
  it("classifies goals, cards and subs", () => {
    assert.equal(parseTimelineLine("72' 1-0 Mayulu S. (assist Godts M.)").type, "goal");
    assert.equal(parseTimelineLine("31' Vitinha (PSG) - yellow card (Tripping)").type, "yellow");
    assert.equal(parseTimelineLine("57' Godts M. in, Neves J. out (PSG)").type, "substitution");
    assert.equal(parseTimelineLine("random text"), null);
  });
});

describe("payload validation (per-entry contract)", () => {
  const good = (over) => ({
    date: "2026-10-26",
    home: "PSG",
    away: "Lyon",
    xgHome: 0.96,
    xgAway: 0.65,
    source: "flashscore",
    matchUrl: "https://www.flashscore.com/match/football/lyon-2akflumR/psg-CjhkPw0k/?mid=zyZq2xcL",
    events: [],
    ...over,
  });
  it("accepts a good entry and rejects bad ones with reasons", () => {
    assert.deepEqual(validateMatchEntry(good()), []);
    assert.ok(validateMatchEntry(good({ xgHome: 99 })).length > 0);
    assert.ok(validateMatchEntry(good({ date: "26-10-2026" })).length > 0);
    assert.ok(validateMatchEntry(good({ home: "" })).length > 0);
    assert.ok(validateMatchEntry(good({ source: "espn" })).length > 0);
  });
  it("rejects worker-rejected null sections (run #2 regression)", () => {
    assert.ok(validateMatchEntry(good({ stats: null })).length > 0);
    assert.ok(validateMatchEntry(good({ events: null })).length > 0);
    assert.ok(validateMatchEntry(good({ missing: null })).length > 0);
    assert.ok(validateMatchEntry(good({ coaches: null })).length > 0);
    assert.ok(validateMatchEntry(good({ odds: null })).length > 0);
    assert.ok(validateMatchEntry(good({ lineups: { home: { formation: null, xi: null, subs: null, bench: null } } })).length > 0);
  });
  it("cleans a run #2-shaped entry into a worker-valid entry", () => {
    const raw = good({
      xgHome: null, xgAway: null, stats: null, odds: null, missing: [],
      coaches: { home: null, away: null },
      lineups: {
        home: { formation: null, xi: null, subs: null, bench: null },
        away: { formation: null, xi: null, subs: null, bench: null },
      },
      referee: "Brisard J.", venue: "Parc des Princes", capacity: 48229, attendance: 47000,
    });
    const cleaned = cleanEntryForWorker(raw);
    assert.equal("stats" in cleaned, false);
    assert.equal("odds" in cleaned, false);
    assert.equal(cleaned.lineups.home.xi, undefined);
    assert.equal(cleaned.xgHome, null);
    assert.equal(cleaned.referee, "Brisard J.");
    assert.deepEqual(validateMatchEntry(cleaned), []);
  });
  it("keeps good entries when a sibling is bad", () => {
    const { valid, rejected } = filterBatch([
      good(),
      good({ home: "Sevilla", away: "Osasuna", xgHome: 1.14, xgAway: 0.77 }),
      good({ xgHome: 99 }),
    ]);
    assert.equal(valid.length, 2);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].index, 2);
    assert.ok(rejected[0].reasons.some((r) => r.includes("xgHome")));
  });
});

describe("state skip logic", () => {
  it("skips an already-harvested finished match, nothing else", () => {
    const harvested = new Set(["2026-10-26|psg|lyon"]);
    const key = buildKey("2026-10-26", "PSG", "Lyon");
    assert.equal(harvested.has(key), true);
    assert.equal(harvested.has(buildKey("2026-10-27", "PSG", "Lyon")), false);
    assert.equal(harvested.has(buildKey("2026-10-26", "PSG", "Nice")), false);
  });
});

// ---- PATCHED BEHAVIOR: worker-mirror stats groups -------------------------
describe("worker-mirror stats groups", () => {
  const base = {
    date: "2026-10-27", home: "Abha", away: "Al Faisaly",
    xgHome: 1.68, xgAway: 0.95, source: "flashscore",
  };
  it("accepts grouped scalar stats (the worker shape)", () => {
    const e = {
      ...base,
      stats: {
        top: { xgHome: 1.68, xgAway: 0.95, possessionHome: 59, possessionAway: 41 },
        shots: { totalShotsHome: 14, totalShotsAway: 9 },
      },
    };
    assert.deepEqual(validateMatchEntry(e), []);
  });
  it("rejects unknown group keys and non-scalar values (worker rules)", () => {
    assert.ok(validateMatchEntry({ ...base, stats: { overall: { xgHome: 1 } } }).length > 0);
    assert.ok(validateMatchEntry({ ...base, stats: { top: { xg: { home: 1, away: 2 } } } }).length > 0);
    assert.ok(validateMatchEntry({ ...base, stats: { top: { note: "x".repeat(201) } } }).length > 0);
  });
  it("rejects the old flat stats shape (never worker-valid)", () => {
    assert.ok(validateMatchEntry({ ...base, stats: { xg: { home: 1.68, away: 0.95 } } }).length > 0);
  });
  it("cleaner drops unknown groups and non-scalar values", () => {
    const cleaned = cleanEntryForWorker({
      ...base,
      stats: {
        top: { xgHome: 1.68, xgAway: 0.95, bad: { home: 1 } },
        overall: { xgHome: 1 },
        shots: {},
      },
    });
    assert.deepEqual(cleaned.stats, { top: { xgHome: 1.68, xgAway: 0.95 } });
  });
});

describe("groupStatsRows (DOM rows -> worker scalars)", () => {
  it("maps labeled rows to Home/Away scalars", () => {
    const out = groupStatsRows([
      { home: "1.68", label: "Expected goals (xG)", away: "0.95" },
      { home: "59%", label: "Ball possession", away: "41%" },
    ]);
    assert.equal(out.xgHome, 1.68);
    assert.equal(out.xgAway, 0.95);
    assert.equal(out.possessionHome, 59);
    assert.equal(out.possessionAway, 41);
  });
  it("maps trailing icon-only TOP rows by position (corners, yellows, reds)", () => {
    const out = groupStatsRows([
      { home: "1.68", label: "Expected goals (xG)", away: "0.95" },
      { home: "5", label: "", away: "3" },
      { home: "2", label: "", away: "1" },
      { home: "0", label: "", away: "1" },
    ], TOP_ICON_ROWS);
    assert.equal(out.cornersHome, 5);
    assert.equal(out.yellowCardsAway, 1);
    assert.equal(out.redCardsAway, 1);
    assert.equal(out.xgHome, 1.68);
  });
  it("splits pct-embedded cells into separate Pct keys and maps '-' to null", () => {
    const out = groupStatsRows([
      { home: "45 (78%)", label: "Accurate passes", away: "-" },
    ]);
    assert.equal(out.accuratePassesHome, 45);
    assert.equal(out.accuratePassesPctHome, 78);
    assert.equal(out.accuratePassesAway, null);
  });
  it("parses stat cells", () => {
    assert.deepEqual(parseStatCell("-"), { value: null, pct: null });
    assert.deepEqual(parseStatCell("45 (78%)"), { value: 45, pct: 78 });
    assert.deepEqual(parseStatCell("69%"), { value: 69, pct: null });
  });
});

describe("missing team rule (worker rejects team:null)", () => {
  it("rejects missing rows without a team", () => {
    const e = {
      date: "2026-10-27", home: "Abha", away: "Al Faisaly", source: "flashscore",
      missing: [{ team: null, player: "Someone", reason: "Injury" }],
    };
    assert.ok(validateMatchEntry(e).length > 0);
    assert.deepEqual(validateMatchEntry({
      ...e, missing: [{ team: "home", player: "Someone", reason: "Injury" }],
    }), []);
  });
  it("cleaner drops team-less rows and counts them", () => {
    const cleaned = cleanEntryForWorker({
      date: "2026-10-27", home: "Abha", away: "Al Faisaly", source: "flashscore",
      missing: [
        { team: "home", player: "A", reason: "Injury" },
        { team: null, player: "B", reason: "Injury" },
      ],
    });
    assert.equal(cleaned.missing.length, 1);
    assert.equal(cleaned.missing[0].player, "A");
    assert.equal(cleaned.droppedMissingTeamUnknown, 1);
    assert.deepEqual(validateMatchEntry(cleaned), []);
  });
});

describe("validation caps (worker limits)", () => {
  const base = { date: "2026-10-27", home: "Abha", away: "Al Faisaly", source: "flashscore" };
  it("rejects oversize arrays and strings", () => {
    assert.ok(validateMatchEntry({ ...base, events: Array.from({ length: 201 }, () => ({ minute: "1" })) }).length > 0);
    assert.ok(validateMatchEntry({ ...base, missing: Array.from({ length: 61 }, () => ({ team: "home", player: "P" })) }).length > 0);
    assert.ok(validateMatchEntry({
      ...base,
      lineups: { home: { xi: Array.from({ length: 31 }, (_, i) => ({ name: `P${i}` })) } },
    }).length > 0);
    assert.ok(validateMatchEntry({
      ...base,
      odds: { bookmakers: Array.from({ length: 51 }, (_, i) => ({ name: `B${i}` })) },
    }).length > 0);
    assert.ok(validateMatchEntry({ ...base, home: "A".repeat(121) }).length > 0);
    assert.ok(validateMatchEntry({ ...base, matchUrl: "http://example.invalid/m" }).length > 0);
  });
});

// ---- PATCHED BEHAVIOR: verify-before-skip --------------------------------
describe("needsReharvest", () => {
  it("re-harvests absent rows and poisoned rows (no xG, no stats)", () => {
    assert.equal(needsReharvest(null), true);
    assert.equal(needsReharvest(undefined), true);
    assert.equal(needsReharvest({ xgHome: null, xgAway: null, stats: null }), true);
    assert.equal(needsReharvest({ xgHome: null, xgAway: null, stats: {} }), true);
    assert.equal(needsReharvest({ xgHome: null, xgAway: null }), true);
  });
  it("keeps rows with stats but no xG, and rows with xG but no stats", () => {
    assert.equal(needsReharvest({ xgHome: null, xgAway: null, stats: { top: { possessionHome: 59 } } }), false);
    assert.equal(needsReharvest({ xgHome: 1.68, xgAway: 0.95, stats: null }), false);
    assert.equal(needsReharvest({ xgHome: 1.68, xgAway: 0.95, stats: { top: {} } }), false);
  });
  it("caps re-harvest attempts at 3", () => {
    assert.deepEqual(reharvestDecision(0), { attempts: 1, accept: false });
    assert.deepEqual(reharvestDecision(1), { attempts: 2, accept: false });
    assert.deepEqual(reharvestDecision(2), { attempts: 3, accept: true });
    assert.deepEqual(reharvestDecision(3), { attempts: 4, accept: true });
  });
});

// ---- PATCHED BEHAVIOR: stored-count gating + odds hashes ------------------
describe("applyPostResult", () => {
  const state = { harvested: ["2026-10-27|abha|al faisaly", "2026-10-27|sassuolo|lazio", "2026-10-26|paris saint germain|lyon"] };
  it("keeps harvested keys when stored == sent", () => {
    const next = applyPostResult(state, ["2026-10-27|abha|al faisaly"], 2, 2);
    assert.equal(next.harvested.length, 3);
    assert.equal(next.lastPost.keptHarvested, true);
  });
  it("prunes ONLY the batch keys when stored < sent", () => {
    const next = applyPostResult(state, ["2026-10-27|abha|al faisaly"], 1, 2);
    assert.deepEqual(next.harvested, ["2026-10-27|sassuolo|lazio", "2026-10-26|paris saint germain|lyon"]);
    assert.deepEqual(next.lastPost.prunedKeys, ["2026-10-27|abha|al faisaly"]);
  });
  it("prunes on unparseable/failed posts (fail-safe retry)", () => {
    const next = applyPostResult(state, ["2026-10-27|abha|al faisaly"], null, 2);
    assert.equal(next.harvested.includes("2026-10-27|abha|al faisaly"), false);
    assert.equal(next.harvested.length, 2);
  });
  it("applies odds hashes only on post success", () => {
    const s1 = applyOddsHashes({ oddsHashes: { old: "aa" } }, { "2026-10-28|ac milan|bologna": "ff01" }, true);
    assert.equal(s1.oddsHashes["2026-10-28|ac milan|bologna"], "ff01");
    const s2 = applyOddsHashes({ oddsHashes: { old: "aa" } }, { "2026-10-28|ac milan|bologna": "ff01" }, false);
    assert.equal(s2.oddsHashes["2026-10-28|ac milan|bologna"], undefined);
    assert.equal(s2.oddsHashes.old, "aa");
  });
});

describe("contentHash (change detection)", () => {
  it("is stable under key order and sensitive to price changes", () => {
    const a = { bookmakers: [{ name: "DraftKings", markets: { "1X2": [2.1, 3.2, 3.8] } }] };
    const b = { bookmakers: [{ markets: { "1X2": [2.1, 3.2, 3.8] }, name: "DraftKings" }] };
    const c = { bookmakers: [{ name: "DraftKings", markets: { "1X2": [2.15, 3.2, 3.8] } }] };
    assert.equal(contentHash(a), contentHash(b));
    assert.notEqual(contentHash(a), contentHash(c));
    assert.equal(stableStringify({ b: 1, a: 2 }), '{"a":2,"b":1}');
  });
});

describe("discovery spelling variants", () => {
  it("generates suffix-stripped variants", () => {
    assert.ok(nameVariants("AS Roma").includes("roma"));
    assert.ok(nameVariants("St. Louis CITY SC").includes("st louis city"));
    assert.ok(nameVariants("CF Montreal").includes("montreal"));
    assert.ok(nameVariants("Torino").includes("torino"));
  });
  it("matches schedule links under any variant, never on one team alone", () => {
    const f = { home: "AS Roma", away: "Cagliari" };
    assert.ok(linkMatchesFixture("Roma - Cagliari", "https://www.flashscore.com/match/football/roma-xxx/cagliari-yyy/?mid=z", f));
    assert.equal(linkMatchesFixture("Roma - Juventus", "https://www.flashscore.com/match/football/roma-xxx/juventus-yyy/?mid=z", f), null);
    assert.ok(linkMatchesFixture("St Louis City - Austin", "https://www.flashscore.com/match/football/st-louis-city-xxx/austin-yyy/?mid=z", { home: "St. Louis CITY SC", away: "Austin FC" }));
  });
});

// ---- PATCHED BEHAVIOR: 256KB size budget ---------------------------------
describe("size budget (Abha full-inventory fixture)", () => {
  const player = (i, team) => ({
    player: `${team} Player ${i}`,
    position: i === 0 ? "GK" : i < 5 ? "DF" : i < 8 ? "MF" : "FW",
    rating: 6.5 + (i % 10) / 10,
    goals: i % 3,
    assists: i % 2,
    shots: 2 + (i % 4),
    shotsOnTarget: 1 + (i % 3),
    passes: 30 + i,
    tackles: i % 5,
    fouls: i % 2,
  });
  const buildAbha = (playerRowsPerCategory) => {
    const cats = {};
    for (const cat of ["top", "shots", "attack", "passes", "defense", "goalkeeping", "general"]) {
      const rows = [];
      for (let i = 0; i < playerRowsPerCategory; i++) rows.push(player(i, "Abha"));
      cats[cat] = { columns: ["player", "position", "rating", "goals", "assists", "shots", "shotsOnTarget", "passes", "tackles", "fouls"], rows };
    }
    const xi = (team) => Array.from({ length: 11 }, (_, i) => ({
      number: i + 1, name: `${team} Player ${i}`, rating: 6.5 + (i % 10) / 10,
    }));
    const subs = (team) => Array.from({ length: 5 }, (_, i) => ({
      name: `${team} Sub ${i}`, minute: `${60 + i}'`, rating: 6.4, replaced: `${team} Player ${i}`,
    }));
    const bench = (team) => Array.from({ length: 9 }, (_, i) => ({ name: `${team} Bench ${i}` }));
    return {
      date: "2026-10-27", home: "Abha", away: "Al Faisaly",
      xgHome: 1.68, xgAway: 0.95, source: "flashscore",
      matchUrl: "https://www.flashscore.com/match/football/abha-lnEqnhJf/al-faisaly-AsIgIB3d/?mid=MumpnBeo",
      stats: {
        top: { xgHome: 1.68, xgAway: 0.95, xgotHome: 1.2, xgotAway: 0.7, xaHome: 1.1, xaAway: 0.8, goalsPreventedHome: 0, goalsPreventedAway: 1, possessionHome: 59, possessionAway: 41, bigChancesHome: 3, bigChancesAway: 2, touchesInBoxHome: 22, touchesInBoxAway: 15, cornersHome: 5, cornersAway: 3, yellowCardsHome: 2, yellowCardsAway: 1, redCardsHome: 0, redCardsAway: 1 },
        shots: { totalShotsHome: 14, totalShotsAway: 9, shotsOnTargetHome: 6, shotsOnTargetAway: 4, shotsOffTargetHome: 5, shotsOffTargetAway: 3, blockedShotsHome: 3, blockedShotsAway: 2, shotsInsideBoxHome: 9, shotsInsideBoxAway: 6, shotsOutsideBoxHome: 5, shotsOutsideBoxAway: 3, hitWoodworkHome: 1, hitWoodworkAway: 0, headedGoalsHome: 0, headedGoalsAway: 0 },
        attack: { freeKicksHome: 12, freeKicksAway: 10, offsidesHome: 2, offsidesAway: 3, keyPassesHome: 8, keyPassesAway: 5, crossesHome: 18, crossesAway: 11, accurateCrossesHome: 6, accurateCrossesAway: 4, throwInsHome: 20, throwInsAway: 16 },
        passes: { passesHome: 420, passesAway: 380, accuratePassesHome: 350, accuratePassesAway: 310, accuratePassesPctHome: 83, accuratePassesPctAway: 82, longPassesHome: 45, longPassesAway: 50, accurateLongPassesHome: 25, accurateLongPassesAway: 28, passesFinalThirdHome: 120, passesFinalThirdAway: 95, accurateFinalThirdHome: 80, accurateFinalThirdAway: 60 },
        defense: { foulsHome: 11, foulsAway: 14, duelsWonHome: 52, duelsWonAway: 48, tacklesHome: 18, tacklesAway: 22, tacklesWonHome: 12, tacklesWonAway: 15, interceptionsHome: 9, interceptionsAway: 7, clearancesHome: 24, clearancesAway: 19, errorsToShotHome: 1, errorsToShotAway: 0, errorsToGoalHome: 0, errorsToGoalAway: 1 },
        goalkeeping: { savesHome: 3, savesAway: 5, xgotFacedHome: 0.7, xgotFacedAway: 1.2, goalsConcededHome: 1, goalsConcededAway: 0, goalKicksHome: 8, goalKicksAway: 6 },
      },
      statsHalves: {
        firstHalf: { top: { xgHome: 0.9, xgAway: 0.4, possessionHome: 55, possessionAway: 45 } },
        secondHalf: { top: { xgHome: 0.78, xgAway: 0.55, possessionHome: 62, possessionAway: 38 } },
      },
      events: Array.from({ length: 35 }, (_, i) => ({
        minute: `${10 + i}`, type: i % 5 === 0 ? "goal" : "other", team: i % 2 ? "home" : "away",
        player: `Player ${i}`, detail: `event detail number ${i} with some descriptive text`,
        text: `${10 + i}' Player ${i}`, half: i < 18 ? "first" : "second",
      })),
      lineups: {
        home: { formation: "4-2-3-1", rating: 6.5, xi: xi("Abha"), subs: subs("Abha"), bench: bench("Abha") },
        away: { formation: "3-4-3", rating: 6.8, xi: xi("Al Faisaly"), subs: subs("Al Faisaly"), bench: bench("Al Faisaly") },
      },
      missing: [
        { team: "home", player: "Abha Absent One", reason: "Muscle Injury" },
        { team: "away", player: "Faisaly Absent One", reason: "Red Card" },
      ],
      coaches: { home: "Abha Coach", away: "Faisaly Coach" },
      referee: "Referee Name", venue: "Prince Sultan bin Abdul Aziz Stadium", capacity: 20000, attendance: 12500,
      playerStats: cats,
      marketValue: { home: "€13.9m", away: "€9.2m", homeMillions: 13.9, awayMillions: 9.2 },
      odds: { bookmakers: Array.from({ length: 12 }, (_, i) => ({ name: `Book ${i}`, markets: { "1X2": [2.1, 3.2, 3.8] } })) },
    };
  };

  it("measures a realistic full Abha object and keeps it under budget", () => {
    const entry = buildAbha(31);
    const cleaned = cleanEntryForWorker(entry);
    const rawBytes = entryByteSize(cleaned);
    const c = compactEntry(cleaned, MAX_ENTRY_BYTES);
    assert.ok(c !== null, "protected core must fit");
    assert.ok(entryByteSize(c.entry) <= MAX_ENTRY_BYTES, `compacted ${entryByteSize(c.entry)} > ${MAX_ENTRY_BYTES}`);
    assert.equal(c.entry.stats.top.xgHome, 1.68);
    assert.equal(c.entry.stats.top.xgAway, 0.95);
    assert.equal(c.entry.lineups.home.formation, "4-2-3-1");
    assert.equal(c.entry.lineups.home.xi.length, 11);
    assert.equal(c.entry.events.length, 35);
    assert.equal(c.entry.lineups.home.rating, 6.5);
    assert.deepEqual(validateMatchEntry(c.entry), []);
    console.log(`    Abha 31-row fixture: raw ${rawBytes} bytes, compacted ${entryByteSize(c.entry)} bytes, truncated=${c.truncated}`);
  });

  it("compacts an over-budget object without touching protected fields", () => {
    const entry = buildAbha(300);
    const cleaned = cleanEntryForWorker(entry);
    assert.ok(entryByteSize(cleaned) > MAX_ENTRY_BYTES, "fixture must exceed budget to exercise compaction");
    const c = compactEntry(cleaned, MAX_ENTRY_BYTES);
    assert.ok(c !== null);
    assert.equal(c.truncated, true);
    assert.ok(c.notes.length > 0);
    assert.ok(entryByteSize(c.entry) <= MAX_ENTRY_BYTES);
    assert.equal(c.entry.stats.top.xgHome, 1.68);
    assert.equal(c.entry.lineups.home.xi.length, 11);
    assert.equal(c.entry.events.length, 35);
    assert.equal(c.entry.lineups.home.formation, "4-2-3-1");
  });

  it("does not truncate a small entry", () => {
    const small = {
      date: "2026-10-27", home: "Abha", away: "Al Faisaly",
      xgHome: 1.68, xgAway: 0.95, source: "flashscore",
      stats: { top: { xgHome: 1.68, xgAway: 0.95 } },
      events: [],
    };
    const c = compactEntry(small, MAX_ENTRY_BYTES);
    assert.equal(c.truncated, false);
    assert.deepEqual(c.notes, []);
  });
});
