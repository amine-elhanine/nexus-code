# Architectural & Structural Survey: Nexus Desktop Agent

## 1. Observation

A forensic survey of the Nexus codebase (`c:\Users\melha_eay78bj\Desktop\code`) was conducted across frameworks, module boundaries, layers, component coupling, dependency flow, design patterns, separation of concerns, and abstractions. The following concrete facts and line-level evidence were recorded:

### 1.1 Tech Stack & Framework Architecture
- **Runtime & Desktop Shell**: Electron 44 (`package.json:129`), Node.js `>=24` (`package.json:9`), Vite 8.2.2 (`package.json:134`), TypeScript 7.0.2 (`package.json:131`).
- **Renderer / Presentation Layer**: React 19.2.8 (`package.json:116`), Lucide-React 1.34.0 (`package.json:111`), Monaco Editor 0.52.2 (`package.json:113`), xterm.js 6.0.0 (`package.json:105`), KaTeX 0.18.7 (`package.json:110`), Mermaid 11.17.2 (`package.json:112`), `@aiden0z/pptx-renderer` 1.2.4 (`package.json:99`), `docx-preview` 0.4.0 (`package.json:107`).
- **Core Agent Runtime (`agentcore`)**: Self-built runtime with zero heavy framework dependencies (`electron/agentcore/index.ts:1-11`), implementing a ReAct streaming loop (`electron/agentcore/loop.ts:1-65`), tool abstractions (`electron/agentcore/tools.ts`), virtual filesystem backend (`electron/agentcore/backend.ts:1-50`), middleware pipeline (`electron/agentcore/middleware.ts`), and hand-crafted LLM adapters for Anthropic, Google Gemini, and OpenAI-compatible endpoints (`electron/agentcore/llm/`).
- **Document & Code Intelligence Libraries**: WebAssembly Tree-sitter (`web-tree-sitter:0.22.4`, `tree-sitter-wasms:0.1.11` in `package.json:118-119`, used in `electron/symbol-parser.ts:1-25`), `@llamaindex/llama-cloud:2.16.0` (`package.json:101`, used in `electron/notebook-parse.ts:2, 524-555`), `docx:9.7.1` (`package.json:106`), `pptxgenjs:4.0.1` (`package.json:115`), `pdf-parse:2.4.5` (`package.json:114`), `xlsx:0.18.5` (`package.json:120`), and `@modelcontextprotocol/sdk:1.30.0` (`package.json:102`).
- **Vector Storage**: Zero-dependency SQLite vector store utilizing Node 24 native `node:sqlite` (`electron/notebook-vectors-sqlite.ts:1-55`), writing 64-bit float vectors as raw blobs with WAL mode enabled (`electron/notebook-vectors-sqlite.ts:49-60`).

