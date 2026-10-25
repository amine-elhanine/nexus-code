# Permissions & security model

## Permission model (least privilege)

Known permissions (`electron/plugin-permissions.ts`):

`workspace.read`, `workspace.write`, `fs.read`, `fs.write`,
`shell.execute`, `network.fetch`, `mcp.connect`, `providers.register`,
`ui.contribute`, `storage.write`, `background.execute`, `config.read`.

There is intentionally NO `secrets.read`: plugins never receive raw
credentials. Unknown permissions in a manifest are rejected at validation.

- Declare in `manifest.permissions`; the user approves the exact set at
  enable time (sensitive ones trigger an explicit prompt in the Marketplace).
- Host enforces on every call (`requirePermission` / `hasPermissions`).
  Deny-by-default: unknown plugin or missing grant → denied.
- No self-escalation: `tryDowngradePermissions` only allows shrinking the
  set; any escalation attempt returns false and changes nothing.

## Approvals

Sensitive tools (`requiresApproval: true`, the default) need per-call user
approval through the existing Nexus approval channel. No approval channel →
denied. This reuses the current approval UX; there is deliberately no
second, divergent approval system. Timeouts deny.

## Isolation

| Kind | Where it runs | Trust |
|---|---|---|
| Declarative (`skills/agents/commands/rules/hooks.json`, declarative `ui`) | in-process as data | safe by construction |
| Executable `entry` JS | separate OS process (`plugin-runner.cjs`), `node:vm` inside it, frozen `nexus` SDK only, no `require`/`process`/`fetch`/Electron, host-side activation (5s) + per-call timeouts, 256KB cap, traversal-checked entry, killed on disable/uninstall/failure | untrusted: needs source review + explicit enable |

HONEST LIMITATION: process + vm isolation is not a full OS sandbox (no
seccomp/job-object caps, no network namespace). It gives crash containment,
hang timeouts, no privileged imports, and clean disposal — enough to run
reviewed third-party tools without risking the main process — but a
determined escape via a Node/V8 flaw cannot be ruled out. Treat executable
installs like installing software: review the source. Deeper OS sandboxing
can be added under this same SDK surface without plugin rewrites.

Per-platform reality of that limitation (what plugin runner children and
shell hooks can and cannot do on each OS Nexus ships today — no kernel-level
confinement on any platform):

| Platform | Runner child runs as | Kernel confinement available today | What the mitigation actually is |
|---|---|---|---|
| Windows | the logged-in user, full user profile access | Job objects (CPU/memory caps via `NODE_OPTIONS` + timeout kill only; no AppContainer/restricted token) | process tree kill on timeout, permission gate + per-call approval, host env scrub (`child-env.ts`) |
| macOS | the logged-in user | none applied (no `sandbox-exec`/Seatbelt profile for children) | same as Windows: timeouts, kills, permission gate, approval |
| Linux | the logged-in user | none applied (no seccomp, no namespaces, no bubblewrap) | same as above |

This is stated deliberately without overclaiming: the OS does not isolate
plugin children from the user's files on ANY platform — the security boundary
is the permission model, the approval channel, and process-level containment
(timeouts, kills, no-Node-globals vm). Anything stronger (AppContainer,
Seatbelt, seccomp/bubblewrap) sits behind the same runner interface and can
be shipped per-platform without plugin changes; until then, repo/flagship
bundles should be treated like browser extensions: review before enable.

Renderer stays `contextIsolation: true`, `nodeIntegration: false`
(`electron/main.ts`). Preload exposes only narrow `invoke()` wrappers; new
IPC (`plugins:enable/disable`, `capabilities:list`, …) validates payloads
in the main process and never trusts the renderer for permissions.

## Hook security

- Shell hooks (`tool:before`) aggregate **monotonically**: the first denial
  wins; later success cannot override it (`dispatchHooks` + regression test
  `plugin-security.test.mjs`). Timeouts/spawn errors count as denial on the
  shell path (fail-closed); SDK policy listeners fail-open to abstain on
  crash/timeout (they cannot grant access either way).
- Hook output capped (4KB), 15s default timeout with kill, secrets scrubbed
  from the child env (`child-env.ts`), cwd pinned to the project root.
- Hooks still run arbitrary shell with user privileges — installing a hook
  plugin is a trust decision. `hooks.json` from projects and enabled plugins
  is discoverable; disabled/uninstalled plugins contribute nothing.

## Install integrity

- HTTPS-only remote bundles; `http://`, `file:`, `data:`, etc. rejected.
- Zip-slip guards (normalize + `startsWith(target + sep)`), Windows drive
  and UNC rejection, `..` rejection.
- Limits: ≤500 files, ≤25MB download, ≤50MB expanded (zip-bomb protection).
- Bundle id must match the listing id; executable bundles pass strict
  manifest validation BEFORE the old install is touched.
- Rollback-safe updates: previous install moved aside, restored on any
  swap/validation failure — an interrupted update never destroys the last
  working version (tested).
- No signature verification is claimed: the marketplace does not provide
  signed artifacts, so the UI never implies cryptographic verification.
  Trust comes from source review + permission approval, stated as such.

## Audit & secrets

- Policy decisions record `deniedBy` + reason (in-memory diagnostics;
  surfaced via `capabilities:list` / hook outcomes).
- Tool results pass secret redaction (`sk-…`, `"api_key"` values masked).
- MCP `stdio.env`/headers stay in main-process memory; never sent to the
  renderer or plugin logs. Plugin logs are capped at 2KB per message.
