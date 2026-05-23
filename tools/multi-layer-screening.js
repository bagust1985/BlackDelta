/**
 * BlackDelta — Multi-Layer Screening
 *
 * Tambahan layer screening setelah OKX enrichment di getTopCandidates().
 * 4 layer paralel (Promise.allSettled), masing-masing hard-filter independent:
 *
 *   1. DexScreener  — boost detection, artificial reactions, meta-rebrand patterns
 *   2. Rugcheck     — rug score, top10 concentration, mint/freeze authority
 *   3. GMGN.AI      — bundler/phishing/blue-chip holder distribution (requires GMGN_API_KEY)
 *   4. Smart Contract — derived dari Rugcheck (mint/freeze authority, age-aware)
 *
 * Layer failure (network/timeout/parse) → return "pass" (don't block deploy).
 * Hard-filter cuma kalau data successfully fetched dan threshold breached.
 *
 * Entry point: `applyMultiLayerScreening(candidates, screeningConfig)`.
 */

import { log } from "../logger.js";

const DEXSCREENER_API = "https://api.dexscreener.com/latest/dex/tokens";
const RUGCHECK_API    = "https://api.rugcheck.xyz/v1/tokens";
const GMGN_API        = "https://gmgn.ai/api/v1/mutil_window_token_info/sol";

// ─── Helpers ──────────────────────────────────────────────────────

function fetchWithTimeout(url, opts = {}, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  return fetch(url, { ...opts, signal: ctrl.signal })
    .finally(() => clearTimeout(t));
}

