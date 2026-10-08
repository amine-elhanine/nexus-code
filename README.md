<div align="center">

<img src="public/icon.png" width="96" alt="Nexus logo" />

# Nexus

**The autonomous AI agent for your desktop — Code it. Draft it. Prove it.**

A coding agent for any repo, a general assistant that ships real documents, and a grounded research
notebook — one native desktop app.

Windows 10 / 11 (NSIS + Portable) — macOS & Linux planned

![Electron](https://img.shields.io/badge/Electron-44-47848F?logo=electron&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-7-3178C6?logo=typescript&logoColor=white)
![LangGraph](https://img.shields.io/badge/LangGraph-1.x-1C3C3C)
![DeepAgents](https://img.shields.io/badge/DeepAgents-1.x-34d399)

**[Download the latest release](https://github.com/amine-elhanine/nexus/releases/latest)** ·
**[Landing page](landing_page/index.html)**

</div>

---

Nexus is a **desktop autonomous agent** built with **Electron + React + TypeScript**. It combines
**LangChain** (models and tools), **LangGraph** (deterministic outer workflow, checkpoints,
verify/repair supervision) and **DeepAgents** (long-running agentic loop, planning, filesystem
backend). Everything runs on your machine: your keys, your models (including local Ollama), your
data in local storage — no Nexus cloud in the middle.

---

## The three modes

Nexus's top bar switches between three product surfaces. They share providers, skills, MCP,
browser, streaming with token/cost metering, and auto-update.

| Mode | What it is | Workspace |
|---|---|---|
| **Home** | General assistant — chat, research the web, create Word / Excel / PowerPoint / PDF / LaTeX / Markdown deliverables | Built-in project rooted at `Documents/Nexus` |
| **Code** | Coding agent for any repository — Plan / Ask / Auto loop, diffs, checkpoints, worktrees, terminal | Any folder you open |
| **Notebook** | NotebookLM-style grounded Q&A over your documents, YouTube videos and web pages — with citations and a groundedness gate | Isolated per-session libraries |

### Home — general assistant

- One-click starters: **Write a Word report · Build a presentation · Make a spreadsheet · Research the web**.
- Real document generation (docx / pptx / xlsx / pdf / md / LaTeX) — not snippets; deliverable files are picked, validated by magic bytes and shown as **artifacts**.
- **Structured long-term memory**: User profile / Preferences / Facts / Project context, injected by relevance into every chat — say *"remember…"* or manage facts with per-fact **Forget** buttons.
- Files the agent creates land in the Nexus folder with preview, download and per-session ownership.

### Code — coding agent

- **Plan / Ask / Auto** control: Plan is hard read-only (no writes, no shell, no MCP), Ask is interactive, Auto runs end-to-end with self-repair.
- **Verify-and-repair loop**: after every run a diff-first verification supervisor checks what the agent changed — typecheck/test cascades for code runs, output contracts for deliverables — and feeds failures back for repair (up to 3 repairs in Ask, 5 in Auto).
- **Multi-level undo**: file snapshots + 20-deep checkpoints; **Undo run** / restore, **per-hunk diff discard**, and Nexus-only commit reset that never touches your own commits.
- **Isolated git worktrees**: run a session in its own worktree + branch (`.forgepilot/worktrees/<session>`), then **Merge to Main**, **Discard**, or **Abort merge** with a conflict resolver.
- **Real tooling**: Monaco editor, xterm.js PTY terminal (out-of-process PTY host), background **daemon manager** (dev servers with live logs, status and port detection), repo map + persistent project index, `@`-file mentions, image attachments (paste, file, PDF, Office).
- **Rules & memory**: reads `.cursorrules`, `AGENTS.md`, `CLAUDE.md`, `AGENT.md`, `.windsurfrules` and `.nexus` rules; project + session memory the agent appends to after runs.
- Code journals: planning / implementation / verification / review phases with run history.

### Notebook — grounded research

- **Sources**: PDF, PPTX, DOCX, TXT/MD, CSV, TeX, images — plus **YouTube** transcripts and **web page** import. Live ingestion pipeline (`queued → parsing → chunking → indexing → ready`) with crash recovery.
- **Chat with citations**: hybrid retrieval (dense SQLite vectors + BM25 + structural signals, with an offline local fallback when no embedding provider is configured), agentic multi-hop search, clickable **[S1]-style citations** that open the exact passage, and a retrieval trace per answer.
- **Groundedness gate**: every answer gets a 0–10 **groundedness score** and verdict (grounded / partial / ungrounded). When your files don't cover the question, Nexus **refuses rather than guesses**.
- **Studio**: one click generates **reports (DOCX/PDF), presentations (PPTX), quizzes (graded, with sources), flashcards, mind maps and summaries** — all built from cited passages of your sources.

---

## Feature highlights

- **15 LLM providers, bring-your-own-key**: OpenAI, Anthropic, Google Gemini, Mistral, Groq, xAI, OpenRouter, DeepSeek, OpenCode Zen, Together AI, Fireworks, Azure OpenAI, AWS Bedrock, **local Ollama**, and any OpenAI-compatible endpoint (with live model discovery).
- **MCP native**: Model Context Protocol servers over **stdio / HTTP / SSE**, warm reconnects, per-server fault isolation (one dead server doesn't drop the rest), connection tester, secrets encrypted at rest.
- **Skills system**: **53 bundled skills** (12 all-purpose, 31 code, 10 home) mounted read-only; bring your own via `SKILL.md` at project (`.nexus/skills`) or global scope, with per-mode scoping and zip import. Skills are recommended per request, not force-fed.
- **38 slash commands** built in (`/plan`, `/auto`, `/review`, `/test`, `/security`, `/pr`, `build-fix`, per-stack sets for React/Python/Rust/Go/…), plus user-defined commands with scope and forced mode.
- **68 specialist subagents** (architect, planner, code-reviewer, security-reviewer, TDD guide, per-language reviewers/build-fixers, …) spawned as nested deep agents — capped at 3 per run, 1 mutating.
- **122 coding rule packs** across 22 language/framework categories, layered with your project rules.
- **Built-in agent browser**: hidden webviews (separate persistent profiles per mode) with rendered-page inspection, SSRF-safe API fetching and `browser_act` actions grounded by element refs — watch it live or let it work headless.
- **Transparent metering**: live streaming, per-message token usage and estimated cost, plan cards, subagent cards, collapsible activity feeds, JSONL trajectory transcripts.
- **9 themes** (7 dark + 2 light), DM Sans / DM Mono type system, emerald brand identity.
- **Auto-update** via GitHub Releases (electron-updater) with in-app download progress pill.

## Architecture

```
                 ┌────────────────────────────────────────────────┐
 brief ──▶ PLAN  │  deep agent (DeepAgents)                       │
                 │   ├ planning + todos (complex tasks)           │
                 │   ├ tools: files · apply_patch · shell ·       │
                 │   │        repo-map/code tools · browser ·     │
                 │   │        web search · memory · MCP ·         │
                 │   │        subagents · ask_user                │
                 │   └ skills mounted per request                 │
                 └───────────────────────┬────────────────────────┘
                                         ▼
                              VERIFY (LangGraph node)
                              diff-first, scoped to this run
                              typecheck / tests / output contract
                                         │  failed?
                              REPAIR ◀───┘  (Ask ≤3, Auto ≤5)
                                         │
                                         ▼
                                   END (+ checkpoint, journal, memory)
```

| Mode | Recursion budget | Auto-repairs |
|---|---|---|
| Plan | 40 | 0 (read-only) |
| Ask | 100 | 3 |
| Auto | 150 | 5 |

Simple tasks take a fast path (50 supersteps). Long histories are compacted (heuristic or
model-backed summarization); provider rate limits are retried with bounded exponential backoff and
resumable checkpoints; a doom-loop breaker stops repeated identical tool calls. Prompt caching is
used for Anthropic models. Every run ends with a checkpoint you can resume ("continue") without
repeating completed steps.

**Stack**: Electron 44 · React 19 · TypeScript · Vite · Monaco · xterm.js · LangChain 1.x ·
LangGraph 1.x · DeepAgents 1.x · SQLite (notebook vectors) · electron-builder + electron-updater.

## Security & approvals (read this)

Nexus executes real commands and edits real files — by design. Its safety model is **approvals +
deny-backstop + encryption**, not a sandbox:

- **Approval gates**: risky commands open a modal with **Deny / Allow once / Allow for session** (120 s timeout defaults to deny). Ask-class heuristics cover `git push/reset/clean/rebase`, package installs, downloaded-code execution, PowerShell dynamic execution/download utilities, and HTTP uploads or mutating requests; ordinary HTTP reads remain allowed.
- **Deny backstop**: hardcoded destructive patterns are always refused, including recursive deletion of system roots, Windows system directories, user profiles (including shell-expanded variables), or relative parent paths (`rm -rf /`, `rm -rf ..`, `Remove-Item -Recurse ..\..`), `mkfs`, `dd of=/dev/…`, fork bombs, diskpart/format, registry deletes, and user adds.
- **Custom policy**: `.nexus/permissions.json` or `package.json → nexus.permissions` with allow/ask/deny glob lists. Agent runs pin the policy when their backend starts, so an agent cannot change its own shell permissions mid-run; user-entered terminal commands use the current policy.
- **Plan mode is hard read-only** — writes, edits, deletes, shell and MCP are all refused.
- **Secrets encrypted at rest** with Electron safeStorage (DPAPI on Windows, Keychain on macOS, libsecret on Linux). Child processes never inherit secrets: terminal env is scrubbed, daemons run with a strict structural allowlist.
- **No telemetry leaves your machine**; transcripts are local JSONL. External links open in your system browser.

Honest limitations: shell command execution is allow-by-default outside the ask/deny classes; treat the approval model as guardrails, not isolation.

## Data & storage

| What | Where |
|---|---|
| App state (projects, sessions, providers, MCP, settings) | `%APPDATA%/nexus/nexus-state.json` (secrets safeStorage-encrypted) |
| Project index, checkpoints, artifacts, browser shots, trajectories | `<project>/.nexus/` |
| Session worktrees | `<project>/.forgepilot/worktrees/` |
| Home deliverables | `Documents/Nexus` |
| Skills (project) | `<project>/.nexus/skills/` |

## Getting started

**Prerequisites**: Node.js 20+, npm. Windows-first (NSIS Setup + Portable); macOS DMG and Linux AppImage targets are configured.

```bash
# install (on restricted PowerShell, use npm.cmd)
npm install

# run in dev (Vite + Electron, hot reload)
npm run dev

# typecheck renderer + main
npm run check

# tests
npm test              # Electron integration suite (sandbox + agent)
npm run test:unit     # 13 unit suites (rate limit, checkpoints, loop prevention, memory, …)
npm run test:notebook # 7 notebook suites (~264 assertions on the deterministic core)

# production build + run
npm run build
npm start

# package installers into release/
npm run dist          # or: npm run dist:dir
```

**Download prebuilt binaries**: see [GitHub Releases](https://github.com/amine-elhanine/nexus/releases/latest) — `Nexus.Setup.<version>.exe` (auto-updating NSIS installer), `Nexus.<version>.Portable.exe`, DMG and AppImage targets. Only the NSIS install self-updates; Portable re-downloads.

**Publish an update**: bump `version` in `package.json`, then `GH_TOKEN=<github_pat> npm run dist -- --publish always` (publishes to the releases repo `amine-elhanine/nexus`, including `latest.yml`; source lives at `amine-elhanine/nexus-code`). For testing the update flow in dev: `NEXUS_UPDATE_DEV=1` + `dev-app-update.yml`.

### Optional environment variables

Every provider can also be configured in-app (Settings → AI Providers); keys are encrypted at rest. Env vars are supported for zero-UI setups:

`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `MISTRAL_API_KEY`, `GROQ_API_KEY`, `XAI_API_KEY`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`, `OPENCODE_API_KEY`, `TOGETHER_AI_API_KEY`, `FIREWORKS_API_KEY`, `AZURE_OPENAI_API_KEY`, `AWS_ACCESS_KEY_ID`, `CUSTOM_API_KEY`, `OLLAMA_BASE_URL` (default `http://127.0.0.1:11434`), plus `OPENAI_BASE_URL` / `OPENAI_MODEL` overrides and `NEXUS_HOME_ROOT` (Home workspace override, used by tests). Notebook feature flags live in `electron/notebook-flags.ts` (`NEXUS_NOTEBOOK_*`).

### Agent evaluations

`npm run eval:agent` runs the Code/Home benchmark cases against a configured headless provider and writes a JSON report under `.nexus/evals/`. Use `npm run eval:agent -- --repeat 3` to measure consistency, or `npm run eval:agent -- --case code-subtotal-cents --compare-assets skills,rules --repeat 2` for a paired baseline/ablation report with wins, losses, ties, pass-rate, token, and estimated-cost deltas. That comparison runs one baseline plus one run per selected asset for every case and repeat. `--without-assets skills,rules,commands,agents` runs one ablated configuration. Keys encrypted for the desktop app cannot be read by the headless CLI; pass `--api-key <key>` or set `NEXUS_API_KEY` for that run. The evaluator checks provider readiness before creating fixtures and reports missing or desktop-only credentials without printing their values. Notebook's deterministic offline benchmark is `npm run eval:notebook`.

## Project structure

```
electron/                 main process (NodeNext TS → dist-electron/)
  main.ts                 window, lifecycle, 159 IPC handlers, single-instance lock
  agent-service.ts        the brain: system prompt, deep agent graph, verify/repair, streaming
  providers.ts            15 provider profiles + model factory
  command-service.ts      shell execution, permission policy, approval flow, filesystem backend
  code-tools.ts / edit-tools.ts / repo-map-service.ts / project-index-service.ts
  diff-service.ts         git diff + per-file/per-hunk revert + Nexus-only commit reset
  worktree-service.ts     per-session git worktree isolation, merge/abort/discard
  checkpoint + journal: code-task-service.ts, artifacts-service.ts, trajectory-service.ts
  terminal-service.ts + pty-host.cjs   out-of-process PTY host (xterm.js frontend)
  daemon-service.ts       long-running processes with logs, status, port detection
  browser-service.ts      hidden-webview agent browser (inspect / act / fetch_api)
  home-service.ts / home-memory-service.ts / home-task-service.ts / home-artifact-service.ts
  notebook-*.ts           grounded RAG core: parse, text, embeddings, SQLite vectors, RAG,
                          documents, quiz, flashcards, mindmaps, summaries, jobs, store
  mcp-service.ts          MCP client (stdio/http/sse) with fault isolation
  skills-service.ts       skill discovery, mounting, zip import
  store.ts                encrypted-at-rest JSON state (safeStorage)
  permissions.ts / approval-service.ts  deny backstop + ask gates + approval modals
  system-skills/ system-commands/ system-agents/ system-rules/  bundled content
src/                      renderer (React 19 + Vite)
  App.tsx                 shell: title bar, tabs, panes, modals
  state/                  useAppController (Code) · useHomeController · useNotebookController · theme
  views/                  AgentView · HomeView · NotebookView · DiffView · MemoryView
  components/             chat, editor (Monaco), terminal (xterm), diff, worktree, browser,
                          notebook studio, settings (providers/MCP/skills), daemons, …
  styles.css              design system (emerald/dark, DM Sans + DM Mono) + 9 themes
landing_page/             static marketing site (no build step; GitHub-Releases-aware)
test/                     21 test suites (Electron integration + unit + notebook)
```

> **Legacy note**: Nexus was previously "Forgepilot". Legacy paths (`window.forgepilot` preload alias, `forgepilot-state.json`, `.forgepilot/` worktrees) are still supported for backward compatibility.

## License

No license has been published yet — all rights reserved by the author until one is added.

---

Built with **Electron + LangChain + LangGraph + DeepAgents**. · Author **amine-elhanine** ·
References: [LangChain JS](https://js.langchain.com) · [LangGraph JS](https://langchain-ai.github.io/langgraphjs) · [DeepAgents JS](https://github.com/langchain-ai/deepagents) · [MCP](https://modelcontextprotocol.io)
