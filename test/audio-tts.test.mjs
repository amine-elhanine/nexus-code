// Tests for the neural TTS episode engine (Phase 2.1): graceful degradation
// without a provider, MP3 frame-header duration parsing, and spoken-text
// citation stripping.
import test from "node:test";
import assert from "node:assert/strict";

const { synthesizeAudioEpisode, mp3DurationMs, sanitizeAudioTurns } = await import("../dist-electron/notebook-audio.js");
const { localEmbed, singularToken, cosine } = await import("../dist-electron/notebook-embeddings.js");

test("mp3DurationMs: parses CBR frame headers into plausible durations", () => {
  // 128 kbps 44.1kHz Layer III frame = 417/418 bytes; 100 frames ≈ 2.6s.
  const frame = Buffer.alloc(417);
  frame[0] = 0xff; frame[1] = 0xfb; // MPEG1 Layer III, no CRC
  frame[2] = 0x90; // bitrate index 9 = 128kbps, 44.1kHz
  const bytes = Buffer.concat(Array.from({ length: 100 }, () => frame));
  const ms = mp3DurationMs(bytes);
  assert.ok(ms > 2000 && ms < 3200, `expected ~2.6s, got ${ms}ms`);
  // Garbage → conservative fallback, never NaN/negative.
  const fallback = mp3DurationMs(Buffer.alloc(48_000, 0x00));
  assert.ok(Number.isFinite(fallback) && fallback > 0);
});

test("synthesizeAudioEpisode: without a TTS provider the script overview is returned unchanged", async () => {
  const overview = {
    id: "audio-test-1", notebookId: "nb", title: "Test Episode", topic: "t",
    durationMinutes: 2, chapters: [], turns: [{ speaker: "Alex", text: "Hello from [S1] the deep dive.", citations: [] }],
    citations: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  const statuses = [];
  const result = await synthesizeAudioEpisode("nb", overview, {
    onStatus: (t) => statuses.push(t),
  });
  assert.equal(result, overview, "same object — no audio fields injected without a provider");
  assert.equal(result.audioFilename, undefined);
  assert.ok(statuses.some((s) => /TTS|browser voices/i.test(s)));
});

test("sanitizeAudioTurns: speaker normalization + citation markers", () => {
  const { turns } = sanitizeAudioTurns(
    { turns: [
      { speaker: "alex", text: "Welcome to [S1] the show.", chapter: "Intro" },
      { speaker: "Sam", text: "Great to be here." },
    ] },
    [{ index: 1, sourceName: "src.md", heading: "h" }]
  );
  assert.equal(turns.length, 2);
  assert.equal(turns[0].speaker, "Alex");
  assert.equal(turns[0].citations.length, 1);
});

// ---- 2.2: local embeddings — morphology + trigram hashing ------------------

test("localEmbed: morphological variants and typos score as related", async () => {
  const base = await localEmbed("The model indexes every document in the collection");
  const inflected = await localEmbed("The models indexed every document in the collections");
  const unrelated = await localEmbed("Julius Caesar crossed the Rubicon with his legion");
  const simRelated = cosine(base, inflected);
  const simUnrelated = cosine(base, unrelated);
  assert.ok(simRelated > simUnrelated, `inflected text (${simRelated.toFixed(3)}) should outrank unrelated (${simUnrelated.toFixed(3)})`);
  // Trigram sub-word signal: a typo of a content word still associates.
  const typo = await localEmbed("The model idnexes every document in the collection");
  assert.ok(cosine(base, typo) > 0.5, `typo association expected >0.5, got ${cosine(base, typo).toFixed(3)}`);
});

test("singularToken: folds plurals and gerunds without mangling short words", async () => {
  assert.equal(singularToken("models"), "model");
  assert.equal(singularToken("indexed"), "index");
  assert.equal(singularToken("indexing"), "index");
  assert.equal(singularToken("classes"), "class");
  assert.equal(singularToken("data"), "data");
  assert.equal(singularToken("status"), "status");
});
