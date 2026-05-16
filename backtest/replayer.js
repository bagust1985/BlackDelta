/**
 * Backtest replayer — replaces globalThis.fetch with a fixture-driven
 * version that walks NDJSON files written by recorder.js.
 *
 * Each fixture lookup is keyed by (URL host, URL path + sorted query
 * string, method, request body hash). Misses return a 404 fixture-not-
 * found response so callers can detect drift between fixture coverage
 * and runtime needs.
 *
 * The replayer also installs a virtual clock: Date.now() returns a
 * monotonically advancing timestamp seeded from the first fixture ts.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";

const _store = new Map(); // key -> array of records, consumed in order
let _virtualClockMs = 0;
let _originalFetch = null;
let _originalDateNow = null;
let _active = false;

function recordKey({ url, method, request_body }) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const query = [...u.searchParams.entries()].sort().map(([k, v]) => `${k}=${v}`).join("&");
  const bodyHash = request_body ? crypto.createHash("md5").update(request_body).digest("hex").slice(0, 8) : "_";
  return `${method.toUpperCase()} ${u.host}${u.pathname}?${query} ${bodyHash}`;
}

export function loadFixtures(fixturesDir) {
  if (!fs.existsSync(fixturesDir)) {
    throw new Error(`Fixtures dir not found: ${fixturesDir}`);
  }
  const files = fs.readdirSync(fixturesDir).filter((f) => f.endsWith(".ndjson"));
  let firstTs = null;
  let count = 0;
  for (const f of files) {
    const lines = fs.readFileSync(path.join(fixturesDir, f), "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const rec = JSON.parse(line);
        if (firstTs == null || rec.ts < firstTs) firstTs = rec.ts;
        const key = recordKey(rec);
        if (!key) continue;
        if (!_store.has(key)) _store.set(key, []);
        _store.get(key).push(rec);
        count++;
      } catch { /* skip */ }
    }
  }
  if (firstTs != null) _virtualClockMs = firstTs;
  return { count, firstTs, files: files.length };
}

export function startReplay({ fixturesDir }) {
  if (_active) return;
  loadFixtures(fixturesDir);
  _originalFetch = globalThis.fetch;
  _originalDateNow = Date.now;

  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input?.url;
    const method = (init.method || "GET").toUpperCase();
    const body = typeof init.body === "string" ? init.body : null;
    const key = recordKey({ url, method, request_body: body });
    const queue = key && _store.get(key);
    if (!queue || queue.length === 0) {
      return new Response(JSON.stringify({ error: "fixture-miss", key }), {
        status: 404,
        headers: { "content-type": "application/json", "x-replayer": "miss" },
      });
    }
    const rec = queue.shift();
    _virtualClockMs = Math.max(_virtualClockMs, rec.ts);
    return new Response(rec.response_text, {
      status: rec.status,
      headers: { "content-type": "application/json", "x-replayer": "hit" },
    });
  };

  Date.now = () => _virtualClockMs;
  _active = true;
}

export function stopReplay() {
  if (!_active) return;
  if (_originalFetch) globalThis.fetch = _originalFetch;
  if (_originalDateNow) Date.now = _originalDateNow;
  _store.clear();
  _active = false;
}

export function advanceClock(ms) {
  _virtualClockMs += ms;
}

export function getClock() {
  return _virtualClockMs;
}

export function remainingFixtureCount() {
  let n = 0;
  for (const arr of _store.values()) n += arr.length;
  return n;
}
