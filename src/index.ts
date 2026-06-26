#!/usr/bin/env node
import { loadRuntimeConfig } from "./config/loader.js";
import { createApp } from "./app.js";
import { runStdioServer } from "./mcp/server.js";
import { logger } from "./utils/logger.js";

try {
  const config = await loadRuntimeConfig();
  const app = createApp(config);
  // Converge the schema once at startup. Migrations are idempotent, so this is
  // safe on every boot; write operations no longer migrate per call.
  await app.db.migrate();
  await runStdioServer(app);
} catch (error) {
  logger.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
