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
  // Explicit opt-in: dashboard owner sets allowPublic=true to accept open access
  // (e.g. behind Cloudflare gating). Without this flag, missing password = deny all.
  if (config?.web?.allowPublic === true) return true;
  const pw = config?.web?.password;
  if (!pw) return false;
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
  // List view: strip heavy fields (full_report, candidates_seen) to keep payload small.
  const decisions = (data.decisions || []).slice(0, 25).map((d) => {
    const { full_report, candidates_seen, ...lite } = d;
    return { ...lite, has_full_report: !!full_report, candidates_count: candidates_seen?.length ?? 0 };
  });
  return {
    decisions,
    total: data.decisions?.length || 0,
  };
}

function handleDecisionById(id) {
  const data = readJsonSafe(DECISION_LOG, { decisions: [] });
  const decision = (data.decisions || []).find((d) => d.id === id);
  if (!decision) {
    return { error: "not_found", id };
  }
  return decision; // full payload including full_report + candidates_seen
}

function handlePaperTrades() {
  const PAPER_PATH = path.join(__dirname, "paper-positions.json");
  const data = readJsonSafe(PAPER_PATH, { positions: [], closed: [] });
  const closed = data.closed || [];
  const open = data.positions || [];

  const wins = closed.filter((p) => (p.estimated_pnl_usd || 0) > 0);
  const totalPnl = closed.reduce((s, p) => s + (p.estimated_pnl_usd || 0), 0);

  return {
    open_count: open.length,
    closed_count: closed.length,
    win_count: wins.length,
    win_rate_pct: closed.length > 0 ? Number(((wins.length / closed.length) * 100).toFixed(1)) : null,
    total_pnl_usd: Number(totalPnl.toFixed(2)),
    avg_pnl_usd: closed.length > 0 ? Number((totalPnl / closed.length).toFixed(2)) : 0,
    open: open.slice(0, 25),
    closed: closed.slice(-25).reverse(),
  };
}

function handleAbCompare() {
  // A/B compare: paper PnL (paused mode) vs actual PnL (live mode), last 7 days
  const PAPER_PATH = path.join(__dirname, "paper-positions.json");
  const paperData = readJsonSafe(PAPER_PATH, { closed: [] });
  const lessonsData = readJsonSafe(LESSONS, { performance: [] });

  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  const paperClosed = (paperData.closed || []).filter((p) =>
    p.closed_at && new Date(p.closed_at).getTime() > cutoff
  );
  const actualClosed = (lessonsData.performance || []).filter((p) =>
    p.recorded_at && new Date(p.recorded_at).getTime() > cutoff
  );

  const paperStats = computeStats(paperClosed, "estimated_pnl_usd", "estimated_pnl_pct");
  const actualStats = computeStats(actualClosed, "pnl_usd", "pnl_pct");

  return {
    window_hours: 168,
    paper: { ...paperStats, sample: paperClosed.length },
    actual: { ...actualStats, sample: actualClosed.length },
    delta: {
      win_rate_diff: paperStats.win_rate_pct != null && actualStats.win_rate_pct != null
        ? Number((paperStats.win_rate_pct - actualStats.win_rate_pct).toFixed(1)) : null,
      avg_pnl_usd_diff: Number((paperStats.avg_pnl_usd - actualStats.avg_pnl_usd).toFixed(2)),
    },
  };
}