### 1.2 Process Architecture, Trust Boundary, & IPC Routing
- **Main Process Bootstrap**: `electron/main.ts:1-40` initializes app lifecycle, protocol handlers (`nexus-attachment`), single-instance locks, and window creation.
- **Renderer Sandboxing**: `electron/main.ts:104-123` configures `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true` (only toggled off if `--dev` is active and `NEXUS_SANDBOX === "0"`). Webview attachments are stripped of preload scripts and forced into sandbox mode (`electron/main.ts:154-159`).
- **Navigation Lockdown**: `electron/main.ts:140-148` intercepts `will-navigate` to restrict renderer navigation strictly to `index.html` or local dev URLs, preventing renderer compromise from navigating to external origins.
- **IPC Routing Structure**: Monolithic IPC registration was extracted into domain-specific route handlers in `electron/ipc/` (`agent-routes.ts`, `browser-routes.ts`, `home-routes.ts`, `home-run-routes.ts`, `notebook-routes.ts`, `project-routes.ts`, `provider-routes.ts`, `settings-routes.ts`, `skills-routes.ts`, `terminal-routes.ts`, `workspace-routes.ts`). Handlers share state via `MainIpcContext` (`electron/ipc/context.ts:12-33`).
- **IPC Contract & Trust Validation**: `electron/ipc/schemas.ts:1-35` defines Zod validation schemas (`assertPayload`) executed at the IPC ingress boundary (`ipc/agent-routes.ts:47`, `ipc/home-run-routes.ts:39`, `ipc/notebook-routes.ts:20-22`), validating types, sizes, and structure before payloads reach internal services.
- **Preload API Surface**: `electron/preload.cts:12-319` exposes `window.nexus` via `contextBridge.exposeInMainWorld`. The object contains over 110 distinct IPC invoke/on methods.
- **Out-of-Process Workers**:
  - `electron/pty-host.cjs:1-60` hosts `@homebridge/node-pty-prebuilt-multiarch` in an external Node process communicating over line-delimited JSON stdio, protecting the main process from native Node ABI segmentation faults.
  - `electron/plugin-process-host.ts:60-99` executes third-party plugin code out-of-process via `electron/plugin-runner.cjs` (`ELECTRON_RUN_AS_NODE: "1"`) with scrubbed environment variables (`scrubSecretEnv` in `electron/child-env.ts`) over NDJSON-RPC.
  - `electron/lsp-service.ts:8-35` spawns language servers (`typescript-language-server`, `pyright-langserver`, `gopls`, `rust-analyzer`, `clangd`) over stdio JSON-RPC 2.0 with LSP header framing.

### 1.3 Directory Sprawl & Layout
- Out of 149 TypeScript/JavaScript files in `electron/`, **105 files sit directly in the root directory `electron/`** with no subdirectory grouping.
- Distinct domains are intermingled in `electron/`:
  - 21 Notebook mode files (`notebook-*.ts`)
  - 15 Plugin & extension files (`plugin-*.ts`, `hooks-service.ts`, `skills-service.ts`, `mcp-service.ts`)
  - 12 Home mode files (`home-*.ts`, `deliverable-inspect.ts`, `artifacts-service.ts`)
  - 13 Code / Git / Terminal files (`diff-service.ts`, `worktree-service.ts`, `lsp-service.ts`, `terminal-service.ts`, `repo-service.ts`, `daemon-service.ts`, etc.)
  - 10 Tool definitions (`code-tools.ts`, `edit-tools.ts`, `browser-tool.ts`, `websearch-tool.ts`, `image-gen-tool.ts`, etc.)
  - 12 Core Agent services (`agent-service.ts`, `agent-prompt.ts`, `agent-types.ts`, `loop-prevention.ts`, `context-service.ts`, `run-checkpoint.ts`, `rate-limit.ts`, etc.)
- In `src/`, 84 files are grouped into `components/` (16 subfolders, 48 files), `modals/` (5 files), `state/` (6 files), `views/` (5 files), `utils/` (14 files), but extreme code concentration exists in top-level view and controller files.

