# UI structure (current, Nexus v0.3.6)

The app is a **per-session workspace**, not a dashboard. Three top-level areas share one shell (`src/App.tsx` → `product-topbar` + `session-pane` + `coding-workspace` + `context-pane`).

## Areas

| Area | Entry | Purpose |
| --- | --- | --- |
| Home | `Home` tab, no project needed | General assistant. Chat + Nexus folder (`~/Documents/Nexus`) with preview/download, session files per chat. |
| Code | `Code` tab, requires `activeProject` | Coding agent. Center toggles `Agent` chat ↔ `Editor` (Monaco, multi-tab, dirty tracking). |
| Notebook | `Notebook` tab | Grounded RAG. Own 3-pane layout (sources / chat / studio-notes) inside the view; the app-level context pane stays hidden. |

## Sidebars

- **Code right pane** (`codeSideTab`): `Session` (status, token/cost totals, rules, memory shortcuts) · `Files` (explorer + refresh) · `Browser` (built-in webview) · `Term` (real PTY) · `Diff` (`git diff HEAD`, per-file revert, Monaco inspect) · `Memory` (project vs session).
- **Home right pane** (`homeSideTab`): `Session` (status, usage, memory, Nexus folder summary) · `Artifacts` (per-chat generated files) · `Browser`.
- Context pane is resizable (220–600 px, persisted as `nexus-context-width`).

## Chat patterns (observed in code)

| Pattern | Nexus decision |
| --- | --- |
| Sessions per project | Left session pane: projects with session counts, sessions with message counts, inline delete, `New project` / `New coding session` (`⌘ N`). |
| Center task chat | `AgentView` / `HomeView`: transcript with user/assistant/event items, live tool steps, plan cards, subagent cards (`researcher/tester/coder`), artifact cards, token streaming. |
| Change review | Diff tab + `MonacoDiffModal`: file-by-file stats `+/−`, single-file revert, `Discard all`, `Undo run` / `Keep changes` action cards. |
| File editor | `MonacoEditorView`: open files tabs, `current-file` `@`-attach, diff-review prompt shortcut. |
| Terminal | `XTermView`: real PTY (`pty-host.cjs` + `node-pty` prebuilds), piped-shell fallback, `terminal:resize` from FitAddon. |
| Autonomy modes | `Plan / Ask / Auto` selector next to the prompt (+ `/plan`, `/ask`, `/auto`, `/review`, … slash commands with mode switching). Budgets: Plan 40 / Ask 100 / Auto 150, repairs 0 / 1 / 3. |
| Local context | Topbar: project menu, branch, session title, model picker, `Skills / MCP / Services / Providers / Settings`, updater pill, command-approval modal when the Ask gate fires. |
| Multi-agent | Parallel sessions each with own run state; subagent activity streams inline as cards with real `usage_metadata`. |
| Notebook grounding | Sources list with `queued/parsing/chunking/indexing/ready/failed` badges, per-source scope toggles, citations with excerpts + scores, `grounded/partial/ungrounded` verdict, passage modal (`explain/simplify/compare/quiz/save-note`). |
| Attachments | Paperclip menu (image, PDF, Word, Excel, …), image preview, `nexus-attachment://` storage (no base64 in state JSON), voice dictation button (hidden when SpeechRecognition is unavailable). |

## Modals

`ProviderModal` (15 providers) · `McpModal` · `SkillsModal` · `SettingsModal` (incl. Updates) · `ProjectPickerModal` · `ConfirmModal` · `DaemonsModal` · `MonacoDiffModal` · `ProjectRulesModal` · `ArtifactViewer` (approve-and-execute) · `FilePreviewModal` / `AttachmentPreviewModal` · command-approval dialog.

Sources: `src/App.tsx`, `src/views/*`, `src/components/*`, `src/state/useAppController.ts`, `src/state/useNotebookController.ts`.
