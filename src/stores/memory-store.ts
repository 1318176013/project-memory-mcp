import type { Pool, PoolClient } from "pg";
import { newId } from "../utils/ids.js";

export type StoredMemory = {
  id: string;
  projectId: string;
  title: string;
  content: string;
  kind: string;
  tags: string[];
  source?: string;
  archivedAt?: string | null;
  confidence: number;
  confidenceStatus: string;
  score?: number;
};

/** pgvector accepts the text form `[0.1,0.2,...]` for a `vector` parameter when
 * the placeholder is cast with `::vector`. Centralised so insert/update/search
 * all serialise embeddings identically. */
function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

export async function insertMemory(
  client: PoolClient,
  input: {
    projectId: string;
    title: string;
    content: string;
    kind: string;
    tags?: string[];
    source?: string;
    embedding: number[];
  }
): Promise<StoredMemory> {
  const id = newId("mem");
  await client.query(
    `INSERT INTO memories (id, project_id, title, content, kind, tags_json, source, embedding)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::vector)`,
    [
      id,
      input.projectId,
      input.title,
      input.content,
      input.kind,
      JSON.stringify(input.tags ?? []),
      input.source ?? "manual",
      toVectorLiteral(input.embedding)
    ]
  );
  return {
    id,
    projectId: input.projectId,
    title: input.title,
    content: input.content,
    kind: input.kind,
    tags: input.tags ?? [],
    source: input.source ?? "manual",
    confidence: 0.7,
    confidenceStatus: "normal"
  };
}

export async function findActiveMemoryByFingerprint(
  client: PoolClient,
  input: { projectId: string; title: string; content: string; kind: string }
): Promise<StoredMemory | undefined> {
  const result = await client.query<MemoryRow>(
    `${memorySelectSql}
     WHERE project_id = $1 AND title = $2 AND content = $3 AND kind = $4 AND archived_at IS NULL
     LIMIT 1`,
    [input.projectId, input.title, input.content, input.kind]
  );
  return result.rows[0] ? mapMemoryRow(result.rows[0]) : undefined;
}

export async function getMemoryById(db: Pool | PoolClient, projectId: string, id: string): Promise<StoredMemory | undefined> {
  const result = await db.query<MemoryRow>(
    `${memorySelectSql}
     WHERE project_id = $1 AND id = $2
     LIMIT 1`,
    [projectId, id]
  );
  return result.rows[0] ? mapMemoryRow(result.rows[0]) : undefined;
}

export async function listMemories(
  db: Pool,
  input: { projectId: string; includeArchived?: boolean; kind?: string; tag?: string; limit?: number }
): Promise<StoredMemory[]> {
  const result = await db.query<MemoryRow>(
    `${memorySelectSql}
     WHERE project_id = $1
       AND ($2::boolean = true OR archived_at IS NULL)
       AND ($3::text IS NULL OR kind = $3)
       AND ($4::text IS NULL OR tags_json ? $4)
     ORDER BY created_at DESC
     LIMIT $5`,
    [input.projectId, input.includeArchived ?? false, input.kind ?? null, input.tag ?? null, input.limit ?? 50]
  );
  return result.rows.map(mapMemoryRow);
}

/**
 * Exact cosine KNN over a single project's active memories. pgvector's `<=>`
 * is cosine distance, so `1 - distance` yields the cosine similarity in [0, 1]
 * that rankMemories then weights by confidence. Rows without an embedding
 * (e.g. legacy rows written before the pgvector migration, until re-saved) are
 * excluded so they never rank as a spurious zero-distance hit.
 */
export async function searchMemoriesByVector(
  db: Pool,
  input: { projectId: string; embedding: number[]; limit: number }
): Promise<StoredMemory[]> {
  const result = await db.query<MemoryRow & { score: number | string }>(
    `SELECT ${memorySelectColumns}, 1 - (embedding <=> $2::vector) AS score
     FROM memories
     WHERE project_id = $1 AND archived_at IS NULL AND embedding IS NOT NULL
     ORDER BY embedding <=> $2::vector
     LIMIT $3`,
    [input.projectId, toVectorLiteral(input.embedding), input.limit]
  );
  return result.rows.map((row) => {
    const memory = mapMemoryRow(row);
    memory.score = Number(row.score);
    return memory;
  });
}

export async function updateMemoryRow(
  client: PoolClient,
  input: {
    projectId: string;
    id: string;
    title: string;
    content: string;
    kind: string;
    tags: string[];
    source?: string;
    embedding: number[];
  }
): Promise<StoredMemory> {
  const result = await client.query<MemoryRow>(
    `UPDATE memories
     SET title = $3, content = $4, kind = $5, tags_json = $6::jsonb,
       source = COALESCE($7, source), embedding = $8::vector, updated_at = now(), archived_at = NULL
     WHERE project_id = $1 AND id = $2
     RETURNING id, project_id AS "projectId", title, content, kind, tags_json AS tags,
       source, archived_at AS "archivedAt", confidence, confidence_status AS "confidenceStatus"`,
    [
      input.projectId,
      input.id,
      input.title,
      input.content,
      input.kind,
      JSON.stringify(input.tags),
      input.source ?? null,
      toVectorLiteral(input.embedding)
    ]
  );
  if (!result.rows[0]) {
    throw new Error(`Memory not found: ${input.id}`);
  }
  return mapMemoryRow(result.rows[0]);
}

export async function archiveMemoryRow(client: PoolClient, projectId: string, id: string): Promise<StoredMemory> {
  const result = await client.query<MemoryRow>(
    `UPDATE memories
     SET archived_at = now(), updated_at = now()
     WHERE project_id = $1 AND id = $2
     RETURNING id, project_id AS "projectId", title, content, kind, tags_json AS tags,
       source, archived_at AS "archivedAt", confidence, confidence_status AS "confidenceStatus"`,
    [projectId, id]
  );
  if (!result.rows[0]) {
    throw new Error(`Memory not found: ${id}`);
  }
  return mapMemoryRow(result.rows[0]);
}

export async function getMemoriesByIds(db: Pool, ids: string[], projectId?: string): Promise<StoredMemory[]> {
  if (ids.length === 0) return [];
  const result = await db.query<MemoryRow>(
    `${memorySelectSql}
     WHERE id = ANY($1::text[]) AND archived_at IS NULL AND ($2::text IS NULL OR project_id = $2)`,
    [ids, projectId ?? null]
  );
  return result.rows.map(mapMemoryRow);
}

type MemoryRow = {
  id: string;
  projectId: string;
  title: string;
  content: string;
  kind: string;
  tags: string[] | string;
  source?: string;
  archivedAt?: Date | string | null;
  confidence: number | string;
  confidenceStatus: string;
};

const memorySelectColumns = `id, project_id AS "projectId", title, content, kind, tags_json AS tags,
  source, archived_at AS "archivedAt",
  confidence, confidence_status AS "confidenceStatus"`;

const memorySelectSql = `SELECT ${memorySelectColumns}
  FROM memories`;

function mapMemoryRow(row: MemoryRow): StoredMemory {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    content: row.content,
    kind: row.kind,
    tags: Array.isArray(row.tags) ? row.tags : JSON.parse(row.tags),
    source: row.source,
    archivedAt: row.archivedAt ? new Date(row.archivedAt).toISOString() : null,
    confidence: Number(row.confidence),
    confidenceStatus: row.confidenceStatus
  };
}