### 1.4 Monolithic Files & God Objects
1. `electron/agent-service.ts`: 128,964 bytes, 2,240 lines. Contains a single exported function `runProjectAgent` (`agent-service.ts:98-2240`) spanning over 2,140 continuous lines. It handles profile determination, tool assembly, slash commands, telemetry, LLM provider selection, git state, skills mounting, MCP filtering, context budgeting, agent loop invocation, verification supervisor dispatch, repair looping, and journal synchronization.
2. `src/App.tsx`: 118,062 bytes, 2,560 lines. God component managing global shell layout, window drag headers, multi-tab routing, file tree drawers, context meters, modals, active session synchronizations, and keyboard shortcuts. Lines 83-188 destructure over 80 state properties and action handlers from `useAppController`.
3. `src/views/NotebookView.tsx`: 95,072 bytes, 2,001 lines. Combines document upload dropzones, ingestion progress bars, grounded chat streaming, inline citation linking, studio artifact generators, quiz players, flashcard carousels, mindmap trees, and audio overview controls into one monolithic view.
4. `electron/notebook-documents.ts`: 88,969 bytes, 2,192 lines. Mixes document schema definitions (`notebook-documents.ts:21-38`), file store persistence (`docsDir`, `listNotebookDocuments`), RAG evidence collection (`notebook-documents.ts:481-690`), Markdown-to-OpenXML parser (`renderDocx` in `notebook-documents.ts:1135-1440`), HTML/PDF builder (`markdownToDocumentHtml`, `renderPdf` in `notebook-documents.ts:1448-1640`), and PPTX generator (`renderPptx` in `notebook-documents.ts:1708-1980`).
5. `electron/store.ts`: 61,268 bytes, 1,267 lines. Manages global persistence, safeStorage DPAPI/Keychain encryption, project CRUD, session CRUD, home session CRUD, provider settings, embedding provider settings, MCP server configs, skills/rules/hooks toggles, search configs, and plugin registry entries in a single monolithic JSON file (`nexus-state.json` via `persist()` in `store.ts:502-520`).
6. `src/modals/SettingsModal.tsx`: 69,523 bytes, 1,278 lines. Houses 13 disparate settings sections (appearance, browser, providers, notebook, mcp, skills, plugins, rules, services, updates, workspace, shortcuts, storage) in one giant file with 30+ internal state hooks (`SettingsModal.tsx:52-85`).
7. `electron/skills-service.ts`: 54,101 bytes, 1,161 lines. Handles discovery, markdown frontmatter parsing, mode filtering, compatibility paths, zip importing, system skill routes, and UI actions.
8. `src/views/AgentView.tsx`: 67,921 bytes, 1,641 lines. Contains the code chat interface, composer input, autosizing textarea, starter action pills, sliding plan drawer integration, and also exports `ModelSelect` and `ModelContextLine` (`AgentView.tsx:36-120`), which are subsequently imported by peer views.

### 1.5 Circular Dependencies & Inverted Layering
Dependency graph analysis across all 233 source files revealed significant structural coupling:
- **Direct 2-Node Circular Dependencies in `electron/` (5 cycles)**:
  1. `agent-service <-> subagent-service`:
     - `subagent-service.ts:12` imports `type { AgentUsage }` from `./agent-service.js`.
     - `agent-service.ts:26` imports `{ createSubagentDelegationTool, executeSubagentTask, buildSubagentCatalog, type SubagentItem }` from `./subagent-service.js`.
  2. `agentcore/backend <-> command-service`:
     - `command-service.ts:416` re-exports `{ getAgentBackend }` from `./agentcore/backend.js`.
     - `agentcore/backend.ts:23` imports `{ executeCommand, readCommandPolicyWithTrust }` from `../command-service.js`.
  3. `code-tools <-> lsp-service`:
     - `code-tools.ts:8` imports `{ lspDefinition, lspDiagnostics, lspDocumentSymbols, lspReferences, lspRename }` from `./lsp-service.js`.
     - `lsp-service.ts:13` imports `type { DiagnosticItem }` from `./code-tools.js`.
  4. `notebook-library <-> notebook-vectors-sqlite`:
     - `notebook-library.ts:5` imports `* as sqliteStore` from `./notebook-vectors-sqlite.js`.
     - `notebook-vectors-sqlite.ts:3` imports `type { VectorPartition }` from `./notebook-library.js`.
  5. `store <-> subagent-service`:
     - `store.ts:30` imports `type { SubagentItem }` from `./subagent-service.js`.
     - `subagent-service.ts:11` imports `type { ProviderConfig }` from `./store.js`.
