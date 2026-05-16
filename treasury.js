/**
 * BlackDelta treasury allocator.
 *
 * Portfolio-level position sizing across N candidate pools and M open
 * positions. Replaces per-pool computeDeployAmount with a single batch
 * decision that respects:
 *   - per-DEX exposure caps
 *   - portfolio total exposure cap
 *   - per-pool floor / ceil
 *   - gas reserve
 *   - existing open-position exposure
 *
 * Usage:
 *   const result = await allocate({
 *     candidates, openPositions, walletSol, signals, config
 *   });
 *   // result.sizes[poolAddr] = solAmount (0 means skip)
 *   // result.skipped[] = [{ poolAddr, reason }]
 *   // result.audit = { policy, inputs, output, weights, normalization }
 *
 * Feature flag: config.treasury.enabled. When false, callers should
 * still use computeDeployAmount(walletSol) — this module is for
 * shadow-mode logging and post-flip use.
 */

import { resolvePolicy } from "./treasury-policies.js";
import { getPoolMemory } from "./pool-memory.js";

const DEFAULT_POLICY = "signalWeighted";

/**
 * Allocate SOL across candidates.
 *
 * @param {object} opts
 * @param {Array<object>} opts.candidates       — condensed pool objects from screening.js (must have `pool`, `dex`)
 * @param {Array<object>} opts.openPositions    — current open positions (with `pool`, `dex`, `amount_sol`)
 * @param {number}       opts.walletSol         — current wallet SOL balance
 * @param {object}       [opts.signals]         — optional signal map for signalWeighted policy
 * @param {object}       opts.config            — config.treasury subtree
 */
