/**
 * BlackDelta — Market Regime Detector
 *
 * Periodically samples recent screening candidates + closed positions
 * to derive a "market health" score. Auto-toggles `screening.deployPaused`:
 *
 *   - Market COLD  (low vol, low fees, losses cluster) → deployPaused=true
 *   - Market WARM  (recovering, mixed signals)         → no change
 *   - Market HOT   (high vol, high fees, wins cluster) → deployPaused=false
 *
 * Run via cron (default every 30 minutes). Decisions persisted to
 * decision-log so you can audit auto-toggle history at dashboard.
 *
 * Config: config.marketRegime — all keys tunable.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";
import { config } from "./config.js";
import { appendDecision } from "./decision-log.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.resolve(__dirname, "user-config.json");
const LESSONS_PATH     = path.resolve(__dirname, "lessons.json");

/**
 * Compute market regime score (0-100) from recent perf.
 * Lower = colder, higher = hotter.
 *
 * Inputs (last N hours):
 *   - avg volatility across closes
 *   - avg fee/TVL ratio
 *   - win rate
 *   - avg PnL per close
 *
 * @returns {{score: number, classification: string, signals: object}}
 */
export function computeRegimeScore(perfHistory, hoursWindow = 24) {
  const cutoff = Date.now() - hoursWindow * 3600 * 1000;
  const recent = (perfHistory || []).filter((p) => {
    if (!p.recorded_at) return false;
    return new Date(p.recorded_at).getTime() > cutoff;
  });

  if (recent.length === 0) {
    return { score: 50, classification: "UNKNOWN", signals: { sample_size: 0 } };
  }

  // Signal 1: avg volatility (higher = more action)
  const vols = recent.map((p) => p.volatility).filter((v) => typeof v === "number" && isFinite(v) && v > 0);
  const avgVol = vols.length ? vols.reduce((s, v) => s + v, 0) / vols.length : 0;

  // Signal 2: avg fee/TVL ratio (higher = more swap activity)
  const feeTvls = recent.map((p) => p.fee_tvl_ratio).filter((v) => typeof v === "number" && isFinite(v) && v > 0);
  const avgFeeTvl = feeTvls.length ? feeTvls.reduce((s, v) => s + v, 0) / feeTvls.length : 0;

  // Signal 3: win rate
  const wins = recent.filter((p) => (p.pnl_usd || 0) > 0);
  const winRate = recent.length > 0 ? wins.length / recent.length : 0;

  // Signal 4: avg PnL per close
  const totalPnl = recent.reduce((s, p) => s + (p.pnl_usd || 0), 0);
  const avgPnl = totalPnl / recent.length;

  // Scoring: each signal 0-25, sum 0-100
  // Volatility (sweet spot 1.5-3): 0 if <1, 25 if in range, 0 if >5
  let volScore = 0;
  if (avgVol >= 1.5 && avgVol <= 3.5) volScore = 25;
  else if (avgVol >= 1.0 && avgVol < 1.5) volScore = (avgVol - 1.0) / 0.5 * 25;
  else if (avgVol > 3.5 && avgVol <= 5.0) volScore = (5.0 - avgVol) / 1.5 * 25;

  // Fee/TVL (sweet spot >0.3): 0 if <0.1, 25 if >0.4
  let feeScore = 0;
  if (avgFeeTvl >= 0.40) feeScore = 25;
  else if (avgFeeTvl >= 0.10) feeScore = (avgFeeTvl - 0.10) / 0.30 * 25;

  // Win rate (sweet spot 65%+): 25 at 70%, 0 at 50% or below
  let winScore = 0;
  if (winRate >= 0.70) winScore = 25;
  else if (winRate >= 0.50) winScore = (winRate - 0.50) / 0.20 * 25;

  // Avg PnL (sweet spot >$0.30): 25 if positive avg >$0.50, 0 if avg negative
  let pnlScore = 0;
  if (avgPnl >= 0.50) pnlScore = 25;
  else if (avgPnl >= 0) pnlScore = (avgPnl / 0.50) * 25;

  const score = Math.round(volScore + feeScore + winScore + pnlScore);
  const classification =
    score >= 70 ? "HOT" :
    score >= 40 ? "WARM" :
                  "COLD";

  return {
    score,
    classification,
    signals: {
      sample_size: recent.length,
      avg_volatility:    Number(avgVol.toFixed(2)),
      avg_fee_tvl_ratio: Number(avgFeeTvl.toFixed(3)),
      win_rate_pct:      Number((winRate * 100).toFixed(1)),
      avg_pnl_usd:       Number(avgPnl.toFixed(2)),
      vol_score:  Math.round(volScore),
      fee_score:  Math.round(feeScore),
      win_score:  Math.round(winScore),
      pnl_score:  Math.round(pnlScore),
    },
  };
}

