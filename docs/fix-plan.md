# Nexus — implementation record (current as of v0.3.6)

> This file was originally the 2026-08-30 remediation plan. It is kept as a **historical record**: everything below describes the behavior **as implemented in the code today**. For user-facing docs, read `README.md`.

## Brand (done)

- Product name is **Nexus** everywhere user-visible (window title, README, logo, Home folder `~/Documents/Nexus`, `.nexus/` telemetry).
- `forgepilot` survives only as a **legacy alias**: `window.forgepilot` IPC bridge (`electron/preload.cts`), `forgepilot-state.json` fallback (`electron/store.ts`), `.forgepilot/` fallbacks for worktrees/rules/commands/trajectories, `forgepilot/session-*` branch prefix (`electron/worktree-service.ts`), and `.forgepilot` in ignore sets. Do not reintroduce user-visible ForgePilot strings.

## Worktree / checkpoint / diff triangle (done — opt-in isolation)

- No automatic worktree creation on `agent:run`; runs execute in `project.root` unless the user explicitly created a session worktree via `worktree:create`.
- Active worktree routing: tree-scoped IPC resolves `getSessionWorktree(root, sessionId)` first, root fallback.
- `restoreWorkspaceCheckpoint` uses the checkpoint's own stored `projectRoot`; unknown checkpoints return an explicit error (no silent mass-revert).
- Telemetry always lives in the real project root (`telemetryRoot` through `agent-service.ts`): `TrajectoryLogger` and `saveArtifact` survive worktree discard.
- Ignore sets everywhere: `.nexus/`, `.forgepilot/`, `.deepagents/`, `.git/` in `diff-service.ts`, `project-tools.ts` (`IGNORED`), `code-tools.ts` (`IGNORED_DIRS`), `repo-map-service.ts`.
- Current paths: checkpoints `.nexus/checkpoints/<id>.json`, run resumption `.nexus/run-checkpoints/`, worktrees `.forgepilot/worktrees/<session-id>`, artifacts `.nexus/artifacts/`, trajectories `.nexus/trajectories/`.
- Tests: `test/sandbox-and-agent.test.mjs` covers checkpoint-restore root fidelity, unknown-checkpoint behavior, and `.nexus/` exclusion from diffs.

## Command model (done — no sandbox)

- Direct execution (`electron/command-service.ts`) with per-run cancellation; no allowlist, no network filter.
- `electron/permissions.ts`: `deny` backstop (destructive/privilege-escalation) + `ask` for `git push|reset|clean|rebase`, dependency mutations, `curl|sh` / `Invoke-WebRequest` patterns. Everything else `allow`. Project policy via `.nexus/permissions.json` / `package.json#nexus.permissions`.
- Browser partitions are isolated (`persist:browser-home`, `persist:browser-code`); `defaultSession` headers untouched. `setWindowOpenHandler` denies + `openExternal`.
- Skills IPC confined to `globalSkillsDir()` / `projectSkillsDir(projectRoot)` (`electron/skills-service.ts`).
- Current budgets: Plan 40 / Ask 100 / Auto 150, `SIMPLE_TASK_LIMIT` 50, repairs Plan 0 / Ask 1 / Auto 3 (`electron/agent-service.ts:85-91`).

## Agent quality (done)

- Repair pass keeps its transcript: streamed updates stored in `AgentState.runMessages`; repair iteration passes `[...priorMessages, initialHumanMessage, ...previousRunMessages, verifyFeedback]`.
- `findTargetedTests` returns `null` (not `node <file>`) for JS/TS; keeps `pytest` / cargo / go conventions.
- Provider-aware costs: unknown/local models → `estimatedCost: null`, UI renders `—` (`src/types.ts:formatCost`).
- Subagent usage from real `usage_metadata` (`electron/subagent-service.ts`), not `task.length / 4`.
- Azure accepts instance/base-URL configuration; per-model `chat|responses|messages` overrides with Zen `x-opencode-*` headers.

## Frontend (done)

- `App.tsx` split: `src/types.ts`, `src/state/useAppController.ts`, `src/state/useNotebookController.ts`, `src/views/` (Home, Agent, Notebook, Diff, Memory), `src/modals/`, `src/components/{chat,browser,terminal,editor,diff,daemons,worktree,rules,artifacts,home,notebook,settings,common}/`.
- `WorktreeBar` uses `ConfirmModal`, not `window.confirm`.
- Session usage is recomputed from messages (no double-count on `agent:event`); `listSessions` refresh after runs.
- Pasted images stored as files via `attachments:save` → `nexus-attachment://` (no base64 in `nexus-state.json`).
- `MonacoDiffModal` uses `workspace:readHead` (`git show HEAD:<path>`) as original; patch parse only as fallback for untracked/single-hunk files.

## Runtime / UX (done, incl. Phase 7 PTY)

- Real PTY out-of-process: `electron/pty-host.cjs` (JSON-lines `spawn/write/resize/kill` → `ready/data/exit/error`) under system Node + `@homebridge/node-pty-prebuilt-multiarch`; `terminal-service.ts` is PTY-first with piped-shell fallback; generation-guarded teardown; `terminal:resize` reaches a real PTY.
- `before-quit` stops daemons + `terminalService.killAll()`.
- Daemon stop on POSIX uses detached group semantics; Windows uses `taskkill /T /F`.
- `session:delete` discards that session's own project worktree (project id threaded through).
- `VoiceDictationButton` hides when SpeechRecognition is unavailable in Electron.

## Verification (per change)

- `npm run check` (both tsconfigs).
- `npm test` (Electron integration), `npm run test:unit` (rate-limit, checkpoint-resume), `npm run test:notebook` (text, parse, library, pipeline).
- Manual: Auto task on a scratch git repo → Diff shows changes → Undo restores → targeted tests fire; Skills import/delete; MCP save/test; browser on localhost + external URL behavior; PTY `MODE: pty` + resize.
