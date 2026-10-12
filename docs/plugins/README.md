# Nexus Plugin Platform (API v1)

Nexus is evolving toward a Pi-inspired / Harness-inspired plugin platform:
a small stable kernel (agent loop, providers, sessions, permissions, IPC)
plus capabilities contributed through a **versioned public SDK**.

Principle: **plugins depend on stable public contracts, not on Nexus
internals.** A plugin must never import `agent-service`, `store`, or
`providers` directly.

## What lives where

- `electron/plugin-api.ts` — the ONLY module plugins import (SDK v1).
- `electron/plugin-manifest.ts` — strict manifest validation (zod).
- `electron/capability-registry.ts` — tools/commands/providers/ui/services.
- `electron/plugin-events.ts` — observational events + monotonic policy hooks.
- `electron/plugin-permissions.ts` — least-privilege grants, host-enforced.
- `electron/tool-executor.ts` — centralized tool execution boundary.
- `electron/provider-registry.ts` — replaceable model providers (builtins stay).
- `electron/plugin-lifecycle.ts` — discover → enable → disable → dispose.
- `electron/plugin-sandbox.ts` — vm isolation for `entry` files.
- `electron/plugins-service.ts` — declarative bundles + marketplace install
  (archive limits, id-match check, rollback-safe updates).

## Plugin kinds

1. **Declarative** (no code): `skills/`, `agents/`, `commands/`, `rules/`,
   `hooks.json`. Data only — safe by construction, active immediately.
2. **Executable** (API v1): `manifest.json` with `apiVersion: "1"`,
   executable capability (`tools`/`providers`/`services`/`ui`), and an
   `entry` JS file. Runs sandboxed, requires explicit enable + permission
   approval. Listed in Settings → Marketplace → Executable Extensions.
3. **External services**: MCP servers (see `docs/plugins/mcp.md`). An MCP
   server is NOT a Nexus plugin — it is an external process over stdio/HTTP.

## Lifecycle

```
Discover → Validate → Resolve deps → Verify compat → Permissions →
Approval → Initialize (sandbox) → Register → Enable → Execute →
Disable → Unregister → Dispose
```

Disable/uninstall ALWAYS removes tools, commands, providers, listeners,
grants, and UI contributions. Failures roll back with no stale state.

## Quick links

- `manifest.md` — manifest reference + modes/permissions/entry rules.
- `sdk.md` — ExtensionAPI reference + tool/command/event examples.
- `permissions-security.md` — permission model, approvals, isolation,
  hook aggregation, install integrity, and HONEST limitations.
- `development.md` — templates, local dev, `validate-plugin` script,
  versioning, troubleshooting.
- `marketplace.md` — management UI, trust info, updates/rollback.
- `compatibility.md` — API version policy + migration notes.
- `mcp.md` — MCP vs plugins, server validation, timeouts, credential safety.
- `known-limitations.md` — what is NOT done yet.
