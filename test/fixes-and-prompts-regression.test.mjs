import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { mkdirScratch } from "./helpers/scratch.mjs";

const { buildAnthropicRequestBody } = await import("../dist-electron/agentcore/llm/anthropic.js");
const { createGoogleClient } = await import("../dist-electron/agentcore/llm/google.js");
const { userMsg, assistantMsg, toolMsg } = await import("../dist-electron/agentcore/messages.js");
const { WorkspaceBackend } = await import("../dist-electron/agentcore/backend.js");
const { applySearchReplaceBlocks } = await import("../dist-electron/edit-tools.js");
const { microcompactToolResults, shrinkToBudget } = await import("../dist-electron/agent/compaction.js");
const { trimRunMessages, estimateMessagesTokens } = await import("../dist-electron/context-service.js");
const { parseLspFrames } = await import("../dist-electron/lsp-service.js");
const { parseToMarkdown } = await import("../dist-electron/notebook-parse.js");
const { discoverTrustedHooks } = await import("../dist-electron/hooks-service.js");
const { createBrowserTools } = await import("../dist-electron/browser-tool.js");
const { writeWorkspaceFile } = await import("../dist-electron/project-tools.js");
const { assertPayload, TerminalCreateSchema, DaemonStartSchema } = await import("../dist-electron/ipc/schemas.js");
const { buildSystemPrompt, inferHomeTaskContract } = await import("../dist-electron/agent-prompt.js");

test("anthropic wire adapter coalesces consecutive tool results into one user turn", () => {
  const body = buildAnthropicRequestBody(
    {
      messages: [
        userMsg("Inspect files"),
        assistantMsg("", [
          { id: "c1", name: "read_file", args: { file_path: "a.ts" } },
          { id: "c2", name: "read_file", args: { file_path: "b.ts" } },
        ]),
        toolMsg("c1", "contents-a", "read_file"),
        toolMsg("c2", "contents-b", "read_file"),
      ],
    },
    { providerId: "anthropic", label: "Anthropic", model: "claude-sonnet-4-5", apiKey: "k" }
  );
  const msgs = body.messages;
  assert.equal(msgs.length, 3);
  assert.equal(msgs[2].role, "user");
  assert.equal(msgs[2].content.length, 2);
  assert.equal(msgs[2].content[0].tool_use_id, "c1");
  assert.equal(msgs[2].content[1].tool_use_id, "c2");
});

test("google adapter does not mark optional-only tool fields as required", async () => {
  let captured = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    captured = JSON.parse(init.body);
    return new Response(
      'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } }
    );
  };
  try {
    const client = createGoogleClient({ providerId: "g", label: "Google", model: "gemini-2.5-flash", apiKey: "k" });
    for await (const _event of client.stream({
      messages: [userMsg("hi")],
      tools: [
        {
          name: "list_items",
          description: "List items",
          parameters: {
            type: "object",
            properties: {
              filter: { type: "string" },
              limit: { type: "number" },
            },
          },
          execute: async () => "[]",
        },
      ],
    })) { /* drain */ }
  } finally {
    globalThis.fetch = origFetch;
  }
  const decl = captured?.tools?.[0]?.functionDeclarations?.[0];
  assert.ok(decl, "tool declaration captured");
  assert.equal(decl.parameters.required, undefined);
});

