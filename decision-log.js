import fs from "fs";
import { log } from "./logger.js";

const DECISION_LOG_FILE = "./decision-log.json";
const MAX_DECISIONS = 100;

function load() {
  if (!fs.existsSync(DECISION_LOG_FILE)) {
    return { decisions: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(DECISION_LOG_FILE, "utf8"));
  } catch (error) {
    log("decision_log_warn", `Invalid ${DECISION_LOG_FILE}: ${error.message}`);
    return { decisions: [] };
  }
}

function save(data) {
  fs.writeFileSync(DECISION_LOG_FILE, JSON.stringify(data, null, 2));
}

function sanitize(value, maxLen = 280) {
  if (value == null) return null;
  return String(value).replace(/\s+/g, " ").trim().slice(0, maxLen) || null;
}

// Cap full LLM report at 8KB per decision (avg LLM screening reply ~2-4KB).
// 100 decisions × 8KB = max ~800KB file footprint.
const MAX_FULL_REPORT_BYTES = 8 * 1024;

function sanitizeReport(value) {
  if (value == null) return null;
  // Preserve newlines + multi-line formatting (unlike sanitize() which collapses whitespace).
  const str = String(value).trim();
  if (str.length === 0) return null;
  return str.length > MAX_FULL_REPORT_BYTES
    ? str.slice(0, MAX_FULL_REPORT_BYTES) + `\n\n... [truncated at ${MAX_FULL_REPORT_BYTES} bytes]`
    : str;
}

export function appendDecision(entry) {
  const data = load();
  const decision = {
    id: `dec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ts: new Date().toISOString(),
    type: entry.type || "note",
    actor: entry.actor || "GENERAL",
    pool: entry.pool || null,
    pool_name: sanitize(entry.pool_name || entry.pool, 120),
    position: entry.position || null,
    summary: sanitize(entry.summary),
    reason: sanitize(entry.reason, 500),
    risks: Array.isArray(entry.risks) ? entry.risks.map((r) => sanitize(r, 140)).filter(Boolean).slice(0, 6) : [],
    metrics: entry.metrics || {},
    rejected: Array.isArray(entry.rejected) ? entry.rejected.map((r) => sanitize(r, 180)).filter(Boolean).slice(0, 8) : [],
    // Optional full LLM report (preserves newlines, capped at 8KB).
    // Used by dashboard modal to show complete reasoning.
    full_report: sanitizeReport(entry.full_report),
    // Optional structured candidate snapshot (for screening decisions).
    candidates_seen: Array.isArray(entry.candidates_seen) ? entry.candidates_seen.slice(0, 20) : null,
  };
  data.decisions.unshift(decision);
  data.decisions = data.decisions.slice(0, MAX_DECISIONS);
  save(data);
  return decision;
}

export function getRecentDecisions(limit = 10) {
  const data = load();
  return (data.decisions || []).slice(0, limit);
}

/**
 * Lookup single decision by ID. Returns null kalau ga ketemu.
 * Used by /api/decisions/:id endpoint for popup detail view.
 */
export function getDecisionById(id) {
  if (!id) return null;
  const data = load();
  return (data.decisions || []).find((d) => d.id === id) || null;
}

export function getDecisionSummary(limit = 6) {
  const decisions = getRecentDecisions(limit);
  if (!decisions.length) return "No recent structured decisions yet.";
  return decisions.map((d, i) => {
    const bits = [
      `${i + 1}. [${d.actor}] ${d.type.toUpperCase()} ${d.pool_name || d.pool || "unknown pool"}`,
      d.summary ? `summary: ${d.summary}` : null,
      d.reason ? `reason: ${d.reason}` : null,
      d.risks?.length ? `risks: ${d.risks.join(", ")}` : null,
      d.rejected?.length ? `rejected: ${d.rejected.join(" | ")}` : null,
    ].filter(Boolean);
    return bits.join(" | ");
  }).join("\n");
}