function safeNum(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// ─── Layer 1: DexScreener ─────────────────────────────────────────

/**
 * Fetch token data from DexScreener and apply hard-filter rules.
 * Reject reasons map ke user's flowchart:
 *   - boost > maxBoostCount
 *   - artificial reactions (500-1000+ tx with low TVL)
 *   - meta rebrand keywords in symbol/name (trump, elon, etc) on fresh tokens
 *   - low organic activity but high MC
 *
 * @returns {Promise<{pass:boolean, reason?:string, data?:object}>}
 */
export async function checkDexScreener(mint, tokenAgeHours, tokenName, screeningCfg) {
  const cfg = screeningCfg.multiLayerScreening;
  if (!cfg.dexScreenerEnabled) return { pass: true, skipped: "disabled" };
  if (!mint) return { pass: true, skipped: "no_mint" };

  try {
    const res = await fetchWithTimeout(`${DEXSCREENER_API}/${mint}`, {}, cfg.apiTimeoutMs);
    if (!res.ok) return { pass: true, skipped: `http_${res.status}` };
    const data = await res.json();
    const pairs = data?.pairs || [];
    if (pairs.length === 0) return { pass: true, skipped: "no_pairs" };

    // Pick highest-liquidity pair
    const best = [...pairs].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    const boosts = safeNum(best.boosts?.active, 0);
    const txnsH1 = (safeNum(best.txns?.h1?.buys, 0)) + (safeNum(best.txns?.h1?.sells, 0));
    const volH1 = safeNum(best.volume?.h1, 0);
    const liquidityUsd = safeNum(best.liquidity?.usd, 0);
    const mcap = safeNum(best.marketCap, 0);
    const symbol = String(best.baseToken?.symbol || tokenName || "").toLowerCase();

    const summary = {
      boosts_active: boosts,
      txns_h1_total: txnsH1,
      volume_h1: volH1,
      liquidity_usd: liquidityUsd,
      marketCap: mcap,
      pair_count: pairs.length,
    };

    // Rule: high boost (artificial pump signal)
    if (boosts > cfg.maxBoostCount) {
      return { pass: false, reason: `DexScreener: boost count ${boosts} > ${cfg.maxBoostCount} (artificial pump)`, data: summary };
    }

    // Rule: high reactions but low liquidity (bot-driven inflation)
    if (txnsH1 > 1000 && liquidityUsd < 5000) {
      return { pass: false, reason: `DexScreener: ${txnsH1} h1 txns but only $${liquidityUsd.toFixed(0)} liquidity (artificial activity)`, data: summary };
    }

    // Rule: meta-rebrand keywords + fresh token
    const ageH = safeNum(tokenAgeHours, 99999);
    if (ageH < 24 && Array.isArray(cfg.metaRebrandKeywords)) {
      const hitKeyword = cfg.metaRebrandKeywords.find((kw) => symbol.includes(String(kw).toLowerCase()));
      if (hitKeyword) {
        return { pass: false, reason: `DexScreener: meta-rebrand keyword "${hitKeyword}" in fresh token (age ${ageH.toFixed(1)}h)`, data: summary };
      }
    }

    // Rule: low organic activity but high MC (dead-cat sample)
    if (volH1 < 100 && txnsH1 < 20 && mcap > 500_000) {
      return { pass: false, reason: `DexScreener: low activity (vol $${volH1} / ${txnsH1} txns) vs high MC $${mcap} (suspicious)`, data: summary };
    }

    return { pass: true, data: summary };
  } catch (e) {
    return { pass: true, skipped: `error: ${e.message?.slice(0, 60)}` };
  }
}

// ─── Layer 2: Rugcheck ────────────────────────────────────────────

/**
 * Fetch Rugcheck report — covers rug score, top10 concentration, mint/freeze authorities.
 *
 * @returns {Promise<{pass:boolean, reason?:string, data?:object}>}
 */
export async function checkRugcheck(mint, screeningCfg) {
  const cfg = screeningCfg.multiLayerScreening;
  if (!cfg.rugcheckEnabled) return { pass: true, skipped: "disabled" };
  if (!mint) return { pass: true, skipped: "no_mint" };

  try {
    const res = await fetchWithTimeout(`${RUGCHECK_API}/${mint}/report`, {}, cfg.apiTimeoutMs);
    if (!res.ok) return { pass: true, skipped: `http_${res.status}` };
    const data = await res.json();

    const score = safeNum(data.score, 0);
    const rugged = !!data.rugged;
    const topHolders = Array.isArray(data.topHolders) ? data.topHolders : [];
    const top10pct = topHolders.slice(0, 10).reduce((sum, h) => sum + safeNum(h.pct ?? h.percentage, 0), 0);

    // Extract mint + freeze authority (we'll use this for SC layer too)
    const mintAuthority = data.token?.mintAuthority ?? data.mintAuthority ?? null;
    const freezeAuthority = data.token?.freezeAuthority ?? data.freezeAuthority ?? null;
    const totalLPProviders = safeNum(data.totalLPProviders ?? data.markets?.[0]?.lp?.holders, null);

    const summary = {
      rug_score: score,
      rugged,
      top10_pct: Number(top10pct.toFixed(2)),
      mint_authority: mintAuthority,
      freeze_authority: freezeAuthority,
      total_lp_providers: totalLPProviders,
      creator: data.creator || null,
      creator_balance: safeNum(data.creatorBalance, null),
    };

    if (rugged) {
      return { pass: false, reason: `Rugcheck: token marked as RUGGED`, data: summary };
    }
    if (score > cfg.maxRugcheckScore) {
      return { pass: false, reason: `Rugcheck: score ${score} > ${cfg.maxRugcheckScore}`, data: summary };
    }
    // Top10 hard filter (use config.screening.maxTop10Pct for consistency)
    const maxTop10 = screeningCfg.maxTop10Pct ?? 60;
    if (top10pct > maxTop10) {
      return { pass: false, reason: `Rugcheck: top10 holders ${top10pct.toFixed(1)}% > ${maxTop10}%`, data: summary };
    }

    return { pass: true, data: summary };
  } catch (e) {
    return { pass: true, skipped: `error: ${e.message?.slice(0, 60)}` };
  }
}

// ─── Layer 3: GMGN.AI ─────────────────────────────────────────────

/**
 * Fetch GMGN holder analysis. Requires GMGN_API_KEY env var (Cloudflare-protected).
 * Endpoint shape may vary by API tier — schema flexible with safeNum() fallbacks.
 *
 * @returns {Promise<{pass:boolean, reason?:string, data?:object}>}
 */
export async function checkGmgn(mint, screeningCfg) {
  const cfg = screeningCfg.multiLayerScreening;
  if (!cfg.gmgnEnabled) return { pass: true, skipped: "disabled" };
  if (!mint) return { pass: true, skipped: "no_mint" };
  if (!process.env.GMGN_API_KEY) return { pass: true, skipped: "no_api_key" };

  try {
    const res = await fetchWithTimeout(`${GMGN_API}/${mint}`, {
      headers: {
        "Authorization": `Bearer ${process.env.GMGN_API_KEY}`,
        "x-api-key":     process.env.GMGN_API_KEY,
        "Accept":        "application/json",
        "User-Agent":    "BlackDelta-LP-Agent/1.0",
      },
    }, cfg.apiTimeoutMs);

    if (!res.ok) return { pass: true, skipped: `http_${res.status}` };
    const json = await res.json();
    // GMGN's shape can be {code, data: {...}} or direct fields — handle both.
    const data = json?.data || json;

    const holderCount       = safeNum(data.holder_count ?? data.holders, 0);
    const bundlersCount     = safeNum(data.bundlers_count ?? data.bundle_count, 0);
    const bundlersPct       = safeNum(data.bundlers_holding_rate ?? data.bundle_pct ?? data.bundlers_pct, 0);
    const top10Pct          = safeNum(data.top10_holders_rate ?? data.top10_pct, 0);
    const phishingCount     = safeNum(data.phishing_holders_count, 0);
    const blueChipPct       = safeNum(data.bluechip_holders_rate ?? data.bluechip_pct, 0);
    const newHoldersCount   = safeNum(data.new_holders_count, null);
    const totalFeesSol      = safeNum(data.total_fees_sol ?? data.total_fees, 0);
    const avgHoldingUsd     = safeNum(data.avg_holding_usd ?? data.average_holding_usd, 0);
    const redFlagCount      = safeNum(data.red_flag_count ?? data.flags?.length, 0);

    const summary = {
      holder_count: holderCount,
      bundlers_count: bundlersCount,
      bundlers_pct: Number((bundlersPct * 100).toFixed(2)),
      top10_pct: Number((top10Pct * 100).toFixed(2)),
      phishing_count: phishingCount,
      bluechip_pct: Number((blueChipPct * 100).toFixed(2)),
      new_holders_count: newHoldersCount,
      total_fees_sol: totalFeesSol,
      avg_holding_usd: avgHoldingUsd,
      red_flag_count: redFlagCount,
    };

    // Apply filter rules sesuai user diagram
    if (holderCount > 0 && bundlersCount > holderCount) {
      return { pass: false, reason: `GMGN: bundlers ${bundlersCount} > holders ${holderCount}`, data: summary };
    }
    if (top10Pct > 0.30) {
      return { pass: false, reason: `GMGN: top10 ${(top10Pct * 100).toFixed(1)}% > 30%`, data: summary };
    }
    if (newHoldersCount != null && newHoldersCount < cfg.gmgnMinNewWallets) {
      return { pass: false, reason: `GMGN: new wallets ${newHoldersCount} < ${cfg.gmgnMinNewWallets}`, data: summary };
    }
    if (blueChipPct > 0 && blueChipPct < cfg.gmgnMinBluechipPct) {
      return { pass: false, reason: `GMGN: blue chip ${(blueChipPct * 100).toFixed(2)}% < ${(cfg.gmgnMinBluechipPct * 100).toFixed(2)}%`, data: summary };
    }
    if (holderCount > 0 && phishingCount / holderCount > cfg.gmgnMaxPhishingPct) {
      return { pass: false, reason: `GMGN: phishing ratio ${(phishingCount / holderCount * 100).toFixed(1)}% > ${(cfg.gmgnMaxPhishingPct * 100)}%`, data: summary };
    }
    if (bundlersPct > cfg.gmgnMaxBundlerPct) {
      return { pass: false, reason: `GMGN: bundlers ${(bundlersPct * 100).toFixed(1)}% > ${(cfg.gmgnMaxBundlerPct * 100)}%`, data: summary };
    }
    if (holderCount > 0 && holderCount < cfg.gmgnMinHolders) {
      return { pass: false, reason: `GMGN: holders ${holderCount} < ${cfg.gmgnMinHolders}`, data: summary };
    }
    if (totalFeesSol > 0 && totalFeesSol < cfg.gmgnMinTotalFeesSol) {
      return { pass: false, reason: `GMGN: total fees ${totalFeesSol.toFixed(1)} SOL < ${cfg.gmgnMinTotalFeesSol}`, data: summary };
    }
    if (redFlagCount > 3) {
      return { pass: false, reason: `GMGN: ${redFlagCount} red flags`, data: summary };
    }

    return { pass: true, data: summary };
  } catch (e) {
    return { pass: true, skipped: `error: ${e.message?.slice(0, 60)}` };
  }
}

// ─── Layer 4: Smart Contract Analysis ─────────────────────────────

/**
 * Smart contract checks derived from Rugcheck data (avoid extra RPC calls).
 * Grace period for fresh tokens (pump.fun bonded etc still has authorities) — skip if
 * token younger than `smartContractGraceAgeHours`.
 *
 * @param {object} rugcheckData — output dari checkRugcheck.data
 * @param {number} tokenAgeHours
 * @param {object} screeningCfg
 */
export function checkSmartContract(rugcheckData, tokenAgeHours, screeningCfg) {
  const cfg = screeningCfg.multiLayerScreening;
  if (!cfg.smartContractCheck) return { pass: true, skipped: "disabled" };
  if (!rugcheckData) return { pass: true, skipped: "no_rugcheck_data" };

  const ageH = safeNum(tokenAgeHours, 99999);
  const grace = safeNum(cfg.smartContractGraceAgeHours, 6);

  // Grace period: pump.fun tokens take time to renounce; tolerate within grace window.
  const inGrace = ageH < grace;

  if (cfg.blockFreezeAuthority && rugcheckData.freeze_authority && !inGrace) {
    return {
      pass: false,
      reason: `SmartContract: freeze authority active (${String(rugcheckData.freeze_authority).slice(0, 12)}…) age ${ageH.toFixed(1)}h > grace ${grace}h`,
      data: { freeze_authority: rugcheckData.freeze_authority, age_hours: ageH },
    };
  }
  if (cfg.blockMintAuthority && rugcheckData.mint_authority && !inGrace) {
    return {
      pass: false,
      reason: `SmartContract: mint authority active (${String(rugcheckData.mint_authority).slice(0, 12)}…) age ${ageH.toFixed(1)}h > grace ${grace}h`,
      data: { mint_authority: rugcheckData.mint_authority, age_hours: ageH },
    };
  }

  return { pass: true, data: { mint_authority: rugcheckData.mint_authority, freeze_authority: rugcheckData.freeze_authority, age_hours: ageH } };
}

// ─── Orchestrator ─────────────────────────────────────────────────

/**
 * Apply all enabled layers to candidates list. Returns separated passing + filtered.
 *
 * @param {Array} candidates — pool candidates (must have `base.mint`, `name`, optional `token_age_hours`)
 * @param {object} screeningCfg — config.screening
 * @returns {Promise<{passing:Array, filtered:Array<{pool, reason, layer}>, stats:object}>}
 */
export async function applyMultiLayerScreening(candidates, screeningCfg) {
  const cfg = screeningCfg.multiLayerScreening;
  if (!cfg?.enabled || !Array.isArray(candidates) || candidates.length === 0) {
    return { passing: candidates || [], filtered: [], stats: { skipped: true } };
  }

  const stats = { dexscreener: { pass: 0, fail: 0, skip: 0 }, rugcheck: { pass: 0, fail: 0, skip: 0 }, gmgn: { pass: 0, fail: 0, skip: 0 }, sc: { pass: 0, fail: 0, skip: 0 } };
  const passing = [];
  const filtered = [];

  // Run all candidates in parallel — each candidate runs 3 API calls in parallel
  const results = await Promise.allSettled(candidates.map(async (p) => {
    const mint = p.base?.mint;
    const ageH = p.token_age_hours;
    const name = p.name;

    // Run DexScreener + Rugcheck + GMGN in parallel
    const [dexRes, rugRes, gmgnRes] = await Promise.allSettled([
      checkDexScreener(mint, ageH, name, screeningCfg),
      checkRugcheck(mint, screeningCfg),
      checkGmgn(mint, screeningCfg),
    ]);

    const dex  = dexRes.status === "fulfilled"  ? dexRes.value  : { pass: true, skipped: "settle_error" };
    const rug  = rugRes.status === "fulfilled"  ? rugRes.value  : { pass: true, skipped: "settle_error" };
    const gmgn = gmgnRes.status === "fulfilled" ? gmgnRes.value : { pass: true, skipped: "settle_error" };

    // Smart contract check is synchronous (uses rugcheck data)
    const sc = checkSmartContract(rug.data, ageH, screeningCfg);

    // Update stats
    for (const [k, r] of [["dexscreener", dex], ["rugcheck", rug], ["gmgn", gmgn], ["sc", sc]]) {
      if (r.skipped) stats[k].skip++;
      else if (r.pass) stats[k].pass++;
      else stats[k].fail++;
    }

    // Attach layer data to candidate (for LLM context + dashboard)
    p.multi_layer = { dexscreener: dex.data || null, rugcheck: rug.data || null, gmgn: gmgn.data || null, smart_contract: sc.data || null };

    // Reject reason — first failing layer wins (priority: SC > Rugcheck > GMGN > DexScreener)
    if (!sc.pass)   return { pool: p, reject: { layer: "smart_contract", reason: sc.reason } };
    if (!rug.pass)  return { pool: p, reject: { layer: "rugcheck", reason: rug.reason } };
    if (!gmgn.pass) return { pool: p, reject: { layer: "gmgn", reason: gmgn.reason } };
    if (!dex.pass)  return { pool: p, reject: { layer: "dexscreener", reason: dex.reason } };

    return { pool: p, reject: null };
  }));

  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    const { pool, reject } = r.value;
    if (reject) {
      filtered.push({ pool, reason: `[${reject.layer}] ${reject.reason}`, layer: reject.layer });
    } else {
      passing.push(pool);
    }
  }

  log("screening", `Multi-layer: ${passing.length} pass / ${filtered.length} filter | layer-stats ${JSON.stringify(stats)}`);
  return { passing, filtered, stats };
}
