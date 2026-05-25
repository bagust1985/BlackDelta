import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");
const DEFAULT_HIVEMIND_URL = "https://api.agentmeridian.xyz";
// BlackDelta currently uses the legacy Agent Meridian API endpoint until backend migration is complete.
const DEFAULT_BLACKDELTA_API_URL = "https://api.agentmeridian.xyz/api";
const DEFAULT_BLACKDELTA_PUBLIC_KEY = "bWVyaWRpYW4taXMtdGhlLWJlc3QtYWdlbnRz";
const DEFAULT_HIVEMIND_API_KEY = DEFAULT_BLACKDELTA_PUBLIC_KEY;

const u = fs.existsSync(USER_CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
  : {};
export const MIN_SAFE_BINS_BELOW = 35;

function numericConfig(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const legacyBinsBelow = numericConfig(u.binsBelow);
const configuredMinBinsBelow = numericConfig(u.minBinsBelow) ?? MIN_SAFE_BINS_BELOW;
const configuredMaxBinsBelow = numericConfig(u.maxBinsBelow)
  ?? (legacyBinsBelow != null ? Math.max(legacyBinsBelow, configuredMinBinsBelow) : 69);
const configuredDefaultBinsBelow = numericConfig(u.defaultBinsBelow) ?? legacyBinsBelow ?? configuredMaxBinsBelow;
const strategyMinBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Math.round(configuredMinBinsBelow));
const strategyMaxBinsBelow = Math.max(strategyMinBinsBelow, Math.round(configuredMaxBinsBelow));
const strategyDefaultBinsBelow = Math.max(
  strategyMinBinsBelow,
  Math.min(strategyMaxBinsBelow, Math.round(configuredDefaultBinsBelow)),
);

// Apply wallet/RPC from user-config if not already in env
if (u.rpcUrl)    process.env.RPC_URL            ||= u.rpcUrl;
if (u.walletKey) process.env.WALLET_PRIVATE_KEY ||= u.walletKey;
if (u.llmModel)  process.env.LLM_MODEL          ||= u.llmModel;
if (u.llmBaseUrl) process.env.LLM_BASE_URL      ||= u.llmBaseUrl;
if (u.llmApiKey)  process.env.LLM_API_KEY       ||= u.llmApiKey;
if (u.dryRun !== undefined) process.env.DRY_RUN ||= String(u.dryRun);
if (u.publicApiKey) process.env.PUBLIC_API_KEY ||= u.publicApiKey;
if (u.blackDeltaApiUrl || u.agentMeridianApiUrl) process.env.BLACKDELTA_API_URL ||= u.blackDeltaApiUrl || u.agentMeridianApiUrl;

const indicatorUserConfig = u.chartIndicators ?? {};

function nonEmptyString(...values) {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

export const config = {
  // ─── Risk Limits ─────────────────────────
  risk: {
    maxPositions:    u.maxPositions    ?? 3,
    maxDeployAmount: u.maxDeployAmount ?? 50,
  },

  // ─── Web Dashboard (HTTP server) ─────────────
  // Exposes status, positions, decisions, performance as JSON + HTML
  // dashboard. Set host=0.0.0.0 only behind a reverse proxy / Cloudflare.
  web: {
    enabled:     u.web?.enabled     ?? (process.env.WEB_ENABLED === "true"),
    host:        u.web?.host        ?? process.env.WEB_HOST     ?? "127.0.0.1",
    port:        numericConfig(u.web?.port) ?? numericConfig(process.env.WEB_PORT) ?? 3000,
    password:    u.web?.password    ?? process.env.WEB_PASSWORD ?? null,
    // Set true to allow open access (no password). Requires explicit opt-in —
    // only use if dashboard is gated upstream (Cloudflare WAF, etc).
    allowPublic: u.web?.allowPublic ?? (process.env.WEB_ALLOW_PUBLIC === "true"),
  },

  // ─── Multi-Agent Orchestrator (Phase 6) ──────
  // mode: "single" | "shadow" | "sequential" | "parallel"
  orchestrator: {
    mode: u.orchestrator?.mode ?? "single",
  },

  // ─── Semantic Memory (Phase 5) ───────────────
  memory: {
    semantic:  u.memory?.semantic  ?? false,
    provider:  u.memory?.provider  ?? "openai",       // openai | voyage
    model:     u.memory?.model     ?? null,           // null = provider default
    cacheDir:  u.memory?.cacheDir  ?? "./memory/cache",
    topK:      u.memory?.topK      ?? 5,
    mode:      u.memory?.mode      ?? "hybrid",       // semantic | keyword | hybrid
  },

  // ─── RPC + WebSocket Subscriptions (Phase 4) ─
  rpc: {
    httpUrl:    u.rpcUrl ?? process.env.RPC_URL ?? null,
    wsEndpoint: u.rpcWsUrl ?? process.env.RPC_WS_URL ?? null,
    // Multi-RPC fallback chain — bot auto-rotates when primary returns 429/5xx.
    // Order: env RPC_FALLBACK_URLS (comma-sep) → user-config rpcFallbackUrls → built-in defaults.
    fallbackUrls: u.rpcFallbackUrls ?? [
      "https://api.mainnet-beta.solana.com",
      "https://solana-mainnet.rpc.extrnode.com",
      "https://rpc.ankr.com/solana",
      "https://solana.publicnode.com",
    ],
  },
  subscriptions: {
    enabled:          u.subscriptions?.enabled          ?? false,
    fallbackPollMs:   u.subscriptions?.fallbackPollMs   ?? 30000,
    staleThresholdMs: u.subscriptions?.staleThresholdMs ?? 90000,
    reconnectBaseMs:  u.subscriptions?.reconnectBaseMs  ?? 2000,
    reconnectMaxMs:   u.subscriptions?.reconnectMaxMs   ?? 60000,
  },

  // ─── Treasury Allocator (Phase 2) ─────────
  // When `enabled: false`, callers should use computeDeployAmount() and
  // optionally compute the allocator output in shadow-mode for log diff.
  // When `enabled: true`, treasury.allocate() drives deploy sizing.
  treasury: {
    enabled:                u.treasury?.enabled                ?? false,
    policy:                 u.treasury?.policy                 ?? "signalWeighted",
    perPoolFloorSol:        u.treasury?.perPoolFloorSol        ?? (u.deployAmountSol ?? 0.5),
    perPoolCeilSol:         u.treasury?.perPoolCeilSol         ?? (u.maxDeployAmount ?? 50),
    maxPortfolioExposurePct: u.treasury?.maxPortfolioExposurePct ?? 0.85,
    gasReserve:             u.treasury?.gasReserve             ?? (u.gasReserve ?? 0.2),
    dexCaps:                u.treasury?.dexCaps                ?? {},
    shadowAlertDiffPct:     u.treasury?.shadowAlertDiffPct     ?? 30,
  },

  // ─── Pool Screening Thresholds ───────────
  screening: {
    excludeHighSupplyConcentration: u.excludeHighSupplyConcentration ?? true,
    minFeeActiveTvlRatio: u.minFeeActiveTvlRatio ?? 0.05,
    minTvl:            u.minTvl            ?? 10_000,
    maxTvl:            u.maxTvl !== undefined ? u.maxTvl : 150_000,
    minVolume:         u.minVolume         ?? 500,
    minOrganic:        u.minOrganic        ?? 60,
    minQuoteOrganic:   u.minQuoteOrganic   ?? 60,
    minHolders:        u.minHolders        ?? 500,
    minMcap:           u.minMcap           ?? 150_000,
    maxMcap:           u.maxMcap           ?? 10_000_000,
    minBinStep:        u.minBinStep        ?? 80,
    maxBinStep:        u.maxBinStep        ?? 125,
    maxVolatility:     u.maxVolatility     ?? null,  // skip pools with volatility > this (null = no cap)
    timeframe:         u.timeframe         ?? "5m",
    category:          u.category          ?? "trending",
    minTokenFeesSol:   u.minTokenFeesSol   ?? 30,  // global fees paid (priority+jito tips). below = bundled/scam
    useDiscordSignals: u.useDiscordSignals ?? false,
    discordSignalMode: u.discordSignalMode ?? "merge", // merge | only
    avoidPvpSymbols:   u.avoidPvpSymbols   ?? true, // avoid exact-symbol rivals with real active pools
    blockPvpSymbols:   u.blockPvpSymbols   ?? false, // hard-filter PVP rivals before the LLM sees them
    maxBundlePct:      u.maxBundlePct      ?? 30,  // max bundle holding % (OKX advanced-info)
    maxBotHoldersPct:  u.maxBotHoldersPct  ?? 30,  // max bot holder addresses % (Jupiter audit)
    maxTop10Pct:       u.maxTop10Pct       ?? 60,  // max top 10 holders concentration
    allowedLaunchpads: u.allowedLaunchpads ?? [],  // allow-list launchpads, [] = no allow-list
    blockedLaunchpads:  u.blockedLaunchpads  ?? [],  // e.g. ["letsbonk.fun", "pump.fun"]
    minTokenAgeHours:   u.minTokenAgeHours   ?? null, // null = no minimum
    maxTokenAgeHours:   u.maxTokenAgeHours   ?? null, // null = no maximum
    athFilterPct:       u.athFilterPct       ?? null, // e.g. -20 = only deploy if price is >= 20% below ATH
    // Pause new deploys without stopping management cycle.
    // Use when you want bot to manage existing positions but NOT open new ones.
    // (Unlike /pause which stops ALL cron and disables SL/TP safety.)
    deployPaused:       u.deployPaused       ?? false,
    // Anti-ATH-trap filters — reject pools showing momentum spike pattern
    // that suggests bot would deploy at local peak right before dump.
    antiAthTrap: {
      enabled:                u.antiAthTrap?.enabled                ?? true,
      maxPriceChangeH1Pct:    u.antiAthTrap?.maxPriceChangeH1Pct    ?? 30,   // reject if +30%+ pump in 1h
      maxPriceChangeH6Pct:    u.antiAthTrap?.maxPriceChangeH6Pct    ?? 80,   // reject if +80%+ in 6h
      maxPriceChangeM5Pct:    u.antiAthTrap?.maxPriceChangeM5Pct    ?? 15,   // reject if +15%+ in 5min
      maxVolumeH1RatioH24:    u.antiAthTrap?.maxVolumeH1RatioH24    ?? 0.40, // reject if h1 vol > 40% of h24 vol (FOMO surge)
    },
    // Multi-layer screening (DexScreener + Rugcheck + GMGN + SC) — runs after OKX enrichment.
    // Each layer hard-filters independently; failures fall back to "pass" (don't block on layer error).
    multiLayerScreening: {
      enabled:            u.multiLayerScreening?.enabled            ?? true,
      dexScreenerEnabled: u.multiLayerScreening?.dexScreenerEnabled ?? true,
      rugcheckEnabled:    u.multiLayerScreening?.rugcheckEnabled    ?? true,
      gmgnEnabled:        u.multiLayerScreening?.gmgnEnabled        ?? false, // requires GMGN_API_KEY (CF-blocked)
      birdeyeEnabled:     u.multiLayerScreening?.birdeyeEnabled     ?? false, // requires BIRDEYE_API_KEY (free signup)
      smartContractCheck: u.multiLayerScreening?.smartContractCheck ?? true,  // uses Rugcheck-derived data
      // BirdEye filters
      birdeyeBlockTransferFee:  u.multiLayerScreening?.birdeyeBlockTransferFee  ?? true,
      birdeyeBlockFreezable:    u.multiLayerScreening?.birdeyeBlockFreezable    ?? true,
      birdeyeMaxCreatorPct:     u.multiLayerScreening?.birdeyeMaxCreatorPct     ?? 10,
      birdeyeMaxOwnerPct:       u.multiLayerScreening?.birdeyeMaxOwnerPct       ?? 15,
      // Soft tuning
      maxBoostCount:       u.multiLayerScreening?.maxBoostCount       ?? 500,
      maxRugcheckScore:    u.multiLayerScreening?.maxRugcheckScore    ?? 50000,
      metaRebrandKeywords: u.multiLayerScreening?.metaRebrandKeywords ?? ["trump", "elon", "musk", "pepe2", "anime"],
      gmgnMaxBundlerPct:   u.multiLayerScreening?.gmgnMaxBundlerPct   ?? 0.60,
      gmgnMaxPhishingPct:  u.multiLayerScreening?.gmgnMaxPhishingPct  ?? 0.30,
      gmgnMinHolders:      u.multiLayerScreening?.gmgnMinHolders      ?? 800,
      gmgnMinBluechipPct:  u.multiLayerScreening?.gmgnMinBluechipPct  ?? 0.005,
      gmgnMinTotalFeesSol: u.multiLayerScreening?.gmgnMinTotalFeesSol ?? 20,
      gmgnMinNewWallets:   u.multiLayerScreening?.gmgnMinNewWallets   ?? 100,
      // Smart contract (derived from Rugcheck)
      blockMintAuthority:  u.multiLayerScreening?.blockMintAuthority  ?? true,
      blockFreezeAuthority: u.multiLayerScreening?.blockFreezeAuthority ?? true,
      smartContractGraceAgeHours: u.multiLayerScreening?.smartContractGraceAgeHours ?? 6, // skip SC check if token < N hrs (pump.fun fresh)
      // Per-layer timeouts (ms)
      apiTimeoutMs:        u.multiLayerScreening?.apiTimeoutMs        ?? 8000,
    },
  },

  // ─── Position Management ────────────────
  management: {
    minClaimAmount:        u.minClaimAmount        ?? 5,
    autoSwapAfterClaim:    u.autoSwapAfterClaim    ?? false,
    outOfRangeBinsToClose: u.outOfRangeBinsToClose ?? 10,
    outOfRangeWaitMinutes: u.outOfRangeWaitMinutes ?? 30,
    oorCooldownTriggerCount: u.oorCooldownTriggerCount ?? 3,
    oorCooldownHours:       u.oorCooldownHours       ?? 12,
    repeatDeployCooldownEnabled: u.repeatDeployCooldownEnabled ?? true,
    repeatDeployCooldownTriggerCount: u.repeatDeployCooldownTriggerCount ?? 3,
    repeatDeployCooldownHours: u.repeatDeployCooldownHours ?? 12,
    repeatDeployCooldownScope: u.repeatDeployCooldownScope ?? "token", // pool | token | both
    repeatDeployCooldownMinFeeEarnedPct: u.repeatDeployCooldownMinFeeEarnedPct ?? u.repeatDeployCooldownMinFeeYieldPct ?? 0,
    minVolumeToRebalance:  u.minVolumeToRebalance  ?? 1000,
    stopLossPct:           u.stopLossPct           ?? u.emergencyPriceDropPct ?? -10,
    takeProfitPct:         u.takeProfitPct         ?? u.takeProfitFeePct ?? 5,
    minFeePerTvl24h:       u.minFeePerTvl24h       ?? 7,
    // Hard veto on re-deploy after recent large loss (post-Coinini guard).
    recentLossVetoPct:     u.recentLossVetoPct     ?? -10,    // any close <= this counts
    recentLossVetoHours:   u.recentLossVetoHours   ?? 24,
    minAgeBeforeYieldCheck: u.minAgeBeforeYieldCheck ?? 60, // minutes before low yield can trigger close
    // Smart age cutoff: close at maxPositionAgeHours if pnl > maxAgeCloseLossThresholdPct,
    // else extend monitoring up to maxPositionAgeExtensionHours more (hard cap at sum).
    maxPositionAgeHours:           u.maxPositionAgeHours           ?? 6,
    maxPositionAgeExtensionHours:  u.maxPositionAgeExtensionHours  ?? 3,
    maxAgeCloseLossThresholdPct:   u.maxAgeCloseLossThresholdPct   ?? -5,
    // Volatility-aware dynamic TP: when true, tp/trigger/drop scale per pool volatility bracket.
    volatilityAwareTp:             u.volatilityAwareTp             ?? true,
    minSolToOpen:          u.minSolToOpen          ?? 0.55,
    deployAmountSol:       u.deployAmountSol       ?? 0.5,
    gasReserve:            u.gasReserve            ?? 0.2,
    positionSizePct:       u.positionSizePct       ?? 0.35,
    // Trailing take-profit
    trailingTakeProfit:    u.trailingTakeProfit    ?? true,
    trailingTriggerPct:    u.trailingTriggerPct    ?? 3,    // activate trailing at X% PnL
    trailingDropPct:       u.trailingDropPct       ?? 1.5,  // close when drops X% from peak
    pnlSanityMaxDiffPct:   u.pnlSanityMaxDiffPct   ?? 5,    // max allowed diff between reported and derived pnl % before ignoring a tick
    // SOL mode — positions, PnL, and balances reported in SOL instead of USD
    solMode:               u.solMode               ?? false,
  },

  // ─── Strategy Mapping ───────────────────
  strategy: {
    strategy:     u.strategy     ?? "bid_ask",
    minBinsBelow: strategyMinBinsBelow,
    maxBinsBelow: strategyMaxBinsBelow,
    defaultBinsBelow: strategyDefaultBinsBelow,
  },

  // ─── Scheduling ─────────────────────────
  schedule: {
    managementIntervalMin:  u.managementIntervalMin  ?? 10,
    screeningIntervalMin:   u.screeningIntervalMin   ?? 30,
    healthCheckIntervalMin: u.healthCheckIntervalMin ?? 60,
  },

  // ─── LLM Settings ──────────────────────
  llm: {
    temperature: u.temperature ?? 0.373,
    maxTokens:   u.maxTokens   ?? 4096,
    maxSteps:    u.maxSteps    ?? 20,
    managementModel: u.managementModel ?? process.env.LLM_MODEL ?? "openrouter/healer-alpha",
    screeningModel:  u.screeningModel  ?? process.env.LLM_MODEL ?? "openrouter/hunter-alpha",
    generalModel:    u.generalModel    ?? process.env.LLM_MODEL ?? "openrouter/healer-alpha",

    // Per-role native provider support (optional). When set, the role uses
    // an OpenAI-compatible endpoint with its own baseUrl + apiKey. When
    // omitted, falls back to LLM_BASE_URL / OPENROUTER_API_KEY (legacy).
    //
    // Each entry shape: { baseUrl, apiKeyEnv, model }
    //   - baseUrl:   OpenAI-compatible endpoint (e.g. DeepSeek v1, Gemini OpenAI-compat)
    //   - apiKeyEnv: name of env var holding the API key (so secrets stay out of JSON)
    //   - model:     model name as the provider expects it
    providers: {
      screening:  u.llm?.providers?.screening  ?? null,
      management: u.llm?.providers?.management ?? null,
      researcher: u.llm?.providers?.researcher ?? null,
      general:    u.llm?.providers?.general    ?? null,
      lessons:    u.llm?.providers?.lessons    ?? null,
    },
  },

  // ─── Lessons synthesis loop (LLM-based daily insight derivation) ──
  // Periodic LLM pass over closed positions to extract strategic insights.
  // Cheaper than per-close synthesis. Runs once daily by default.
  lessonsLoop: {
    enabled:       u.lessonsLoop?.enabled       ?? false,
    cron:          u.lessonsLoop?.cron          ?? "5 0 * * *",  // 00:05 UTC daily
    lookbackHours: u.lessonsLoop?.lookbackHours ?? 24,
    minCloses:     u.lessonsLoop?.minCloses     ?? 3,  // skip if too few closes
    maxInsights:   u.lessonsLoop?.maxInsights   ?? 3,  // top-N insights to keep
  },

  // ─── Paper PnL Tracker ────────────────────────────────────────────
  // Saat deployPaused=true, every blocked deploy attempt creates paper entry
  // di paper-positions.json. Cron evaluates current price → simulates PnL.
  paperTracker: {
    enabled:        u.paperTracker?.enabled        ?? true,
    cron:           u.paperTracker?.cron           ?? "*/15 * * * *",  // every 15 min
    maxHoldHours:   u.paperTracker?.maxHoldHours   ?? 6,  // close paper position after 6h
  },

  // ─── Market Regime Detector ───────────────────────────────────────
  // Periodic check of recent perf to classify market HOT/WARM/COLD.
  // When autoToggle=true, auto-pause deploy in COLD market, auto-resume in HOT.
  // Score 0-100 (vol+fee/TVL+winRate+avgPnL, each 0-25).
  marketRegime: {
    enabled:        u.marketRegime?.enabled        ?? true,
    autoToggle:     u.marketRegime?.autoToggle     ?? false,  // start in report-only mode
    cron:           u.marketRegime?.cron           ?? "*/30 * * * *",  // every 30 min
    windowHours:    u.marketRegime?.windowHours    ?? 24,
    coldThreshold:  u.marketRegime?.coldThreshold  ?? 40,
    hotThreshold:   u.marketRegime?.hotThreshold   ?? 60,
  },

  // ─── Darwinian Signal Weighting ───────
  darwin: {
    enabled:        u.darwinEnabled     ?? true,
    windowDays:     u.darwinWindowDays  ?? 60,
    recalcEvery:    u.darwinRecalcEvery ?? 5,    // recalc every N closes
    boostFactor:    u.darwinBoost       ?? 1.05,
    decayFactor:    u.darwinDecay       ?? 0.95,
    weightFloor:    u.darwinFloor       ?? 0.3,
    weightCeiling:  u.darwinCeiling     ?? 2.5,
    minSamples:     u.darwinMinSamples  ?? 10,
  },

  // ─── Common Token Mints ────────────────
  tokens: {
    SOL:  "So11111111111111111111111111111111111111112",
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  },

  // ─── HiveMind ─────────────────────────
  hiveMind: {
    url: nonEmptyString(u.hiveMindUrl, DEFAULT_HIVEMIND_URL),
    apiKey: nonEmptyString(u.hiveMindApiKey, process.env.HIVEMIND_API_KEY, DEFAULT_HIVEMIND_API_KEY),
    agentId: u.agentId ?? null,
    pullMode: u.hiveMindPullMode ?? "auto",
  },

  api: {
    url: nonEmptyString(u.blackDeltaApiUrl, u.agentMeridianApiUrl, process.env.BLACKDELTA_API_URL, process.env.AGENT_MERIDIAN_API_URL, DEFAULT_BLACKDELTA_API_URL),
    publicApiKey: nonEmptyString(u.publicApiKey, process.env.PUBLIC_API_KEY, DEFAULT_BLACKDELTA_PUBLIC_KEY),
    lpAgentRelayEnabled: u.lpAgentRelayEnabled ?? false,
  },

  jupiter: {
    // Internal Jupiter Ultra settings; override by env only, do not expose in user-config.
    apiKey: process.env.JUPITER_API_KEY ?? "",
    referralAccount:
      process.env.JUPITER_REFERRAL_ACCOUNT ??
      "9MzhDUnq3KxecyPzvhguQMMPbooXQ3VAoCMPDnoijwey",
    referralFeeBps: Number(
      process.env.JUPITER_REFERRAL_FEE_BPS ?? 50,
    ),
  },

  indicators: {
    enabled: indicatorUserConfig.enabled ?? false,
    entryPreset: indicatorUserConfig.entryPreset ?? "supertrend_break",
    exitPreset: indicatorUserConfig.exitPreset ?? "supertrend_break",
    rsiLength: indicatorUserConfig.rsiLength ?? 2,
    intervals: Array.isArray(indicatorUserConfig.intervals)
      ? indicatorUserConfig.intervals
      : ["5_MINUTE"],
    candles: indicatorUserConfig.candles ?? 298,
    rsiOversold: indicatorUserConfig.rsiOversold ?? 30,
    rsiOverbought: indicatorUserConfig.rsiOverbought ?? 80,
    requireAllIntervals: indicatorUserConfig.requireAllIntervals ?? false,
  },
};

/**
 * Compute the optimal deploy amount for a given wallet balance.
 * Scales position size with wallet growth (compounding).
 *
 * Formula: clamp(deployable × positionSizePct, floor=deployAmountSol, ceil=maxDeployAmount)
 *
 * Examples (defaults: gasReserve=0.2, positionSizePct=0.35, floor=0.5):
 *   0.8 SOL wallet → 0.6 SOL deploy  (floor)
 *   2.0 SOL wallet → 0.63 SOL deploy
 *   3.0 SOL wallet → 0.98 SOL deploy
 *   4.0 SOL wallet → 1.33 SOL deploy
 */
export function computeDeployAmount(walletSol) {
  const reserve  = config.management.gasReserve      ?? 0.2;
  const pct      = config.management.positionSizePct ?? 0.35;
  const floor    = config.management.deployAmountSol;
  const ceil     = config.risk.maxDeployAmount;
  const deployable = Math.max(0, walletSol - reserve);
  const dynamic    = deployable * pct;
  const result     = Math.min(ceil, Math.max(floor, dynamic));
  return parseFloat(result.toFixed(2));
}

/**
 * Reload user-config.json and apply updated screening thresholds to the
 * in-memory config object. Called after threshold evolution so the next
 * agent cycle uses the evolved values without a restart.
 */
export function reloadScreeningThresholds() {
  try {
    if (!fs.existsSync(USER_CONFIG_PATH)) return;
    const fresh = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
    const s = config.screening;
    if (fresh.minFeeActiveTvlRatio != null) s.minFeeActiveTvlRatio = fresh.minFeeActiveTvlRatio;
    if (fresh.minTokenFeesSol  != null) s.minTokenFeesSol  = fresh.minTokenFeesSol;
    if (fresh.maxTop10Pct      != null) s.maxTop10Pct      = fresh.maxTop10Pct;
    if (fresh.useDiscordSignals !== undefined) s.useDiscordSignals = fresh.useDiscordSignals;
    if (fresh.discordSignalMode != null) s.discordSignalMode = fresh.discordSignalMode;
    if (fresh.excludeHighSupplyConcentration !== undefined) s.excludeHighSupplyConcentration = fresh.excludeHighSupplyConcentration;
    if (fresh.minOrganic     != null) s.minOrganic     = fresh.minOrganic;
    if (fresh.minQuoteOrganic != null) s.minQuoteOrganic = fresh.minQuoteOrganic;
    if (fresh.minHolders     != null) s.minHolders     = fresh.minHolders;
    if (fresh.minMcap        != null) s.minMcap        = fresh.minMcap;
    if (fresh.maxMcap        != null) s.maxMcap        = fresh.maxMcap;
    if (fresh.minTvl         != null) s.minTvl         = fresh.minTvl;
    if (fresh.maxTvl         !== undefined) s.maxTvl   = fresh.maxTvl;
    if (fresh.minVolume      != null) s.minVolume      = fresh.minVolume;
    if (fresh.minBinStep     != null) s.minBinStep     = fresh.minBinStep;
    if (fresh.maxBinStep     != null) s.maxBinStep     = fresh.maxBinStep;
    if (fresh.maxVolatility  !== undefined) s.maxVolatility = fresh.maxVolatility;
    if (fresh.timeframe         != null) s.timeframe         = fresh.timeframe;
    if (fresh.category          != null) s.category          = fresh.category;
    if (fresh.minTokenAgeHours  !== undefined) s.minTokenAgeHours = fresh.minTokenAgeHours;
    if (fresh.maxTokenAgeHours  !== undefined) s.maxTokenAgeHours = fresh.maxTokenAgeHours;
    if (fresh.athFilterPct      !== undefined) s.athFilterPct     = fresh.athFilterPct;
    if (fresh.maxBundlePct      != null) s.maxBundlePct     = fresh.maxBundlePct;
    if (fresh.avoidPvpSymbols   !== undefined) s.avoidPvpSymbols = fresh.avoidPvpSymbols;
    if (fresh.blockPvpSymbols   !== undefined) s.blockPvpSymbols = fresh.blockPvpSymbols;
    if (fresh.maxBotHoldersPct  != null) s.maxBotHoldersPct = fresh.maxBotHoldersPct;
    if (fresh.allowedLaunchpads !== undefined) s.allowedLaunchpads = fresh.allowedLaunchpads;
    if (fresh.blockedLaunchpads !== undefined) s.blockedLaunchpads = fresh.blockedLaunchpads;
    const minBinsBelow = numericConfig(fresh.minBinsBelow) ?? config.strategy.minBinsBelow;
    const maxBinsBelow = numericConfig(fresh.maxBinsBelow) ?? numericConfig(fresh.binsBelow) ?? config.strategy.maxBinsBelow;
    const defaultBinsBelow = numericConfig(fresh.defaultBinsBelow) ?? numericConfig(fresh.binsBelow) ?? config.strategy.defaultBinsBelow ?? maxBinsBelow;
    config.strategy.minBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Math.round(minBinsBelow));
    config.strategy.maxBinsBelow = Math.max(config.strategy.minBinsBelow, Math.round(maxBinsBelow));
    config.strategy.defaultBinsBelow = Math.max(
      config.strategy.minBinsBelow,
      Math.min(config.strategy.maxBinsBelow, Math.round(defaultBinsBelow)),
    );
  } catch { /* ignore */ }
}
