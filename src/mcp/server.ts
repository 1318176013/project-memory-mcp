import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { AppContext } from "../app.js";
import { searchKnowledge } from "../query/retriever.js";
import { addMemory } from "../memory/add-memory.js";
import { archiveMemory, listMemories, updateMemory } from "../memory/memory-manager.js";
import { registerProject } from "../stores/project-store.js";
import { healthCheck } from "../health/check.js";
import { listFeedback, listSuspectConfidence, readConfidence, submitConfidenceFeedback } from "../confidence/confidence-manager.js";
import { buildHelp } from "../help/help.js";

const confidenceSignalSchema = z.enum(["support", "confirm", "dispute", "contradict", "obsolete", "uncertain"]);

export function createMcpServer(app: AppContext): McpServer {
  const server = new McpServer({
    name: "project-memory-mcp",
    version: "0.1.0"
  });

  server.registerTool(
    "help",
    {
      title: "Help",
      description:
        "Start here. Returns a guide for using this server: which tool to call first, the call order and arguments, how projectId works, and the scaffold (files + contents) to wire a project into the auto-memory workflow. Takes no arguments.",
      inputSchema: {}
    },
    async () => jsonResult(await buildHelp())
  );

  server.registerTool(
    "record_confidence_feedback",
    {
      title: "Record Confidence Feedback",
      description: "Let an agent submit positive or negative evidence about a memory. The server recomputes its confidence and status. Requires projectId; the memory must belong to that project.",
      inputSchema: {
        projectId: z.string(),
        targetId: z.string(),
        signal: confidenceSignalSchema,
        weight: z.number().positive().max(5).optional(),
        agentId: z.string().optional(),
        rationale: z.string().optional(),
        evidence: z.record(z.unknown()).optional()
      }
    },
    async ({ projectId, targetId, signal, weight, agentId, rationale, evidence }) =>
      jsonResult(
        await submitConfidenceFeedback({
          ...app,
          projectId,
          targetId,
          signal,
          weight,
          agentId,
          rationale,
          evidence
        })
      )
  );

  server.registerTool(
    "get_confidence",
    {
      title: "Get Confidence",
      description: "Read the confidence summary for a memory. Requires projectId; the memory must belong to that project.",
      inputSchema: {
        projectId: z.string(),
        targetId: z.string()
      }
    },
    async ({ projectId, targetId }) => jsonResult(await readConfidence({ ...app, projectId, targetId }))
  );

  server.registerTool(
    "list_confidence_feedback",
    {
      title: "List Confidence Feedback",
      description: "List confidence feedback records for audit. Requires projectId; results are scoped to that project.",
      inputSchema: {
        projectId: z.string(),
        targetId: z.string().optional(),
        limit: z.number().int().positive().optional()
      }
    },
    async ({ projectId, targetId, limit }) => jsonResult(await listFeedback({ ...app, projectId, targetId, limit }))
  );

  server.registerTool(
    "list_suspect_confidence",
    {
      title: "List Suspect Confidence",
      description: "List suspect or rejected memories. Requires projectId; results are scoped to that project.",
      inputSchema: {
        projectId: z.string()
      }
    },
    async ({ projectId }) => jsonResult(await listSuspectConfidence({ ...app, projectId }))
  );

  server.registerTool(
    "health_check",
    {
      title: "Health Check",
      description: "Check PostgreSQL and embedding API connectivity.",
      inputSchema: {}
    },
    async () => jsonResult(await healthCheck(app))
  );

  server.registerTool(
    "register_project",
    {
      title: "Register Project",
      description: "Register a project and obtain a projectId. The projectId is server-generated and returned; use it as the projectId argument for search_knowledge, add_memory, and other project-scoped tools. No filesystem root is required — retrieval isolation is keyed solely on projectId.",
      inputSchema: {
        name: z.string().optional()
      }
    },
    async ({ name }) => jsonResult(await registerProject(app.db.pool, { name }))
  );

  server.registerTool(
    "search_knowledge",
    {
      title: "Search Knowledge",
      description: "Semantic search over manual project memories. Requires a projectId registered via register_project; results are strictly scoped to that project.",
      inputSchema: {
        projectId: z.string(),
        query: z.string(),
        topK: z.number().int().positive().optional()
      }
    },
    async ({ projectId, query, topK }) => jsonResult(await searchKnowledge({ ...app, projectId, query, topK }))
  );

  server.registerTool(
    "add_memory",
    {
      title: "Add Memory",
      description: "Add a manual project memory and index it for semantic search. Requires projectId; the memory is scoped to that project.",
      inputSchema: {
        projectId: z.string(),
        title: z.string(),
        content: z.string(),
        kind: z.string().default("note"),
        tags: z.array(z.string()).optional(),
        source: z.string().optional(),
        allowDuplicate: z.boolean().optional()
      }
    },
    async ({ projectId, title, content, kind, tags, source, allowDuplicate }) =>
      jsonResult(await addMemory({ ...app, projectId, title, content, kind, tags, source, allowDuplicate }))
  );

  server.registerTool(
    "list_memories",
    {
      title: "List Memories",
      description: "List manual memories. Requires projectId; results are scoped to that project.",
      inputSchema: {
        projectId: z.string(),
        includeArchived: z.boolean().optional(),
        kind: z.string().optional(),
        tag: z.string().optional(),
        limit: z.number().int().positive().optional()
      }
    },
    async ({ projectId, includeArchived, kind, tag, limit }) =>
      jsonResult(await listMemories({ ...app, projectId, includeArchived, kind, tag, limit }))
  );

  server.registerTool(
    "update_memory",
    {
      title: "Update Memory",
      description: "Update a memory and refresh its embedding. Requires projectId; the memory must belong to that project.",
      inputSchema: {
        projectId: z.string(),
        id: z.string(),
        title: z.string().optional(),
        content: z.string().optional(),
        kind: z.string().optional(),
        tags: z.array(z.string()).optional(),
        source: z.string().optional()
      }
    },
    async ({ projectId, id, title, content, kind, tags, source }) =>
      jsonResult(await updateMemory({ ...app, projectId, id, title, content, kind, tags, source }))
  );

  server.registerTool(
    "archive_memory",
    {
      title: "Archive Memory",
      description: "Archive a memory so it no longer appears in search results. Requires projectId; the memory must belong to that project.",
      inputSchema: {
        projectId: z.string(),
        id: z.string()
      }
    },
    async ({ projectId, id }) => jsonResult(await archiveMemory({ ...app, projectId, id }))
  );

  return server;
}

export async function runStdioServer(app: AppContext): Promise<void> {
  const server = createMcpServer(app);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function jsonResult(value: unknown) {
  const text = JSON.stringify(value, null, 2);
  const structuredContent =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { value };
  return {
    content: [{ type: "text" as const, text }],
    structuredContent
  };
}
