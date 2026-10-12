# Plugin development guide

## Templates

- Declarative skill: `plugins/examples/hello-declarative/` (manifest + `skills/hello/SKILL.md`).
- Executable tool: `plugins/examples/hello-tool/` (manifest v2 + `dist/index.js`).
- Policy hook: `plugins/examples/event-guard/` (`hooks.json` + `guard.js`).
- Calendar (tool + modal UI): `plugins/examples/calendar/` (manifest v2 + `dist/index.js` + `ui/calendar.html`).

Copy one, rename `id`, keep the layout. Do not fork Nexus.

## Local dev loop

1. Create a folder with `manifest.json` (+ contents).
2. Validate: `node scripts/validate-plugin.mjs ./my-plugin` (needs `npm run build:electron` first).
3. Link it: Settings → Marketplace → Advanced → pick the parent as dev root
   (every subfolder with a manifest appears automatically), or publish via
   "Import Local".
4. Install into a project, then enable executable plugins in the
   "Executable Extensions" panel (approve exactly the listed permissions).
5. Iterate: edit files, disable/enable to reload. Declarative skills/commands
   reload on the next agent run.

## Validation & compat checks

- `validatePluginManifest()` rejects: unknown modes/capabilities/permissions,
  unsafe entries, missing entries, `ui` without the `ui` capability,
  unsupported `apiVersion`, bad `minAppVersion`, bad dependencies.
- `scripts/validate-plugin.mjs` additionally checks declared capabilities
  against actual folders/files and the entry size/existence.
- `minAppVersion` + `apiVersion` gate enable time; mismatches fail with a
  clear error and no partial registration.

## Versioning

Semver for `version`. Within SDK v1 only additive changes ship; a breaking
SDK ships `apiVersion: "2"` with migration notes in `compatibility.md`.
Old v1 entries keep loading. `dependencies` are informational ids today
(missing dep blocks enable); version-range solving is deferred (see
limitations).

## Calendar walkthrough (manual test)

The calendar sample (`plugins/examples/calendar/`) is the end-to-end proof:
tool + modal UI in one plugin.

1. Build: `npm run build` (or `npm run build:electron` for main-only).
2. Open Nexus with a project workspace (plugins install per-project).
3. Settings → Marketplace → **Import Local** → select
   `plugins/examples/calendar` (publishes to your developer catalog).
4. Install `calendar`, then find it in **Executable Extensions** and
   **Enable** (no permissions requested — enable directly).
5. Click **Open Calendar** → a modal shows the current month with two seeded
   demo events. Navigate months, click a day to fill the form, add an event,
   verify it renders. Close via the × or the bridge.
6. `list_events` / `add_event` are also callable through the normal tool
   boundary (covered in `test/plugin-ui.test.mjs`).
7. **Disable** removes the tools, kills the runner, and closes the surface;
   **Uninstall** disposes state first, then deletes files.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `manifest invalid: …` on install | run the validator; usually a missing `entry` for `tools`, or a typo in `modes`/`permissions` |
| Enable fails `missing dependency` | install the named plugin first |
| Enable fails `requires app >= …` | update Nexus |
| Tool reports "declares no executable handler" | add a `handler` (or `execute`) function to the `registerTool` call — metadata-only tools cannot run |
| Hook denies everything | check `.nexus/hooks.json` + plugin `hooks.json`; hook stderr is the reason |
| Entry fails `require is not defined` | expected: no Node globals in the sandbox; use the `nexus` SDK only |

## MCP integration sample

MCP servers are configured in Settings → MCP (existing UI), not in plugin
manifests. A plugin may request `mcp.connect` to use already-configured
servers through the gated tool path; it cannot add servers silently. To
ship an MCP-based workflow, bundle a **skill** (`SKILL.md`) that documents
which MCP tools to call (`filterSkillsByMcp` picks it when the server is
present) — see `docs/plugins/mcp.md`.
