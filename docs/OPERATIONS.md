# Operations

Operational runbook for a production (trusted-network) deployment of
project-memory-mcp. Covers the two things that bite memory data hardest:
**losing it** (backup/restore) and **invalidating it** (re-embedding after an
embedding-model or dimension change).

All state lives in PostgreSQL. The MCP server itself is stateless — every
durable thing (projects, memories, embeddings, confidence feedback) is a row in
the database. Backing up PostgreSQL backs up everything.

## What holds state

| Table | Holds | Lost if not backed up |
| --- | --- | --- |
| `projects` | registered project ids + names | project registration |
| `memories` | title/content/kind/tags, confidence, **`embedding` vector** | all knowledge + its vectors |
| `confidence_feedback` | every feedback row; confidence is recomputed from these | trust history |

The `memories.embedding` column (pgvector `vector`) is the only thing that is
*derived* — it can be regenerated from `title`/`content` by re-embedding (see
[Re-embedding](#re-embedding)). Everything else is source-of-truth.

## Fresh deployment

From an empty PostgreSQL to a running server. The server is stateless; the only
durable setup is the database schema, which the server creates itself.

### Prerequisites

- **PostgreSQL** reachable from where the server runs, with the **pgvector**
  extension available to install (the `pgvector/pgvector:pg16` image ships it;
  on a managed/self-hosted Postgres the `vector` extension package must be
  present so `CREATE EXTENSION` can succeed). The server runs
  `CREATE EXTENSION IF NOT EXISTS vector` during migration, so the DB role used
  must be allowed to create extensions (superuser, or pre-create it once by
  hand).
- An **OpenAI-compatible embeddings endpoint** and API key. The embedding
  `model` and `dimensions` are fixed for the life of the data — changing them
  later forces a full re-embed (see [Re-embedding](#re-embedding)), so pick them
  now.
- A `DATABASE_URL` pointing at the target database (the database itself should
  exist; `createdb project_memory` if not).

### Schema creation (migrations)

Migrations are idempotent and converge the schema to its final state. They run
**automatically once at server startup** — both the stdio and HTTP entry points
migrate before serving, and individual tool calls no longer migrate. So simply
starting the server against an empty (but existing) database builds the schema.

To create the schema explicitly without starting a server — useful in a
provisioning step or to verify connectivity first:

```bash
project-memory migrate \
  --service-config ./examples/project-memory.service.json \
  --project-config ./examples/project-memory.config.json
```

There is a single migration file (`migrations/001_init.sql`) describing the full
schema; re-running it against an already-migrated database is a no-op.

### Run (Docker, recommended)

```bash
docker build -t project-memory-mcp:local .

docker run --rm -p 8788:8788 \
  -e PROJECT_MEMORY_HTTP_TOKEN="change-me" \
  -e DATABASE_URL="postgres://user:password@postgres-host:5432/project_memory" \
  -e EMBEDDING_BASE_URL="https://api.example.com/v1" \
  -e EMBEDDING_MODEL="text-embedding-3-small" \
  -e EMBEDDING_DIMENSIONS="1536" \
  -e EMBEDDING_API_KEY="your-key" \
  project-memory-mcp:local
```

The image installs its own dependencies and builds inside a multi-stage
Dockerfile — no host `node_modules` is required. On startup it migrates, then
serves the HTTP `/mcp` endpoint and the read-only REST endpoints on `:8788`.

### Verify

```bash
# Both postgres and the embedding API must report ok (embedding dimension is
# checked against config here, catching a model/dimensions mismatch early).
curl http://127.0.0.1:8788/health

# Register the first project and capture its server-generated id.
# (Over MCP this is the register_project tool; the id scopes everything else.)
```

After `health` is green, point an MCP client at `http://<host>:8788/mcp`, call
`register_project` once, store the returned `projectId` in the project's
`.project-memory` file, and the auto-memory scaffold takes over from there (see
the `help` tool / `GET /help`).

## Backup

The MCP server holds no state, so a standard PostgreSQL dump is a complete
backup. The pgvector `vector` column dumps and restores like any other column.

```bash
# Full logical backup (custom format, compressed). Run against the same
# DATABASE_URL the server uses.
pg_dump --format=custom --no-owner --file=project-memory-$(date +%F).dump \
  "postgres://user:password@postgres-host:5432/project_memory"
```

Schedule this (cron / systemd timer) and keep dumps off-host. A few hundred
memories per project is tiny; dumps are small and fast.

> Restoring into a fresh database requires the `vector` extension. The server's
> migrations run `CREATE EXTENSION IF NOT EXISTS vector`, but a raw
> `pg_restore` into an empty DB does not. Either run the migrations first
> (`project-memory migrate` or start the server once), or create the extension
> manually before restore: `CREATE EXTENSION IF NOT EXISTS vector;`.

## Restore

```bash
# Into an empty database. Ensure the pgvector extension is available on the
# target server (the image/package must provide it).
createdb project_memory   # if the database does not exist yet
psql "postgres://user:password@host:5432/project_memory" \
  -c "CREATE EXTENSION IF NOT EXISTS vector;"
pg_restore --no-owner --dbname \
  "postgres://user:password@host:5432/project_memory" \
  project-memory-2026-06-25.dump
```

After restore, verify:

```bash
curl http://127.0.0.1:8788/health        # postgres + embedding both ok
# Spot-check a known project returns memories:
curl "http://127.0.0.1:8788/memories?projectId=<id>" -H "Authorization: Bearer $TOKEN"
```

## Re-embedding

The embedding vector is model-specific. **Changing the embedding model, or its
output dimensions, invalidates every stored vector** — old vectors and new query
vectors then live in different spaces and cosine similarity is meaningless.
Search will silently return garbage rankings rather than error.

The `memories.embedding` column is an unconstrained `vector` (no fixed
dimension) precisely so the dimension can change with config; nothing in the
schema enforces that all rows share one model. **That invariant is operational,
not enforced — you must re-embed every memory whenever the model or dimensions
change.**

### When you must re-embed

- You change `embedding.model` (e.g. swap providers, upgrade model version).
- You change `embedding.dimensions`.
- You restore a dump that was created under a different embedding model.

### Procedure

There is no batch re-embed command yet (tracked in `ROADMAP.md`). Re-embedding
happens by re-saving each memory, which recomputes its vector from the current
`title`/`content` using the configured model:

1. **Back up first** (see above) — re-embedding overwrites vectors in place.
2. Point the service config / env at the new embedding model and dimensions.
3. For every memory, call `update_memory` with no content change (or re-send the
   existing title/content). `update_memory` always recomputes the embedding from
   `title` + `content`, so the row is re-vectorized under the new model.
   - Enumerate ids per project via `GET /memories?projectId=<id>&includeArchived=true`
     (or the `list-memories` CLI command), then loop `update_memory` over them.
4. Re-run `health_check` — it asserts the live embedding output dimension equals
   the configured `dimensions`, catching a mismatched model/config.
5. Spot-check `search_knowledge` on a query with a known expected hit.

> Until all rows are re-embedded, search results mix old- and new-model vectors
> and rankings are unreliable. Re-embed in one maintenance window rather than
> incrementally. Rows written before the pgvector migration (no embedding) are
> already excluded from search until re-saved.

## Tuning (connection pool & timeouts)

The server bounds its PostgreSQL pool and the embedding HTTP request so a slow
or flaky dependency cannot hang requests or exhaust connections. Defaults are
conservative; override via env (or the `database.pool` / `embedding.requestTimeoutMs`
service-config fields) if your deployment needs different limits.

| Env var | Default | Meaning |
| --- | --- | --- |
| `DATABASE_POOL_MAX` | `10` | max PostgreSQL connections in the pool |
| `DATABASE_POOL_IDLE_TIMEOUT_MS` | `30000` | idle client eviction |
| `DATABASE_POOL_CONNECTION_TIMEOUT_MS` | `10000` | fail fast if no connection within this window |
| `EMBEDDING_REQUEST_TIMEOUT_MS` | `30000` | abort a hung embedding API call |

## Health monitoring

`GET /health` (no auth) returns 200 only when both PostgreSQL and the embedding
API are reachable and the embedding dimension matches config; 503 otherwise.
Wire it into your container/orchestrator health check. The deployment compose
file already exposes the server on `:8788`.
