import type { AppContext } from "../app.js";
import { logger } from "../utils/logger.js";

export async function healthCheck(app: AppContext): Promise<{
  ok: boolean;
  checks: Record<string, { ok: boolean; message?: string }>;
}> {
  const checks: Record<string, { ok: boolean; message?: string }> = {};

  try {
    const startedAt = Date.now();
    logger.info("Health check postgres started");
    await app.db.pool.query("SELECT 1");
    logger.info("Health check postgres completed", { elapsedMs: Date.now() - startedAt });
    checks.postgres = { ok: true };
  } catch (error) {
    logger.error("Health check postgres failed", { error: errorMessage(error) });
    checks.postgres = { ok: false, message: errorMessage(error) };
  }

  try {
    const startedAt = Date.now();
    logger.info("Health check embedding started", {
      model: app.config.service.embedding.model,
      expectedDimensions: app.config.service.embedding.dimensions
    });
    const result = await app.embeddingProvider.embed({ text: "health check" });
    logger.info("Health check embedding completed", {
      model: result.model,
      dimensions: result.dimensions,
      elapsedMs: Date.now() - startedAt
    });
    checks.embedding = {
      ok: result.dimensions === app.config.service.embedding.dimensions,
      message:
        result.dimensions === app.config.service.embedding.dimensions
          ? undefined
          : `Expected ${app.config.service.embedding.dimensions}, got ${result.dimensions}`
    };
  } catch (error) {
    logger.error("Health check embedding failed", { error: errorMessage(error) });
    checks.embedding = { ok: false, message: errorMessage(error) };
  }

  return {
    ok: Object.values(checks).every((check) => check.ok),
    checks
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
