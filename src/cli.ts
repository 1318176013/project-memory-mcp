#!/usr/bin/env node
import { Command } from "commander";
import { loadRuntimeConfig } from "./config/loader.js";
import { createApp } from "./app.js";
import { searchKnowledge } from "./query/retriever.js";
import { addMemory } from "./memory/add-memory.js";
import { archiveMemory, listMemories, updateMemory } from "./memory/memory-manager.js";
import { healthCheck } from "./health/check.js";
import { listFeedback, listSuspectConfidence, readConfidence, submitConfidenceFeedback } from "./confidence/confidence-manager.js";

const program = new Command();

program
  .name("project-memory")
  .description("Project memory MCP helper CLI")
  .option("-s, --service-config <path>", "service config path")
  .option("-p, --project-config <path>", "project config path");

program.command("migrate").action(async () => {
  const app = await appFromOptions();
  await app.db.migrate();
  await app.db.close();
  console.log("Migrations applied (pgvector extension and memory embedding column ensured).");
});

program.command("health").action(async () => {
  const app = await appFromOptions();
  const result = await healthCheck(app);
  await app.db.close();
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
});

program
  .command("search")
  .argument("<query>")
  .option("-k, --top-k <n>", "number of results", parseInt)
  .action(async (query: string, options: { topK?: number }) => {
    const app = await appFromOptions();
    const result = await searchKnowledge({ ...app, projectId: app.config.project.projectId, query, topK: options.topK });
    await app.db.close();
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("add-memory")
  .requiredOption("--title <title>", "memory title")
  .requiredOption("--content <content>", "memory content")
  .option("--kind <kind>", "memory kind", "note")
  .option("--tags <tags>", "comma-separated tags")
  .option("--source <source>", "memory source")
  .option("--allow-duplicate", "allow an exact duplicate memory")
  .action(async (options: { title: string; content: string; kind: string; tags?: string; source?: string; allowDuplicate?: boolean }) => {
    const app = await appFromOptions();
    const result = await addMemory({
      ...app,
      projectId: app.config.project.projectId,
      title: options.title,
      content: options.content,
      kind: options.kind,
      tags: options.tags?.split(",").map((tag) => tag.trim()).filter(Boolean),
      source: options.source,
      allowDuplicate: options.allowDuplicate
    });
    await app.db.close();
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("list-memories")
  .option("--include-archived", "include archived memories")
  .option("--kind <kind>", "filter by kind")
  .option("--tag <tag>", "filter by tag")
  .option("--limit <n>", "maximum rows", parseInt)
  .action(async (options: { includeArchived?: boolean; kind?: string; tag?: string; limit?: number }) => {
    const app = await appFromOptions();
    const result = await listMemories({ ...app, projectId: app.config.project.projectId, ...options });
    await app.db.close();
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("update-memory")
  .requiredOption("--id <id>", "memory id")
  .option("--title <title>", "new title")
  .option("--content <content>", "new content")
  .option("--kind <kind>", "new kind")
  .option("--tags <tags>", "comma-separated tags")
  .option("--source <source>", "new source")
  .action(async (options: { id: string; title?: string; content?: string; kind?: string; tags?: string; source?: string }) => {
    const app = await appFromOptions();
    const result = await updateMemory({
      ...app,
      projectId: app.config.project.projectId,
      id: options.id,
      title: options.title,
      content: options.content,
      kind: options.kind,
      tags: options.tags?.split(",").map((tag) => tag.trim()).filter(Boolean),
      source: options.source
    });
    await app.db.close();
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("archive-memory")
  .requiredOption("--id <id>", "memory id")
  .action(async (options: { id: string }) => {
    const app = await appFromOptions();
    const result = await archiveMemory({ ...app, projectId: app.config.project.projectId, id: options.id });
    await app.db.close();
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("confidence")
  .requiredOption("--target-id <id>", "memory id")
  .action(async (options: { targetId: string }) => {
    const app = await appFromOptions();
    const result = await readConfidence({ ...app, projectId: app.config.project.projectId, targetId: options.targetId });
    await app.db.close();
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("feedback")
  .requiredOption("--target-id <id>", "memory id")
  .requiredOption("--signal <signal>", "support, confirm, dispute, contradict, obsolete, or uncertain")
  .option("--weight <n>", "feedback weight", parseFloat)
  .option("--agent-id <id>", "agent id")
  .option("--rationale <text>", "why this feedback was submitted")
  .action(
    async (options: {
      targetId: string;
      signal: "support" | "confirm" | "dispute" | "contradict" | "obsolete" | "uncertain";
      weight?: number;
      agentId?: string;
      rationale?: string;
    }) => {
      const app = await appFromOptions();
      const result = await submitConfidenceFeedback({
        ...app,
        projectId: app.config.project.projectId,
        targetId: options.targetId,
        signal: options.signal,
        weight: options.weight,
        agentId: options.agentId,
        rationale: options.rationale
      });
      await app.db.close();
      console.log(JSON.stringify(result, null, 2));
    }
  );

program
  .command("list-feedback")
  .option("--target-id <id>", "memory id")
  .option("--limit <n>", "maximum rows", parseInt)
  .action(async (options: { targetId?: string; limit?: number }) => {
    const app = await appFromOptions();
    const result = await listFeedback({ ...app, projectId: app.config.project.projectId, ...options });
    await app.db.close();
    console.log(JSON.stringify(result, null, 2));
  });

program.command("list-suspect").action(async () => {
  const app = await appFromOptions();
  const result = await listSuspectConfidence({ ...app, projectId: app.config.project.projectId });
  await app.db.close();
  console.log(JSON.stringify(result, null, 2));
});

await program.parseAsync(process.argv);

async function appFromOptions() {
  const options = program.opts<{ serviceConfig?: string; projectConfig?: string }>();
  const config = await loadRuntimeConfig({
    serviceConfigPath: options.serviceConfig,
    projectConfigPath: options.projectConfig
  });
  return createApp(config);
}
