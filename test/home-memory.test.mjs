// Unit tests for home-memory-service
import assert from "node:assert/strict";
import {
  parseHomeMemory,
  formatHomeMemory,
  addMemoryFact,
  removeMemoryFact,
  recordDeliverable,
  isSubstantiveHomeTask,
  selectRelevantHomeMemory,
  parseCandidateFacts,
  shouldExtractMemory,
} from "../dist-electron/home-memory-service.js";

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (error) {
    console.error(`  ✗ ${name}`);
    console.error(error);
    failed++;
  }
}

console.log("\n=== Home Memory Service Tests ===");

await test("parseHomeMemory parses markdown sections correctly", () => {
  const raw = `
## User Profile
- Senior Python Developer
- Located in Paris

## Preferences
- Prefers concise code snippets
- Likes dark mode UI

## Project Context
- Working on Q3 financial report

## Recent Deliverables
- [2026-09-20] Created sales report
`;

  const parsed = parseHomeMemory(raw);
  assert.equal(parsed.profile.length, 2);
  assert.equal(parsed.profile[0], "Senior Python Developer");
  assert.equal(parsed.profile[1], "Located in Paris");
  assert.equal(parsed.preferences.length, 2);
  assert.equal(parsed.preferences[0], "Prefers concise code snippets");
  assert.equal(parsed.context.length, 1);
  assert.equal(parsed.context[0], "Working on Q3 financial report");
  assert.equal(parsed.recentDeliverables.length, 1);
  assert.equal(parsed.recentDeliverables[0].summary, "Created sales report");
});

await test("parseHomeMemory handles legacy 'Recent work' lines gracefully", () => {
  const legacy = `
Recent work (2026-09-21): build landing page → finished
Recent work (2026-09-22): summarize document → completed PDF summary
`;
  const parsed = parseHomeMemory(legacy);
  assert.equal(parsed.recentDeliverables.length, 2);
  assert.equal(parsed.recentDeliverables[0].date, "2026-09-21");
  assert.ok(parsed.recentDeliverables[0].summary.includes("build landing page"));
});

await test("addMemoryFact adds new items without duplicating existing ones", () => {
  let memory = "";
  memory = addMemoryFact(memory, "preference", "Prefers TypeScript");
  memory = addMemoryFact(memory, "preference", "Prefers TypeScript"); // duplicate
  memory = addMemoryFact(memory, "profile", "Data Scientist");

  const parsed = parseHomeMemory(memory);
  assert.equal(parsed.preferences.length, 1);
  assert.equal(parsed.preferences[0], "Prefers TypeScript");
  assert.equal(parsed.profile.length, 1);
  assert.equal(parsed.profile[0], "Data Scientist");
  assert.ok(memory.includes("## User Profile"));
  assert.ok(memory.includes("## Preferences"));
});

await test("removeMemoryFact removes matching facts across categories", () => {
  let memory = `
## Preferences
- Prefers TypeScript
- Prefers dark mode
`;
  // Exact-fact match: a partial query ("dark mode") must NOT delete the
  // whole "Prefers dark mode" entry anymore.
  memory = removeMemoryFact(memory, "Prefers dark mode");
  const parsed = parseHomeMemory(memory);
  assert.equal(parsed.preferences.length, 1);
  assert.equal(parsed.preferences[0], "Prefers TypeScript");
});

await test("recordDeliverable caps recent deliverables at 5", () => {
  let memory = "";
  for (let i = 1; i <= 8; i++) {
    memory = recordDeliverable(memory, `Task ${i}`, `Done ${i}`);
  }
  const parsed = parseHomeMemory(memory);
  assert.equal(parsed.recentDeliverables.length, 5);
  assert.ok(parsed.recentDeliverables[4].summary.includes("Task 8"));
  assert.ok(parsed.recentDeliverables[0].summary.includes("Task 4"));
});

await test("preserves custom unparsed user notes", () => {
  const raw = `
## User Profile
- Jane Doe

> Custom quote or personal notes that user manually typed in.
Some arbitrary paragraph.
`;
  const parsed = parseHomeMemory(raw);
  assert.equal(parsed.profile.length, 1);
  assert.ok(parsed.customNotes.includes("Custom quote"));

  const formatted = formatHomeMemory(parsed);
  assert.ok(formatted.includes("Jane Doe"));
  assert.ok(formatted.includes("Custom quote"));
});

