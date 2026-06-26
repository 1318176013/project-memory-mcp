# Project Memory MCP Roadmap

## Current Status

- MCP server starts and exposes project memory tools.
- PostgreSQL stores metadata, memories, confidence feedback, and memory vectors (pgvector).
- Semantic search is exact cosine KNN in SQL, scoped per project.
- OpenAI-compatible embedding API is wired through config.
- `search_knowledge` returns ranked memory hits scoped to a project.
- Memory confidence can be updated through feedback and affects retrieval ranking.

## Near-Term Production Hardening

- Add more tests around stores, retriever ranking, memory updates, archiving, and confidence feedback.
- Add operational docs for backup, restore, and embedding model changes (re-embed on model/dimension change, since vectors live in the `memories.embedding` column).

## Confidence System Improvements

Current confidence is a simple linear score:

```text
confidence = clamp(0.7 + sum(signalScore * weight), 0, 1)
```

This is enough for MVP, but should evolve before serious multi-agent use.

Planned improvements:

- Add per-agent trust scores so reliable agents have more influence than unknown agents.
- Deduplicate or rate-limit repeated feedback from the same agent on the same target.
- Add time decay so old feedback gradually has less influence.
- Weight feedback by evidence type, for example project test result, source quote, runtime error, manual human review, or generic agent opinion.
- Make human feedback stronger than agent feedback by default.
- Prefer project-local evidence over general web knowledge.
- Track feedback provenance in richer detail, including thread id, tool call id, source URL, code location, and timestamp.
- Add confidence explanation output so agents can see why an item is trusted, suspect, or rejected.
- Add automatic review queues for `suspect` and `rejected` memories.
- Add configurable thresholds per project instead of global hard-coded thresholds.
- Consider Bayesian or Wilson-score style aggregation once feedback volume grows.

## Confidence Status Semantics

- `trusted`: Strong positive evidence. Prefer in context when relevant.
- `normal`: Usable, default status.
- `suspect`: Keep visible but down-rank heavily and warn consumers.
- `rejected`: Exclude from retrieval unless explicitly requested for audit.

## Viewer Ideas

- Add a knowledge-focused view that lists memories with their kind and tags.
- Show confidence badges and feedback history for each memory.
- Add filters for `trusted`, `normal`, `suspect`, and `rejected`.
- Add export modes for audit reports and compact agent-readable context.
