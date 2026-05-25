#!/usr/bin/env node
/**
 * BlackDelta — BirdEye API Key Validator + Optional .env Writer
 *
 * Validates BIRDEYE_API_KEY by hitting 3 endpoints + sample token data.
 * Optionally appends/updates .env file kalau test pass.
 *
 * Usage:
 *   node scripts/test-birdeye.js <key>              # test only
 *   node scripts/test-birdeye.js <key> --save       # test + save to .env (with backup)
 *   node scripts/test-birdeye.js --env              # test key already in env (no arg)
 *   node scripts/test-birdeye.js --help
 *
 * Exit: 0 = valid, 1 = invalid, 2 = aborted, 3 = error
 */

import fs from "fs";
import path from "path";
import os from "os";
import readline from "readline";
import { fileURLToPath } from "url";
import { loadEnv } from "../envcrypt.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

// ─── Locate .env (same logic as cli.js / close-all.js) ──────────
const blackdeltaDir = path.join(os.homedir(), ".blackdelta");
const meridianDir   = path.join(os.homedir(), ".meridian");
const targetDir = fs.existsSync(blackdeltaDir) ? blackdeltaDir
                : fs.existsSync(meridianDir)   ? meridianDir
                : repoRoot;
const envPath = path.join(targetDir, ".env");

const argv = process.argv.slice(2);
const fromEnv = argv.includes("--env");
const save    = argv.includes("--save");
const help    = argv.includes("--help") || argv.includes("-h");

if (help) {
  console.log(`BlackDelta — BirdEye API Key Validator

Usage:
  node scripts/test-birdeye.js <key>              # test the key
  node scripts/test-birdeye.js <key> --save       # test then save to .env
  node scripts/test-birdeye.js --env              # test key from existing .env
  node scripts/test-birdeye.js --help

Tests run:
  1. /defi/networks            (basic auth ping)
  2. /defi/token_security      (filter endpoint, real token)
  3. /defi/token_overview      (alt endpoint)

Sample token: DEGEN-SOL (FmjijgwEHpe32VPvHy1s7u7TLthh9yu1j75djVbWpump)

Exit codes: 0 valid | 1 invalid | 2 aborted | 3 error
`);
  process.exit(0);
}

// Get key
let KEY;
if (fromEnv) {
  if (fs.existsSync(envPath)) {
    loadEnv({ envPath, keyPath: path.join(targetDir, ".envrypt"), override: false });
  }
  KEY = process.env.BIRDEYE_API_KEY;
  if (!KEY) {
    console.error("✗ No BIRDEYE_API_KEY in environment. Run setup wizard or pass key as arg.");
    process.exit(3);
  }
} else {
  KEY = argv.find((a) => !a.startsWith("--"));
  if (!KEY) {
    console.error("✗ No key provided. Usage: node scripts/test-birdeye.js <key>");
    console.error("  Or: node scripts/test-birdeye.js --env  (to test key in .env)");
    process.exit(3);
  }
}

function color(text, c) {
  const codes = { red: 31, green: 32, yellow: 33, cyan: 36, gray: 90 };
  return process.stdout.isTTY ? `\x1b[${codes[c] || 0}m${text}\x1b[0m` : text;
}

const BASE = "https://public-api.birdeye.so";
const HEADERS = { "X-API-KEY": KEY, "x-chain": "solana", "Accept": "application/json" };
const TEST_MINT = "FmjijgwEHpe32VPvHy1s7u7TLthh9yu1j75djVbWpump"; // DEGEN

async function callEndpoint(name, url) {
  process.stdout.write(`  ${name.padEnd(30)} `);
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(10000) });
    const status = res.status;
    let body = null;
    try { body = await res.json(); } catch { body = await res.text(); }

    if (status === 200 && body?.success === true) {
      console.log(color(`✓ 200 OK`, "green"));
      return { ok: true, status, data: body.data };
    } else if (status === 401 || (body?.message || "").toLowerCase().includes("unauthorized")) {
      console.log(color(`✗ 401 Unauthorized — key invalid or revoked`, "red"));
      return { ok: false, status, error: "unauthorized" };
    } else if (status === 429) {
      console.log(color(`⚠ 429 Rate Limited (key valid but quota hit)`, "yellow"));
      return { ok: true, status, error: "rate_limited" };
    } else if (status === 403) {
      console.log(color(`✗ 403 Forbidden — plan/tier ga support endpoint ini`, "red"));
      return { ok: false, status, error: "forbidden" };
    } else {
      console.log(color(`✗ ${status} — ${(body?.message || JSON.stringify(body)).slice(0, 80)}`, "red"));
      return { ok: false, status, error: body?.message };
    }
  } catch (e) {
    if (e.name === "AbortError") {
      console.log(color("✗ Timeout (>10s)", "red"));
    } else {
      console.log(color(`✗ Network error: ${e.message}`, "red"));
    }
    return { ok: false, error: e.message };
  }
}

async function askYes(promptText) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(promptText, (answer) => {
      rl.close();
      resolve(answer === "YES");
    });
  });
}

