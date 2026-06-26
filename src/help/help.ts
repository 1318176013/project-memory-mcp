import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The `help` MCP tool and the GET /help HTTP endpoint both return the payload
// built here. It targets an agent that has just connected to a running server
// and needs to know: which tool to call first, the call order, how to pass
// arguments, where projectId comes from, and how to wire the current project
// into the auto-memory workflow (the read-side CLAUDE.md guidance + the
// write-side Stop hook).
//
// The three scaffold files are kept verbatim under ./templates and read at
// runtime, so there is a single source of truth: edit the template, not a
// duplicated string. `pnpm build` copies ./templates into dist/help/templates.

// Directory holding the scaffold templates, resolved relative to this module so
// it works from both src (tsx) and dist (node) without depending on the CWD.
const templatesDir = path.resolve(fileURLToPath(new URL("./templates", import.meta.url)));

async function readTemplate(...segments: string[]): Promise<string> {
  return readFile(path.resolve(templatesDir, ...segments), "utf8");
}

export type HelpToolArg = {
  tool: string;
  purpose: string;
  args: string;
};

export type HelpFile = {
  recommendedPath: string;
  purpose: string;
  content: string;
};

export async function buildHelp() {
  const [claudeMd, settingsJson, memorySink] = await Promise.all([
    readTemplate("CLAUDE.md"),
    readTemplate("settings.json"),
    readTemplate("hooks", "memory-sink.cjs")
  ]);

  return {
    name: "project-memory-mcp",
    version: "0.1.0",
    summary:
      "Project memory server: semantic retrieval over manual memories with confidence feedback. Every project-scoped tool requires a projectId. Clients contribute knowledge via add_memory.",

    // What an agent should do right after connecting.
    start_here: [
      "1. Call `health_check` (no args) to confirm PostgreSQL and the embedding API are reachable.",
      "2. Call `register_project` once to obtain a server-generated `projectId`. Reuse it for the whole project; do not register again every session.",
      "3. Pass that `projectId` to every project-scoped tool. Results are strictly isolated per projectId.",
      "4. Retrieve with `search_knowledge` (ranked memory hits).",
      "5. Contribute durable knowledge with `add_memory`; correct or challenge it with `record_confidence_feedback`.",
      "6. To make a project remember automatically across sessions, install the auto-memory scaffold below."
    ],

    projectId: {
      whatItIs: "An opaque id that scopes all retrieval, memory, and confidence data.",
      howToGet: "Returned by `register_project`. There is no other way to mint one; the server generates it.",
      howToUse: "Pass it as the `projectId` argument to every project-scoped tool. A wrong/unknown projectId simply returns empty, isolated results.",
      persistInProject: "Store it in a `.project-memory` JSON file at the project root (e.g. {\"projectId\": \"...\"}) so the auto-memory hook and CLAUDE.md guidance can read it."
    },

    // One line per tool: what it does and the argument shape. The authoritative
    // schemas live in the registered MCP tools (src/mcp/server.ts).
    tools: [
      { tool: "help", purpose: "This guide. Call order, arguments, projectId, and the auto-memory scaffold.", args: "{}" },
      { tool: "health_check", purpose: "Confirm PostgreSQL and embedding API are up.", args: "{}" },
      { tool: "register_project", purpose: "Get a projectId (once per project).", args: "{ name?: string }" },
      { tool: "search_knowledge", purpose: "Ranked memory hits.", args: "{ projectId, query, topK?: number }" },
      { tool: "add_memory", purpose: "Persist a decision/convention/pattern/gotcha for future retrieval.", args: "{ projectId, title, content, kind?: string, tags?: string[], source?: string, allowDuplicate?: boolean }" },
      { tool: "list_memories", purpose: "List memories with optional archived/kind/tag filters.", args: "{ projectId, includeArchived?: boolean, kind?: string, tag?: string, limit?: number }" },
      { tool: "update_memory", purpose: "Update a memory and refresh its embedding.", args: "{ projectId, id, title?, content?, kind?, tags?, source? }" },
      { tool: "archive_memory", purpose: "Archive a memory so it no longer appears in search results.", args: "{ projectId, id }" },
      { tool: "record_confidence_feedback", purpose: "Up/down-weight a memory based on evidence.", args: "{ projectId, targetId, signal: 'support'|'confirm'|'dispute'|'contradict'|'obsolete'|'uncertain', weight?, agentId?, rationale?, evidence? }" },
      { tool: "get_confidence", purpose: "Read computed confidence for a memory.", args: "{ projectId, targetId }" },
      { tool: "list_confidence_feedback", purpose: "List feedback records for audit.", args: "{ projectId, targetId?, limit? }" },
      { tool: "list_suspect_confidence", purpose: "List suspect or rejected memories.", args: "{ projectId }" }
    ] satisfies HelpToolArg[],

    // The scaffold that turns a Claude Code project into one that reads memory
    // before a task and writes memory after a task automatically.
    auto_memory_setup: {
      whatItDoes:
        "Wires a Claude Code project into project-memory: before a task the agent searches existing memory (read side), after a task with code edits a Stop hook prompts the agent to persist new knowledge (write side).",
      recommendedLayout:
        "Recommended: install the three files once under the global ~/.claude/ so all projects share them, and put a per-project .project-memory at each project root holding that project's projectId. A project may instead place CLAUDE.md/settings.json under its own .claude/ if it does not want the global install — the choice is up to each project.",
      files: [
        {
          recommendedPath: "~/.claude/CLAUDE.md",
          purpose: "Read side: instructs the agent to read .project-memory for the projectId and search_knowledge before any non-trivial task (new features included, not just changes to existing functionality).",
          content: claudeMd
        },
        {
          recommendedPath: "~/.claude/settings.json",
          purpose: "Registers the Stop hook. NOTE: the `command` path must point at the actual install location of memory-sink.cjs (shown here as an absolute path); update it to where you placed the file, e.g. ~/.claude/hooks/memory-sink.cjs.",
          content: settingsJson
        },
        {
          recommendedPath: "~/.claude/hooks/memory-sink.cjs",
          purpose: "Write side: on Stop, if the turn made code edits and the project root has a .project-memory, it blocks once and asks the agent to persist knowledge via add_memory/update_memory. Use the .cjs extension so it always loads as CommonJS.",
          content: memorySink
        },
        {
          recommendedPath: "<project-root>/.project-memory",
          purpose: "Per-project marker holding the projectId from register_project. The hook and CLAUDE.md read it; if absent, auto-memory simply stays off for that project.",
          content: "{\n  \"projectId\": \"<projectId from register_project>\"\n}\n"
        }
      ]
    },

    http_endpoints: {
      root: "GET /            capability manifest",
      help: "GET /help        this guide",
      health: "GET /health      dependency health",
      status: "GET /status      dependency health",
      tools: "GET /tools       tool names and descriptions",
      mcp: "POST /mcp        MCP Streamable HTTP endpoint"
    }
  };
}

export type Help = Awaited<ReturnType<typeof buildHelp>>;
