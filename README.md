<div align="center">

<img src="public/icon.png" width="96" alt="Nexus logo" />

# Nexus

**The autonomous AI agent for your desktop — Code it. Draft it. Prove it.**

A full-capability coding agent for any repository, a general desktop assistant that generates real deliverables, and a grounded research notebook with verified citations — unified into a single native desktop application.

Windows 10 / 11 (NSIS + Portable) · macOS & Linux configurable

![Electron](https://img.shields.io/badge/Electron-44-47848F?logo=electron&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)
![LangGraph](https://img.shields.io/badge/LangGraph-1.x-1C3C3C)
![DeepAgents](https://img.shields.io/badge/DeepAgents-1.x-34d399)
![License](https://img.shields.io/badge/license-All_Rights_Reserved-lightgrey)

**[Download the latest release](https://github.com/amine-elhanine/nexus/releases/latest)** ·
**[Landing page](landing_page/index.html)**

</div>

---

Nexus is an **autonomous AI desktop agent** engineered with **Electron + React + TypeScript**. It brings together:
- **LangChain** for model orchestration and tool interfaces,
- **LangGraph** for deterministic outer loop execution, session checkpointing, and verify/repair supervision,
- **DeepAgents** for planning, multi-step agentic execution, and virtual filesystem manipulation.

Everything executes on your local machine: your API keys (safely encrypted via OS keychain/DPAPI), your choice of 15+ cloud or local models (including offline Ollama), and all session storage residing on disk — with **zero proprietary telemetry or middleman cloud**.

---

## The Three Core Modes

Nexus features three dedicated operational surfaces accessible from the persistent top bar:

| Mode | Purpose | Workspace Root |
|---|---|---|
| **Code** | Autonomous software engineer — Plan / Ask / Auto execution, diff-first verification, multi-level undo, git worktrees, Monaco editor, and PTY terminal. | Any local directory or Git repository you open |
| **Home** | General assistant — Web research, document deliverables (Word, PowerPoint, Excel, PDF, LaTeX, Markdown), and structured long-term memory. | Dedicated directory at `Documents/Nexus` |
| **Notebook** | NotebookLM-inspired grounded research engine over documents, YouTube transcripts, and web pages with strict citation attribution. | Isolated per-session SQLite & vector libraries |

---

### 1. Code Mode — Autonomous Software Engineering

- **Three Autonomous Modes**:
  - `Plan`: Hard read-only mode (no file mutations, no shell commands, no external side effects) designed for architecture exploration and roadmapping.
  - `Ask`: Interactive paired-programming mode asking for guidance and confirmations before mutations.
  - `Auto`: Full autonomous execution end-to-end with automated self-repair loops.
- **Diff-First Verify & Repair Loop**: After file modifications, an autonomous supervisor reviews Git diffs and executes relevant verification cascades (typechecking, linters, unit tests). If failures occur, the supervisor extracts diagnostics and initiates repair cycles (up to 3 in *Ask*, 5 in *Auto*).
- **Multi-Level Undo & Checkpoints**: File snapshots paired with 20-deep run checkpoints. One-click **Undo run**, per-hunk diff discard, and Nexus-specific commit resets that never alter your personal commit history.
- **Isolated Git Worktrees**: Spin up ephemeral sessions inside isolated Git worktrees (`.forgepilot/worktrees/<session>`). Test, develop, and then select **Merge to Main**, **Discard**, or utilize the built-in 3-way conflict resolver.
- **Code Intelligence & LSP**:
  - Out-of-process Language Server Protocol (LSP) integration for **TypeScript**, **Python**, **Go**, **Rust**, and **C++** providing definitions, references, document symbols, and diagnostics.
  - WebAssembly-backed **Tree-sitter** grammar warmup for instant syntactic outline extraction and symbol indexing.
  - Persistent repository map and project index.
- **Developer Tooling**: Monaco code editor, embedded xterm.js terminal powered by an out-of-process PTY host (`pty-host.cjs`), background daemon manager (dev servers with port detection and log streaming), `@`-file autocomplete mentions, and image attachment previews.
- **Atomic Multi-File Patching**: High-speed, atomic file patching (`apply_patch`) supporting search-and-replace blocks, unified diff hunks, file creation, deletion, and relocation.
- **Rules & Memory Layering**: Automatic ingestion of `.cursorrules`, `AGENTS.md`, `CLAUDE.md`, `.windsurfrules`, and `.nexus/rules`, with persistent project and session memory appended after each completed run.

---

### 2. Home Mode — Desktop Assistant & Document Generation

- **Real Document Deliverables**: Generates complete, fully formatted files — `.docx` Word documents, `.pptx` presentations, `.xlsx` workbooks, `.pdf`, `.md`, and LaTeX — not raw code snippets.
- **Magic-Byte & OpenXML Validation**: Every generated document is validated against binary magic bytes and inspected via zip/XML structure parsers to ensure corruption-free files compatible with Microsoft Office.
- **Structured Long-Term Memory**:
  - Four distinct memory tiers: **User Profile**, **Preferences**, **Factual Knowledge**, and **Project Context**.
  - Dynamically injected into context based on conversational relevance.
  - Granular control: tell the agent *"remember that..."* or selectively remove items via per-fact **Forget** buttons.
- **Web Research & Visual Automation**: Integrated headless and visual browser tools with snapshot inspection, element grounding, and SSRF-safe request capabilities.

---

### 3. Notebook Mode — Grounded Research & Studio Artifacts

- **Multi-Source Ingestion Pipeline**:
  - Ingests PDF, DOCX, PPTX, TXT, Markdown, CSV, TeX, YouTube video transcripts, and public web pages.
  - Resilient asynchronous processing pipeline (`queued → parsing → chunking → indexing → ready`) with crash recovery.
- **Grounded Chat with Verified Citations**:
  - Hybrid retrieval combining dense vector similarity (SQLite vectors), BM25 lexical token matching, and structural heading boosts.
  - Clickable `[S1]`, `[S2]` citation badges that instantly open the exact passage and highlight the evidence source.
  - Transparent retrieval traces displaying passage scores and candidate ranking.
- **Strict Groundedness Gate**: Evaluates answer fidelity on a 0–10 scale. When ingested sources do not contain sufficient evidence, the model **refuses to hallucinate** rather than guessing.
- **Studio Generative Artifacts**: One-click generation of:
  - **Reports** (DOCX / PDF)
  - **Presentations** (PPTX)
  - **Quizzes** (Graded multi-choice and boolean questions with passage citations)
  - **Flashcards** (Study flashcard sets with interactive review player)
  - **Mind Maps** (Interactive hierarchical graph rendered on visual canvas)
  - **Summaries** (Executive overviews, section analyses, and key takeaways)

---

## OpenCode & Antigravity Step Experience

Nexus features a redesigned, interactive step execution feed inspired by **OpenCode** and **Antigravity**, active across **Code**, **Home**, and **Notebook** modes:

- **Connected Stepper Timeline**: Step execution is rendered along an interconnected vertical track with clean status nodes:
  - 🔄 **Running**: Active spinner with glowing aura and pulsating live beacon.
  - ✅ **Completed**: Crisp emerald checkmark with execution timing.
  - ❌ **Failed / Error**: Dedicated warning icon and collapsible diagnostic trace.
- **Antigravity Live Pulse Beacon**: When the agent is actively executing, the summary header features an animated dual-ring pulse beacon (`stepBeaconPulse`).
- **Standardized Tool Badges**: Activities are color-coded and labeled with monospace pills:
  - `READ`: File reading with line ranges (`src/App.tsx:1-120`).
  - `WRITE` / `EDIT` / `PATCH`: Atomic file additions, modifications, and patches.
  - `BASH` / `RUN`: Terminal command executions (`$ npm test`).
  - `SEARCH` / `GREP` / `GLOB` / `LSP`: Codebase grep, globbing, directory listing, and symbol lookups.
  - `SKILL`: Skill consultations and on-demand loads.
  - `WEB` / `BROWSE`: Web queries and page visits.
  - `AGENT`: Subagent delegations.
  - `PLAN`: Interactive working plan item trackers.
- **Live Active Step Highlighting**: The currently running step displays an animated shimmer gradient wave and live present-tense verbs (*"Executing command"*, *"Reading file"*, *"Applying patch"*).
- **Consolidated Step Pairing**: Merges tool invocations and subsequent completions into a single unified step card, avoiding duplicate or noisy activity rows.
- **Expandable Output Cards**: Terminal outputs, file excerpts, and diagnostic logs feature dark monospace styling, syntax presentation, and a one-click **Copy to Clipboard** button.

---

## Feature Matrix

| Feature | Details |
|---|---|
| **15 LLM Providers** | OpenAI, Anthropic Claude, Google Gemini, Mistral, Groq, xAI Grok, OpenRouter, DeepSeek, OpenCode Zen, Together AI, Fireworks, Azure OpenAI, AWS Bedrock, local **Ollama**, and custom OpenAI-compatible endpoints with dynamic model discovery. |
| **Model Context Protocol (MCP)** | Native MCP client supporting `stdio`, `HTTP`, and `SSE` transports. Features connection health testing, isolated fault boundaries, and encrypted configurations. |
| **Extensible Skills** | **53 bundled system skills** (12 common, 31 code, 10 home), plus project-level (`.nexus/skills/`) and global skills formatted as `SKILL.md`. Includes ZIP bundle import/export. |
| **Specialist Subagents** | **68 specialized agents** (architect, code reviewer, security reviewer, TDD guide, language-specific build error resolvers) dispatched as scoped subagents (max 3 concurrent per run, 1 mutating). |
| **Coding Rule Packs** | **122 rule sets** across 22 languages and frameworks, dynamically merged with workspace rules. |
| **Slash Commands** | **38 built-in slash commands** (`/plan`, `/auto`, `/review`, `/test`, `/security`, `/pr`, `/build-fix`, etc.) plus custom user-defined commands supporting variable replacement (`{{input}}`, `$ARGUMENTS`). |
| **Lifecycle Hooks** | Shell lifecycle hooks configured via `.nexus/hooks.json` (`run:start`, `run:end`, `tool:before`, `tool:after`, `verify:fail`) with stdin JSON payloads and tool veto capabilities. |
| **Plugin Marketplace** | Directory-based bundles (`.nexus/plugins/<name>/`) packaging manifests, skills, and lifecycle hooks. Developers curate local bundles or publish a simple JSON registry; users install a plugin into their project with one click. |
| **Agent Browser** | Embedded hidden webview profiles per mode with rendered DOM inspection, interactive element actions, and SSRF-safe API fetch utilities. |
| **Transparent Cost Metering** | Per-message token accounting, input/output breakdown, and estimated cost tracking. |
| **10 Themes** | Nexus Emerald, Dark-White, Midnight, Grape, Ember, Crimson, Lagoon, Moss, Alabaster, and Daylight. |
| **Auto-Updates** | Integrated updater via GitHub Releases (`electron-updater`) with live background progress pill. |

---

## Publishing Plugins

Open **Settings → Marketplace → Add plugin** to add a local bundle to the developer catalog. A bundle must contain `manifest.json`; its `skills/` and `hooks.json` are activated as soon as a user installs it into a project.

The official Marketplace automatically loads [this repository's registry](https://raw.githubusercontent.com/amine-elhanine/nexus-code/main/registry.json). Add plugin folders under `plugins/`, upload their ZIP packages to a GitHub Release in this same repository, then add a listing to the root `registry.json`. The registry may be either an array or `{ "plugins": [...] }`; each listing needs `id`, `name`, and an HTTPS `.zip` `source`:

```json
{
  "plugins": [{
    "id": "release-notes",
    "name": "Release Notes",
    "version": "1.0.0",
    "author": "Nexus Team",
    "description": "Creates release notes from Git history.",
    "capabilities": ["skills", "hooks"],
    "source": "https://example.com/plugins/release-notes.zip"
  }]
}
```

## Architecture & Loop Design

```
                     ┌─────────────────────────────────────────────────────────┐
 User Prompt ──────▶ │ 1. PLAN / ROUTE                                         │
                     │    - Mode heuristic & task routing                      │
                     │    - Active skills & prompt assets injection            │
                     │    - Relevant memory extraction                         │
                     └───────────────────────────┬─────────────────────────────┘
                                                 │
                                                 ▼
                     ┌─────────────────────────────────────────────────────────┐
                     │ 2. DEEP AGENT LOOP (DeepAgents + LangChain)             │
                     │    - Tool calls: Filesystem, Bash, AST / LSP, Browser,  │
                     │      Web search, Memory, MCP, Subagents, ask_user       │
                     │    - Loop prevention & Doom loop circuit breakers       │
                     │    - Rate limit backoff & checkpoint snapshots          │
                     └───────────────────────────┬─────────────────────────────┘
                                                 │
                                                 ▼
                     ┌─────────────────────────────────────────────────────────┐
                     │ 3. VERIFICATION (LangGraph outer supervisor node)        │
                     │    - Diff-first inspection                              │
                     │    - Diagnostics cascade (Typechecks / Tests / Lints)   │
                     │    - Deliverable schema & magic-byte contract check     │
                     └─────────────┬─────────────────────────────┬─────────────┘
                                   │ Failure                     │ Success
                                   ▼                             │
                     ┌───────────────────────────┐               │
                     │ 4. REPAIR SUPERVISOR      │               │
                     │    - Injects diagnostics  │               │
                     │    - Ask: ≤ 3 repairs     │               │
                     │    - Auto: ≤ 5 repairs    │               │
                     └─────────────┬─────────────┘               │
                                   ▲                             │
                                   └─────── Loop back ───────────┤
                                                                 │
                                                                 ▼
                                                  ┌────────────────────────────┐
                                                  │ 5. FINALIZATION            │
                                                  │    - Checkpoint persistence│
                                                  │    - Memory facts update   │
                                                  │    - Git undo snapshot     │
                                                  └────────────────────────────┘
```

| Mode | Recursion Step Cap | Automated Repairs | Permissions |
|---|---|---|---|
| **Plan** | 40 | 0 (None) | Read-only strictly enforced |
| **Ask** | 100 | Up to 3 | Interactive confirmation for mutations |
| **Auto** | 150 | Up to 5 | Fully autonomous with self-repair |

---

## Security, Approvals & Privacy

Nexus operates with direct filesystem and shell access on your machine by design. Safety is governed by **multi-tier approval gates, a hardcoded denial backstop, and encrypted local storage**:

1. **Interactive Approval Prompts**: Sensitive operations trigger an interactive dialog with **Deny / Allow once / Allow for session** (120-second timeout automatically defaults to Deny). Heuristics intercept:
   - `git push`, `git reset`, `git clean`, `git rebase`
   - Package installations (`npm install`, `pip install`, `cargo add`, etc.)
   - Dynamic script execution (`curl ... | sh`, `Invoke-Expression`, PowerShell encoded commands)
   - Mutating network operations and file uploads
2. **Hardcoded Denial Backstop**: Destructive commands are permanently blocked and cannot be bypassed:
   - Recursive deletion of drive roots, Windows directories, user profiles (`rm -rf /`, `Remove-Item -Recurse ..\..`)
   - Low-level disk formatting (`mkfs`, `dd of=/dev/…`, `diskpart`)
   - System registry wipes, user account creation, fork bombs
3. **Granular Permissions Policy**: Configurable through `.nexus/permissions.json` or `package.json -> nexus.permissions` specifying custom `allow`, `ask`, and `deny` glob patterns. Agent runs lock the active policy at launch, preventing mid-run privilege escalation.
4. **Secret Protection at Rest**: All API keys and MCP credentials are encrypted using Electron's `safeStorage` (Windows DPAPI, macOS Keychain, Linux Secret Service).
5. **Sanitized Subprocess Environments**: Terminal environments strip credentials before spawning child processes. Daemons execute under a strict environment variable allowlist.
6. **No External Telemetry**: No user prompts, source code, or trajectories leave your machine. Network activity is limited strictly to configured model endpoints and user-initiated web tools.

---

## Data & Storage Layout

| Category | Storage Location | Description |
|---|---|---|
| **App State** | `%APPDATA%/nexus/nexus-state.json` | Providers, settings, MCP configurations (keys encrypted) |
| **Project Workspace** | `<project>/.nexus/` | Local index, checkpoints, trajectories, artifacts, hooks, plugins |
| **Session Worktrees** | `<project>/.forgepilot/worktrees/` | Ephemeral Git worktree branches per session |
| **Home Deliverables** | `Documents/Nexus/` | Validated office documents, spreadsheets, and presentations |
| **Project Skills** | `<project>/.nexus/skills/` | Workspace-specific `SKILL.md` definitions |
| **Notebook Libraries** | `%APPDATA%/nexus/notebooks/<id>/` | Ingested source files, passage chunks, and SQLite vector stores |

---

## Getting Started

### Prerequisites
- **Node.js**: v20 or higher
- **npm**: v10 or higher
- **Operating System**: Windows 10/11 (fully supported); macOS and Linux build configurations included.

### Installation & Development

```bash
# Clone the repository
git clone https://github.com/amine-elhanine/nexus-code.git
cd nexus-code

# Install dependencies (use npm.cmd if PowerShell script execution is restricted)
npm install

# Start in development mode (Vite HMR + Electron)
npm run dev

# Run TypeScript compiler checks (renderer + electron)
npm run check
```

### Running Test Suites

Nexus maintains a comprehensive testing harness:

```bash
# Run unit test suite (34 suites covering rate-limits, checkpoints, LSP, hooks, plugins, memory)
npm run test:unit

# Run notebook test suite (11 suites covering ingestion, RAG, SQLite vectors, groundedness)
npm run test:notebook

# Run permissions and security policy test suite
npm run test:permissions

# Run full integration test suite (sandbox + agent execution)
npm test
```

### Production Build & Packaging

```bash
# Compile renderer and Electron main process
npm run build

# Launch production build locally
npm start

# Package desktop executables into release/ (NSIS installer + Portable)
npm run dist

# Package unpacked directory for rapid verification
npm run dist:dir
```

---

## Headless CLI & Evaluation Harness

Nexus includes headless evaluation runners to benchmark models and prompt assets against standardized suites:

```bash
# Run agent evaluation benchmark
npm run eval:agent

# Run repeated evaluations to measure consistency
npm run eval:agent -- --repeat 3

# Paired ablation test comparing skills and rules impact
npm run eval:agent -- --case code-subtotal-cents --compare-assets skills,rules --repeat 2

# Offline deterministic notebook RAG evaluation
npm run eval:notebook
```

---

## Repository Structure

```
nexus/
├── electron/                   # Electron Main Process (TypeScript)
│   ├── main.ts                 # Window management, lifecycle, IPC registry
│   ├── agent-service.ts        # Agent core: graph orchestration, verify/repair, streaming
│   ├── providers.ts            # 15 LLM provider integrations & model factory
│   ├── command-service.ts      # Shell execution, permission gates, approval prompts
│   ├── code-tools.ts           # Code intelligence tools (definitions, references, outline)
│   ├── edit-tools.ts           # Atomic apply_patch, search-and-replace, file mutations
│   ├── diff-service.ts         # Git diff engine, hunk discard, checkpoint rollbacks
│   ├── worktree-service.ts     # Isolated git worktrees & 3-way conflict resolver
│   ├── lsp-service.ts          # Language Server Protocol client (TS, Py, Go, Rust, C++)
│   ├── hooks-service.ts        # Lifecycle hooks engine (.nexus/hooks.json)
│   ├── plugins-service.ts      # Plugin discovery & management (.nexus/plugins/)
│   ├── daemon-service.ts       # Background dev process & port manager
│   ├── terminal-service.ts     # PTY terminal manager & pty-host.cjs bridge
│   ├── browser-service.ts      # Hidden webview agent browser
│   ├── home-*.ts               # Home mode: tasks, memory, deliverable validation
│   ├── notebook-*.ts           # Notebook mode: SQLite vectors, hybrid RAG, studio generators
│   ├── subagent-service.ts     # 68 specialist subagents execution engine
│   └── system-*/               # Bundled skills, rules, commands, and agent profiles
├── src/                        # Renderer UI (React 19 + TypeScript + Vite)
│   ├── App.tsx                 # Main application layout, navigation, and modal manager
│   ├── views/                  # Primary mode views: AgentView, HomeView, NotebookView, DiffView, MemoryView
│   ├── components/             # UI components: chat stepper, Monaco editor, xterm terminal, studio modals
│   ├── state/                  # Controllers: useAppController, useHomeController, useNotebookController
│   ├── styles/                 # 10 themes and global styling system
│   └── types.ts                # Shared TypeScript type definitions
├── scripts/                    # Headless CLI and evaluation benchmarks
├── evals/                      # Standardized evaluation datasets
├── test/                       # 56+ test files and integration test suites
└── landing_page/               # Static marketing site
```

---

## References & Credits

- [LangChain](https://js.langchain.com) — Model integration and tool routing
- [LangGraph](https://langchain-ai.github.io/langgraphjs) — Outer state machine workflows and human-in-the-loop controls
- [DeepAgents](https://github.com/langchain-ai/deepagents) — Long-running agent loops and virtual filesystem manipulation
- [Model Context Protocol (MCP)](https://modelcontextprotocol.io) — Open tool interoperability
- [Monaco Editor](https://microsoft.github.io/monaco-editor/) & [xterm.js](https://xtermjs.org/) — In-app editor and terminal interfaces
