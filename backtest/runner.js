#!/usr/bin/env node
/**
 * Backtest CLI runner.
 *
 * Usage:
 *   node backtest/runner.js --fixtures backtest/fixtures/golden-sample
 *   node backtest/runner.js --fixtures <dir> --trades <trades.json>
 *
 * Modes:
 *   - When --trades is provided, scores that file directly (golden path
 *     for CI hash assertion).
 *   - When only --fixtures is provided, runs the screener via replayer
 *     to derive trade intents (Phase 3 follow-up — for now logs a hint).
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { score } from "./scorer.js";
import { startReplay, stopReplay, remainingFixtureCount } from "./replayer.js";

function parseArgs(argv) {
  const args = { fixtures: null, trades: null, config: null, json: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--fixtures") { args.fixtures = next; i++; }
    else if (a === "--trades") { args.trades = next; i++; }
    else if (a === "--config") { args.config = next; i++; }
    else if (a === "--json") { args.json = true; }
    else if (a === "--help" || a === "-h") {
      console.log("Usage: node backtest/runner.js --fixtures <dir> [--trades <file>] [--config <file>] [--json]");
      process.exit(0);
    }
  }
  return args;
}

function configHash(filepath) {
  if (!filepath || !fs.existsSync(filepath)) return null;
  return crypto.createHash("sha256")
    .update(fs.readFileSync(filepath))
    .digest("hex")
    .slice(0, 12);
}

async function main() {
  const args = parseArgs(process.argv);

  if (!args.fixtures && !args.trades) {
    console.error("error: --fixtures or --trades required");
    process.exit(2);
  }

  let trades = [];
  if (args.trades) {
    if (!fs.existsSync(args.trades)) {
      console.error(`trades file not found: ${args.trades}`);
      process.exit(2);
    }
    const raw = fs.readFileSync(args.trades, "utf8");
    trades = JSON.parse(raw);
  } else if (args.fixtures) {
    // Phase 3 minimum: replayer is wired but driving the screener through
    // replay requires the cycle-extraction refactor in index.js (out of
    // current scope). For now: warm the fixture store and emit an empty
    // run so CI hash assertions still produce a deterministic Report.
    startReplay({ fixtures: args.fixtures, fixturesDir: args.fixtures });
    const fixtureCount = remainingFixtureCount();
    console.error(`[backtest] replayer warmed; ${fixtureCount} fixtures available`);
    if (fixtureCount === 0) {
      console.error(`[backtest] note: --fixtures alone produces an empty Report.`);
      console.error(`[backtest] add --trades <file> to score recorded trade intents.`);
    }
    stopReplay();
  }

  const report = score(trades, { configHash: configHash(args.config) });
  const reportHash = crypto.createHash("sha256")
    .update(JSON.stringify(report))
    .digest("hex")
    .slice(0, 12);
  const finalReport = { ...report, reportHash };

  if (args.json) {
    console.log(JSON.stringify(finalReport, null, 2));
  } else {
    console.log("─── Backtest Report ───");
    for (const [k, v] of Object.entries(finalReport)) {
      console.log(`  ${k.padEnd(18)} ${v}`);
    }
  }
}

main().catch((err) => {
  console.error("backtest failed:", err);
  process.exit(1);
});
