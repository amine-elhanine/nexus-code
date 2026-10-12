# SDK reference (v1)

Import surface: **only** `electron/plugin-api.ts` (or the frozen `nexus`
global inside the sandbox — same shape). Version: `PLUGIN_SDK_VERSION = "1"`.

## Entry shape

```js
// dist/index.js (CommonJS-ish top-level script, strict mode)
"use strict";
nexus.registerTool({ name: "greet", description: "Greet someone", modes: ["home", "code"] });
nexus.registerCommand({ name: "hello", description: "Say hello" });
nexus.on("run:start", () => nexus.log("run started"));
```

No `require`, no `process`, no `fetch`, no Electron. If the entry touches a
blocked global at the top level it throws → enable fails safely with the
error shown in the Marketplace. Caught access still cannot escape: the
global simply does not exist in the vm context.

## registerTool

```ts
nexus.registerTool({
  name: "greet",                 // [a-z0-9._-], unique per plugin
  description: "Greet someone",  // shown to the model + UI
  modes: ["home", "code"],       // optional; defaults to manifest modes
  permissions: [],               // optional; subset of approved grants
  requiresApproval: false,       // default true (ask every call)
  timeoutMs: 30000,              // 1000–120000
});
```

Execution boundary (`electron/tool-executor.ts`): zod arg validation →
mode gate → permission gate (host-enforced, deny-by-default) → `tool:before`
policy hooks (monotonic deny) → approval → timeout/cancellation → handler →
secret redaction.

Handlers execute out-of-process (`electron/plugin-runner.cjs` +
`electron/plugin-process-host.ts`): the entry may export a `handler` (or
`execute`) function alongside the tool declaration; the host calls it over
narrow NDJSON-RPC with a host-side timeout. Tools that declare no handler
register as gated metadata and report "declares no executable handler"
instead of running blindly. Runner entries still see only the frozen `nexus`
object (no require/process/fetch); arg schemas are not declared in v1, so
handlers must validate their own inputs (non-object args are rejected by
the boundary).

## registerCommand

```ts
nexus.registerCommand({ name: "hello", description: "Say hello", modes: ["home"] });
```

Names must be unique per plugin (`pluginId:name`); duplicates are rejected,
never silently overwritten. Availability follows modes; discovery merges
with built-in + declarative slash commands.

## on(event, handler)

Subscribed events (v1): `run:start`, `run:end`, `tool:before`,
`tool:after`, `task:completed`, `task:failed`.

- Observational (`run:start/end`, `tool:after`, `task:*`): failures and
  timeouts become diagnostics only — they never change outcomes.
- Policy (`tool:before`): return `"deny"` / `{ verdict: "deny", reason }`
  to block. **Denials are monotonic**: any deny wins; later allows cannot
  override it; exceptions/timeouts abstain (they cannot grant access).

`on()` subscriptions from runner entries are recorded as service metadata
(visible in `capabilities:list`); live cross-process event handlers are not
wired yet. Declarative `hooks.json` shell hooks execute today with the same
monotonic rule (`electron/hooks-service.ts` — first denial wins).

## definePlugin helper

```ts
import { definePlugin } from "./plugin-api.js";
export default definePlugin((nexus) => {
  nexus.registerTool({ name: "greet", description: "Greet" });
});
```

## UI contributions

Declare static HTML in the manifest:

```json
"ui": [{ "slot": "modal", "title": "Calendar", "entry": "./ui/calendar.html" }]
```

Rules: `entry` must exactly match (arbitrary paths are never served), be
`.html`, stay inside the plugin dir, be ≤512KB, and contain no
`<object>/<embed>/<applet>`. The host mounts it in `sandbox="allow-scripts"`
iframe with an opaque origin plus a `window.nexusPlugin` bridge:

```js
const res = await window.nexusPlugin.callTool("list_events", { month: "2026-10" });
if (res.ok) render(res.result.events);
window.nexusPlugin.close(); // ask the host to close the modal
window.nexusPlugin.log("calendar rendered");
```

`callTool` runs the plugin's own runner tool through the same gated
boundary (modes, permissions, approval-deny-by-default, timeouts). Only the
`modal` slot has a renderer today (Marketplace → Open); other slots are
reserved metadata. See `plugins/examples/calendar/` for the full sample.

## What plugins MUST NOT do

- Import `agent-service`, `store`, `providers`, `main`, or any internal file.
- Bypass the tool boundary (all execution goes through `executePluginTool`).
- Grant themselves permissions at runtime (grants are set at enable time;
  only downgrades allowed via `tryDowngradePermissions`).
- Touch Electron (`BrowserWindow`, `ipcMain`), Node (`process`, `require`),
  or the renderer preload. UI contributions are declarative metadata
  (`ui` capability + slots), rendered by the host.
