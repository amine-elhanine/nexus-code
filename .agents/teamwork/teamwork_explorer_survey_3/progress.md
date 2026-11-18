# Progress — teamwork_explorer_survey_3

Last visited: 2026-11-13T04:05:00Z
Current Milestone: M3 - Performance & Bug Deep Dive

## Status
- [x] Initialized DISPATCH.md, BRIEFING.md, and progress.md
- [x] Explored codebase structure, modules, and architecture
- [x] Deep dive on Performance Bottlenecks:
  - [x] Memory leaks and resource lifecycles (fileLocks map in atomic-write.ts, screenshot accumulation, SQLite connection thrashing)
  - [x] Algorithmic complexity and excessive allocations (BM25 df/tf recomputation per query, graph expansion tokenization, daemon log array shift)
  - [x] Blocking synchronous I/O on Electron main event loop (eager transcript hydration on projects:list, chats.json re-serialization)
  - [x] IPC serialization overhead and high-frequency messaging (unthrottled daemon:log streaming, token/thinking React re-renders)
  - [x] Database/vector search query optimization & caching (loadVectorsSqlite loading all chunks, un-batched Ollama embeddings)
  - [x] Renderer render loops, re-render cascades, and DOM virtualization (ChatShell unvirtualized DOM, resize observer loop)
- [x] Deep dive on Latent Bugs & Edge Cases:
  - [x] Anthropic Messages API consecutive user message violation on multi-tool turns
  - [x] L4 compaction converting user/assistant messages into invalid tool messages
  - [x] Special character `$` pattern expansion corrupting user code during search/replace edits
  - [x] Auto-recovery inserting userMsg after unfulfilled tool calls causing infinite HTTP 400 loops
  - [x] Single-turn autonomous runs bypassing microcompactBoundary completely
  - [x] Assistant messages with tool calls marked as extendsPrior preventing transcript trimming
  - [x] LSP framing parser infinite loop on missing Content-Length header
  - [x] Message resurrection bug on session truncation race
  - [x] CSV parser line-ending edge case on classic Mac CR linebreaks
- [x] Synthesizing findings into structured report (`handoff.md`) with exact file:line citations
- [ ] Final handoff and notification to orchestrator
