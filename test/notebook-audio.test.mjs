import test from "node:test";
import assert from "node:assert/strict";

import { sanitizeAudioTurns } from "../dist-electron/notebook-audio.js";

test("notebook audio overview", async (t) => {
  await t.test("sanitizeAudioTurns enforces alternating Alex and Sam hosts and grounds citations", () => {
    const raw = {
      turns: [
        { speaker: "Alex", text: "Welcome to today's deep dive on quantum computing [S1]!", chapter: "Introduction" },
        { speaker: "Sam", text: "Glad to be here! Quantum superpositions change everything [S2]." },
        { speaker: "unknown_host", text: "And we also see decoherence effects [S1] and [S3]." },
      ],
    };

    const mockCitations = [
      { index: 1, sourceId: "src_1", sourceName: "Quantum101.pdf", chunkId: "c_1", excerpt: "Quantum basics", heading: "Intro", score: 1 },
      { index: 2, sourceId: "src_2", sourceName: "Superposition.txt", chunkId: "c_2", excerpt: "Superposition", heading: "Superposition", score: 1 },
    ];

    const { turns, chapters } = sanitizeAudioTurns(raw, mockCitations);

    assert.equal(turns.length, 3);
    assert.equal(turns[0].speaker, "Alex");
    assert.equal(turns[0].citations.length, 1);
    assert.equal(turns[0].citations[0].sourceName, "Quantum101.pdf");

    assert.equal(turns[1].speaker, "Sam");
    assert.equal(turns[1].citations.length, 1);
    assert.equal(turns[1].citations[0].sourceName, "Superposition.txt");

    // Host 3 defaults to Alex when unknown
    assert.equal(turns[2].speaker, "Alex");
    assert.equal(turns[2].citations.length, 1); // [S3] not in citations, only [S1] matches

    assert.equal(chapters.length, 1);
    assert.equal(chapters[0].title, "Introduction");
    assert.equal(chapters[0].turnIndex, 0);
  });

  await t.test("sanitizeAudioTurns falls back to top-level chapters when per-turn chapter is omitted", () => {
    const raw = {
      chapters: ["Part 1: Foundations", "Part 2: Applications"],
      turns: [
        { speaker: "Alex", text: "Let's start with the foundations." },
        { speaker: "Sam", text: "Yes, the fundamentals are key." },
        { speaker: "Alex", text: "Now moving to real-world applications." },
        { speaker: "Sam", text: "Here is where it gets practical." },
      ],
    };
    const { turns, chapters } = sanitizeAudioTurns(raw, []);
    assert.equal(turns.length, 4);
    assert.equal(chapters.length, 2);
    assert.equal(chapters[0].title, "Part 1: Foundations");
    assert.equal(chapters[0].turnIndex, 0);
    assert.equal(chapters[1].title, "Part 2: Applications");
    assert.equal(chapters[1].turnIndex, 2);
  });

  await t.test("sanitizeAudioTurns throws when turns array is missing", () => {
    assert.throws(() => sanitizeAudioTurns({}, []), /Audio overview JSON missing turns array/);
  });
});
