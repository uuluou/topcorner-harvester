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
  isFinished,
  isUpcoming,
  parseStatLines,
  parseTimelineLine,
  validateMatchEntry,
  filterBatch,
  cleanEntryForWorker,
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
