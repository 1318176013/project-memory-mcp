import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Database } from "../src/stores/db.js";
import { addMemory, archiveMemory, listMemories, updateMemory } from "../src/memory/memory-manager.js";
import { searchKnowledge } from "../src/query/retriever.js";
import { submitConfidenceFeedback, readConfidence } from "../src/confidence/confidence-manager.js";
import type { RuntimeConfig } from "../src/config/types.js";
import type { EmbeddingProvider, EmbeddingResult } from "../src/embeddings/provider.js";

// DB-backed integration tests. They require a real PostgreSQL (with pgvector)
// reachable via DATABASE_URL and are skipped otherwise so the default `pnpm
// test` stays hermetic. Run them with, e.g.:
//   DATABASE_URL=postgres://project_memory:project_memory@localhost:5432/project_memory pnpm test
const DATABASE_URL = process.env.DATABASE_URL;
const skip = DATABASE_URL ? false : "DATABASE_URL not set — skipping DB integration tests";

const DIMENSIONS = 8;

// Deterministic stub embedder: hashes text into a fixed-dimension unit-ish
// vector so "similar" queries (sharing tokens) land near their memory without a
// live embedding API. Good enough to exercise the pgvector KNN path end-to-end.
const stubEmbedding: EmbeddingProvider = {
  async embed({ text }): Promise<EmbeddingResult> {
    const vector = new Array(DIMENSIONS).fill(0);
    for (const token of text.toLowerCase().split(/\W+/).filter(Boolean)) {
      let hash = 0;
      for (let i = 0; i < token.length; i++) hash = (hash * 31 + token.charCodeAt(i)) | 0;
      vector[Math.abs(hash) % DIMENSIONS] += 1;
    }
    const norm = Math.hypot(...vector) || 1;
    return {
      vector: vector.map((value) => value / norm),
      model: "stub",
      provider: "stub",
      dimensions: DIMENSIONS
    };
  },
  async embedBatch(inputs) {
    return Promise.all(inputs.map((input) => this.embed(input)));
  }
};

function makeApp(): { config: RuntimeConfig; db: Database; embeddingProvider: EmbeddingProvider } {
  const config: RuntimeConfig = {
    service: {
      // Fail fast if the configured DB is unreachable, rather than hanging on
      // the OS-level connect timeout.
      database: { url: DATABASE_URL, pool: { connectionTimeoutMillis: 5000 } },
      embedding: {
        provider: "openai-compatible",
        baseUrl: "https://stub.local/v1",
        apiKeyEnv: "EMBEDDING_API_KEY",
        model: "stub",
        dimensions: DIMENSIONS
      }
    },
    project: { projectId: "unused" }
  };
  return { config, db: new Database(config.service), embeddingProvider: stubEmbedding };
}

test("memory lifecycle: add, search, feedback, archive", { skip }, async (t) => {
  const app = makeApp();
  const projectId = `proj_test_${randomUUID()}`;

  t.after(async () => {
    // Cascades to memories + confidence_feedback via ON DELETE CASCADE.
    await app.db.pool.query("DELETE FROM projects WHERE id = $1", [projectId]);
    await app.db.close();
  });

  await app.db.migrate();

  // add_memory inserts and returns a row with the default 0.7 confidence.
  const added = await addMemory({
    ...app,
    projectId,
    title: "Authentication uses JWT",
    content: "All API auth flows through signed JWT tokens validated in middleware.",
    kind: "convention"
  });
  assert.equal(added.confidence, 0.7);
  assert.equal(added.confidenceStatus, "normal");
  assert.ok(added.id.startsWith("mem_"));

  // A second memory so search has something to rank against.
  const other = await addMemory({
    ...app,
    projectId,
    title: "Database is PostgreSQL",
    content: "Metadata and vectors both live in PostgreSQL via pgvector.",
    kind: "note"
  });

  // Duplicate add (same fingerprint) is detected, not re-inserted.
  const dup = await addMemory({
    ...app,
    projectId,
    title: "Authentication uses JWT",
    content: "All API auth flows through signed JWT tokens validated in middleware.",
    kind: "convention"
  });
  assert.equal(dup.id, added.id, "duplicate add should return the existing memory");
  assert.equal((dup as { duplicate?: boolean }).duplicate, true);

  // Vector search: the auth query should surface the auth memory first.
  const search = await searchKnowledge({ ...app, projectId, query: "how is authentication handled with JWT tokens" });
  assert.equal(search.registered, true);
  assert.ok(search.memories.length >= 1);
  assert.equal(search.memories[0].id, added.id, "auth memory should rank first for an auth query");

  // Isolation: a different projectId sees none of these memories.
  const otherProject = await searchKnowledge({
    ...app,
    projectId: `proj_test_${randomUUID()}`,
    query: "authentication"
  });
  assert.equal(otherProject.memories.length, 0);
  assert.equal(otherProject.registered, false);
  assert.ok(otherProject.warning, "unregistered project should carry a warning");

  // Confidence feedback lowers confidence and the recomputed summary reflects it.
  const summary = await submitConfidenceFeedback({
    ...app,
    projectId,
    targetId: added.id,
    signal: "contradict",
    weight: 2
  });
  assert.ok(summary.confidence < 0.7, `expected confidence below base, got ${summary.confidence}`);
  assert.equal(summary.feedbackCount, 1);

  const reread = await readConfidence({ ...app, projectId, targetId: added.id });
  assert.equal(reread.confidence, summary.confidence);

  // update_memory refreshes content and keeps the same id.
  const updated = await updateMemory({
    ...app,
    projectId,
    id: other.id,
    content: "Metadata, memories, and embeddings all live in PostgreSQL with the pgvector extension."
  });
  assert.equal(updated.id, other.id);

  // archive_memory removes it from search and from the default list.
  await archiveMemory({ ...app, projectId, id: other.id });
  const afterArchive = await listMemories({ ...app, projectId });
  assert.ok(!afterArchive.some((m) => m.id === other.id), "archived memory should not appear in default list");
  const withArchived = await listMemories({ ...app, projectId, includeArchived: true });
  assert.ok(withArchived.some((m) => m.id === other.id), "archived memory should appear when explicitly included");
});
