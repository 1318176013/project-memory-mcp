import type { AppContext } from "../app.js";

export async function healthCheck(app: AppContext): Promise<{
  ok: boolean;
  checks: Record<string, { ok: boolean; message?: string }>;
}> {
  const checks: Record<string, { ok: boolean; message?: string }> = {};

  try {
    await app.db.pool.query("SELECT 1");
    checks.postgres = { ok: true };
  } catch (error) {
    checks.postgres = { ok: false, message: errorMessage(error) };
  }

  try {
    const result = await app.embeddingProvider.embed({ text: "health check" });
    checks.embedding = {
      ok: result.dimensions === app.config.service.embedding.dimensions,
      message:
        result.dimensions === app.config.service.embedding.dimensions
          ? undefined
          : `Expected ${app.config.service.embedding.dimensions}, got ${result.dimensions}`
    };
  } catch (error) {
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
