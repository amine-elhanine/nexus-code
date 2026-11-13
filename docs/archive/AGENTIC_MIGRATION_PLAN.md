# Agentic Migration Plan — off LangChain / LangGraph / DeepAgents, onto self-built logic

Status: **IMPLEMENTED** (all phases landed on `fixing-the-code-19`, all suites green) · Branch: `fixing-the-code-19` · Date: 2026-11-06
Constraint honored from `CODING_AGENT_EXECUTION_PLAN.md` working rule 6: changing the agent
framework requires a migration/compatibility plan — this document is that plan.

---

## 1. Why migrate, and what we keep

**Why:**
- The app already owns ~90% of the "agent framework" itself: compaction ladder, checkpoint/resume,
  failover, usage accounting, loop prevention, hooks engine, permissions, tools. What LangChain
  provides is (a) HTTP plumbing to ~15 providers, (b) a ReAct loop, (c) a virtual-FS backend,
  (d) middleware plumbing — all thin relative to the custom code built *on top* of their internals
  (`tool_calls`, `usage_metadata`, `AIMessageChunk.additional_kwargs`, `streamMode` tuples,
  `_getType()` duck-typing). We pay upgrade churn on every minor bump for code we mostly bypass.
- Dependency surface: 15 packages (`@langchain/*` ×12, `langchain`, `deepagents`,
  `langchain-mcp-adapters`) pinning a shared `@langchain/core` version grid.
- Provider behavior is already normalized by hand (`flattenToolMessageContent`,
  `anthropicCachingModel` override, per-provider reasoning kwargs) — we are fighting the
  abstraction more than using it.

**What stays untouched:** renderer (`src/`) and the IPC boundary are framework-neutral —
`AgentEvent` / `AgentUsage` camelCase shapes survive verbatim, zero UI changes required.
Also already self-built and *not* migrated: embeddings/vectors (`notebook-embeddings.ts`,
`notebook-vectors-sqlite.ts`), zod→JSON-Schema walk (`context-service.ts`), rate-limit/error
classification regexes (`rate-limit.ts`), provider data tables (`PROVIDERS`, pricing, effort maps),
`provider-failover.ts` chain data, `capability-registry.ts`.

**What gets replaced (by layer):**

| Layer | Today | Replacement |
|---|---|---|
| Provider models | 10 `@langchain/*` chat-model packages → `BaseChatModel` | `electron/agentcore/llm/` — one SSE client, 3 protocol adapters |
| Inner agent loop | `deepagents.createDeepAgent` (4 call sites) | `electron/agentcore/loop.ts` — own ReAct loop |
| Virtual FS / file tools | deepagents `FilesystemBackend`/`CompositeBackend` | `electron/agentcore/backend.ts` |
| Planning/todo | deepagents planning + `langchain.todoListMiddleware` | existing `plan` event path + own plan tool (already 90% custom) |
| Middleware | `langchain.createMiddleware` (3 uses) | `electron/agentcore/middleware.ts` — same 3 hooks, own contract |
| Outer supervisor graph | `@langchain/langgraph` `StateGraph` (2 files, no checkpointer) | plain `while` loop in `agent-service.ts` |
| Messages | `@langchain/core/messages` classes | `electron/agentcore/messages.ts` — own `ChatMessage` union |
| Tool wrapper | `tool()` from `@langchain/core/tools` | `electron/agentcore/tools.ts` — `defineTool()` (zod schemas kept) |
| MCP | `langchain-mcp-adapters.MultiServerMCPClient` | `@modelcontextprotocol/sdk` directly |
| Checkpoint format | LangChain `toJSON()` `{type, kwargs}` | v2 own format + v1 reader |

---

## 2. Current coupling map (what the agents' reads established)

Import surface, main process only (26 files in `electron/`):

- **`@langchain/core/messages`** (AIMessage/HumanMessage/SystemMessage/ToolMessage):
  `agent-service.ts:3`, `agent/message-utils.ts:4`, `agent/compaction.ts:24`, `context-service.ts:1`,
  `hooks-service.ts:11`, `loop-prevention.ts:4`, `run-checkpoint.ts:6`, `subagent-service.ts:1`,
  `notebook-rag.ts:3`, `home-research-agent.ts:18`.
