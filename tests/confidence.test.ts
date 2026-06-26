import test from "node:test";
import assert from "node:assert/strict";
import { computeConfidence, signalScores, statusForConfidence } from "../src/stores/confidence-store.js";

test("computeConfidence starts at the 0.7 base with no feedback", () => {
  const result = computeConfidence([]);
  assert.equal(result.confidence, 0.7);
  assert.equal(result.confidenceStatus, "normal");
  assert.equal(result.feedbackCount, 0);
});

test("positive signals raise confidence, negative signals lower it", () => {
  const raised = computeConfidence([{ signal: "confirm", weight: 1 }]);
  assert.ok(raised.confidence > 0.7, `expected > 0.7, got ${raised.confidence}`);

  const lowered = computeConfidence([{ signal: "contradict", weight: 1 }]);
  assert.ok(lowered.confidence < 0.7, `expected < 0.7, got ${lowered.confidence}`);
});

test("feedback weight scales the signal score", () => {
  const single = computeConfidence([{ signal: "support", weight: 1 }]);
  const double = computeConfidence([{ signal: "support", weight: 2 }]);
  // The weight-2 delta should be twice the weight-1 delta, before rounding.
  assert.ok(double.confidence - 0.7 > single.confidence - 0.7);
  assert.equal(double.confidence, Math.round((0.7 + signalScores.support * 2) * 100) / 100);
});

test("confidence is clamped to [0, 1]", () => {
  const floor = computeConfidence(Array(20).fill({ signal: "contradict", weight: 5 }));
  assert.equal(floor.confidence, 0);
  const ceiling = computeConfidence(Array(20).fill({ signal: "confirm", weight: 5 }));
  assert.equal(ceiling.confidence, 1);
});

test("strong negative feedback drives status to rejected, mild to suspect", () => {
  const rejected = computeConfidence([
    { signal: "contradict", weight: 2 },
    { signal: "contradict", weight: 1 }
  ]);
  assert.equal(rejected.confidenceStatus, "rejected");

  // A single contradict lands at 0.42 (normal); pair a dispute to reach suspect range.
  const suspect = computeConfidence([
    { signal: "contradict", weight: 1 },
    { signal: "dispute", weight: 1 }
  ]);
  assert.equal(suspect.confidenceStatus, "suspect");
});

test("statusForConfidence thresholds", () => {
  assert.equal(statusForConfidence(0.9), "trusted");
  assert.equal(statusForConfidence(0.85), "trusted");
  assert.equal(statusForConfidence(0.7), "normal");
  assert.equal(statusForConfidence(0.3), "suspect");
  assert.equal(statusForConfidence(0.1), "rejected");
});
