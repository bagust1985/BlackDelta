/**
 * Researcher specialist agent.
 *
 * Read-only analysis: smart wallets, recent decisions, pool/token deep
 * dive. Output is consumed by the supervisor to enrich screener/manager
 * context (no direct trade actions).
 */

import { agentLoop } from "../agent.js";
import { getRoleConfig } from "./registry.js";
import { config } from "../config.js";
import { log } from "../logger.js";

export async function runResearcher({ goal, context = {} } = {}) {
  const role = getRoleConfig("researcher");
  const prompt = goal || buildDefaultGoal(context);
  const start = Date.now();
  try {
    const text = await agentLoop(prompt, Math.min(config.llm.maxSteps, 10), [], role.agentType, role.model);
    return {
      role: "researcher",
      ok: true,
      durationMs: Date.now() - start,
      result: text,
    };
  } catch (err) {
    log("supervisor_researcher_error", err.message);
    return { role: "researcher", ok: false, error: err.message };
  }
}

function buildDefaultGoal(context) {
  const trigger = context.trigger || "manual";
  return `RESEARCH PASS (trigger=${trigger})\n\nSummarize recent smart-wallet activity, OKX signals, and decision-log themes. Identify 1-2 actionable observations for the screener/manager.`;
}
