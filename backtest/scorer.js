/**
 * Backtest scorer — computes a Report from a list of recorded trade
 * intents and the resulting (mock) position lifecycle events.
 *
 * Inputs:
 *   trades = [
 *     { type: "deploy", ts, pool, dex, amount_sol, pool_name? },
 *     { type: "close", ts, pool, pnl_sol, pnl_pct, fees_earned_sol },
 *     ...
 *   ]
 *
 * Output Report fields:
 *   - totalDeploys, totalCloses
 *   - pnlSol (sum of close.pnl_sol)
 *   - feesSol (sum of close.fees_earned_sol)
 *   - winRate (closes with pnl_sol > 0)
 *   - avgPnlPct, medianPnlPct
 *   - maxDrawdownPct (peak-to-trough on cumulative pnlSol)
 *   - durationHours
 *   - signalPrecision (deploys backed by discord_signal that closed in profit)
 */

export function score(trades, options = {}) {
  const deploys = trades.filter((t) => t.type === "deploy");
  const closes = trades.filter((t) => t.type === "close");

  const totalDeploys = deploys.length;
  const totalCloses = closes.length;

  let pnlSol = 0;
  let feesSol = 0;
  const pnlPcts = [];
  const cumulative = [];
  let cumNow = 0;
  let wins = 0;

  for (const c of closes) {
    pnlSol += Number(c.pnl_sol) || 0;
    feesSol += Number(c.fees_earned_sol) || 0;
    if (Number(c.pnl_sol) > 0) wins++;
    if (Number.isFinite(c.pnl_pct)) pnlPcts.push(Number(c.pnl_pct));
    cumNow += Number(c.pnl_sol) || 0;
    cumulative.push(cumNow);
  }

  const avgPnlPct = pnlPcts.length ? pnlPcts.reduce((a, b) => a + b, 0) / pnlPcts.length : null;
  const medianPnlPct = pnlPcts.length ? median([...pnlPcts]) : null;
  const winRate = totalCloses ? wins / totalCloses : null;

  let peak = 0;
  let maxDrawdown = 0;
  for (const v of cumulative) {
    if (v > peak) peak = v;
    const dd = peak - v;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }
  const maxDrawdownPct = peak > 0 ? (maxDrawdown / peak) * 100 : 0;

  const tsList = trades.map((t) => t.ts).filter(Number.isFinite);
  const startTs = tsList.length ? Math.min(...tsList) : null;
  const endTs = tsList.length ? Math.max(...tsList) : null;
  const durationHours = startTs != null && endTs != null
    ? (endTs - startTs) / 3_600_000
    : null;

  const signalPrecision = (() => {
    const signalDeploys = deploys.filter((d) => d.discord_signal);
    if (!signalDeploys.length) return null;
    const closedByPool = new Map(closes.map((c) => [c.pool, c]));
    let hits = 0;
    let counted = 0;
    for (const d of signalDeploys) {
      const c = closedByPool.get(d.pool);
      if (!c) continue;
      counted++;
      if (Number(c.pnl_sol) > 0) hits++;
    }
    return counted ? hits / counted : null;
  })();

  return {
    totalDeploys,
    totalCloses,
    pnlSol: round(pnlSol, 4),
    feesSol: round(feesSol, 4),
    winRate: winRate != null ? round(winRate, 3) : null,
    avgPnlPct: avgPnlPct != null ? round(avgPnlPct, 2) : null,
    medianPnlPct: medianPnlPct != null ? round(medianPnlPct, 2) : null,
    maxDrawdownPct: round(maxDrawdownPct, 2),
    durationHours: durationHours != null ? round(durationHours, 2) : null,
    signalPrecision: signalPrecision != null ? round(signalPrecision, 3) : null,
    config: options.configHash || null,
  };
}

function median(arr) {
  arr.sort((a, b) => a - b);
  const m = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[m] : (arr[m - 1] + arr[m]) / 2;
}

function round(n, decimals = 2) {
  return Math.round(n * 10 ** decimals) / 10 ** decimals;
}
