import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const {
  isCompactModelProfile,
  parseOllamaShowContextWindow,
  compactToolsForSmallModel,
} = await import("../dist-electron/model-profile.js");
const {
  parseToolArgsSafely,
  extractTextToolCalls,
  createLeadingThinkSplitter,
} = await import("../dist-electron/agentcore/llm/openai-compat.js");
const { WorkspaceBackend } = await import("../dist-electron/agentcore/backend.js");
const { createFilesystemTools } = await import("../dist-electron/agentcore/builtin-file-tools.js");
const { buildSystemPrompt } = await import("../dist-electron/agent-prompt.js");
const { prepareContextBudget } = await import("../dist-electron/agent/context-budget.js");

let passed = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
    })
    .catch((err) => {
      console.error(`FAIL: ${name}`);
      throw err;
    });
}

await check("isCompactModelProfile isolates small/local models without affecting frontier models", () => {
  // Big frontier models must NEVER be downgraded.
  assert.equal(isCompactModelProfile({ provider: "anthropic", modelName: "claude-sonnet-4-6", contextWindow: 200_000 }), false);
  assert.equal(isCompactModelProfile({ provider: "openai", modelName: "gpt-5", contextWindow: 256_000 }), false);
  assert.equal(isCompactModelProfile({ provider: "google", modelName: "gemini-2.5-pro", contextWindow: 1_048_576 }), false);
  assert.equal(isCompactModelProfile({ provider: "deepseek", modelName: "deepseek-reasoner", contextWindow: 131_072 }), false);
  assert.equal(isCompactModelProfile({ provider: "ollama", modelName: "llama3.3:70b", contextWindow: 131_072 }), false);

  // Small / local models activate compact mode.
  assert.equal(isCompactModelProfile({ provider: "ollama", modelName: "qwen2.5-coder:7b", contextWindow: 128_000 }), true);
  assert.equal(isCompactModelProfile({ provider: "ollama", modelName: "llama3.2:latest", contextWindow: 128_000 }), true);
  assert.equal(isCompactModelProfile({ provider: "custom", baseUrl: "http://127.0.0.1:1234/v1", modelName: "local-model", contextWindow: 128_000 }), true);
  assert.equal(isCompactModelProfile({ provider: "openai", modelName: "gpt-4o", contextWindow: 16_384 }), true);
});

await check("parseOllamaShowContextWindow reads num_ctx and caps untuned GGUF context_length", () => {
  assert.equal(parseOllamaShowContextWindow({ parameters: "temperature 0.7\nnum_ctx 16384\n" }), 16_384);
  assert.equal(parseOllamaShowContextWindow({ model_info: { "qwen2.context_length": 131072 } }), 32_768);
  assert.equal(parseOllamaShowContextWindow({ model_info: { "llama.context_length": 8192 } }), 8192);
});

await check("compactToolsForSmallModel prunes low-ROI tools and shortens schemas non-destructively", () => {
  const longDesc = "First short actionable sentence. Second verbose sentence explaining every possible edge case and caveat that wastes precious small-model context tokens on every single step.";
  const sampleTools = [
    { name: "read_file", description: longDesc, parameters: { type: "object", properties: { file_path: { type: "string", description: longDesc } }, additionalProperties: false }, execute: async () => "ok" },
    { name: "delegate_task", description: "Delegate task", parameters: { type: "object", properties: {} }, execute: async () => "ok" },
    { name: "project_memory", description: "Project memory", parameters: { type: "object", properties: {} }, execute: async () => "ok" },
    { name: "write_todos", description: "Todo list", parameters: { type: "object", properties: {} }, execute: async () => "ok" },
  ];
  const compacted = compactToolsForSmallModel(sampleTools, { taskKind: "code", isSimple: false, requiresPlanGate: false });
  assert.deepEqual(compacted.map((t) => t.name), ["read_file"]);
  assert.equal(compacted[0].description, "First short actionable sentence.");
  assert.equal(compacted[0].parameters.additionalProperties, undefined);
  assert.equal(sampleTools[0].description, longDesc);

  const gated = compactToolsForSmallModel(sampleTools, { taskKind: "code", isSimple: false, requiresPlanGate: true });
  assert.deepEqual(gated.map((t) => t.name), ["read_file", "write_todos"]);
});

await check("parseToolArgsSafely & extractTextToolCalls handle local-model glitches safely", () => {
  assert.deepEqual(parseToolArgsSafely('{"path":"a.ts"}'), { path: "a.ts" });
  assert.deepEqual(parseToolArgsSafely('```json\n{"content": "line1\nline2",}\n```'), { content: "line1\nline2" });
  assert.ok("_raw" in parseToolArgsSafely("not json at all"));

  const mixed = 'Let me check.\n<tool_call>\n{"name": "read_file", "arguments": {"file_path": "src/App.tsx",}}\n</tool_call>';
  const parsed = extractTextToolCalls(mixed);
  assert.equal(parsed.calls.length, 1);
  assert.equal(parsed.calls[0].name, "read_file");
  assert.deepEqual(parsed.calls[0].args, { file_path: "src/App.tsx" });
  assert.equal(parsed.text, "Let me check.");

  const inFence = "Example:\n```xml\n<tool_call>{\"name\":\"read_file\",\"arguments\":{\"file_path\":\"a\"}}</tool_call>\n```";
  const fencedOut = extractTextToolCalls(inFence);
  assert.equal(fencedOut.calls.length, 0);
  assert.equal(fencedOut.text, inFence);
});

