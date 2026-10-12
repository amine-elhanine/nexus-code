# Manifest reference (API v1)

Strict validation lives in `electron/plugin-manifest.ts` (zod). Legacy v1
bundles (only `id/name/version/capabilities/modes`) keep loading through the
tolerant path in `plugins-service.ts`; anything with `entry` or `apiVersion`
must pass strict validation.

```json
{
  "id": "nexus.database-tools",
  "name": "Database Tools",
  "version": "1.0.0",
  "apiVersion": "1",
  "description": "Database inspection and query assistance",
  "capabilities": ["tools", "commands"],
  "modes": ["code", "home"],
  "permissions": ["workspace.read"],
  "entry": "./dist/index.js",
  "dependencies": {},
  "minAppVersion": "0.4.5",
  "ui": [{ "slot": "settings", "title": "Database Tools" }]
}
```

## Fields

| Field | Required | Rules |
|---|---|---|
| `id` | yes | `[a-z0-9._-]{1,64}`, must match the bundle id on install |
| `name` | yes | 1–80 chars |
| `version` | no (default `0.1.0`) | lenient semver (`1`, `1.2`, `1.2.3` + prerelease) |
| `apiVersion` | no (default `"1"`) | must be a supported version (`"1"`); anything else rejected |
| `description`/`author` | no | ≤500 / ≤120 chars |
| `capabilities` | yes (≥1) | only `skills,agents,commands,rules,hooks,tools,providers,services,ui`; unknown rejected |
| `modes` | no | omitted = all modes (implicit); `[]` = all modes (explicit, backward compat); otherwise 1–3 of `home,code,notebook`. **Unknown modes are rejected — never broadened to all.** |
| `permissions` | no (default `[]`) | only known permissions (see `permissions-security.md`); unknown rejected |
| `entry` | required when any executable capability (`tools,providers,services,ui`) is declared | relative `.js/.mjs/.cjs` path inside the plugin dir; no `..`, no absolute, no URL, no hidden files; ≤256KB |
| `dependencies` | no | `{ "<plugin-id>": "<constraint>" }`; missing dep blocks enable |
| `minAppVersion` | no | semver; enable fails when the running app is older |
| `ui` | no | requires the `ui` capability; slots: `settings,sidebar,modal,status,command-palette,home-widget,code-panel` |

## Capability ↔ contents

- `tools`/`providers`/`services` without `entry` → rejected.
- `entry` without an executable capability → rejected.
- `ui` entries without the `ui` capability → rejected.
- Declarative capabilities should match folders (`skills/`, `agents/`,
  `commands/`, `rules/`, `hooks.json`); `scripts/validate-plugin.mjs`
  checks this before install.

## Modes semantics

`manifestAppliesToMode()`: omitted or `[]` → true for every mode.
Explicit list → only those modes. There is intentionally NO wildcard
string: an omitted field and an explicit empty list are both "all", and
both are recorded (`modesImplicit`) so the UI can show the difference.
Invalid input is never treated as "all".
