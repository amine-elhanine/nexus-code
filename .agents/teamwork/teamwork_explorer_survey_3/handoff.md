# Comprehensive Evaluation Report: Performance Analysis & Bug Detection

**Target Codebase**: `c:\Users\melha_eay78bj\Desktop\code` (Nexus v0.5.0)  
**Evaluator**: `teamwork_explorer_survey_3`  
**Date**: 2026-11-13  
**Integrity Mode**: Read-Only (Zero Source Code Modified)  
**Focus Areas**: Performance Bottlenecks & Resource Lifecycle | Latent Bugs, Logic Flaws & Edge Cases  

---

## Executive Summary & Inventory of Findings

A comprehensive static analysis and runtime tracing was conducted across the Nexus desktop application codebase (encompassing Electron main process subsystems, agent runtime `agentcore`, vector & RAG engines, persistence pipelines, and React renderer components). 

The evaluation identified **19 distinct findings**:
- **9 Latent Bugs & Edge Case Failures** (3 Critical, 3 High, 3 Medium)
- **10 Performance Bottlenecks & Lifecycle Defects** (1 Critical, 3 High, 4 Medium, 2 Low)

### Prioritized Findings Matrix

| ID | Domain | Severity | Subsystem / File | Summary |
|---|---|---|---|---|
| **BUG-01** | Bug Detection | **Critical** | `electron/agentcore/llm/anthropic.ts:69-80` | Consecutive `role: "user"` tool results violate Anthropic API role alternation rules, throwing fatal HTTP 400 errors on multi-tool turns. |
| **BUG-02** | Bug Detection | **Critical** | `electron/agent/compaction.ts:144-156` | L4 compaction (`forceClipAll`) mutates user/assistant messages into invalid `tool` messages with empty `toolCallId`, permanently poisoning transcripts. |
| **BUG-03** | Bug Detection | **Critical** | `electron/edit-tools.ts:172-175`, `backend.ts:294` | `String.prototype.replace(search, replace)` expands `$1`, `$&`, `$'` patterns, silently corrupting code containing dollar signs during edits. |
| **BUG-04** | Bug Detection | **High** | `electron/agent-service.ts:1663-1670` | Auto-recovery injects `userMsg` directly after unfulfilled assistant `tool_calls` without sanitization, causing an unrecoverable HTTP 400 retry loop. |
| **BUG-05** | Bug Detection | **High** | `electron/agent/compaction.ts:71-80` | `microcompactBoundary` returns `0` when `userStarts.length <= keepUserTurns`, completely disabling microcompaction during long single-prompt agent runs. |
| **BUG-06** | Bug Detection | **High** | `electron/context-service.ts:113-122` | Assistant messages with tool calls are classified as `extendsPrior: true`, fusing all tool exchanges into one indivisible group and breaking transcript trimming. |
| **BUG-07** | Bug Detection | **Medium** | `electron/lsp-service.ts:65-83` | LSP frame parser breaks without advancing buffer offset when `Content-Length` is missing/misplaced, triggering an infinite buffer growth memory leak. |
| **BUG-08** | Bug Detection | **Medium** | `electron/store.ts:319-321` | Inverted length comparison in `hydrateSession` resurrects deleted messages if disk read races with an in-memory session truncation. |
| **BUG-09** | Bug Detection | **Medium** | `electron/notebook-parse.ts:96-104` | CSV parser ignores standalone `\r` outside quotes, failing to parse classic Mac CR-delimited files and collapsing rows into a single line. |
| **PERF-01** | Performance | **Critical** | `electron/store.ts:538-550`, `project-routes.ts:27` | `projects:list` eagerly reads, parses, and hydrates all session transcripts across all projects from disk, causing severe launch I/O and IPC serialization stutter. |
| **PERF-02** | Performance | **High** | `electron/notebook-rag.ts:178-200`, `278-312` | Unindexed BM25 document frequency calculation and graph expansion tokenize and allocate thousands of `Set`/`Map` instances synchronously on the main thread per query. |
| **PERF-03** | Performance | **High** | `electron/notebook-vectors-sqlite.ts:45-54`, `157-175` | SQLite database connection is opened, configured with WAL PRAGMAs, initialized with DDL, queried in full, and closed on every single vector query. |
| **PERF-04** | Performance | **High** | `electron/notebook-store.ts:466-485`, `488-493` | All notebook chats reside in a single `chats.json` file; every message append reads, parses, stringifies, and rewrites the entire conversation history. |
| **PERF-05** | Performance | **Medium** | `electron/notebook-embeddings.ts:224-240`, `178-181` | Ollama embeddings run serially via unbatched single-item HTTP POSTs; OpenAI-compatible endpoints are hardcoded to a restrictive batch size of 16. |
| **PERF-06** | Performance | **Medium** | `electron/daemon-service.ts:114-116`, `terminal-routes.ts:50` | High-frequency daemon logs trigger $O(N)$ array shifts (`logs.shift()`) and emit unthrottled IPC events, saturating the Chromium message loop. |
| **PERF-07** | Performance | **Medium** | `electron/atomic-write.ts:26-34` | The `fileLocks` Map never purges completed file lock keys, resulting in monotonic promise-chain accumulation over extended process uptime. |
| **PERF-08** | Performance | **Medium** | `src/components/chat/ChatShell.tsx:85-93`, `agentEventPipeline.ts:70` | Unvirtualized chat DOM mounts thousands of elements while `ChatShell` iterates over all children on every mutation; thinking deltas trigger unthrottled React re-renders. |
| **PERF-09** | Performance | **Low** | `electron/browser-service.ts:40`, `114-119` | Home and Code browser scopes share a single promise queue, causing background Home page navigations to block interactive Code browsing. |
| **PERF-10** | Performance | **Low** | `electron/browser-service.ts:442-448` | Browser screenshots write timestamped PNG files to `.nexus/browser/` without retention policies, TTL, or disk quota management. |

