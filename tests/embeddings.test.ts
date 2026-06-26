import test, { mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { OpenAICompatibleEmbeddingProvider } from "../src/embeddings/openai-compatible.js";
import type { ServiceConfig } from "../src/config/types.js";

// The provider reads its key from this env var at construction time.
process.env.EMBEDDING_API_KEY = "test-key";

function baseConfig(overrides: Partial<ServiceConfig["embedding"]> = {}): ServiceConfig["embedding"] {
  return {
    provider: "openai-compatible",
    baseUrl: "https://embeddings.local/v1",
    apiKeyEnv: "EMBEDDING_API_KEY",
    model: "text-embedding-3-small",
    dimensions: 3,
    ...overrides
  };
}

// Build an OpenAI-style embeddings response. Returns embeddings out of order to
// prove the provider re-sorts by `index`.
function embeddingResponse(vectors: number[][]) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      model: "text-embedding-3-small",
      data: vectors
        .map((embedding, index) => ({ embedding, index }))
        .reverse()
    })
  } as unknown as Response;
}

afterEach(() => {
  mock.restoreAll();
});

test("embed returns the vector for a single input", async () => {
  const fetchMock = mock.method(globalThis, "fetch", async () => embeddingResponse([[0.1, 0.2, 0.3]]));
  const provider = new OpenAICompatibleEmbeddingProvider(baseConfig());

  const result = await provider.embed({ text: "hello" });

  assert.deepEqual(result.vector, [0.1, 0.2, 0.3]);
  assert.equal(result.dimensions, 3);
  assert.equal(result.model, "text-embedding-3-small");
  assert.equal(fetchMock.mock.callCount(), 1);
});

test("embed re-sorts results by index", async () => {
  // Response is reversed inside embeddingResponse; the provider must restore order.
  mock.method(globalThis, "fetch", async () =>
    embeddingResponse([
      [1, 0, 0],
      [0, 1, 0]
    ])
  );
  const provider = new OpenAICompatibleEmbeddingProvider(baseConfig());

  const results = await provider.embedBatch([{ text: "a" }, { text: "b" }]);

  assert.deepEqual(results[0].vector, [1, 0, 0]);
  assert.deepEqual(results[1].vector, [0, 1, 0]);
});

test("embedBatch chunks inputs by batchSize", async () => {
  const fetchMock = mock.method(globalThis, "fetch", async (_url: unknown, init: unknown) => {
    const body = JSON.parse((init as { body: string }).body) as { input: string[] };
    return embeddingResponse(body.input.map(() => [0, 0, 1]));
  });
  const provider = new OpenAICompatibleEmbeddingProvider(baseConfig({ batchSize: 2 }));

  const results = await provider.embedBatch([{ text: "a" }, { text: "b" }, { text: "c" }]);

  assert.equal(results.length, 3);
  // 3 inputs, batchSize 2 -> two HTTP calls.
  assert.equal(fetchMock.mock.callCount(), 2);
});

test("embed throws on a non-ok response", async () => {
  mock.method(globalThis, "fetch", async () => ({
    ok: false,
    status: 429,
    text: async () => "rate limited"
  }) as unknown as Response);
  const provider = new OpenAICompatibleEmbeddingProvider(baseConfig());

  await assert.rejects(() => provider.embed({ text: "x" }), /Embedding API failed with 429/);
});

test("embed throws on a dimension mismatch", async () => {
  // config says 3 dimensions; API returns 2.
  mock.method(globalThis, "fetch", async () => embeddingResponse([[0.1, 0.2]]));
  const provider = new OpenAICompatibleEmbeddingProvider(baseConfig());

  await assert.rejects(() => provider.embed({ text: "x" }), /dimensions mismatch/);
});

test("embed surfaces a clear timeout error", async () => {
  // Simulate AbortSignal.timeout firing: fetch rejects with a TimeoutError.
  mock.method(globalThis, "fetch", async () => {
    const error = new Error("The operation timed out");
    error.name = "TimeoutError";
    throw error;
  });
  const provider = new OpenAICompatibleEmbeddingProvider(baseConfig({ requestTimeoutMs: 5 }));

  await assert.rejects(() => provider.embed({ text: "x" }), /Embedding API timed out after 5ms/);
});
