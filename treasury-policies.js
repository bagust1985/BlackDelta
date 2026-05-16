/**
 * Treasury allocation policies.
 *
 * Each policy takes a context object and returns a weight per candidate.
 * Weights are then normalized by treasury.js and converted into SOL sizes
 * subject to per-pool floor/ceil and portfolio exposure caps.
 *
 * Policy signature:
 *   ({ candidates, openPositions, walletSol, signals, poolHistory, config })
 *     -> { weights: { [poolAddress]: number }, debug?: object }
 *
 * Weights need not sum to 1 — treasury.js normalizes.
 * Returning weight 0 (or omitting a pool) signals "do not deploy".
 */

/**
 * Equal weight across all eligible candidates.
 */
export function equalWeight({ candidates }) {
  const weights = {};
  for (const c of candidates) {
    weights[c.pool] = 1;
  }
  return { weights };
}

/**
 * Kelly-lite — scale by historical win rate × average return, clamped.
 *
 * For pools with no history we fall back to equal weight. This is the
 * conservative variant of Kelly: we cap fractions hard at 0.5 to avoid
 * the over-betting tail.
 */
export function kellyLite({ candidates, poolHistory = {} }) {
  const weights = {};
  for (const c of candidates) {
    const hist = poolHistory[c.pool];
    if (!hist || hist.total_deploys < 3) {
      weights[c.pool] = 1; // not enough data — equal weight fallback
      continue;
    }
    const p = clamp(hist.win_rate ?? 0.5, 0.05, 0.95);   // win prob
    const b = Math.max(0.1, hist.avg_pnl_pct ?? 0) / 100; // payoff ratio
    const q = 1 - p;
    const kelly = b > 0 ? (p * b - q) / b : 0;
    weights[c.pool] = clamp(kelly, 0, 0.5);
  }
  return { weights };
}

/**
 * Risk parity — inverse-volatility weighting.
 * Higher pool volatility → smaller allocation.
 */
export function riskParity({ candidates }) {
  const weights = {};
  for (const c of candidates) {
    const vol = Number(c.volatility);
    if (!Number.isFinite(vol) || vol <= 0) {
      weights[c.pool] = 0; // skip pools with bad volatility data
      continue;
    }
    weights[c.pool] = 1 / vol;
  }
  return { weights };
}

/**
 * Signal-weighted — combine fee/TVL ratio, organic score, and discord
 * signal boosts. This is the closest analogue to the current implicit
 * "screener picks top-1 by score" behavior.
 */
export function signalWeighted({ candidates, signals = {} }) {
  const weights = {};
  for (const c of candidates) {
    const feeTvl = Math.max(0, Number(c.fee_active_tvl_ratio) || 0);
    const organic = Math.max(0, Number(c.organic_score) || 0) / 100;
    const discordBoost = c.discord_signal ? 1.25 : 1;
    const smartMoneyBoost = signals?.smartWallets?.[c.pool] ? 1.4 : 1;
    const raw = (feeTvl * 4 + organic) * discordBoost * smartMoneyBoost;
    weights[c.pool] = Math.max(0, raw);
  }
  return { weights };
}

export const POLICIES = {
  equalWeight,
  kellyLite,
  riskParity,
  signalWeighted,
};

export function resolvePolicy(name) {
  return POLICIES[name] || signalWeighted;
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}
