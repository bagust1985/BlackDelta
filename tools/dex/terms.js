/**
 * BlackDelta DEX terminology map.
 *
 * Translates Meteora-specific concepts to DEX-neutral terms so adapters for
 * Raydium CLMM and Orca Whirlpools can share a common surface.
 *
 * Adapters MAY expose extra DEX-specific fields under a namespaced object
 * (e.g. `position.meteora.binStep`) but the neutral fields below must always
 * be populated.
 */

export const NEUTRAL_TERMS = {
  bin: "tick",
  binId: "currentTick",
  binStep: "tickSpacing",
  activeBin: "currentTick",
  lbPair: "pool",
  StrategyType: "distributionStrategy",
  BIN_ARRAY: "tickArray",
  bins_below: "tickRangeBelow",
  bins_above: "tickRangeAbove",
};

export const SUPPORTED_DEX_IDS = ["meteora", "raydium", "orca"];

export function isSupportedDex(dexId) {
  return SUPPORTED_DEX_IDS.includes(dexId);
}

export function defaultDex() {
  return "meteora";
}
