/**
 * Phase 3 backtest harness test.
 *
 * Validates:
 *   - scorer produces deterministic output for fixed trades
 *   - replayer load/start/stop API
 *   - reportHash stable across two runs
 */

import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { score } from "../backtest/scorer.js";
import { loadFixtures, startReplay, stopReplay, remainingFixtureCount } from "../backtest/replayer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const goldenTrades = path.join(__dirname, "..", "backtest", "fixtures", "golden-sample", "trades.json");

console.log("Backtest harness tests:");

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    throw err;
  }
}

const trades = JSON.parse(fs.readFileSync(goldenTrades, "utf8"));

test("scorer produces expected golden-sample stats", () => {
  const r = score(trades);
  assert.equal(r.totalDeploys, 2);
  assert.equal(r.totalCloses, 2);
  assert.equal(r.pnlSol, 0.13);
  assert.equal(r.feesSol, 0.11);
  assert.equal(r.winRate, 0.5);
  assert.equal(r.signalPrecision, 1); // 1 of 1 discord_signal deploys profitable
});

test("scorer reportHash is stable", () => {
  const r1 = score(trades);
  const r2 = score(trades);
  const h1 = crypto.createHash("sha256").update(JSON.stringify(r1)).digest("hex").slice(0, 12);
  const h2 = crypto.createHash("sha256").update(JSON.stringify(r2)).digest("hex").slice(0, 12);
  assert.equal(h1, h2);
});

test("replayer loadFixtures returns shape", () => {
  const dir = path.join(__dirname, "..", "backtest", "fixtures", "golden-sample");
  const result = loadFixtures(dir);
  // golden-sample contains only trades.json (no .ndjson files yet)
  assert.equal(result.count, 0);
});

test("replayer start/stop installs/uninstalls without breaking fetch", async () => {
  const dir = path.join(__dirname, "..", "backtest", "fixtures", "golden-sample");
  const originalFetch = globalThis.fetch;
  startReplay({ fixturesDir: dir });
  assert.notEqual(globalThis.fetch, originalFetch, "fetch should be replaced during replay");
  // A miss should produce a 404 response, not throw
  const r = await globalThis.fetch("https://example.invalid/whatever");
  assert.equal(r.status, 404);
  stopReplay();
  assert.equal(globalThis.fetch, originalFetch, "fetch should be restored after stopReplay");
});

test("scorer handles empty trades array", () => {
  const r = score([]);
  assert.equal(r.totalDeploys, 0);
  assert.equal(r.totalCloses, 0);
  assert.equal(r.pnlSol, 0);
  assert.equal(r.winRate, null);
});

console.log("✓ Phase 3 backtest tests passed");
process.exit(0);
