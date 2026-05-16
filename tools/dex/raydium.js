/**
 * Raydium CLMM adapter — stub.
 *
 * All write operations throw NotImplemented. Read operations return empty
 * shapes so callers can iterate over the registry safely.
 */

const DEX_ID = "raydium";

function notImplemented(method) {
  return async () => {
    const err = new Error(`Raydium adapter: ${method} not implemented (Phase 1 stub)`);
    err.code = "NotImplemented";
    err.dex = DEX_ID;
    throw err;
  };
}

export const raydiumAdapter = {
  id: DEX_ID,

  async getActiveBin() {
    return { dex: DEX_ID, activeBin: null, currentTick: null, price: null };
  },

  async searchPools({ query, limit = 10 } = {}) {
    return { query, total: 0, pools: [], dex: DEX_ID };
  },

  async getMyPositions() {
    return { wallet: null, total_positions: 0, positions: [], dex: DEX_ID };
  },

  async getWalletPositions({ wallet_address } = {}) {
    return { wallet: wallet_address, total_positions: 0, positions: [], dex: DEX_ID };
  },

  async getPositionPnl() {
    return { dex: DEX_ID, pnl_usd: null, in_range: null };
  },

  deployPosition: notImplemented("deployPosition"),
  claimFees: notImplemented("claimFees"),
  closePosition: notImplemented("closePosition"),

  decodeAccount: null,
  subscriptionAccounts: null,
};

export default raydiumAdapter;
