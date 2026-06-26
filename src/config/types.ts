export type ServiceConfig = {
  database: {
    url?: string;
    urlEnv?: string;
    // Connection-pool tuning. All optional; loader fills defaults. Guards
    // against a slow/flaky PostgreSQL hanging requests or exhausting the pool.
    pool?: {
      max?: number;
      idleTimeoutMillis?: number;
      connectionTimeoutMillis?: number;
    };
  };
  embedding: {
    provider: "openai-compatible";
    baseUrl: string;
    apiKeyEnv: string;
    model: string;
    dimensions: number;
    batchSize?: number;
    // Per-request timeout (ms) for the embedding HTTP call. A hung embedding
    // API would otherwise block add/update/search indefinitely.
    requestTimeoutMs?: number;
  };
};

export type ProjectConfig = {
  projectId: string;
  name?: string;
  // Optional, informational only. Retrieval isolation is keyed solely on
  // projectId; the server never reads project files (indexing was removed).
  root?: string;
};

export type RuntimeConfig = {
  service: ServiceConfig;
  project: ProjectConfig;
};
