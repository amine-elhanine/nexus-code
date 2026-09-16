# Nexus

Nexus is a desktop autonomous AI agent built with Electron + React + TypeScript. It combines **LangChain** (models and tools), **LangGraph** (deterministic outer workflow) and **DeepAgents** (long-running agentic loop, planning, project context).

The app has **three equal modes** in one window (topbar tabs `Home | Code | Notebook`):

| Mode | Needs a project? | What it does |
| --- | --- | --- |
| **Home** | No — built-in folder `~/Documents/Nexus` | Everyday assistant: chat, web research, writes Word / Excel / PowerPoint / LaTeX / Markdown files with preview + download. |
| **Code** | Yes — any local repository | Coding agent: Plan/Ask/Auto loop that edits code, runs typecheck + targeted tests, repairs failures, with diff review, worktrees and rollback. |
| **Notebook** | No — its own notebook library | Grounded Q&A over your documents (PDF, DOCX, XLSX, PPTX, CSV, LaTeX) plus YouTube transcripts and website crawls: hybrid retrieval, citations, groundedness verdicts, saved notes. |

All three share providers (15), streaming + token/cost display, attachments, voice dictation, browser, MCP/Skills and auto-updates. Code is the only mode with repo verification, diffs and worktrees; Home is the only mode with the Nexus folder; Notebook is the only mode with sources/chunks/citations.

---

## Mode 1 — Home (general assistant)

No repository needed. The Home area is a built-in project rooted at `~/Documents/Nexus` (`electron/home-service.ts`, `HOME_PROJECT_ID = "home"`).

### What you can do

- **Chat + research**: ask anything, `Search the web for …` via keyless DuckDuckGo Lite `web_search` / `web_fetch` (8 results, 12 s timeout, best-effort scrape).
- **One-click starters** (`src/views/HomeView.tsx` → `SUGGESTIONS`): `Write a Word report (.docx)`, `Build a presentation (.pptx)`, `Make a spreadsheet (.xlsx)`, `Research the web` — each pre-fills the prompt.
- **Documents the agent really builds**: Word (`.docx` via `docx-preview` round-trip), PowerPoint (`.pptx` via `@aiden0z/pptx-renderer`), Excel (`.xlsx` via `xlsx`), PDF, Markdown, LaTeX (KaTeX rendering in chat). The agent typically generates them via a throwaway script (e.g. `generate_report.py`) — see cleanup below.
- **Nested output**: files can land in subfolders; the file list walks recursively (latest 200, newest first).

### Nexus folder mechanics (the details that matter)

- **Ownership per chat**: every file belongs to exactly one session — the most recent session created at/before the file's mtime (60 s tolerance; predated files go to the earliest session). Works even when the file was produced indirectly by `execute`, where tool args never name the output (`listHomeSessionFiles`).
- **Session files vs all files**: right sidebar `Artifacts` tab shows only this chat's files; `Session` tab shows the folder summary + counts. Header has `Files` (open folder in OS) and `New chat`.
- **Preview + download**: `FilePreviewModal` reads via `home:readFile` (30 MB cap — larger files degrade to “download instead”); `downloadHomeFile` opens a save dialog and copies out. Path-escape checked (`Path escapes the Home folder`).
- **Generator cleanup** (`cleanupHomeGeneratorScripts`): after a run that produced a fresh deliverable (docx/xlsx/pptx/pdf/…), throwaway generator scripts (`.py/.js/.ts/.sh/.ps1/.bat/…` created during the run) are deleted automatically — unless you explicitly asked for code/scripts (`CODE_REQUEST_PATTERN`).
- **Agent loop**: same DeepAgents loop with `taskKind: "general"` — document-oriented system prompt, **no code-project verification** (no typecheck/test gate), doom-loop breaker and rate-limit resume still apply.
- **Composer**: textarea (Enter to send), paperclip attach (images, PDF, Word, Excel, PowerPoint, TeX, text — `ATTACHMENT_ACCEPT`), image chips with preview + remove, model picker, per-session token/cost pill (`Session: 12.4k tokens ~$0.0231`, `—` when pricing unknown).
- **Transcript**: user/assistant bubbles + collapsed `ActivityGroupView` tool steps, sticky-to-bottom unless you're reading history, `RichMarkdown` (KaTeX + Mermaid).

