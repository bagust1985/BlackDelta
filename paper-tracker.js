/**
 * BlackDelta — Paper PnL Tracker
 *
 * Saat `deployPaused=true` + LLM tries deploy → executor blocks AND
 * records to paper-positions.json. Tracker periodically simulates
 * "what would have happened if we deployed" by fetching current price
 * via DexScreener/Meteora datapi, computing approximate PnL based on
 * price drift + estimated fee accrual.
 *
 * Use case: validate LLM picks during paused mode. Compare paper PnL
 * vs actual when live mode resumes → A/B test bot decision quality.
 *
 * State: /var/www/meridian/paper-positions.json
 *   { positions: [{id, deployed_at, pool, base_mint, ...}], closed: [...] }
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";
import { config } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAPER_PATH = path.resolve(__dirname, "paper-positions.json");

function load() {
  if (!fs.existsSync(PAPER_PATH)) return { positions: [], closed: [] };
  try { return JSON.parse(fs.readFileSync(PAPER_PATH, "utf8")); }
  catch { return { positions: [], closed: [] }; }
}

function save(data) {
  fs.writeFileSync(PAPER_PATH, JSON.stringify(data, null, 2) + "\n");
}

/**
 * Record a paper deploy. Called by executor when deployPaused=true
 * and LLM attempts deploy_position.
 *
 * @param {object} args — deploy_position args (pool_address, base_mint, amount_y/amount_sol, bins, etc)
 * @param {object} [meta] — extra context (decision_id, pool_name, etc)
 */
