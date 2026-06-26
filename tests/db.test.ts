import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { migrationsDir } from "../src/stores/db.js";

test("migrationsDir resolves to the repo migrations folder regardless of cwd", async () => {
  // Run from an unrelated working directory (the temp dir) to prove the path is
  // not relative to process.cwd(). Previously it used path.resolve("migrations/...")
  // which broke when launched via MCP clients or Docker from a different cwd.
  const originalCwd = process.cwd();
  const tmpDir = await import("node:os").then((os) => os.tmpdir());
  process.chdir(tmpDir);
  try {
    assert.ok(
      path.isAbsolute(migrationsDir),
      `migrationsDir must be absolute, got: ${migrationsDir}`
    );
    assert.ok(
      !migrationsDir.startsWith(tmpDir),
      `migrationsDir must not resolve under the temp cwd, got: ${migrationsDir}`
    );
    const migrationFile = path.join(migrationsDir, "001_init.sql");
    assert.ok(existsSync(migrationFile), `migration file not found at ${migrationFile}`);
    assert.ok(statSync(migrationFile).isFile(), "migration file is not a regular file");

    const sql = readFileSync(migrationFile, "utf8");
    assert.match(sql, /CREATE TABLE IF NOT EXISTS memories/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS confidence_feedback/);
  } finally {
    process.chdir(originalCwd);
  }
});