- **`@langchain/core/tools` `tool()`** (zod-schema tool factory): `code-tools.ts`, `edit-tools.ts`,
  `browser-tool.ts`, `websearch-tool.ts`, `skills-service.ts`, `home-memory-service.ts`,
  `tool-executor.ts`, `agent/background-jobs.ts`, `notebook-rag.ts`, `home-research-agent.ts`,
  `subagent-service.ts`.
- **`@langchain/langgraph`** (Annotation/StateGraph/START/END): only `agent-service.ts:4` and
  `notebook-rag.ts:4`. No checkpointer, no `interrupt()`, no `MemorySaver` anywhere.
- **`deepagents`** (`createDeepAgent`, `FilesystemBackend`, `CompositeBackend`):
  `agent-service.ts:5`, `command-service.ts:5` (backend only), `subagent-service.ts`,
  `notebook-rag.ts`, `home-research-agent.ts`, `notebook-agent-backend.ts`.
- **`langchain`** (`createMiddleware`, `todoListMiddleware`): `hooks-service.ts:10`,
  `loop-prevention.ts:5`, `agent-service.ts:6`.
- **`langchain-mcp-adapters`** (`MultiServerMCPClient`): `mcp-service.ts:1` only.
- **Provider packages**: all instantiated inside `providers.ts:327-510` `createChatModel()` —
  ChatOpenAI (openai/custom/ollama/together/fireworks/azure/plugin providers), ChatOpenAIResponses,
  ChatAnthropic (+ caching subclass, `providers.ts:282-317`), ChatGoogleGenerativeAI (thinkingBudget
  map), ChatMistralAI/ChatGroq/ChatXAI (identical shape), ChatOpenRouter, ChatDeepSeek,
  ChatBedrockConverse.

Deep dependencies to reproduce exactly:

1. **LangChain wire shapes consumed**: `chunk.usage_metadata.input_token_details.cache_read/
   cache_creation` and provider-raw fallbacks (`context-service.ts:213-248`); thinking deltas from
   `additional_kwargs.reasoning_content` / `.reasoning` / Anthropic `thinking` blocks
   (`thinking-chunk.ts:7-29`); `tool_calls[].function.arguments` parsing (`tool-describe.ts:64-84`);
   `_getType()`/`constructor.name` duck-typing (`agent-service.ts:1206,1239,1312,1417`).
2. **deepagents behaviors the loop leans on**: backend-routed built-in file tools
   (ls/read_file/write_file/edit_file/execute/glob/grep), skill mounts via backend routes
   (`skills-service.ts:1115-1162` mounts `/global-skills`, `/system-skills` + slash variants),
   todo/planning middleware, deepagents JSON checkpoint format consumed by `run-checkpoint.ts`
   via `message.toJSON()` → `{type, kwargs}` (`run-checkpoint.ts:111-132`).
3. **Outer graph semantics**: `graph.invoke(..., { recursionLimit })` is used as the *step budget*
   primitive; `isRecursionLimitError` regexes `GRAPH_RECURSION_LIMIT` (`loop-limits.ts:38-41`);
   delta-budget extension ladder (40→60→…), deliverable short-circuit re-invoke with limit 16.
4. **Tests pinning framework shapes**: `test/checkpoint-resume.test.mjs` (imports real
   `createDeepAgent` + `fakeModel` from `@langchain/core/testing`), `cache-usage.test.mjs`,
   `token-accounting.test.mjs`, `compaction-tiers.test.mjs`, `tool-message-sanitize.test.mjs`,
   `loop-prevention.test.mjs`, `notebook-agentic.test.mjs` (imports `deepagents` backends),
   `model-efforts.test.mjs`.

---

## 3. Target architecture — `electron/agentcore/` (zero framework deps)