export function recordPaperEntry(args, meta = {}) {
  const data = load();

  // Don't double-record same pool within 1 hour (LLM retry guard)
  const recentDupe = data.positions.find((p) =>
    p.pool === args.pool_address &&
    Date.now() - new Date(p.deployed_at).getTime() < 60 * 60 * 1000
  );
  if (recentDupe) return null;

  const entry = {
    id: `paper_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    deployed_at: new Date().toISOString(),
    pool: args.pool_address,
    pool_name: meta.pool_name || args.pool_name || null,
    base_mint: args.base_mint || meta.base_mint || null,
    strategy: args.strategy || meta.strategy || "spot",
    amount_sol: Number(args.amount_y ?? args.amount_sol ?? 0),
    bin_step: args.bin_step ?? meta.bin_step ?? null,
    bin_range: {
      min: args.min_bin ?? null,
      max: args.max_bin ?? null,
    },
    bins_below: args.bins_below ?? null,
    volatility: meta.volatility ?? null,
    fee_tvl_ratio: meta.fee_tvl_ratio ?? null,
    initial_price_usd: meta.initial_price_usd ?? null,
    decision_id: meta.decision_id || null,
    status: "open",
  };

  data.positions.push(entry);
  save(data);
  log("paper", `Paper entry: ${entry.pool_name || entry.pool?.slice(0, 12)} ${entry.amount_sol} SOL`);
  return entry;
}

/**
 * Evaluate all open paper positions:
 *   - Fetch current price/state via DexScreener (cheap, no auth)
 *   - Compute approximate PnL based on price drift + estimated fees
 *   - Close paper position if older than maxPaperHoldHours
 *
 * Approximation: PnL ≈ price_drift × position_value + estimated_fees
 * where estimated_fees = fee_tvl_ratio × volume_share × duration
 * (best-effort; not as accurate as Meteora datapi PnL but works for trend)
 */
export async function evaluatePaperPositions() {
  const data = load();
  const open = data.positions.filter((p) => p.status === "open");
  if (open.length === 0) return { ok: true, evaluated: 0 };

  const maxHoldHours = config.paperTracker?.maxHoldHours ?? 6;
  const maxHoldMs = maxHoldHours * 3600 * 1000;
  const now = Date.now();

  let evaluated = 0;
  let closed = 0;

  for (const entry of open) {
    const ageMs = now - new Date(entry.deployed_at).getTime();
    const shouldClose = ageMs >= maxHoldMs;

    if (!entry.base_mint) {
      // Can't query without mint — close as N/A after age cap
      if (shouldClose) {
        entry.status = "closed_no_data";
        entry.closed_at = new Date().toISOString();
        entry.minutes_held = Math.round(ageMs / 60000);
        data.closed.push(entry);
        closed++;
      }
      continue;
    }

    try {
      // Fetch current price + 24h volume from DexScreener
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${entry.base_mint}`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) continue;
      const json = await res.json();
      const pair = (json?.pairs || []).find((p) =>
        p.pairAddress === entry.pool ||
        (p.dexId === "meteora-dlmm" && p.baseToken?.address === entry.base_mint)
      ) || (json?.pairs || [])[0];

      if (!pair) continue;

      const currentPriceUsd = Number(pair.priceUsd) || null;
      const liquidity = Number(pair.liquidity?.usd) || null;
      const volH24 = Number(pair.volume?.h24) || 0;
      const priceChH1 = Number(pair.priceChange?.h1) || 0;
      const priceChH24 = Number(pair.priceChange?.h24) || 0;

      // Capture initial price if missing
      if (entry.initial_price_usd == null && currentPriceUsd) {
        entry.initial_price_usd = currentPriceUsd;
      }

      // Approximation PnL:
      //   1. Impermanent loss component: based on price drift since deploy
      //   2. Fee accrual: estimate from pool's fee/TVL × position share × time fraction
      //
      // For single-side SOL deploy: when token price goes UP, your position converts
      // SOL → tokens (less SOL than initial). Vice versa, price DOWN = more tokens but
      // worth less in SOL. Roughly: PnL ≈ -0.5 × |price_change_pct| (IL) + fee_earned.
      const priceDriftPct = entry.initial_price_usd && currentPriceUsd
        ? ((currentPriceUsd - entry.initial_price_usd) / entry.initial_price_usd) * 100
        : 0;

      // Simple IL approximation for DLMM single-side:
      //   if price up X%: IL ≈ -X/4 (you sold low)
      //   if price down X%: IL ≈ -X/2 (you held more tokens at lower price)
      const ilPct = priceDriftPct > 0
        ? -priceDriftPct / 4
        : priceDriftPct / 2;

      // Fee approximation: pool's fee_tvl_ratio (per cycle) × duration fraction
      const ageHours = ageMs / 3600000;
      const feePctEstimate = entry.fee_tvl_ratio
        ? (entry.fee_tvl_ratio * ageHours / 24) * 100   // fee_tvl_ratio is "per day" estimate
        : 0;

      const estimatedPnlPct = ilPct + feePctEstimate;
      const positionValueUsd = entry.amount_sol * (currentPriceUsd && entry.initial_price_usd
        ? (currentPriceUsd / entry.initial_price_usd) * 85  // ~SOL price
        : 85);
      const estimatedPnlUsd = (estimatedPnlPct / 100) * (entry.amount_sol * 85);

      entry.last_check_at = new Date().toISOString();
      entry.current_price_usd = currentPriceUsd;
      entry.liquidity_usd = liquidity;
      entry.price_drift_pct = Number(priceDriftPct.toFixed(2));
      entry.estimated_pnl_pct = Number(estimatedPnlPct.toFixed(2));
      entry.estimated_pnl_usd = Number(estimatedPnlUsd.toFixed(2));
      entry.minutes_held = Math.round(ageMs / 60000);
      entry.dexscreener_h1_change = priceChH1;
      entry.dexscreener_h24_change = priceChH24;

      evaluated++;

      if (shouldClose) {
        entry.status = "closed_paper";
        entry.closed_at = new Date().toISOString();
        entry.close_reason = `paper age cap ${maxHoldHours}h reached`;
        data.closed.push(entry);
        closed++;
        log("paper", `Paper closed: ${entry.pool_name || entry.pool?.slice(0, 12)} | est PnL ${entry.estimated_pnl_pct}% ($${entry.estimated_pnl_usd}) | held ${entry.minutes_held}m`);
      }
    } catch (e) {
      log("paper_warn", `Failed to eval ${entry.pool_name}: ${e.message?.slice(0, 60)}`);
    }
  }

  // Remove closed from positions
  data.positions = data.positions.filter((p) => p.status === "open");

  // Cap closed history at 100 entries
  if (data.closed.length > 100) data.closed = data.closed.slice(-100);

  save(data);
  return { ok: true, evaluated, closed, open_after: data.positions.length };
}

/**
 * Generate summary stats for dashboard/CLI.
 */
export function getPaperSummary() {
  const data = load();
  const closed = data.closed || [];
  if (closed.length === 0) {
    return { closed_count: 0, win_count: 0, win_rate_pct: null, total_pnl_usd: 0, avg_pnl_usd: 0, open_count: data.positions?.length || 0 };
  }
  const wins = closed.filter((p) => (p.estimated_pnl_usd || 0) > 0);
  const totalPnl = closed.reduce((s, p) => s + (p.estimated_pnl_usd || 0), 0);
  return {
    closed_count: closed.length,
    win_count: wins.length,
    win_rate_pct: Number(((wins.length / closed.length) * 100).toFixed(1)),
    total_pnl_usd: Number(totalPnl.toFixed(2)),
    avg_pnl_usd: Number((totalPnl / closed.length).toFixed(2)),
    open_count: data.positions?.length || 0,
    recent: closed.slice(-10).reverse(),
  };
}
