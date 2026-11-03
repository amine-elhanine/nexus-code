# Nexus Security Threat Model

Status: living document. Keep it short and current; when you change one of the
trust boundaries below, update this page in the same PR.

## Assets

- User files and git history inside any opened project root, plus
  `Documents/Nexus` (Home mode) and Notebook databases.
- Provider API keys at rest (stored in `store.ts`, encrypted via Electron
  `safeStorage`/DPAPI, `safeStorage:v1:` prefix; legacy plaintext is
  re-encrypted on read).
- The host OS (shell access is the agent's whole point — deny/ask lists are
  the primary defense).

## Trust boundaries

1. **Renderer → main process (IPC)** — the renderer is untrusted by default:
   contextIsolation on, nodeIntegration off, Chromium sandbox on, and every
   IPC entry validates payloads with zod (`electron/ipc/schemas.ts` +
   `assertPayload`, fail-closed). Unknown keys pass through (`z.looseObject`),
   but every *used* field is typed, sized, and enum-checked; handlers must
   never read new fields without adding them to the schema.
2. **Agent tool → filesystem/shell** — path confinement lives in
   `code-tools.ts::safePath()` (realpath-anchored, symlink-walked) and
   `path-utils.ts` (LLM path-hallucination fixes); shell commands go through
   `permissions.ts` deny/ask gates and `shell-subprocess.ts::boundedExecFile`
   (300s, 8MB, process-tree kill). Full-access mode (`Full`) still hard-denies
   destructive classes (disk/home/system wipes, shutdown, fork bombs, registry
   deletes, privilege escalation) regardless of project rules.
3. **Agent tool → network** — Notebook ingestion and web fetch funnel through
   `notebook/net-guard.ts` (SSRF: private ranges, localhost, non-HTTP
   protocols blocked). Browser tools drive pre-made hidden webviews; the
   agent never opens windows of its own (`setWindowOpenHandler` denies and
   routes https openExternal).
4. **Plugins → the app** — deny-by-default pipeline
   (`capability-registry.ts` → `tool-executor.ts`): mode gate → permission
   gate → zod validation → policy hooks (monotonic deny, 5s timeout) →
   approval requirement → clamped tool timeout [1s,120s] → execution →
   `redactSecrets` on results.

## Documented tradeoffs

- **Browser-partition CSP stripping** (`electron/main.ts`): for the two
  `persist:browser-*` partitions, `X-Frame-Options` and `frame-ancestors` are
  removed/rewritten so iframe-based browsing works at all. This weakens
  clickjacking defenses *for pages browsed inside that partition only*; the
  app shell partition and the main window are unaffected. If a future design
  allows agents to browse user-authenticated sites, revisit before reusing
  this partition.
- **`will-navigate` allows `file://`** for local document previews
  (`nexus-attachment://` plus blob/file iframes for PDF viewers). Attachment
  paths are confined to `path.join(userData, "attachments", fileName)`; if
  that confinement or the filename whitelist changes, re-evaluate the guard.
- **`z.looseObject` IPC schemas**: unknown keys are not rejected ≈20% defense
  budget spent elsewhere (fail-closed *handlers* rather than fail-closed
  *parsers*). Tighten to `z.object` for new schemas; don't widen existing.
- **Built-in agent tools vs plugin tools**: built-ins (read/grep/edit/shell)
  keep their LangChain-era execution path with the permission gates applied
  at call-time; plugin tools additionally flow through `tool-executor.ts`
  (validation, hooks, approval, redaction). The registry/route migration and
  the residual differences are tracked in `docs/TOOL_PIPELINE.md`.
- **Env escape hatch `NEXUS_SANDBOX=0`**: honored only when `--dev` is also
  present (guarded in `createWindow`); `test/renderer-security.test.mjs`
  statically verifies the compiled bundle keeps the dev gate.

## Known residual risks (accepted, monitored)

- Regex-based `redactSecrets` only sanitizes well-known token shapes
  (`sk-…`, bearer headers); custom provider key formats may leak into tool
  results. Mitigation: treat tool output in the renderer as untrusted display
  data, never shell-qoute it back into commands without the `_raw` gates.
- Windows `cmd.exe` is used for npx-style exec with fixed argv only; any
  future variable interpolation into that argv must go through the deny/ask
  gate chain first.
