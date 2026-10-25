import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  KNOWN_MODEL_EFFORTS,
  resolveModelEfforts,
  formatEffortLabel,
  autoDiscoverModelEfforts,
  KNOWN_MODEL_CONTEXT_WINDOWS,
  KNOWN_MODEL_MAX_OUTPUTS,
  resolveModelContextWindow,
  resolveModelMaxOutput,
  formatContextWindow,
  formatTokenCount,
  autoDiscoverModelContextWindow,
  computeCompactionThreshold,
} from "../dist-electron/providers.js";
import {
  isContextWindowError,
  estimateMessagesTokens,
  trimRunMessages,
  trimRunMessagesWithRecoveryBrief,
  StreamUsageTracker,
  estimateTokens,
} from "../dist-electron/context-service.js";

test("KNOWN_MODEL_EFFORTS defines supported efforts for reasoning models", () => {
  assert.deepEqual(KNOWN_MODEL_EFFORTS["o3"], ["low", "medium", "high"]);
  assert.deepEqual(KNOWN_MODEL_EFFORTS["o4-mini"], ["low", "medium", "high"]);
  assert.deepEqual(KNOWN_MODEL_EFFORTS["claude-opus-4-6"], ["low", "medium", "high", "max"]);
  assert.deepEqual(KNOWN_MODEL_EFFORTS["claude-3-7-sonnet"], ["low", "medium", "high", "max"]);
  assert.deepEqual(KNOWN_MODEL_EFFORTS["gemini-3.7-pro"], ["none", "low", "medium", "high"]);
  assert.deepEqual(KNOWN_MODEL_EFFORTS["deepseek-reasoner"], ["low", "medium", "high"]);
});

test("KNOWN_MODEL_CONTEXT_WINDOWS & KNOWN_MODEL_MAX_OUTPUTS define accurate token limits", () => {
  assert.equal(KNOWN_MODEL_CONTEXT_WINDOWS["claude-3-7-sonnet"], 200_000);
  assert.equal(KNOWN_MODEL_MAX_OUTPUTS["claude-3-7-sonnet"], 64_000);
  assert.equal(KNOWN_MODEL_CONTEXT_WINDOWS["gemini-2.5-pro"], 2_097_152);
  assert.equal(KNOWN_MODEL_CONTEXT_WINDOWS["nemotron-3.5-super-vl"], 1_048_576);
  assert.equal(KNOWN_MODEL_CONTEXT_WINDOWS["llama-3.3-70b-instruct"], 131_072);
});

test("resolveModelContextWindow and resolveModelMaxOutput resolve across hierarchy", () => {
  const customConfig = {
    id: "openrouter-1",
    provider: "openrouter",
    label: "OpenRouter",
    apiKey: "sk-or-123",
    models: ["custom-model", "o3"],
    modelContextWindows: {
      "custom-model": 500_000,
      "o3": 250_000,
    },
    modelMaxOutputs: {
      "custom-model": 32_000,
    },
  };

  // Provider config overrides
  assert.equal(resolveModelContextWindow("openrouter-1", "custom-model", customConfig), 500_000);
  assert.equal(resolveModelContextWindow("openrouter-1", "o3", customConfig), 250_000);
  assert.equal(resolveModelMaxOutput("openrouter-1", "custom-model", customConfig), 32_000);

  // Fallback to known heuristics
  assert.equal(resolveModelContextWindow("openai", "o3"), 200_000);
  assert.equal(resolveModelContextWindow("openrouter", "meta-llama/llama-3.3-70b-instruct"), 131_072);
  assert.equal(resolveModelContextWindow("anthropic", "claude-3-7-sonnet"), 200_000);
  assert.equal(resolveModelMaxOutput("anthropic", "claude-3-7-sonnet"), 64_000);

  // Default fallback for unrecognized models
  assert.equal(resolveModelContextWindow("custom", "unrecognized-model-123"), 128_000);
});

