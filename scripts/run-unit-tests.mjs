// Unit-test runner for the curated `test:unit` list below. Replaces the old
// 60-`&&`-chain `test:unit` script: each test now runs and reports by name,
// failures print their own output inline, and a failing test does not stop
// the rest of the suite from running (exit code is 1 if anything failed).
// NOTE: some tests (sandbox-and-agent, renderer-security, verify-terminal-ipc,
// inspect-langchain-links) intentionally stay out of this list — they need a
// live Electron runtime or network and are run via their own scripts.
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

const UNIT_TESTS = [
  "test/scratch-helper.test.mjs",
  "test/rate-limit.test.mjs",
  "test/checkpoint-resume.test.mjs",
  "test/checkpoint-binary.test.mjs",
  "test/widget-blocks.test.mjs",
  "test/visual-svg.test.mjs",
  "test/loop-prevention.test.mjs",
  "test/browser-auto-open.test.mjs",
  "test/symbol-parser.test.mjs",
  "test/lsp-service.test.mjs",
  "test/hooks.test.mjs",
  "test/headless-cli.test.mjs",
  "test/edit-gate.test.mjs",
  "test/permissions.test.mjs",
  "test/full-access-mode.test.mjs",
  "test/plugins.test.mjs",
  "test/plugin-manifest.test.mjs",
  "test/plugin-security.test.mjs",
  "test/plugin-lifecycle.test.mjs",
  "test/plugin-runner.test.mjs",
  "test/plugin-ui.test.mjs",
  "test/plugin-agent-tools.test.mjs",
  "test/plugin-live-events-and-context.test.mjs",
  "test/state-split.test.mjs",
  "test/home-memory.test.mjs",
  "test/skill-archive.test.mjs",
  "test/large-project-index.test.mjs",
  "test/code-task.test.mjs",
  "test/home-task.test.mjs",
  "test/home-artifact.test.mjs",
  "test/home-isolation.test.mjs",
  "test/home-session-files.test.mjs",
  "test/fix-regressions.test.mjs",
  "test/command-expansion.test.mjs",
  "test/prompt-assets.test.mjs",
  "test/eval-corpus.test.mjs",
  "test/eval-prompt-assets.test.mjs",
  "test/eval-runner-utils.test.mjs",
  "test/binary-files.test.mjs",
  "test/thinking-chunk.test.mjs",
  "test/git-status.test.mjs",
  "test/project-instructions.test.mjs",
  "test/project-memory.test.mjs",
  "test/memory-format.test.mjs",
  "test/provider-crud.test.mjs",
  "test/path-normalization.test.mjs",
  "test/chat-inline-images.test.mjs",
  "test/sliding-plan-drawer.test.mjs",
  "test/skill-selection.test.mjs",
  "test/marketplace-global-and-skill-scope.test.mjs",
  "test/model-efforts.test.mjs",
  "test/secret-storage-policy.test.mjs",
  "test/subprocess-bounds.test.mjs",
  "test/network-policy.test.mjs",
  "test/ipc-adversarial.test.mjs",
  "test/ipc-schemas.test.mjs",
  "test/prompt-caching.test.mjs",
  "test/cache-usage.test.mjs",
  "test/deliverable-inspect.test.mjs",
  "test/reliability-gates.test.mjs",
  "test/tool-message-sanitize.test.mjs",
  "test/compaction-tiers.test.mjs",
  "test/home-research-agent.test.mjs",
  "test/background-jobs.test.mjs",
  "test/home-verify-decision.test.mjs",
  "test/edit-fuzzy-match.test.mjs",
  "test/compat-readers.test.mjs",
  "test/builtin-tool-catalog.test.mjs",
  "test/context-budget.test.mjs",
];

console.log(`Running ${UNIT_TESTS.length} unit tests...\n`);
const failures = [];
for (const [i, testPath] of UNIT_TESTS.entries()) {
  const label = path.basename(testPath);
  process.stdout.write(`[${String(i + 1).padStart(3, "0")}/${UNIT_TESTS.length}] ${label} — `);
  const res = spawnSync(process.execPath, [testPath], { cwd: root, stdio: "pipe", encoding: "utf8" });
  if (res.status === 0) {
    console.log("pass");
    continue;
  }
  console.log("FAIL");
  failures.push(label);
  // Show the failing test's output inline so the fix loop can start immediately.
  const out = (res.stdout || "") + (res.stderr || "");
  const lines = out.split(/\r?\n/).filter(Boolean);
  console.log(lines.slice(-15).map((l) => `    ${l}`).join("\n"));
}

console.log(`\nDone: ${UNIT_TESTS.length - failures.length}/${UNIT_TESTS.length} passed.`);
if (failures.length) {
  console.log(`\nFailed (${failures.length}):`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
