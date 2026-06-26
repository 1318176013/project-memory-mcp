import type { RuntimeConfig } from "../config/types.js";
import type { Database } from "../stores/db.js";
import { searchMemoriesByVector, type StoredMemory } from "../stores/memory-store.js";
import type { EmbeddingProvider } from "../embeddings/provider.js";

export type SearchKnowledgeResult = {
  query: string;
  projectId: string;
  memories: StoredMemory[];
  registered: boolean;
  warning?: string;
};

export async function searchKnowledge(input: {
  config: RuntimeConfig;
  db: Database;
  embeddingProvider: EmbeddingProvider;
  query: string;
  projectId: string;
  topK?: number;
}): Promise<SearchKnowledgeResult> {
  const embedding = await input.embeddingProvider.embed({ text: input.query });

  // Exact cosine KNN in Postgres, already scoped to this project and to active
  // (non-archived) rows with an embedding. Each row carries its cosine
  // similarity as `score`, which rankMemories then weights by confidence.
  const candidates = await searchMemoriesByVector(input.db.pool, {
    projectId: input.projectId,
    embedding: embedding.vector,
    limit: input.topK ?? 8
  });

  const rawScores = new Map<string, number>(candidates.map((memory) => [memory.id, memory.score ?? 0]));
  const sortedMemories = rankMemories(candidates, rawScores);

  const registered = await isProjectRegistered(input.db.pool, input.projectId);
  const result: SearchKnowledgeResult = {
    query: input.query,
    projectId: input.projectId,
    memories: sortedMemories,
    registered
  };
  if (sortedMemories.length === 0 && !registered) {
    result.warning = `projectId "${input.projectId}" is not registered and has no indexed data. Call register_project first or check the projectId.`;
  }
  return result;
}

async function isProjectRegistered(db: import("pg").Pool, projectId: string): Promise<boolean> {
  const result = await db.query<{ count: string }>(
    "SELECT count(*) FROM projects WHERE id = $1",
    [projectId]
  );
  return Number(result.rows[0]?.count ?? 0) > 0;
}

/**
 * Apply confidence weighting to raw vector scores and sort, dropping rejected
 * memories entirely. Pure and exported so ranking behavior can be unit-tested
 * without a live PG round-trip. Mutates each memory's `score` in place (the
 * score is derived retrieval state, not persisted).
 */
export function rankMemories(
  memories: StoredMemory[],
  rawScores: Map<string, number>
): StoredMemory[] {
  for (const memory of memories) {
    const baseScore = rawScores.get(memory.id) ?? 0;
    memory.score = memory.confidenceStatus === "rejected" ? 0 : baseScore * confidenceMultiplier(memory.confidence);
  }
  return memories
    .filter((memory) => memory.confidenceStatus !== "rejected")
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

export function confidenceMultiplier(confidence: number): number {
  if (confidence < 0.2) return 0;
  if (confidence < 0.35) return 0.25;
  if (confidence < 0.5) return 0.55;
  return 0.75 + confidence * 0.25;
}