test("formatContextWindow and formatTokenCount produce concise human labels", () => {
  assert.equal(formatContextWindow(1_048_576), "1M");
  assert.equal(formatContextWindow(2_000_000), "2M");
  assert.equal(formatContextWindow(200_000), "200k");
  assert.equal(formatContextWindow(131_072), "128k");
  assert.equal(formatContextWindow(128_000), "128k");
  assert.equal(formatContextWindow(65_536), "64k");
  assert.equal(formatContextWindow(32_768), "32k");
  assert.equal(formatContextWindow(8_192), "8k");

  assert.equal(formatTokenCount(1_048_576), "1.05M");
  assert.equal(formatTokenCount(128_000), "128k");
  assert.equal(formatTokenCount(542), "542");
});

test("autoDiscoverModelContextWindow discovers context windows automatically", async () => {
  const openRouterConfig = {
    id: "openrouter-test",
    provider: "openrouter",
    label: "OpenRouter",
    apiKey: "sk-or-test",
    models: ["meta-llama/llama-3.3-70b-instruct", "anthropic/claude-3-7-sonnet"],
  };

  const llamaCtx = await autoDiscoverModelContextWindow(openRouterConfig, "meta-llama/llama-3.3-70b-instruct");
  assert.ok(llamaCtx.contextWindow >= 128_000);

  const sonnetCtx = await autoDiscoverModelContextWindow(openRouterConfig, "anthropic/claude-3-7-sonnet");
  assert.equal(sonnetCtx.contextWindow, 200_000);
});

test("resolveModelEfforts resolves correctly across configuration hierarchy", () => {
  // 1. Explicit provider config modelEfforts wins over definition & known
  const customConfig = {
    id: "openrouter-1",
    provider: "openrouter",
    label: "OpenRouter",
    apiKey: "sk-or-123",
    models: ["custom-model", "o3"],
    modelEfforts: {
      "custom-model": ["minimal", "standard", "extreme"],
      "o3": ["low", "high"], // Overrides o3 default
    },
  };

  assert.deepEqual(
    resolveModelEfforts("openrouter-1", "custom-model", customConfig),
    ["minimal", "standard", "extreme"]
  );
  assert.deepEqual(
    resolveModelEfforts("openrouter-1", "o3", customConfig),
    ["low", "high"]
  );

  // 2. Provider definition modelEfforts applies if not in provider config
  const providerDef = {
    id: "openai",
    label: "OpenAI",
    packageName: "@langchain/openai",
    envKey: "OPENAI_API_KEY",
    models: ["gpt-5.5", "gpt-4.1"],
    modelEfforts: {
      "gpt-5.5": ["none", "low", "medium", "high"],
    },
  };
  assert.deepEqual(
    resolveModelEfforts("openai", "gpt-5.5", undefined, providerDef),
    ["none", "low", "medium", "high"]
  );

  // 3. Fallback to KNOWN_MODEL_EFFORTS
  assert.deepEqual(
    resolveModelEfforts("openai", "o3-mini"),
    ["low", "medium", "high"]
  );
  assert.deepEqual(
    resolveModelEfforts("openrouter", "openai/o3-mini"),
    ["low", "medium", "high"],
    "basename with slash prefix resolves known efforts"
  );

  // 4. Non-reasoning models return empty array so UI does not show effort dropdown
  assert.deepEqual(
    resolveModelEfforts("openai", "gpt-4.1"),
    [],
    "gpt-4.1 does not support effort and returns empty array"
  );
  assert.deepEqual(
    resolveModelEfforts("mistral", "mistral-large-latest"),
    [],
    "mistral-large-latest returns empty array"
  );
  assert.deepEqual(
    resolveModelEfforts("custom", "llama3.3"),
    [],
    "unconfigured model returns empty array"
  );
});

