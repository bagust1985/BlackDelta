#!/usr/bin/env node
/**
 * BlackDelta — Paper Trading Report
 *
 * Show paper PnL stats (positions that WOULD have been deployed in paused mode)
 * + A/B compare paper vs actual deploys.
 *
 * Usage:
 *   node scripts/paper-report.js              # summary + open paper positions
 *   node scripts/paper-report.js --ab         # A/B compare vs actual last 7d
 *   node scripts/paper-report.js --closed     # detail closed paper positions
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const PAPER_PATH = path.join(repoRoot, "paper-positions.json");
const LESSONS_PATH = path.join(repoRoot, "lessons.json");

const argv = process.argv.slice(2);
const mode = argv.includes("--ab") ? "ab"
           : argv.includes("--closed") ? "closed"
           : "summary";

function color(text, c) {
  const codes = { red: 31, green: 32, yellow: 33, cyan: 36, gray: 90 };
  return process.stdout.isTTY ? `\x1b[${codes[c] || 0}m${text}\x1b[0m` : text;
}

function fmt(n, d = 2) { return n == null || !Number.isFinite(n) ? "—" : n.toFixed(d); }
function fmtUsd(n) { return n == null || !Number.isFinite(n) ? "  —  " : `${n >= 0 ? "+" : "-"}$${Math.abs(n).toFixed(2)}`; }
function fmtPct(n) { return n == null || !Number.isFinite(n) ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`; }

function loadPaper() {
  if (!fs.existsSync(PAPER_PATH)) return { positions: [], closed: [] };
  return JSON.parse(fs.readFileSync(PAPER_PATH, "utf8"));
}
function loadLessons() {
  if (!fs.existsSync(LESSONS_PATH)) return { performance: [] };
  return JSON.parse(fs.readFileSync(LESSONS_PATH, "utf8"));
}

function showSummary() {
  const data = loadPaper();
  const open = data.positions || [];
  const closed = data.closed || [];
  const wins = closed.filter((p) => (p.estimated_pnl_usd || 0) > 0);
  const totalPnl = closed.reduce((s, p) => s + (p.estimated_pnl_usd || 0), 0);

  console.log("");
  console.log(color("BlackDelta — Paper Trading Report", "cyan"));
  console.log("");
  console.log(color("=== Summary ===", "cyan"));
  console.log(`Open paper positions:  ${open.length}`);
  console.log(`Closed paper positions: ${closed.length}`);
  if (closed.length > 0) {
    console.log(`Win rate:              ${((wins.length / closed.length) * 100).toFixed(1)}%`);
    console.log(`Total est PnL:         ${color(fmtUsd(totalPnl), totalPnl >= 0 ? "green" : "red")}`);
    console.log(`Avg PnL/trade:         ${color(fmtUsd(totalPnl / closed.length), "yellow")}`);
  } else {
    console.log(color("No closed paper trades yet. Bot need to run with deployPaused=true and LLM attempts deploy.", "gray"));
  }

  if (open.length > 0) {
    console.log("");
    console.log(color("=== Open Paper Positions ===", "cyan"));
    console.log("pool                  | age      | drift   | est pnl    | initial $");
    console.log("─".repeat(80));
    for (const p of open) {
      const ageMin = Math.round((Date.now() - new Date(p.deployed_at).getTime()) / 60000);
      const ageStr = ageMin < 60 ? `${ageMin}m` : `${(ageMin / 60).toFixed(1)}h`;
      console.log(
        (p.pool_name || p.pool?.slice(0, 12) || "?").padEnd(22),
        "|",
        ageStr.padStart(7),
        "|",
        (fmtPct(p.price_drift_pct) || "—").padStart(7),
        "|",
        color(fmtUsd(p.estimated_pnl_usd), (p.estimated_pnl_usd || 0) >= 0 ? "green" : "red").padStart(10),
        "|",
        p.initial_price_usd ? `$${p.initial_price_usd.toFixed(6)}` : "—"
      );
    }
  }

  console.log("");
  console.log(color("Use --closed for closed positions detail, --ab for A/B compare", "gray"));
  console.log("");
}

function showClosed() {
  const data = loadPaper();
  const closed = (data.closed || []).slice(-25).reverse();
  console.log("");
  console.log(color(`=== Last ${closed.length} Closed Paper Positions ===`, "cyan"));
  console.log("");
  if (closed.length === 0) {
    console.log(color("No closed paper trades yet.", "gray"));
    return;
  }
  console.log("closed_at        | pool                  | held    | drift   | est pnl");
  console.log("─".repeat(85));
  for (const p of closed) {
    console.log(
      (p.closed_at?.slice(5, 16).replace("T", " ") || "?").padEnd(16),
      "|",
      (p.pool_name || p.pool?.slice(0, 12) || "?").padEnd(22),
      "|",
      ((p.minutes_held || 0) + "m").padStart(7),
      "|",
      (fmtPct(p.price_drift_pct) || "—").padStart(7),
      "|",
      color(fmtUsd(p.estimated_pnl_usd), (p.estimated_pnl_usd || 0) >= 0 ? "green" : "red")
    );
  }
  console.log("");
}

function showAbCompare() {
  const paperData = loadPaper();
  const lessons = loadLessons();
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;

  const paperClosed = (paperData.closed || []).filter((p) =>
    p.closed_at && new Date(p.closed_at).getTime() > cutoff
  );
  const actualClosed = (lessons.performance || []).filter((p) =>
    p.recorded_at && new Date(p.recorded_at).getTime() > cutoff
  );

  console.log("");
  console.log(color("=== A/B Compare: Paper vs Actual (last 7 days) ===", "cyan"));
  console.log("");

  function statsOf(arr, pnlKey, pctKey) {
    if (arr.length === 0) return null;
    const wins = arr.filter((p) => (p[pnlKey] || 0) > 0);
    const totalPnl = arr.reduce((s, p) => s + (p[pnlKey] || 0), 0);
    const totalPct = arr.reduce((s, p) => s + (p[pctKey] || 0), 0);
    return {
      count: arr.length,
      win_rate: (wins.length / arr.length) * 100,
      total_pnl: totalPnl,
      avg_pnl: totalPnl / arr.length,
      avg_pnl_pct: totalPct / arr.length,
    };
  }

  const paper = statsOf(paperClosed, "estimated_pnl_usd", "estimated_pnl_pct");
  const actual = statsOf(actualClosed, "pnl_usd", "pnl_pct");

  console.log("                         |   PAPER (sim) |  ACTUAL (live)");
  console.log("─".repeat(60));
  if (paper && actual) {
    console.log(`Closes                   | ${String(paper.count).padStart(13)} | ${String(actual.count).padStart(13)}`);
    console.log(`Win rate                 | ${(paper.win_rate.toFixed(1) + "%").padStart(13)} | ${(actual.win_rate.toFixed(1) + "%").padStart(13)}`);
    console.log(`Total PnL                | ${fmtUsd(paper.total_pnl).padStart(13)} | ${fmtUsd(actual.total_pnl).padStart(13)}`);
    console.log(`Avg PnL/trade            | ${fmtUsd(paper.avg_pnl).padStart(13)} | ${fmtUsd(actual.avg_pnl).padStart(13)}`);
    console.log(`Avg PnL %                | ${(fmtPct(paper.avg_pnl_pct)).padStart(13)} | ${(fmtPct(actual.avg_pnl_pct)).padStart(13)}`);
    console.log("");
    console.log(color("=== Delta (paper − actual) ===", "cyan"));
    const winDelta = paper.win_rate - actual.win_rate;
    const pnlDelta = paper.avg_pnl - actual.avg_pnl;
    console.log(`Win rate diff:  ${color((winDelta >= 0 ? "+" : "") + winDelta.toFixed(1) + "%", winDelta >= 0 ? "green" : "red")}`);
    console.log(`Avg PnL diff:   ${color(fmtUsd(pnlDelta), pnlDelta >= 0 ? "green" : "red")}`);
    console.log("");
    console.log(color("Interpretation:", "cyan"));
    if (Math.abs(winDelta) < 5 && Math.abs(pnlDelta) < 0.2) {
      console.log(color("  ➡️  Paper closely tracks actual — paper sim is reasonably accurate.", "gray"));
    } else if (winDelta > 0 && pnlDelta > 0) {
      console.log(color("  ✅ Paper outperforms actual — kalau resume live, expect similar or BETTER outcomes (LLM pick quality good).", "green"));
    } else if (winDelta < 0 || pnlDelta < 0) {
      console.log(color("  ⚠️  Paper underperforms actual — paper estimation may be overly conservative OR live deploys did better due to bot tuning.", "yellow"));
    }
  } else {
    if (!paper) console.log(color("No paper closes in last 7 days.", "gray"));
    if (!actual) console.log(color("No actual closes in last 7 days.", "gray"));
    console.log("");
    console.log(color("Need both paper + actual data for compare. Enable deployPaused=true for paper, then resume to compare.", "gray"));
  }
  console.log("");
}

if (mode === "ab") showAbCompare();
else if (mode === "closed") showClosed();
else showSummary();