- **Deep Dependency Cycles in `electron/`**: 393 cyclical paths through `store`, `subagent-service`, `agent-service`, `skills-service`, and `agent/context-budget`.
- **Inverted Dependency in `agentcore/`**:
  `agentcore/` is meant to be a core runtime engine, but `electron/agentcore/backend.ts:21-26` imports upwards from `../path-utils.js`, `../state-guard.js`, `../command-service.js`, `../lsp-service.js`, `../approval-service.js`, and `../store.js`. Similarly, `electron/agentcore/loop.ts:21` imports `normalizeArgAliases` from `../loop-prevention.js`.
- **Direct 2-Node Circular Dependencies in `src/` (3 cycles)**:
  1. `components/chat/ChatMessageItem.tsx:31` imports `{ SubagentCardView }` from `./SubagentCard.js`, while `components/chat/SubagentCard.tsx:5` imports `{ parseEventText }` from `./ChatMessageItem.js`.
  2. `components/chat/HtmlVisualBlock.tsx:9` imports `{ openVisualFullscreen }` from `../common/VisualFullscreen.js`, while `components/common/VisualFullscreen.tsx:4` imports `{ HtmlVisualBlock }` from `../chat/HtmlVisualBlock.js`.
  3. `components/chat/WidgetBlock.tsx:15` imports `{ openVisualFullscreen }` from `../common/VisualFullscreen.js`, while `components/common/VisualFullscreen.tsx:3` imports `{ WidgetBlock }` from `../chat/WidgetBlock.js`.
- **Cross-Domain Coupling**:
  - `electron/notebook-rag.ts:26, 870-878` imports `createHomeMemoryTool` and `selectRelevantHomeMemory` from `home-memory-service.ts` to manage per-notebook memory, tightly binding Notebook mode to Home mode.
  - `electron/skills-service.ts:10` imports `foldToken, SKILLS_ES_RE` from `notebook-text.ts`.
  - `src/views/NotebookView.tsx:7` and `src/views/HomeView.tsx:17` import `{ ModelSelect }` from `./AgentView.js`.

### 1.6 Tool Pipeline Bifurcation
- `electron/capability-registry.ts:1-60` provides a unified capability catalog, and `electron/tool-executor.ts:1-70` implements an enterprise-grade execution boundary (validating Zod schemas, checking mode permissions, evaluating policy hooks, prompting approvals, enforcing timeouts, and redacting secrets).
- However, as acknowledged in `electron/agent/builtin-tool-catalog.ts:5-18`, **built-in agent tools bypass `tool-executor.ts`** and execute through ad-hoc paths assembled directly in `agent-service.ts`. Built-in tools do not benefit from the centralized security, timeout, hook, and redaction pipeline that plugin tools undergo.

### 1.7 Type System & Contract Duplication
- Because `tsconfig.json` (Bundler / `src`) and `tsconfig.electron.json` (NodeNext / `electron`) are completely separated with no shared project reference or path alias, data contracts are manually duplicated in 3 different locations:
  1. `electron/agent-types.ts:7-105`
  2. `src/types.ts:1-100`
  3. `src/vite-env.d.ts:1-120`
- Provider definitions are duplicated between `electron/providers.ts:37-120` (`PROVIDERS`) and `src/state/useAppController.ts:28-100` (`FALLBACK_PROVIDERS`), creating risk of schema drift.

---

## 2. Logic Chain

1. **Premise from Observation 1.3 & 1.4**:
   With 105 files in `electron/` root and single files exceeding 2,000 lines (`agent-service.ts`, `notebook-documents.ts`, `App.tsx`, `NotebookView.tsx`), components take on multiple divergent responsibilities. For example, `agent-service.ts:runProjectAgent` orchestrates LLM streaming, slash command expansion, filesystem composite mounting, git diff tracking, LSP diagnostics, verification review, and task journaling.
2. **Inference on Architectural Boundaries**:
   Because `electron/` lacks domain subdirectories (such as `domains/code`, `domains/home`, `domains/notebook`), any file can import any other file with a flat `./` import. This lack of package boundaries enabled developers to borrow utilities across domains, resulting in:
   - `notebook-rag.ts` importing `home-memory-service.ts`
   - `skills-service.ts` importing `notebook-text.ts`
   - `agentcore/backend.ts` reaching upwards into `command-service.ts` and `lsp-service.ts`