test("formatEffortLabel formats raw effort strings for user-friendly UI display", () => {
  assert.equal(formatEffortLabel("none"), "None (Disabled)");
  assert.equal(formatEffortLabel("low"), "Low");
  assert.equal(formatEffortLabel("medium"), "Medium");
  assert.equal(formatEffortLabel("high"), "High");
  assert.equal(formatEffortLabel("max"), "Max");
  assert.equal(formatEffortLabel("xhigh"), "Extra High");
  assert.equal(formatEffortLabel("minimal"), "Minimal");
});

test("autoDiscoverModelEfforts discovers reasoning efforts automatically", async () => {
  const openAIConfig = {
    id: "openai-test",
    provider: "openai",
    label: "OpenAI",
    apiKey: "sk-test",
    models: ["o3", "gpt-4.1", "o4-mini"],
  };

  // Known reasoning models return their supported efforts automatically
  const o3Efforts = await autoDiscoverModelEfforts(openAIConfig, "o3");
  assert.deepEqual(o3Efforts, ["low", "medium", "high"]);

  const o4MiniEfforts = await autoDiscoverModelEfforts(openAIConfig, "o4-mini");
  assert.deepEqual(o4MiniEfforts, ["low", "medium", "high"]);

  // Namespaced reasoning model
  const openRouterConfig = {
    id: "openrouter-test",
    provider: "openrouter",
    label: "OpenRouter",
    apiKey: "sk-or-test",
    models: ["anthropic/claude-3-7-sonnet"],
  };
  const sonnetEfforts = await autoDiscoverModelEfforts(openRouterConfig, "anthropic/claude-3-7-sonnet");
  assert.deepEqual(sonnetEfforts, ["low", "medium", "high", "max"]);

  // Standard non-reasoning models return [] so UI effort dropdown is hidden
  const gpt4Efforts = await autoDiscoverModelEfforts(openAIConfig, "gpt-4.1");
  assert.deepEqual(gpt4Efforts, []);

  const standardModel = await autoDiscoverModelEfforts(
    { id: "custom", provider: "custom", label: "Custom", models: ["meta-llama/llama-3-8b-instruct"] },
    "meta-llama/llama-3-8b-instruct"
  );
  assert.deepEqual(standardModel, []);

  const unknownModel = await autoDiscoverModelEfforts(
    { id: "custom", provider: "custom", label: "Custom", models: ["non-existent-model-xyz"] },
    "non-existent-model-xyz"
  );
  assert.deepEqual(unknownModel, []);
});