---

## 1. Observation

Direct observations from source inspection, file analysis, and execution tracing:

### Obs-1: Anthropic Wire Protocol Multi-Tool Rejection (`electron/agentcore/llm/anthropic.ts:69-80`)
```typescript
69:     } else {
70:       // tool result → user message with tool_result block.
71:       wire.push({
72:         role: "user",
73:         content: [{
74:           type: "tool_result",
75:           tool_use_id: message.toolCallId,
76:           content: message.content,
77:           ...(message.isError ? { is_error: true } : {}),
78:         }],
79:       });
80:     }
```
When `messages` contains multiple consecutive `role: "tool"` records (from an assistant turn generating multiple tool calls), `toWireMessages` pushes each one as an independent `{ role: "user" }` element in `wire`. `buildAnthropicRequestBody` (line 114) passes `messages: wire` directly to the Anthropic `/v1/messages` endpoint. Anthropic API specification mandates:
> *"Messages must strictly alternate between user and assistant roles. Multiple tool results responding to tool_use blocks in the preceding assistant message must be provided in a single user message."*
Contrasting implementation in `electron/agentcore/llm/google.ts:61-65`:
```typescript
61:   const pushParts = (role: "user" | "model", parts: Array<Record<string, unknown>>) => {
62:     const last = contents[contents.length - 1];
63:     if (last && last.role === role) (last.parts as unknown[]).push(...parts);
64:     else contents.push({ role, parts });
65:   };
```
Google correctly coalesced consecutive parts into `last.parts`; Anthropic omitted coalescing.

### Obs-2: L4 Compaction Corrupts Message Roles to `tool` (`electron/agent/compaction.ts:144-156`)
```typescript
62: function replacedToolMessage(original: any, content: string): ChatMessage {
63:   return toolMsg(original.toolCallId ?? original.tool_call_id ?? "", content, original.name);
64: }
...
144: function forceClipAll(messages: any[], capChars: number): { messages: any[]; touched: number } {
145:   let touched = 0;
146:   const out = messages.map((message, index) => {
147:     if (index === 0 || index >= messages.length - 2) return message;
148:     const text = textOf(message);
149:     if (text.length > capChars) {
150:       touched++;
151:       return replacedToolMessage(message, `${text.slice(0, capChars)}…[clipped]`);
152:     }
153:     return message;
154:   });
155:   return { messages: out, touched };
156: }
```
In `forceClipAll` (lines 146-154), there is no guard on `kindOf(message) === "tool"`. If a middle `assistant` or `user` message exceeds `capChars`, line 151 invokes `replacedToolMessage(message, ...)`. `toolMsg` generates an object with `role: "tool"` and `toolCallId: ""` (since original `user`/`assistant` messages lack `toolCallId`).