test("search/replace and WorkspaceBackend.edit treat $ replacement patterns literally", async () => {
  const input = "const price = OLD_PRICE;";
  const updated = applySearchReplaceBlocks(input, "<<<<<<< SEARCH\nOLD_PRICE\n=======\n\"$& $1 $' $$50\"\n>>>>>>>");
  assert.equal(updated.trimEnd(), "const price = \"$& $1 $' $$50\";");

  const scratch = await mkdirScratch("nexus-edit-dollar-");
  try {
    await fs.writeFile(path.join(scratch, "sample.txt"), "hello TARGET world", "utf8");
    const backend = new WorkspaceBackend({ rootDir: scratch });
    const res = await backend.edit("sample.txt", "TARGET", "$&-$1-$$-");
    assert.equal(res.error, undefined);
    const onDisk = await fs.readFile(path.join(scratch, "sample.txt"), "utf8");
    assert.equal(onDisk, "hello $&-$1-$$- world");
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
});

test("compaction clears stale results on single-prompt runs and keeps message roles valid", () => {
  const messages = [userMsg("Solve complex single-prompt task")];
  for (let i = 1; i <= 7; i++) {
    messages.push(assistantMsg(`step ${i}`, [{ id: `id_${i}`, name: "read_file", args: { p: `f${i}.ts` } }]));
    messages.push(toolMsg(`id_${i}`, `payload-${i}: ` + "z".repeat(4000), "read_file"));
  }
  const micro = microcompactToolResults(messages, { keepUserTurns: 2 });
  assert.ok(micro.cleared >= 2, `expected stale single-prompt tool results cleared, got ${micro.cleared}`);
  assert.match(String(micro.messages[2].content), /Tool result cleared/);
  assert.equal(micro.messages[messages.length - 1].content, messages[messages.length - 1].content);

  // trimRunMessages prunes early single-prompt exchanges while preserving request & latest steps
  const trimmed = trimRunMessages(messages, 3000);
  assert.ok(estimateMessagesTokens(trimmed) < estimateMessagesTokens(messages));
  assert.equal(trimmed[0].role, "user");
  assert.match(String(trimmed[0].content), /Solve complex single-prompt task/);

  // shrinkToBudget last-resort clipping preserves non-tool message roles
  const hugeTranscript = [
    userMsg("Start task"),
    assistantMsg("x".repeat(30_000)),
    userMsg("y".repeat(30_000)),
    assistantMsg("Final reply"),
  ];
  const shrunk = shrinkToBudget(hugeTranscript, 500);
  for (const msg of shrunk.messages) {
    assert.ok(["user", "assistant", "tool", "system"].includes(msg.role), `valid role preserved, got ${msg.role}`);
  }
  assert.equal(shrunk.messages.filter((m) => m.role === "tool").length, 0);
});

test("parseLspFrames skips malformed header without Content-Length and parses next frame", () => {
  const validBody = JSON.stringify({ jsonrpc: "2.0", id: 1, result: [] });
  const validFrame = `Content-Length: ${Buffer.byteLength(validBody, "utf8")}\r\n\r\n${validBody}`;
  const raw = Buffer.from(`X-Malformed: nope\r\n\r\n${validFrame}`, "utf8");
  const { frames, rest } = parseLspFrames(raw);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].id, 1);
  assert.equal(rest.length, 0);
});

test("parseToMarkdown preserves rows on standalone CR CSV files", async () => {
  const csv = Buffer.from("name,score\rAlice,95\rBob,88\r", "utf8");
  const doc = await parseToMarkdown(csv, "grades.csv");
  assert.match(doc.markdown, /Alice/);
  assert.match(doc.markdown, /Bob/);
  assert.match(doc.markdown, /95/);
  assert.match(doc.markdown, /88/);
});

