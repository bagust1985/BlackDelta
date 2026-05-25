#!/usr/bin/env node
/**
 * BlackDelta — Anti-ATH-Trap Filter Analyzer
 *
 * 2 mode:
 *
 * 1. LIVE mode (default):
 *    Fetch current top candidates → apply anti-ATH filter → show per-pool verdict
 *    Useful: "what would bot deploy RIGHT NOW kalau deployPaused=false?"
 *
 * 2. HISTORICAL mode (--history):
 *    Loop last N closed positions from pool-memory.json → fetch current
 *    DexScreener data → retroactively apply filter → compare with actual PnL
 *    Limitation: pakai current price metrics (bukan saat-deploy), so this is
 *    PATTERN match, bukan exact backtest. Tetap useful buat tune filter.
 *
 * Usage:
 *   node scripts/analyze-ath-filter.js                 # live mode
 *   node scripts/analyze-ath-filter.js --history       # historical mode
 *   node scripts/analyze-ath-filter.js --history --limit=50
 *   node scripts/analyze-ath-filter.js --history --losers-only
 *   node scripts/analyze-ath-filter.js --help
 *
 * Exit: 0 = ok, 3 = error
 */

import { loadEnv } from "../envcrypt.js";
import { parseArgs } from "util";
import os from "os";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ─── Bootstrap (mirror cli.js + close-all.js) ──────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const blackdeltaDir = path.join(os.homedir(), ".blackdelta");
const meridianDir = path.join(os.homedir(), ".meridian");
const targetDir = fs.existsSync(blackdeltaDir) ? blackdeltaDir
                : fs.existsSync(meridianDir) ? meridianDir
                : repoRoot;
const envFile = path.join(targetDir, ".env");
if (fs.existsSync(envFile)) {
  loadEnv({ envPath: envFile, keyPath: path.join(targetDir, ".envrypt"), override: false });
}

// ─── CLI flags ────────────────────────────────────────────────────
let flags;
try {
  flags = parseArgs({
    options: {
      history:      { type: "boolean", default: false },
      limit:        { type: "string",  default: "50" },
      "losers-only": { type: "boolean", default: false },
      help:         { type: "boolean", default: false },
    },
    strict: false,
    allowPositionals: true,
  }).values;
} catch (e) {
  console.error(`Argument error: ${e.message}`);
  process.exit(3);
}

if (flags.help) {
  console.log(`BlackDelta analyze-ath-filter

Usage:
  node scripts/analyze-ath-filter.js                # live: cek candidate NOW
  node scripts/analyze-ath-filter.js --history      # cek last N closed deploys
  node scripts/analyze-ath-filter.js --history --limit=100
  node scripts/analyze-ath-filter.js --history --losers-only

Flags:
  --history       Historical mode — analyze past closes vs filter
  --limit=N       Limit N entries in history mode (default 50)
  --losers-only   Only show closes with pnl <= 0
`);
  process.exit(0);
}

// ─── Imports ──────────────────────────────────────────────────────
const { config } = await import("../config.js");
const { checkDexScreener } = await import("../tools/multi-layer-screening.js");