export function allocate({
  candidates = [],
  openPositions = [],
  walletSol = 0,
  signals = {},
  config: tconfig = {},
}) {
  const audit = {
    policy: tconfig.policy || DEFAULT_POLICY,
    inputs: {
      candidateCount: candidates.length,
      openPositionCount: openPositions.length,
      walletSol,
    },
    output: null,
    weights: null,
    normalization: null,
    skipped: [],
  };

  if (!candidates.length) {
    audit.output = {};
    audit.skipped = [];
    return { sizes: {}, skipped: [], audit };
  }

  const skipped = [];
  const gasReserve = num(tconfig.gasReserve, 0.2);
  const perPoolFloor = num(tconfig.perPoolFloorSol, 0.5);
  const perPoolCeil = num(tconfig.perPoolCeilSol, 50);
  const maxExposurePct = clamp(num(tconfig.maxPortfolioExposurePct, 0.85), 0, 1);
  const dexCaps = tconfig.dexCaps || {}; // e.g. { meteora: 0.7, raydium: 0.2 }

  // 1. Capital available for new deploys
  const existingExposureSol = openPositions.reduce(
    (acc, p) => acc + (Number(p.amount_sol) || 0),
    0,
  );
  const deployable = Math.max(0, walletSol - gasReserve);
  const exposureBudget = (walletSol + existingExposureSol) * maxExposurePct;
  const remainingExposure = Math.max(
    0,
    exposureBudget - existingExposureSol,
  );
  const capital = Math.min(deployable, remainingExposure);

  audit.inputs.gasReserve = gasReserve;
  audit.inputs.deployable = round(deployable, 4);
  audit.inputs.existingExposureSol = round(existingExposureSol, 4);
  audit.inputs.capital = round(capital, 4);
  audit.inputs.perPoolFloor = perPoolFloor;
  audit.inputs.perPoolCeil = perPoolCeil;

  if (capital < perPoolFloor) {
    skipped.push({ poolAddr: "*", reason: `capital ${capital.toFixed(3)} SOL below per-pool floor ${perPoolFloor}` });
    audit.skipped = skipped;
    audit.output = {};
    return { sizes: {}, skipped, audit };
  }

  // 2. Filter candidates: drop dupes vs open positions, dropped DEX,
  //    invalid pool addr.
  const openPools = new Set(openPositions.map((p) => p.pool));
  const eligible = [];
  for (const c of candidates) {
    if (!c?.pool) continue;
    if (openPools.has(c.pool)) {
      skipped.push({ poolAddr: c.pool, reason: "already deployed" });
      continue;
    }
    eligible.push(c);
  }

  if (!eligible.length) {
    audit.skipped = skipped;
    audit.output = {};
    return { sizes: {}, skipped, audit };
  }

  // 3. Build pool history map from pool-memory.js (input to kellyLite).
  // getPoolMemory always returns an object — when the pool is unknown it
  // sets `known: false` and omits stats; skip those so policies don't see
  // synthetic-but-empty history entries.
  const poolHistory = {};
  for (const c of eligible) {
    const mem = getPoolMemory({ pool_address: c.pool });
    if (mem && mem.known) {
      poolHistory[c.pool] = {
        total_deploys: mem.total_deploys || 0,
        win_rate: mem.win_rate ?? null,
        avg_pnl_pct: mem.avg_pnl_pct ?? null,
      };
    }
  }

  // 4. Policy-driven weighting
  const policyFn = resolvePolicy(tconfig.policy || DEFAULT_POLICY);
  const { weights, debug } = policyFn({
    candidates: eligible,
    openPositions,
    walletSol,
    signals,
    poolHistory,
    config: tconfig,
  });
  audit.weights = weights;
  if (debug) audit.policyDebug = debug;

  // 5. Apply per-DEX caps (zero out weight for over-cap DEX)
  if (Object.keys(dexCaps).length) {
    const exposureByDex = {};
    for (const p of openPositions) {
      const dex = p.dex || "meteora";
      exposureByDex[dex] = (exposureByDex[dex] || 0) + (Number(p.amount_sol) || 0);
    }
    for (const c of eligible) {
      const dex = c.dex || "meteora";
      const capPct = dexCaps[dex];
      if (capPct == null) continue;
      const dexBudget = walletSol * capPct;
      if ((exposureByDex[dex] || 0) >= dexBudget) {
        if (weights[c.pool] > 0) {
          weights[c.pool] = 0;
          skipped.push({ poolAddr: c.pool, reason: `${dex} DEX cap reached` });
        }
      }
    }
  }

  // 6. Normalize weights to budget
  const totalWeight = Object.values(weights).reduce((a, b) => a + (b > 0 ? b : 0), 0);
  audit.normalization = { totalWeight, capital };

  const sizes = {};
  if (totalWeight <= 0) {
    audit.skipped = skipped;
    audit.output = sizes;
    return { sizes, skipped, audit };
  }

  for (const c of eligible) {
    const w = weights[c.pool];
    if (!w || w <= 0) continue;
    const raw = (w / totalWeight) * capital;
    let size = Math.min(perPoolCeil, raw);
    if (size < perPoolFloor) {
      // Don't deploy fractional positions below floor — skip.
      skipped.push({ poolAddr: c.pool, reason: `allocated ${size.toFixed(3)} below floor ${perPoolFloor}` });
      continue;
    }
    sizes[c.pool] = round(size, 3);
  }

  audit.skipped = skipped;
  audit.output = sizes;
  return { sizes, skipped, audit };
}

/**
 * Shadow-mode comparison helper. Computes both the legacy per-pool size
 * (via computeDeployAmount) and the allocator size, returning a diff
 * record suitable for decision-log + logger.
 *
 * Used by index.js / executor.js when config.treasury.enabled === false,
 * so we collect 7 days of diff data before flipping the flag.
 */
export function shadowDiff({ poolAddr, legacySol, allocatorSol }) {
  const diffSol = allocatorSol - legacySol;
  const diffPct = legacySol > 0 ? (diffSol / legacySol) * 100 : null;
  return {
    poolAddr,
    legacySol: round(legacySol, 3),
    allocatorSol: round(allocatorSol, 3),
    diffSol: round(diffSol, 3),
    diffPct: diffPct != null ? round(diffPct, 1) : null,
    ts: new Date().toISOString(),
  };
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function round(n, decimals = 2) {
  return Math.round(n * 10 ** decimals) / 10 ** decimals;
}
