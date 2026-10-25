# Nexus Codebase Report

**Review date:** 23 October 2026  
**Repository version:** `0.5.0` (package version `0.4.5`; see versioning note below)  
**Scope:** Source-based architecture and product review of the checked-out repository. This report covers the primary application, Electron services, docs, package configuration, and test inventory. It is not an exhaustive line-by-line security audit, and this review did not execute the test suites.

## Executive summary

Nexus is a local-first desktop AI application built with Electron, React, and TypeScript. Its three main surfaces—Code, Home, and Notebook—share model/provider infrastructure and a substantial Electron main-process service layer. The product aims to combine an autonomous coding agent, general assistant with document creation, and source-grounded research notebook.

The codebase shows considerable breadth and a serious effort to build operational controls around agent actions: a narrow preload bridge, main-process validation, project-root file boundaries, shell approval/denial policy, run checkpoints, diff/revert support, plugin permission checks, and an SSRF-aware notebook ingestion path. The strongest engineering concern is the size and integration complexity of the feature set: many capabilities converge in `electron/main.ts`, `electron/agent-service.ts`, and a large renderer, raising regression and maintenance costs. Security documentation also correctly states that some protections are guardrails rather than OS isolation.

**Overall assessment:** a feature-rich, actively developed desktop agent with a credible modular service layout and broad test coverage on paper. It is not accurate to characterize it as a hardened sandbox: the app grants powerful local capabilities by design, renderer sandboxing is opt-in, hooks run with user privileges, and executable plugin isolation is process/VM-based rather than a full OS sandbox.

## Product and architecture

### Product surfaces

- **Code:** repository-aware agent with Plan/Ask/Auto modes, edits, shell and terminal tools, code intelligence, verification/repair, checkpoints, and Git worktrees.
- **Home:** general assistant with memory, web/browser access, and generated office/document artifacts.
- **Notebook:** source ingestion and indexing, hybrid retrieval, citation-aware Q&A, and generated reports, quizzes, flashcards, summaries, and mind maps.

### Main technical layers

- **Renderer:** React 19 + TypeScript + Vite in `src/`; mode views, controllers, Monaco/xterm components, settings, and shared chat UI.
- **Desktop host:** Electron TypeScript in `electron/`; app lifecycle, IPC, persistence, model/provider setup, file/shell operations, agent execution, plugins, browser, and notebook processing.
- **Agent execution:** LangChain models and tools, DeepAgents for tool-using workflows, and LangGraph orchestration/supervision. `agent-service.ts` composes routing, project context, tools, hooks, memory, checkpoints, context management, and verification/repair.
- **Notebook:** asynchronous ingestion stages documents through parse, chunk, index, and ready/failure states; retrieval combines semantic and lexical signals with citation/evidence handling.
- **Extensibility:** declarative plugin bundles and executable plugin tools, plus skills, commands, rules, hooks, MCP servers, and specialist agents.
- **Delivery:** Electron Builder packages Windows NSIS/portable, macOS DMG, and Linux AppImage targets. The README foregrounds Windows support.

The main process is the system boundary: the renderer calls a deliberately exposed preload API, while privileged operations are registered through IPC handlers and service modules. This separation is sound in principle, though the large handler registry and broad shared state make the main process a natural hotspot for future refactoring.

## Strengths observed in source

1. **Substantial safety and recovery mechanisms for agent workflows.** There are approval flows, command policy checks, cancellation, bounded run loops, checkpointing, diff review, file/hunk rollback, verification, and repair limits. File access uses a root-constrained path resolver and filters common generated directories from browsing.
2. **Clear plugin permission model.** Plugin documentation and code describe deny-by-default permissions, no raw secret access, per-call permission checks, approval requirements, bounded execution, install size/path checks, and rollback-safe updates.
3. **Honest security limitations.** The plugin security docs explicitly avoid claiming signed marketplace artifacts or full sandboxing, and note that shell hooks execute with the user's privileges. This is a useful trust boundary statement.
4. **Notebook evidence pipeline is treated as a first-class feature.** Retrieval scores and source passages are represented explicitly; the answer path includes citation coverage/evidence gates, while ingest has stable identifiers, retry/recovery, bounded concurrency, and network URL protections.
5. **Breadth of automated regression tests.** The repository contains roughly 56 test files spanning permissions, checkpoints, loop prevention, LSP, plugins, memory, providers, file/path handling, notebook ingestion/RAG, and artifact behavior. The package scripts also separate unit, notebook, permissions, integration, and evaluation runs.
6. **Useful project-facing docs.** The README maps product modes and repository layout, while plugin docs include SDK, compatibility, marketplace, permissions, known limitations, and development guidance.

## Risks and limitations

### Security and trust boundaries

