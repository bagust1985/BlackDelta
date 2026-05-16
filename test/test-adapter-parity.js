/**
 * Phase 1 parity test: confirm the meteora adapter is a shape-preserving
 * wrapper around tools/dlmm.js.
 *
 * This is a static check — no network, no SDK init. We assert:
 *   1. Adapter registry resolves all three DEX ids.
 *   2. Default-dex lookup matches "meteora".
 *   3. Unknown dex id throws.
 *   4. Meteora adapter exposes the same 8 method names that executor.js
 *      uses to route DLMM operations.
 *   5. Raydium/Orca stubs respond to every required method (read ops
 *      return safe empty shapes; write ops throw NotImplemented).
 */

import assert from "node:assert/strict";
import { getAdapter, listAdapters, meteoraAdapter, raydiumAdapter, orcaAdapter } from "../tools/dex/index.js";

const REQUIRED_METHODS = [
  "getActiveBin",
  "searchPools",
  "getMyPositions",
  "getWalletPositions",
  "getPositionPnl",
  "deployPosition",
  "claimFees",
  "closePosition",
];

function expectMethods(adapter, name) {
  for (const m of REQUIRED_METHODS) {
    assert.equal(typeof adapter[m], "function", `${name} adapter missing ${m}`);
  }
}

async function main() {
  // 1. Registry has all three.
  const ids = listAdapters().sort();
  assert.deepEqual(ids, ["meteora", "orca", "raydium"]);

  // 2. Default-dex lookup.
  assert.equal(getAdapter().id, "meteora");
  assert.equal(getAdapter(null).id, "meteora");
  assert.equal(getAdapter("meteora").id, "meteora");
  assert.equal(getAdapter("raydium").id, "raydium");
  assert.equal(getAdapter("orca").id, "orca");

  // 3. Unknown id throws.
  assert.throws(() => getAdapter("uniswap"), /Unknown dex id/);

  // 4. Meteora adapter has all required methods.
  expectMethods(meteoraAdapter, "meteora");
  expectMethods(raydiumAdapter, "raydium");
  expectMethods(orcaAdapter, "orca");

  // 5. Stub read ops return safe empty shapes.
  const ray = await raydiumAdapter.searchPools({ query: "x" });
  assert.equal(ray.dex, "raydium");
  assert.deepEqual(ray.pools, []);
  const orca = await orcaAdapter.getMyPositions();
  assert.equal(orca.dex, "orca");
  assert.deepEqual(orca.positions, []);

  // 6. Stub write ops throw NotImplemented.
  await assert.rejects(
    () => raydiumAdapter.deployPosition({ pool_address: "x", amount_sol: 1 }),
    (err) => err.code === "NotImplemented" && err.dex === "raydium",
  );
  await assert.rejects(
    () => orcaAdapter.closePosition({ position_address: "x", reason: "test" }),
    (err) => err.code === "NotImplemented" && err.dex === "orca",
  );

  console.log("✓ Phase 1 adapter parity test passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("✗ adapter parity test failed:", err);
    process.exit(1);
  });
