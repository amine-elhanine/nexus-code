import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { mkdirScratch } from "./helpers/scratch.mjs";

const { runAgentLoop, StepBudgetExceededError } = await import("../dist-electron/agentcore/loop.js");
const { userMsg } = await import("../dist-electron/agentcore/messages.js");
const { loopPreventionMiddleware } = await import("../dist-electron/loop-prevention.js");
const {
  addMemoryFact,
  parseHomeMemory,
  formatHomeMemory,
  removeMemoryFactWithCount,
  selectRelevantHomeMemory,
  searchMemoryFacts,
  createHomeMemoryTool,
  parseCandidateFacts,
} = await import("../dist-electron/home-memory-service.js");
const {
  createLearnSkillTool,
  deriveDeterministicLessons,
  shouldExtractCodeMemory,
  buildSelfImprovementExtractionPrompt,
} = await import("../dist-electron/agent/self-improvement.js");
const { expandSlashCommand } = await import("../dist-electron/custom-commands-service.js");
const { discoverProjectInstructions } = await import("../dist-electron/project-instructions.js");
const { buildSystemPrompt, inferHomeTaskContract } = await import("../dist-electron/agent-prompt.js");
const { listSkills } = await import("../dist-electron/skills-service.js");
const JSZip = (await import("jszip")).default;
const { inspectDeliverable, createInspectArtifactTool } = await import("../dist-electron/deliverable-inspect.js");
const { validateHomeArtifact } = await import("../dist-electron/home-artifact-service.js");

async function drainLoop(gen) {
  for (;;) {
    const next = await gen.next();
    if (next.done) return next.value;
  }
}

test("1. runAgentLoop executes past 25+ steps when stepBudget is omitted or Infinity, and still enforces explicit finite budgets", async () => {
  let stepIndex = 0;
  const mockTool = {
    name: "work_step",
    description: "performs a work step",
    parameters: { type: "object", properties: { n: { type: "number" } } },
    execute: async (args) => `completed-${args.n}`,
  };
  const multiStepClient = {
    async *stream() {
      stepIndex++;
      if (stepIndex <= 25) {
        const call = { id: `call_${stepIndex}`, name: "work_step", args: { n: stepIndex } };
        yield { type: "done", text: "", toolCalls: [call], stopReason: "tool" };
        return;
      }
      yield { type: "text", delta: "All 25 steps finished cleanly." };
      yield { type: "done", text: "All 25 steps finished cleanly.", toolCalls: [], stopReason: "stop" };
    },
  };

  const result = await drainLoop(
    runAgentLoop({
      client: multiStepClient,
      messages: [userMsg("Run 25 autonomous steps")],
      tools: [mockTool],
      stepBudget: Infinity,
    })
  );
  assert.equal(stepIndex, 26);
  assert.equal(result.answer, "All 25 steps finished cleanly.");

  // Explicit finite budget still throws StepBudgetExceededError
  let finiteCalls = 0;
  const infiniteClient = {
    async *stream() {
      finiteCalls++;
      const call = { id: `c_${finiteCalls}`, name: "work_step", args: { n: finiteCalls } };
      yield { type: "done", text: "", toolCalls: [call], stopReason: "tool" };
    },
  };
  await assert.rejects(
    () =>
      drainLoop(
        runAgentLoop({
          client: infiniteClient,
          messages: [userMsg("Keep going")],
          tools: [mockTool],
          stepBudget: 3,
        })
      ),
    (err) => err instanceof StepBudgetExceededError
  );
});