- In `electron/main.ts`, `contextIsolation` is enabled and `nodeIntegration` disabled, but Chromium's renderer `sandbox` is conditional on `NEXUS_SANDBOX=1`. The source comment says the default has not yet been flipped pending release validation. Treat this as a meaningful hardening gap for a desktop app that handles untrusted content.
- Executable plugins run in a separate process and VM with timeouts and a restricted bridge, but the docs explicitly say there is no OS sandbox, resource cap, or network namespace. A Node/V8 escape is not ruled out.
- Hook plugins and user-configured shell workflows can execute commands with the user's privileges. The command policy is a backstop, not a containment boundary; `permissions.ts` says so directly.
- `safeStorage` is used for provider credentials when available, but `store.ts` contains a plaintext fallback when encryption is unavailable. The fallback and recovery behavior deserve clear user-facing explanation and a release/security review.
- Notebook network guards reduce SSRF risk, but network fetch and browser features remain sensitive surfaces. They warrant ongoing adversarial tests around redirects, DNS/IP changes, URL parsing, and local/private address handling.

### Maintainability and product complexity

- `electron/main.ts` has a very large IPC registry and coordinates many product domains. `agent-service.ts` also imports and composes many subsystems. This increases the chance that changes to shared state, event routing, or cancellation have cross-mode effects.
- The product's feature matrix is ambitious. Provider-specific model formats, multiple document formats, three modes, plugins, MCP, browser actions, and generated artifacts create a large compatibility surface.
- Some plugin extension points are intentionally incomplete: cross-process event delivery is metadata-only, several UI slots are reserved metadata, and deeper adapter interfaces for retrieval/memory/persistence/verification are deferred. These are stated in `docs/plugins/known-limitations.md`.
- The package manifest reports `0.4.5` while the changelog's latest entry is `0.5.0`. This could be a packaging/versioning oversight; release artifacts and in-app version reporting should be checked against the intended release.
- README feature counts and descriptions (for example, provider, subagent, rule, and command counts) are documentation claims. This review did not independently enumerate every bundled item or validate every advertised interaction end-to-end.

### Operational evidence

Test scripts are extensive, but their presence alone does not establish pass status. I did not run type checking, tests, packaging, or evaluations for this report. Runtime behavior, provider API compatibility, and package reproducibility therefore remain unverified here.

## Recommendations

### Near term

1. **Reconcile release version metadata.** Align `package.json`, changelog, installer metadata, and app-reported version before the next release.
2. **Validate and enable Electron renderer sandboxing by default.** Run the full supported flows with `sandbox: true`, resolve preload/native integration issues, and add a test or release check to prevent accidental regression.
3. **Make credential fallback explicit.** If OS-backed encryption is unavailable, give users a clear status and consider requiring an explicit opt-in before persisting a key in plaintext.
4. **Add an actionable security posture page.** Summarize what runs locally, what can execute shell commands, plugin trust expectations, credential storage behavior, and what the app's controls do not guarantee.
5. **Keep dependency/release verification visible.** Establish a release checklist for `npm run check`, the relevant test suites, and platform packaging; publish which targets were actually built and tested.

### Medium term

1. Split IPC registration and lifecycle/state ownership by domain, preserving a small central bootstrap in `main.ts`.
2. Continue extracting agent orchestration into explicit, typed stages with observable inputs/outputs and cancellation contracts.
3. Add OS-level plugin isolation/resource controls where the supported platforms allow it; until then, keep executable plugin installation a clearly stated trust decision.
4. Expand adversarial tests for filesystem symlinks/path traversal, browser/network redirects and DNS rebinding, plugin process termination, malformed document parsers, and multi-session cancellation.
5. Track documentation claims against generated inventories or tests to keep README counts and capability statements current.

## Evidence and navigation

- Product overview and architecture map: `README.md`
- Dependency scripts, runtime dependencies, packaging targets, and package version: `package.json`
- Release history: `CHANGELOG.md`
- Electron lifecycle, BrowserWindow settings, IPC registry: `electron/main.ts`
- Narrow renderer bridge: `electron/preload.cts`
- Agent orchestration and verification: `electron/agent-service.ts`
- Workspace path and file operations: `electron/project-tools.ts`
- Shell command policy: `electron/permissions.ts` and `electron/command-service.ts`
- Credential persistence and encryption fallback: `electron/store.ts`
- Notebook retrieval and citation path: `electron/notebook-rag.ts`, `electron/notebook-text.ts`
- Notebook ingestion and job recovery: `electron/notebook-jobs.ts`, `electron/notebook-parse.ts`
- Plugin limitations/security model: `docs/plugins/known-limitations.md`, `docs/plugins/permissions-security.md`
- Test inventory and commands: `test/`, `package.json`

## Conclusion

Nexus is a substantial local desktop agent platform, not a small wrapper around a model API. Its strongest differentiation is the integration of coding workflows, document creation, and source-grounded research with local persistence and practical recovery controls. The main work ahead is reducing cross-cutting complexity and raising the default security posture—especially renderer sandboxing and credential storage—while validating the broad advertised feature set through repeatable release evidence.