function computeStats(arr, pnlUsdKey, pnlPctKey) {
  if (!arr || arr.length === 0) return { count: 0, total_pnl_usd: 0, avg_pnl_usd: 0, win_rate_pct: null };
  const wins = arr.filter((p) => (p[pnlUsdKey] || 0) > 0);
  const totalPnl = arr.reduce((s, p) => s + (p[pnlUsdKey] || 0), 0);
  const totalPnlPct = arr.reduce((s, p) => s + (p[pnlPctKey] || 0), 0);
  return {
    count: arr.length,
    win_count: wins.length,
    win_rate_pct: Number(((wins.length / arr.length) * 100).toFixed(1)),
    total_pnl_usd: Number(totalPnl.toFixed(2)),
    avg_pnl_usd: Number((totalPnl / arr.length).toFixed(2)),
    avg_pnl_pct: Number((totalPnlPct / arr.length).toFixed(2)),
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
 * Aggregate closed-position PnL into a daily grid covering N weeks
 * starting from the first trade date (forward-looking calendar).
 *
 * Layout: Monday-aligned weeks. Days array fills column-first so the
 * frontend's grid-auto-flow:column lays out row0=Mon, row1=Tue,
 * ..., row6=Sun across 12 columns.
 *
 * Future days (after today) are marked isFuture for fade-out styling.
 */
function buildCalendar(perf, weeks = 12) {
  // Find earliest trade as the seed. Fall back to today.
  let earliestMs = Number.POSITIVE_INFINITY;
  for (const p of perf) {
    const t = new Date(p.recorded_at).getTime();
    if (Number.isFinite(t) && t < earliestMs) earliestMs = t;
  }
  const seed = new Date(Number.isFinite(earliestMs) ? earliestMs : Date.now());
  seed.setUTCHours(0, 0, 0, 0);

  // Align to Monday: 0=Sun → -6, 1=Mon → 0, 2=Tue → -1, etc.
  const dow = seed.getUTCDay();
  const offsetToMonday = dow === 0 ? -6 : 1 - dow;
  seed.setUTCDate(seed.getUTCDate() + offsetToMonday);
  const startDate = seed;

  // Today midnight UTC for isToday / isFuture markers
  const todayUtc = new Date();
  todayUtc.setUTCHours(0, 0, 0, 0);
  const todayKey = todayUtc.toISOString().slice(0, 10);

  const totalDays = weeks * 7;

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

  // Forward 84 days from startDate
  const days = [];
  for (let i = 0; i < totalDays; i++) {
    const d = new Date(startDate);
    d.setUTCDate(startDate.getUTCDate() + i);
    const key = d.toISOString().slice(0, 10);
    const entry = byDay.get(key) || { pnlUsd: 0, count: 0 };
    days.push({
      date: key,
      pnlUsd: Math.round(entry.pnlUsd * 100) / 100,
      count: entry.count,
      dow: d.getUTCDay(),
      isToday: key === todayKey,
      isFuture: d.getTime() > todayUtc.getTime(),
    });
  }

  const maxAbs = days.reduce((m, x) => Math.max(m, Math.abs(x.pnlUsd)), 0) || 1;

  return {
    weeks,
    totalDays,
    startDate: days[0].date,
    endDate: days[days.length - 1].date,
    todayDate: todayKey,
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

/**
 * Serve a whitelisted static asset from PUBLIC_DIR with caching headers.
 * Routes map each public URL to its filename explicitly (no directory
 * traversal possible).
 */
function serveStaticAsset(res, filename, contentType) {
  const filepath = path.join(PUBLIC_DIR, filename);
  if (!filepath.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(filepath)) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("404 not found");
    return;
  }
  const stat = fs.statSync(filepath);
  res.writeHead(200, {
    "content-type": contentType,
    "content-length": stat.size,
    "cache-control": "public, max-age=86400",
  });
  fs.createReadStream(filepath).pipe(res);
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
      case "/blackdelta.png":
      case "/favicon.png":
      case "/apple-touch-icon.png":
        return serveStaticAsset(res, "blackdelta.png", "image/png");
      case "/api/status":
        return json(res, 200, await handleStatus());
      case "/api/positions":
        return json(res, 200, await handlePositions());
      case "/api/decisions":
        return json(res, 200, handleDecisions());
      case "/api/performance":
        return json(res, 200, handlePerformance());
      case "/api/paper":
        return json(res, 200, handlePaperTrades());
      case "/api/ab-compare":
        return json(res, 200, handleAbCompare());
      case "/healthz":
        return json(res, 200, { ok: true });
      default: {
        // Pattern match: /api/decisions/:id (alphanumeric + underscore safe)
        const m = url.match(/^\/api\/decisions\/([A-Za-z0-9_-]+)$/);
        if (m) {
          const result = handleDecisionById(m[1]);
          return json(res, result.error ? 404 : 200, result);
        }
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("404 not found");
      }
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
  const allowPublic = config.web.allowPublic === true;
  if (!allowPublic && !config.web.password) {
    log("web_error", "dashboard refused to start: set config.web.password OR config.web.allowPublic=true (explicit opt-in for open access)");
    return null;
  }
  if (_server) return _server;
  const port = config.web.port || 3000;
  const host = config.web.host || "127.0.0.1";
  _server = http.createServer(handleRequest);
  _server.listen(port, host, () => {
    _startedAt = Date.now();
    const mode = allowPublic ? "PUBLIC (allowPublic=true)" : "password-protected";
    log("web", `dashboard listening on http://${host}:${port} (${mode})`);
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
