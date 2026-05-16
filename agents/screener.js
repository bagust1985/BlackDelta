/**
 * Screener specialist agent.
 *
 * Wraps agentLoop with SCREENER role + tool allow-list, returning a
 * structured Report consumable by the supervisor.
 */

import { agentLoop } from "../agent.js";
import { getRoleConfig } from "./registry.js";
import { config } from "../config.js";
import { log } from "../logger.js";

export async function runScreener({ goal, context = {} } = {}) {
  const role = getRoleConfig("screener");
  const prompt = goal || buildDefaultGoal(context);
  const start = Date.now();
  try {
    const text = await agentLoop(prompt, config.llm.maxSteps, [], role.agentType, role.model);
    return {
      role: "screener",
      ok: true,
      durationMs: Date.now() - start,
      result: text,
    };
  } catch (err) {
    log("supervisor_screener_error", err.message);
    return { role: "screener", ok: false, error: err.message };
  }
}

function buildDefaultGoal(context) {
  const open = context.openPositions?.length || 0;
  return `SCREENER CYCLE\n\nOpen positions: ${open}. Find the strongest candidate and deploy if criteria are met. Skip with a reason otherwise.`;
}