### Home files in code

- Backend: `electron/home-service.ts` (`getHomeRoot`, `ensureHomeDir`, `listHomeFiles`, `listHomeSessionFiles`, `downloadHomeFile`, `openHomeFolder`, `cleanupHomeGeneratorScripts`, `readHomeFile`).
- Frontend: `src/views/HomeView.tsx`, `src/components/home/FilePreviewModal.tsx`, `AttachmentPreviewModal.tsx`, `src/state/useAppController.ts` (`homeRoot`, `homeFiles`, `homeSessionFiles`, `createHomeSession`, `refreshHomeFiles`).

---

## Mode 2 — Code (coding agent)

Open any local repo. Center toggles **Agent chat ↔ Editor** (Monaco, multi-tab, dirty tracking); right pane tabs: `Session | Files | Browser | Term | Diff | Memory`.

### Agentic loop with repair pass

Every run executes `START → brief → deep_agent → verify → (repair) → END` (`electron/agent-service.ts`):

- **`brief`** — session context, compacted history excerpt (4 000 chars), active-mode announcement.
- **`deep_agent`** — DeepAgents + todo-list middleware + project/session memory + repo-map symbol outline + rules + skills + MCP + subagents (`researcher | tester | coder` with real `usage_metadata`) + file tools + `apply_patch` + clarification tool + browser tools + web search.
- **`verify`** — static check (`npm run typecheck` > `npm run check` > `tsc --noEmit` > `npm run lint` > `cargo check` > `go vet` > `ruff check`) + targeted tests (`findTargetedTests`; JS/TS returns `null`, never `node <file>`). Failures are fed back with the full transcript kept for a targeted repair.
- **Plan skips verify** (`MAX_REPAIRS = 0`). **Resume**: bounded retries with exponential backoff honoring `Retry-After`; resume from last complete superstep. **Doom-loop breaker** aborts exact-repeat tool calls.

| Mode | Budget (`recursionLimit`) | Repairs | Behavior |
| --- | --- | --- | --- |
| **Plan** | 40 | 0 | Strict read-only backend. Inspects + writes a detailed plan, zero edits. |
| **Ask** | 100 | 1 | Standard: implement, verify once, summarize. |
| **Auto** | 150 | 3 | Extended autonomous: plan → implement → verify → auto-repair. |

Fast path for single-lookup/single-edit tasks: 50 supersteps. Switch via the `Plan/Ask/Auto` selector or slash commands `/plan`, `/ask`, `/auto`, `/review` (+ project `.nexus/commands/*.md`, `.forgepilot/commands` fallback, `{{input}}` / `{{activeFile}}` placeholders, `/` popup, `@file` mention autocomplete with 8-file fuzzy list).

### Review safety net: checkpoints, diff, worktrees

- **Snapshots before every run** on disk: `.nexus/checkpoints/<id>.json` (+ `.nexus/run-checkpoints/` for resume). Survive restarts. **Undo run** card restores the exact pre-run tree; unknown/expired id → explicit error, never a silent mass-revert.
- **Diff tab** (`workspace:diff`): `git diff HEAD` in one pass (numstat + unified, `--no-renames`), per-file `+/−`, status codes, `MonacoDiffModal` inspect (original = `git show HEAD:<path>`, patch-parse fallback for untracked files), per-file `revertFile`, `Discard all`. Telemetry (`.nexus/`, `.forgepilot/`, `.deepagents/`, `.git/`) always excluded.
- **Opt-in worktrees**: per-session isolated tree at `.forgepilot/worktrees/<session-id>`, branch `forgepilot/session-<session-id>`. `WorktreeBar`: **Merge to Main / Discard** (confirm modal, not `window.confirm`). Telemetry (trajectories, artifacts, run checkpoints) stays in the real root so discard never loses history.
- **Memory**: project memory (shared across sessions) vs session memory (local); agent appends after runs; edited in `MemoryView`. **Project rules** auto-injected from `.cursorrules`, `AGENT.md`, `AGENTS.md`, `CLAUDE.md`, `.windsurfrules`, `.nexus/rules` (`.forgepilot/rules` fallback), viewable in `ProjectRulesModal`.
- **Artifacts & trajectory**: deliverables in `.nexus/artifacts/` (`draft | pending_approval | approved | completed | rejected`, approve-and-execute re-submits the plan in Auto); full JSONL transcripts in `.nexus/trajectories/` (`USER|MODEL|TOOL|SYSTEM`), readable from the UI.
- **Composer note** (honest): “Nexus runs real commands and edits files in this workspace — review the Diff tab before keeping changes.”

