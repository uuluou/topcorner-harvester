# TOPCORNER Flashscore harvester

Scheduled harvester that reads Flashscore match pages with a real browser
(Playwright/Chromium on GitHub Actions runners) and writes structured
payload files for TOPCORNER. It does **not** post anything anywhere in its
current version: posting is a later step, owned by the main agent, once the
ingest endpoint and the `HARVEST_TOKEN` secret exist.

## What it harvests

Per run, for the TOPCORNER board of yesterday / today / tomorrow:

- **Finished matches** (not already in `state.json`): summary timeline
  (goals, cards, substitutions with minutes), referee, venue, capacity,
  attendance, the full stats groups (Top, Shots, Attack, Passes, Defense,
  Goalkeeping — including xG, xGOT, xA, goals prevented), lineups
  (formations, match ratings, subs with minutes, bench, missing players
  with reasons, coaches), and player-stat rows.
- **Upcoming matches today**: odds with bookmaker names exactly as
  displayed. Minimum markets: 1X2, Over/Under 2.5, Both Teams To Score;
  more markets are recorded when the page shows them.

One JSON payload file per run lands in `out/` (for example
`out/payload-2026-10-27T10-00-00-000Z.json`). `state.json` is committed
back so re-runs skip finished matches they already harvested.

## Cadence: every 10 minutes, 24/7

`.github/workflows/harvest.yml` runs on the cron expression
`*/10 * * * *` — every 10 minutes, all day, every day — plus a manual
`workflow_dispatch` trigger for testing. `concurrency: cancel-in-progress`
keeps at most one run active. Each run is capped at 30 minutes.

How the 24/7 schedule works: GitHub's scheduler wakes the workflow on
the cron, a fresh Ubuntu runner installs Node + Chromium, runs
`node harvest.mjs`, uploads the payload files as a workflow artifact
(7-day retention), and commits the updated `state.json` back to the repo
with the built-in `GITHUB_TOKEN`. No server of yours runs, no human
touches a run.

## Setup

1. Create a repo (private is fine) and push this directory to it.
2. Confirm the first manual run: Actions > Flashscore harvest > Run
   workflow. Check the run log and the uploaded `payload-*.json`
   artifact. The first run also validates the Flashscore selectors
   (see Limits).
3. Later, when the ingest endpoint exists:
   - Add the repo secret `HARVEST_TOKEN` (Settings > Secrets and
     variables > Actions).
   - Set the same value as a Pages secret named `HARVEST_TOKEN`.
   - Uncomment the posting step at the bottom of `harvest.yml`.

## Board fetching

The harvester reads the site's own board API: `GET /api/session` first
(it sets the `tc_visit` cookie), then `GET /api/board?date=YYYY-MM-DD`
with that cookie plus the site's own Origin/Referer. Calls are
sequential, never parallel. Match state comes from `status.state`
(`pre` / `in` / `post`); scores are never used to decide whether a
match finished, because the feed reports 0-0 for matches that have not
started yet.

## Name mapping (read this before adding leagues)

Site fixture names (ESPN) differ from Flashscore short names
(Paris Saint-Germain vs PSG, Flamengo RJ vs Flamengo). Resolution order
in `harvest.mjs`:

1. `mapping.json` exact key: `date|normalized-home|normalized-away`.
2. Same key with canonical alias names (see `mapping.json` aliases).
3. `state.json` discovered URLs (filled by the discovery fallback).
4. Schedule-page discovery fallback (scans Flashscore's football
   schedule page for links matching both team names).

A fixture that matches nothing is **not** dropped silently: it lands in
the payload file's `meta.unresolved` list and in `state.json` pending,
so an alias can be added to `mapping.json` and the next run picks it
up. Keep aliases current; that file is the mapping's source of truth.

## Ingest payload shape (the future POST)

`POST /api/fs/ingest`, header `x-harvest-token: <HARVEST_TOKEN>`,
body:

