# Known limitations & deferred work (honest list)

Completed in this increment: strict manifest v2, capability registry,
monotonic policy hooks, permission model + tool boundary, sandboxed
activation + lifecycle with rollback, install integrity + rollback-safe
updates, provider registry (builtins + OpenAI-compatible plugin providers),
declarative UI contribution metadata, Marketplace executable panel, samples,
validator, docs, unit + security + lifecycle tests.

## Partially done

- **Live entry handlers**: DONE via the out-of-process runner
  (`plugin-runner.cjs` + `plugin-process-host.ts`, 8 tests in
  `plugin-runner.test.mjs`). Tools with a `handler` execute cross-process
  through the gated boundary; tools without one report clearly.
- **Cross-process event handlers**: `on()` subscriptions record metadata
  only; live delivery is still future work (declarative `hooks.json` covers
  the policy path today).
- **UI contributions**: the `modal` slot renders today via a sandboxed
  iframe host (`PluginUiModal`: `sandbox="allow-scripts"`, opaque origin,
  `window.nexusPlugin` bridge with `callTool`/`close`/`log`, exact-manifest
  file serving in `plugin-ui.ts`, Open buttons in the Marketplace).
  Remaining slots (`settings/sidebar/status/command-palette/home-widget/
  code-panel`) are still reserved metadata. The bridge has no approval
  channel yet, so approval-gated tools called from UI are denied by default
  (use `requiresApproval: false` for UI-reachable tools, or call them from
  the agent where approval UX exists).
- **Retrieval/memory/persistence/verification interfaces**: documented as
  target seams, not yet decoupled (existing notebook/RAG, memory, checkpoint
  code untouched for safety).
- **Replaceable agent loops**: explicitly deferred. LangGraph/DeepAgents stay
  the only loop; safety/cancellation/audit remain enforceable.

## Proposed future work

1. Deeper OS sandboxing for the runner (job objects/seccomp, network
   namespace, memory caps) + live cross-process event delivery.
2. Renderer UI host (iframe + postMessage bridge, per-slot lifecycle).
3. Retrieval/document-processing, memory/persistence, session/checkpoint
   storage interfaces with adapters + tests.
4. Dependency version-range solving + signed marketplace artifacts (requires
   marketplace trust infrastructure that does not exist today).
5. MCP server mode for Nexus (expose authorized capabilities outward).
6. Hot-reload watcher for dev roots (`/reload`-style) + richer diagnostics
   log view in the Marketplace.

## What was NOT changed (deliberately)

Code/Home/Notebook modes, agent orchestration, LangChain/LangGraph/
DeepAgents wiring, session data formats, existing plugin bundles,
provider credentials storage, notebook pipeline. All preserved and covered
by the existing suites.
