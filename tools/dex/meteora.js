/**
 * Meteora DLMM adapter.
 *
 * Thin re-export layer around tools/dlmm.js that conforms to the IDexAdapter
 * contract (see tools/dex/index.js). All behavior is delegated unchanged;
 * the only addition is the `dex: "meteora"` annotation on returned objects
 * for downstream routing.
 */

import {
  getActiveBin as _getActiveBin,
  searchPools as _searchPools,
  getMyPositions as _getMyPositions,
  getWalletPositions as _getWalletPositions,
  getPositionPnl as _getPositionPnl,
  deployPosition as _deployPosition,
  claimFees as _claimFees,
  closePosition as _closePosition,
} from "../dlmm.js";
import { decodeLbPair, subscriptionAccounts as _subAccts } from "./meteora-decoder.js";

const DEX_ID = "meteora";

function tag(obj) {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(tag);
  if (!("dex" in obj)) obj.dex = DEX_ID;
  return obj;
}

function tagPositions(result) {
  if (!result || typeof result !== "object") return result;
  if (Array.isArray(result.positions)) {
    result.positions = result.positions.map((p) => {
      if (p && typeof p === "object" && !("dex" in p)) p.dex = DEX_ID;
      return p;
    });
  }
  if (!("dex" in result)) result.dex = DEX_ID;
  return result;
}

export const meteoraAdapter = {
  id: DEX_ID,

  async getActiveBin(args) {
    const res = await _getActiveBin(args);
    return tag(res);
  },

  async searchPools(args) {
    const res = await _searchPools(args);
    if (res && Array.isArray(res.pools)) {
      res.pools.forEach((p) => {
        if (p && typeof p === "object" && !("dex" in p)) p.dex = DEX_ID;
      });
    }
    return res;
  },

  async getMyPositions(args = {}) {
    const res = await _getMyPositions(args);
    return tagPositions(res);
  },

  async getWalletPositions(args) {
    const res = await _getWalletPositions(args);
    return tagPositions(res);
  },

  async getPositionPnl(args) {
    const res = await _getPositionPnl(args);
    return tag(res);
  },

  async deployPosition(args) {
    const res = await _deployPosition(args);
    return tag(res);
  },

  async claimFees(args) {
    const res = await _claimFees(args);
    return tag(res);
  },

  async closePosition(args) {
    const res = await _closePosition(args);
    return tag(res);
  },

  // Phase 4 hooks.
  decodeAccount: decodeLbPair,
  subscriptionAccounts: _subAccts,
};

export default meteoraAdapter;
