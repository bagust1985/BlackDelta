import {
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
  Keypair,
} from "@solana/web3.js";
import bs58 from "bs58";
import { log } from "../logger.js";
import { config } from "../config.js";

let _connection = null;
let _wallet = null;

// Multi-RPC fallback chain. Try primary (env RPC_URL or user-config rpcUrl), then fallbacks.
// Set via config.rpc.fallbackUrls = ["url1", "url2"] OR env RPC_FALLBACK_URLS (comma-sep).
function getRpcChain() {
  const primary = process.env.RPC_URL || config.rpc?.httpUrl || "https://api.mainnet-beta.solana.com";
  const fallbacks = (process.env.RPC_FALLBACK_URLS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const configFallbacks = Array.isArray(config.rpc?.fallbackUrls) ? config.rpc.fallbackUrls : [];
  // Default free public RPCs (battle-tested, free, no key needed)
  const defaults = [
    "https://api.mainnet-beta.solana.com",
    "https://solana-mainnet.rpc.extrnode.com",
    "https://rpc.ankr.com/solana",
    "https://solana.publicnode.com",
  ];
  // Dedupe + remove primary from fallback list
  const seen = new Set([primary]);
  const chain = [primary];
  for (const url of [...fallbacks, ...configFallbacks, ...defaults]) {
    if (url && !seen.has(url)) {
      seen.add(url);
      chain.push(url);
    }
  }
  return chain;
}

// Round-robin RPC index — rotates on 429/5xx to spread load.
let _rpcIndex = 0;
let _rpcChain = null;

function getConnection() {
  if (!_connection) {
    _rpcChain = getRpcChain();
    _connection = new Connection(_rpcChain[_rpcIndex], "confirmed");
    log("rpc", `RPC primary: ${_rpcChain[_rpcIndex].slice(0, 50)}... (${_rpcChain.length} fallbacks ready)`);
  }
  return _connection;
}

/**
 * Rotate to next RPC in chain. Call when current connection returns 429/5xx.
 * Cycles back to primary after exhausting fallbacks.
 */
export function rotateRpc(reason = "manual") {
  if (!_rpcChain) _rpcChain = getRpcChain();
  _rpcIndex = (_rpcIndex + 1) % _rpcChain.length;
  _connection = new Connection(_rpcChain[_rpcIndex], "confirmed");
  log("rpc", `Rotated RPC to: ${_rpcChain[_rpcIndex].slice(0, 50)}... (reason: ${reason})`);
  return _connection;
}

function getWallet() {
  if (!_wallet) {
    if (!process.env.WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY not set");
    _wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
  }
  return _wallet;
}

const JUPITER_PRICE_API = "https://api.jup.ag/price/v3";
const JUPITER_SWAP_V2_API = "https://api.jup.ag/swap/v2";

function getJupiterApiKey() {
  return config.jupiter.apiKey || process.env.JUPITER_API_KEY || "";
}

function getJupiterReferralParams() {
  const referralAccount = String(config.jupiter.referralAccount || "").trim();
  const referralFee = Number(config.jupiter.referralFeeBps || 0);
  if (!referralAccount || !Number.isFinite(referralFee) || referralFee <= 0) {
    return null;
  }
  if (referralFee < 50 || referralFee > 255) {
    log("swap_warn", `Ignoring Jupiter referral fee ${referralFee}; Ultra requires 50-255 bps`);
    return null;
  }
  try {
    new PublicKey(referralAccount);
  } catch {
    log("swap_warn", "Ignoring invalid Jupiter referral account");
    return null;
  }
  return { referralAccount, referralFee: Math.round(referralFee) };
}

/**
 * Get current wallet balances: SOL, USDC, and all SPL tokens using Helius Wallet API.
 * Returns USD-denominated values provided by Helius.
 */
// ─── In-memory cache + dedupe ──────────────────────────────────
// Helius free tier + public RPCs rate-limited; aggressive cache mitigates.
// Bumped from 20s → 60s after observing Helius 429 spam.
const BALANCE_CACHE_TTL_MS = 60_000;
let _balanceCache = null;
let _balanceCacheAt = 0;
let _balanceInflight = null;

/**
 * Native Solana RPC fallback with auto-rotation across fallback chain.
 * Tries up to 3 RPC endpoints before giving up.
 */
async function fetchBalancesViaRpc(walletAddress) {
  const maxAttempts = 3;
  let lastError = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const conn = getConnection();
      const pubkey = new PublicKey(walletAddress);

      const lamports = await conn.getBalance(pubkey, "confirmed");
      const sol = lamports / LAMPORTS_PER_SOL;

      const tokenAccounts = await conn.getParsedTokenAccountsByOwner(pubkey, {
        programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      });
      const tokens = tokenAccounts.value
        .map((acc) => {
          const info = acc.account.data.parsed?.info;
          const amount = Number(info?.tokenAmount?.uiAmount || 0);
          if (amount <= 0) return null;
          return {
            mint: info.mint,
            symbol: info.mint.slice(0, 8),
            balance: amount,
            usd: null,
          };
        })
        .filter(Boolean);

      return {
        wallet: walletAddress,
        sol: Math.round(sol * 1e6) / 1e6,
        sol_price: null,
        sol_usd: null,
        usdc: tokens.find((t) => t.mint === config.tokens.USDC)?.balance || 0,
        tokens,
        total_usd: null,
        source: `rpc_fallback (attempt ${attempt + 1})`,
      };
    } catch (e) {
      lastError = e;
      const msg = String(e?.message || "");
      const isRateLimited = msg.includes("429") || msg.includes("max usage") || msg.includes("Too Many Requests");
      const isServerErr   = msg.includes("503") || msg.includes("502") || msg.includes("500");
      if ((isRateLimited || isServerErr) && attempt < maxAttempts - 1) {
        rotateRpc(`429/5xx on attempt ${attempt + 1}`);
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      break;
    }
  }

  return {
    wallet: walletAddress,
    sol: 0, sol_price: 0, sol_usd: 0, usdc: 0, tokens: [], total_usd: 0,
    error: `RPC fallback failed after ${maxAttempts} attempts: ${lastError?.message?.slice(0, 100)}`,
    source: "rpc_fallback_exhausted",
  };
}

/**
 * Get current wallet balances. Helius first (with pricing), fallback to
 * native RPC when Helius rate-limited or unavailable. Cached for 20s to
 * avoid burning quota during burst calls (dashboard + cron).
 *
 * @param {object} [opts]
 * @param {boolean} [opts.force=false] — bypass cache
 */
export async function getWalletBalances({ force = false } = {}) {
  let walletAddress;
  try {
    walletAddress = getWallet().publicKey.toString();
  } catch {
    return { wallet: null, sol: 0, sol_price: 0, sol_usd: 0, usdc: 0, tokens: [], total_usd: 0, error: "Wallet not configured" };
  }

  // ── Cache hit ────────────────────────────────────────────────
  if (!force && _balanceCache && Date.now() - _balanceCacheAt < BALANCE_CACHE_TTL_MS) {
    return _balanceCache;
  }
  // ── Dedupe concurrent calls ──────────────────────────────────
  if (_balanceInflight) return _balanceInflight;

  _balanceInflight = (async () => {
    const HELIUS_KEY = process.env.HELIUS_API_KEY;

    // ── Path A: Helius (preferred — includes USD pricing) ──────
    if (HELIUS_KEY) {
      try {
        const url = `https://api.helius.xyz/v1/wallet/${walletAddress}/balances?api-key=${HELIUS_KEY}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });

        if (res.ok) {
          const data = await res.json();
          const balances = data.balances || [];

          const solEntry  = balances.find((b) => b.mint === config.tokens.SOL || b.symbol === "SOL");
          const usdcEntry = balances.find((b) => b.mint === config.tokens.USDC || b.symbol === "USDC");

          const result = {
            wallet: walletAddress,
            sol:       Math.round((solEntry?.balance || 0) * 1e6) / 1e6,
            sol_price: Math.round((solEntry?.pricePerToken || 0) * 100) / 100,
            sol_usd:   Math.round((solEntry?.usdValue || 0) * 100) / 100,
            usdc:      Math.round((usdcEntry?.balance || 0) * 100) / 100,
            tokens: balances.map((b) => ({
              mint: b.mint,
              symbol: b.symbol || b.mint.slice(0, 8),
              balance: b.balance,
              usd: b.usdValue ? Math.round(b.usdValue * 100) / 100 : null,
            })),
            total_usd: Math.round((data.totalUsdValue || 0) * 100) / 100,
            source: "helius",
          };
          _balanceCache = result;
          _balanceCacheAt = Date.now();
          return result;
        }

        // 429/5xx → fall through to RPC fallback (log warn, not error)
        log("wallet_warn", `Helius ${res.status} ${res.statusText} — falling back to RPC native`);
      } catch (e) {
        log("wallet_warn", `Helius failed (${e.message?.slice(0, 60)}) — falling back to RPC native`);
      }
    }

    // ── Path B: Solana RPC native (SOL + token list, no pricing) ─
    const fallback = await fetchBalancesViaRpc(walletAddress);
    _balanceCache = fallback;
    _balanceCacheAt = Date.now();
    return fallback;
  })();

  try {
    return await _balanceInflight;
  } finally {
    _balanceInflight = null;
  }
}

/**
 * Swap tokens via Jupiter Swap API V2 (order → sign → execute).
 */
const SOL_MINT = "So11111111111111111111111111111111111111112";

// Normalize any SOL-like address to the correct wrapped SOL mint
export function normalizeMint(mint) {
  if (!mint) return mint;
  const SOL_MINT = "So11111111111111111111111111111111111111112";
  if (
    mint === "SOL" || 
    mint === "native" || 
    /^So1+$/.test(mint) || 
    (mint.length >= 32 && mint.length <= 44 && mint.startsWith("So1") && mint !== SOL_MINT)
  ) {
    return SOL_MINT;
  }
  return mint;
}

export async function swapToken({
  input_mint,
  output_mint,
  amount,
}) {
  input_mint  = normalizeMint(input_mint);
  output_mint = normalizeMint(output_mint);

  if (process.env.DRY_RUN === "true") {
    return {
      dry_run: true,
      would_swap: { input_mint, output_mint, amount },
      message: "DRY RUN — no transaction sent",
    };
  }

  try {
    log("swap", `${amount} of ${input_mint} → ${output_mint}`);
    const wallet = getWallet();
    const connection = getConnection();

    // ─── Convert to smallest unit ──────────────────────────────
    let decimals = 9; // SOL default
    if (input_mint !== config.tokens.SOL) {
      const mintInfo = await connection.getParsedAccountInfo(new PublicKey(input_mint));
      decimals = mintInfo.value?.data?.parsed?.info?.decimals ?? 9;
    }
    const amountStr = Math.floor(amount * Math.pow(10, decimals)).toString();

    // ─── Get Swap V2 order (unsigned tx + requestId) ───────────
    const search = new URLSearchParams({
      inputMint: input_mint,
      outputMint: output_mint,
      amount: amountStr,
      taker: wallet.publicKey.toString(),
    });
    const referralParams = getJupiterReferralParams();
    if (referralParams) {
      search.set("referralAccount", referralParams.referralAccount);
      search.set("referralFee", String(referralParams.referralFee));
    }
    const orderUrl = `${JUPITER_SWAP_V2_API}/order?${search.toString()}`;
    const jupiterApiKey = getJupiterApiKey();

    const orderRes = await fetch(orderUrl, {
      headers: jupiterApiKey ? { "x-api-key": jupiterApiKey } : {},
    });
    if (!orderRes.ok) {
      const body = await orderRes.text();
      throw new Error(`Swap V2 order failed: ${orderRes.status} ${body}`);
    }

    const order = await orderRes.json();
    if (order.errorCode || order.errorMessage) {
      throw new Error(`Swap V2 order error: ${order.errorMessage || order.errorCode}`);
    }

    const { transaction: unsignedTx, requestId } = order;

    // ─── Deserialize and sign ─────────────────────────────────
    const tx = VersionedTransaction.deserialize(Buffer.from(unsignedTx, "base64"));
    tx.sign([wallet]);
    const signedTx = Buffer.from(tx.serialize()).toString("base64");

    // ─── Execute ───────────────────────────────────────────────
    const execRes = await fetch(`${JUPITER_SWAP_V2_API}/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(jupiterApiKey ? { "x-api-key": jupiterApiKey } : {}),
      },
      body: JSON.stringify({ signedTransaction: signedTx, requestId }),
    });
    if (!execRes.ok) {
      throw new Error(`Swap V2 execute failed: ${execRes.status} ${await execRes.text()}`);
    }

    const result = await execRes.json();
    if (result.status === "Failed") {
      throw new Error(`Swap failed on-chain: code=${result.code}`);
    }

    log("swap", `SUCCESS tx: ${result.signature}`);
    if (referralParams && order.feeBps !== referralParams.referralFee) {
      log(
        "swap_warn",
        `Jupiter referral fee requested ${referralParams.referralFee} bps but order applied ${order.feeBps ?? "unknown"} bps`,
      );
    }

    return {
      success: true,
      tx: result.signature,
      input_mint,
      output_mint,
      amount_in: result.inputAmountResult,
      amount_out: result.outputAmountResult,
      referral_account: referralParams?.referralAccount || null,
      referral_fee_bps_requested: referralParams?.referralFee || 0,
      fee_bps_applied: order.feeBps ?? null,
      fee_mint: order.feeMint ?? null,
    };
  } catch (error) {
    log("swap_error", error.message);
    return { success: false, error: error.message };
  }
}