/**
 * Run regime check + auto-toggle deployPaused if config.marketRegime.autoToggle=true.
 * Persists changes to user-config.json + logs to decision-log.
 */
export async function runRegimeCheck() {
  const mr = config.marketRegime;
  if (!mr?.enabled) return { ok: false, skipped: "marketRegime.enabled=false" };

  let perfData;
  try {
    const lessons = JSON.parse(fs.readFileSync(LESSONS_PATH, "utf8"));
    perfData = lessons.performance || [];
  } catch (e) {
    log("market_regime_warn", `Failed to load lessons.json: ${e.message}`);
    return { ok: false, error: e.message };
  }

  const result = computeRegimeScore(perfData, mr.windowHours ?? 24);
  log("market_regime", `Regime: ${result.classification} (score ${result.score}/100) | signals=${JSON.stringify(result.signals)}`);

  if (!mr.autoToggle) {
    return { ok: true, regime: result, action: "report_only (autoToggle=false)" };
  }

  const currentlyPaused = config.screening.deployPaused === true;
  const shouldPause = result.score < (mr.coldThreshold ?? 40);
  const shouldResume = result.score >= (mr.hotThreshold ?? 60);

  let action = "no_change";
  let newState = currentlyPaused;

  if (shouldPause && !currentlyPaused) {
    newState = true;
    action = "auto_pause";
  } else if (shouldResume && currentlyPaused) {
    newState = false;
    action = "auto_resume";
  }

  if (action !== "no_change") {
    // Persist to user-config + live config
    try {
      const uc = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
      uc.deployPaused = newState;
      uc._lastRegimeToggle = { at: new Date().toISOString(), regime: result.classification, score: result.score, action };
      fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(uc, null, 2) + "\n");
      config.screening.deployPaused = newState;

      appendDecision({
        type: "regime_toggle",
        actor: "MARKET_REGIME",
        summary: `${action}: market ${result.classification} (score ${result.score}/100) — deployPaused now ${newState}`,
        reason: `Auto-toggle based on market regime detection. Signals: vol=${result.signals.avg_volatility}, fee/TVL=${result.signals.avg_fee_tvl_ratio}, win=${result.signals.win_rate_pct}%, avg PnL=$${result.signals.avg_pnl_usd}`,
        full_report: `MARKET REGIME REPORT\n\nClassification: ${result.classification}\nScore: ${result.score}/100\nWindow: last ${mr.windowHours ?? 24} hours\nSample: ${result.signals.sample_size} closes\n\nSIGNALS:\n  Avg volatility:     ${result.signals.avg_volatility} (sub-score ${result.signals.vol_score}/25)\n  Avg fee/TVL ratio:  ${result.signals.avg_fee_tvl_ratio} (sub-score ${result.signals.fee_score}/25)\n  Win rate:           ${result.signals.win_rate_pct}% (sub-score ${result.signals.win_score}/25)\n  Avg PnL per close:  $${result.signals.avg_pnl_usd} (sub-score ${result.signals.pnl_score}/25)\n\nACTION: ${action}\nNew deployPaused: ${newState}\n\nThresholds: cold<${mr.coldThreshold ?? 40}, hot>=${mr.hotThreshold ?? 60}`,
        metrics: { regime: result.classification, score: result.score, ...result.signals },
      });

      log("market_regime", `🔄 ${action}: deployPaused → ${newState} (regime ${result.classification}, score ${result.score})`);
    } catch (e) {
      log("market_regime_error", `Failed to persist toggle: ${e.message}`);
      return { ok: false, error: e.message, regime: result };
    }
  }

  return { ok: true, regime: result, action, newState };
}