3. **Inference on Cyclic Coupling**:
   Co-locating type definitions inside implementation files instead of dedicated contract modules causes circular imports. For example, `lsp-service.ts` needs `DiagnosticItem` from `code-tools.ts`, while `code-tools.ts` needs LSP query functions from `lsp-service.ts`. In the renderer, putting `parseEventText` inside `ChatMessageItem.tsx` causes a cycle with `SubagentCard.tsx`.
4. **Inference on Clean Architecture & Inverted Dependencies**:
   `agentcore` was engineered to be a standalone, self-built agent framework replacing LangGraph/LangChain. However, `agentcore/backend.ts` directly imports `command-service.ts` and `approval-service.ts`. The foundational core runtime depends on high-level Electron services, violating the Dependency Inversion Principle. `agentcore` cannot be extracted or run in an isolated CLI without pulling in Electron-specific command services.
5. **Inference on Tool Execution Pipeline**:
   Having two distinct tool execution pathways—one through `tool-executor.ts` (with strict Zod validation, permission checks, timeouts, and redactions for plugins) and one direct in `agent-service.ts` for built-in tools—creates dual maintenance overhead and inconsistent security postures.
6. **Inference on State Management**:
   `useAppController` acts as a monolithic hook returning 80+ state variables to `App.tsx`. Any state change triggers top-level renders across `App.tsx` and child components unless guarded by `React.memo`. Concurrently, `store.ts` serializes the entirety of `PersistedState` (`projects`, `providers`, `settings`, `mcp`, `skills`, `rules`) into `nexus-state.json` on any mutation, creating an I/O bottleneck and concurrency contention under heavy agent operations.

---

## 3. Caveats

1. **Integrity Mode & Scope**: This survey was performed strictly in read-only investigation mode. No production source code files were edited or refactored.
2. **Runtime Dynamic Behavior**: Dependency and cycle detection was executed through static AST/regex analysis of all TypeScript and TSX files in `electron/` and `src/`. Dynamic runtime imports (e.g. `await import("../notebook-youtube.js")` in `notebook-routes.ts:80`) were reviewed statically but not traced through memory instrumentation during full Electron application execution.
3. **Packaging Artifacts**: The investigation surveyed the source tree under `electron/`, `src/`, `scripts/`, `plugins/`, and `test/`. Pre-compiled bundles in `dist/`, `dist-electron/`, and `release/` were excluded from code metrics.

---

## 4. Conclusion

Nexus possesses several impressive architectural strengths:
- A completely self-built agent runtime (`agentcore`) avoiding third-party agent framework bloat.
- Strict IPC security boundaries with Zod validation at trust boundaries (`ipc/schemas.ts`).
- Chromium sandbox enforcement and protocol lockdowns (`main.ts`).
- Resilient out-of-process isolation for crash-prone native modules (PTY host in `pty-host.cjs`, plugin runners in `plugin-process-host.ts`, and LSPs).
- Zero-dependency local vector retrieval using native Node 24 `node:sqlite`.
- A declarative `RunProfile` regime unifying mode behaviors.

However, the architecture suffers from six significant structural pathologies:
1. **Severe Directory Sprawl**: 105 files loose in `electron/` root, obscuring module boundaries and domain ownership.
2. **Monolithic God Classes/Functions**: Single functions (`runProjectAgent` in `agent-service.ts`) and files (`notebook-documents.ts`, `App.tsx`, `NotebookView.tsx`, `store.ts`) exceeding 2,000 lines.
3. **Extensive Circular Dependencies**: 5 direct 2-node cycles in `electron/`, 393 deep dependency cycles, and 3 UI cycles in `src/`.
4. **Inverted Core Layering**: `agentcore/` imports upward into outer Electron services (`command-service`, `lsp-service`, `approval-service`), breaking decoupling.
5. **Dual Tool Pipelines**: Built-in tools bypass the centralized validation, permission, and approval pipeline in `tool-executor.ts`.
6. **State & Type Duplication**: Triplicate data model definitions between Main, Preload, and Renderer without a shared contract workspace.