test("store CRUD persists model reasoning efforts and context windows, and preserves them on rename", async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-effort-test-"));
  process.env.APPDATA = scratch;
  const {
    createProviderConnection,
    addProviderModels,
    updateProviderModel,
    removeProviderModel,
  } = await import("../dist-electron/store.js");

  try {
    const provider = await createProviderConnection({
      provider: "openrouter",
      label: "OpenRouter",
      apiKey: "sk-or-test",
    });

    // Add models with discovered or configured efforts and context windows
    const withModels = await addProviderModels(
      provider.id,
      ["openai/o3", "google/gemini-2.5-flash"],
      {
        "openai/o3": ["low", "medium", "high"],
        "google/gemini-2.5-flash": ["none", "low", "medium", "high"],
      },
      {
        "openai/o3": 200_000,
        "google/gemini-2.5-flash": 1_048_576,
      },
      {
        "openai/o3": 100_000,
        "google/gemini-2.5-flash": 65_536,
      }
    );

    assert.deepEqual(withModels.models, ["openai/o3", "google/gemini-2.5-flash"]);
    assert.deepEqual(withModels.modelEfforts?.["openai/o3"], ["low", "medium", "high"]);
    assert.deepEqual(withModels.modelEfforts?.["google/gemini-2.5-flash"], ["none", "low", "medium", "high"]);
    assert.equal(withModels.modelContextWindows?.["openai/o3"], 200_000);
    assert.equal(withModels.modelContextWindows?.["google/gemini-2.5-flash"], 1_048_576);
    assert.equal(withModels.modelMaxOutputs?.["openai/o3"], 100_000);
    assert.equal(withModels.modelMaxOutputs?.["google/gemini-2.5-flash"], 65_536);

    // Update context & effort for an existing model
    const updatedModel = await updateProviderModel(provider.id, "openai/o3", {
      efforts: ["low", "high", "max"],
      contextWindow: 250_000,
      maxOutput: 120_000,
    });
    assert.deepEqual(updatedModel.modelEfforts?.["openai/o3"], ["low", "high", "max"]);
    assert.equal(updatedModel.modelContextWindows?.["openai/o3"], 250_000);
    assert.equal(updatedModel.modelMaxOutputs?.["openai/o3"], 120_000);

    // Rename model preserves efforts, context windows and max outputs
    const renamed = await updateProviderModel(provider.id, "openai/o3", {
      newName: "openai/o3-custom",
    });
    assert.ok(renamed.models.includes("openai/o3-custom"));
    assert.ok(!renamed.models.includes("openai/o3"));
    assert.deepEqual(renamed.modelEfforts?.["openai/o3-custom"], ["low", "high", "max"]);
    assert.equal(renamed.modelEfforts?.["openai/o3"], undefined);
    assert.equal(renamed.modelContextWindows?.["openai/o3-custom"], 250_000);
    assert.equal(renamed.modelContextWindows?.["openai/o3"], undefined);
    assert.equal(renamed.modelMaxOutputs?.["openai/o3-custom"], 120_000);
    assert.equal(renamed.modelMaxOutputs?.["openai/o3"], undefined);

    // Remove model cleans up its efforts, context windows and max outputs
    const removed = await removeProviderModel(provider.id, "openai/o3-custom");
    assert.ok(!removed.models.includes("openai/o3-custom"));
    assert.equal(removed.modelEfforts?.["openai/o3-custom"], undefined);
    assert.equal(removed.modelContextWindows?.["openai/o3-custom"], undefined);
    assert.equal(removed.modelMaxOutputs?.["openai/o3-custom"], undefined);
    assert.deepEqual(removed.modelEfforts?.["google/gemini-2.5-flash"], ["none", "low", "medium", "high"]);
    assert.equal(removed.modelContextWindows?.["google/gemini-2.5-flash"], 1_048_576);

    // Verify persisted state on disk
    const stateFile = path.join(scratch, "nexus", "nexus-state.json");
    const onDisk = JSON.parse(await fs.readFile(stateFile, "utf8"));
    const diskProvider = onDisk.providers.find((p) => p.id === provider.id);
    assert.deepEqual(diskProvider.modelEfforts?.["google/gemini-2.5-flash"], ["none", "low", "medium", "high"]);
    assert.equal(diskProvider.modelContextWindows?.["google/gemini-2.5-flash"], 1_048_576);
    assert.equal(diskProvider.modelMaxOutputs?.["google/gemini-2.5-flash"], 65_536);
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
});

test("computeCompactionThreshold calculates dynamic 80% auto-compaction boundaries like Claude Code & Codex", () => {
  // 1. Claude 3.7 Sonnet (200k context, 64k max output)
  // Reserves 64k output + 4k headroom = 68k reserve -> 132k threshold
  const claudeThreshold = computeCompactionThreshold(200_000, 64_000);
  assert.equal(claudeThreshold, 132_000);

  // 2. GPT-4o / GPT-4.1 (128k context, 16k max output)
  // 80% of 128k = 102,400 tokens
  const gptThreshold = computeCompactionThreshold(128_000, 16_384);
  assert.equal(gptThreshold, 102_400);

  // 3. Gemini 2.5 Flash / Pro (1M context)
  // 80% of 1,048,576 = 838,860 tokens
  const geminiThreshold = computeCompactionThreshold(1_048_576, 65_536);
  assert.equal(geminiThreshold, 838_860);

  // 4. Smaller local models (32k context, 4k max output)
  const smallThreshold = computeCompactionThreshold(32_768, 4_096);
  assert.equal(smallThreshold, 24_672);

  // 5. Minimal fallbacks
  const defaultThreshold = computeCompactionThreshold(128_000);
  assert.equal(defaultThreshold, 102_400);
});

