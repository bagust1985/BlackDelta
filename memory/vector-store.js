/**
 * Flat in-memory cosine-similarity vector store.
 *
 * Brute-force is fine for the BlackDelta lesson scale (hundreds, not
 * millions). The index persists to `memory/index.json` so restarts
 * don't trigger a re-embed.
 *
 * Persisted shape:
 *   {
 *     dims: 1536,
 *     entries: [{ id, vec: number[], meta: { ... } }, ...],
 *   }
 *
 * Note: vectors persist as plain number[] to keep the JSON
 * human-greppable; in-memory they upgrade to Float32Array for speed.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_INDEX_FILE = path.join(__dirname, "index.json");

class VectorStore {
  constructor({ path: indexPath = DEFAULT_INDEX_FILE } = {}) {
    this.indexPath = indexPath;
    this.dims = null;
    this.entries = []; // { id, vec: Float32Array, meta }
    this._byId = new Map();
    this._loaded = false;
  }

  load() {
    if (this._loaded) return;
    this._loaded = true;
    if (!fs.existsSync(this.indexPath)) return;
    try {
      const json = JSON.parse(fs.readFileSync(this.indexPath, "utf8"));
      this.dims = json.dims || null;
      this.entries = (json.entries || []).map((e) => ({
        id: e.id,
        vec: Float32Array.from(e.vec),
        meta: e.meta || {},
      }));
      for (const e of this.entries) this._byId.set(e.id, e);
    } catch (err) {
      log("memory_load_warn", `failed to load ${this.indexPath}: ${err.message}`);
    }
  }

  save() {
    const out = {
      dims: this.dims,
      entries: this.entries.map((e) => ({
        id: e.id,
        vec: Array.from(e.vec),
        meta: e.meta,
      })),
    };
    fs.writeFileSync(this.indexPath, JSON.stringify(out));
  }

  /**
   * Insert or replace by id.
   */
  add(id, vec, meta = {}) {
    if (!this._loaded) this.load();
    const v = vec instanceof Float32Array ? vec : Float32Array.from(vec);
    if (this.dims == null) this.dims = v.length;
    if (this.dims !== v.length) {
      throw new Error(`vector dim mismatch: store=${this.dims} got=${v.length}`);
    }
    const existing = this._byId.get(id);
    if (existing) {
      existing.vec = v;
      existing.meta = meta;
      return;
    }
    const entry = { id, vec: v, meta };
    this.entries.push(entry);
    this._byId.set(id, entry);
  }

  has(id) {
    if (!this._loaded) this.load();
    return this._byId.has(id);
  }

  remove(id) {
    if (!this._loaded) this.load();
    if (!this._byId.has(id)) return;
    this._byId.delete(id);
    this.entries = this.entries.filter((e) => e.id !== id);
  }

  size() {
    if (!this._loaded) this.load();
    return this.entries.length;
  }

  /**
   * Top-k by cosine similarity. Returns [{ id, score, meta }] sorted desc.
   */
  search(queryVec, k = 5) {
    if (!this._loaded) this.load();
    if (!this.entries.length) return [];
    const q = queryVec instanceof Float32Array ? queryVec : Float32Array.from(queryVec);
    const qNorm = norm(q);
    if (qNorm === 0) return [];
    const scored = this.entries.map((e) => ({
      id: e.id,
      score: cosine(q, e.vec, qNorm),
      meta: e.meta,
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  }
}

function norm(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  return Math.sqrt(s);
}

function cosine(q, e, qNormCached) {
  let dot = 0;
  let eNorm = 0;
  const n = Math.min(q.length, e.length);
  for (let i = 0; i < n; i++) {
    dot += q[i] * e[i];
    eNorm += e[i] * e[i];
  }
  const denom = qNormCached * Math.sqrt(eNorm);
  return denom === 0 ? 0 : dot / denom;
}

export const vectorStore = new VectorStore();
export { VectorStore };