New module, self-contained, no imports outside `electron/` + `zod` + `@modelcontextprotocol/sdk`.
Everything else migrates onto it; LangChain packages are deleted when the last call site leaves.

### 3.1 Messages (`agentcore/messages.ts`)

```ts
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }   // anthropic-style
  | { type: "image"; source: { kind: "url" | "data"; value: string; mime?: string } };

interface ToolCall { id: string; name: string; args: unknown; rawArgs?: string }

type ChatMessage =
  | { role: "user"; content: ContentBlock[] | string }
  | { role: "assistant"; content: ContentBlock[] | string; toolCalls?: ToolCall[]
      stopReason?: "end" | "tool" | "length"; usage?: Usage }
  | { role: "tool"; toolCallId: string; name?: string; status?: "ok" | "error"
      content: string }                                            // string-only by design
  | { role: "system"; content: string };
```

Design decisions carried over from existing code (not new behavior):
- Tool results are **string content only** — this is what `flattenToolMessageContent` already
  forces before every stream for provider compat.
- `tool_call_id` pairing invariant, "first group survives, newest exchange never degraded"
  compaction rules (`agent/compaction.ts:18-22`) become type-level guarantees.
- Serialization: `{ v: 2, messages: [...] }` plain JSON. **v1 reader**: detect `{type:"human"|"ai"|
  "tool"|"system", kwargs}` and map (the existing `CHECKPOINT_TYPE_BY_CLASS` mapping already
  produces exactly this discriminator, so the v1 file is trivially revivable).

### 3.2 LLM client (`agentcore/llm/`)

Three protocol adapters over `undici`/`fetch` streaming SSE — not ten model classes:

```
llm/
  sse.ts            — SSE line parser (also handles OpenRouter silent-200-error case)
  types.ts          — ChatRequest {messages, tools?, model, temperature, maxTokens?,
                      reasoningEffort?, signal, headers?}
                      ChatEvent  = TextDelta | ThinkingDelta | ToolCallDelta | Done(stopReason, usage)
                      ChatResult = { text, toolCalls, usage: {input, output, cacheRead, cacheCreation}, stopReason }
  openai-compat.ts  — /chat/completions streaming; covers openai, custom, ollama, together,
                      fireworks, openrouter, deepseek, groq, xai, mistral, opencode-zen, azure,
                      all plugin providers. reasoning_effort + Responses-API variant for o-series.
  anthropic.ts      — /v1/messages streaming; cache_control injection (ports
                      anthropicCachingModel.invocationParams), thinking budgets
                      (effortToAnthropicBudget), temperature 1.0-with-thinking rule.
  google.ts         — generateContent streaming; thinkingBudget map (providers.ts:429-437).
  factory.ts        — createChatModel(config) → same signature as today, returns
                      { stream(req): AsyncIterable<ChatEvent>, complete(req): Promise<ChatResult> }
```

Notes:
- Bedrock (`@langchain/aws`, `ChatBedrockConverse`) is the only adapter with no HTTP shortcut:
  **defer** it — keep the dep behind a stub that throws "Bedrock requires legacy provider" in v1,
  or port last via AWS SDK `Converse` streaming if Bedrock users exist. No other package shares it.
- Thinking deltas: adapters emit `ThinkingDelta` natively (replaces `thinking-chunk.ts` mining of
  three different `additional_kwargs` shapes — the knowledge moves into the one place that knows
  the wire protocol).
- Usage parsing moves into adapters too; `StreamUsageTracker` keeps its public API but consumes
  typed `Done.usage` instead of sniffing five metadata shapes (its cumulative-vs-incremental
  `chunk.id` logic is preserved inside adapters).

### 3.3 Tool definition (`agentcore/tools.ts`)

```ts
defineTool({ name, description, schema: z.object({...}), execute(args, ctx) })
```
- zod stays as the authoring format → JSON Schema via the existing zod-v4 walker extracted from
  `context-service.ts:79-88` into `agentcore/zod-schema.ts`.
