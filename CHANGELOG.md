# Changelog

All notable changes to Nexus are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.5.0] - 2026-10-20

Nexus 0.5.0 adds per-model Reasoning Effort control, automatic context compaction with a live context meter, and smarter provider model management — plus a full project-wide Unity pass that removes the last legacy naming traces and hard-blocks legacy state folders.

### New Features

#### Reasoning Effort Control
- **Per-Model Effort Selection**: Pick a reasoning effort (None, Low, Medium, High, Max) for the current chat, Home session, and Notebook question. The setting is saved with the session and reused on follow-up runs.
- **Provider-Native Mapping**: Effort is translated to each provider's native wire format — `reasoning_effort` for OpenAI and OpenAI-compatible endpoints, extended-thinking budget tokens for Anthropic, and `thinkingBudget` for Gemini — with the correct temperature automatically applied when thinking is enabled.
- **Known Effort Catalog**: Built-in effort levels for OpenAI (o1/o3/o4/GPT-5.x), Anthropic (Claude Opus/Sonnet 4.6, 3.7 Sonnet), Gemini thinking models, and DeepSeek reasoners, with heuristic fallbacks for unknown reasoning models.

#### Context Window Intelligence
- **Model Context Windows & Max Outputs**: Provider definitions now carry per-model context window sizes and maximum output tokens, resolved from provider defaults, stored provider config, or a built-in catalog.
- **Auto-Detection**: New detection endpoints query OpenAI-compatible `/models` metadata (plus a public model catalog) to discover context windows, max outputs, and supported reasoning efforts automatically — exposed in Settings with per-model "Detect" actions.
- **Model Management in Settings**: Add and rename provider models with per-model endpoint, effort, and context metadata instead of single flat model strings.

#### Automatic Context Compaction
- **Smart Compaction Threshold**: Context is auto-compacted at ~80% of the model's context window (matching Claude Code and Codex behavior), reserving room for max completion output and a system-prompt reserve, never compacting below 40% capacity.
- **Automatic Tail Compaction**: When a run crosses the threshold, the oldest turns are summarized in the background and the execution continues seamlessly with a status message reporting tokens freed.
- **Manual Compact Now**: A new `Compact` action lets you compact any session on demand and see how many tokens were freed.
- **Live Context Meter**: The chat header now shows a token usage bar for the active model — used tokens, remaining tokens, the compaction threshold mark, and `NEAR COMPACT` / `AUTO-COMPACT` badges when you approach or hit the limit — with a hover panel detailing threshold stats.

#### In-Run Context Safety
- **Mid-Run Compaction**: Long runs no longer die with a provider "context length exceeded" error — the run watches its real request size on every step (provider-reported input tokens plus a projected payload) and when it crosses the threshold it stops at a clean boundary, condenses the transcript to a digest, and resumes with all committed work intact.
- **Accurate Run-Start Estimate**: The pre-run check counts the full payload — system prompt, tool schemas and results, image/attachment payloads, per-model output reserve — instead of just persisted chat texts, so long sessions start condensed instead of failing immediately.
- **Pair-Safe Condensation**: Context trimming always cuts at message-group boundaries (a tool call is never separated from its result), always keeps the original request, and falls back to truncating single oversized messages so a condensed transcript is always accepted by every provider.
- **Manual Context Overrides**: A context-window override from the provider settings (or the run payload) is now honored everywhere, including prefix-mismatched model IDs (`openrouter/gpt-5.5` ↔ `gpt-5.5`).
- **Honest Meter Readings**: The context meter now measures the latest model call's input tokens — the actual current request size — instead of the session's cumulative lifetime spend, so `NEAR COMPACT` / `AUTO-COMPACT` reflect reality.

### Improvements & Fixes

#### Naming Unification
- **All-In On Nexus**: Removed the final legacy "forgepilot" references across configuration, services, prompts, preload bridge, worktree branch prefixes (`nexus/session-*`), worktree locations (`.nexus/worktrees/`), rules sources, ignore lists, and README documentation. Nexus is now the only name.
- **Cleaner Fallbacks**: Deduplicated redunant legacy-path fallbacks and feature lists in artifact, trajectory, custom-commands, rules, ignore, telemetry, and renderer bridge code, keeping only the canonical `.nexus` locations (with legacy `.deepagents/skills` still read-only supported).

