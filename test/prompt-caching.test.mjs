// Tests for the provider adapters' wire-request shapes (agentcore/llm).
//
// Home and Code agent runs both go through createChatModel → adapters, so
// provider-level behavior here covers both modes:
// - Anthropic Messages-API paths (native + Anthropic-protocol gateways on
//   /messages) carry a top-level `cache_control: {type:"ephemeral"}` request
//   field — the API applies an auto-advancing cache breakpoint, so the
//   tools + system prompt + prior-turns prefix is billed as cached tokens.
// - OpenAI-compatible paths must NOT carry the flag (they'd 400); OpenAI /
//   DeepSeek / GLM-family providers cache automatically provider-side.
// - Thinking mode coexists with cache_control and pins temperature to 1.0.
import test from "node:test";
import assert from "node:assert/strict";

const { buildAnthropicRequestBody } = await import("../dist-electron/agentcore/llm/anthropic.js");
const { createOpenAICompatClient } = await import("../dist-electron/agentcore/llm/openai-compat.js");
const { userMsg } = await import("../dist-electron/agentcore/messages.js");

test("prompt caching: native anthropic requests carry cache_control ephemeral", () => {
  const body = buildAnthropicRequestBody(
    { messages: [userMsg("hello")] },
    { providerId: "anthropic", label: "Anthropic", model: "claude-sonnet-4-5", apiKey: "sk-test" }
  );
  assert.deepEqual(body.cache_control, { type: "ephemeral" });
  assert.equal(body.model, "claude-sonnet-4-5");
});

test("prompt caching: anthropic-protocol gateway adapter is provider-agnostic (baseUrl applied at the client)", async () => {
  // Gateway routing is resolved by the factory; the body builder always
  // carries the cache flag because only Messages-API paths reach it.
  const { createChatClient } = await import("../dist-electron/agentcore/llm/factory.js");
  const client = await createChatClient(
    {
      id: "t2", provider: "custom", label: "Gateway", apiKey: "k",
      baseUrl: "https://gateway.example.com/anthropic",
      modelEndpoints: { "claude-via-gateway": "messages" },
    },
    "claude-via-gateway"
  );
  assert.equal(client.providerId, "t2");
  assert.equal(client.model, "claude-via-gateway");
  const body = buildAnthropicRequestBody(
    { messages: [userMsg("hello")] },
    { providerId: "t2", label: "Gateway", model: "claude-via-gateway", apiKey: "k", baseUrl: "https://gateway.example.com/anthropic" }
  );
  assert.deepEqual(body.cache_control, { type: "ephemeral" });
  assert.equal(body.model, "claude-via-gateway");
});

test("prompt caching: chat-completions bodies stay flag-free (OpenAI-style APIs reject it)", async () => {
  // Intercept the outbound request: the openai-compat adapter must not add
  // cache_control to the JSON body.
  let captured = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    captured = JSON.parse(init.body);
    return new Response('data: {"choices":[{"finish_reason":"stop","delta":{"content":"ok"}}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\ndata: [DONE]\n', {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  try {
    const client = createOpenAICompatClient({
      providerId: "t3", label: "OpenAI-compatible", apiKey: "k", model: "some-openai-model",
      baseUrl: "https://api.example.com/v1",
    });
    for await (const event of client.stream({ messages: [userMsg("hi")] })) {
      if (event.type === "done") break;
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(captured, "request captured");
  assert.equal(captured.cache_control, undefined);
  assert.equal(captured.model, "some-openai-model");
});

test("prompt caching: thinking mode keeps cache_control (cached prefix + thinking coexist)", () => {
  const body = buildAnthropicRequestBody(
    { messages: [userMsg("hello")], reasoningEffort: "high" },
    { providerId: "anthropic", label: "Anthropic", model: "claude-sonnet-4-5", apiKey: "sk-test" }
  );
  assert.deepEqual(body.cache_control, { type: "ephemeral" });
  assert.equal(body.thinking?.type, "enabled");
  // With thinking enabled the API pins temperature to 1 — never 0.x alongside thinking.
  assert.equal(body.temperature, 1.0);
  // max_tokens must exceed the thinking budget.
  assert.ok(Number(body.max_tokens) > body.thinking.budget_tokens);
});
