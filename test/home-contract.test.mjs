import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Scratch Home workspace BEFORE imports — cleanupHomeGeneratorScripts reads
// getHomeRoot(), which honors NEXUS_HOME_ROOT.
const tempHome = path.join(os.tmpdir(), `nexus-test-home-contract-${Date.now()}`);
fs.mkdirSync(path.join(tempHome, ".nexus"), { recursive: true });
process.env.NEXUS_HOME_ROOT = tempHome;

const { inferHomeTaskContract, inferHomeOutputFormats, homeRequestNamesFileFormat } = await import("../dist-electron/agent-service.js");
const { cleanupHomeGeneratorScripts } = await import("../dist-electron/home-service.js");

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

console.log("\n=== Home Task Contract Tests ===");

await test("polite requests keep the output contract", () => {
  assert.equal(inferHomeTaskContract("Can you create a report about AI?").expectsOutput, true);
  assert.equal(inferHomeTaskContract("Could you make me a slide deck?").expectsOutput, true);
  assert.equal(inferHomeTaskContract("Would you write a cover letter for me?").expectsOutput, true);
  assert.equal(inferHomeTaskContract("Please prepare a budget spreadsheet").expectsOutput, true);
  assert.equal(inferHomeTaskContract("I need a budget spreadsheet").expectsOutput, true);
  assert.equal(inferHomeTaskContract("I need to create a PDF report").expectsOutput, true);
  assert.equal(inferHomeTaskContract("I want to write a Word document").expectsOutput, true);
  assert.equal(inferHomeTaskContract("Give me a one-page summary").expectsOutput, true);
});

await test("genuine questions never expect output", () => {
  assert.equal(inferHomeTaskContract("How do I create a bootable USB?").expectsOutput, false);
  assert.equal(inferHomeTaskContract("What is a pivot table?").expectsOutput, false);
  assert.equal(inferHomeTaskContract("Should I create a new branch?").expectsOutput, false);
  assert.equal(inferHomeTaskContract("I want to understand recursion").expectsOutput, false);
  assert.equal(inferHomeTaskContract("I need to know the capital of France").expectsOutput, false);
});

await test("research flag follows the request", () => {
  assert.equal(inferHomeTaskContract("Create a report on the latest AI models").needsResearch, true);
  assert.equal(inferHomeTaskContract("Create a report about my course notes").needsResearch, false);
});

await test("format-named requests are detectable for the chat-answer guardrail", () => {
  assert.equal(homeRequestNamesFileFormat("Create a report.docx about X"), true);
  assert.equal(homeRequestNamesFileFormat("Build a PowerPoint presentation"), true);
  assert.equal(homeRequestNamesFileFormat("Make me a spreadsheet for expenses"), true);
  assert.equal(homeRequestNamesFileFormat("Export the data as PDF"), true);
  assert.equal(homeRequestNamesFileFormat("Write a poem about autumn"), false);
  assert.equal(homeRequestNamesFileFormat("Explain quantum computing"), false);
});

await test("output contract extracts requested file formats without mistaking topic mentions", () => {
  assert.deepEqual(inferHomeOutputFormats("Create a PDF report about thermal storage"), ["pdf"]);
  assert.deepEqual(inferHomeOutputFormats("I need a budget spreadsheet"), ["xlsx"]);
  assert.deepEqual(inferHomeOutputFormats("Write a Word document and export a PDF version"), ["docx", "pdf"]);
  assert.deepEqual(inferHomeOutputFormats("Create a Markdown file called runbook.md"), ["md"]);
  assert.deepEqual(inferHomeOutputFormats("Create a report about PDF compression"), []);
  assert.deepEqual(inferHomeOutputFormats("Explain how to create a PDF"), []);
});

function writeFresh(name, content) {
  const abs = path.join(tempHome, name);
  fs.writeFileSync(abs, content ?? `content of ${name}`);
  const now = new Date();
  fs.utimesSync(abs, now, now);
}

await test("topic language mentions no longer block generator cleanup", async () => {
  writeFresh("make_slides.py");
  writeFresh("slides.pptx", "PK\u0003\u0004 fake pptx");
  const deleted = await cleanupHomeGeneratorScripts(Date.now() - 5000, "Make a presentation about Python");
  assert.ok(deleted.includes("make_slides.py"), "generator script removed despite 'Python' topic mention");
});

await test("script-as-deliverable requests still preserve fresh scripts", async () => {
  writeFresh("build_chart.py");
  writeFresh("chart_report.pdf", "%PDF-1.7 fake");
  const deleted = await cleanupHomeGeneratorScripts(Date.now() - 5000, "Write a python script that exports the chart");
  assert.equal(deleted.length, 0, "no scripts removed when the user asked for a script");
});

// Cleanup
delete process.env.NEXUS_HOME_ROOT;
fs.rmSync(tempHome, { recursive: true, force: true });

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);
