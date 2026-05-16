/**
 * Phase 6 supervisor smoke test.
 *
 * Validates:
 *   - default mode "single" causes tick() to skip
 *   - registry exposes the three roles with correct tool allow-lists
 *   - bus context patch / reset works
 *
 * The agentLoop itself isn't exercised — that path needs LLM credentials
 * and is covered by live shadow-mode review (per the rollout plan).
 */

import assert from "node:assert/strict";
import { tick } from "../agents/supervisor.js";
import { bus } from "../agents/bus.js";
import { getRoleConfig, ROLES, SCREENER_TOOLS, MANAGER_TOOLS } from "../agents/registry.js";

console.log("Orchestrator tests:");

function test(name, fn) {
  try {
    const ret = fn();
    if (ret && typeof ret.then === "function") {
      return ret.then(() => console.log(`  ✓ ${name}`)).catch((err) => {
        console.error(`  ✗ ${name}`); throw err;
      });
    }
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    throw err;
  }
}

await test("default mode single → tick skips", async () => {
  const r = await tick({ trigger: "cron-mgmt" });
  assert.equal(r.mode, "single");
  assert.equal(r.skipped, true);
});

test("registry covers screener/manager/researcher", () => {
  assert.deepEqual(ROLES.sort(), ["manager", "researcher", "screener"]);
  const s = getRoleConfig("screener");
  const m = getRoleConfig("manager");
  const r = getRoleConfig("researcher");
  assert.equal(s.agentType, "SCREENER");
  assert.equal(m.agentType, "MANAGER");
  assert.equal(r.agentType, "GENERAL");
  assert.deepEqual(s.tools, SCREENER_TOOLS);
  assert.deepEqual(m.tools, MANAGER_TOOLS);
});

test("registry throws on unknown role", () => {
  assert.throws(() => getRoleConfig("hacker"), /Unknown role/);
});

test("bus setContext / getContext / reset", () => {
  bus.resetContext();
  assert.deepEqual(bus.getContext(), {});
  bus.setContext({ trigger: "test", openPositions: [1, 2, 3] });
  assert.equal(bus.getContext().trigger, "test");
  assert.equal(bus.getContext().openPositions.length, 3);
  bus.resetContext();
  assert.deepEqual(bus.getContext(), {});
});

test("bus publish/subscribe emits events", () => {
  const received = [];
  bus.subscribe("test-topic", (p) => received.push(p));
  bus.publish("test-topic", { hello: 1 });
  bus.publish("test-topic", { hello: 2 });
  assert.equal(received.length, 2);
  assert.equal(received[1].hello, 2);
});

console.log("✓ Phase 6 orchestrator tests passed");
process.exit(0);
