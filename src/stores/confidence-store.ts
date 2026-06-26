import type { Pool, PoolClient } from "pg";
import { newId } from "../utils/ids.js";

export type ConfidenceTargetType = "memory";
export type ConfidenceSignal = "support" | "confirm" | "dispute" | "contradict" | "obsolete" | "uncertain";

export type ConfidenceFeedbackInput = {
  projectId: string;
  targetType: ConfidenceTargetType;
  targetId: string;
  signal: ConfidenceSignal;
  weight?: number;
  agentId?: string;
  rationale?: string;
  evidence?: Record<string, unknown>;
};

export type ConfidenceSummary = {
  targetType: ConfidenceTargetType;
  targetId: string;
  confidence: number;
  confidenceStatus: "trusted" | "normal" | "suspect" | "rejected";
  feedbackCount: number;
};

export type ConfidenceFeedbackRecord = ConfidenceFeedbackInput & {
  id: string;
  createdAt: string;
};

export const signalScores: Record<ConfidenceSignal, number> = {
  support: 0.08,
  confirm: 0.12,
  dispute: -0.16,
  contradict: -0.28,
  obsolete: -0.22,
  uncertain: -0.06
};

const BASE_CONFIDENCE = 0.7;

/**
 * Pure confidence math, separated from the DB read so it can be unit-tested and
 * reasoned about in isolation. Confidence starts at a fixed base and each
 * feedback row nudges it by its signal score times weight, clamped to [0, 1].
 */
export function computeConfidence(
  feedback: Array<{ signal: ConfidenceSignal; weight: number }>
): { confidence: number; confidenceStatus: ConfidenceSummary["confidenceStatus"]; feedbackCount: number } {
  const delta = feedback.reduce((sum, row) => sum + signalScores[row.signal] * Number(row.weight), 0);
  const confidence = clamp(round2(BASE_CONFIDENCE + delta), 0, 1);
  return {
    confidence,
    confidenceStatus: statusForConfidence(confidence),
    feedbackCount: feedback.length
  };
}

export async function recordConfidenceFeedback(
  client: PoolClient,
  input: ConfidenceFeedbackInput
): Promise<ConfidenceSummary> {
  await client.query(
    `INSERT INTO confidence_feedback
       (id, project_id, target_type, target_id, signal, weight, agent_id, rationale, evidence_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
    [
      newId("feedback"),
      input.projectId,
      input.targetType,
      input.targetId,
      input.signal,
      input.weight ?? 1,
      input.agentId ?? null,
      input.rationale ?? null,
      JSON.stringify(input.evidence ?? {})
    ]
  );
  return recomputeConfidence(client, input.projectId, input.targetType, input.targetId);
}

export async function getConfidenceSummary(
  db: Pool | PoolClient,
  projectId: string,
  targetType: ConfidenceTargetType,
  targetId: string
): Promise<ConfidenceSummary> {
  return recomputeConfidence(db, projectId, targetType, targetId, false);
}

export async function listConfidenceFeedback(
  db: Pool,
  input: { projectId: string; targetType?: ConfidenceTargetType; targetId?: string; limit?: number }
): Promise<ConfidenceFeedbackRecord[]> {
  const result = await db.query<{
    id: string;
    projectId: string;
    targetType: ConfidenceTargetType;
    targetId: string;
    signal: ConfidenceSignal;
    weight: number;
    agentId?: string | null;
    rationale?: string | null;
    evidence: Record<string, unknown>;
    createdAt: Date;
  }>(
    `SELECT id, project_id AS "projectId", target_type AS "targetType", target_id AS "targetId",
       signal, weight, agent_id AS "agentId", rationale, evidence_json AS evidence, created_at AS "createdAt"
     FROM confidence_feedback
     WHERE project_id = $1
       AND ($2::text IS NULL OR target_type = $2)
       AND ($3::text IS NULL OR target_id = $3)
     ORDER BY created_at DESC
     LIMIT $4`,
    [input.projectId, input.targetType ?? null, input.targetId ?? null, input.limit ?? 50]
  );
  return result.rows.map((row) => ({
    ...row,
    agentId: row.agentId ?? undefined,
    rationale: row.rationale ?? undefined,
    createdAt: row.createdAt.toISOString()
  }));
}

export async function listLowConfidenceTargets(
  db: Pool,
  projectId: string
): Promise<{ memories: unknown[] }> {
  const memories = await db.query(
    `SELECT id, title, kind, confidence, confidence_status AS "confidenceStatus"
     FROM memories
     WHERE project_id = $1 AND archived_at IS NULL AND confidence_status IN ('suspect', 'rejected')
     ORDER BY confidence ASC`,
    [projectId]
  );
  return { memories: memories.rows };
}

async function recomputeConfidence(
  db: Pool | PoolClient,
  projectId: string,
  targetType: ConfidenceTargetType,
  targetId: string,
  updateTarget = true
): Promise<ConfidenceSummary> {
  const feedback = await db.query<{ signal: ConfidenceSignal; weight: number }>(
    `SELECT signal, weight
     FROM confidence_feedback
     WHERE project_id = $1 AND target_type = $2 AND target_id = $3`,
    [projectId, targetType, targetId]
  );
  const { confidence, confidenceStatus, feedbackCount } = computeConfidence(feedback.rows);

  if (updateTarget) {
    await updateTargetConfidence(db, projectId, targetType, targetId, confidence, confidenceStatus);
  }

  return {
    targetType,
    targetId,
    confidence,
    confidenceStatus,
    feedbackCount
  };
}

async function updateTargetConfidence(
  db: Pool | PoolClient,
  projectId: string,
  targetType: ConfidenceTargetType,
  targetId: string,
  confidence: number,
  confidenceStatus: string
): Promise<void> {
  await db.query(
    `UPDATE memories
     SET confidence = $3, confidence_status = $4, updated_at = now()
     WHERE project_id = $1 AND id = $2`,
    [projectId, targetId, confidence, confidenceStatus]
  );
}

export function statusForConfidence(confidence: number): ConfidenceSummary["confidenceStatus"] {
  if (confidence >= 0.85) return "trusted";
  if (confidence < 0.2) return "rejected";
  if (confidence < 0.35) return "suspect";
  return "normal";
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
