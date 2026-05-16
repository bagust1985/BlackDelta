/**
 * Semantic memory embedder.
 *
 * Calls the configured embedding provider (OpenAI or Voyage) over HTTPS.
 * Returns a Float32Array per input string.
 *
 * Provider selection: config.memory.provider = "openai" | "voyage"
 * API keys: OPENAI_API_KEY or VOYAGE_API_KEY env vars.
 *
 * The embedder caches by content hash to `memory/cache/<hash>.bin` to
 * avoid re-paying for unchanged lessons. Cache files are raw Float32
 * little-endian buffers.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { config } from "../config.js";
import { log } from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const DEFAULT_CACHE_DIR = path.join(__dirname, "cache");

const PROVIDERS = {
  openai: {
    url: "https://api.openai.com/v1/embeddings",
    defaultModel: "text-embedding-3-small",
    dims: 1536,
    keyEnv: "OPENAI_API_KEY",
    headers: (key) => ({
      "authorization": `Bearer ${key}`,
      "content-type": "application/json",
    }),
    body: (model, input) => JSON.stringify({ model, input }),
    parse: (json) => json.data?.map((d) => d.embedding) || [],
  },
  voyage: {
    url: "https://api.voyageai.com/v1/embeddings",
    defaultModel: "voyage-3",
    dims: 1024,
    keyEnv: "VOYAGE_API_KEY",
    headers: (key) => ({
      "authorization": `Bearer ${key}`,
      "content-type": "application/json",
    }),
    body: (model, input) => JSON.stringify({ model, input }),
    parse: (json) => json.data?.map((d) => d.embedding) || [],
  },
};

function cfg() {
  return config?.memory || {};
}

function getProvider() {
  return PROVIDERS[cfg().provider] || PROVIDERS.openai;
}

function cacheDir() {
  const configured = cfg().cacheDir;
  let d;
  if (!configured) {
    d = DEFAULT_CACHE_DIR;
  } else if (path.isAbsolute(configured)) {
    d = configured;
  } else {
    // Resolve relative paths against the project root so the cache lives
    // alongside the codebase regardless of where PM2 spawned us.
    d = path.resolve(PROJECT_ROOT, configured);
  }
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}

function hashKey(provider, model, text) {
  return crypto
    .createHash("sha256")
    .update(`${provider}|${model}|${text}`)
    .digest("hex");
}

function cachePath(key) {
  return path.join(cacheDir(), `${key}.bin`);
}

function readCache(key) {
  const p = cachePath(key);
  if (!fs.existsSync(p)) return null;
  try {
    const buf = fs.readFileSync(p);
    return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  } catch {
    return null;
  }
}

function writeCache(key, vec) {
  try {
    fs.writeFileSync(cachePath(key), Buffer.from(vec.buffer));
  } catch (err) {
    log("memory_cache_warn", `cache write failed: ${err.message}`);
  }
}

/**
 * Embed a batch of strings. Returns Promise<Float32Array[]>.
 * Hits cache for unchanged inputs. Provider errors propagate.
 */
export async function embedBatch(texts) {
  if (!texts || !texts.length) return [];
  const provider = getProvider();
  const providerName = cfg().provider || "openai";
  const model = cfg().model || provider.defaultModel;
  const key = process.env[provider.keyEnv];

  // Build cache layer first.
  const out = new Array(texts.length).fill(null);
  const missIdx = [];
  const missTexts = [];
  for (let i = 0; i < texts.length; i++) {
    const k = hashKey(providerName, model, texts[i]);
    const cached = readCache(k);
    if (cached) {
      out[i] = cached;
    } else {
      missIdx.push(i);
      missTexts.push(texts[i]);
    }
  }
  if (!missTexts.length) return out;

  if (!key) {
    throw new Error(`Embedding provider ${providerName} requires ${provider.keyEnv}`);
  }

  const resp = await fetch(provider.url, {
    method: "POST",
    headers: provider.headers(key),
    body: provider.body(model, missTexts),
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`Embedding API ${resp.status}: ${txt.slice(0, 200)}`);
  }
  const json = await resp.json();
  const vectors = provider.parse(json);
  if (vectors.length !== missTexts.length) {
    throw new Error(`Embedding API returned ${vectors.length} vectors for ${missTexts.length} inputs`);
  }
  for (let j = 0; j < vectors.length; j++) {
    const arr = Float32Array.from(vectors[j]);
    const i = missIdx[j];
    const k = hashKey(providerName, model, texts[i]);
    writeCache(k, arr);
    out[i] = arr;
  }
  return out;
}

/**
 * Embed a single string. Convenience wrapper.
 */
export async function embed(text) {
  const [vec] = await embedBatch([text]);
  return vec;
}

export function providerInfo() {
  const provider = getProvider();
  return {
    name: cfg().provider || "openai",
    model: cfg().model || provider.defaultModel,
    dims: provider.dims,
    keyEnv: provider.keyEnv,
    hasKey: Boolean(process.env[provider.keyEnv]),
  };
}
