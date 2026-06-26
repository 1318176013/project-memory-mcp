import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { getDatabaseUrl, getRequiredEnv, loadRuntimeConfig } from "../src/config/loader.js";

test("getDatabaseUrl prefers explicit url", () => {
  assert.equal(
    getDatabaseUrl({
      database: { url: "postgres://explicit/db", urlEnv: "DATABASE_URL" },
      embedding: {
        provider: "openai-compatible",
        baseUrl: "https://example.com/v1",
        apiKeyEnv: "KEY",
        model: "model",
        dimensions: 1
      }
    }),
    "postgres://explicit/db"
  );
});

test("getRequiredEnv throws for missing variables", () => {
  delete process.env.PROJECT_MEMORY_TEST_MISSING;
  assert.throws(() => getRequiredEnv("PROJECT_MEMORY_TEST_MISSING"), /Required environment variable/);
});

test("loadRuntimeConfig applies service environment overrides", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "project-memory-config-"));
  const servicePath = path.join(dir, "service.json");
  const projectPath = path.join(dir, "project.json");
  await writeFile(
    servicePath,
    JSON.stringify({
      database: { urlEnv: "DATABASE_URL" },
      embedding: { provider: "openai-compatible" }
    }),
    "utf8"
  );
  await writeFile(
    projectPath,
    JSON.stringify({ projectId: "test-project", root: "." }),
    "utf8"
  );

  process.env.DATABASE_URL = "postgres://env/db";
  process.env.EMBEDDING_BASE_URL = "https://embedding.local/v1";
  process.env.EMBEDDING_API_KEY = "test-key";
  process.env.EMBEDDING_MODEL = "text-embedding-3-small";
  process.env.EMBEDDING_DIMENSIONS = "1536";

  const config = await loadRuntimeConfig({ serviceConfigPath: servicePath, projectConfigPath: projectPath });

  assert.equal(config.service.database.url, "postgres://env/db");
  assert.equal(config.service.embedding.baseUrl, "https://embedding.local/v1");
  assert.equal(config.service.embedding.apiKeyEnv, "EMBEDDING_API_KEY");
  assert.equal(config.service.embedding.model, "text-embedding-3-small");
  assert.equal(config.service.embedding.dimensions, 1536);
});
