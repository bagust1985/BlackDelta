#!/usr/bin/env node
/**
 * BlackDelta — Backfill closed positions to lessons.json + pool-memory.json
 *
 * Saat lo close manual lewat web Meteora UI atau Jupiter (bukan via bd-close
 * script), bot detect posisi hilang on-chain dan mark state.json sebagai
 * "Auto-closed during state sync" — TANPA PnL data. Akibatnya:
 *   - lessons.json: trade ga ke-record (bias stats bot)
 *   - pool-memory.json: recordPoolDeploy() ga ke-trigger (no veto active)
 *
 * Script ini reconstruct data dari Meteora datapi (sumber autoritative on-chain
 * P&L) dan backfill ke kedua file. Setelah ini, recentLossVetoPct work properly.
 *
 * Usage:
 *   node scripts/backfill-closed.js                 # auto-detect Auto-closed entries
 *   node scripts/backfill-closed.js --dry-run       # preview only, no writes
 *   node scripts/backfill-closed.js --since=24h     # only entries closed in last 24h (default)
 *   node scripts/backfill-closed.js --since=7d      # last 7 days
 *   node scripts/backfill-closed.js --position=ADDR # specific position address
 *   node scripts/backfill-closed.js --yes           # skip confirmation prompt
 *
 * Exit codes:
 *   0 = success (backfilled or nothing to do)
 *   1 = partial failure (some failed)
 *   2 = user aborted
 *   3 = fatal error
 */

if (process.argv.includes("--dry-run")) process.env.DRY_RUN = "true";

import { loadEnv } from "../envcrypt.js";
import { parseArgs } from "util";
import os from "os";
import fs from "fs";
import path from "path";
import readline from "readline";
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
      yes:        { type: "boolean", default: false },
      "dry-run":  { type: "boolean", default: false },
      since:      { type: "string",  default: "24h" },
      position:   { type: "string" },
      help:       { type: "boolean", default: false },
    },
    strict: false,
    allowPositionals: true,
  }).values;
} catch (e) {
  console.error(`Argument error: ${e.message}`);
  process.exit(3);
}

if (flags.help) {
  console.log(`BlackDelta backfill-closed — reconstruct manual-close data

Usage:
  node scripts/backfill-closed.js [--since=24h] [--position=ADDR] [--yes] [--dry-run]

Flags:
  --since=DUR     Lookback window: e.g. 24h, 7d, 30d (default: 24h)
  --position=ADDR Backfill specific position address only
  --yes           Skip confirmation prompt
  --dry-run       Preview only, no writes to lessons/pool-memory
  --help          Show this help

Exit codes: 0 ok | 1 partial | 2 aborted | 3 fatal
`);
  process.exit(0);
}

// ─── Helpers ──────────────────────────────────────────────────────
function parseDuration(s) {
  const m = String(s).trim().match(/^(\d+)\s*([hdmw])$/i);
  if (!m) return 24 * 3600 * 1000;
  const n = parseInt(m[1]);
  const unit = m[2].toLowerCase();
  if (unit === "h") return n * 3600 * 1000;
  if (unit === "d") return n * 24 * 3600 * 1000;
  if (unit === "w") return n * 7 * 24 * 3600 * 1000;
  if (unit === "m") return n * 60 * 1000;
  return 24 * 3600 * 1000;
}

function fmtUsd(n) {
  if (!Number.isFinite(n)) return "  —  ";
  const sign = n > 0 ? "+" : n < 0 ? "-" : " ";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function askYes(promptText) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(promptText, (answer) => {
      rl.close();
      resolve(answer === "YES");
    });
  });
}

// ─── Tool imports (AFTER env set) ─────────────────────────────────
const { config } = await import("../config.js");
const lessons = await import("../lessons.js");
const poolMemory = await import("../pool-memory.js");

const WALLET = process.env.WALLET_ADDRESS || null;

// Resolve wallet address from key if not in env
async function getWalletAddress() {
  if (WALLET) return WALLET;
  try {
    const { Keypair } = await import("@solana/web3.js");
    const bs58 = (await import("bs58")).default;
    if (!process.env.WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY not set");
    return Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY)).publicKey.toString();
  } catch (e) {
    throw new Error(`Cannot resolve wallet address: ${e.message}`);
  }
}

