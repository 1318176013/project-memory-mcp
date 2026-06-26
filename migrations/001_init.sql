-- project-memory-mcp initial schema.
--
-- This is the converged final state of what were once five incremental
-- migrations (001 init, 002 root_path optional, 003 drop graph, 004 drop
-- documents/chunks, 005 pgvector memories). They were squashed into one file
-- once the schema stabilized: a fresh database builds the final structure
-- directly instead of creating tables only to alter and drop them.
--
-- Idempotent on purpose: every statement uses IF NOT EXISTS so re-running the
-- full file against an already-migrated database is a no-op. migrate() globs
-- migrations/*.sql in lexical order, so adding a future 002_*.sql will run
-- after this one.

-- pgvector backs the memories.embedding column. The column is an unconstrained
-- `vector` (no dimension modifier) on purpose: the embedding dimension is
-- config-driven (service.embedding.dimensions), so pinning it here would couple
-- the schema to one model. Exact KNN needs no fixed dimension or index; all rows
-- in a deployment share one dimension. Changing the model/dimensions requires
-- re-embedding every row (see docs/OPERATIONS.md).
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  -- Nullable: register_project mints projects with no filesystem root, and the
  -- server never reads project files. root_path is informational only.
  root_path TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Preserve uniqueness only for projects that carry a root; NULL roots
-- (registered-only projects) are exempt so many may coexist.
CREATE UNIQUE INDEX IF NOT EXISTS uq_projects_root_path
  ON projects (root_path)
  WHERE root_path IS NOT NULL;

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  kind TEXT NOT NULL,
  tags_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  source TEXT NOT NULL DEFAULT 'manual',
  confidence REAL NOT NULL DEFAULT 0.7,
  confidence_status TEXT NOT NULL DEFAULT 'normal',
  embedding vector,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS confidence_feedback (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- target_type is fixed to 'memory' today but kept so feedback rows stay
  -- self-describing if other target kinds are ever added.
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  signal TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1,
  agent_id TEXT,
  rationale TEXT,
  evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_id);
CREATE INDEX IF NOT EXISTS idx_memories_confidence ON memories(project_id, confidence_status, confidence);
CREATE INDEX IF NOT EXISTS idx_confidence_feedback_target ON confidence_feedback(project_id, target_type, target_id);