### Terminal, daemons, browser (Code scope)

- **Real PTY** (`electron/pty-host.cjs` + `@homebridge/node-pty-prebuilt-multiarch`, JSON-lines `spawn/write/resize/kill` → `ready/data/exit/error` under system Node; Electron can't load native PTYs in-process). PTY-first with piped-shell fallback, generation-guarded teardown, `terminal:resize` from xterm FitAddon (`XTermView`).
- **Services manager** (`DaemonsModal`): start/watch/stop dev servers (Vite, Next, APIs), log buffers, live port detection (`localhost:5173`, `port 3000`) → open in built-in browser.
- **Browser** (partition `persist:browser-code`, never host cookies): sidebar webview (back/forward/reload in place, `openExternal` for outside links) + hidden agent executor (`AgentBrowserHost`, same partition). Agent tools: `browser_inspect` / `browser_fetch_api` (manual capped redirect walk, `http(s)` only) + `browser_act` (element snapshots `e3…`, click, React-compatible fill, keys, scroll, navigate, screenshots to `.nexus/browser/`). **Headless / Watching** toggle — Watching makes the sidebar follow the agent live.

### Code files in code

- Backend: `agent-service.ts`, `command-service.ts`, `permissions.ts`, `approval-service.ts`, `context-service.ts`, `rate-limit.ts`, `subagent-service.ts`, `code-tools.ts`, `project-tools.ts`, `edit-tools.ts`, `repo-map-service.ts`, `rules-service.ts`, `custom-commands-service.ts`, `diff-service.ts`, `worktree-service.ts`, `artifacts-service.ts`, `trajectory-service.ts`, `terminal-service.ts` + `pty-host.cjs`, `daemon-service.ts`, `browser-service.ts` + `browser-tool.ts`.
- Frontend: `src/views/AgentView.tsx` (+ `ModelSelect`), `DiffView.tsx`, `MemoryView.tsx`, `components/editor/MonacoEditorView.tsx`, `terminal/XTermView.tsx`, `browser/SidebarBrowser.tsx` + `IntegratedBrowserView.tsx` + `AgentBrowserHost.tsx`, `diff/MonacoDiffModal.tsx`, `worktree/WorktreeBar.tsx`, `chat/` (`ChatMessageItem`, `PlanCard`, `SubagentCard`, `ArtifactCard`, `SlashCommandPopup`), `rules/ProjectRulesModal.tsx`, `artifacts/ArtifactViewer.tsx`, `daemons/DaemonsModal.tsx`.

---

## Mode 3 — Notebook (grounded Q&A over your documents)

NotebookLM-style research desk with its own 3-pane layout **inside the view** (sources | chat | studio-notes); the app-level context pane stays hidden (`src/views/NotebookView.tsx`; state in `src/state/useNotebookController.ts`).

### Library model

- **Multiple notebooks** (`notebook:list|create|rename|delete`): each has sources, chats, notes, custom instructions, stats. Sessions-first: never auto-enters — you click a session.
- **Chats per notebook** (`notebook:chats|createChat|deleteChat`): independent conversations with own streaming tokens (`streamByChat`), working steps (`stepsByChat`), citations, evaluations and retrieval metadata. Transcript export to Markdown (`# Notebook — Chat` + `## You / ## Notebook` + `**Sources:** [S1] …`).
- **Notes / Studio** (`notebook:notes:list|save|delete`): save any passage or answer as a cited note (`title + content + citations`), persisted per notebook.
- **Instructions**: per-notebook custom system instructions (`notebook:settings:get|save`), editable inline, applied to every answer.

### Ingest pipeline (async job queue)

Status per source (`NotebookSourceStatus`): `uploaded → parsing → chunking → indexing → ready`, or `failed` with error text. UI badges: `queued / parsing… / chunking… / indexing… / ready / failed` with spinner; auto-poll every 3 s while anything is pending; manual refresh, per-source delete / re-index, global re-index-all (`notebook:reindexSource`, `notebook:reindexAll`).

- **File upload** (`notebook:pickFiles` / drag-and-drop): PDF, DOCX, XLSX, PPTX (slides), CSV, TeX (+ plain text/markdown). Reports `parser`, `pageCount`, `chars`, `chunks`, `fingerprint`.
- **Link imports** (no API key, same ingest pipeline after fetch):
  - **YouTube** (`notebook:importYouTube`, `electron/notebook-youtube.ts`): paste a watch / youtu.be / embed / shorts / live URL (or bare 11-char id) — the public caption track is fetched as WebVTT and stored as timestamped (`[mm:ss]`) Markdown. Videos without captions (private / region-blocked / caption-less) fail with a friendly error.
  - **Website** (`notebook:importWebsite`, `electron/notebook-web.ts`): paste one `http(s)` URL — the start page plus a bounded same-origin BFS crawl (page/depth caps) is combined into a single source document. Plain HTTP fetch only, so heavily JS-rendered pages may come back thin (flagged per page instead of silently stored).
- **Chunking** (`electron/notebook-text.ts`, pure core): `cleanMarkdown`, section-aware `chunkSections`, `sha256Hex`/`uuid5` ids, upload validation, groundedness gate. Covered by `test/notebook-text.test.mjs` + `notebook-parse.test.mjs`.
- **Library store** (`electron/notebook-library.ts`): relational JSON (`LibraryDocument/Section/Chunk`) + vector partition, neighbor expansion (prev/next chunk), `sessionOutline`, session summary/digest (`topics + updatedAt`).
- **Jobs** (`electron/notebook-jobs.ts`): `enqueueIngest → parse → chunk → embed → index`, with `retrySource`, `reindexSessionFromLibrary`, `recoverInterruptedJobs` after restart. Covered by `notebook-pipeline.test.mjs` + `notebook-library.test.mjs`.
- **Stats** (`notebook:stats`): sources, ready sources, chunks, sections, embedding model + dims, entities, conversations, digest.

### Retrieval + answering (grounded, cited)

- **Hybrid retrieve** (`electron/notebook-rag.ts` → `hybridRetrieve`): vector + keyword fusion, local rerank (opt-in LLM cross-encoder via `NEXUS_NOTEBOOK_LLM_RERANK=1`), neighbor expansion, per-source scope respected. `notebook:retrieve` for inspection; `notebook:ask` streams tokens.
- **Citations on every answer** (`NotebookCitation`): `[S1]` numbered refs with `sourceId`, `sourceName`, `chunkId`, `heading`, `excerpt` (400 chars), `snippet`, `score`. Clicking a citation opens the passage modal at that exact chunk.
- **Groundedness verdict** (`NotebookEvaluation`): `grounded / partial / ungrounded` + score + `issues[]`; chat-level average shown in the header (`evals: n, avg: x/10`). Refusals and fallback-model usage flagged in `metadata` (`routing`, `topScore`, `refused`, `fallbackModel`).
- **Source scoping**: per-source include/exclude toggles (`excludedIds`; empty = all files), `resetScope`, scoped ids sent with every query. Scope chips + counts in the sources pane.
- **Passage viewer** (`SourcePassageModal`, `notebook:passage`): full chunk text + prev/next context + section summary + heading path; one-click agent actions: `explain` (define terms, stay grounded), `simplify` (plain language), `compare` (agreements/differences/uncertainty across sources), `quiz` (one question at a time), `save` (to Studio notes).
- **Embeddings, pluggable** (`electron/notebook-embeddings.ts`): `openai | ollama | gemini | cohere` (`notebook:embedding-providers`, save/remove/test), `embedQuery`, plus a **local offline fallback** so the notebook works with no embedding key. Model + dims recorded in stats and every answer (`embeddingModel`, `dims`).
- **Flags** (`electron/notebook-flags.ts`, `NEXUS_NOTEBOOK_*=0|1`): `LLM_ROUTER` (default on — structured-output routing, heuristics fallback), `SESSION_DIGEST` (default on — outline + topics when all files ready), `SYNTH_QUESTIONS` / `CLOUD_PARSER` / `LLM_RERANK` (default off). Base pipeline never depends on a flagged path.

### Notebook files in code

- Backend: `electron/notebook-store.ts` (CRUD + `importSourceBuffer`/`pickAndImportSourceFiles`), `notebook-parse.ts`, `notebook-text.ts`, `notebook-library.ts`, `notebook-embeddings.ts`, `notebook-jobs.ts`, `notebook-rag.ts`, `notebook-flags.ts`, `notebook-youtube.ts` (keyless transcript fetch), `notebook-web.ts` (same-origin crawl).
- Frontend: `src/views/NotebookView.tsx`, `src/components/notebook/SourcePassageModal.tsx`, `src/state/useNotebookController.ts` (`notebooks/activeNotebook/sources/chats/activeChat/stats/draft/asking/notice/embedding/excludedIds/streamByChat/stepsByChat/passage/settings/notes` + `create/remove/renameNotebook`, `create/removeChat`, `uploadFromPicker/uploadBrowserFiles`, `ask`, `toggleScope/resetScope`, `openPassage/closePassage`, `saveInstructions/saveNote/removeNote`, `reindexAll`).
- Tests: `npm run test:notebook` (text, parse, library, pipeline).

---

## Shared systems (all three modes)

### Command execution model (no sandbox — read this)

Commands run **directly on your machine with your user privileges**. No container or VM isolation:

- **Deny backstop** (`electron/permissions.ts`): catastrophic patterns never run (`rm -rf /`, `rm -rf ~`, `mkfs`, `dd … of=/dev/`, fork bombs, `shutdown/reboot`, `format`, `diskpart`, shadow-copy deletion, `bcdedit`, `reg delete`, recursive deletes of drive roots/profiles, `net user /add`, …). A backstop against agent mistakes, not a boundary.
- **Ask gate** (`classifyCommand` + modal **Deny / Allow for run / Allow once**): `git push|reset|clean|rebase`, dependency mutations (`npm|pnpm|yarn|pip|cargo install|add|remove`), `curl … | sh|bash`, `Invoke-WebRequest/iwr/irm`. Project policy via `.nexus/permissions.json` or `package.json#nexus.permissions`.
- **Per-run cancellation**: each run owns its children; Stop kills only that run (`taskkill /T /F` on Windows). Daemons + terminals killed on `before-quit`. **Daemon env scrubbed** (structural vars like `PATH` only). **Keys encrypted at rest** (`safeStorage`: DPAPI / Keychain / libsecret).
- Need isolation → run Nexus in a dedicated VM/container.

### Providers, MCP, Skills (shared)

- **15 providers** (`electron/providers.ts` → `PROVIDERS`): `openai`, `anthropic`, `google` (Gemini), `mistral`, `groq`, `xai`, `openrouter`, `ollama` (`http://127.0.0.1:11434`), `deepseek`, `opencode-zen` gateway, `together`, `fireworks`, `azure`, `bedrock`, `custom` (any OpenAI-compatible `baseUrl`). Per-model `chat | responses | messages` overrides; Zen sends `x-opencode-*` headers. Env fallback per provider (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `OLLAMA_BASE_URL`, …). Unknown/local pricing → cost shows `—` (`formatCost`).
- **MCP** (`mcp-service.ts`): `stdio | http | sse`, cached client per config fingerprint, save/test UI. Runs with your privileges.
- **Skills** (`skills-service.ts`): global (`userData/skills`) + project (`.nexus/skills`, legacy `.deepagents/skills` read-only), path-confined list/read/import/create/delete, per-run recommendation, global on/off toggle.
- **Web search for all**: Home research + Code/Notebook context via the same DuckDuckGo Lite tools.
- **Themes** (`src/state/theme.ts`): 8 themes (Nexus Emerald default, Midnight Ocean, Grape Nebula, Ember Sunset, Crimson Rose, Lagoon Teal, Moss Citrus, Daylight Paper light), persisted as `nexus-theme`.

---

## Installation

Requires Node 20+ and `npm`. On Windows with restricted `.ps1` execution, use the `.cmd` binaries:

```powershell
npm.cmd install
```

Then connect providers from the **Providers** modal (paste a key or point at local Ollama). Env fallback:

| Variable | Role | Default |
| --- | --- | --- |
| `OPENAI_API_KEY` | OpenAI key | None |
| `OPENAI_BASE_URL` | OpenAI-compatible endpoint | Standard OpenAI endpoint |
| `OPENAI_MODEL` | Default model | `gpt-4.1-mini` |

Each provider respects its own env key too (see `electron/providers.ts`).

---

## Useful commands

- **Typecheck (both projects)**:
  ```powershell
  npm.cmd run check
  ```
- **Integration suite (agent + workspace)**:
  ```powershell
  npm.cmd test
  ```
- **Unit tests (rate-limit, checkpoint-resume)**:
  ```powershell
  npm.cmd run test:unit
  ```
- **Notebook pipeline tests (text, parse, library, pipeline)**:
  ```powershell
  npm.cmd run test:notebook
  ```
- **Dev mode**:
  ```powershell
  npm.cmd run dev
  ```
- **Production bundle + run**:
  ```powershell
  npm.cmd run build
  npm.cmd start
  ```
- **Packaging (installers in `release/`)**:
  ```powershell
  npm.cmd run dist
  npm.cmd run dist:dir
  ```

---

## Publish an update (auto-update)

Launch-time check (installed builds only) via `electron-updater` against public `L7A9/nexus` releases (`build.publish`). Badge in topbar → auto-download → click to restart. Settings → Updates for manual check.

```powershell
# 1. Bump version in package.json (e.g. 0.3.6)
# 2. Build + publish (latest.yml included):
$env:GH_TOKEN = "github_pat_..."
npm.cmd run dist -- --publish always
```

Notes: only NSIS Setup self-updates (Portable re-downloads); dev runs just report local version (`NEXUS_UPDATE_DEV=1` + `dev-app-update.yml` for real-flow testing); targets Windows (`nsis`, `portable`), macOS (`dmg`), Linux (`AppImage`).

---

## Project structure

- `electron/` — backend and system services.
  - `main.ts` — lifecycle, window, IPC, `nexus-attachment://`, browser partitions (`persist:browser-home`, `persist:browser-code`), Home/notebook bootstrap, `agent:run` orchestration.
  - `agent-service.ts` — LangGraph (`brief → deep_agent → verify → repair`), `AgentMode plan|ask|auto` (40/100/150, repairs 0/1/3), `AgentTaskKind code|general`, transcript-preserving repair, usage.
  - `command-service.ts` / `permissions.ts` / `approval-service.ts` — direct execution, per-run cancel, `deny|ask|allow`, approval bridge. No sandbox.
  - `context-service.ts` / `rate-limit.ts` / `subagent-service.ts` — tokens + compaction, backoff + `Retry-After` resume, researcher/tester/coder delegation.
  - `code-tools.ts` / `project-tools.ts` / `edit-tools.ts` / `repo-map-service.ts` — symbols, path-safe I/O, `apply_patch`, clarification tool, cached outline.
  - `rules-service.ts` / `custom-commands-service.ts` / `skills-service.ts` — rules, slash commands (`/plan /ask /auto /review` + project), `SKILL.md` library.
  - `diff-service.ts` / `worktree-service.ts` — one-pass `git diff HEAD` + reverts + `.nexus/checkpoints/`; `.forgepilot/worktrees/` + `forgepilot/session-*`.
  - `artifacts-service.ts` / `trajectory-service.ts` — `.nexus/artifacts/` deliverables, `.nexus/trajectories/` JSONL.
  - `terminal-service.ts` + `pty-host.cjs` — out-of-process PTY + piped fallback.
  - `daemon-service.ts` / `browser-service.ts` / `browser-tool.ts` / `websearch-tool.ts` / `mcp-service.ts` — dev servers, hidden webviews + act/inspect/fetch, DDG search, cached MCP.
  - `home-service.ts` — `home` project: `getHomeRoot/ensureHomeDir/listHomeFiles/listHomeSessionFiles/downloadHomeFile/openHomeFolder/cleanupHomeGeneratorScripts/readHomeFile`.
  - `notebook-store.ts` / `notebook-parse.ts` / `notebook-text.ts` / `notebook-library.ts` / `notebook-embeddings.ts` / `notebook-jobs.ts` / `notebook-rag.ts` / `notebook-flags.ts` / `notebook-youtube.ts` / `notebook-web.ts` — full RAG stack (see Mode 3).
  - `providers.ts` (15 defs + endpoint resolution + Zen headers), `repo-service.ts` (git detect/init), `store.ts` (`nexus-state.json` + `forgepilot-state.json` fallback, `safeStorage`), `updater-service.ts` (`idle|checking|up-to-date|available|downloading|downloaded|error`), `preload.cts` (`window.nexus` + legacy `window.forgepilot`).
- `src/` — React frontend.
  - `App.tsx` — shell: `Home|Code|Notebook` tabs, session pane, workspace, resizable context pane (220–600 px, `nexus-context-width`), modals, hidden `AgentBrowserHost`.
  - `state/useAppController.ts` — projects/sessions/providers/runs, per-area drafts + attachments, files/diff/terminals/daemons IPC, `enterHome/enterCode/enterNotebook`.
  - `state/useNotebookController.ts` — notebooks/sources/chats/notes/instructions/passages/embeddings (see Mode 3).
  - `views/` — `HomeView` (chat + Nexus folder), `AgentView` (Plan/Ask/Auto + mentions + slash + worktree + artifacts), `NotebookView` (sources/chat/studio), `DiffView` (split patch + revert), `MemoryView` (project vs session).
  - `components/` — `chat/` (message/activity/plan/subagent/artifact/slash/voice), `browser/`, `terminal/` (xterm), `editor/` (Monaco), `diff/`, `daemons/`, `worktree/`, `rules/`, `artifacts/`, `home/` (preview + attachment modals), `notebook/` (passage modal), `settings/` (providers/MCP/skills), `common/` (logo, window controls, KaTeX/Mermaid markdown).
  - `modals/` — `ProviderModal`, `McpModal`, `SkillsModal`, `SettingsModal` (incl. Updates), `ProjectPickerModal`, `ConfirmModal`.
  - `types.ts` — contracts: sessions, providers, MCP, skills, `Notebook*` RAG (sources, citations, evaluations, passages, embeddings), updater, …
- `landingPage/` — static site with always-latest Releases wiring (`app.js` → `L7A9/nexus`, exact Setup/Portable asset URLs, releases-page fallback) and screenshots for Home / Code / Notebook.
- `test/` — `sandbox-and-agent.test.mjs` (integration), `rate-limit` + `checkpoint-resume` (unit), `notebook-text/parse/library/pipeline` (RAG).
- `docs/` — `fix-plan.md` (historical implementation record), findings notes for execution model + UI.

`forgepilot` is legacy-only: `window.forgepilot` bridge, `forgepilot-state.json` fallback, `.forgepilot/` worktree/rules/commands fallbacks, `forgepilot/session-*` branches. Product name: **Nexus**.

---

## Technical references

- [LangChain JS](https://docs.langchain.com/oss/javascript/langchain/overview)
- [LangGraph JS](https://docs.langchain.com/oss/javascript/langgraph/quickstart)
- [DeepAgents JS](https://docs.langchain.com/oss/javascript/deepagents/overview)

Built with Electron + LangChain + LangGraph + DeepAgents.
