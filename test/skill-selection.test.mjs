// Regression cover for "I installed a skill and the agent never used it".
//
// Skill selection used to be a hard lexical gate: only skills scoring >= 3 on
// keyword overlap were advertised and mounted, so a request phrased in the
// user's own words ("generate me a presentation") shared too few tokens with a
// pptx skill's description to clear the bar and the skill vanished entirely —
// while the system prompt still demanded the agent check for skills. Selection
// now ranks but never filters; these tests pin that contract.
import assert from "node:assert/strict";
import { formatSkillNote, recommendSkills, scoreSkills, selectSkills } from "../dist-electron/skills-service.js";

const skill = (name, description, modes = [], source = "global") => ({
  name,
  description,
  modes,
  source,
  path: `/skills/${name}/SKILL.md`,
});

const CATALOG = [
  skill("pptx", "Use this skill any time a .pptx file is involved. Includes creating slide decks and presentations as PowerPoint files."),
  skill("docx", "Write and edit Word .docx documents."),
  skill("xlsx", "Build Excel .xlsx spreadsheets with formulas."),
  skill("pdf", "Extract text from PDF files and merge them."),
  skill("react-reviewer", "Review React components for hooks misuse.", ["code"]),
];

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

await test("every mode-eligible skill is advertised, however the request is worded", () => {
  for (const request of [
    "generate me a presentation about the roman empire",
    "I need slides for the pitch",
    "deck please",
    "make something for the all-hands",
    "hello there",
  ]) {
    const selection = selectSkills(CATALOG, request, "home");
    assert.deepEqual(
      selection.catalog.map((entry) => entry.name).sort(),
      ["docx", "pdf", "pptx", "xlsx"],
      `catalog must be complete for: ${request}`
    );
  }
});

await test("the skill is still recommended when only description wording overlaps", () => {
  const selection = selectSkills(CATALOG, "generate me a presentation about the roman empire", "home");
  assert.deepEqual(selection.recommended.map((entry) => entry.name), ["pptx"]);
});

await test("the lone installed skill leads the field even on a weak match", () => {
  const lone = [skill("pptx", "Build decks and presentations as PowerPoint files.")];
  assert.deepEqual(selectSkills(lone, "make me a presentation", "home").recommended.map((entry) => entry.name), ["pptx"]);
  assert.deepEqual(selectSkills(lone, "refactor this component", "home").recommended, [], "no overlap means no READ FIRST hint");
});

await test("singular and plural wordings score the same", () => {
  assert.deepEqual(
    selectSkills(CATALOG, "make me a spreadsheet of quarterly sales", "home").recommended.map((entry) => entry.name),
    ["xlsx"]
  );
});

await test("skills scoped to another mode stay out of the catalog and are named as off-limits", () => {
  const selection = selectSkills(CATALOG, "review this react component", "home");
  assert.ok(!selection.catalog.some((entry) => entry.name === "react-reviewer"), "Code-only skill must not leak into Home");
  const note = formatSkillNote(selection, {
    modeLabel: "home",
    offLimits: CATALOG.filter((entry) => entry.modes.length && !entry.modes.includes("home")),
    offLimitsSystemCount: 0,
  });
  assert.match(note, /Skills NOT available in this mode/);
  assert.match(note, /react-reviewer/);
});

await test("Code mode still gets its own scoped skill", () => {
  assert.deepEqual(
    selectSkills(CATALOG, "review this react component", "code").recommended.map((entry) => entry.name),
    ["react-reviewer"]
  );
});

await test("the note lists every installed skill with a read path and says it is complete", () => {
  const note = formatSkillNote(selectSkills(CATALOG, "make me a presentation", "home"), { modeLabel: "home" });
  for (const entry of CATALOG.filter((item) => !item.modes.length)) {
    assert.ok(note.includes(`**${entry.name}**`), `${entry.name} missing from the note`);
    assert.ok(note.includes(`/global-skills/${entry.name}/SKILL.md`), `${entry.name} has no read path`);
  }
  assert.match(note, /COMPLETE list of skills/);
  assert.match(note, /READ FIRST/);
});

await test("no skills and nothing off-limits produces no note", () => {
  assert.equal(formatSkillNote({ catalog: [], recommended: [] }), "");
});

await test("same-named skills collapse to the highest-priority source", () => {
  const selection = selectSkills(
    [skill("pptx", "global copy", [], "global"), skill("pptx", "project copy", [], "project")],
    "make a presentation",
    "home"
  );
  assert.equal(selection.catalog.length, 1);
  assert.equal(selection.catalog[0].source, "project");
});

await test("scoring stays a pure ranking signal with no filtering of its own", () => {
  const scored = scoreSkills(CATALOG, "make me a spreadsheet");
  assert.equal(scored.length, CATALOG.length, "every skill is scored, none dropped");
  assert.deepEqual(scored[0].skill.name, "xlsx");
  assert.deepEqual(
    scored.filter((entry) => entry.score === 0).map((entry) => entry.skill.name).sort(),
    ["docx", "pdf", "pptx", "react-reviewer"],
    "zero-score skills survive scoring — only ranking uses them"
  );
  // recommendSkills keeps its legacy noise floor; selectSkills supersedes it.
  assert.deepEqual(recommendSkills(CATALOG, "refactor this component"), []);
});

if (failed > 0) {
  console.error(`\nTests failed: ${failed}`);
  process.exit(1);
}
console.log(`\nAll ${passed} skill selection tests passed!`);