// ─── Meteora datapi query ─────────────────────────────────────────
async function fetchClosedFromMeteora(poolAddress, wallet) {
  const url = `https://dlmm.datapi.meteora.ag/positions/${poolAddress}/pnl?user=${wallet}&status=closed&pageSize=50&page=1`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return data?.positions || data?.data || [];
  } catch {
    return [];
  }
}

// Find pool address for a position by searching pool-memory.json by name match
function poolCandidatesByName(poolName) {
  const pmPath = path.join(repoRoot, "pool-memory.json");
  if (!fs.existsSync(pmPath)) return [];
  try {
    const pm = JSON.parse(fs.readFileSync(pmPath, "utf8"));
    const wantedKey = String(poolName || "").toUpperCase();
    return Object.entries(pm)
      .filter(([_, entry]) => String(entry?.name || "").toUpperCase() === wantedKey)
      .map(([poolAddr, entry]) => ({ poolAddr, base_mint: entry.base_mint }));
  } catch {
    return [];
  }
}

// ─── Find Auto-closed entries from state.json ────────────────────
function findAutoClosed(sinceMs, specificPosition = null) {
  const statePath = path.join(repoRoot, "state.json");
  if (!fs.existsSync(statePath)) return [];
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const positions = Object.values(state.positions || {});
  const cutoff = Date.now() - sinceMs;

  return positions.filter((p) => {
    if (!p.closed) return false;
    if (!p.closed_at) return false;
    if (new Date(p.closed_at).getTime() < cutoff) return false;
    if (specificPosition && p.position !== specificPosition) return false;
    const lastNote = (p.notes && p.notes[p.notes.length - 1]) || "";
    return /Auto-closed during state sync/i.test(lastNote);
  });
}

// Check if already backfilled (avoid double-count in lessons)
function isAlreadyInLessons(positionAddr) {
  const lessonsPath = path.join(repoRoot, "lessons.json");
  if (!fs.existsSync(lessonsPath)) return false;
  try {
    const data = JSON.parse(fs.readFileSync(lessonsPath, "utf8"));
    return (data.performance || []).some((p) => p.position === positionAddr);
  } catch {
    return false;
  }
}

