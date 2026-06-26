export type ToolManifestItem = {
  name: string;
  description: string;
};

export const toolManifest: ToolManifestItem[] = [
  { name: "help", description: "Start here. Guide to call order, tool arguments, projectId, and the auto-memory scaffold (files + contents)." },
  { name: "health_check", description: "Check PostgreSQL and embedding API connectivity." },
  { name: "register_project", description: "Register a project and obtain a server-generated projectId for retrieval isolation." },
  { name: "search_knowledge", description: "Semantic search over manual project memories. Requires projectId; results are strictly scoped to that project." },
  { name: "add_memory", description: "Add a manual project memory and index it for semantic search. Requires projectId; the memory is scoped to that project." },
  { name: "list_memories", description: "List project memories with optional archived/kind/tag filters. Requires projectId; results are scoped to that project." },
  { name: "update_memory", description: "Update a memory and refresh its embedding. Requires projectId; the memory must belong to that project." },
  { name: "archive_memory", description: "Archive a memory so it no longer appears in search results. Requires projectId; the memory must belong to that project." },
  { name: "record_confidence_feedback", description: "Submit positive or negative evidence about a memory. Requires projectId; the memory must belong to that project." },
  { name: "get_confidence", description: "Read computed confidence for a memory. Requires projectId; the memory must belong to that project." },
  { name: "list_confidence_feedback", description: "List feedback records for confidence audit. Requires projectId; results are scoped to that project." },
  { name: "list_suspect_confidence", description: "List suspect or rejected memories. Requires projectId; results are scoped to that project." }
];
