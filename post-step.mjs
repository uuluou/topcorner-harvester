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
import { applyPostResult, applyOddsHashes, applyVerifyResult, updateRequeuePool, classifyReadback } from "./lib.mjs";

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

// Sessioned model-route read for verify-after-post. Mirrors harvest.mjs's
// fetchModel: returns parsed JSON or null on any failure/non-200.
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
  // Read-back manifest (added by the self-healing harvester): league+id per
  // valid finished entry. Entries without league/id keep stored-count
  // gating only (the model route cannot address them); this is logged.
  const verifyList = Array.isArray(manifest.verify) ? manifest.verify.filter((v) => v && v.key && v.league && v.id) : [];

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
  // SELF-HEALING: verify-after-post. Stored-count gating alone trusts the
  // worker's count; read-back trusts only a live fs row that is present
  // AND non-empty (same rule as needsReharvest, inverted). A row is
  // harvested ONLY if stored == sent AND its read-back passes (or it has
  // no league/id, in which case stored-count gating stands and the gap
  // is logged). Failures stay out of harvested AND stay in the requeue
  // pool, so the next run retries them by itself.
  let verified = [];
  let verifyFailed = {};
  let poolRemaining = Array.isArray(state.requeuePool) ? state.requeuePool.length : 0;
  if (postOk && verifyList.length > 0) {
    // Reuse the session cookie from the post (same run, same gate).
    let cookie = "";
    try {
      cookie = await fetchSessionCookie();
    } catch (err) {
      console.error(`post-step: verify session failed: ${err.message}`);
    }
    for (const v of verifyList) {
      // Only verify keys this batch actually posted and kept through the
      // stored-count gate; a pruned key is already pending again.
      if (!state.harvested.includes(v.key)) continue;
      if (!cookie) {
        verifyFailed[v.key] = "read failed";
        continue;
      }
      const body = await fetchModel(v.league, v.id, cookie);
      const data = body && body.data;
      if (!data) {
        verifyFailed[v.key] = "read failed";
      } else if (data.locked) {
        verifyFailed[v.key] = "locked";
      } else {
        const c = classifyReadback(data.fs);
        if (c.ok) verified.push(v.key);
        else verifyFailed[v.key] = c.reason;
      }
    }
    state = applyVerifyResult(state, verified, verifyFailed);
    // Pool bookkeeping: a pooled key leaves the pool ONLY when this batch
    // posted it (stored == sent) and it did not fail read-back. Keys
    // without a verify entry leave on stored-count gating alone.
    const poolKeys = new Set((state.requeuePool || []).map((e) => e.key));
    const succeededPoolKeys = finishedKeys.filter((k) => poolKeys.has(k) && !Object.prototype.hasOwnProperty.call(verifyFailed, k));
    state.requeuePool = updateRequeuePool(state.requeuePool || [], succeededPoolKeys);
    poolRemaining = state.requeuePool.length;
  } else if (postOk && verifyList.length === 0) {
    console.log("post-step: no verify manifest; stored-count gating only");
  }
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  const failedList = Object.entries(verifyFailed).map(([k, r]) => `${k} (${r})`).join(", ");
  console.log(
    `post-step: sent ${matches.length}, stored ${stored === null ? "unknown" : stored}, failed ${failed === null ? "unknown" : failed}, ` +
    `harvested kept: ${postOk}, pruned: ${postOk ? 0 : finishedKeys.length}, odds hashes applied: ${postOk ? Object.keys(proposedHashes).length : 0}, ` +
    `verified: ${verified.length}, unverified: ${Object.keys(verifyFailed).length}${failedList ? ` [${failedList}]` : ""}, requeue pool: ${poolRemaining}`
  );
}

main().catch((err) => {
  console.error(`fatal: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