// ─── Main ──────────────────────────────────────────────────────────
async function main() {
  const sinceMs = parseDuration(flags.since);
  console.log("");
  console.log("BlackDelta backfill-closed");
  console.log(`Mode:    ${process.env.DRY_RUN === "true" ? "DRY_RUN (no writes)" : "LIVE (will modify lessons.json + pool-memory.json)"}`);
  console.log(`Window:  last ${flags.since} (${Math.round(sinceMs / 3600000)}h)`);

  const wallet = await getWalletAddress();
  console.log(`Wallet:  ${wallet.slice(0, 4)}…${wallet.slice(-4)}`);
  console.log("");

  const candidates = findAutoClosed(sinceMs, flags.position);
  if (candidates.length === 0) {
    console.log("No 'Auto-closed during state sync' entries found in window. Nothing to backfill.");
    process.exit(0);
  }

  console.log(`Found ${candidates.length} manually-closed position(s) to backfill:`);
  console.log("");

  // Resolve each candidate to its pool address + fetch Meteora data
  const resolved = [];
  for (const c of candidates) {
    const already = isAlreadyInLessons(c.position);
    process.stdout.write(`  ${c.pool_name?.padEnd(20) || "?".padEnd(20)} ${c.position.slice(0, 8)}…  `);

    if (already) {
      console.log("⏭  already in lessons.json — skipping");
      continue;
    }

    const pools = poolCandidatesByName(c.pool_name);
    if (pools.length === 0) {
      console.log("✗  pool address not in pool-memory.json — cannot resolve");
      continue;
    }

    let found = null;
    let foundPool = null;
    for (const p of pools) {
      const items = await fetchClosedFromMeteora(p.poolAddr, wallet);
      const match = items.find((x) => x.positionAddress === c.position);
      if (match) {
        found = match;
        foundPool = p;
        break;
      }
    }

    if (!found) {
      console.log("✗  not found in Meteora datapi");
      continue;
    }

    const pnlUsd = parseFloat(found.pnlUsd || 0);
    const pnlPct = parseFloat(found.pnlPctChange || 0);
    const feesUsd = parseFloat(found.allTimeFees?.total?.usd || 0);
    const initialUsd = parseFloat(found.allTimeDeposits?.total?.usd || 0);
    const withdrawUsd = parseFloat(found.allTimeWithdrawals?.total?.usd || 0);
    const finalValueUsd = withdrawUsd; // withdrawals already include principal back
    const minutesHeld = found.createdAt && found.closedAt
      ? Math.round((found.closedAt - found.createdAt) / 60)
      : null;

    console.log(`✓  pnl ${fmtUsd(pnlUsd)} (${pnlPct.toFixed(2)}%) fees ${fmtUsd(feesUsd)}`);

    resolved.push({
      candidate: c,
      meteora: found,
      pool: foundPool,
      computed: { pnlUsd, pnlPct, feesUsd, initialUsd, finalValueUsd, minutesHeld },
    });
  }

  if (resolved.length === 0) {
    console.log("");
    console.log("No resolvable entries. Nothing to write.");
    process.exit(0);
  }

  // Summary
  const totalPnl = resolved.reduce((s, r) => s + r.computed.pnlUsd, 0);
  console.log("");
  console.log(`Total backfill: ${resolved.length} positions, PnL sum ${fmtUsd(totalPnl)}`);
  console.log("");

  if (process.env.DRY_RUN === "true") {
    console.log("DRY_RUN mode — no writes performed. Re-run without --dry-run to apply.");
    process.exit(0);
  }

  // Confirm
  if (!flags.yes) {
    const ok = await askYes(`Type YES to backfill ${resolved.length} entries into lessons.json + pool-memory.json:\n> `);
    if (!ok) {
      console.log("Aborted.");
      process.exit(2);
    }
  }

  // Apply
  console.log("");
  let saved = 0;
  let failed = 0;
  for (const r of resolved) {
    const { candidate: c, pool: p, computed: x, meteora: m } = r;
    try {
      // 1. lessons.recordPerformance() — reconstruct perf payload matching closePosition()'s shape
      await lessons.recordPerformance({
        position: c.position,
        pool: p.poolAddr,
        pool_name: c.pool_name,
        base_mint: p.base_mint,
        strategy: c.strategy || "spot",
        bin_range: c.bin_range,
        bin_step: c.bin_step,
        volatility: c.volatility,
        fee_tvl_ratio: c.fee_tvl_ratio,
        organic_score: c.organic_score,
        amount_sol: c.amount_sol,
        fees_earned_usd: x.feesUsd,
        final_value_usd: x.finalValueUsd,
        initial_value_usd: x.initialUsd,
        minutes_in_range: x.minutesHeld || 0,  // approx — we don't have OOR breakdown
        minutes_held: x.minutesHeld || 0,
        close_reason: "manual close (backfilled from Meteora datapi)",
      });

      // 2. pool-memory.recordPoolDeploy() — this triggers veto if loss > threshold
      poolMemory.recordPoolDeploy(p.poolAddr, {
        deployed_at: c.deployed_at,
        closed_at: c.closed_at,
        pnl_pct: x.pnlPct,
        pnl_usd: x.pnlUsd,
        fees_earned_usd: x.feesUsd,
        minutes_held: x.minutesHeld,
        close_reason: "manual close (backfilled)",
        strategy: c.strategy || "spot",
        volatility: c.volatility,
        base_mint: p.base_mint,
      });

      console.log(`  ✓ ${c.pool_name.padEnd(20)} ${fmtUsd(x.pnlUsd)} — saved`);
      saved++;
    } catch (e) {
      console.log(`  ✗ ${c.pool_name.padEnd(20)} — error: ${e.message}`);
      failed++;
    }
  }

  // Final summary
  console.log("");
  console.log("─── Summary ───");
  console.log(`Saved:  ${saved}/${resolved.length}`);
  console.log(`Failed: ${failed}`);
  console.log(`PnL total backfilled: ${fmtUsd(totalPnl)}`);
  console.log("");

  if (failed > 0 && saved === 0) process.exit(3);
  if (failed > 0) process.exit(1);
  process.exit(0);
}

main().catch((e) => {
  console.error("");
  console.error(`Fatal: ${e.stack || e.message}`);
  process.exit(3);
});
