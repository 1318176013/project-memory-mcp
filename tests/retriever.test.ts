import test from "node:test";
import assert from "node:assert/strict";
import { confidenceMultiplier, rankMemories } from "../src/query/retriever.js";
import type { StoredMemory } from "../src/stores/memory-store.js";

function memory(overrides: Partial<StoredMemory> & { id: string }): StoredMemory {
  return {
    projectId: "proj",
    title: overrides.id,
    content: "content",
    kind: "note",
    tags: [],
    confidence: 0.7,
    confidenceStatus: "normal",
    ...overrides
  };
}

test("confidenceMultiplier is monotonic and zeroes very low confidence", () => {
  assert.equal(confidenceMultiplier(0.1), 0);
  assert.ok(confidenceMultiplier(0.3) < confidenceMultiplier(0.45));
  assert.ok(confidenceMultiplier(0.45) < confidenceMultiplier(0.9));
  assert.ok(confidenceMultiplier(1) <= 1);
});

test("rankMemories drops rejected memories entirely", () => {
  const memories = [
    memory({ id: "a", confidenceStatus: "normal", confidence: 0.7 }),
    memory({ id: "b", confidenceStatus: "rejected", confidence: 0.1 })
  ];
  const scores = new Map([
    ["a", 0.5],
    ["b", 0.99]
  ]);
  const ranked = rankMemories(memories, scores);
  assert.deepEqual(ranked.map((m) => m.id), ["a"]);
});

test("rankMemories weights raw score by confidence before sorting", () => {
  // 'low' has a higher raw vector score but low confidence; 'high' has a lower
  // raw score but high confidence. Confidence weighting should reorder them.
  const memories = [
    memory({ id: "low", confidence: 0.3, confidenceStatus: "suspect" }),
    memory({ id: "high", confidence: 0.95, confidenceStatus: "trusted" })
  ];
  const scores = new Map([
    ["low", 0.8],
    ["high", 0.6]
  ]);
  const ranked = rankMemories(memories, scores);
  assert.equal(ranked[0].id, "high", "high-confidence memory should rank first");
  assert.ok((ranked[0].score ?? 0) > (ranked[1].score ?? 0));
});

test("rankMemories treats a missing raw score as zero", () => {
  const memories = [memory({ id: "a" })];
  const ranked = rankMemories(memories, new Map());
  assert.equal(ranked[0].score, 0);
});
