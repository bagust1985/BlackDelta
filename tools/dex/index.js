/**
 * BlackDelta DEX adapter registry.
 *
 * IDexAdapter contract:
 *
 *   {
 *     id: "meteora" | "raydium" | "orca",
 *     getActiveBin({ pool_address }): Promise<{ dex, activeBin, currentTick, price, ... }>
 *     searchPools({ query, limit }): Promise<{ pools[], total, query }>
 *     getMyPositions({ force, silent }): Promise<{ positions[], wallet, total_positions }>
 *     getWalletPositions({ wallet_address }): Promise<{ positions[], wallet, total_positions }>
 *     getPositionPnl({ pool_address, position_address }): Promise<{ pnl_usd, in_range, ... }>
 *     deployPosition({ pool_address, amount_sol, strategy, bins_below, ... }): Promise<{ success, position?, error? }>
 *     claimFees({ position_address }): Promise<{ success, txs?, error? }>
 *     closePosition({ position_address, reason }): Promise<{ success, txs?, error? }>
 *     // Optional Phase 4 hooks (null when not implemented):
 *     decodeAccount(buffer): { activeBin, totalLiquidity, ... }
 *     subscriptionAccounts(position): Pubkey[]
 *   }
 *
 * Neutral Position shape returned by getMyPositions/getWalletPositions:
 *   {
 *     dex, pool, position, pair, lower, upper, currentTick, in_range,
 *     pnl_usd, pnl_pct, unclaimed_fees_usd, total_value_usd, age_minutes, ...
 *   }
 *
 * For the Meteora adapter, legacy fields (lower_bin, upper_bin, active_bin)
 * are preserved alongside neutral names so existing callers keep working
 * during the Phase 1 rollout.
 */

import meteoraAdapter from "./meteora.js";
import raydiumAdapter from "./raydium.js";
import orcaAdapter from "./orca.js";
import { defaultDex, isSupportedDex } from "./terms.js";

const REGISTRY = {
  meteora: meteoraAdapter,
  raydium: raydiumAdapter,
  orca: orcaAdapter,
};

/**
 * Get an adapter by DEX id. Falls back to the default (meteora) when
 * the id is missing or null, since pre-Phase-1 records have no dex field.
 * Throws when the id is recognized-but-misspelled (e.g. "uniswap") to
 * surface integration bugs early.
 */
export function getAdapter(dexId) {
  if (!dexId) return REGISTRY[defaultDex()];
  if (!isSupportedDex(dexId)) {
    throw new Error(`Unknown dex id: ${dexId}`);
  }
  return REGISTRY[dexId];
}

export function listAdapters() {
  return Object.keys(REGISTRY);
}

export { meteoraAdapter, raydiumAdapter, orcaAdapter };