test("isContextWindowError matches every provider shape and rejects transient/other errors", () => {
  // OpenAI: "maximum context length" 400 invalid_request_error
  assert.equal(isContextWindowError(new Error("This model's maximum context length is 16385 tokens. However, you requested 20000 tokens.")), true);
  assert.equal(isContextWindowError(new Error("context_length_exceeded: reduce the length of the conversation")), true);
  // Anthropic: prompt too long
  assert.equal(isContextWindowError(new Error("prompt is too long: 200000 tokens > 128000 token maximum")), true);
  assert.equal(isContextWindowError(new Error({ name: "APIError", code: "prompt_too_long" })), false); // non-Error object with plain string coercion
  assert.equal(isContextWindowError({ name: "APIError", code: "prompt_too_long", status: 400 }), true);
  // Gemini: input token count exceeds maximum
  assert.equal(isContextWindowError(new Error("The input token count (300000) exceeds the maximum number of tokens allowed (200000)")), true);
  // Gateway/status shapes
  assert.equal(isContextWindowError({ status: 413 }), true);
  assert.equal(isContextWindowError(new Error("payload too large")), true);
  // Transient and unrelated errors must NOT be treated as context overflows
  assert.equal(isContextWindowError(new Error("429 rate limit exceeded; please retry")), false);
  assert.equal(isContextWindowError(new Error("socket hang up")), false);
  assert.equal(isContextWindowError(new Error("ECONNRESET")), false);
  assert.equal(isContextWindowError(null), false);
  assert.equal(isContextWindowError(undefined), false);
});

test("estimateMessagesTokens counts content, tool-call args and image payloads", () => {
  const human = { type: "human", content: "x".repeat(3800) };
  const ai = { type: "ai", content: "hello world", tool_calls: [{ name: "read_file", args: { file_path: "a".repeat(190) } }] };
  const multimodal = { type: "human", content: [{ type: "text", text: "desc" }, { type: "image_url", image_url: { url: "data:image/png;base64,iVBOR" } }] };
  const humanEstimate = estimateMessagesTokens([human]);
  assert.equal(humanEstimate, Math.ceil(3800 / 3.8));
  // AI tokens = text content + serialized args + per-call overhead
  const aiEstimate = estimateMessagesTokens([ai]);
  assert.ok(aiEstimate >= Math.ceil(("hello world".length + "a".repeat(190).length) / 3.8));
  const mmEstimate = estimateMessagesTokens([multimodal]);
  assert.ok(mmEstimate >= estimateTokens("desc") + estimateTokens("data:image/png;base64,iVBOR"));
  assert.equal(estimateMessagesTokens([null, { content: "" }]), 0);
});