test("2. runAgentLoop shouldContinue keeps the agent working in-loop until task is finished", async () => {
  let turn = 0;
  let toolExecs = 0;
  const tool = {
    name: "apply_fix",
    description: "apply a fix",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      toolExecs++;
      return "fixed";
    },
  };
  const client = {
    async *stream() {
      turn++;
      if (turn === 1) {
        // Model stops with forward narration and no tool calls
        yield { type: "text", delta: "Now I will apply the fix." };
        yield { type: "done", text: "Now I will apply the fix.", toolCalls: [], stopReason: "stop" };
        return;
      }
      if (turn === 2) {
        yield { type: "done", text: "", toolCalls: [{ id: "t2", name: "apply_fix", args: {} }], stopReason: "tool" };
        return;
      }
      yield { type: "text", delta: "Fix applied and verified." };
      yield { type: "done", text: "Fix applied and verified.", toolCalls: [], stopReason: "stop" };
    },
  };

  const res = await drainLoop(
    runAgentLoop({
      client,
      messages: [userMsg("Fix the issue")],
      tools: [tool],
      stepBudget: Infinity,
      shouldContinue: ({ text }) => (text.includes("I will apply the fix") ? "Do not narrate — call apply_fix now." : null),
    })
  );
  assert.equal(turn, 3);
  assert.equal(toolExecs, 1);
  assert.equal(res.answer, "Fix applied and verified.");
});

test("3. loopPreventionMiddleware({ autonomous: true }) lifts lookup & churn cutoffs while preserving per-target repeat bans", async () => {
  const middleware = loopPreventionMiddleware({ general: true, outputRequired: true, autonomous: true });
  const handler = async () => ({ content: "ok" });

  // 30 distinct web searches must all execute without hitting 8 or 20 lookup caps
  for (let i = 1; i <= 30; i++) {
    const res = await middleware.wrapToolCall(
      { call: { id: `ws_${i}`, name: "web_search", args: { query: `unique query ${i}` } }, toolCallId: `ws_${i}` },
      handler
    );
    assert.ok(!String(res?.content ?? res).includes("SUPERVISOR INTERVENTION"), `query ${i} should not hit research budget`);
  }

  // >5 edits to same file allowed in autonomous mode (threshold raised to 25)
  for (let i = 1; i <= 8; i++) {
    const res = await middleware.wrapToolCall(
      { call: { id: `ed_${i}`, name: "edit_file", args: { file_path: "src/app.ts" } }, toolCallId: `ed_${i}` },
      handler
    );
    assert.ok(!String(res?.content ?? res).includes("EDIT/EXECUTION CHURN DETECTED"), `edit ${i} should be allowed`);
  }

  // Exact same URL repeated 3x still gets banned per-target
  await middleware.wrapToolCall({ call: { id: "u1", name: "browser_inspect", args: { url: "https://example.com/stuck" } }, toolCallId: "u1" }, handler);
  await middleware.wrapToolCall({ call: { id: "u2", name: "browser_inspect", args: { url: "https://example.com/stuck" } }, toolCallId: "u2" }, handler);
  const third = await middleware.wrapToolCall({ call: { id: "u3", name: "browser_inspect", args: { url: "https://example.com/stuck" } }, toolCallId: "u3" }, handler);
  assert.ok(String(third?.content ?? third).includes("RESEARCH TARGET BANNED"));
});

test("4. Structured memory supports lesson category, active search/list recall, and exact forget", async () => {
  let mem = "";
  const tool = createHomeMemoryTool({
    onRemember: (cat, fact) => {
      mem = addMemoryFact(mem, cat, fact);
    },
    onForget: (query) => {
      const res = removeMemoryFactWithCount(mem, query);
      mem = res.memory;
      return res.removed;
    },
    onRead: () => mem,
  });

  await tool.execute({ action: "remember", category: "lesson", fact: "Always use npm.cmd instead of npm on restricted Windows PowerShell" });
  await tool.execute({ action: "remember", category: "fact", fact: "Backend tests live in test/*.test.mjs" });

  assert.ok(mem.includes("## Learned Patterns & Lessons"));
  const parsed = parseHomeMemory(mem);
  assert.deepEqual(parsed.lessons, ["Always use npm.cmd instead of npm on restricted Windows PowerShell"]);

  const searchRes = await tool.execute({ action: "search", fact: "PowerShell" });
  assert.ok(searchRes.includes("npm.cmd"));
  assert.ok(!searchRes.includes("test/*.test.mjs"));

  const listRes = await tool.execute({ action: "list" });
  assert.ok(listRes.includes("## Learned Patterns & Lessons"));
  assert.ok(listRes.includes("Backend tests live in test/*.test.mjs"));

  const relevant = selectRelevantHomeMemory(mem, "run build", 2000);
  assert.ok(relevant.includes("## Learned Patterns & Lessons"));
  assert.ok(relevant.includes("npm.cmd"));

  // parseCandidateFacts accepts lesson category and up to 4 candidates
  const candidates = parseCandidateFacts(
    JSON.stringify({
      candidates: [
        { category: "lesson", fact: "Lesson one learned from repair loop" },
        { category: "fact", fact: "Fact two discovered in repo" },
        { category: "preference", fact: "Preference three for strict TS" },
        { category: "context", fact: "Context four for active migration" },
      ],
    })
  );
  assert.equal(candidates.length, 4);
  assert.equal(candidates[0].category, "lesson");

  // Search helper fallback on empty memory
  assert.equal(searchMemoryFacts("", "anything"), "Memory is currently empty.");
  // Round-trip format
  assert.ok(formatHomeMemory(parsed).includes("## Learned Patterns & Lessons"));
});

