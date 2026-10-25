# Nexus Security Policy

Status: as of 2026-10-23. This document describes what is TESTED (not aspirational), and what is explicitly NOT guaranteed. It is updated whenever a guarantee, test, or gap changes.

## 1. Renderer security (tested)

- The renderer runs inside **Chromium's sandbox** by default. `NEXUS_SANDBOX=0` is a local-diagnosis escape hatch only; it must never be disabled in packaged builds.
- The preload uses only `contextBridge`/`ipcRenderer` — no Node, no file system, no process access in a sandboxed render process.
- `contextIsolation: true`, `nodeIntegration: false`, forced sandboxing of attached webviews, window-open redirection to the system browser, and navigation lockdown are asserted **both statically** (compiled `dist-electron/main.js`) and **at runtime** (real sandboxed window + real preload exposes `window.nexus` and resolves no native modules) by `test/renderer-security.test.mjs`, run in CI on its own Electron step.
- **Not claimed**: renderer isolation covers prompt-injection in model output — a compromised LLM response remains a content problem; only its ability to reach the OS through the renderer is contained here.

## 2. Secrets at rest (tested)

- API keys (provider connections, embedding providers, notebook parser, MCP server `env`/`headers`) are encrypted at rest with the OS credential store (DPAPI / Keychain / libsecret–kwallet) and only decrypted in memory.
- **No silent plaintext fallback**: if the OS credential store is unavailable, persistence is refused — the key works for the current session only, is written to disk as empty, and the connection is flagged for re-entry with a distinct settings message ("no OS credential store here"). `test/secret-storage-policy.test.mjs` proves raw keys never reach the state file in any vault state, and that cross-machine ciphertext is preserved (never destroyed) until re-entry.
- Display mask round-trip (`********…`) cannot overwrite a stored key.
- **Documented gap**: secrets synced in app state (via state sync/cloud) are encrypted per-machine — a synced machine without the original vault sees re-entry flags, not decryption failures of the keys themselves (DPAPI/Keychain domain mismatch is the mechanism, not a break of encryption).

## 3. Process containment (tested)

- Every agent-invoked shell command runs with: wall-clock timeout (default, minimum 10s), an 8MiB output buffer, head+tail model-output capping, secret redaction, and per-run cancellation that kills the whole Windows process tree (`taskkill /T /F`) or `SIGKILL` on POSIX.
- All repository-context git subprocesses (workspace grep, diff/status service, project init/commit, worktree merges, HEAD file reads) run through a shared bounded executor: 300s default wall clock, tree-wide kill on timeout, `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`-bounded output. `test/subprocess-bounds.test.mjs` proves tree cleanup of grandchildren, timeout firing, and buffer caps.
- Project hooks (user-defined shell commands) run with their own 15s default timeout, output cap, and kill tree. Plugin runner child processes are timed out per activation/tool call/event and killed on expiry.
- Where OS-level sandboxing of those child processes is NOT available in the desktop app (plugin runners, hooks, terminal, agent shell all share the user account), that is an acknowledged limitation: mitigations are the permission system, approval prompts, and hooks — not kernel isolation. The per-platform breakdown (Windows/macOS/Linux: no kernel confinement applied to children on any platform; the mitigation is the permission model + timeouts + kills) is documented in `docs/plugins/permissions-security.md` § Isolation.

## 4. Network policy (tested, deliberate)

Default policy: **network reads run freely; network writes and code-from-network require explicit user approval.**

| Surface | Reads | Writes/mutations |
|---|---|---|
| Agent shell (curl/wget/Invoke-WebRequest…) | Allowed without approval | `POST/PUT/PATCH/DELETE`, upload flags (`-d/-F/-T`), download-then-execute, remote-code-pipe, PowerShell dynamic execution → **approval required** |
| Notebook network guard | Bounded by the notebook-specific guard (tested in `notebook-net-guard.test.mjs`) | refused |
| `browser_fetch_api` tool | **GET/HEAD only** (tested read-only) | **Refused at runtime** — HTTP mutations must go through the shell path with approval |
| `browser_inspect` / `browser_act` | Read-only page inspection and interaction in the built-in session | Form submissions through rendered pages behave like the user's own browser session (visible in the Browser tab) |
| Plugin runner | No direct network API (no `fetch`/`require`); plugins communicate via structured host IPC | — |
| Marketplace installs | HTTPS-only sources (installed entry must be fetched over https during development flows) | — |

Shell-level hard denies (never run, independent of policy): disk/root wipes, `rm -rf ~`, fork bomb, disk format/boot config edits, shadow-copy deletion, account seizure commands, and any attempt to create the legacy `.deepagents/` folder.

## 5. Command/permission machinery (tested)

- Ranking: hard denies → user project policy (deny/allow/ask patterns) → network/mutation classes → everything else allowed.
- Agent destructive mistakes have a worktree/checkpoint + revert safety net (`diff-service`, `worktree-service`); `.nexus/` state and the legacy `.deepagents/` path are guarded at shell, backend, edit, and skill layers (`state-guard.ts`, `permissions.ts`, `edit-tools.ts`, `skills-service.ts`).

## 6. Current gaps (not fixed yet)

The core adversarial IPC audit is CLOSED: `test/ipc-adversarial.test.mjs` (wired into `test:unit`)
attacks workspace read/write/preview/download, symlink (junction) escapes against the realpath
containment in `safePath`, Home file read/download, artifact filename traversal, and terminal
output redaction (bearer/basic + key=value) — all against the compiled `dist-electron` modules.
It also caught and fixed a quadratic-backtracking hang in the carriage-return collapse of
`cleanTerminalOutput` on megabyte single-line outputs.

Remaining gaps:

1. **Path-traversal fuzzing**: the guard suites cover obvious and structured cases; no systematic fuzzer.
2. **No OS-level isolation** of plugin/agent child processes beyond user context (see §3).
3. **macOS**: neither packaged nor tested in CI; Linux CI runs headless tests only.
4. The npm/package version (0.4.5) lags the unreleased changelog (0.5.0) — release gate pending.
