// Phase 1 verification: notebook history roles, LSP CRLF edit application,
// SSRF-safe public fetch, zero-copy vector deserialization, and the
// out-of-process plugin sandbox.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { mkdirScratch } from "./helpers/scratch.mjs";

const { historyToChatMessages } = await import("../dist-electron/notebook-rag.js");
const { applyTextDocumentEdits } = await import("../dist-electron/lsp-service.js");
const { safePublicFetch, assertPublicHttpUrl } = await import("../dist-electron/net-guard.js");
const { loadVectorsSqlite, saveVectorsSqlite } = await import("../dist-electron/notebook-vectors-sqlite.js");
const { cosine, localEmbed } = await import("../dist-electron/notebook-embeddings.js");

// ---- 1.1: conversation history role mapping -------------------------------

test("history: assistant turns stay assistant messages (Anthropic alternation)", () => {
  const history = [
    { role: "user", text: "What is a quasar?" },
    { role: "assistant", text: "A quasar is an extremely luminous active galactic nucleus." },
    { role: "user", text: "How bright compared to the Milky Way?" },
  ];
  const messages = historyToChatMessages(history);
  assert.deepEqual(messages.map((m) => m.role), ["user", "assistant", "user"]);
  assert.match(messages[1].content, /active galactic nucleus/);
});

test("history: caps turns and truncates long texts to 4000 chars", () => {
  const history = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `turn ${i}` }));
  const messages = historyToChatMessages(history, 10);
  assert.equal(messages.length, 10);
  assert.equal(messages[0].content, "turn 20");
  const long = { role: "user", text: "x".repeat(5000) };
  assert.equal(historyToChatMessages([long])[0].content.length, 4000);
});

// ---- 1.2: LSP edit application preserves CRLF ------------------------------

const edit = (sl, sc, el, ec, newText) => ({
  range: { start: { line: sl, character: sc }, end: { line: el, character: ec } },
  newText,
});

test("applyTextDocumentEdits: CRLF files keep CRLF after rename", () => {
  const crlf = "export function alpha() {}\r\nexport const beta = 1;\r\n";
  const next = applyTextDocumentEdits(crlf, [edit(0, 16, 0, 21, "gamma")]);
  assert.ok(next.includes("\r\n"), "line endings preserved");
  assert.equal(next, "export function gamma() {}\r\nexport const beta = 1;\r\n");
  assert.ok(!next.slice(0, 30).includes("\n\ranymore"));
});

test("applyTextDocumentEdits: LF files stay LF; multi-line newText uses file EOL", () => {
  const lf = "const a = 1;\nconst b = 2;\n";
  const next = applyTextDocumentEdits(lf, [edit(0, 10, 0, 11, "12;\nconst c = 3; //")]);
  assert.equal(next, "const a = 12;\nconst c = 3; //;\nconst b = 2;\n");
  const crlf = "const a = 1;\r\nconst b = 2;\r\n";
  const nextCrlf = applyTextDocumentEdits(crlf, [edit(0, 10, 0, 11, "12;\r\nconst c = 3; //")]);
  assert.equal((nextCrlf.match(/(^|[^ \r])\n/g) || []).length, 0, "no bare LF in CRLF output");
  assert.equal(nextCrlf, "const a = 12;\r\nconst c = 3; //;\r\nconst b = 2;\r\n");
});

// ---- 1.3: SSRF guard on public fetch ---------------------------------------

test("safePublicFetch: blocks loopback, link-local metadata, and private ranges", async () => {
  for (const url of [
    "http://127.0.0.1:9222/json",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.5/internal",
    "http://192.168.1.10/router",
    "http://localhost:8080/",
  ]) {
    await assert.rejects(() => safePublicFetch(url), /local or private|valid URL|http\(s\)/, url);
  }
});

test("assertPublicHttpUrl: DNS resolving to a private range is rejected", async () => {
  const fakeResolve = async () => [{ address: "10.1.2.3", family: 4 }];
  await assert.rejects(() => assertPublicHttpUrl("https://rebind.example.com", fakeResolve), /local or private/);
  const okResolve = async () => [{ address: "93.184.216.34", family: 4 }];
  const url = await assertPublicHttpUrl("https://example.com", okResolve);
  assert.equal(url.hostname, "example.com");
});