test("discoverTrustedHooks blocks unapproved .nexus/hooks.json commands", async () => {
  const scratch = await mkdirScratch("nexus-trust-hooks-");
  const prevAppData = process.env.APPDATA;
  process.env.APPDATA = scratch;
  try {
    await fs.mkdir(path.join(scratch, ".nexus"), { recursive: true });
    await fs.writeFile(
      path.join(scratch, ".nexus", "hooks.json"),
      JSON.stringify({ hooks: [{ event: "run:start", command: "echo pwned" }] }),
      "utf8"
    );
    const denied = await discoverTrustedHooks(scratch, "code", async () => false);
    assert.equal(denied.blockedUntrusted, true);
    assert.equal(denied.hooks.length, 0);

    const noCallback = await discoverTrustedHooks(scratch, "code");
    assert.equal(noCallback.blockedUntrusted, true);
    assert.equal(noCallback.hooks.length, 0);

    // Once approved, the content hash is saved and future lookups trust it automatically.
    const approved = await discoverTrustedHooks(scratch, "code", async () => true);
    assert.equal(approved.blockedUntrusted, false);
    assert.equal(approved.hooks.length, 1);

    const cachedTrust = await discoverTrustedHooks(scratch, "code");
    assert.equal(cachedTrust.blockedUntrusted, false);
    assert.equal(cachedTrust.hooks.length, 1);
  } finally {
    if (prevAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = prevAppData;
    await fs.rm(scratch, { recursive: true, force: true });
  }
});

test("browser_fetch_api blocks SSRF metadata targets and writeWorkspaceFile blocks .deepagents", async () => {
  const tools = createBrowserTools(".");
  const apiTool = tools.find((t) => t.name === "browser_fetch_api");
  assert.ok(apiTool);
  const res = String(await apiTool.execute({ url: "http://169.254.169.254/latest/meta-data", method: "GET" }));
  assert.match(res, /local or private|Failed/i);

  const scratch = await mkdirScratch("nexus-state-guard-");
  try {
    await assert.rejects(
      () => writeWorkspaceFile(scratch, ".deepagents/memory.md", "evil"),
      /\.deepagents/i
    );
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
});

test("IPC terminal and daemon schemas reject oversized or empty fields", () => {
  assert.doesNotThrow(() => assertPayload(TerminalCreateSchema, { id: "t1", cols: 80, rows: 24 }, "terminal:create"));
  assert.throws(() => assertPayload(TerminalCreateSchema, { id: "" }, "terminal:create"));
  assert.doesNotThrow(() => assertPayload(DaemonStartSchema, { name: "web", command: "npm run dev" }, "daemons:start"));
  assert.throws(() => assertPayload(DaemonStartSchema, { name: "", command: "npm run dev" }, "daemons:start"));
});

test("system prompts are concise and modularly adapt to task type", () => {
  const mem = { projectMemory: "", sessionMemory: "" };

  // Home greeting omits heavyweight widget/chart tutorials
  const greetingPrompt = buildSystemPrompt(
    "auto",
    "/home",
    "Test",
    "test-model",
    mem,
    "",
    "simple",
    false,
    "general",
    "",
    inferHomeTaskContract("hi"),
    "",
    "",
    "",
    false,
    { request: "hi" }
  );
  assert.ok(greetingPrompt.length < 3000, `greeting prompt should be compact, got ${greetingPrompt.length} chars`);
  assert.doesNotMatch(greetingPrompt, /Mortgage payment calculator/i);
  assert.doesNotMatch(greetingPrompt, /pmt\(r,n,pv\)/);

  // Home interactive widget request includes compact widget grammar
  const widgetPrompt = buildSystemPrompt(
    "auto",
    "/home",
    "Test",
    "test-model",
    mem,
    "",
    "complex",
    false,
    "general",
    "",
    inferHomeTaskContract("create a mortgage calculator with sliders"),
    "",
    "",
    "",
    false,
    { request: "create a mortgage calculator with sliders" }
  );
  assert.match(widgetPrompt, /```widget/);
  assert.match(widgetPrompt, /pmt\(r,n,pv\)/);

  // Home chart comparison includes compact chart grammar without widget bloat
  const chartPrompt = buildSystemPrompt(
    "auto",
    "/home",
    "Test",
    "test-model",
    mem,
    "",
    "complex",
    false,
    "general",
    "",
    inferHomeTaskContract("compare 2023 vs 2024 sales with a bar chart"),
    "",
    "",
    "",
    false,
    { request: "compare 2023 vs 2024 sales with a bar chart" }
  );
  assert.match(chartPrompt, /```bar/);
  assert.doesNotMatch(chartPrompt, /pmt\(r,n,pv\)/);

  // General Home Q&A/research without explicit "chart" keywords still includes
  // inline visual guidance & chart/mermaid syntax for both standard and compact models
  const explainHomePrompt = buildSystemPrompt(
    "auto",
    "/home",
    "Test",
    "test-model",
    mem,
    "",
    "complex",
    false,
    "general",
    "",
    inferHomeTaskContract("explain how TLS handshakes work"),
    "",
    "",
    "",
    false,
    { request: "explain how TLS handshakes work", compact: false }
  );
  assert.match(explainHomePrompt, /```mermaid/);
  assert.match(explainHomePrompt, /bar "Label" 10 20/);
  assert.match(explainHomePrompt, /web_image_search/);

  const compactHomePrompt = buildSystemPrompt(
    "auto",
    "/home",
    "Ollama",
    "qwen2.5:7b",
    mem,
    "",
    "complex",
    false,
    "general",
    "",
    inferHomeTaskContract("explain how TLS handshakes work"),
    "",
    "",
    "",
    false,
    { request: "explain how TLS handshakes work", compact: true }
  );
  assert.match(compactHomePrompt, /```mermaid/);
  assert.match(compactHomePrompt, /```bar/);

  // Code lookup prompt omits browser, GitHub MCP, and new-project sections
  const codeQaPrompt = buildSystemPrompt(
    "auto",
    "/repo",
    "Test",
    "test-model",
    mem,
    "",
    "simple",
    false,
    "code",
    "",
    null,
    "",
    "",
    "",
    false,
    { request: "how does session saving work?", hasGithubMcp: false, includeBrowser: false }
  );
  assert.match(codeQaPrompt, /TASK \(lookup\/Q&A/i);
  assert.doesNotMatch(codeQaPrompt, /get_me/);
  assert.doesNotMatch(codeQaPrompt, /browser_act/);
  assert.doesNotMatch(codeQaPrompt, /NEW PROJECT deliverable/);

  // Code bugfix + browser + GitHub includes targeted sections
  const codeBugWebPrompt = buildSystemPrompt(
    "auto",
    "/repo",
    "Test",
    "test-model",
    mem,
    "",
    "complex",
    false,
    "code",
    "",
    null,
    "",
    "",
    "",
    false,
    { request: "fix login redirect bug on localhost", hasGithubMcp: true, includeBrowser: true }
  );
  assert.match(codeBugWebPrompt, /TASK \(bug fix\)/);
  assert.match(codeBugWebPrompt, /browser_inspect/);
  assert.match(codeBugWebPrompt, /get_me/);
});
