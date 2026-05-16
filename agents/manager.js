/**
 * Manager specialist agent.
 *
 * Handles open-position decisions: claim, close, swap, set notes.
 */

import { agentLoop } from "../agent.js";
import { getRoleConfig } from "./registry.js";
import { config } from "../config.js";
import { log } from "../logger.js";

export async function runManager({ goal, context = {} } = {}) {
  const role = getRoleConfig("manager");
  const prompt = goal || buildDefaultGoal(context);
  const start = Date.now();
  try {
    const text = await agentLoop(prompt, config.llm.maxSteps, [], role.agentType, role.model);
    return {
      role: "manager",
      ok: true,
      durationMs: Date.now() - start,
      result: text,
    };
  } catch (err) {
    log("supervisor_manager_error", err.message);
    return { role: "manager", ok: false, error: err.message };
  }
}

function buildDefaultGoal(context) {
  const open = context.openPositions?.length || 0;
  const trigger = context.trigger || "cron-mgmt";
  return `MANAGEMENT CYCLE (trigger=${trigger})\n\nReview ${open} open positions and decide whether to claim fees, close, or hold.`;
}
