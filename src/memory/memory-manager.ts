import type { RuntimeConfig } from "../config/types.js";
import type { Database } from "../stores/db.js";
import {
  archiveMemoryRow,
  findActiveMemoryByFingerprint,
  getMemoryById,
  insertMemory,
  listMemories as listMemoryRows,
  updateMemoryRow,
  type StoredMemory
} from "../stores/memory-store.js";
import { ensureProjectRow } from "../stores/project-store.js";
import type { EmbeddingProvider } from "../embeddings/provider.js";
import { logger } from "../utils/logger.js";

export type MemoryApp = {
  config: RuntimeConfig;
  db: Database;
  embeddingProvider: EmbeddingProvider;
};

export async function addMemory(input: MemoryApp & {
  projectId: string;
  title: string;
  content: string;
  kind: string;
  tags?: string[];
  source?: string;
  allowDuplicate?: boolean;
}): Promise<StoredMemory & { duplicate?: boolean }> {
  const tags = normalizeTags(input.tags);
  logger.info("Add memory started", {
    projectId: input.projectId,
    kind: input.kind,
    tagCount: tags.length,
    allowDuplicate: input.allowDuplicate === true,
    titleLength: input.title.length,
    contentLength: input.content.length
  });

  // Embed before the transaction so the embedding round-trip is not held open
  // inside Postgres. The vector is then written with the row in a single
  // transaction — there is no second store to keep consistent.
  const embeddingStartedAt = Date.now();
  const embedding = await input.embeddingProvider.embed({ text: `${input.title}\n\n${input.content}` });
  logger.info("Add memory embedding completed", {
    projectId: input.projectId,
    dimensions: embedding.dimensions,
    elapsedMs: Date.now() - embeddingStartedAt
  });

  const txStartedAt = Date.now();
  return input.db.withTransaction(async (client) => {
    await ensureProjectRow(client, input.projectId);
    if (!input.allowDuplicate) {
      const existing = await findActiveMemoryByFingerprint(client, {
        projectId: input.projectId,
        title: input.title,
        content: input.content,
        kind: input.kind
      });
      if (existing) {
        return { ...existing, duplicate: true } as StoredMemory & { duplicate?: true };
      }
    }

    return insertMemory(client, {
      projectId: input.projectId,
      title: input.title,
      content: input.content,
      kind: input.kind,
      tags,
      source: input.source,
      embedding: embedding.vector
    });
  }).then((result) => {
    const memory = result as StoredMemory & { duplicate?: boolean };
    logger.info("Add memory completed", {
      projectId: input.projectId,
      id: memory.id,
      duplicate: memory.duplicate === true,
      elapsedMs: Date.now() - txStartedAt
    });
    return memory;
  });
}

export async function updateMemory(input: MemoryApp & {
  projectId: string;
  id: string;
  title?: string;
  content?: string;
  kind?: string;
  tags?: string[];
  source?: string;
}): Promise<StoredMemory> {
  const projectId = input.projectId;
  logger.info("Update memory started", {
    projectId,
    id: input.id,
    hasTitle: input.title !== undefined,
    hasContent: input.content !== undefined,
    hasKind: input.kind !== undefined,
    hasTags: input.tags !== undefined,
    hasSource: input.source !== undefined
  });

  // Read the current memory (read-only) so the slow embedding call can run
  // outside the transaction. There is a narrow window where the memory could
  // change before the transaction re-reads it; that is an acceptable trade-off
  // for not holding the embedding round-trip open inside Postgres.
  const current = await getMemoryById(input.db.pool, projectId, input.id);
  if (!current) throw new Error(`Memory not found: ${input.id}`);
  const nextTitle = input.title ?? current.title;
  const nextContent = input.content ?? current.content;
  const embeddingStartedAt = Date.now();
  const embedding = await input.embeddingProvider.embed({ text: `${nextTitle}\n\n${nextContent}` });
  logger.info("Update memory embedding completed", {
    projectId,
    id: input.id,
    dimensions: embedding.dimensions,
    elapsedMs: Date.now() - embeddingStartedAt
  });

  const txStartedAt = Date.now();
  return input.db.withTransaction(async (client) => {
    await ensureProjectRow(client, projectId);
    const inTx = await getMemoryById(client, projectId, input.id);
    if (!inTx) throw new Error(`Memory not found: ${input.id}`);

    return updateMemoryRow(client, {
      projectId,
      id: input.id,
      title: input.title ?? inTx.title,
      content: input.content ?? inTx.content,
      kind: input.kind ?? inTx.kind,
      tags: input.tags ? normalizeTags(input.tags) : inTx.tags,
      source: input.source,
      embedding: embedding.vector
    });
  }).then((result) => {
    logger.info("Update memory completed", {
      projectId,
      id: input.id,
      elapsedMs: Date.now() - txStartedAt
    });
    return result;
  });
}

export async function archiveMemory(input: MemoryApp & { projectId: string; id: string }): Promise<StoredMemory> {
  const projectId = input.projectId;
  logger.info("Archive memory started", { projectId, id: input.id });

  const startedAt = Date.now();
  return input.db.withTransaction(async (client) => {
    const current = await getMemoryById(client, projectId, input.id);
    if (!current) throw new Error(`Memory not found: ${input.id}`);
    return archiveMemoryRow(client, projectId, input.id);
  }).then((result) => {
    logger.info("Archive memory completed", { projectId, id: input.id, elapsedMs: Date.now() - startedAt });
    return result;
  });
}

export async function listMemories(input: {
  db: Database;
  config: RuntimeConfig;
  projectId: string;
  includeArchived?: boolean;
  kind?: string;
  tag?: string;
  limit?: number;
}): Promise<StoredMemory[]> {
  logger.info("List memories started", {
    projectId: input.projectId,
    includeArchived: input.includeArchived === true,
    kind: input.kind,
    tag: input.tag,
    limit: input.limit
  });
  const startedAt = Date.now();
  const rows = await listMemoryRows(input.db.pool, {
    projectId: input.projectId,
    includeArchived: input.includeArchived,
    kind: input.kind,
    tag: input.tag,
    limit: input.limit
  });
  logger.info("List memories completed", {
    projectId: input.projectId,
    resultCount: rows.length,
    elapsedMs: Date.now() - startedAt
  });
  return rows;
}

function normalizeTags(tags?: string[]): string[] {
  return [...new Set((tags ?? []).map((tag) => tag.trim()).filter(Boolean))];
}
