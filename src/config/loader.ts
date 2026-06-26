import { readFile } from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import { z } from "zod";
import type { ProjectConfig, RuntimeConfig, ServiceConfig } from "./types.js";

dotenv.config();

const poolSchema = z
  .object({
    max: z.number().int().positive().optional(),
    idleTimeoutMillis: z.number().int().nonnegative().optional(),
    connectionTimeoutMillis: z.number().int().nonnegative().optional()
  })
  .optional();

const rawServiceSchema = z.object({
  database: z.object({
    url: z.string().optional(),
    urlEnv: z.string().optional(),
    pool: poolSchema
  }),
  embedding: z.object({
    provider: z.literal("openai-compatible"),
    baseUrl: z.string().url().optional(),
    apiKeyEnv: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    dimensions: z.number().int().positive().optional(),
    batchSize: z.number().int().positive().optional(),
    requestTimeoutMs: z.number().int().positive().optional()
  })
});

const serviceSchema = z.object({
  database: z.object({
    url: z.string().optional(),
    urlEnv: z.string().optional(),
    pool: poolSchema
  }),
  embedding: z.object({
    provider: z.literal("openai-compatible"),
    baseUrl: z.string().url(),
    apiKeyEnv: z.string().min(1),
    model: z.string().min(1),
    dimensions: z.number().int().positive(),
    batchSize: z.number().int().positive().optional(),
    requestTimeoutMs: z.number().int().positive().optional()
  })
});

const projectSchema = z.object({
  projectId: z.string().min(1),
  name: z.string().optional(),
  // Optional, informational only. The server never reads project files.
  root: z.string().min(1).optional()
});

export async function loadRuntimeConfig(options: {
  serviceConfigPath?: string;
  projectConfigPath?: string;
} = {}): Promise<RuntimeConfig> {
  const servicePath =
    options.serviceConfigPath ??
    process.env.PROJECT_MEMORY_SERVICE_CONFIG ??
    "project-memory.service.json";
  const projectPath =
    options.projectConfigPath ??
    process.env.PROJECT_MEMORY_PROJECT_CONFIG ??
    process.env.PROJECT_MEMORY_CONFIG ??
    "project-memory.config.json";

  const service = applyServiceEnvOverrides(await readJson<RawServiceConfig>(servicePath, rawServiceSchema));
  const project = await readJson<ProjectConfig>(projectPath, projectSchema);
  return {
    service,
    project: resolveProjectRoot(project, projectPath)
  };
}

export async function loadProjectConfigs(projectConfigPaths?: string[]): Promise<ProjectConfig[]> {
  const rawPaths =
    projectConfigPaths ??
    process.env.PROJECT_MEMORY_PROJECT_CONFIGS?.split(",").map((item) => item.trim()).filter(Boolean) ??
    [
      process.env.PROJECT_MEMORY_PROJECT_CONFIG ??
        process.env.PROJECT_MEMORY_CONFIG ??
        "project-memory.config.json"
    ];
  const projects = [];
  for (const projectPath of rawPaths) {
    const project = await readJson<ProjectConfig>(projectPath, projectSchema);
    projects.push(resolveProjectRoot(project, projectPath));
  }
  return projects;
}

// `root` is optional and informational only. When present, resolve it relative
// to the config file's directory so the capability manifest reports a stable
// absolute path; when absent, leave it undefined.
function resolveProjectRoot(project: ProjectConfig, projectPath: string): ProjectConfig {
  if (!project.root) return project;
  return {
    ...project,
    root: path.resolve(path.dirname(path.resolve(projectPath)), project.root)
  };
}

type RawServiceConfig = z.infer<typeof rawServiceSchema>;

// Pool and timeout defaults. Conservative values that protect against a slow or
// flaky PostgreSQL / embedding API without surprising a healthy deployment.
const DEFAULT_POOL_MAX = 10;
const DEFAULT_POOL_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_POOL_CONNECTION_TIMEOUT_MS = 10_000;
const DEFAULT_EMBEDDING_REQUEST_TIMEOUT_MS = 30_000;

function applyServiceEnvOverrides(config: RawServiceConfig): ServiceConfig {
  const service = {
    database: {
      ...config.database,
      url: process.env.DATABASE_URL ?? config.database.url,
      pool: {
        max: numberFromEnv(process.env.DATABASE_POOL_MAX) ?? config.database.pool?.max ?? DEFAULT_POOL_MAX,
        idleTimeoutMillis:
          numberFromEnv(process.env.DATABASE_POOL_IDLE_TIMEOUT_MS) ??
          config.database.pool?.idleTimeoutMillis ??
          DEFAULT_POOL_IDLE_TIMEOUT_MS,
        connectionTimeoutMillis:
          numberFromEnv(process.env.DATABASE_POOL_CONNECTION_TIMEOUT_MS) ??
          config.database.pool?.connectionTimeoutMillis ??
          DEFAULT_POOL_CONNECTION_TIMEOUT_MS
      }
    },
    embedding: {
      ...config.embedding,
      baseUrl: process.env.EMBEDDING_BASE_URL ?? config.embedding.baseUrl,
      apiKeyEnv: process.env.EMBEDDING_API_KEY ? "EMBEDDING_API_KEY" : config.embedding.apiKeyEnv,
      model: process.env.EMBEDDING_MODEL ?? config.embedding.model,
      dimensions: process.env.EMBEDDING_DIMENSIONS
        ? Number(process.env.EMBEDDING_DIMENSIONS)
        : config.embedding.dimensions,
      batchSize: process.env.EMBEDDING_BATCH_SIZE
        ? Number(process.env.EMBEDDING_BATCH_SIZE)
        : config.embedding.batchSize,
      requestTimeoutMs:
        numberFromEnv(process.env.EMBEDDING_REQUEST_TIMEOUT_MS) ??
        config.embedding.requestTimeoutMs ??
        DEFAULT_EMBEDDING_REQUEST_TIMEOUT_MS
    }
  };

  return serviceSchema.parse(service);
}

// Parse a numeric env var, ignoring unset/blank/non-numeric values so a stray
// empty string never overrides a configured value with NaN.
function numberFromEnv(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function getDatabaseUrl(config: ServiceConfig): string {
  const url = config.database.url ?? (config.database.urlEnv ? process.env[config.database.urlEnv] : undefined);
  if (!url) {
    throw new Error("PostgreSQL URL is missing. Set database.url or database.urlEnv in the service config.");
  }
  return url;
}

export function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Required environment variable ${name} is not set.`);
  }
  return value;
}

async function readJson<T>(filePath: string, schema: z.ZodType<T>): Promise<T> {
  const absolutePath = path.resolve(filePath);
  const raw = await readFile(absolutePath, "utf8");
  return schema.parse(JSON.parse(raw));
}
