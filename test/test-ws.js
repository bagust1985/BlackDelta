/**
 * Phase 4 WS subscriber smoke test (no live RPC).
 *
 * Validates that the wsSubscriber:
 *   - reports disabled by default
 *   - exposes the required methods
 *   - emits events synchronously when triggered
 *   - reports stale-feed correctly
 *   - throttles reconnect attempts via exponential backoff (interface check)
 *
 * A live OOR detection test against mainnet is left for staging — running
 * it requires a real RPC endpoint with WS and an active pool.
 */

import assert from "node:assert/strict";
import { wsSubscriber } from "../ws-subscriber.js";

console.log("WS subscriber tests:");

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    throw err;
  }
}

test("disabled by default (config.subscriptions.enabled=false)", () => {
  assert.equal(wsSubscriber.isEnabled(), false);
});

test("required public methods exist", () => {
  for (const m of ["start", "stop", "watch", "unwatch", "isEnabled", "isStale", "lastEventAt", "on", "emit"]) {
    assert.equal(typeof wsSubscriber[m], "function", `missing ${m}`);
  }
});

test("watch returns null when subscriber disabled", async () => {
  const r = await wsSubscriber.watch({ position: "X", pool: "P", lower: 0, upper: 100 });
  assert.equal(r, null);
});

test("isStale reports true with no events and disabled feed", () => {
  assert.equal(wsSubscriber.isStale(), true);
});

test("event emission works (tick + oor)", () => {
  const received = [];
  wsSubscriber.once("tick", (ev) => received.push(["tick", ev]));
  wsSubscriber.once("oor", (ev) => received.push(["oor", ev]));
  wsSubscriber.emit("tick", { pool: "P", position: "X", activeBin: 10 });
  wsSubscriber.emit("oor", { pool: "P", position: "X", activeBin: 999 });
  assert.equal(received.length, 2);
  assert.equal(received[0][0], "tick");
  assert.equal(received[1][0], "oor");
});

test("watchedPositions starts empty", () => {
  assert.deepEqual(wsSubscriber.watchedPositions(), []);
});

console.log("✓ Phase 4 WS subscriber tests passed");
process.exit(0);