```json
{
  "generatedAt": "2026-10-27T10:00:00.000Z",
  "runDates": ["2026-10-26", "2026-10-27", "2026-10-28"],
  "matches": [
    {
      "date": "2026-10-26",
      "home": "PSG",
      "away": "Lyon",
      "xgHome": 0.96,
      "xgAway": 0.65,
      "source": "flashscore",
      "matchUrl": "https://www.flashscore.com/match/football/lyon-2akflumR/psg-CjhkPw0k/?mid=zyZq2xcL",
      "stats": {
        "xg": { "home": 0.96, "away": 0.65 },
        "possession": { "home": 69, "away": 31 }
      },
      "events": [
        { "minute": "72", "type": "goal", "team": null, "player": "Mayulu S.", "detail": "assist Godts M." }
      ],
      "lineups": {
        "home": { "formation": "4-3-3", "xi": null, "subs": null, "bench": null },
        "away": { "formation": "4-3-3", "xi": null, "subs": null, "bench": null }
      },
      "missing": [{ "player": "Dembele O.", "reason": "Thigh Injury", "team": null }],
      "coaches": { "home": "Luis Enrique", "away": "Fonseca P." },
      "referee": "Brisard J.",
      "venue": "Parc des Princes (Paris)",
      "capacity": 48229,
      "attendance": 47000,
      "odds": {
        "bookmakers": [
          { "name": "Fanatics", "markets": { "1X2": [1.28, 6.0, 9.0] } }
        ]
      }
    }
  ],
  "meta": {
    "totalFixtures": 19,
    "skippedFinished": 4,
    "rejected": [],
    "unresolved": []
  }
}
```

Field rules: `date` is a real `YYYY-MM-DD` date; `xgHome`/`xgAway`
are `null` or finite numbers 0-15; any field the page did not show is
`null`, never invented; `stats` keys are the stable labels documented
in `lib.mjs`; odds `markets` keys are market labels (`1X2`,
`overUnder`, `btts`, `doubleChance`, `asianHandicap`, `drawNoBet`,
`correctScore`, `halfTimeFullTime`, `oddEven`) with price arrays in
display order; bookmaker names are recorded exactly as displayed.

## Validation contract (writer vs worker)

The writer applies **per-entry** validation (`lib.mjs` `filterBatch`):
a bad entry is dropped and reported in `meta.rejected` with reasons,
and every good sibling in the same batch is kept. The payload file
therefore always contains only fully valid matches.

The recommended worker contract for `/api/fs/ingest` is the same
per-entry semantics (accept valid entries, report rejected ones
individually). Note the existing `/api/xg/ingest` endpoint is stricter
(whole-batch reject on one bad entry); the payload files this writer
emits satisfy that stricter contract too, because they never contain an
invalid entry — but per-entry results are still recommended for the new
endpoint so one bad match can never hide a whole run's harvest.

## Honest limits (verified, not guessed)

- **Odds are geo-targeted to the runner's egress.** From US egress the
  odds tab showed only US bookmakers (Kalshi, Fanatics, FanDuel,
  DraftKings, BetMGM.us, bet365.us). **1xBet never appeared in any
  load.** This harvester records whatever bookmakers the runner sees;
  it never invents a 1xBet price. If 1xBet odds are required, they need
  a different egress or the OddsPapi route — not this harvester.
- **Selectors need a first live validation.** The extraction code was
  written from a verified text inventory of the match page, not from
  its DOM, and the author's VM cannot reach Flashscore at all. The
  text-based parsers (stats labels, timeline lines, match info) are
  covered by unit tests on sample text, but the DOM table scan for odds
  and the schedule-page discovery URL are best-effort and must be
  confirmed on the first runner run. Check the first artifact before
  trusting the harvest.
- **GitHub scheduled runs can be delayed a few minutes** on busy
  runners, and GitHub automatically disables scheduled workflows in a
  repo with no activity for 60 days. A manual dispatch or any commit
  re-arms the schedule.
- **One failure never kills a run.** Every fixture is wrapped in
  try/catch, navigation retries once, and failures land in
  `meta.unresolved` with a reason. A run exits non-zero only if no
  board could be fetched at all.
- **Live matches are skipped.** Only finished matches get full stats
  and only today's upcoming matches get odds; a live match is picked
  up as finished on a later run.

## Files

- `harvest.mjs` — the harvester (Playwright). Needs `playwright`
  installed; see `package.json`.
- `lib.mjs` — pure helpers (normalization, aliases, validation,
  parsers). No browser, no network; unit-tested.
- `mapping.json` — team aliases + known Flashscore match URLs.
- `state.json` — run state (harvested keys, discovered URLs, pending).
- `test.mjs` — unit tests (`npm test`, plain `node:test`).
- `.github/workflows/harvest.yml` — the 30-minute schedule.
