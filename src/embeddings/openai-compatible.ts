import type { ServiceConfig } from "../config/types.js";
import { getRequiredEnv } from "../config/loader.js";
import type { EmbeddingInput, EmbeddingProvider, EmbeddingResult } from "./provider.js";

type EmbeddingResponse = {
  data: Array<{ embedding: number[]; index: number }>;
  model?: string;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  private readonly apiKey: string;
  private readonly batchSize: number;
  private readonly requestTimeoutMs: number;

  constructor(private readonly config: ServiceConfig["embedding"]) {
    this.apiKey = getRequiredEnv(config.apiKeyEnv);
    this.batchSize = config.batchSize ?? 64;
    this.requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  async embed(input: EmbeddingInput): Promise<EmbeddingResult> {
    const [result] = await this.embedBatch([input]);
    return result;
  }

  async embedBatch(inputs: EmbeddingInput[]): Promise<EmbeddingResult[]> {
    const results: EmbeddingResult[] = [];
    for (let i = 0; i < inputs.length; i += this.batchSize) {
      const batch = inputs.slice(i, i + this.batchSize);
      results.push(...(await this.embedBatchOnce(batch)));
    }
    return results;
  }

  private async embedBatchOnce(inputs: EmbeddingInput[]): Promise<EmbeddingResult[]> {
    if (inputs.length === 0) return [];

    // Bound the request so a hung embedding API cannot block add/update/search
    // indefinitely. AbortSignal.timeout fires an AbortError after the deadline;
    // surface it as a clear, actionable message.
    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl.replace(/\/$/, "")}/embeddings`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: this.config.model,
          input: inputs.map((input) => input.text)
        }),
        signal: AbortSignal.timeout(this.requestTimeoutMs)
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new Error(`Embedding API timed out after ${this.requestTimeoutMs}ms`);
      }
      throw error;
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Embedding API failed with ${response.status}: ${text}`);
    }

    const payload = (await response.json()) as EmbeddingResponse;
    const byIndex = [...payload.data].sort((a, b) => a.index - b.index);
    return byIndex.map((item) => {
      if (item.embedding.length !== this.config.dimensions) {
        throw new Error(
          `Embedding dimensions mismatch: expected ${this.config.dimensions}, got ${item.embedding.length}`
        );
      }
      return {
        vector: item.embedding,
        model: payload.model ?? this.config.model,
        provider: this.config.provider,
        dimensions: item.embedding.length
      };
    });
  }
}