function saveToEnv(key) {
  if (!fs.existsSync(envPath)) {
    fs.writeFileSync(envPath, `BIRDEYE_API_KEY=${key}\n`, { mode: 0o600 });
    return { created: true };
  }
  // Backup
  const backupPath = envPath + ".bak-" + new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  fs.copyFileSync(envPath, backupPath);

  let content = fs.readFileSync(envPath, "utf8");
  if (/^BIRDEYE_API_KEY=/m.test(content)) {
    // Update existing line
    content = content.replace(/^BIRDEYE_API_KEY=.*$/m, `BIRDEYE_API_KEY=${key}`);
  } else {
    // Append
    if (!content.endsWith("\n")) content += "\n";
    content += `BIRDEYE_API_KEY=${key}\n`;
  }
  fs.writeFileSync(envPath, content, { mode: 0o600 });
  return { backupPath };
}

// ─── Main ──────────────────────────────────────────────────────────
async function main() {
  console.log("");
  console.log(color("BlackDelta — BirdEye API Key Validator", "cyan"));
  console.log(color(`Key: ${KEY.slice(0, 8)}…${KEY.slice(-4)} (${KEY.length} chars)`, "gray"));
  console.log(color(`Target .env: ${envPath}`, "gray"));
  console.log("");

  console.log("Running 3 endpoint tests:");
  const r1 = await callEndpoint("/defi/networks (auth ping)",     `${BASE}/defi/networks`);
  const r2 = await callEndpoint("/defi/token_security (filter)",  `${BASE}/defi/token_security?address=${TEST_MINT}`);
  const r3 = await callEndpoint("/defi/token_overview (alt)",     `${BASE}/defi/token_overview?address=${TEST_MINT}`);
  console.log("");

  const allPass = r1.ok && r2.ok;  // overview optional, security + ping critical
  const securityHasData = r2.ok && r2.data;

  if (!allPass) {
    console.log(color("=== ❌ Key invalid or restricted ===", "red"));
    if (r1.status === 401 || r2.status === 401) {
      console.log("Possible causes:");
      console.log("  - Typo in key (paste again, no extra spaces)");
      console.log("  - Key revoked at https://birdeye.so dashboard");
      console.log("  - Account suspended");
      console.log("  - Wrong key (used different service?)");
    } else if (r1.status === 403 || r2.status === 403) {
      console.log("Free tier may not include /defi/token_security — upgrade plan or use alternative.");
    }
    process.exit(1);
  }

  // Success — show sample data
  console.log(color("=== ✅ Key valid ===", "green"));
  console.log("");
  if (securityHasData) {
    const d = r2.data;
    console.log(color("Sample data from DEGEN-SOL (/defi/token_security):", "cyan"));
    console.log(`  top10 holders %:        ${d.top10HolderPercent != null ? (d.top10HolderPercent * 100).toFixed(1) + "%" : "—"}`);
    console.log(`  mint authority:         ${d.mintAuthority || "renounced ✓"}`);
    console.log(`  freeze authority:       ${d.freezeAuthority || "renounced ✓"}`);
    console.log(`  freezeable:             ${d.freezeable ? color("yes ⚠️", "yellow") : "no ✓"}`);
    console.log(`  transfer fee enabled:   ${d.transferFeeEnable ? color("yes ⚠️", "yellow") : "no ✓"}`);
    console.log(`  mutable metadata:       ${d.mutableMetadata ? color("yes ⚠️", "yellow") : "no ✓"}`);
    console.log(`  creator %:              ${d.creatorPercentage != null ? (d.creatorPercentage * 100).toFixed(2) + "%" : "—"}`);
    console.log(`  owner %:                ${d.ownerPercentage != null ? (d.ownerPercentage * 100).toFixed(2) + "%" : "—"}`);
  }
  console.log("");

  // Save if requested
  if (save) {
    console.log(color(`💾 Save key to ${envPath}?`, "cyan"));
    const confirmed = await askYes("Type YES (uppercase) to write key to .env:\n> ");
    if (!confirmed) {
      console.log("Aborted save.");
      process.exit(2);
    }
    try {
      const r = saveToEnv(KEY);
      if (r.created) console.log(color(`✅ Created new .env file with BIRDEYE_API_KEY`, "green"));
      else console.log(color(`✅ Saved BIRDEYE_API_KEY to .env (backup: ${path.basename(r.backupPath)})`, "green"));
      console.log("");
      console.log(color("Next steps:", "cyan"));
      console.log("  1. Enable BirdEye layer:");
      console.log(`     Edit user-config.json → "multiLayerScreening": { "birdeyeEnabled": true, ... }`);
      console.log(`     Or one-liner: sed -i 's/"birdeyeEnabled": false/"birdeyeEnabled": true/' ${path.join(repoRoot, "user-config.json")}`);
      console.log("  2. Restart bot: bd-restart");
      console.log("  3. Verify in log: bd-logs | grep -i birdeye");
    } catch (e) {
      console.error(color(`✗ Failed to write .env: ${e.message}`, "red"));
      process.exit(3);
    }
  } else {
    console.log(color("Key valid but NOT saved. Run with --save to write to .env.", "gray"));
    console.log(color(`Example: node scripts/test-birdeye.js ${KEY.slice(0, 6)}... --save`, "gray"));
  }

  process.exit(0);
}

main().catch((e) => {
  console.error("");
  console.error(color(`Fatal: ${e.stack || e.message}`, "red"));
  process.exit(3);
});