### Prioritized Actionable Recommendations

| Priority | Recommendation | Target Files | Impact & Action Plan |
|---|---|---|---|
| **P1** | **Untangle Inverted Dependencies in `agentcore` & Eliminate Direct 2-Node Cycles** | `electron/agentcore/backend.ts`<br>`electron/command-service.ts`<br>`electron/subagent-service.ts`<br>`electron/agent-service.ts`<br>`electron/code-tools.ts`<br>`electron/lsp-service.ts` | 1. Move `getAgentBackend` out of `backend.ts` into a dedicated factory (`electron/services/backend-factory.ts`).<br>2. In `agentcore/backend.ts`, remove upward imports to `command-service` and `approval-service`; accept command execution and approval delegates via constructor dependency injection.<br>3. Extract `DiagnosticItem` from `code-tools.ts` into a shared `electron/types/lsp.ts`.<br>4. Extract `VectorPartition` from `notebook-library.ts` into `electron/types/notebook.ts`.<br>5. Extract `SubagentItem` and `AgentUsage` references in `store.ts` and `subagent-service.ts` into `agent-types.ts`. |
| **P2** | **Break Down Monolithic God Objects** | `electron/agent-service.ts`<br>`electron/notebook-documents.ts`<br>`src/App.tsx`<br>`src/views/NotebookView.tsx`<br>`src/modals/SettingsModal.tsx` | 1. Decompose `runProjectAgent` (2,140 lines) into pipeline phases: `RunContextBuilder`, `ToolAssemblyNode`, `SupervisorExecutionNode`, and `TaskJournalNode`.<br>2. Split `notebook-documents.ts` into `DocxRenderer.ts`, `PdfRenderer.ts`, `PptxRenderer.ts`, and `DocumentPlanSanitizer.ts`.<br>3. Split `SettingsModal.tsx` into modular section views loaded on demand.<br>4. Decompose `NotebookView.tsx` into sub-views: `NotebookSourcesPanel`, `NotebookChatPanel`, and `NotebookStudioGrid`. |
| **P3** | **Domain-Driven Directory Restructuring in `electron/`** | `electron/*` (105 files) | Restructure `electron/` into domain modules:<br>- `electron/core/` (`agentcore/`, `agent/`, `loop-prevention.ts`, `task-routing.ts`, `rate-limit.ts`)<br>- `electron/domains/code/` (`worktree`, `diff`, `lsp`, `terminal`, `daemon`, `repo`)<br>- `electron/domains/home/` (`home-*`, `deliverable-inspect`, `artifacts`)<br>- `electron/domains/notebook/` (all 21 `notebook-*` files)<br>- `electron/plugins/` (manifest, host, lifecycle, sandbox, skills, hooks, mcp)<br>- `electron/platform/` (`main.ts`, `preload.cts`, `os-sandbox`, `permissions`, `net-guard`) |
| **P4** | **Unify Tool Execution Pipeline** | `electron/agent/builtin-tool-catalog.ts`<br>`electron/tool-executor.ts`<br>`electron/agent-service.ts` | Route built-in tools through `tool-executor.ts` using their registered capability IDs (`builtin:<tool>`). This standardizes parameter validation, timeout cancellation, secret redaction, and policy hook enforcement across all first-party and third-party tools. |
| **P5** | **Establish a Shared Types Package / Directory** | `electron/agent-types.ts`<br>`src/types.ts`<br>`src/vite-env.d.ts`<br>`tsconfig.json`<br>`tsconfig.electron.json` | Create `shared/types/` containing pure TypeScript interfaces for sessions, projects, agent events, usage, and provider configs. Configure path aliases (`@nexus/shared`) in both `tsconfig.json` and `tsconfig.electron.json` to eliminate manual triple-entry contract maintenance and prevent schema drift. |
| **P6** | **Refactor Renderer State Architecture & Eliminate UI Cycles** | `src/App.tsx`<br>`src/state/useAppController.ts`<br>`src/views/AgentView.tsx`<br>`src/components/chat/ChatMessageItem.tsx`<br>`src/components/common/VisualFullscreen.tsx` | 1. Move `ModelSelect` out of `views/AgentView.tsx` into `components/settings/ModelSelect.tsx`.<br>2. Move `parseEventText` from `ChatMessageItem.tsx` into `utils/chat-parser.ts`.<br>3. Extract `openVisualFullscreen` event dispatch into a standalone utility `utils/visual-event.ts`.<br>4. Split `useAppController` into segmented React contexts (e.g., `WorkspaceContext`, `SessionContext`, `ModalContext`) to avoid 80-variable destructuring and reduce unnecessary full-tree re-renders. |

