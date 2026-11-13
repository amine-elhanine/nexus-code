# Nexus Codebase Report

**Review date:** 12 November 2026  
**Repository version:** `0.5.0` (matching `package.json` and `CHANGELOG.md`)  
**Scope:** Architecture, security guarantees, runtime verification, and service boundaries of the Nexus codebase.

## Executive summary

Nexus is a local-first desktop AI application built with Electron 44, React 19, and TypeScript 7. Its three core surfaces—Code, Home, and Notebook—run on a unified, self-built agent runtime (`agentcore`). The application executes locally without proprietary intermediaries or middleman telemetry.

## System boundaries and security model

1. **Chromium renderer sandbox:**
   - Sandboxing is **enabled by default** in `electron/main.ts` (`webPreferences.sandbox = true`, `contextIsolation: true`, `nodeIntegration: false`).
   - The preload bundle (`electron/preload.cts`) is restricted to explicit `contextBridge` methods.
   - Verified statically and dynamically by `test/renderer-security.test.mjs`.

2. **Credentials and secrets at rest:**
   - Stored secrets and API keys are protected using Electron's `safeStorage` (OS DPAPI / Keychain / Secret Service).
   - Plaintext fallback persistence is refused; when an OS credential store is unavailable, keys remain in memory only and the UI flags the connection for re-entry.

3. **Process and shell containment:**
   - Every agent-invoked shell command runs with wall-clock timeouts, bounded stdio buffers, and tree-wide termination (`taskkill /T /F` on Windows, `SIGKILL` on POSIX).
   - Git subprocesses run through bounded timeouts and buffer limits.
   - Dangerous commands (root wipe, fork bombs, disk format, and legacy `.deepagents/` paths) are blocked by hard denies in `electron/permissions.ts`.

4. **Network and filesystem guards:**
   - Path resolution across file tools is strictly constrained by `electron/path-guard.ts` using `safePath` to prevent directory traversal and symlink escapes.
   - Network reads are permitted, while network writes and dynamic code execution require user approval.

## Main technical layers

- **Renderer (`src/`):** React 19 + TypeScript + Vite. UI modes (Code, Home, Notebook), Monaco Editor, PTY/Xterm terminals, and responsive markdown rendering.
- **Main process (`electron/`):** IPC routes, state persistence (`store.ts`), LSP language server manager (`lsp-service.ts`), plugin runners (`plugin-lifecycle.ts`), and browser automation (`browser-service.ts`).
- **Agent runtime (`electron/agentcore/` and `electron/agent/`):** Independent ReAct loop, supervisor verify-node (`verify-node.ts`), tool execution, token compaction, and resume note generation (`resume-note.ts`).
- **Notebook engine:** Vector embedding and hybrid retrieval over SQLite, PDF/DOCX/PPTX parsers, citation attribution, and document generation.

## Test and verification status

The repository maintains an extensive test suite:
- Unit tests (`scripts/run-unit-tests.mjs`): 86+ test cases
- Renderer tests (`scripts/run-renderer-tests.mjs`): UI and event pipeline
- Permissions and security tests (`test/permissions.test.mjs`, `test/renderer-security.test.mjs`)
- Notebook ingestion, vector search, and citation tests (`test/notebook-*.test.mjs`)
- Continuous integration (`.github/workflows/ci.yml`) runs on Windows and Ubuntu matrices.