#### Legacy State Folder Hardening
- **Never Create `.deepagents/`**: The agent can no longer create or write into the legacy DeepAgents convention folder. Attempts are hard-blocked at the shell command deny list, backend file writes/edits, apply-patch/import paths, and the skill materialization tool — every path that could materialize `.deepagents/` now fails with a message pointing to `.nexus/`.
- **Prompt Guardrail**: The system prompt explicitly instructs the agent that state, skills, and telemetry live under `.nexus/` only.

#### Renderer Security
- **Chromium Sandbox On By Default**: The renderer now runs inside Chromium's sandbox. The preload (which uses only `contextBridge`/`ipcRenderer`) was verified against a sandboxed render process, and attached webviews keep their force-sandboxed guard. A `NEXUS_SANDBOX=0` environment override remains for local diagnosis only.
- **Security Regression Canary**: A new test suite asserts the packaged window configuration (`contextIsolation: true`, `nodeIntegration: false`, sandboxed-by-default, webview/window-open/navigation guards) both statically on the compiled bundle and at runtime with the real preload, and is wired as its own CI Electron step.

#### Secrets At Rest
- **No Silent Plaintext Fallback**: When the OS credential store is unavailable, API keys are no longer written to disk in the clear — persistence is refused, the key works for the current session only, and the connection is flagged for re-entry with a clear settings message. Legacy plaintext entries are migrated the same way.
- **Cross-Machine Ciphertext Preserved**: Keys encrypted on another machine/profile are kept as ciphertext (they used to be silently blanked when the credential store was unavailable), flagged as needing re-entry, and are replaced the moment a new key is entered.

#### Containment
- **Every git subprocess is time-bounded**: the shared execution helper behind the agent's workspace grep, diff/import listing, project setup, and worktree merge flows now enforces a 300s wall-clock default and a process-tree kill on timeout — a repository with a hung `core.fsmonitor` hook or malicious post-checkout hook can no longer freeze a run. Output buffers stay capped, and non-zero exits still carry captured stdout/stderr for tooling.
- **Explicit Network Policy**: Browser-side API checks by the agent are now read-only (GET/HEAD) — HTTP mutations can no longer bypass approval through a tool call and must go through the terminal command path where the user approves them. The policy matrix (reads free; writes and code-from-network approved) is documented and pin-tested in `SECURITY.md` plus a dedicated regression suite.
- **Adversarial IPC Audit**: A consolidated suite attacks the compiled IPC services with traversal, drive-absolute, UNC/pipe, and junction/symlink escape payloads (workspace, Home, and artifact surfaces) and confirms the realpath containment refuses every one; a terminal-output audit added `Authorization: Bearer/Basic` credential redaction alongside the existing key=value redaction.
- **Output-Collapse Hang Fixed**: The terminal-output cleaner's carriage-return collapse backtracked quadratically on megabyte single-line outputs and could hang a run indefinitely; it is now an equivalent linear scan covered by a 1 MB regression test.

#### Tests
- **Eval Corpus Grows 10 → 56 Agent Cases**: The end-to-end agent benchmark now covers strict-spec implementation (with per-case error-class discipline), subtle-bug repair where comments mislead, behavior-preserving refactors, code and Home injection resistance, fact-bounded Home deliverables with an explicit "Missing:" contract, and 12 prompt-asset cases (commands/skills/rules/subagents, including a new subagent-side DSN parser). A failure-class taxonomy map now lives in `evals/README.md` so failing runs land in a named bucket instead of a vibe.
- **Corpus Quality Enforced in CI**: A new unit suite runs every case's independent checker against its pristine fixture and requires a real executed failure (nonzero exit plus TAP `not ok` markers) — a checker that somehow passes the untouched stub, or fails through a syntax/load error, now fails the build. It also documents the nested `node --test` pitfall where spawned test children silently skip when they inherit the parent runner's session environment.
- **New Model-Efforts Suite**: Dedicated tests for effort resolution, context window/max output resolution, compaction threshold math, and provider-native effort mapping, wired into the unit test script.
- **Compaction & Overflow Tests**: New coverage for context-exhaustion error classification across all provider shapes, message token estimation, and budget-respecting, tool-pair-safe transcript condensation.
- **Guard Regression Tests**: New tests assert shell commands, backend writes, and virtual edit paths can never create `.deepagents/`.

