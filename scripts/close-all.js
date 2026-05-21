#!/usr/bin/env node
/**
 * BlackDelta — Close All Positions (standalone emergency exit script)
 *
 * Sequentially close every open DLMM position in this wallet, with a YES
 * confirmation prompt and a PnL preview before execution. Uses the executor
 * wrapper (NOT closePosition directly) so it inherits:
 *   - auto-swap base token → SOL after close (executor.js:753-769)
 *   - Telegram 🔒 Closed notification per position (executor.js:743)
 *   - WS unsubscribe (executor.js:746)
 *   - logs/actions-*.jsonl audit entry
 *   - state.json + lessons.json updates
 *
 * Usage:
 *   node scripts/close-all.js                  # preview + YES prompt + execute
 *   node scripts/close-all.js --yes            # skip confirmation (automation)
 *   node scripts/close-all.js --dry-run        # set DRY_RUN=true, no on-chain tx
 *   node scripts/close-all.js --skip-swap      # leave base tokens un-swapped
 *   node scripts/close-all.js --help
 *
 * Exit codes:
 *   0 = all closed OR no open positions
 *   1 = partial failure (some closed, some failed)
 *   2 = user aborted (typed anything except YES)
 *   3 = fatal error (wallet not configured, fetch failed, etc)
 */

// ─── DRY_RUN must be set BEFORE any tool imports ──────────────────
if (process.argv.includes("--dry-run")) process.env.DRY_RUN = "true";

import { loadEnv } from "../envcrypt.js";
import { parseArgs } from "util";
import os from "os";
import fs from "fs";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";

// ─── Bootstrap: load .env (mirror cli.js:16-28) ────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const blackdeltaDir = path.join(os.homedir(), ".blackdelta");
const meridianDir = path.join(os.homedir(), ".meridian");
const targetDir = fs.existsSync(blackdeltaDir) ? blackdeltaDir
                : fs.existsSync(meridianDir) ? meridianDir
                : repoRoot;

const envFile = path.join(targetDir, ".env");
if (fs.existsSync(envFile)) {
  loadEnv({
    envPath: envFile,
    keyPath: path.join(targetDir, ".envrypt"),
    override: false,
  });
}

// ─── Parse CLI flags ──────────────────────────────────────────────
let parsed;
try {
  parsed = parseArgs({
    options: {
      yes:         { type: "boolean", default: false },
      "dry-run":   { type: "boolean", default: false },
      "skip-swap": { type: "boolean", default: false },
      help:        { type: "boolean", default: false },
    },
    strict: false,
    allowPositionals: true,
  });
} catch (e) {
  console.error(`Argument error: ${e.message}`);
  process.exit(3);
}
const flags = parsed.values;

if (flags.help) {
  console.log(`BlackDelta close-all — emergency exit

Usage:
  node scripts/close-all.js [--yes] [--dry-run] [--skip-swap]

Flags:
  --yes          Skip confirmation prompt (for automation)
  --dry-run      Set DRY_RUN=true; no on-chain transactions
  --skip-swap    Do NOT auto-swap base token back to SOL after close
  --help         Show this help

Exit codes: 0 ok | 1 partial | 2 aborted | 3 fatal
`);
  process.exit(0);
}

// ─── Tool imports (AFTER env + DRY_RUN set) ───────────────────────
const { getMyPositions } = await import("../tools/dlmm.js");
const { executeTool }    = await import("../tools/executor.js");

// ─── Helpers ──────────────────────────────────────────────────────
function fmtUsd(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return "  —   ";
  const sign = n > 0 ? "+" : n < 0 ? "-" : " ";
  return `${sign}$${Math.abs(n).toFixed(2).padStart(5)}`;
}
function fmtPct(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : n < 0 ? "" : "";
  return `${sign}${n.toFixed(2)}%`;
}
function fmtAge(min) {
  if (!Number.isFinite(min)) return "—";
  if (min < 60) return `${Math.round(min)}m`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return `${h}h ${m}m`;
}
function maskWallet(w) {
  if (!w || w.length < 12) return w || "—";
  return `${w.slice(0, 4)}…${w.slice(-4)}`;
}

