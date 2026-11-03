// Tests for prompt caching across the chat-model factory (electron/providers.ts).
//
// Home and Code agent runs both go through runProjectAgent → createChatModel,
// so provider-level caching here covers both modes:
// - Anthropic Messages-API paths (native + Anthropic-protocol gateways on
//   /messages) carry a top-level `cache_control: {type:"ephemeral"}` request
//   field — the API applies an auto-advancing cache breakpoint, so the
//   tools + system prompt + prior-turns prefix is billed as cached tokens.
// - OpenAI-compatible paths must NOT carry the flag (they'd 400); OpenAI /
//   DeepSeek / GLM-family providers cache automatically provider-side.
import test from "node:test";
import assert from "node:assert/strict";

const { createChatModel } = await import("../dist-electron/providers.js");

async function invocationParamsFor(config, model, options) {
  const chat = await createChatModel(config, model, options);
  // invocationParams is the single funnel every ChatAnthropic request passes
  // through before hitting the API — inspect it rather than the wire.
  return chat.invocationParams({});
}

test("prompt caching: native anthropic requests carry cache_control ephemeral", async () => {
  const params = await invocationParamsFor(
    { id: "t1", provider: "anthropic", label: "Anthropic", apiKey: "sk-test" },
    "claude-sonnet-4-5"
  );
  assert.deepEqual(params.cache_control, { type: "ephemeral" });
});

test("prompt caching: anthropic-protocol gateway (/messages) carries cache_control too", async () => {
  const params = await invocationParamsFor(
    {
      id: "t2", provider: "custom", label: "Gateway", apiKey: "k",
      baseUrl: "https://gateway.example.com/anthropic",
      modelEndpoints: { "claude-via-gateway": "messages" },
    },
    "claude-via-gateway"
  );
  assert.deepEqual(params.cache_control, { type: "ephemeral" });
  // Still pointed at the gateway, not the native API.
  assert.equal(params.model, "claude-via-gateway");
});

test("prompt caching: chat-completions models stay flag-free (OpenAI-style APIs reject it)", async () => {
  const params = await invocationParamsFor(
    { id: "t3", provider: "custom", label: "OpenAI-compatible", apiKey: "k", baseUrl: "https://api.example.com/v1" },
    "some-openai-model"
  );
  assert.equal(params?.cache_control, undefined);
});

test("prompt caching: thinking mode keeps cache_control (cached prefix + thinking coexist)", async () => {
  const params = await invocationParamsFor(
    { id: "t4", provider: "anthropic", label: "Anthropic", apiKey: "sk-test" },
    "claude-sonnet-4-5",
    { reasoningEffort: "high" }
  );
  assert.deepEqual(params.cache_control, { type: "ephemeral" });
  assert.equal(params.thinking?.type, "enabled");
  // With thinking enabled the SDK may omit temperature from the request
  // (the API pins it to 1) — it must never be 0.x alongside thinking.
  if (params.temperature !== undefined) assert.equal(params.temperature, 1.0);
});
