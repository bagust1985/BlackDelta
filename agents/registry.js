/**
 * Multi-agent role registry (Phase 6).
 *
 * Maps a specialist agent's id to:
 *   - the allowed tool set
 *   - the model to call (defaults to per-role config in config.llm)
 *   - the system prompt builder argument (agentType)
 *
 * Seed values mirror the pre-Phase-6 SCREENER_TOOLS / MANAGER_TOOLS sets
 * defined in agent.js, with a new RESEARCHER role that's read-only.
 */

import { config } from "../config.js";

export const SCREENER_TOOLS = [
  "deploy_position",
  "get_active_bin",
  "get_top_candidates",
  "check_smart_wallets_on_pool",
  "get_token_holders",
  "get_token_narrative",
  "get_token_info",
  "search_pools",
  "get_pool_memory",
  "get_wallet_balance",
  "get_my_positions",
];

export const MANAGER_TOOLS = [
  "close_position",
  "claim_fees",
  "swap_token",
  "get_position_pnl",
  "get_my_positions",
  "get_wallet_balance",
];

export const RESEARCHER_TOOLS = [
  "get_top_candidates",
  "get_pool_detail",
  "get_token_info",
  "get_token_holders",
  "get_token_narrative",
  "check_smart_wallets_on_pool",
  "list_smart_wallets",
  "get_recent_decisions",
];

export function getRoleConfig(role) {
  switch (role) {
    case "screener":
      return {
        agentType: "SCREENER",
        tools: SCREENER_TOOLS,
        model: config.llm.screeningModel,
      };
    case "manager":
      return {
        agentType: "MANAGER",
        tools: MANAGER_TOOLS,
        model: config.llm.managementModel,
      };
    case "researcher":
      return {
        agentType: "GENERAL",
        tools: RESEARCHER_TOOLS,
        model: config.llm.generalModel,
      };
    default:
      throw new Error(`Unknown role: ${role}`);
  }
}

export const ROLES = ["screener", "manager", "researcher"];