test("renderPptx slide images: private-target image URLs are skipped, deck still renders", async (t) => {
  const dir = await mkdirScratch("nexus-net-guard-");
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { createDeliverable } = await import("../dist-electron/home-deliverables.js");
  const md = `# SSRF Probe Deck

## Private probe slide

- This image URL points at the cloud metadata service, which is link-local
- It must be skipped by the SSRF guard, never fetched, never embedded
- The deck itself must still render without the image
- Structural validation and content inspection continue as normal

![probe](http://169.254.169.254/latest/meta-data/illustration.png)

## Guarded rendering

- Every image URL from untrusted source documents passes safePublicFetch
- Loopback, private and link-local targets fail before any socket connects
- The deck completes with the remaining text content intact
- This is the defense-in-depth contract for generated presentations
`;
  const result = await createDeliverable({ projectRoot: dir, fileName: "probe.pptx", format: "pptx", content: md, request: "ssrf probe" });
  assert.equal(result.ok, true, result.message);
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(await fs.readFile(path.join(dir, "probe.pptx")));
  const media = Object.keys(zip.files).filter((n) => n.startsWith("ppt/media/") && !zip.files[n].dir);
  assert.equal(media.length, 0, "private-target image must NOT be embedded");
});

// ---- 1.4: zero-copy vector deserialization ---------------------------------

test("vectors: sqlite round-trip yields Float64Array views with identical cosine", async (t) => {
  const dir = await mkdirScratch("nexus-vectors-");
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const a = Array.from({ length: 16 }, (_, i) => Math.sin(i) * 0.5);
  const b = Array.from({ length: 16 }, (_, i) => Math.cos(i) * 0.25);
  await saveVectorsSqlite(dir, {
    sessionId: "s1",
    embeddingModel: "test-model",
    dims: 16,
    updatedAt: new Date().toISOString(),
    vectors: { chunkA: a, chunkB: b },
  });
  const partition = await loadVectorsSqlite(dir, "s1");
  assert.equal(partition.embeddingModel, "test-model");
  const va = partition.vectors.chunkA;
  assert.ok(va instanceof Float64Array, `expected Float64Array, got ${va?.constructor?.name}`);
  assert.deepEqual(Array.from(va), a);
  // cosine accepts typed arrays and plain arrays with identical results.
  const score1 = cosine(va, partition.vectors.chunkB);
  const score2 = cosine(a, b);
  assert.ok(Math.abs(score1 - score2) < 1e-12);
  // cosine is a raw dot product (vectors are normalized upstream); the
  // typed-array path must be numerically identical to the plain-array path.
  const selfDot = a.reduce((sum, v) => sum + v * v, 0);
  assert.ok(Math.abs(cosine(va, va) - selfDot) < 1e-9);
});

test("localEmbed: works and produces normalized vectors (hash fallback path)", async () => {
  const vec = await localEmbed("Fourier analysis decomposes signals into sinusoids");
  assert.equal(vec.length, 2048);
  let norm = 0;
  for (const v of vec) norm += v * v;
  assert.ok(Math.abs(Math.sqrt(norm) - 1) < 1e-6);
});

// ---- 1.5: out-of-process plugin sandbox ------------------------------------

test("plugin sandbox: malicious/broken entries fail honestly out-of-process", async () => {
  const dir = await mkdirScratch("nexus-plugin-sandbox-");
  try {
    await fs.writeFile(path.join(dir, "escape.js"), "require('child_process');", "utf8");
    const { runPluginEntrySandbox } = await import("../dist-electron/plugin-sandbox.js");
    const escapeResult = await runPluginEntrySandbox({ pluginDir: dir, entry: "../outside.js" });
    assert.equal(escapeResult.ok, false);
    assert.match(escapeResult.error || "", /escape/);

    await fs.writeFile(path.join(dir, "throw.js"), "throw new Error('boom at activation');", "utf8");
    const throwResult = await runPluginEntrySandbox({ pluginDir: dir, entry: "throw.js" });
    assert.equal(throwResult.ok, false);
    assert.match(throwResult.error || "", /boom/);
  } finally {
    await new Promise((r) => setTimeout(r, 400)); // child releases cwd on Windows
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}, { timeout: 30_000 });

test("plugin sandbox: a well-behaved entry registers tools out-of-process", async () => {
  const dir = await mkdirScratch("nexus-plugin-sandbox-");
  try {
    await fs.writeFile(
      path.join(dir, "good.js"),
      `nexus.registerTool({ name: "hello_tool", description: "says hello" });\nnexus.on("tool:before", () => ({}));\nnexus.log("activated");\n`,
      "utf8"
    );
    const { runPluginEntrySandbox } = await import("../dist-electron/plugin-sandbox.js");
    const result = await runPluginEntrySandbox({ pluginDir: dir, entry: "good.js" });
    assert.equal(result.ok, true, result.error);
    const methods = result.calls.map((c) => c.method);
    assert.ok(methods.includes("registerTool"), JSON.stringify(result.calls));
    assert.ok(methods.includes("on"));
    assert.ok(result.logs.includes("activated"));
    const tool = result.calls.find((c) => c.method === "registerTool");
    assert.equal(tool.args.name, "hello_tool");
  } finally {
    await new Promise((r) => setTimeout(r, 400)); // child releases cwd on Windows
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}, { timeout: 30_000 });
