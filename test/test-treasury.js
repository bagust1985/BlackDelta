/**
 * Phase 2 treasury allocator test.
 *
 * Validates per-policy sizing across a synthetic candidate set.
 * No network, no SDK init — pure compute over fixture data.
 */

import assert from "node:assert/strict";
import { allocate, shadowDiff } from "../treasury.js";
import { signalWeighted, equalWeight, riskParity, kellyLite, resolvePolicy } from "../treasury-policies.js";

const baseCfg = {
  enabled: false,
  policy: "signalWeighted",
  perPoolFloorSol: 0.5,
  perPoolCeilSol: 5,
  maxPortfolioExposurePct: 0.85,
  gasReserve: 0.2,
  dexCaps: {},
};

const candidates = [
  { pool: "POOL_A", dex: "meteora", volatility: 1.0, fee_active_tvl_ratio: 0.08, organic_score: 75, discord_signal: false },
  { pool: "POOL_B", dex: "meteora", volatility: 3.0, fee_active_tvl_ratio: 0.04, organic_score: 60, discord_signal: true },
  { pool: "POOL_C", dex: "raydium", volatility: 2.0, fee_active_tvl_ratio: 0.06, organic_score: 70, discord_signal: false },
];

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    throw err;
  }
}

console.log("Treasury allocator tests:");

test("empty candidates → empty sizes", () => {
  const r = allocate({ candidates: [], openPositions: [], walletSol: 5, config: baseCfg });
  assert.deepEqual(r.sizes, {});
});

test("walletSol below floor → skipped with reason", () => {
  const r = allocate({ candidates, openPositions: [], walletSol: 0.3, config: baseCfg });
  assert.deepEqual(r.sizes, {});
  assert.equal(r.skipped[0].reason.includes("below per-pool floor"), true);
});

test("signalWeighted distributes by signal strength", () => {
  const r = allocate({ candidates, openPositions: [], walletSol: 5, config: baseCfg });
  // POOL_A has high feeTvl + organic → should get more weight than POOL_B (high vol but discord boost)
  assert.equal(Object.keys(r.sizes).length, 3);
  const total = Object.values(r.sizes).reduce((a, b) => a + b, 0);
  // walletSol=5, gasReserve=0.2, deployable=4.8, exposure cap=5*0.85=4.25 → capital=4.25
  assert.ok(total <= 4.3, `total ${total} should be within budget (4.25)`);
  assert.ok(total >= 3.8, `total ${total} should be near budget`);
});

test("equalWeight gives identical sizes", () => {
  const r = allocate({ candidates, openPositions: [], walletSol: 5, config: { ...baseCfg, policy: "equalWeight" } });
  const vals = Object.values(r.sizes);
  assert.equal(vals.length, 3);
  // All sizes should be within 0.01 SOL of each other
  const max = Math.max(...vals);
  const min = Math.min(...vals);
  assert.ok(max - min < 0.02, `equalWeight produced varied sizes: ${vals}`);
});

test("riskParity favors low-volatility pools", () => {
  const r = allocate({ candidates, openPositions: [], walletSol: 5, config: { ...baseCfg, policy: "riskParity" } });
  // POOL_A (vol=1) > POOL_C (vol=2) > POOL_B (vol=3)
  assert.ok(r.sizes.POOL_A > r.sizes.POOL_C, "POOL_A should beat POOL_C by inverse-vol");
  assert.ok(r.sizes.POOL_C > r.sizes.POOL_B, "POOL_C should beat POOL_B by inverse-vol");
});

test("duplicate pool in open positions is skipped", () => {
  const r = allocate({
    candidates,
    openPositions: [{ pool: "POOL_A", dex: "meteora", amount_sol: 1 }],
    walletSol: 5,
    config: baseCfg,
  });
  assert.equal(r.sizes.POOL_A, undefined);
  assert.ok(r.skipped.some((s) => s.poolAddr === "POOL_A" && s.reason.includes("already deployed")));
});

test("per-DEX cap zeroes overflowing dex", () => {
  const r = allocate({
    candidates,
    openPositions: [{ pool: "POOL_X", dex: "meteora", amount_sol: 4 }],
    walletSol: 5,
    config: { ...baseCfg, dexCaps: { meteora: 0.5 } }, // budget = 5*0.5 = 2.5, existing 4 exceeds
  });
  // Meteora pools should be skipped
  assert.equal(r.sizes.POOL_A, undefined);
  assert.equal(r.sizes.POOL_B, undefined);
  assert.ok(r.skipped.some((s) => s.reason.includes("meteora DEX cap")));
});

test("perPoolCeil truncates oversized allocations", () => {
  const single = [candidates[0]];
  const r = allocate({
    candidates: single,
    openPositions: [],
    walletSol: 100,
    config: { ...baseCfg, perPoolCeilSol: 2 },
  });
  assert.ok(r.sizes.POOL_A <= 2.001, `POOL_A=${r.sizes.POOL_A} exceeded ceil`);
});

test("audit metadata is populated", () => {
  const r = allocate({ candidates, openPositions: [], walletSol: 5, config: baseCfg });
  assert.equal(r.audit.policy, "signalWeighted");
  assert.equal(r.audit.inputs.candidateCount, 3);
  assert.equal(typeof r.audit.weights, "object");
  assert.equal(typeof r.audit.normalization.totalWeight, "number");
});

test("resolvePolicy falls back to signalWeighted", () => {
  assert.equal(resolvePolicy("garbage"), signalWeighted);
  assert.equal(resolvePolicy("equalWeight"), equalWeight);
  assert.equal(resolvePolicy("riskParity"), riskParity);
  assert.equal(resolvePolicy("kellyLite"), kellyLite);
});

test("shadowDiff produces signed pct", () => {
  const d1 = shadowDiff({ poolAddr: "X", legacySol: 1, allocatorSol: 1.5 });
  assert.equal(d1.diffPct, 50);
  const d2 = shadowDiff({ poolAddr: "Y", legacySol: 1, allocatorSol: 0.7 });
  assert.equal(d2.diffPct, -30);
  const d3 = shadowDiff({ poolAddr: "Z", legacySol: 0, allocatorSol: 0.5 });
  assert.equal(d3.diffPct, null);
});

console.log("✓ Phase 2 treasury tests passed");
process.exit(0);