// ─── Helpers ──────────────────────────────────────────────────────
function fmtPct(n, decimals = 2) {
  if (n == null || !Number.isFinite(n)) return "  —  ";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(decimals)}%`;
}
function fmtUsd(n, decimals = 2) {
  if (n == null || !Number.isFinite(n)) return "  —  ";
  const sign = n > 0 ? "+" : "-";
  return `${sign}$${Math.abs(n).toFixed(decimals)}`;
}
function color(text, c) {
  const codes = { red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, gray: 90 };
  return process.stdout.isTTY ? `\x1b[${codes[c] || 0}m${text}\x1b[0m` : text;
}

// ─── LIVE MODE ─────────────────────────────────────────────────────
async function runLive() {
  console.log("");
  console.log("BlackDelta — Anti-ATH Filter Analyzer (LIVE)");
  console.log("");
  console.log("Fetching current top candidates from Meteora...");

  const { getTopCandidates } = await import("../tools/screening.js");
  const result = await getTopCandidates({ limit: 10 }).catch((e) => {
    console.error("Error fetching candidates:", e.message);
    process.exit(3);
  });

  const candidates = (result?.candidates || result?.pools || []).slice(0, 10);
  if (candidates.length === 0) {
    console.log("No top candidates available right now. Try again later.");
    process.exit(0);
  }

  console.log(`Found ${candidates.length} candidate(s). Applying anti-ATH filter...`);
  console.log("");

  const athCfg = config.screening.antiAthTrap;
  console.log(color("Filter thresholds:", "cyan"));
  console.log(`  athFilterPct: ${config.screening.athFilterPct} (price must be <= ${100 + (config.screening.athFilterPct ?? -25)}% of ATH)`);
  console.log(`  anti-ATH-trap enabled: ${athCfg?.enabled}`);
  if (athCfg?.enabled) {
    console.log(`    max h1 pump: ${athCfg.maxPriceChangeH1Pct}%`);
    console.log(`    max h6 pump: ${athCfg.maxPriceChangeH6Pct}%`);
    console.log(`    max m5 pump: ${athCfg.maxPriceChangeM5Pct}%`);
    console.log(`    max h1/h24 vol ratio: ${(athCfg.maxVolumeH1RatioH24 * 100).toFixed(0)}%`);
  }
  console.log("");

  let passing = 0;
  let blocked = 0;
  for (let i = 0; i < candidates.length; i++) {
    const p = candidates[i];
    const mint = p.base?.mint;
    if (!mint) continue;
    const ageH = (p.token_age_hours || (p.token_x?.created_at ? (Date.now() - p.token_x.created_at) / 3_600_000 : 99999));
    const r = await checkDexScreener(mint, ageH, p.name, config.screening);

    const verdict = r.pass ? color("PASS", "green") : color("REJECT", "red");
    const reason = r.pass ? "" : color(" · " + r.reason.replace("DexScreener: ", ""), "yellow");
    console.log(`  ${String(i + 1).padStart(2)}. [${verdict}] ${(p.name || "?").padEnd(22)}${reason}`);

    if (r.data) {
      const mom = `m5 ${fmtPct(r.data.price_change_m5)}  h1 ${fmtPct(r.data.price_change_h1)}  h6 ${fmtPct(r.data.price_change_h6)}  h24 ${fmtPct(r.data.price_change_h24)}`;
      const vol = r.data.volume_h24 > 0 ? `vol h1/h24 ${(r.data.volume_h1/r.data.volume_h24*100).toFixed(1)}%` : "";
      console.log("      " + color(mom + "  " + vol, "gray"));
    }

    if (r.pass) passing++; else blocked++;
    await new Promise(rr => setTimeout(rr, 150)); // rate limit
  }

  console.log("");
  console.log("─── Summary ───");
  console.log(`Passing:  ${color(String(passing) + "/" + candidates.length, "green")}`);
  console.log(`Blocked:  ${color(String(blocked) + "/" + candidates.length, "red")}`);
  console.log(`Pass rate: ${(passing/candidates.length*100).toFixed(0)}%`);
  console.log("");
  console.log("Note: pass-rate live tergantung market regime. Saat market panas → banyak pump → banyak REJECT.");
}

// ─── HISTORICAL MODE ───────────────────────────────────────────────
async function runHistory() {
  console.log("");
  console.log("BlackDelta — Anti-ATH Filter Analyzer (HISTORICAL)");
  console.log("");

  const limit = parseInt(flags.limit) || 50;
  const losersOnly = flags["losers-only"];

  const pm = JSON.parse(fs.readFileSync(path.join(repoRoot, "pool-memory.json"), "utf8"));
  const allDeploys = [];
  Object.entries(pm).forEach(([pool, entry]) => {
    if (Array.isArray(entry.deploys)) {
      entry.deploys.forEach((d) => {
        if (d.pnl_pct == null || !d.closed_at) return;
        allDeploys.push({ pool, name: entry.name, base_mint: entry.base_mint, ...d });
      });
    }
  });
  allDeploys.sort((a, b) => new Date(b.closed_at) - new Date(a.closed_at));

  const subset = (losersOnly ? allDeploys.filter((d) => d.pnl_pct <= 0) : allDeploys).slice(0, limit);
  console.log(`Analyzing ${subset.length} historical deploys (${losersOnly ? "losers only" : "all"})...`);
  console.log("⚠️  Note: pakai CURRENT DexScreener data sebagai approximation. Bukan exact backtest.");
  console.log("");

  const buckets = {
    truePositive: [],  // filter REJECT + actual loss = saved money
    falsePositive: [], // filter REJECT + actual profit = missed opportunity
    falseNegative: [], // filter PASS + actual loss = filter missed bad trade
    trueNegative: [],  // filter PASS + actual profit = filter correct allow
    noData: [],        // can't fetch DexScreener data
  };

  for (let i = 0; i < subset.length; i++) {
    const d = subset[i];
    process.stdout.write(`\r  Processing ${i + 1}/${subset.length}...`);
    if (!d.base_mint) {
      buckets.noData.push({ ...d, reason: "no base_mint" });
      continue;
    }
    const r = await checkDexScreener(d.base_mint, 9999, d.name, config.screening);
    const actualLoss = (d.pnl_pct || 0) <= 0;

    if (r.skipped) {
      buckets.noData.push({ ...d, reason: r.skipped });
    } else if (!r.pass && actualLoss) {
      buckets.truePositive.push({ ...d, filterReason: r.reason });
    } else if (!r.pass && !actualLoss) {
      buckets.falsePositive.push({ ...d, filterReason: r.reason });
    } else if (r.pass && actualLoss) {
      buckets.falseNegative.push({ ...d });
    } else {
      buckets.trueNegative.push({ ...d });
    }
    await new Promise(rr => setTimeout(rr, 150));
  }

  console.log("\r" + " ".repeat(40) + "\r");

  // ── Report ──────────────────────────────────────────────────────
  const total = subset.length;
  const analyzable = total - buckets.noData.length;
  const tp = buckets.truePositive.length;
  const fp = buckets.falsePositive.length;
  const fn = buckets.falseNegative.length;
  const tn = buckets.trueNegative.length;

  console.log(color("=== Filter Accuracy ===", "cyan"));
  console.log(`Total analyzed:          ${analyzable}/${total} (${buckets.noData.length} no DexScreener data)`);
  console.log("");
  console.log("                     | Actual LOSS         | Actual PROFIT        | Total");
  console.log("─".repeat(85));
  console.log(`  Filter REJECT      | ${color(tp + " ✓ SAVED", "green").padEnd(28)} | ${color(fp + " ✗ MISSED", "red").padEnd(29)} | ${tp+fp}`);
  console.log(`  Filter PASS        | ${color(fn + " ✗ NOT CAUGHT", "yellow").padEnd(28)} | ${color(tn + " ✓ ALLOWED", "green").padEnd(29)} | ${fn+tn}`);
  console.log("");

  if (analyzable > 0) {
    const precision = tp + fp > 0 ? (tp / (tp + fp) * 100).toFixed(1) : "n/a";
    const recall = tp + fn > 0 ? (tp / (tp + fn) * 100).toFixed(1) : "n/a";
    console.log(`Precision (saving accuracy):    ${precision}%  (when filter rejects, ${precision}% of time it was a real loss)`);
    console.log(`Recall (loss catch rate):       ${recall}%  (filter catches ${recall}% of all losses)`);
  }

  // ── Estimated $ impact ──────────────────────────────────────────
  const savedUsd = buckets.truePositive.reduce((s, d) => s + Math.abs(d.pnl_usd || 0), 0);
  const missedUsd = buckets.falsePositive.reduce((s, d) => s + Math.abs(d.pnl_usd || 0), 0);
  const netImpact = savedUsd - missedUsd;
  console.log("");
  console.log(color("=== Estimated $ Impact (if filter was active) ===", "cyan"));
  console.log(`  Saved (true positives):   ${color(fmtUsd(savedUsd), "green")}  (loss avoided)`);
  console.log(`  Missed (false positives): ${color(fmtUsd(-missedUsd), "red")}    (opportunity cost)`);
  console.log(`  Net impact:               ${color(fmtUsd(netImpact), netImpact >= 0 ? "green" : "red")}  ${netImpact >= 0 ? "← filter helpful" : "← filter too aggressive"}`);

  // ── Top samples ─────────────────────────────────────────────────
  if (buckets.truePositive.length > 0) {
    console.log("");
    console.log(color("=== TOP 5 SAVES (REJECT + actual loss) ===", "green"));
    buckets.truePositive
      .sort((a, b) => (a.pnl_usd || 0) - (b.pnl_usd || 0))
      .slice(0, 5)
      .forEach((d) => {
        console.log(`  ${d.name?.padEnd(22)} ${fmtUsd(d.pnl_usd).padStart(8)} ${fmtPct(d.pnl_pct).padStart(7)}  →  blocked: ${d.filterReason?.slice(0, 60)}`);
      });
  }

  if (buckets.falsePositive.length > 0) {
    console.log("");
    console.log(color("=== TOP 5 MISSED OPPORTUNITY (REJECT + actual profit) ===", "yellow"));
    buckets.falsePositive
      .sort((a, b) => (b.pnl_usd || 0) - (a.pnl_usd || 0))
      .slice(0, 5)
      .forEach((d) => {
        console.log(`  ${d.name?.padEnd(22)} ${fmtUsd(d.pnl_usd).padStart(8)} ${fmtPct(d.pnl_pct).padStart(7)}  →  rejected: ${d.filterReason?.slice(0, 60)}`);
      });
  }

  if (buckets.falseNegative.length > 0) {
    console.log("");
    console.log(color("=== TOP 5 LOSSES FILTER MISSED ===", "red"));
    buckets.falseNegative
      .sort((a, b) => (a.pnl_usd || 0) - (b.pnl_usd || 0))
      .slice(0, 5)
      .forEach((d) => {
        console.log(`  ${d.name?.padEnd(22)} ${fmtUsd(d.pnl_usd).padStart(8)} ${fmtPct(d.pnl_pct).padStart(7)}  (filter let it through)`);
      });
  }

  console.log("");
  console.log(color("=== Interpretation ===", "cyan"));
  if (tp + fp + fn + tn === 0) {
    console.log("  No data for analysis.");
  } else {
    if (netImpact > 0) {
      console.log(`  ✅ Filter would have SAVED net ${fmtUsd(netImpact)} across ${analyzable} deploys.`);
      console.log(`     Worth enabling. Consider tightening more if precision > 70%.`);
    } else if (netImpact < 0) {
      console.log(`  ⚠️  Filter would have COST net ${fmtUsd(-netImpact)} (too aggressive).`);
      console.log(`     Consider loosening thresholds (mis. max h1 pump 30% → 50%).`);
    } else {
      console.log(`  ➡️  Filter break-even. No strong signal either way.`);
    }
    console.log("");
    console.log("  ⚠️  CAVEAT: Analysis pakai CURRENT DexScreener data sebagai approximation.");
    console.log("     Pump status pool sekarang ≠ pump status saat deploy lama. Treat as DIRECTIONAL signal.");
    console.log("     Best validation: run paper trading 24-48 jam, compare actual outcomes.");
  }
  console.log("");
}

// ─── Main ──────────────────────────────────────────────────────────
async function main() {
  if (flags.history) {
    await runHistory();
  } else {
    await runLive();
  }
}

main().catch((e) => {
  console.error("");
  console.error(`Fatal: ${e.stack || e.message}`);
  process.exit(3);
});
