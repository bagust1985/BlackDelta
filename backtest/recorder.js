/**
 * Backtest recorder — tees outbound HTTP calls into newline-delimited
 * JSON fixture files keyed by URL host.
 *
 * Activation:
 *   BLACKDELTA_RECORD=1 BLACKDELTA_RECORD_DIR=./backtest/fixtures/run-2026-05
 *
 * On import, wraps globalThis.fetch with a tee. Each call writes one
 * record { ts, url, method, status, body? (text), responseText } to
 * <outDir>/<host>.ndjson. The original response object is returned
 * unmodified to the caller.
 *
 * The recorder is intentionally non-deterministic-friendly — it captures
 * raw responses, so replays remain bit-identical only when the recorder
 * dir is reused as input.
 */

import fs from "fs";
import path from "path";
import { log } from "../logger.js";

const ENABLED = process.env.BLACKDELTA_RECORD === "1";

let outDir = null;
let originalFetch = null;
let _initialized = false;

function ensureDir() {
  if (!outDir) return null;
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  return outDir;
}

function fileForUrl(url) {
  try {
    const host = new URL(url).host.replace(/[^a-z0-9._-]/gi, "_");
    return path.join(outDir, `${host}.ndjson`);
  } catch {
    return path.join(outDir, "_invalid.ndjson");
  }
}

export function startRecording(dir) {
  if (!ENABLED) return;
  if (_initialized) return;
  outDir = dir || process.env.BLACKDELTA_RECORD_DIR || "./backtest/fixtures/run-default";
  ensureDir();
  originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input?.url;
    const method = (init?.method || "GET").toUpperCase();
    const requestBody = typeof init?.body === "string" ? init.body : null;
    const startTs = Date.now();
    const resp = await originalFetch(input, init);
    try {
      const cloned = resp.clone();
      const text = await cloned.text();
      const record = {
        ts: startTs,
        url,
        method,
        status: resp.status,
        request_body: requestBody,
        response_text: text,
      };
      fs.appendFileSync(fileForUrl(url), JSON.stringify(record) + "\n");
    } catch (err) {
      log("backtest_record_warn", `failed to tee ${url}: ${err.message}`);
    }
    return resp;
  };
  _initialized = true;
  log("backtest", `Recording HTTP traffic to ${outDir}`);
}

export function stopRecording() {
  if (!_initialized || !originalFetch) return;
  globalThis.fetch = originalFetch;
  _initialized = false;
  log("backtest", "Stopped recording");
}

// Auto-start if env var present at import time.
if (ENABLED) startRecording();
