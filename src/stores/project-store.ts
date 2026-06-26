import type { Pool, PoolClient } from "pg";
import { newId } from "../utils/ids.js";
import type { ProjectConfig } from "../config/types.js";

export async function upsertProject(db: Pool | PoolClient, project: ProjectConfig): Promise<void> {
  await db.query(
    `INSERT INTO projects (id, name, root_path, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (id)
     DO UPDATE SET name = EXCLUDED.name, root_path = COALESCE(EXCLUDED.root_path, projects.root_path), updated_at = now()`,
    [project.projectId, project.name ?? project.projectId, project.root ?? null]
  );
}

/**
 * Register a project by id only, with no filesystem root. Used by the
 * register_project tool so a caller can obtain a projectId for retrieval
 * isolation without pointing at a local codebase. Returns the generated id.
 */
export async function registerProject(
  db: Pool | PoolClient,
  input: { projectId?: string; name?: string }
): Promise<{ projectId: string; name: string }> {
  const projectId = input.projectId ?? newId("proj");
  const name = input.name ?? projectId;
  await db.query(
    `INSERT INTO projects (id, name, root_path, updated_at)
     VALUES ($1, $2, NULL, now())
     ON CONFLICT (id)
     DO UPDATE SET name = EXCLUDED.name, updated_at = now()`,
    [projectId, name]
  );
  return { projectId, name };
}

/**
 * Ensure a projects row exists for the given id without overwriting an existing
 * row (in particular, never clobber an existing name/root_path). Used by memory
 * and confidence writes that reference a projectId which may have been obtained
 * via register_project and therefore have no config-file backing.
 */
export async function ensureProjectRow(db: Pool | PoolClient, projectId: string): Promise<void> {
  await db.query(
    `INSERT INTO projects (id, name, root_path, updated_at)
     VALUES ($1, $1, NULL, now())
     ON CONFLICT (id) DO NOTHING`,
    [projectId]
  );
}
