# Nexus — Remediation Plan

Source: full codebase review (2026-08-30). Ordered by priority; each phase is independently shippable and ends with a green `npm run check` + `npm test`.

## Phase 0 — Housekeeping (30 min)

1. `git init` this project itself and commit a baseline before any changes.
2. Decide the brand, once: keep **Nexus** (app name, window title, README, logo) and keep `forgepilot` only as a legacy IPC alias / state-file fallback path. Sweep user-visible "ForgePilot" strings (`App.tsx` input-note, `AgentView` copy, `sandbox-service.ts` approval dialog title, `worktree-service.ts` branch prefix is fine to keep).
3. Delete dead code: `EditorView` and `TerminalView` in `App.tsx`, `injectPromptCacheControl` in `context-service.ts` (+ its test), the bogus `import { treeKill } from "node:child_process"` in `daemon-service.ts`, `tmp-smoke.mjs` / `tmp-mcp-server.mjs` (move to `scripts/` if wanted).
4. Move `electron-builder` from `dependencies` to `devDependencies`.

## Phase 1 — Critical correctness: worktree / checkpoint / diff triangle

**Decision (recommended): make worktree isolation opt-in, not automatic.** The automatic path is what breaks Undo-run and the Diff tab; explicit worktrees via the existing WorktreeBar stay coherent because the user opts into that workflow.

1. `electron/main.ts` (`agent:run`): remove the automatic `createSessionWorktree` call; run in `project.root`. Keep `worktree:create` IPC for explicit isolation.
2. When a worktree IS active, route the tree-scoped IPC handlers through the session's worktree instead of `requireRoot()`:
   - `workspace:diff`, `workspace:revert-file`, `workspace:revert-all`, `checkpoint:restore`, `trajectory:get`, `artifacts:*` → resolve `getSessionWorktree(root, activeSessionId)` first, fall back to root.
3. `restoreWorkspaceCheckpoint` (`diff-service.ts`): use the checkpoint's own `projectRoot` (already stored in the snapshot) rather than trusting the caller's root; return false with a clear error if the checkpoint is unknown instead of silently doing `revertAllWorkspaceChanges`.
4. Telemetry must always live in the real project root, never the worktree: `runProjectAgent` already receives `projectRoot`; pass the *original* root for `TrajectoryLogger` and `saveArtifact` (add an explicit `telemetryRoot` option in `agent-service.ts`) so logs survive worktree discard.
5. Add `.nexus`, `.forgepilot`, `.deepagents` to the ignore sets in `diff-service.ts` (untracked scan), `project-tools.ts` (`IGNORED`), and `code-tools.ts` (`IGNORED_DIRS`) so agent telemetry never appears as a change to verify or review.
6. Tests: extend `test/sandbox-and-agent.test.mjs` — (a) checkpoint restore restores the snapshot's own root; (b) unknown checkpoint returns false instead of reverting everything; (c) `getWorkspaceDiffFiles` ignores `.nexus/`.

## Phase 2 — Security alignment

1. **Network tools obey the sandbox switch.** `createBrowserTools(projectRoot)` → `createBrowserTools(projectRoot, config)`; when `allowNetwork === false`, restrict `browser_inspect` / `browser_fetch_api` to loopback/private hosts (`localhost`, `127.0.0.0.0/8`, `::1`, RFC1918) and return a policy message otherwise. Pass the sandbox config through `agent-service.ts`.
2. **Stop stripping security headers globally** (`electron/main.ts:102-117`). Move the webview to a dedicated `partition` (e.g. `persist:browser`) and strip headers only on that session; leave `defaultSession` intact. Keep `setWindowOpenHandler` deny + `openExternal`.
3. **Default the approval gate on.** `DEFAULT_SANDBOX_CONFIG.requireApproval: true`; `main.ts` auto-save paths (`agent:run`, `workspace:command`) stop forcing `false`; `App.tsx` initial state already assumes true. Existing saved configs keep their value.
4. **Expand `APPROVAL_REQUIRED`** (`sandbox-service.ts:35`): add `git clean`, `git stash drop|clear`, `git branch -D`, `git worktree remove`, `git remote`, `git config`, and `npx <anything>` (npx downloads and executes arbitrary packages — it should always require approval, or be removed from the allowlist).
5. **Validate skills IPC.** `skills:read` / `skills:delete` may only touch paths inside `globalSkillsDir()` or `projectSkillsDir(projectRoot)`; reject anything else in `skills-service.ts` before touching the filesystem.
6. **Fix Windows quoting**: in `quoteForShell` / `commandPolicy`, reject tokens containing embedded `"` (post-tokenize) instead of re-emitting `\"`, which `cmd.exe` does not interpret the way the tokenizer assumed.
7. Tests: policy cases for `git clean -fd`, `npx foo`, embedded quotes; a loopback-vs-external test for the browser tools.

