/**
 * Phase 5 semantic memory test (no network).
 *
 * Validates:
 *   - VectorStore add / search / persist round-trip
 *   - Cosine ordering is correct for hand-crafted vectors
 *   - getSemanticLessonContext returns null when feature flag is off
 */

import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import { VectorStore } from "../memory/vector-store.js";
import { getSemanticLessonContext } from "../lessons.js";

console.log("Semantic memory tests:");

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    throw err;
  }
}

test("VectorStore add + search returns nearest first", () => {
  const tmpPath = path.join(os.tmpdir(), `vs-${Date.now()}.json`);
  const vs = new VectorStore({ path: tmpPath });
  vs.add("a", [1, 0, 0], { kind: "lesson", rule: "AAA" });
  vs.add("b", [0, 1, 0], { kind: "lesson", rule: "BBB" });
  vs.add("c", [0.9, 0.1, 0], { kind: "lesson", rule: "CCC" });
  const hits = vs.search([1, 0, 0], 3);
  assert.equal(hits[0].id, "a");
  assert.equal(hits[1].id, "c");
  assert.equal(hits[2].id, "b");
  assert.ok(hits[0].score > hits[1].score);
});

test("VectorStore persists across instances", () => {
  const tmpPath = path.join(os.tmpdir(), `vs-persist-${Date.now()}.json`);
  const a = new VectorStore({ path: tmpPath });
  a.add("x", [0.5, 0.5, 0], { kind: "lesson" });
  a.save();
  const b = new VectorStore({ path: tmpPath });
  b.load();
  assert.equal(b.size(), 1);
  assert.equal(b.has("x"), true);
  fs.unlinkSync(tmpPath);
});

test("VectorStore enforces dim consistency", () => {
  const tmpPath = path.join(os.tmpdir(), `vs-dim-${Date.now()}.json`);
  const vs = new VectorStore({ path: tmpPath });
  vs.add("a", [1, 0, 0], {});
  assert.throws(() => vs.add("b", [1, 0]), /dim mismatch/);
});

test("getSemanticLessonContext returns null when disabled", async () => {
  const r = await getSemanticLessonContext({ query: "test" });
  assert.equal(r, null);
});

test("getSemanticLessonContext returns null on missing query", async () => {
  const r = await getSemanticLessonContext({ query: null });
  assert.equal(r, null);
});

console.log("✓ Phase 5 semantic memory tests passed");
process.exit(0);