test("trimRunMessages keeps the original request, preserves tool pairs and honors the budget", () => {
  const small = (text) => ({ type: "human", content: `/build ${text}` });
  const giant = (chars) => ({ type: "tool", content: "x".repeat(chars) });
  // Pair: AI-with-calls must move together with its tool result.
  const messages = [
    { type: "human", content: "Build feature X with Y and Z constraints" },
    { type: "ai", content: "Reading the repo", tool_calls: [{ name: "read_file", args: { file_path: "src/a.ts" } }] },
    giant(20_000),
    { type: "ai", content: "Now editing" },
    { type: "ai", content: "second plan", tool_calls: [{ name: "execute", args: { command: "npm test" } }] },
    giant(20_000),
    { type: "human", content: "iterate further" },
    { type: "ai", content: "more work", tool_calls: [{ name: "write_file", args: { file_path: "src/b.ts" } }] },
    giant(8_000),
    { type: "ai", content: "final check", tool_calls: [{ name: "read_file", args: { file_path: "src/b.ts" } }] },
    giant(8_000),
    { type: "ai", content: "done text" },
  ];

  const budget = 30_000;
  const result = trimRunMessages(messages, budget);
  // Under budget after condensation
  assert.ok(estimateMessagesTokens(result) <= budget, "result should fit the budget");
  // Never an orphan tool result at the start, and pairs stay adjacent
  assert.equal(result[0].type, "human");
  const summaryText = String(result[0].content);
  assert.ok(summaryText.includes("Condensed earlier work"), "condensation digest must be present");
  assert.ok(summaryText.includes("Build feature X"), "the original request must be preserved in the digest");
  for (let i = 1; i < result.length; i++) {
    if (result[i].type === "ai" && Array.isArray(result[i].tool_calls) && result[i].tool_calls.length) {
      assert.equal(result[i + 1]?.type, "tool", "an AI message with tool calls must be followed by its tool result");
    }
    if (result[i].type === "tool") {
      assert.ok(Array.isArray(result[i - 1]?.tool_calls), "a tool result must never appear without its AI call message");
    }
  }
  // Condensation actually freed room (strictly smaller than the input)
  assert.ok(estimateMessagesTokens(result) < estimateMessagesTokens(messages));
});

test("run compaction preserves the structured recovery brief and complete tool-call pairs", () => {
  const messages = [
    { type: "human", content: "Implement feature Q; preserve API compatibility and add tests" },
    { type: "ai", content: "Inspecting files", tool_calls: [{ id: "call-1", name: "read_file", args: { path: "src/q.ts" } }] },
    { type: "tool", tool_call_id: "call-1", content: "x".repeat(20_000) },
    { type: "ai", content: "Implementing changes" },
    { type: "ai", content: "Running checks", tool_calls: [{ id: "call-2", name: "execute", args: { command: "npm test" } }] },
    { type: "tool", tool_call_id: "call-2", content: "y".repeat(20_000) },
  ];
  const brief = [
    "[Durable Code Task Recovery Brief]",
    "Original request/constraints: Implement feature Q; preserve API compatibility and add tests",
    "Next step: Run the targeted test and inspect its result",
    "Changed files: src/q.ts",
    "Latest verification: npm test failed with assertion mismatch",
  ].join("\n");
  const compacted = trimRunMessagesWithRecoveryBrief(messages, brief, 5000);
  const allText = compacted.map((message) => String(message.content ?? "")).join("\n");
  assert.match(allText, /Durable Code Task Recovery Brief/);
  assert.match(allText, /preserve API compatibility/);
  assert.match(allText, /npm test failed with assertion mismatch/);
  assert.ok(estimateMessagesTokens(compacted) <= 5000);
  for (let i = 1; i < compacted.length; i++) {
    if (compacted[i]?.type === "tool") {
      assert.ok(Array.isArray(compacted[i - 1]?.tool_calls), "compaction must not orphan a tool result");
    }
  }
});

test("StreamUsageTracker.lastObservedInputTokens tracks the largest single-call input", () => {
  const tracker = new StreamUsageTracker();
  tracker.noteChunk({ usage_metadata: { input_tokens: 1200, output_tokens: 40 } });
  assert.equal(tracker.lastObservedInputTokens, 1200);
  tracker.noteChunk({ response_metadata: { tokenUsage: { promptTokens: 5000, completionTokens: 30 } } });
  assert.equal(tracker.lastObservedInputTokens, 5000);
  // Repeated cumulative chunks under one id must not inflate the max
  tracker.noteChunk({ id: "msg-1", usage_metadata: { input_tokens: 6000, output_tokens: 10 } });
  tracker.noteChunk({ id: "msg-1", usage_metadata: { input_tokens: 6100, output_tokens: 15 } });
  assert.equal(tracker.lastObservedInputTokens, 6100);
  // Empty usage payloads are ignored
  tracker.noteChunk({ usage_metadata: {} });
  assert.equal(tracker.lastObservedInputTokens, 6100);
});