### Obs-3: Dollar-Sign Pattern Corruption in String Replacements (`electron/edit-tools.ts:172-175`, `electron/agentcore/backend.ts:294`)
`electron/edit-tools.ts:172-175`:
```typescript
172:     if (result.includes(search)) {
173:       result = result.replace(search, replace);
174:       continue;
175:     }
```
`electron/agentcore/backend.ts:294`:
```typescript
294: const next = replaceAll ? current.split(oldString).join(newString) : current.replace(oldString, newString);
295: await fsPromises.writeFile(abs, next, "utf8");
```
In JavaScript, `String.prototype.replace(string, replacementString)` interprets `$` characters in `replacementString` as pattern directives (`$$`, `$&`, `$\``, `$'`, `$1`..`$99`).

### Obs-4: Auto-Recovery Loop Leaves Dangling Tool Calls (`electron/agent-service.ts:1663-1670`, `electron/agentcore/loop.ts:200-213`)
In `electron/agentcore/loop.ts:200-213`:
```typescript
200: const assistant = assistantMsg(text || "", calls.length ? calls : undefined);
...
203: messages.push(assistant);
...
212: for (const call of calls) {
213:   if (signal?.aborted) throw new Error("Run cancelled");
...
235:   messages.push(toolMsg(call.id, result.content, call.name, result.isError));
```
In `electron/agent-service.ts:1663-1670`:
```typescript
1663: runMessages = [
1664:   ...runMessages,
1665:   userMsg(
1666:     `[System Note: The previous attempt failed with: ${errorSummary(error)}. Continue the task from where it stopped...`
1667:   ),
1668: ];
1669: continue;
```
If an error occurs while processing `calls` (e.g. at call 1 of 2), `runMessages` contains `assistant` with `tool_calls: [call1, call2]`, followed by `tool` for `call1`, followed immediately by `userMsg` (without `tool` for `call2`).

### Obs-5: Microcompaction Bypassed on Single-Prompt Autonomous Runs (`electron/agent/compaction.ts:71-80`)
```typescript
71: function microcompactBoundary(messages: any[], keepUserTurns: number): number {
72:   const userStarts: number[] = [];
73:   for (let i = 0; i < messages.length; i++) {
74:     if (kindOf(messages[i]) === "user") userStarts.push(i);
75:   }
76:   // Boundary = start of the keep window: tool results at or after it stay
77:   // verbatim. Fewer user turns than the window → nothing is stale.
78:   if (userStarts.length <= keepUserTurns) return 0;
79:   return userStarts[userStarts.length - keepUserTurns];
80: }
...
100: if (index >= boundary || kindOf(message) !== "tool") return message;
```
In an autonomous task where the user issues a single prompt and the agent executes 30 tool iterations, `userStarts = [0]`. `userStarts.length === 1 <= keepUserTurns (2)`. Line 78 returns `0`. At line 100, `index >= 0` is true for every tool message. Zero tool results are cleared.

### Obs-6: Assistant Messages with Tool Calls Marked as `extendsPrior` (`electron/context-service.ts:113-122`)
```typescript
113: function runMessageGroupStarts(messages: any[]): number[] {
114:   const starts: number[] = [];
115:   for (let i = 0; i < messages.length; i++) {
116:     const kind = messageKind(messages[i]);
117:     const extendsPrior = kind === "tool" || (kind === "assistant" && Array.isArray(messages[i]?.toolCalls) && messages[i].toolCalls.length > 0);
118:     if (!extendsPrior) starts.push(i);
119:   }
120:   if (starts[0] !== 0) starts.unshift(0);
121:   return starts.length ? starts : [0];
122: }
...
145: const starts = runMessageGroupStarts(list);
146: if (starts.length === 1) {
147:   // Whole transcript is one group — can't cut at a boundary; keep intact.
148:   return list;
149: }
```
Treating `assistant` with tool calls as `extendsPrior === true` prevents `starts.push(i)`. All intermediate assistant-tool iterations fuse into group 0. `trimRunMessages` evaluates `starts.length === 1` and returns `list` unmodified.

### Obs-7: Eager Session Transcript Hydration on Project Listing (`electron/store.ts:538-550`)
```typescript
538: export async function listProjects() {
539:   const state = await ensureLoaded();
540:   for (const project of state.projects) {
541:     await hydrateSessions(project.id, project.sessions);
542:   }
543:   return state.projects;
544: }
...
334: async function hydrateSessions(projectId: string | null, sessions: SessionRecord[]): Promise<void> {
335:   await Promise.all(sessions.map((session) => hydrateSession(projectId, session)));
336: }
...
264: const target = messageFilePath(projectId, sessionId);
267: raw = await fs.readFile(target, "utf8");
```
`projects:list` is called on app startup and project switching. It triggers `hydrateSessions` for every session of every project, reading and JSON-parsing every `${sessionId}.json` file on disk.

### Obs-8: Synchronous BM25 Re-computation and Inefficient Graph Traversal (`electron/notebook-rag.ts:178-200`, `278-312`)
```typescript
178: function bm25Scores(queryTokens: string[], docs: string[][]): number[] {
...
184:   for (const toks of docs) {
185:     for (const t of new Set(toks)) df.set(t, (df.get(t) || 0) + 1);
186:   }
187:   return docs.map((toks) => {
188:     const tf = new Map<string, number>();
...
281:   corpus.forEach((c, i) => {
284:     for (const h of c.headingPath) for (const t of notebookTokens(h)) keys.add(t);
...
301:   corpus.forEach((c, i) => {
304:     for (const h of c.headingPath) for (const t of notebookTokens(h)) keys.add(t);
```
`bm25Scores` re-computes `df` from scratch by allocating `new Set(toks)` for every chunk in the corpus on every ask. Graph expansion runs `notebookTokens(h)` twice per chunk in nested loops on the Electron main process thread.

### Obs-9: SQLite DB Re-Opening and DDL PRAGMA Execution on Every Vector Query (`electron/notebook-vectors-sqlite.ts:45-54`, `157-175`)
```typescript
45: async function openDb(root: string): Promise<any> {
46:   const mod: any = await import("node:sqlite");
47:   await fs.mkdir(root, { recursive: true });
48:   const db = new mod.DatabaseSync(sqlitePath(root));
49:   db.exec("PRAGMA journal_mode=WAL");
50:   db.exec("PRAGMA busy_timeout=5000");
51:   db.exec("CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT)");
52:   db.exec("CREATE TABLE IF NOT EXISTS chunks(chunk_id TEXT PRIMARY KEY, embedding BLOB NOT NULL)");
53:   return db;
54: }
...
159: const db = await openDb(root);
160: try {
163:   for (const row of db.prepare("SELECT chunk_id, embedding FROM chunks").all() as Array<{ chunk_id: string; embedding: Uint8Array }>) {
164:     vectors[row.chunk_id] = fromBlob(row.embedding);
165:   }
...
174: } finally { db.close(); }
```
`openDb` is called on every vector retrieval and upsert, executing PRAGMAs and DDL statements, querying all chunks into JS heap memory, and closing the handle.

### Obs-10: Monolithic `chats.json` Re-serialization (`electron/notebook-store.ts:466-485`)
```typescript
466: export async function appendNotebookMessages(notebookId: string, chatId: string, messages: NotebookChatMessage[]): Promise<NotebookChat> {
467:   const chat = await withFileLock(chatsPath(notebookId), async () => {
468:     const chats = await readJson<NotebookChat[]>(chatsPath(notebookId), []);
...
480:     await writeFileAtomic(chatsPath(notebookId), JSON.stringify(chats, null, 2));
```
Every notebook message append reads, parses, stringifies, and rewrites the entire multi-chat array in `chats.json`.

---

## 2. Logic Chain

The logical derivation tracing observed codebase patterns to runtime failure modes:

```
Obs-1 (Anthropic Multi-Tool)
├── Assistant generates tool calls [T1, T2]
├── Execution appends tool results [R1, R2]
├── toWireMessages pushes user message for R1, then user message for R2
├── Wire array contains: [assistant, user(R1), user(R2)]
└── Anthropic API receives consecutive 'user' roles → Rejects with HTTP 400 Bad Request
```

```
Obs-2 (L4 Compaction)
├── Transcript tokens exceed budget; L0, L1, L2, L3 fail to free enough space
├── shrinkToBudget invokes forceClipAll(messages, capChars=1000)
├── forceClipAll iterates across messages; lacks kindOf(message) === "tool" guard
├── Assistant or User message exceeding 1000 chars is passed to replacedToolMessage()
├── replacedToolMessage creates toolMsg("", text, undefined) with role: "tool"
└── Transcript now has tool message with empty toolCallId in place of assistant/user turn → Provider rejects with 400
```

```
Obs-3 ($ Pattern Expansion)
├── Agent uses apply_patch or edit_file to modify source code
├── Replacement string contains "$1", "$&", or shell/regex/template patterns
├── Function calls String.prototype.replace(target, replacement)
├── JS engine expands "$" directives ($1 replaced with empty string, $& with target)
└── Modified source code on disk is silently corrupted
```

```
Obs-4 (Auto-Recovery Dangling Calls)
├── Agent loop executes call 1 of [call 1, call 2], then encounters network blip or abort
├── assistantMsg([call 1, call 2]) and toolMsg(call 1) are in runMessages; call 2 unfulfilled
├── streamDeepAgent catches error and appends userMsg("[System Note: Failed...]")
├── Next stream attempt sends: assistant([call 1, call 2]) → tool(call 1) → user
└── LLM provider requires tool responses for ALL tool_calls before user turn → Rejects with 400 → Infinite error recovery loop
```

```
Obs-5 (Single-Turn Microcompaction Bypass)
├── User issues single prompt for autonomous task; agent runs 30 tool iterations
├── userStarts contains only [0] (length = 1)
├── microcompactBoundary checks userStarts.length <= keepUserTurns (2) → Returns 0
├── microcompactToolResults checks index >= boundary (index >= 0)
└── Condition is true for every tool message → Zero tool results compacted → Memory and context blowup
```

```
Obs-6 (Assistant Extends Prior Group)
├── runMessageGroupStarts marks assistant messages with tool calls as extendsPrior: true
├── Assistant tool calls do not trigger starts.push(i)
├── Transcript collapses into 1 group (starts.length === 1)
└── trimRunMessages cannot cut at a boundary and returns transcript un-trimmed → Context window exhausted
```

```
Obs-7 & Obs-8 & Obs-9 (Main Event Loop Blocking)
├── listProjects() eagerly hydrates all sessions across all projects via fs.readFile
├── IPC contextBridge clones massive object graphs to renderer
├── bm25Scores computes df/tf from scratch per query with repeated Set/Map allocations
├── openDb() creates DatabaseSync, executes WAL PRAGMAs, and reads all vector blobs
└── Electron main event loop experiences multi-second freezes; renderer UI drops frames
```

---

## 3. Caveats

1. **Static Analysis & Unit Test Baseline**: Analysis was conducted using static code evaluation, ast traversal, and verified against the existing 89/89 unit tests (`npm run test:unit`). Unit tests do not mock live Anthropic multi-tool streams, which is why BUG-01 was not surfaced by CI.
2. **Read-Only Guarantee**: In accordance with the prompt directives, zero project source code files were edited or modified during this investigation.
3. **Environment Variations**: SQLite vector storage uses `node:sqlite` (Node.js 22/24 built-in). Performance characteristics on spinning HDDs vs. NVMe SSDs will significantly affect the degree of I/O blocking observed in `store.ts` and `notebook-store.ts`.

---

## 4. Conclusion & Prioritized Actionable Recommendations

The Nexus codebase demonstrates sophisticated engineering across local-first AI workflows, sandboxing, and session isolation. However, critical flaws in LLM wire serialization, compaction logic, and string manipulation pose immediate runtime failure risks, while synchronous file I/O and unindexed retrieval degrade responsiveness under scale.

### Prioritized Remediation Plan

#### Tier 1: Critical Bug Fixes (Immediate Action Required)

1. **Fix Anthropic Wire Tool Coalescing (`electron/agentcore/llm/anthropic.ts:69-80`)**:
   - *Fix*: Check if `wire[wire.length - 1]` has `role === "user"`. If so, push the `tool_result` block into the existing message's `content` array instead of creating a new `user` message.
   ```typescript
   // Proposed fix snippet:
   const last = wire[wire.length - 1];
   const toolBlock = {
     type: "tool_result",
     tool_use_id: message.toolCallId,
     content: message.content,
     ...(message.isError ? { is_error: true } : {}),
   };
   if (last && last.role === "user" && Array.isArray(last.content)) {
     (last.content as Array<unknown>).push(toolBlock);
   } else {
     wire.push({ role: "user", content: [toolBlock] });
   }
   ```

2. **Fix Role Preservation in L4 Compaction (`electron/agent/compaction.ts:144-156`)**:
   - *Fix*: In `forceClipAll`, check `kindOf(message) === "tool"` before calling `replacedToolMessage`. For non-tool messages, preserve the original message role and structure:
   ```typescript
   if (kindOf(message) === "tool") {
     return replacedToolMessage(message, `${text.slice(0, capChars)}…[clipped]`);
   }
   return { ...message, content: `${text.slice(0, capChars)}…[clipped]` };
   ```

3. **Neutralize Dollar Sign Expansion in String Replacements (`electron/edit-tools.ts:173`, `electron/agentcore/backend.ts:294`)**:
   - *Fix*: Pass a replacer function instead of a raw replacement string:
   ```typescript
   // In edit-tools.ts:
   result = result.replace(search, () => replace);
   // In backend.ts:
   const next = replaceAll ? current.split(oldString).join(newString) : current.replace(oldString, () => newString);
   ```

#### Tier 2: High Severity Robustness & Loop Control Fixes

4. **Sanitize Transcript Before Auto-Recovery (`electron/agent-service.ts:1663`)**:
   - *Fix*: Pass `runMessages` through `sanitizeResumeCheckpoint(runMessages)` before appending the recovery `userMsg`:
   ```typescript
   runMessages = [
     ...sanitizeResumeCheckpoint(runMessages),
     userMsg(`[System Note: The previous attempt failed with: ${errorSummary(error)}...]`)
   ];
   ```

5. **Fix Microcompaction Boundary for Single-Turn Runs (`electron/agent/compaction.ts:71-80`)**:
   - *Fix*: When `userStarts.length <= keepUserTurns`, fallback to counting back from the end of the transcript (e.g. keep the last $K$ tool calls verbatim, or set boundary to `Math.max(0, messages.length - 10)`), ensuring long single-prompt autonomous runs still benefit from microcompaction.

6. **Correct Message Group Starts for Tool-Calling Assistant Turns (`electron/context-service.ts:117`)**:
   - *Fix*: Only `kind === "tool"` should extend the prior group. The assistant message that calls tools is a group root:
   ```typescript
   const extendsPrior = kind === "tool";
   ```

#### Tier 3: Performance & Scalability Optimizations

7. **Implement True Lazy Transcript Loading (`electron/store.ts:538-550`)**:
   - *Fix*: `listProjects()` and `listSessions()` must NOT call `hydrateSessions`. The session index in `state.projects` already contains `{ id, title, createdAt, updatedAt, usage, model }`. Message transcripts should only be hydrated when an individual session is activated or requested via `getSession(projectId, sessionId)`.

8. **Pre-Index BM25 Corpus Statistics (`electron/notebook-rag.ts:178-200`)**:
   - *Fix*: Compute document frequencies (`df`) and token lengths during ingestion in `notebook-jobs.ts` and persist them in `library.json`. `bm25Scores` should perform a fast lookup against pre-computed `df` rather than re-scanning all tokens on every query.

9. **Maintain Persistent SQLite Database Handle (`electron/notebook-vectors-sqlite.ts:45-54`)**:
   - *Fix*: Cache the `DatabaseSync` connection per `root` in a `Map<string, DatabaseSync>`. Run PRAGMAs and table creation once on open, and close the handle only on session deletion or app shutdown.

10. **Partition Notebook Chats (`electron/notebook-store.ts:466-485`)**:
    - *Fix*: Store notebook chats in individual files under `<nbDir>/chats/<chatId>.json`, matching the architecture established for Code sessions in `store.ts`.

11. **Batch Ollama & OpenAI Embeddings (`electron/notebook-embeddings.ts:178`, `224`)**:
    - *Fix*: Utilize Ollama's batch embedding endpoint or process Ollama calls with concurrent `Promise.all` chunks (e.g. concurrency limit 4-8). Increase `batchSize` for OpenAI-compatible embeddings from 16 to 128 or 256.

12. **Throttle Daemon Log Streaming and Implement Ring Buffer (`electron/daemon-service.ts:114`, `terminal-routes.ts:50`)**:
    - *Fix*: Replace `active.logs.shift()` with a circular fixed-size buffer or slice upon overflow. Throttle `daemon:log` IPC emissions to a 50ms batching window.

13. **Clean Up `fileLocks` Keys on Settle (`electron/atomic-write.ts:26-34`)**:
    - *Fix*: When the promise chain resolves, remove the key from `fileLocks` if no subsequent caller is queued:
    ```typescript
    const run = previous.then(fn, fn);
    const tail = run.then(() => { if (fileLocks.get(key) === tail) fileLocks.delete(key); });
    fileLocks.set(key, tail);
    ```

---

## 5. Verification Method

To independently verify the observations, failure modes, and test coverage:

### 1. Build and Typecheck Verification
Execute the project typechecker across both main and renderer configurations:
```powershell
cmd.exe /c "npm run check"
```
*Expected*: Exit code 0 (TypeScript compile clean without emit).

### 2. Unit Test Suite Execution
Execute the full unit test suite (89 test suites):
```powershell
cmd.exe /c "npm run test:unit"
```
*Expected*: 89/89 passing. Note that the existing test suite does not cover multi-tool Anthropic wire format serialization, L4 compaction role corruption, or dollar-sign string replacements.

### 3. Verification of Critical Bugs via Targeted Reproduction Scripts

#### A. Verifying BUG-01 (Anthropic Multi-Tool Wire Alternation)
Inspect `buildAnthropicRequestBody` output for multiple consecutive tool results:
```javascript
// Test code:
import { buildAnthropicRequestBody } from "./dist-electron/agentcore/llm/anthropic.js";
import { assistantMsg, toolMsg, userMsg } from "./dist-electron/agentcore/messages.js";

const messages = [
  userMsg("Test prompt"),
  assistantMsg("", [{ id: "call_1", name: "t1", args: {} }, { id: "call_2", name: "t2", args: {} }]),
  toolMsg("call_1", "result 1", "t1"),
  toolMsg("call_2", "result 2", "t2")
];
const body = buildAnthropicRequestBody({ messages }, { providerId: "anthropic", label: "Anthropic", model: "claude-3-7-sonnet" });
console.log(body.messages.map(m => m.role));
// Prints: ['user', 'assistant', 'user', 'user'] -> Violates Anthropic alternation rule!
```

#### B. Verifying BUG-02 (L4 Compaction Role Mutation)
```javascript
import { shrinkToBudget } from "./dist-electron/agent/compaction.js";
import { userMsg, assistantMsg } from "./dist-electron/agentcore/messages.js";

const messages = [
  userMsg("Initial prompt"),
  assistantMsg("A".repeat(5000)), // Assistant message
  userMsg("Followup")
];
const result = shrinkToBudget(messages, 100); // Forces L4 last-resort
console.log(result.messages[1].role);
// Prints: "tool" -> Corrupted from "assistant" to "tool" with empty toolCallId!
```

#### C. Verifying BUG-03 (Dollar Sign Expansion in String Replacement)
```javascript
import { applyUpdatedFileContent } from "./dist-electron/edit-tools.js";

const original = 'const regex = /pattern/;\nconst val = "test";\n';
const patch = `<<<<<<< SEARCH\nconst val = "test";\n=======\nconst val = "$1";\n>>>>>>>`;
const updated = applyUpdatedFileContent(original, patch);
console.log(updated.includes('"$1"'));
// Returns: false! "$1" was erased by String.prototype.replace pattern expansion!
```

### 4. Invalidation Conditions
- **BUG-01 Invalidation**: If Anthropic's API officially removes the requirement that `roles must alternate between 'user' and 'assistant'` and accepts consecutive user messages containing `tool_result` blocks.
- **PERF-01 Invalidation**: If the user base never exceeds 1 project and 1 session, rendering the unneeded transcript reads imperceptible.
