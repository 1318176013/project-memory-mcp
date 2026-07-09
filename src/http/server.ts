#!/usr/bin/env node
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createApp } from "../app.js";
import { loadProjectConfigs, loadRuntimeConfig } from "../config/loader.js";
import { healthCheck } from "../health/check.js";
import { createMcpServer } from "../mcp/server.js";
import { toolManifest } from "../mcp/tool-manifest.js";
import { buildHelp } from "../help/help.js";
import { logger } from "../utils/logger.js";
import { listMemories } from "../memory/memory-manager.js";
import { listFeedback, listSuspectConfidence } from "../confidence/confidence-manager.js";

const config = await loadRuntimeConfig();
const projects = await loadProjectConfigs();
const app = createApp(config);
logger.info("HTTP app config loaded", {
  projectId: config.project.projectId,
  projectCount: projects.length,
  embeddingProvider: config.service.embedding.provider,
  embeddingBaseUrl: config.service.embedding.baseUrl,
  embeddingModel: config.service.embedding.model,
  embeddingDimensions: config.service.embedding.dimensions,
  embeddingBatchSize: config.service.embedding.batchSize
});
// Converge the schema once before accepting connections. Migrations are
// idempotent, so this is safe on every boot; request handlers no longer migrate
// per call.
await app.db.migrate();
const port = Number(process.env.PROJECT_MEMORY_HTTP_PORT ?? 8788);
const host = process.env.PROJECT_MEMORY_HTTP_HOST ?? "127.0.0.1";
const token = process.env.PROJECT_MEMORY_HTTP_TOKEN;
const transports = new Map<string, StreamableHTTPServerTransport>();

const server = http.createServer(async (request, response) => {
  const startedAt = Date.now();
  response.on("finish", () => {
    logger.info("HTTP request completed", {
      method: request.method,
      path: request.url?.split("?")[0] ?? "/",
      statusCode: response.statusCode,
      elapsedMs: Date.now() - startedAt
    });
  });
  try {
    await route(request, response);
  } catch (error) {
    logger.error("HTTP request failed", {
      method: request.method,
      path: request.url?.split("?")[0] ?? "/",
      elapsedMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error)
    });
    json(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, host, () => {
  if (!token && host !== "127.0.0.1" && host !== "localhost") {
    logger.warn("HTTP server is running without PROJECT_MEMORY_HTTP_TOKEN on a non-localhost host.");
  }
  logger.info(`HTTP server listening on http://${host}:${port}`);
});

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${host}:${port}`);
  const projectId = url.searchParams.get("projectId") ?? config.project.projectId;

  // The MCP endpoint is exempt from bearer-token enforcement and handled before
  // the auth gate below. MCP Streamable HTTP clients (Claude Code, Codex) do not
  // reliably forward custom headers on every request during the
  // initialize/session handshake, so enforcing the token here would drop the
  // connection in ways that are hard to diagnose. In the trusted deployment this
  // server targets, /mcp is reachable without a token; the token still guards
  // the read-only REST endpoints below.
  if (url.pathname === "/mcp") {
    await handleMcp(request, response);
    return;
  }

  if (url.pathname !== "/health" && !isAuthorized(request)) {
    json(response, 401, {
      error: "Unauthorized",
      message: "Set Authorization: Bearer <PROJECT_MEMORY_HTTP_TOKEN>."
    });
    return;
  }

  if (request.method !== "GET") {
    json(response, 405, { error: "Method not allowed" });
    return;
  }

  if (url.pathname === "/") {
    json(response, 200, capabilities());
    return;
  }

  if (url.pathname === "/health") {
    const result = await healthCheck(app);
    json(response, result.ok ? 200 : 503, result);
    return;
  }

  if (url.pathname === "/status") {
    json(response, 200, {
      health: await healthCheck(app)
    });
    return;
  }

  if (url.pathname === "/tools") {
    json(response, 200, { tools: toolManifest });
    return;
  }

  if (url.pathname === "/help") {
    json(response, 200, await buildHelp());
    return;
  }

  if (url.pathname === "/memories") {
    json(response, 200, await listMemories({
      ...app,
      projectId,
      includeArchived: url.searchParams.get("includeArchived") === "true",
      kind: url.searchParams.get("kind") ?? undefined,
      tag: url.searchParams.get("tag") ?? undefined,
      limit: Number(url.searchParams.get("limit") ?? 50)
    }));
    return;
  }

  if (url.pathname === "/confidence/suspect") {
    json(response, 200, await listSuspectConfidence({ ...app, projectId }));
    return;
  }

  if (url.pathname === "/confidence/feedback") {
    json(response, 200, await listFeedback({
      ...app,
      projectId,
      targetId: url.searchParams.get("targetId") ?? undefined,
      limit: Number(url.searchParams.get("limit") ?? 50)
    }));
    return;
  }

  json(response, 404, { error: "Not found" });
}

async function handleMcp(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const sessionId = request.headers["mcp-session-id"];
  const existingSessionId = Array.isArray(sessionId) ? sessionId[0] : sessionId;
  const body = request.method === "POST" ? await readJsonBody(request) : undefined;

  // A request that carries a known session id is routed to that transport,
  // regardless of method: POST (requests/notifications), GET (server-driven SSE
  // stream), or DELETE (session shutdown).
  if (existingSessionId && transports.has(existingSessionId)) {
    await transports.get(existingSessionId)!.handleRequest(request, response, body);
    return;
  }

  // A POST with no session id and an initialize body starts a new session.
  if (request.method === "POST" && !existingSessionId && isInitializeRequest(body)) {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (newSessionId) => {
        transports.set(newSessionId, transport);
      }
    });
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id) transports.delete(id);
    };
    await createMcpServer(app).connect(transport);
    await transport.handleRequest(request, response, body);
    return;
  }

  // Anything else (GET without a session, DELETE of an unknown session, a stray
  // POST that is not initialize) is handed to a one-off stateless transport so
  // the SDK returns the protocol-correct error (400 "session id required",
  // 404 "session not found") instead of a hand-rolled JSON shape.
  const ephemeral = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await ephemeral.handleRequest(request, response, body);
}

function capabilities() {
  return {
    name: "project-memory-mcp",
    version: "0.1.0",
    projectId: config.project.projectId,
    projects: projects.map((project) => ({
      projectId: project.projectId,
      name: project.name ?? project.projectId,
      root: project.root
    })),
    description: "Project memory MCP server with semantic memory retrieval, memory management, and confidence feedback.",
    transport: {
      stdio: "node dist/index.js",
      streamableHttp: "/mcp"
    },
    endpoints: {
      root: "/",
      help: "/help",
      mcp: "/mcp",
      health: "/health",
      status: "/status",
      tools: "/tools",
      memories: "/memories",
      confidenceSuspect: "/confidence/suspect",
      confidenceFeedback: "/confidence/feedback"
    },
    tools: toolManifest
  };
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value, null, 2));
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return undefined;
  return JSON.parse(raw);
}

function isAuthorized(request: IncomingMessage): boolean {
  if (!token) return true;
  const expected = `Bearer ${token}`;
  // timingSafeEqual throws on mismatched Buffer lengths, so compare lengths with
  // a constant-time-friendly check first. Trim the header so trailing whitespace
  // never causes a spurious failure.
  const received = (request.headers.authorization ?? "").trim();
  if (received.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}
