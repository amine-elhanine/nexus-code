# Nexus — execution model (current)

This note replaces the old sandbox theory. Nexus has **no sandbox**. All agent work runs directly on the host with user privileges.

## What actually runs where

- `electron/command-service.ts` executes shell commands via `execFile` in `projectRoot` (or the session worktree when active). There is no container, no network filter, no tool allowlist. Pipes, chaining and redirections work.
- DeepAgents file tools are scoped by `FilesystemBackend` to the project root (path-escape blocked in `project-tools.ts`), but the **shell is unrestricted** apart from the two gates below.
- MCP servers (`stdio` / `http` / `sse`) and dev daemons also run with your privileges. Daemons get a scrubbed env (structural vars such as `PATH` only).

## The two gates that do exist

1. **Deny backstop** (`electron/permissions.ts`, `isDeniedCommand` / `classifyCommand`): catastrophic patterns never run — `rm -rf /`, `rm -rf ~` / `$HOME` / `/home/…` / `/root`, `mkfs`, `dd … of=/dev/…`, `chmod/chown -R /`, fork bombs, `shutdown/reboot/halt/poweroff`, `format`, `diskpart`, shadow-copy deletion, `bcdedit`, `reg delete`, recursive deletes of drive roots/profiles, `takeown` / `icacls grant`, `net user/localgroup /add`. This is a backstop against agent mistakes, not isolation.
2. **Ask gate** (approval modal: **Deny / Allow for run / Allow once**): `git push|reset|clean|rebase`, dependency mutations (`npm|pnpm|yarn|pip|pip3|cargo install|add|remove|uninstall`), `curl … | sh|bash` and `Invoke-WebRequest|iwr|irm`. Project policy can extend this via `.nexus/permissions.json` or the `nexus.permissions` key in `package.json` (`allow` / `ask` / `deny` glob lists).

## Consequences

- `npm run` scripts, installers and MCP tools execute with full user rights including network access.
- Per-run cancellation is scoped by run id; Stop kills only that run's process tree (`taskkill /T /F` on Windows).
- API keys are encrypted at rest with `safeStorage` and only decrypted in memory.
- If you need isolation, run Nexus in a dedicated VM or container — the app itself is not a security boundary.

## Related code

- `electron/command-service.ts`, `electron/permissions.ts`, `electron/approval-service.ts`
- `electron/daemon-service.ts` (scrubbed env), `electron/mcp-service.ts`, `electron/store.ts` (encrypted keys)
- UI copy: `src/views/AgentView.tsx` input note (“Nexus runs real commands…”)