test("5. learn_skill creates and updates reusable skills in project (Code) and global (Home) scopes", async () => {
  const scratch = await mkdirScratch("nexus-learn-skill-");
  const prevGlobalSkills = process.env.NEXUS_GLOBAL_SKILLS_DIR;
  process.env.NEXUS_GLOBAL_SKILLS_DIR = path.join(scratch, "global-skills");
  try {
    const projectRoot = path.join(scratch, "repo");
    await fs.mkdir(projectRoot, { recursive: true });

    const codeLearn = createLearnSkillTool({ projectRoot, taskKind: "code" });
    const createdMsg = await codeLearn.execute({
      name: "Verify Electron IPC",
      description: "Verify Electron preload and IPC routes with npm run check",
      instructions: "# Verify IPC\n\n1. Run `npm run check`.\n2. Run unit tests.",
    });
    assert.match(createdMsg, /Created reusable skill "verify-electron-ipc" \(project scope, mode: code\)/);

    // Updating the same skill refines it in place
    const updatedMsg = await codeLearn.execute({
      name: "verify-electron-ipc",
      description: "Verify Electron preload, schemas, and IPC routes",
      instructions: "# Verify IPC v2\n\n1. Check ipc/schemas.ts.\n2. Run `npm run check`.",
    });
    assert.match(updatedMsg, /Updated reusable skill "verify-electron-ipc"/);

    // Home mode saves to global scope with mode: home
    const homeLearn = createLearnSkillTool({ projectRoot, taskKind: "general" });
    const homeMsg = await homeLearn.execute({
      name: "quarterly-briefing",
      description: "Produce executive quarterly briefing decks",
      instructions: "# Briefing Workflow\n\n1. Gather latest metrics.\n2. Call create_deliverable.",
    });
    assert.match(homeMsg, /Created reusable skill "quarterly-briefing" \(global scope, mode: home\)/);

    const discovered = await listSkills(projectRoot);
    const codeSkill = discovered.find((s) => s.name === "verify-electron-ipc");
    const homeSkill = discovered.find((s) => s.name === "quarterly-briefing");
    assert.ok(codeSkill && codeSkill.source === "project" && codeSkill.modes.includes("code"));
    assert.ok(homeSkill && homeSkill.source === "global" && homeSkill.modes.includes("home"));
  } finally {
    if (prevGlobalSkills === undefined) delete process.env.NEXUS_GLOBAL_SKILLS_DIR;
    else process.env.NEXUS_GLOBAL_SKILLS_DIR = prevGlobalSkills;
    await fs.rm(scratch, { recursive: true, force: true });
  }
});