- **Mechanical migration**: every tool file changes one import (`@langchain/core/tools` →
  `agentcore/tools`); bodies, schemas, descriptions untouched. `executePluginTool` pipeline,
  permissions, policy hooks unchanged.

### 3.4 MCP (`agentcore/mcp.ts`)

Direct `@modelcontextprotocol/sdk`: one `Client` per server (stdio + streamable-http), warm-cache
per config fingerprint (ports `mcp-service.ts:44-53` semantics), `listTools()` → `defineTool`
wrappers whose `execute` calls `callTool`; server JSON-Schema passes through unvalidated (or
wrapped `z.any()`), matching today's lenient behavior. Keep the health-check fallback
(`mcp-service.ts:61-85`) — per-server fault isolation is ours, not the adapter's.

### 3.5 Agent loop (`agentcore/loop.ts`) — replaces `createDeepAgent`

```ts
async function* runAgentLoop(opts: {
  client, system: string, messages: ChatMessage[], tools: AgentTool[],
  backend?: AgentBackend, middleware: Middleware[], stepBudget: number, signal,
}): AsyncIterable<AgentEvent>
```
- Event types: `token`, `thinking`, `tool_start`, `tool_result`, `step`, `assistant`, `done`,
  `usage` — superset of today's `updates`/`messages` consumption; the `values`-mode full-array
  re-emit is dropped (it existed for LangGraph superstep semantics and forced the WeakMap
  memoization).
- Per step: middleware `wrapModelCall` → client.stream → append assistant msg → for each toolCall:
  `wrapToolCall` chain (hooks deny → loop-prevention steer → backend write/edit gates) → execute →
  append `role:"tool"` message. No toolCalls or stopReason `end` → exit.
- Context-relaunch check that today fires off `usage.observedInputTokens` during `values` mode
  moves to a `Done.usage` check per step.
- Middleware contract (own, in `agentcore/middleware.ts`):
  `wrapModelCall(req, next)`, `wrapToolCall(call, next)`, `afterModel(msgs)`. The three existing
  middlewares port almost verbatim: `loop-prevention.ts` (its logic is already fully custom —
  only the wrapper changes), `hooks-service.ts` (`createHooksMiddleware` → same hook table on the
  new contract), plan/todo tool (new 40-line tool emitting the existing `plan` events; deepagents
  todoListMiddleware is only "keep a list, remind the model" — the model-facing semantics stay).

### 3.6 Backend (`agentcore/backend.ts`) — replaces deepagents backends

```ts
interface AgentBackend {
  resolvePath(p: string): string;         // virtual-root + legacy-dir guard
  ls/glob/grep/read/write/edit/delete(path, ...): Promise<...>;
  execute(cmd: string): Promise<...>;
  mounts: Record<string, AgentBackend>;   // replaces CompositeBackend
}
```
- The workspace backend in `command-service.ts:363-450` is **already** the real implementation
  (path normalization, fan-out caps, read-only stubs, approval gates, LSP diagnostics,
  `.deepagents` guard, run-scoped execute policy) — promote it from "deepagents monkey-patch
  wrapper" to the canonical `AgentBackend`; delete the interception indirection.
- Skill mounts: port `buildSkillMounts` route table (incl. the slash-variant routes) onto
  `mounts` lookup. `virtualMode: true` FilesystemBackend becomes a 60-line rooted-path class.
- deepagents built-in file tools that Nexus doesn't already own (plain `ls`, `read_file`,
  `write_file`) become thin `defineTool`s over the backend; Nexus's richer `apply_patch`,
  `read_file_range`, `grep_search` (edit-tools/code-tools) stay authoritative.

---

## 4. Phase plan

Each phase ends with `npm run check` + unit tests green and the app manually smoke-tested
(`npm run cli` for a scripted run). One phase per PR on this branch. Phases 1–2 are safe to run
while LangChain is still installed (strangler order chosen so nothing is half-swapped).