function printPreview(positions, walletAddr, mode, autoSwapOn) {
  console.log("");
  console.log("BlackDelta close-all");
  console.log(`Mode:   ${mode}`);
  console.log(`Wallet: ${maskWallet(walletAddr)}`);
  console.log(`Auto-swap base→SOL: ${autoSwapOn ? "ON" : "OFF (--skip-swap)"}`);
  console.log("");
  console.log(`Open positions: ${positions.length}`);
  console.log("");
  console.log("  #  pair                     status   age        fees      pnl         pnl%");
  console.log("  ─  ───────────────────────  ──────  ─────────  ────────  ──────────  ───────");
  let totalFees = 0;
  let totalPnl = 0;
  positions.forEach((p, i) => {
    const pair = (p.pair || p.pool?.slice(0, 8) || "?").padEnd(23).slice(0, 23);
    const status = p.in_range ? "IN " : "OOR";
    const age = fmtAge(p.age_minutes).padStart(9);
    const fees = fmtUsd(p.unclaimed_fees_usd).padStart(8);
    const pnl = fmtUsd(p.pnl_usd).padStart(10);
    const pct = fmtPct(p.pnl_pct).padStart(7);
    console.log(`  ${String(i + 1).padStart(2)} ${pair}    ${status}   ${age}   ${fees}  ${pnl}  ${pct}`);
    if (Number.isFinite(p.unclaimed_fees_usd)) totalFees += p.unclaimed_fees_usd;
    if (Number.isFinite(p.pnl_usd)) totalPnl += p.pnl_usd;
  });
  console.log("");
  console.log(`Total unclaimed fees: ${fmtUsd(totalFees).trim()}`);
  console.log(`Total est. PnL:       ${fmtUsd(totalPnl).trim()}`);
  console.log("");
}

function askYes(promptText) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(promptText, (answer) => {
      rl.close();
      resolve(answer === "YES"); // strict — must be uppercase exact match
    });
  });
}

// ─── Main ──────────────────────────────────────────────────────────
async function main() {
  const mode = process.env.DRY_RUN === "true" ? "DRY_RUN" : "LIVE";
  const autoSwapOn = !flags["skip-swap"];

  // Warn if PM2 management cron might race us (best-effort string check)
  if (mode === "LIVE") {
    console.warn("⚠  LIVE mode. If PM2 bot is running, consider `pm2 stop blackdelta` to avoid race with management cron.");
  }

  let portfolio;
  try {
    portfolio = await getMyPositions({ force: true, silent: false });
  } catch (e) {
    console.error(`Fatal: failed to fetch positions: ${e.message}`);
    process.exit(3);
  }

  if (portfolio.error) {
    console.error(`Fatal: ${portfolio.error}`);
    process.exit(3);
  }

  const positions = portfolio.positions || [];
  if (positions.length === 0) {
    console.log("");
    console.log("No open positions. Nothing to close.");
    process.exit(0);
  }

  printPreview(positions, portfolio.wallet, mode, autoSwapOn);

  // Confirmation
  if (!flags.yes) {
    const ok = await askYes(`Type YES (uppercase) to close all ${positions.length} position(s), anything else to abort:\n> `);
    if (!ok) {
      console.log("Aborted.");
      process.exit(2);
    }
  } else {
    console.log("(--yes flag set, skipping confirmation)");
  }

  // Sequential close loop (mirror index.js:1592-1599 but via executeTool for full hooks)
  console.log("");
  const results = [];
  let successCount = 0;
  let failCount = 0;
  let realizedPnl = 0;
  for (let i = 0; i < positions.length; i++) {
    const pos = positions[i];
    const label = `${i + 1}/${positions.length} ${pos.pair || pos.position.slice(0, 8)}`;
    process.stdout.write(`Closing ${label}... `);
    try {
      const result = await executeTool("close_position", {
        position_address: pos.position,
        skip_swap: !autoSwapOn,
        reason: "manual close-all script",
      });
      if (result?.success === false || result?.error || result?.blocked) {
        failCount++;
        const reason = result?.reason || result?.error || "unknown";
        console.log(`✗ failed: ${reason}`);
        results.push({ pair: pos.pair, ok: false, error: reason });
      } else {
        successCount++;
        const pnl = Number.isFinite(result?.pnl_usd) ? result.pnl_usd : 0;
        realizedPnl += pnl;
        const tx = result?.txs?.[0] || result?.close_txs?.[0] || "—";
        const txShort = tx === "—" ? tx : `${tx.slice(0, 8)}…`;
        const swapNote = result?.auto_swapped ? " (auto-swapped)" : "";
        console.log(`✓ closed (pnl ${fmtUsd(pnl).trim()}, tx ${txShort})${swapNote}`);
        results.push({ pair: pos.pair, ok: true, pnl, tx });
      }
    } catch (e) {
      failCount++;
      console.log(`✗ exception: ${e.message}`);
      results.push({ pair: pos.pair, ok: false, error: e.message });
    }
  }

  // Summary
  console.log("");
  console.log("─── Summary ───");
  console.log(`Closed:    ${successCount}/${positions.length}`);
  console.log(`Failed:    ${failCount}`);
  console.log(`PnL total: ${fmtUsd(realizedPnl).trim()}`);
  if (failCount > 0) {
    console.log("");
    console.log("Failed positions:");
    results.filter(r => !r.ok).forEach(r => {
      console.log(`  - ${r.pair}: ${r.error}`);
    });
  }
  console.log("");

  if (failCount === 0) process.exit(0);
  if (successCount === 0) process.exit(3);
  process.exit(1);
}

main().catch((e) => {
  console.error("");
  console.error(`Fatal uncaught error: ${e.stack || e.message}`);
  process.exit(3);
});