test("6. deriveDeterministicLessons and shouldExtractCodeMemory capture verified commands and self-healing lessons", () => {
  const codeLessons = deriveDeterministicLessons({
    taskKind: "code",
    supervisorRepairs: 1,
    verification: "passed",
    codeJournal: {
      version: 2,
      sessionId: "s1",
      goal: "Fix auth",
      mode: "auto",
      phase: "completed",
      status: "completed",
      plan: [],
      actions: [],
      changedFiles: ["src/auth.ts"],
      verification: [
        { command: "npm run check", passed: false, output: "TS2322 type error" },
        { command: "npm run check", passed: true },
      ],
      contextSummary: "",
      lastProgressAt: new Date().toISOString(),
      noProgressCount: 0,
    },
    existingMemory: "",
  });
  assert.ok(codeLessons.some((c) => c.category === "fact" && c.fact.includes("npm run check")));
  assert.ok(codeLessons.some((c) => c.category === "lesson" && c.fact.includes("Self-healed")));

  assert.equal(shouldExtractCodeMemory("Remember we always use pnpm", "Got it, noted."), true);
  assert.equal(shouldExtractCodeMemory("Fix bug", "Fixed it.", { repairs: 1 }), true);
  assert.equal(shouldExtractCodeMemory("Explain x", "Short."), false);

  const prompt = buildSelfImprovementExtractionPrompt({
    taskKind: "code",
    request: "Fix build",
    response: "Fixed build.",
    repairs: 1,
  });
  assert.match(prompt, /lesson/);
});