await test("isSubstantiveHomeTask filters trivial chatter and keeps substantive tasks", () => {
  // Greetings
  assert.equal(isSubstantiveHomeTask("hi", "Hello! How can I help?", false), false);
  assert.equal(isSubstantiveHomeTask("good morning", "Good morning!", false), false);

  // Identity
  assert.equal(isSubstantiveHomeTask("who are you?", "I am Nexus Home.", false), false);

  // Resume / continue
  assert.equal(isSubstantiveHomeTask("continue", "Continuing from where we left off...", false), false);
  assert.equal(isSubstantiveHomeTask("ok", "Got it.", false), false);

  // Simple math
  assert.equal(isSubstantiveHomeTask("2 + 2", "4", false), false);

  // File action is always substantive
  assert.equal(isSubstantiveHomeTask("make file", "ok", true), true);

  // Substantive explanation / report
  const longResponse = "Here is a detailed breakdown of the quarterly revenue report with bullet points and thorough analysis across multiple sectors.";
  assert.equal(isSubstantiveHomeTask("analyze Q3 financials", longResponse, false), true);
});

await test("remembered facts round-trip separately from project context", () => {
  let memory = "";
  memory = addMemoryFact(memory, "fact", "GitHub login is L7A9");
  memory = addMemoryFact(memory, "context", "Working on Q3 financial report");
  const parsed = parseHomeMemory(memory);
  assert.equal(parsed.facts.length, 1);
  assert.equal(parsed.facts[0], "GitHub login is L7A9");
  assert.equal(parsed.context.length, 1);
  assert.ok(memory.includes("## Remembered Facts"));
  assert.ok(memory.includes("## Project Context"));
  const without = removeMemoryFact(memory, "GitHub login is L7A9");
  const reparsed = parseHomeMemory(without);
  assert.equal(reparsed.facts.length, 0);
  assert.equal(reparsed.context.length, 1);
  // A partial query removes nothing (exact-match semantics).
  const afterPartial = removeMemoryFact(memory, "L7A9");
  assert.equal(parseHomeMemory(afterPartial).facts.length, 1);
});

await test("recordDeliverable keeps the originating chat session", () => {
  const memory = recordDeliverable("", "Build slides", "Created deck", "homesess_abc123");
  const parsed = parseHomeMemory(memory);
  assert.equal(parsed.recentDeliverables.length, 1);
  assert.equal(parsed.recentDeliverables[0].sessionId, "homesess_abc123");
  // Format/parse round-trip preserves the link without duplicating it.
  const reparsed = parseHomeMemory(formatHomeMemory(parsed));
  assert.equal(reparsed.recentDeliverables[0].sessionId, "homesess_abc123");
  assert.equal(reparsed.recentDeliverables[0].summary, parsed.recentDeliverables[0].summary);
});

await test("selectRelevantHomeMemory always keeps profile, ranks the rest", () => {
  let memory = "";
  memory = addMemoryFact(memory, "profile", "Senior Python Developer");
  memory = addMemoryFact(memory, "fact", "GitHub login is L7A9");
  memory = addMemoryFact(memory, "fact", "Prefers dark roast coffee");
  memory = recordDeliverable(memory, "List github repos", "Listed 15 repos", "s1");
  const relevant = selectRelevantHomeMemory(memory, "list my github repos", 2000);
  assert.ok(relevant.includes("Senior Python Developer"));
  assert.ok(relevant.includes("L7A9"));
  assert.ok(!relevant.includes("dark roast coffee"));
});

await test("parseCandidateFacts accepts JSON, drops transient data", () => {
  const raw = JSON.stringify({
    candidates: [
      { category: "profile", fact: "Senior Python Developer based in Paris" },
      { category: "fact", fact: "| repo | stars |\n| a | 1 |" },
      { category: "preference", fact: "ok" },
      { category: "weird", fact: "Prefers concise summaries" },
    ],
  });
  const out = parseCandidateFacts(raw);
  assert.equal(out.length, 2);
  assert.equal(out[0].category, "profile");
  assert.equal(out[1].category, "fact");
  assert.equal(parseCandidateFacts("not json at all").length, 0);
});

await test("shouldExtractMemory fires on identity signals even with short replies", () => {
  assert.equal(shouldExtractMemory("my name is Amine, I am a master student in data science", "Nice to meet you, Amine!"), true);
  assert.equal(shouldExtractMemory("je m'appelle Amine", "Enchanté, Amine !"), true);
  assert.equal(shouldExtractMemory("hi", "Hello! How can I help?"), false);
  assert.equal(shouldExtractMemory("analyze Q3 financials", "Here is a detailed breakdown of the quarterly revenue report with thorough analysis across multiple sectors and regions."), true);
  assert.equal(shouldExtractMemory("what is 2+2", "4"), false);
  assert.equal(shouldExtractMemory("my name is Amine", ""), false);
});

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);
