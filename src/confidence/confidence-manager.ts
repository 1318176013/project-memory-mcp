import type { Database } from "../stores/db.js";
import {
  getConfidenceSummary,
  listConfidenceFeedback,
  listLowConfidenceTargets,
  recordConfidenceFeedback,
  type ConfidenceSignal,
  type ConfidenceTargetType
} from "../stores/confidence-store.js";

// Confidence flows only touch the database; they never embed. Depend on just the
// DB rather than the full AppContext so any caller with a Database (tests, CLI,
// MCP) can drive them without constructing a concrete embedding provider.
type ConfidenceApp = { db: Database };

// Confidence feedback applies only to memories. targetType is fixed to "memory"
// here so callers (MCP tools, CLI) do not have to pass it; the column is still
// stored so feedback records remain self-describing.
const MEMORY_TARGET: ConfidenceTargetType = "memory";

export async function submitConfidenceFeedback(input: ConfidenceApp & {
  projectId: string;
  targetId: string;
  signal: ConfidenceSignal;
  weight?: number;
  agentId?: string;
  rationale?: string;
  evidence?: Record<string, unknown>;
}) {
  return input.db.withTransaction((client) =>
    recordConfidenceFeedback(client, {
      projectId: input.projectId,
      targetType: MEMORY_TARGET,
      targetId: input.targetId,
      signal: input.signal,
      weight: input.weight,
      agentId: input.agentId,
      rationale: input.rationale,
      evidence: input.evidence
    })
  );
}

export async function listFeedback(input: ConfidenceApp & {
  projectId: string;
  targetId?: string;
  limit?: number;
}) {
  return listConfidenceFeedback(input.db.pool, {
    projectId: input.projectId,
    targetId: input.targetId,
    limit: input.limit
  });
}

export async function listSuspectConfidence(input: ConfidenceApp & { projectId: string }) {
  return listLowConfidenceTargets(input.db.pool, input.projectId);
}

export async function readConfidence(input: ConfidenceApp & {
  projectId: string;
  targetId: string;
}) {
  return getConfidenceSummary(input.db.pool, input.projectId, MEMORY_TARGET, input.targetId);
}