---

## 5. Verification Method

To independently verify the observations, structural cycles, and compiler health reported above:

1. **Verify TypeScript Compilation & Type Health**:
   Execute the project type-checker against both main and renderer configurations:
   ```powershell
   npm.cmd run check
   ```
   *Expected outcome*: Exits with code 0. `tsc --noEmit -p tsconfig.json` and `tsc --noEmit -p tsconfig.electron.json` succeed.

2. **Verify Circular Dependencies**:
   Execute a Node script to trace direct two-node cycles across `electron/`:
   ```powershell
   node -e 'const fs=require("fs"),path=require("path");function getTs(d){let r=[];for(const f of fs.readdirSync(d)){const p=path.join(d,f);if(fs.statSync(p).isDirectory())r=r.concat(getTs(p));else if(f.endsWith(".ts"))r.push(p);}return r;}const files=getTs("electron");const g=new Map();for(const f of files){const m=path.relative("electron",f).replace(/\\/g,"/").replace(/\.ts$/,"");const c=fs.readFileSync(f,"utf8");const d=[];const re=/from\s+[\x22\x27](\.[^\x22\x27]+)[\x22\x27]/g;let match;while((match=re.exec(c))!==null){const r=path.relative("electron",path.resolve(path.dirname(f),match[1].replace(/\.js$/,""))).replace(/\\/g,"/");d.push(r);}g.set(m,d);}const c=new Set();for(const [m,deps] of g){for(const dep of deps){if(g.has(dep)&&g.get(dep).includes(m))c.add([m,dep].sort().join(" <-> "));}}console.log(Array.from(c));'
   ```
   *Expected outcome*: Outputs the 5 direct cycles cited in Section 1.5 (`agent-service <-> subagent-service`, `agentcore/backend <-> command-service`, `code-tools <-> lsp-service`, `notebook-library <-> notebook-vectors-sqlite`, `store <-> subagent-service`).

3. **Verify File Line Counts & Monolith Citations**:
   Inspect line counts of cited god objects:
   ```powershell
   (Get-Content electron/agent-service.ts | Measure-Object -Line).Lines
   (Get-Content electron/notebook-documents.ts | Measure-Object -Line).Lines
   (Get-Content src/App.tsx | Measure-Object -Line).Lines
   (Get-Content src/views/NotebookView.tsx | Measure-Object -Line).Lines
   ```
   *Expected outcome*: Confirms `agent-service.ts` > 2,100 lines, `notebook-documents.ts` > 2,000 lines, `App.tsx` > 2,500 lines, `NotebookView.tsx` > 2,000 lines.

4. **Verify Clean Working Tree**:
   Confirm that zero project source files were modified during the investigation:
   ```powershell
   git status --porcelain
   ```
