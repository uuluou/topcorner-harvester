// TOPCORNER harvest post step (patched).
// Called by the workflow AFTER harvest.mjs, once per payload file:
//   node post-step.mjs out/payload-<stamp>.json
//
// It POSTs payload.matches to /api/fs/ingest (session cookie first, no
// Origin/Referer headers, x-harvest-token from env), reads the worker's
// honest {data:{stored, failed}} reply, and amends state.json BEFORE the
// workflow commits it:
//   - harvested-marking is gated on stored == sent: if stored < sent (or
//     the post failed / reply unparseable), NONE of that batch's finished
//     keys stay harvested, so the whole batch retries next run.
//   - proposed upcoming-odds hashes are applied ONLY on post success, so a
//     failed post never silently swallows an odds change.
// Exit code is always 0 when state.json was handled (even on post failure),
// so the workflow still commits the pruned state; it is 1 only on usage or
// filesystem errors. It NEVER invents a stored count: an unparseable reply
// counts as stored=null (fail-safe prune).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyPostResult, applyOddsHashes } from "./lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE_URL = process.env.SITE_URL || "https://topcorner.pages.dev";
const STATE_PATH = path.join(HERE, "state.json");

function loadJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

async function fetchSessionCookie() {
  const res = await fetch(`${SITE_URL}/api/session`, {
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`session ${res.status}`);
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  return setCookie.map((c) => c.split(";")[0]).join("; ");
}

async function main() {
  const payloadPath = process.argv[2];
  if (!payloadPath) {
    console.error("usage: node post-step.mjs <payload.json>");
    process.exit(1);
  }
  const token = process.env.HARVEST_TOKEN || "";
  if (!token) {
    console.error("HARVEST_TOKEN is not set; refusing to post");
    process.exit(1);
  }
  const payload = loadJson(payloadPath, null);
  if (!payload || !Array.isArray(payload.matches)) {
    console.error(`payload ${payloadPath} has no matches array; nothing to post`);
    process.exit(1);
  }
  const matches = payload.matches;
  const manifest = (payload.meta && payload.meta.post) || {};
  const finishedKeys = Array.isArray(manifest.finishedKeys) ? manifest.finishedKeys : [];
  const proposedHashes = (manifest.oddsHashes && typeof manifest.oddsHashes === "object") ? manifest.oddsHashes : {};

  if (matches.length === 0) {
    console.log(`post-step: ${payloadPath} has 0 matches; state untouched`);
    return;
  }

  let stored = null;
  let failed = null;
  try {
    const cookie = await fetchSessionCookie();
    const res = await fetch(`${SITE_URL}/api/fs/ingest`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        "x-harvest-token": token,
        "content-type": "application/json",
      },
      body: JSON.stringify({ matches }),
      signal: AbortSignal.timeout(60000),
    });
    const body = await res.json().catch(() => null);
    if (body && body.data && typeof body.data.stored === "number") {
      stored = body.data.stored;
      failed = typeof body.data.failed === "number" ? body.data.failed : matches.length - stored;
    } else {
      console.error(`post-step: unexpected ingest reply (status ${res.status}): ${JSON.stringify(body).slice(0, 300)}`);
    }
  } catch (err) {
    console.error(`post-step: post failed: ${err.message}`);
  }

  const postOk = stored === matches.length;
  let state = loadJson(STATE_PATH, { version: 1, harvested: [] });
  state = applyPostResult(state, finishedKeys, stored, matches.length);
  state = applyOddsHashes(state, proposedHashes, postOk);
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  console.log(
    `post-step: sent ${matches.length}, stored ${stored === null ? "unknown" : stored}, failed ${failed === null ? "unknown" : failed}, ` +
    `harvested kept: ${postOk}, pruned: ${postOk ? 0 : finishedKeys.length}, odds hashes applied: ${postOk ? Object.keys(proposedHashes).length : 0}`
  );
}

main().catch((err) => {
  console.error(`fatal: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