test("7. /goal and /learn slash commands expand in both home and code scopes, and .nexus/MEMORY.md loads", async () => {
  const homeGoal = await expandSlashCommand("/goal Build a comprehensive research briefing", undefined, "home");
  const codeGoal = await expandSlashCommand("/goal Refactor authentication middleware", undefined, "code");
  assert.match(homeGoal, /AUTONOMOUS GOAL MODE/);
  assert.match(homeGoal, /Build a comprehensive research briefing/);
  assert.match(codeGoal, /AUTONOMOUS GOAL MODE/);
  assert.match(codeGoal, /Refactor authentication middleware/);

  const homeLearn = await expandSlashCommand("/learn extract lessons", undefined, "home");
  const codeLearn = await expandSlashCommand("/learn extract lessons", undefined, "code");
  assert.match(homeLearn, /SELF-IMPROVEMENT/);
  assert.match(codeLearn, /SELF-IMPROVEMENT/);

  const scratch = await mkdirScratch("nexus-mem-md-");
  try {
    await fs.mkdir(path.join(scratch, ".nexus"), { recursive: true });
    await fs.writeFile(path.join(scratch, ".nexus", "MEMORY.md"), "- Always run npm run check after editing IPC schemas.", "utf8");
    const instr = await discoverProjectInstructions(scratch);
    assert.match(instr.section, /Workspace Memory \(\.nexus\/MEMORY\.md\)/);
    assert.match(instr.section, /Always run npm run check/);
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
});

test("8. buildSystemPrompt removes artificial 3-tool-call caps and advertises self-improvement tools", () => {
  const mem = { projectMemory: "", sessionMemory: "", facts: "" };
  const homeSimple = buildSystemPrompt(
    "auto",
    "/home",
    "Test",
    "test-model",
    mem,
    "",
    "simple",
    false,
    "general",
    "",
    inferHomeTaskContract("Explain transformers"),
    "",
    "",
    "",
    false,
    { request: "Explain transformers" }
  );
  assert.doesNotMatch(homeSimple, /at most 3 tool calls/i);
  assert.match(homeSimple, /learn_skill/);

  const codeQa = buildSystemPrompt(
    "auto",
    "/repo",
    "Test",
    "test-model",
    mem,
    "",
    "simple",
    false,
    "code",
    "",
    null,
    "",
    "",
    "",
    false,
    { request: "How does routing work?" }
  );
  assert.doesNotMatch(codeQa, /at most 3 tool calls/i);
  assert.doesNotMatch(codeQa, /read at most 2 files/i);
  assert.match(codeQa, /learn_skill/);
});

test("9. multi-format artifact inspection detects structural/content issues across presentations, spreadsheets, documents, latex, svg, json, csv, and images", async () => {
  const dir = await mkdirScratch("artifact-inspect-");
  const write = async (rel, content) => {
    const full = path.join(dir, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
    return rel;
  };
  const makePng = (width, height) => {
    const buf = Buffer.alloc(33);
    Buffer.from("89504e470d0a1a0a", "hex").copy(buf, 0);
    buf.writeUInt32BE(13, 8);
    buf.write("IHDR", 12, "ascii");
    buf.writeUInt32BE(width, 16);
    buf.writeUInt32BE(height, 20);
    buf[24] = 8;
    buf[25] = 2;
    return buf;
  };

  // 1. PPTX: broken deck (empty slide, duplicate slide, >350-word overflow, raw markdown & placeholder)
  const slideXml = (text) =>
    `<?xml version="1.0"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="x"><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:sld>`;
  const brokenPptxZip = new JSZip();
  const introText = "Quantum Computing Roadmap Overview and Executive Key Milestones for 2026";
  const overflowText = Array.from({ length: 380 }, (_, i) => `word${i}`).join(" ");
  brokenPptxZip.file("ppt/slides/slide1.xml", slideXml(introText));
  brokenPptxZip.file("ppt/slides/slide2.xml", `<?xml version="1.0"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="x"/>`);
  brokenPptxZip.file("ppt/slides/slide3.xml", slideXml(introText));
  brokenPptxZip.file("ppt/slides/slide4.xml", slideXml(overflowText));
  brokenPptxZip.file("ppt/slides/slide5.xml", slideXml("Architecture ![diagram](fig.png) Lorem ipsum dolor sit amet"));
  await write("broken.pptx", await brokenPptxZip.generateAsync({ type: "nodebuffer" }));

  const brokenPptxRes = await inspectDeliverable(dir, "broken.pptx", "Quantum computing roadmap");
  assert.equal(brokenPptxRes.ok, false);
  const pptxMsg = brokenPptxRes.problems.join("\n");
  assert.match(pptxMsg, /slide 2 is empty/i);
  assert.match(pptxMsg, /slide 3 duplicates slide 1/i);
  assert.match(pptxMsg, /slide 4 has ~380 words.*overflows/i);
  assert.match(pptxMsg, /unrendered Markdown syntax/i);
  assert.match(pptxMsg, /placeholder text/i);

  // Valid multi-slide PPTX
  const goodPptxZip = new JSZip();
  goodPptxZip.file(
    "ppt/slides/slide1.xml",
    slideXml(
      "Quantum Computing Strategy: Hardware Error Correction, Logical Qubit Scaling, Surface Code Thresholds, Cryogenic Microwave Control Planes, and Fault Tolerant Architecture Across Near Term Superconducting and Trapped Ion Processors"
    )
  );
  goodPptxZip.file(
    "ppt/slides/slide2.xml",
    slideXml(
      "Implementation Timeline: Cryogenic Control Stack Integration, Sub-Microsecond Syndrome Decoder Latency Targets, Compiler transpilation Passes, Benchmarking Metrics, and Fault Tolerant Logical Gate Milestones Planned Through 2028"
    )
  );
  await write("good.pptx", await goodPptxZip.generateAsync({ type: "nodebuffer" }));
  const goodPptxRes = await inspectDeliverable(dir, "good.pptx", "Quantum computing strategy");
  assert.equal(goodPptxRes.ok, true, `unexpected problems: ${goodPptxRes.problems.join("; ")}`);

  // 2. XLSX: formula errors (#REF!, #N/A) + 0-row sheet
  const brokenXlsxZip = new JSZip();
  brokenXlsxZip.file(
    "xl/workbook.xml",
    `<?xml version="1.0"?><workbook><sheet name="Summary" sheetId="1"/><sheet name="Blank" sheetId="2"/></workbook>`
  );
  brokenXlsxZip.file(
    "xl/worksheets/sheet1.xml",
    `<worksheet><row r="1"><c t="e"><v>#REF!</v></c><c t="e"><v>#N/A</v></c></row></worksheet>`
  );
  brokenXlsxZip.file("xl/worksheets/sheet2.xml", `<worksheet></worksheet>`);
  await write("broken.xlsx", await brokenXlsxZip.generateAsync({ type: "nodebuffer" }));
  const brokenXlsxRes = await inspectDeliverable(dir, "broken.xlsx", "");
  assert.equal(brokenXlsxRes.ok, false);
  assert.match(brokenXlsxRes.problems.join("\n"), /formula\/value errors.*#REF!.*#N\/A/i);
  assert.match(brokenXlsxRes.problems.join("\n"), /worksheet "Blank" has 0 rows/i);

  // 3. DOCX: serialization leak, placeholder, raw markdown
  const brokenDocxZip = new JSZip();
  const filler = Array.from({ length: 85 }, (_, i) => `clause${i}`).join(" ");
  brokenDocxZip.file(
    "word/document.xml",
    `<?xml version="1.0"?><w:document xmlns:w="x"><w:p><w:r><w:t>${filler}</w:t></w:r></w:p><w:p><w:r><w:t>[object Object] [insert company name]</w:t></w:r></w:p><w:p><w:r><w:t>![diagram](fig.png)</w:t></w:r></w:p></w:document>`
  );
  await write("broken.docx", await brokenDocxZip.generateAsync({ type: "nodebuffer" }));
  const brokenDocxRes = await inspectDeliverable(dir, "broken.docx", "");
  assert.equal(brokenDocxRes.ok, false);
  const docxMsg = brokenDocxRes.problems.join("\n");
  assert.match(docxMsg, /\[object Object\]/);
  assert.match(docxMsg, /placeholders/i);
  assert.match(docxMsg, /unrendered Markdown/i);

  // 4. LaTeX: unbalanced environment
  await write("broken.tex", "\\documentclass{article}\n\\begin{document}\n\\begin{itemize}\n\\item One item in this test.\n\\end{document}\n");
  const texRes = await inspectDeliverable(dir, "broken.tex", "");
  assert.equal(texRes.ok, false);
  assert.match(texRes.problems.join("\n"), /\\begin\{itemize\}.*unbalanced/i);

  // 5. CSV: inconsistent column counts & NaN leak
  await write("broken.csv", "name,value,unit\nalpha,10,ms\nbeta,NaN\n");
  const csvRes = await inspectDeliverable(dir, "broken.csv", "");
  assert.equal(csvRes.ok, false);
  assert.match(csvRes.problems.join("\n"), /inconsistent column counts on row\(s\) 3/i);
  assert.match(csvRes.problems.join("\n"), /invalid cell values/i);

  // 6. SVG, JSON & Images via validateHomeArtifact + inspect_artifact tool
  await write("broken.svg", `<svg viewBox="0 0 100 100"><defs/><rect x="NaN" y="0" width="10" height="10"/></svg>`);
  await write("nodraw.svg", `<svg viewBox="0 0 100 100"><defs/></svg>`);
  await write("empty.json", `{}`);
  await write("tiny.png", makePng(1, 1));
  await write("good.svg", `<svg viewBox="0 0 120 120"><rect x="10" y="10" width="100" height="100"/></svg>`);
  await write("good.png", makePng(128, 128));

  const inspectTool = createInspectArtifactTool({ projectRoot: dir });

  const brokenSvgOut = String(await inspectTool.execute({ file_path: "broken.svg" }));
  assert.match(brokenSvgOut, /PROBLEMS DETECTED/);
  assert.match(brokenSvgOut, /"NaN" or "undefined"/);

  const nodrawSvgOut = String(await inspectTool.execute({ file_path: "nodraw.svg" }));
  assert.match(nodrawSvgOut, /PROBLEMS DETECTED/);
  assert.match(nodrawSvgOut, /no drawable elements/);

  const emptyJsonOut = String(await inspectTool.execute({ file_path: "empty.json" }));
  assert.match(emptyJsonOut, /PROBLEMS DETECTED/);
  assert.match(emptyJsonOut, /JSON artifact is empty/);

  const tinyPngOut = String(await inspectTool.execute({ file_path: "tiny.png" }));
  assert.match(tinyPngOut, /PROBLEMS DETECTED/);
  assert.match(tinyPngOut, /degenerate \(1x1px\)/);

  const goodSvgOut = String(await inspectTool.execute({ file_path: "good.svg" }));
  assert.match(goodSvgOut, /Status: OK/);
  assert.equal((await validateHomeArtifact(dir, "good.svg")).valid, true);

  const goodPngOut = String(await inspectTool.execute({ file_path: "good.png" }));
  assert.match(goodPngOut, /Status: OK/);
  assert.match(goodPngOut, /128x128px PNG/);
});
