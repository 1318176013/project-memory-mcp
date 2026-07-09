import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";
import type { ServiceConfig } from "../config/types.js";
import { getDatabaseUrl } from "../config/loader.js";
import { logger } from "../utils/logger.js";

/** Directory containing SQL migrations, resolved relative to this module so it
 * is independent of the process working directory (CLI, MCP client, Docker, HTTP
 * server may all launch from different cwds). Exported for tests. */
export const migrationsDir = path.resolve(fileURLToPath(new URL("../../migrations", import.meta.url)));

export class Database {
  readonly pool: Pool;

  constructor(config: ServiceConfig) {
    const databaseUrl = getDatabaseUrl(config);
    logger.info("PostgreSQL pool initializing", {
      target: describeDatabaseUrl(databaseUrl),
      max: config.database.pool?.max,
      idleTimeoutMillis: config.database.pool?.idleTimeoutMillis,
      connectionTimeoutMillis: config.database.pool?.connectionTimeoutMillis
    });
    this.pool = new Pool({
      connectionString: databaseUrl,
      max: config.database.pool?.max,
      idleTimeoutMillis: config.database.pool?.idleTimeoutMillis,
      connectionTimeoutMillis: config.database.pool?.connectionTimeoutMillis
    });
    // A pool-level 'error' listener is required: without it, an error emitted by
    // an idle client (e.g. PostgreSQL closing the connection) crashes the
    // process. Log and let pg evict the dead client; the next query reconnects.
    this.pool.on("error", (error) => {
      logger.error(`Idle PostgreSQL client error: ${error.message}`);
    });
  }

  async migrate(): Promise<void> {
    // Run every migration in lexical order. Each file is idempotent (uses
    // CREATE TABLE IF NOT EXISTS / ALTER ... IF NOT EXISTS / guarded DROP), so
    // re-running the full set on an already-migrated DB is safe.
    const dir = await readdir(migrationsDir);
    const files = dir.filter((file) => file.endsWith(".sql")).sort();
    logger.info("Database migrations started", { migrationsDir, count: files.length });
    for (const file of files) {
      const startedAt = Date.now();
      const migration = await readFile(path.resolve(migrationsDir, file), "utf8");
      await this.pool.query(migration);
      logger.info("Database migration applied", { file, elapsedMs: Date.now() - startedAt });
    }
    logger.info("Database migrations completed", { count: files.length });
  }

  async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function describeDatabaseUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}${url.pathname}`;
  } catch {
    return "<unparseable database url>";
  }
}