---

## [0.4.5] - 2026-10-12

Nexus 0.4.5 brings a brand new Plugin Marketplace, native interactive charts in Home mode, smarter agent loops that avoid repeating searches, citation highlights in Notebook mode, and a cleaner chat progress feed.

### New Features

#### Plugin Marketplace
- **Redesigned In-App Store**: Browse and manage extensions from a clean store view in Settings, featuring live search, status filters (Installed, Available, Dev), and Grid vs. List views.
- **Capability Filters**: Filter extensions by what they add to your workspace, including Skills, Specialist Subagents, Slash Commands, Coding Rules, and Event Hooks.
- **Plugin Inspector**: View full details, author information, descriptions, and installed files before adding an extension.
- **Bundled Flagship Suites**: Includes the Engineering Suite (standards and workflows for TypeScript, Python, React, Rust, Go, Vue, and Docker) and the Research Studio (deep research, evaluation tools, and office document generators).
- **Custom Feeds and Local Development**: Connect private registry feeds or link local developer folders to test custom plugins instantly.

#### Interactive Charts in Home Mode
- **Inline Visualizations**: Ask the assistant for visual insights and receive interactive charts rendered directly in chat, including bar charts, line graphs, pie charts, area charts, scatter plots, radar charts, and diagrams.
- **Theme-Aware Styling**: Charts automatically adapt their colors and contrast to match your selected theme.
- **Automatic Visual Embedding**: If the agent creates charts or chart images during data analysis, they are automatically placed directly in your chat response so you can see the results immediately.
- **Verified Deliverables**: Strengthened verification to ensure Word, PowerPoint, Excel, and PDF files are generated cleanly without file corruption.

#### Grounded Research Notebook
- **Verified Citations**: Clickable citation tags open the exact evidence source and highlight relevant passages in the side panel.
- **Strict Accuracy Gate**: The model refuses to guess if your uploaded documents do not contain enough evidence to answer a question.
- **Interactive Study Tools**: Generate interactive flashcards, multiple-choice quizzes, mind maps with zoom and pan, and executive summaries from your sources.
- **Enhanced Network Security**: Built-in protection blocks unauthorized network requests and private IP access during web ingestion.

### Improvements & Fixes

#### Agent Performance and Stability
- **Smart Web Loop Prevention**: If a search query or webpage returns unhelpful results, the agent now redirects itself to alternative sources instead of repeatedly retrying the same page or stopping the task.
- **Research Quotas**: Balanced research budgets prevent the assistant from spending too much time browsing when you need quick answers.
- **Accurate Token Tracking**: Token counts and cost calculations are now accurately recorded even if a run is cancelled or interrupted.
- **Cross-Platform File Handling**: Improved file path resolution on Windows systems to avoid case-sensitivity and backslash issues.

#### User Interface
- **Redesigned Progress Stepper**: A cleaner, connected activity timeline showing what the agent is currently reading, running, or editing in real time.
- **Expandable Output Cards**: Terminal outputs, command logs, and file previews can now be expanded or copied to the clipboard with one click.
- **Polished Visual Themes**: Improved contrast and element styling across all 10 color themes.

---

## [0.4.4] - 2026-10-09

### Improvements
- Added preview support for Markdown chart blocks in Home mode.
- Improved asynchronous document parsing performance in Notebook mode.
- Fixed cancellation handling when the agent is waiting on rate limit retries.
- Resolved memory deduplication issues in Home mode.
- Fixed code editor responsiveness when resizing sidebars.

---

## [0.4.3] - 2026-10-05

### Initial Baseline
- Unified desktop experience combining Code mode, Home assistant mode, and Notebook research mode.
- Code intelligence supporting Language Server Protocol (LSP) across TypeScript, Python, Go, Rust, and C++.
- Git worktree isolation and multi-level undo checkpoints.
- Out-of-process terminal host and in-app code editor.
- Encrypted local credential storage with zero telemetry.
