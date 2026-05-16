/**
 * Memory ingest — bulk-embed lessons.json + pool-memory.json into the
 * vector store on demand. Designed for lazy startup ingest and
 * incremental updates as new lessons/pool outcomes are recorded.
 *
 * Public API:
 *   ensureLessonsIngested() — embed any lessons not yet in the store
 *   ensurePoolMemoryIngested() — same for pool-memory entries
 *   addLessonToStore(lesson) — embed one new lesson incrementally
 *
 * Designed to be safe to call multiple times; only un-embedded entries
 * trigger an API call thanks to embedder's content-hash cache.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { config } from "../config.js";
import { log } from "../logger.js";
import { embedBatch } from "./embedder.js";
import { vectorStore } from "./vector-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LESSONS_PATH = path.join(__dirname, "..", "lessons.json");
const POOL_MEMORY_PATH = path.join(__dirname, "..", "pool-memory.json");

function lessonText(lesson) {
  const parts = [
    lesson.rule || "",
    lesson.outcome ? `outcome=${lesson.outcome}` : "",
    Array.isArray(lesson.tags) ? `tags=${lesson.tags.join(",")}` : "",
    lesson.role ? `role=${lesson.role}` : "",
  ];
  return parts.filter(Boolean).join(" | ");
}

function poolNoteText(poolAddr, note, ctx) {
  const tags = ctx.win_rate != null ? `win=${(ctx.win_rate * 100).toFixed(0)}%` : "";
  const avg = ctx.avg_pnl_pct != null ? `avg_pnl=${ctx.avg_pnl_pct.toFixed(1)}%` : "";
  return [note, tags, avg, `pool=${poolAddr.slice(0, 8)}`].filter(Boolean).join(" | ");
}

function lessonId(lesson) {
  return `lesson:${lesson.id || crypto.createHash("md5").update(lessonText(lesson)).digest("hex").slice(0, 12)}`;
}

function poolNoteId(poolAddr, idx) {
  return `pool:${poolAddr}:${idx}`;
}

function isEnabled() {
  return Boolean(config?.memory?.semantic);
}

function readJsonSafe(p) {
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

export async function ensureLessonsIngested() {
  if (!isEnabled()) return { skipped: true };
  const data = readJsonSafe(LESSONS_PATH);
  const lessons = data?.lessons || [];
  if (!lessons.length) return { added: 0 };

  vectorStore.load();
  const todo = [];
  for (const l of lessons) {
    const id = lessonId(l);
    if (vectorStore.has(id)) continue;
    todo.push({ id, text: lessonText(l), meta: { kind: "lesson", role: l.role || null, outcome: l.outcome || null, rule: l.rule } });
  }
  if (!todo.length) return { added: 0 };

  const vectors = await embedBatch(todo.map((t) => t.text));
  for (let i = 0; i < todo.length; i++) {
    vectorStore.add(todo[i].id, vectors[i], todo[i].meta);
  }
  vectorStore.save();
  log("memory", `ingested ${todo.length} lessons → vector store (${vectorStore.size()} total)`);
  return { added: todo.length };
}

export async function ensurePoolMemoryIngested() {
  if (!isEnabled()) return { skipped: true };
  const data = readJsonSafe(POOL_MEMORY_PATH);
  if (!data) return { added: 0 };

  vectorStore.load();
  const todo = [];
  for (const [poolAddr, pool] of Object.entries(data)) {
    const notes = pool.notes || [];
    for (let i = 0; i < notes.length; i++) {
      const id = poolNoteId(poolAddr, i);
      if (vectorStore.has(id)) continue;
      todo.push({
        id,
        text: poolNoteText(poolAddr, notes[i], pool),
        meta: { kind: "pool_note", pool: poolAddr, win_rate: pool.win_rate, avg_pnl_pct: pool.avg_pnl_pct },
      });
    }
  }
  if (!todo.length) return { added: 0 };

  const vectors = await embedBatch(todo.map((t) => t.text));
  for (let i = 0; i < todo.length; i++) {
    vectorStore.add(todo[i].id, vectors[i], todo[i].meta);
  }
  vectorStore.save();
  log("memory", `ingested ${todo.length} pool notes → vector store (${vectorStore.size()} total)`);
  return { added: todo.length };
}

export async function addLessonToStore(lesson) {
  if (!isEnabled()) return;
  const id = lessonId(lesson);
  vectorStore.load();
  if (vectorStore.has(id)) return;
  const [vec] = await embedBatch([lessonText(lesson)]);
  vectorStore.add(id, vec, { kind: "lesson", role: lesson.role || null, outcome: lesson.outcome || null, rule: lesson.rule });
  vectorStore.save();
}

/**
 * Best-effort ingest at startup — fire-and-forget so we don't block
 * the agent loop if embedding API is slow/unreachable.
 */
export function startBackgroundIngest() {
  if (!isEnabled()) return;
  Promise.all([
    ensureLessonsIngested().catch((err) => log("memory_warn", `lesson ingest failed: ${err.message}`)),
    ensurePoolMemoryIngested().catch((err) => log("memory_warn", `pool ingest failed: ${err.message}`)),
  ]).then(() => log("memory", "background ingest done"));
}