### Phase 0 — characterization pins (½ day)
Freeze current behavior before touching anything:
- Add `test/migration-baselines/`: recorded provider SSE transcripts (1 OpenAI-compat, 1 Anthropic
  thinking run, 1 Gemini) asserting today's extracted usage/thinking/tool-call outputs. These
  become the acceptance tests for the new adapters.
- Record 2–3 full `agent:run` trajectories (`evals/` cases) as output baselines for the loop swap.
- Snapshot the checkpoint JSON v1 format from a real run.

### Phase 1 — agentcore core + tools + messages (2–3 days)
- Build `agentcore/messages.ts`, `agentcore/tools.ts`, `agentcore/zod-schema.ts`, `agentcore/sse.ts`.
- Convert all 11 `tool()` files to `defineTool` (import-only change). LangChain `tool()` objects
  no longer exist at call sites — but deepagents still expects them, so this phase lands together
  with Phase 2's loop for the main agent; to stay green *within* the phase, add a 30-line
  `toLangChainTool` shim in agentcore (deleted in Phase 5).
- Convert `agent/message-utils.ts`, `agent/compaction.ts`, `hooks-service.ts`, `loop-prevention.ts`,
  `context-service.ts` message handling to `ChatMessage`. Keep checkpoint **v1 writer** until
  Phase 4.
- Update tests: `compaction-tiers`, `tool-message-sanitize`, `loop-prevention`, `token-accounting`
  (construct `ChatMessage` instead of LangChain classes).

### Phase 2 — LLM adapters (3–5 days, highest risk)
- Build `agentcore/llm/` (sse, openai-compat, anthropic, google, factory).
- `providers.ts` keeps its 900 lines of provider *data* (tables, effort maps, endpoint routing,
  zen headers, azure config) — only `createChatModel`'s body swaps from LangChain classes to
  `agentcore` adapters. Same for `provider-registry.ts:106` and the failover rebuild call.
- Port `anthropicCachingModel` cache_control injection + thinking budget into `anthropic.ts`;
  thinkingBudget map into `google.ts`; reasoning kwargs into `openai-compat.ts`.
- Mid-run failover (`agent-service.ts:1476-1500`) now rebuilds the client, not the graph.
- Acceptance: Phase 0 baseline transcripts replay identically; live smoke on OpenAI-compat
  (ollama, covers tool calling without streaming quirks), Anthropic (cache_read telemetry +
  thinking deltas), Gemini.
- Keep `@langchain/*` provider packages installed until Phase 5 (rollback path: git revert).

### Phase 3 — inner loop swap on the secondary agents (2–3 days)
Replace `createDeepAgent` + triple-stream consumption with `runAgentLoop` at the three simpler
sites, proving the loop before the main agent:
- `home-research-agent.ts:73-131` (read-only, recursionLimit 24, single concurrency guard —
  smallest surface).
- `subagent-service.ts:583-733` (10 roles, step summaries, `sanitizeResumeCheckpoint` retry-resume
  path, usage estimation fallbacks).
- `notebook-rag.ts:825-937` (drop the single-node StateGraph wrapper → direct `runAgentLoop`;
  doom-loop detection at 4 identical calls; deterministic fallback pipeline untouched).

### Phase 4 — main loop + outer supervisor + checkpoint v2 (3–5 days)
- `agent-service.ts`: delete `buildDeepAgent`/`createDeepAgent`; `streamDeepAgent`/`consumeStream`
  collapse onto `runAgentLoop` (dedup via `seenToolCallIds` disappears — events are now
  single-emission; the `values`-mode relaunch check moves to per-step `Done.usage`).
- Delete the 2-node `StateGraph` (`agent-service.ts:1608-2068`): replace with a plain
  `runSupervisor()` while-loop — `while (attempt < limit) { await runLoop(); const v = await verify();
  if (!v.repairs.length) break; feedback = v.verifyFeedback }`. Budget semantics ported 1:1:
  per-mode limits from `loop-limits.ts`, delta extensions, deliverable short-circuit, doom-loop
  pause, 3-error self-healing, `AgentContextRelaunch` shrink ladder.
