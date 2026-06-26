import type { RuntimeConfig } from "./config/types.js";
import { Database } from "./stores/db.js";
import { OpenAICompatibleEmbeddingProvider } from "./embeddings/openai-compatible.js";

export function createApp(config: RuntimeConfig) {
  const db = new Database(config.service);
  const embeddingProvider = new OpenAICompatibleEmbeddingProvider(config.service.embedding);
  return { config, db, embeddingProvider };
}

export type AppContext = ReturnType<typeof createApp>;