## Phase 3 — Agent quality

1. **Repair pass keeps its transcript.** In `streamDeepAgent`, collect the streamed `updates`/`values` messages for the pass; store them in the graph state (new `AgentState` channel, e.g. `runMessages`); on the repair iteration pass `[...priorMessages, initialHumanMessage, ...previousRunMessages, verifyFeedback]` to the model so it can see what it did.
2. **`findTargetedTests` fallback**: return `null` instead of `node ${rel}` for JS/TS; for `.py` keep `pytest`, `.rs`/`.go` keep existing.
3. **Provider-aware cost estimates.** Add a `pricing: { inputPer1M, outputPer1M } | null` field to `PROVIDERS` definitions (`providers.ts`); `calculateAgentUsage` takes the pricing (unknown provider / local models → `estimatedCost: null`, UI renders "—" instead of a fabricated `$`). Default OpenAI pricing only for OpenAI-compatible endpoints without pricing info, labeled "estimate".
4. **Subagent usage**: extract real `usage_metadata` from the subagent stream (`extractStreamUsage`) instead of `task.length / 4`.
5. **Azure fix** (`providers.ts:58`): accept the instance name properly (store base URL vs instance separately, or document that Azure config uses the instance name field).
6. Tests: repair-context accumulation (assert second `deep_agent` invocation receives prior messages), `findTargetedTests` no longer returns `node …`.

## Phase 4 — Frontend refactor

1. Split `App.tsx` (2,109 lines) into:
   - `src/types.ts` (shared types currently duplicated in `vite-env.d.ts` and `App.tsx`)
   - `src/state/useAppController.ts` (projects/sessions/providers/run lifecycle)
   - `src/views/` (AgentView, DiffView, MemoryView), `src/modals/` (Provider, Sandbox, Mcp, Skills already exist as components — move the remaining inline ones)
   - `src/components/chat/` gets `ChatItemView`, `ActivityGroupView`, `SubagentCardView`, `ModelSelect`, `FileRow`, `Modal`, `ConfirmModal`.
2. `WorktreeBar`: replace `window.confirm` with the existing `ConfirmModal` for consistency.
3. Session usage double-counting: in `App.tsx`'s `onAgentEvent`, don't add `event.usage` onto `session.usage` cumulatively (the store already recomputes from messages); rely on `listSessions` refresh after the run.
4. Store pasted images as files, not base64 in state JSON: new IPC `attachments:save` writes to `userData/attachments/<id>.png` and returns a `nexus-attachment://` path the renderer can display; session messages store the path. Prevents `nexus-state.json` bloat.
5. `MonacoDiffModal`: stop reconstructing original/modified from the patch. Add IPC `workspace:readHead(file)` using `git show HEAD:<path>`; use that as `original` and the current file as `modified` (patch parse only as fallback for untracked files, single-hunk).

## Phase 5 — Runtime / UX

1. **Real PTY**: swap `terminal-service.ts` to `node-pty` (or `@lydell/node-pty`), propagate `cols`/`rows` from the FitAddon via a new `terminal:resize` IPC, remove the "Live PTY" badge until it's true.
2. **Cleanup on quit**: `app.on("before-quit")` → `daemonService.stopAllDaemons()` + `terminalService` kill-all (add a `killAll()`).
3. Daemon `stopDaemon` on non-Windows: `process.kill(-pid)` requires a detached group leader; spawn with `detached: true` on POSIX or use `tree-kill` package properly.
4. `main.ts` `session:delete`: discard the worktree for the session's *own* project (pass `projectId` through and resolve its root), not blindly `activeProjectRoot`.
5. `VoiceDictationButton`: feature-detect and hide when SpeechRecognition is unavailable in Electron (it usually is); note it in the tooltip.

## Phase 6 — Docs honesty

1. README: rename "Bac à sable local" to "Politique de commandes locale" (local command policy); state explicitly that `npm run` scripts and MCP tools execute with user-level privileges and that the sandbox is workspace scoping + command validation, not isolation.
2. Document the new defaults (approvals on, network tools loopback-only, worktrees opt-in).
3. Update the sandbox modal warning text to match (it's already mostly honest).

## Verification after each phase

- `npm run check` (both tsconfigs)
- `npm test` (electron integration suite, extended per-phase)
- Manual pass: run an Auto task on a scratch git repo → Diff tab shows changes → Undo run restores → targeted tests fire; Skills import/delete; MCP save/test; browser view on localhost with `allowNetwork=false` and an external URL blocked.
