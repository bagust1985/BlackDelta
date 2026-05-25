#!/usr/bin/env node
/**
 * BlackDelta — Preset Swapper
 *
 * Apply config preset (e.g. bid_ask, conservative, aggressive) to user-config.json.
 * Selalu backup current config sebelum apply.
 *
 * Usage:
 *   node scripts/preset.js list                   # list available presets
 *   node scripts/preset.js show bid_ask           # show preset content
 *   node scripts/preset.js apply bid_ask          # apply with YES prompt
 *   node scripts/preset.js apply bid_ask --yes    # skip prompt
 *   node scripts/preset.js diff bid_ask           # show what would change
 *   node scripts/preset.js restore <backup-id>    # restore from backup
 *
 * Exit: 0 ok, 2 aborted, 3 error
 */

import fs from "fs";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const presetsDir = path.join(repoRoot, "presets");
const configPath = path.join(repoRoot, "user-config.json");

const argv = process.argv.slice(2);
const cmd = argv[0];
const arg = argv[1];
const yes = argv.includes("--yes");

function color(text, c) {
  const codes = { red: 31, green: 32, yellow: 33, cyan: 36, gray: 90 };
  return process.stdout.isTTY ? `\x1b[${codes[c] || 0}m${text}\x1b[0m` : text;
}

function listPresets() {
  if (!fs.existsSync(presetsDir)) {
    console.log("No presets directory yet.");
    return [];
  }
  return fs.readdirSync(presetsDir).filter(f => f.endsWith(".json")).map(f => f.replace(/\.json$/, ""));
}

function loadPreset(name) {
  const file = path.join(presetsDir, `${name}.json`);
  if (!fs.existsSync(file)) throw new Error(`Preset "${name}" not found at ${file}`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function loadConfig() {
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

function backupConfig() {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const backupPath = path.join(repoRoot, `user-config.json.preset-bak-${ts}`);
  fs.copyFileSync(configPath, backupPath);
  return backupPath;
}

function diffConfig(currentCfg, preset) {
  const changes = [];
  for (const [key, newVal] of Object.entries(preset)) {
    if (key.startsWith("_")) continue; // skip _description, _strategy_overview, etc
    const oldVal = currentCfg[key];
    if (JSON.stringify(oldVal) === JSON.stringify(newVal)) continue;
    changes.push({ key, oldVal, newVal });
  }
  return changes;
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

async function main() {
  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log(`BlackDelta preset swapper

Commands:
  list                  - list available presets
  show <name>           - show preset content
  diff <name>           - show what would change (no apply)
  apply <name> [--yes]  - apply preset (with backup)
  restore <backup-id>   - restore a previous backup

Examples:
  node scripts/preset.js list
  node scripts/preset.js diff bid_ask
  node scripts/preset.js apply bid_ask --yes
`);
    process.exit(0);
  }

  if (cmd === "list") {
    const names = listPresets();
    if (!names.length) {
      console.log("No presets in", presetsDir);
      process.exit(0);
    }
    console.log("Available presets:");
    for (const n of names) {
      try {
        const p = loadPreset(n);
        const desc = p._description || "(no description)";
        console.log(`  ${color(n, "cyan")} — ${desc.slice(0, 90)}${desc.length > 90 ? "..." : ""}`);
      } catch {
        console.log(`  ${n} — (error loading)`);
      }
    }
    process.exit(0);
  }

  if (cmd === "show") {
    if (!arg) { console.error("Need preset name"); process.exit(3); }
    const p = loadPreset(arg);
    console.log(JSON.stringify(p, null, 2));
    process.exit(0);
  }

  if (cmd === "diff" || cmd === "apply") {
    if (!arg) { console.error("Need preset name"); process.exit(3); }
    const preset = loadPreset(arg);
    const current = loadConfig();
    const changes = diffConfig(current, preset);

    console.log("");
    console.log(`Preset: ${color(arg, "cyan")}`);
    if (preset._description) console.log(`Description: ${color(preset._description, "gray")}`);
    console.log("");

    if (changes.length === 0) {
      console.log(color("No changes — current config already matches preset.", "green"));
      process.exit(0);
    }

    console.log(`${changes.length} key(s) will change:`);
    console.log("");
    for (const c of changes) {
      const oldStr = JSON.stringify(c.oldVal);
      const newStr = JSON.stringify(c.newVal);
      console.log(`  ${c.key.padEnd(32)} ${color(oldStr, "red")} → ${color(newStr, "green")}`);
    }
    console.log("");

    if (cmd === "diff") {
      process.exit(0);
    }

    // apply mode
    if (!yes) {
      const ok = await askYes(`Type YES (uppercase) to apply preset "${arg}":\n> `);
      if (!ok) {
        console.log("Aborted.");
        process.exit(2);
      }
    }

    const backupPath = backupConfig();
    console.log("");
    console.log(`Backup saved: ${path.basename(backupPath)}`);

    // Merge: keep current's keys + override with preset's (excluding _meta)
    const merged = { ...current };
    for (const [key, val] of Object.entries(preset)) {
      if (key.startsWith("_")) continue;
      merged[key] = val;
    }

    fs.writeFileSync(configPath, JSON.stringify(merged, null, 2) + "\n");
    console.log(color(`✅ Applied preset "${arg}".`, "green"));
    console.log("");
    console.log("Next: bd-restart to load new config.");
    console.log("Rollback: node scripts/preset.js restore " + path.basename(backupPath).replace("user-config.json.preset-bak-", ""));
    process.exit(0);
  }

  if (cmd === "restore") {
    if (!arg) { console.error("Need backup-id (e.g. 2026-05-25T07-30-00)"); process.exit(3); }
    const backupFile = path.join(repoRoot, `user-config.json.preset-bak-${arg}`);
    if (!fs.existsSync(backupFile)) {
      console.error(`Backup not found: ${backupFile}`);
      process.exit(3);
    }
    if (!yes) {
      const ok = await askYes(`Type YES to restore from ${path.basename(backupFile)}:\n> `);
      if (!ok) { console.log("Aborted."); process.exit(2); }
    }
    const beforeRestore = backupConfig();
    console.log(`Current saved to: ${path.basename(beforeRestore)}`);
    fs.copyFileSync(backupFile, configPath);
    console.log(color(`✅ Restored from ${arg}`, "green"));
    console.log("Next: bd-restart");
    process.exit(0);
  }

  console.error(`Unknown command: ${cmd}. Use --help.`);
  process.exit(3);
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(3);
});