- Backend port (§3.6): promote `command-service.getAgentBackend`; port skill mounts; new built-in
  ls/read_file/write_file tools; plan-mode write stubs.
- Middleware runner + the three ports; new plan/todo tool replacing `todoListMiddleware`.
- **Checkpoint v2** (`run-checkpoint.ts`): write `{v:2, ...}` own format; add v1 reader (§3.1);
  bump truncation constants unchanged. `sanitizeResumeCheckpoint` (`rate-limit.ts:86-165`) keeps
  its role, now over `ChatMessage`.
- Update `checkpoint-resume.test.mjs` (drop `deepagents`+`fakeModel`, script the new client),
  `notebook-agentic.test.mjs` (drop deepagents backends), `sandbox-and-agent.test.mjs`
  `.deepagents` assertions unchanged (the guard stays — the folder name is legacy, not the package).

### Phase 5 — MCP + dependency removal (1–2 days)
- `mcp-service.ts` → `@modelcontextprotocol/sdk` (§3.4); settings `testMcpServer` path updated;
  `McpManager.tsx:196` label change.
- Delete `toLangChainTool` shim and all 15 packages from `package.json`; add
  `@modelcontextprotocol/sdk`. Expected lockfile shrink is large (all transitive LangChain deps).
- Sweep residuals: `useAppController.ts:25-112` `packageName` strings (display metadata → update
  or drop the field), `preload.cts` duplicated `AgentEvent` (fix the pre-existing
  `context`/`stream-reset` drift while there), `README.md` architecture section (lines 29-32,
  211, 220, 425-427), `package.json` description line.
- `test/inspect-langchain-links.mjs` removed or repurposed.

### Phase 6 — Bedrock decision + hardening (ongoing)
- Port `ChatBedrockConverse` via AWS SDK `Converse` streaming only if a Bedrock user exists;
  otherwise document removal.
- Run `eval:agent` / `eval:notebook` suites and compare against Phase 0 baselines.
- Optional follow-ups now unlocked: single `AbortSignal` tree, typed provider error taxonomy
  (replacing string regexes over time), parallel tool-call execution.

**Total estimate: ~11–18 working days**, with Phase 2 (adapters) and Phase 4 (main loop) carrying
most risk.

---

## 5. Risk register

| Risk | Mitigation |
|---|---|
| Provider quirks (thinking shapes, usage fields, azure/zen headers, OpenRouter silent-200) | Phase 0 recorded baselines; adapters emit typed deltas so quirks live in one file; live smoke per protocol |
| Deepagents loop behaviors we didn't notice (system-reminder injection, todo nudges, skill-list formatting in prompts) | Diff a recorded real run's prompt/stream before/after in Phase 4; keep `eval:agent` baselines |
| Checkpoint/session compat across upgrade | v2 + v1 reader; old `.nexus/run-checkpoints/*.json` files revive cleanly (already defensive `try/catch`) |
| `recursionLimit` semantics as budget primitive | Port budget ladder explicitly into `runSupervisor`/`runAgentLoop` counters; delete `isRecursionLimitError` regex dependence |
| MCP SDK behavior differences (tool schemas, error mapping) | Keep per-server fault isolation + settings test path; validation stays lenient as today |
| Skill-mount route table regressions (six slash-variants per mount) | Unit-test `resolveRoute` against the full variant list from `skills-service.ts:1129-1159` |
| Two green states can't be kept mid-phase for tools+loop | Accept short-lived shims (`toLangChainTool`) inside phases 1–3; delete in Phase 5 |

## 6. Definition of done

- `npm run check`, `npm test`, `test:unit`, `test:notebook`, `test:permissions`,
  `test:renderer-security` all green with **zero** `@langchain/*` / `langchain` / `deepagents` /
  `langchain-mcp-adapters` imports left in `electron/` and none of the 15 packages in
  `package.json`.
- Recorded Phase 0 baselines replay with identical usage/thinking/tool-call extraction.
- One old-format checkpoint file resumes successfully.
- README/docs updated; IPC protocol and renderer untouched (verifiable by `src/` diff being empty).
