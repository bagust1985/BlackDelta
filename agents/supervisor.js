/**
 * Multi-agent supervisor (Phase 6).
 *
 * Entry point: supervisor.tick({ trigger, payload })
 *
 * Triggers and the specialists they dispatch to:
 *   - "cron-mgmt"      → manager
 *   - "cron-screen"    → screener (with optional researcher prelude)
 *   - "ws-oor"         → manager  (urgent close path)
 *   - "manual"         → custom mix via payload.roles
 *
 * Modes (config.orchestrator.mode):
 *   - "single"     : delegate to legacy agentLoop callers (no-op)
 *   - "shadow"     : run specialists in parallel BUT only log their
 *                    decisions — execution still flows through legacy
 *   - "sequential" : specialists run one-after-another and their tool
 *                    calls execute live
 *   - "parallel"   : specialists run concurrently (Phase 6 final form)
 *
 * Default is "single" so this module is dormant until the operator
 * flips the flag.
 */

import { runScreener } from "./screener.js";
import { runManager } from "./manager.js";
import { runResearcher } from "./researcher.js";
import { bus } from "./bus.js";
import { config } from "../config.js";
import { log } from "../logger.js";
import { appendDecision } from "../decision-log.js";

const MODE = () => config?.orchestrator?.mode || "single";

async function dispatch({ roles, context }) {
  const mode = MODE();
  if (mode === "single") return { skipped: true, mode };

  bus.resetContext();
  bus.setContext(context);

  // Always run researcher first (read-only) so its findings can flow
  // into screener/manager prompts in future iterations. For now its
  // output is logged for review.
  const runners = {
    researcher: runResearcher,
    screener: runScreener,
    manager: runManager,
  };
  const ordered = roles.filter((r) => runners[r]);
  const results = [];

  if (mode === "parallel") {
    const settled = await Promise.allSettled(ordered.map((r) => runners[r]({ context })));
    for (let i = 0; i < settled.length; i++) {
      const s = settled[i];
      results.push(s.status === "fulfilled" ? s.value : { role: ordered[i], ok: false, error: String(s.reason) });
    }
  } else {
    // sequential or shadow
    for (const r of ordered) {
      const res = await runners[r]({ context });
      results.push(res);
      bus.publish(`role:${r}:done`, res);
    }
  }

  return { mode, results };
}

export async function tick({ trigger = "manual", payload = {} } = {}) {
  const mode = MODE();
  const ctx = { trigger, ...payload };
  let roles;
  switch (trigger) {
    case "cron-mgmt":
      roles = ["manager"];
      break;
    case "cron-screen":
      roles = ["researcher", "screener"];
      break;
    case "ws-oor":
      roles = ["manager"];
      break;
    case "manual":
      roles = Array.isArray(payload.roles) && payload.roles.length ? payload.roles : ["researcher"];
      break;
    default:
      roles = ["researcher"];
  }

  log("supervisor", `tick trigger=${trigger} mode=${mode} roles=${roles.join(",")}`);

  if (mode === "single") {
    return { mode, skipped: true, roles };
  }

  const report = await dispatch({ roles, context: ctx });

  // Phase 6 shadow-mode: log decisions but do not let them propagate
  // outside the supervisor. Live execution still flows through the
  // legacy callers in index.js.
  if (mode === "shadow") {
    appendDecision({
      type: "supervisor_shadow",
      actor: "SUPERVISOR",
      summary: `trigger=${trigger} roles=${roles.join(",")} ok=${report.results?.filter((r) => r.ok).length}/${report.results?.length}`,
      metrics: {
        trigger,
        roles,
        durations: report.results?.map((r) => ({ role: r.role, ok: r.ok, ms: r.durationMs })) || [],
      },
    });
    return { mode, shadow: true, ...report };
  }

  return { trigger, ...report };
}

export const supervisor = { tick };
export default supervisor;