await check("createLeadingThinkSplitter separates leading <think> without buffering normal streams", () => {
  const splitter = createLeadingThinkSplitter();
  const chunks = ["  <thi", "nk>step 1\n", "step 2</thi", "nk>\n\nFinal ", "answer <think>literal</think>"];
  let thoughts = "";
  let text = "";
  for (const ch of chunks) {
    const out = splitter.push(ch);
    thoughts += out.thinkingDeltas.join("");
    text += out.textDeltas.join("");
  }
  const tail = splitter.flush();
  thoughts += tail.thinkingDeltas.join("");
  text += tail.textDeltas.join("");
  assert.equal(thoughts, "step 1\nstep 2");
  assert.equal(text, "Final answer <think>literal</think>");

  const normal = createLeadingThinkSplitter();
  const first = normal.push("Hello world");
  assert.deepEqual(first.textDeltas, ["Hello world"]);
  assert.deepEqual(first.thinkingDeltas, []);
});

await check("WorkspaceBackend.edit provides nearest lines on mismatch & compactMode bounds ls/read_file", async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-compact-edit-"));
  try {
    await fs.writeFile(path.join(scratch, "demo.ts"), "export function alpha() {\n  return 41;\n}\n", "utf8");
    const backend = new WorkspaceBackend({ rootDir: scratch });
    const res = await backend.edit("demo.ts", "function alpha() {\nreturn 99;\n}", "return 42;");
    assert.ok(res.error?.includes("Nearest match around line 1"));
    assert.ok(res.error?.includes("return 41;"));

    for (let i = 0; i < 130; i++) {
      await fs.writeFile(path.join(scratch, `f${String(i).padStart(3, "0")}.txt`), "x", "utf8");
    }
    const defaultLs = createFilesystemTools(backend).find((t) => t.name === "ls");
    const compactLs = createFilesystemTools(backend, { compactMode: true }).find((t) => t.name === "ls");
    const defOut = await defaultLs.execute({});
    const cmpOut = await compactLs.execute({});
    assert.ok(!defOut.includes("entries omitted"));
    assert.ok(cmpOut.includes("more entries omitted"));
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
});

await check("buildSystemPrompt & prepareContextBudget shrink compact runs without altering big-model defaults", async () => {
  const mem = { projectMemory: "Fact A\n\nFact B", sessionMemory: "Did X", facts: "Build passes" };
  const bigPrompt = buildSystemPrompt("auto", "/repo", "Anthropic", "claude-sonnet-4-6", mem, "", "complex", false, "code", "REPO_MAP", null, "SUBAGENTS", "PROJ_INST", "", false, { request: "fix login bug", compact: false });
  const smallPrompt = buildSystemPrompt("auto", "/repo", "Ollama", "qwen2.5-coder:7b", mem, "", "complex", false, "code", "REPO_MAP", null, "SUBAGENTS", "PROJ_INST", "", false, { request: "fix login bug", compact: true });
  assert.ok(smallPrompt.length < bigPrompt.length);
  assert.ok(bigPrompt.includes("SUBAGENTS"));
  assert.ok(!smallPrompt.includes("SUBAGENTS"));

  let llmCalls = 0;
  const fakeLlm = {
    async complete() {
      llmCalls++;
      return { text: "summary", toolCalls: [] };
    },
  };
  const longHistory = Array.from({ length: 12 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    text: "history turn ".repeat(900),
  }));

  const compactBudget = await prepareContextBudget({
    modelContextWindow: 8192,
    systemPromptText: smallPrompt,
    mcpTools: [],
    pluginTools: [],
    boundTools: [],
    mountedSkillCatalog: [],
    metaContextInputs: [],
    history: longHistory,
    isSimple: false,
    llm: fakeLlm,
    isGeneral: false,
    compactModel: true,
    emit: () => {},
    onEvent: () => {},
  });
  assert.equal(compactBudget.outputReserve, 2048);
  assert.equal(llmCalls, 0);

  const bigBudget = await prepareContextBudget({
    modelContextWindow: 16_384,
    systemPromptText: bigPrompt,
    mcpTools: [],
    pluginTools: [],
    boundTools: [],
    mountedSkillCatalog: [],
    metaContextInputs: [],
    history: longHistory,
    isSimple: false,
    llm: fakeLlm,
    isGeneral: false,
    compactModel: false,
    emit: () => {},
    onEvent: () => {},
  });
  assert.equal(bigBudget.outputReserve, 8192);
  assert.equal(llmCalls, 1);
});

console.log(`compact-model-support: ${passed} checks passed`);
