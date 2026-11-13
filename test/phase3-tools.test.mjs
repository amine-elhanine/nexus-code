// Phase 3 verification: multi-backend web search adapters + routing, and the
// generate_image tool (backend resolution, filename sanitization, edit gate).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { mkdirScratch } from "./helpers/scratch.mjs";

const search = await import("../dist-electron/websearch-tool.js");
const {
  parseTavilyResponse, parseBraveResponse, parseExaResponse, parseSearxngResponse,
  webSearchWithFallback, duckDuckGoSearch,
} = search;
const { createImageGenTool, resolveImageGenBackend, generateImageBytes } = await import("../dist-electron/image-gen-tool.js");

// ---- 3.1: response parsers --------------------------------------------------

test("search parsers: tavily/brave/exa/searxng JSON shapes normalize", () => {
  const tavily = parseTavilyResponse({ results: [
    { title: "T result", url: "https://t.example.com/a", content: "snippet text" },
    { title: "bad", url: "not-a-url", content: "dropped" },
  ] }, 5);
  assert.equal(tavily.length, 1);
  assert.equal(tavily[0].url, "https://t.example.com/a");

  const brave = parseBraveResponse({ web: { results: [{ title: "B", url: "https://b.example.com", description: "desc" }] } }, 5);
  assert.equal(brave[0].snippet, "desc");

  const exa = parseExaResponse({ results: [{ title: "E", url: "https://e.example.com", text: "text body" }] }, 5);
  assert.equal(exa[0].title, "E");

  const searx = parseSearxngResponse({ results: [{ title: "S", url: "https://s.example.com", content: "content" }] }, 5);
  assert.equal(searx[0].snippet, "content");
});

test("webSearchWithFallback: explicit backend selection + graceful DDG fallback", async () => {
  // HERMETIC: stub outbound fetch so the routing assertions never depend on a
  // live DDG scrape. The parallel unit suite saw intermittent pipe-read
  // failures on this real-network test (it passed standalone every time —
  // the flake was environmental, not logical). A 200-with-no-results body
  // still exercises: backend routing → ddg, and the failing-tavily → ddg
  // fallback, without a socket.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url, opts) => {
    const target = String(url || "");
    if (/duckduckgo\.com/i.test(target)) {
      return new Response("<html><body>stub — no results</body></html>", { status: 200 });
    }
    if (/api\.tavily\.com/i.test(target)) {
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    }
    return realFetch(url, opts);
  });
  try {
    // No keys configured → DDG path (assertion is about routing, not results).
    const routed = await webSearchWithFallback("test query routing", 3, null, { backend: "auto" });
    assert.equal(routed.backend, "ddg");
    // Explicit backend with a key that will fail → falls back to DDG, never throws.
    const fallback = await webSearchWithFallback("test query routing", 3, null, {
      backend: "tavily", tavilyKey: "invalid-key-for-fallback-test",
    });
    assert.equal(fallback.backend, "ddg");
  } finally {
    globalThis.fetch = realFetch;
  }
}, { timeout: 30_000 });

// ---- 3.2: generate_image ----------------------------------------------------

test("image backend resolution: openai/google recognized, others null", () => {
  assert.equal(resolveImageGenBackend({ id: "x", label: "X", provider: "openai", apiKey: "sk-test", models: [] }).backend, "openai");
  assert.equal(resolveImageGenBackend({ id: "x", label: "X", provider: "google", apiKey: "g-key", models: [] }).backend, "google");
  assert.equal(resolveImageGenBackend({ id: "x", label: "X", provider: "ollama", models: [] }), null);
  assert.equal(resolveImageGenBackend({ id: "x", label: "X", provider: "openai", models: [] }), null, "no key → null");
});

test("generateImageBytes: openai b64_json payload decodes to PNG bytes", async () => {
  const png1x1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.model, "gpt-image-1");
    assert.ok(body.prompt.includes("watercolor"));
    return new Response(JSON.stringify({ data: [{ b64_json: png1x1.toString("base64") }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const result = await generateImageBytes("openai", {
      base: "https://api.openai.com/v1", apiKey: "sk", prompt: "a watercolor fox",
    });
    assert.equal(result.mimeType, "image/png");
    assert.ok(result.bytes.length > 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createImageGenTool: writes the image into the workspace + edit gate respected", async (t) => {
  const dir = await mkdirScratch("nexus-image-gen-");
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const png1x1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ b64_json: png1x1.toString("base64") }] }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const denied = createImageGenTool({ projectRoot: dir, provider: { id: "x", label: "X", provider: "openai", apiKey: "sk", models: [] }, beforeEdit: async () => "Edit denied by the user." });
    const denial = await denied.execute({ file_name: "pic.png", prompt: "a fox" });
    assert.match(String(denial), /denied/i);

    const gen = createImageGenTool({ projectRoot: dir, provider: { id: "x", label: "X", provider: "openai", apiKey: "sk", models: [] } });
    assert.ok(gen, "tool bound for openai provider");
    const result = await gen.execute({ file_name: "my-image", prompt: "a fox" });
    assert.match(String(result), /my-image\.png/);
    const stat = await fs.stat(path.join(dir, "my-image.png"));
    assert.ok(stat.size > 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
