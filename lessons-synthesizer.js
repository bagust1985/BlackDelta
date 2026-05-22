/**
 * BlackDelta — Lessons Synthesizer
 *
 * Daily LLM batch pass over recent closed positions. Uses the LESSONS role
 * provider (typically Claude Opus) to extract strategic insights that pure-JS
 * heuristics in lessons.js can't surface.
 *
 * Triggered by cron in index.js (per config.lessonsLoop.cron). Cheap: 1 call/day
 * with ~50-100 closes worth of context = ~$0.10-0.30/day for Opus.
 *
 * Output: each insight is saved via lessons.addLesson() with tag="synthesized"
 * + sourceType="llm_synthesis", pinned=false. Screener/Manager prompts pick
 * them up automatically via getLessonsForPrompt().
 */

import { agentLoop } from "./agent.js";
import { addLesson, getPerformanceHistory } from "./lessons.js";
import { config } from "./config.js";
import { log } from "./logger.js";

const SYNTH_TAG = "synthesized";

/**
 * Run one synthesis pass. Idempotent: safe to call multiple times — duplicate
 * insights de-duped at addLesson sanitize layer.
 *
 * @returns {Promise<{ok:boolean, insightCount:number, skipped?:string, error?:string}>}
 */
export async function synthesizeDailyLessons() {
  const cfg = config.lessonsLoop || {};
  if (!cfg.enabled) {
    return { ok: false, insightCount: 0, skipped: "lessonsLoop.enabled=false" };
  }

  const hours = Number(cfg.lookbackHours ?? 24);
  const minCloses = Number(cfg.minCloses ?? 3);
  const maxInsights = Number(cfg.maxInsights ?? 3);

  // Pull recent perf records (already ordered, capped to 50 by default)
  const recent = getPerformanceHistory({ hours, limit: 100 });
  if (!Array.isArray(recent) || recent.length < minCloses) {
    log("lessons_synth", `Skipping — only ${recent?.length ?? 0} closes in last ${hours}h (min ${minCloses})`);
    return { ok: false, insightCount: 0, skipped: `insufficient_closes (${recent?.length ?? 0}/${minCloses})` };
  }

  // Compute aggregate stats for the prompt
  const wins = recent.filter((p) => (p.pnl_usd ?? 0) > 0);
  const losses = recent.filter((p) => (p.pnl_usd ?? 0) < 0);
  const totalPnl = recent.reduce((s, p) => s + (p.pnl_usd ?? 0), 0);
  const avgPnl = totalPnl / recent.length;
  const winRate = recent.length > 0 ? (wins.length / recent.length) * 100 : 0;
  const biggestLoser = [...recent].sort((a, b) => (a.pnl_usd ?? 0) - (b.pnl_usd ?? 0))[0];
  const biggestWinner = [...recent].sort((a, b) => (b.pnl_usd ?? 0) - (a.pnl_usd ?? 0))[0];

  // Trim perf payload — avoid sending massive context to Opus
  const compactPerf = recent.map((p) => ({
    pool: p.pool_name,
    pnl_usd: p.pnl_usd,
    pnl_pct: p.pnl_pct,
    strategy: p.strategy,
    volatility: p.volatility,
    fee_tvl_ratio: p.fee_tvl_ratio,
    bin_step: p.bin_step,
    minutes_held: p.minutes_held,
    range_efficiency: p.range_efficiency,
    close_reason: (p.close_reason || "").slice(0, 80),
  }));

  const goal = `You are reviewing the BlackDelta DLMM LP bot's performance over the last ${hours} hours.

AGGREGATE STATS:
- Total closes: ${recent.length}
- Win rate: ${winRate.toFixed(1)}% (${wins.length}W / ${losses.length}L)
- Total PnL: $${totalPnl.toFixed(2)}
- Average PnL per close: $${avgPnl.toFixed(2)}
- Biggest winner: ${biggestWinner?.pool_name} ($${biggestWinner?.pnl_usd?.toFixed(2)})
- Biggest loser: ${biggestLoser?.pool_name} ($${biggestLoser?.pnl_usd?.toFixed(2)})

CLOSED POSITIONS (compact):
${JSON.stringify(compactPerf, null, 2)}

YOUR TASK:
Extract up to ${maxInsights} STRATEGIC INSIGHTS that the bot's screener and manager should learn from this batch. Each insight must:

1. Be ACTIONABLE — frame it as a rule (e.g. "PREFER: ...", "AVOID: ...", "INCREASE: ...", "DECREASE: ...").
2. Be SPECIFIC — reference concrete numbers, pool types, volatility ranges, fee/TVL ratios, or close-reason patterns.
3. Be NOVEL — focus on cross-trade patterns the pure-JS heuristics already in lessons.js wouldn't catch (e.g. correlation between volatility AND bin_step, time-of-day effects, sequential loss clustering).
4. Avoid restating obvious individual outcomes ("Coinini lost money" is not an insight; "pools with vol>3 + fee/TVL>0.5 cluster in OOR closes" is).

OUTPUT FORMAT — strict JSON only, no prose, no markdown:
{
  "insights": [
    { "rule": "AVOID: ...", "tag_hint": "screener|manager|strategy", "confidence": "high|medium|low" }
  ]
}

If there are no novel insights worth recording, return {"insights": []}.`;

  let response;
  try {
    response = await agentLoop(
      goal,
      4,                    // maxSteps — synthesis shouldn't need tools
      [],                   // no history
      "LESSONS",            // role → routes to lessons provider (Claude Opus)
      null,                 // model — let provider config decide
      2048,                 // maxOutputTokens
      {}
    );
  } catch (e) {
    log("lessons_synth_error", `agentLoop failed: ${e.message}`);
    return { ok: false, insightCount: 0, error: e.message };
  }

  const content = response?.content || "";
  let parsed;
  try {
    // Strip markdown fences if model didn't comply with "no markdown"
    const jsonStr = content.replace(/```json\s*|\s*```/g, "").trim();
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    log("lessons_synth_warn", `Failed to parse insights JSON: ${e.message} | raw: ${content.slice(0, 200)}`);
    return { ok: false, insightCount: 0, error: "parse_failed" };
  }

  const insights = Array.isArray(parsed?.insights) ? parsed.insights.slice(0, maxInsights) : [];
  if (insights.length === 0) {
    log("lessons_synth", "Model returned 0 insights for this window.");
    return { ok: true, insightCount: 0 };
  }

  // Persist via addLesson — sanitize + de-dup happens there
  let saved = 0;
  for (const i of insights) {
    if (!i?.rule || typeof i.rule !== "string") continue;
    const tagHint = String(i.tag_hint || "strategy").toLowerCase().split("|")[0];
    const confidence = String(i.confidence || "medium").toLowerCase();
    try {
      addLesson(i.rule, [SYNTH_TAG, "llm_synthesis", tagHint, `confidence_${confidence}`], {
        pinned: false,
        role: ["screener", "manager"].includes(tagHint) ? tagHint.toUpperCase() : null,
      });
      saved++;
    } catch (e) {
      log("lessons_synth_warn", `Failed to save insight: ${e.message}`);
    }
  }

  log("lessons_synth", `Synthesized ${saved}/${insights.length} insights from ${recent.length} closes in last ${hours}h.`);
  return { ok: true, insightCount: saved };
}
