/**
 * BlackDelta web dashboard server.
 *
 * Tiny native-Node HTTP server (no express) that serves:
 *   GET /                 dashboard HTML (macOS terminal theme)
 *   GET /api/status       wallet + uptime + mode + balance
 *   GET /api/positions    open positions with live PnL
 *   GET /api/decisions    last 25 entries from decision-log.json
 *   GET /api/performance  closed positions + lessons summary
 *
 * Protected by HTTP Basic auth (config.web.password).
 * Intended to sit behind Cloudflare proxy (free SSL + DDoS).
 *
 * Designed to share the bot's process: gets `getMyPositions()` from the
 * adapter so it uses the same cache and doesn't pile on extra API calls.
 */

import fs from "fs";
import path from "path";
import http from "http";
import { fileURLToPath } from "url";
import { config } from "./config.js";
import { log } from "./logger.js";
import { getAdapter } from "./tools/dex/index.js";
import { getWalletBalances } from "./tools/wallet.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const DECISION_LOG = path.join(__dirname, "decision-log.json");
const LESSONS = path.join(__dirname, "lessons.json");
const STATE = path.join(__dirname, "state.json");

let _server = null;
let _startedAt = null;

function readJsonSafe(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

function isAuthorized(req) {
  const pw = config?.web?.password;
  if (!pw) return true; // no password set = open access
  const header = req.headers["authorization"];
  if (!header || !header.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  if (idx < 0) return false;
  return decoded.slice(idx + 1) === pw;
}

function json(res, code, body) {
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  res.end(JSON.stringify(body));
}

function html(res, code, body) {
  res.writeHead(code, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function uptimeStr(startedAt) {
  if (!startedAt) return "—";
  const ms = Date.now() - startedAt;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${m}m`;
}

// ────────────────────────────────────────────
// Endpoint handlers
// ────────────────────────────────────────────

async function handleStatus() {
  let balances = null;
  let positions = null;
  try { balances = await getWalletBalances({}); } catch { /* ignore */ }
  try { positions = await getAdapter().getMyPositions({ force: false, silent: true }); } catch { /* ignore */ }

  const lessonsData = readJsonSafe(LESSONS, { performance: [], lessons: [] });
  const totalPnl = (lessonsData.performance || []).reduce((s, x) => s + (x.pnl_usd || 0), 0);

  return {
    online: true,
    mode: process.env.DRY_RUN === "true" ? "DRY_RUN" : "LIVE",
    uptime: uptimeStr(_startedAt),
    memMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    wallet: balances?.wallet || null,
    balanceSol: balances?.sol ?? null,
    balanceUsd: balances?.total_usd ?? null,
    openPositions: positions?.total_positions ?? 0,
    maxPositions: config?.risk?.maxPositions ?? 3,
    totalPnlUsd: lessonsData.performance?.length ? totalPnl : null,
    timestamp: new Date().toISOString(),
  };
}

async function handlePositions() {
  let positions = null;
  try {
    positions = await getAdapter().getMyPositions({ force: false, silent: true });
  } catch (e) {
    return { positions: [], error: e.message };
  }

  // Merge with state.json so deploy-time fields (amount_sol, deployed_at,
  // bin range, etc.) show up alongside live API metrics.
  const state = readJsonSafe(STATE, { positions: {} });
  const tracked = state.positions || {};
  const merged = (positions?.positions || []).map((p) => {
    const t = tracked[p.position];
    if (!t) return p;
    return {
      ...p,
      amount_sol:        p.amount_sol        ?? t.amount_sol        ?? null,
      initial_value_usd: p.initial_value_usd ?? t.initial_value_usd ?? null,
      deployed_at:       p.deployed_at       ?? t.deployed_at       ?? null,
      strategy:          p.strategy          ?? t.strategy          ?? null,
      // Use tracked bin_range as fallback if API doesn't expose lower/upper.
      lower_bin: p.lower_bin ?? t.bin_range?.min ?? null,
      upper_bin: p.upper_bin ?? t.bin_range?.max ?? null,
    };
  });

  return {
    positions: merged,
    total: positions?.total_positions || merged.length,
    timestamp: new Date().toISOString(),
  };
}

function handleDecisions() {
  const data = readJsonSafe(DECISION_LOG, { decisions: [] });
  return {
    decisions: (data.decisions || []).slice(0, 25),
    total: data.decisions?.length || 0,
  };
}

function handlePerformance() {
  const data = readJsonSafe(LESSONS, { performance: [], lessons: [] });
  const perf = data.performance || [];
  const wins = perf.filter((x) => (x.pnl_usd || 0) > 0).length;
  const totalPnl = perf.reduce((s, x) => s + (x.pnl_usd || 0), 0);
  const avgPnlPct = perf.length
    ? perf.reduce((s, x) => s + (x.pnl_pct || 0), 0) / perf.length
    : null;
  return {
    performance: perf,
    winRatePct: perf.length ? Math.round((wins / perf.length) * 100) : null,
    totalPnlUsd: perf.length ? Math.round(totalPnl * 100) / 100 : null,
    avgPnlPct: avgPnlPct != null ? Math.round(avgPnlPct * 100) / 100 : null,
    lessonsCount: (data.lessons || []).length,
    calendar: buildCalendar(perf, 12),
  };
}

/**
 * Aggregate closed-position PnL into a daily grid for the last N weeks.
 * Days with no trades come back with pnlUsd=0, count=0 so the frontend
 * can render every cell in the heatmap without conditional placeholders.
 */
function buildCalendar(perf, weeks = 12) {
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  const totalDays = weeks * 7;
  const start = new Date(end);
  start.setUTCDate(end.getUTCDate() - totalDays + 1);

  const byDay = new Map();
  for (const p of perf) {
    const d = new Date(p.recorded_at);
    if (Number.isNaN(d.getTime())) continue;
    const key = d.toISOString().slice(0, 10);
    const entry = byDay.get(key) || { pnlUsd: 0, count: 0 };
    entry.pnlUsd += Number(p.pnl_usd) || 0;
    entry.count += 1;
    byDay.set(key, entry);
  }

  const days = [];
  for (let i = 0; i < totalDays; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    const key = d.toISOString().slice(0, 10);
    const entry = byDay.get(key) || { pnlUsd: 0, count: 0 };
    days.push({
      date: key,
      pnlUsd: Math.round(entry.pnlUsd * 100) / 100,
      count: entry.count,
      dow: d.getUTCDay(),
    });
  }

  const maxAbs = days.reduce((m, x) => Math.max(m, Math.abs(x.pnlUsd)), 0) || 1;

  return {
    weeks,
    totalDays,
    startDate: days[0].date,
    endDate: days[days.length - 1].date,
    days,
    maxAbsPnlUsd: Math.round(maxAbs * 100) / 100,
  };
}

function serveStaticHtml(res) {
  const filepath = path.join(PUBLIC_DIR, "dashboard.html");
  try {
    const body = fs.readFileSync(filepath, "utf8");
    html(res, 200, body);
  } catch {
    html(res, 500, "<h1>500</h1><p>dashboard.html missing</p>");
  }
}

// ────────────────────────────────────────────
// Request dispatcher
// ────────────────────────────────────────────

async function handleRequest(req, res) {
  // Auth gate
  if (!isAuthorized(req)) {
    res.writeHead(401, {
      "www-authenticate": 'Basic realm="BlackDelta"',
      "content-type": "text/plain",
    });
    res.end("Authentication required.");
    return;
  }

  const url = (req.url || "/").split("?")[0];
  try {
    switch (url) {
      case "/":
      case "/index.html":
        return serveStaticHtml(res);
      case "/api/status":
        return json(res, 200, await handleStatus());
      case "/api/positions":
        return json(res, 200, await handlePositions());
      case "/api/decisions":
        return json(res, 200, handleDecisions());
      case "/api/performance":
        return json(res, 200, handlePerformance());
      case "/healthz":
        return json(res, 200, { ok: true });
      default:
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("404 not found");
    }
  } catch (err) {
    log("web_error", `${url}: ${err.message}`);
    json(res, 500, { error: err.message });
  }
}

// ────────────────────────────────────────────
// Lifecycle
// ────────────────────────────────────────────

export function start() {
  if (!config?.web?.enabled) {
    log("web", "dashboard disabled (config.web.enabled=false)");
    return null;
  }
  if (_server) return _server;
  const port = config.web.port || 3000;
  const host = config.web.host || "127.0.0.1";
  _server = http.createServer(handleRequest);
  _server.listen(port, host, () => {
    _startedAt = Date.now();
    const authed = config.web.password ? "password-protected" : "OPEN (no password)";
    log("web", `dashboard listening on http://${host}:${port} (${authed})`);
  });
  _server.on("error", (err) => log("web_error", `server error: ${err.message}`));
  return _server;
}

export async function stop() {
  if (!_server) return;
  await new Promise((resolve) => _server.close(resolve));
  _server = null;
  log("web", "dashboard stopped");
}
