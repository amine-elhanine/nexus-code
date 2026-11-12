// Renderer unit-test runner.
//
// The renderer has no compiled output (tsconfig.json is noEmit; vite bundles
// for the app only), so plain node cannot import src/**.ts directly. This
// runner bundles each renderer test (and the TS modules it imports) with
// rolldown (already in the dependency tree via vite) into a scratch ESM file
// and executes it with plain node — the same pass/fail-per-name contract as
// scripts/run-unit-tests.mjs.
//
// TS import specifiers use the repo-wide ".js" convention, so a resolve hook
// maps "./x.js" → "./x.ts" when only the .ts file exists.
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

// Pure TS/TSX-free renderer modules with real logic. Component tests need a
// DOM and belong to the Electron snapshot harness (test/renderer-snapshot).
const RENDERER_TESTS = [
  "test/renderer/agent-event-pipeline.test.mjs",
];

async function bundle(entry) {
  const { rolldown } = await import("rolldown");
  const outDir = path.join(root, "test", ".renderer-build");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, path.basename(entry).replace(/\.mjs$/, ".bundle.mjs"));
  const build = await rolldown({
    input: path.join(root, entry),
    resolve: {
      // Resolve ".js" specifiers to sibling ".ts" files (TS convention).
      extensionAlias: { ".js": [".js", ".ts"] },
    },
    transform: { tsconfig: { jsx: "react-jsx" } },
  });
  await build.write({ dir: outDir, entryFileNames: path.basename(outFile), format: "esm" });
  await build.close();
  return outFile;
}

const failures = [];
for (const [i, entry] of RENDERER_TESTS.entries()) {
  const label = path.basename(entry);
  process.stdout.write(`[${String(i + 1).padStart(3, "0")}/${RENDERER_TESTS.length}] ${label} — `);
  let outFile;
  try {
    outFile = await bundle(entry);
  } catch (error) {
    console.log("FAIL (bundle error)");
    console.error(error);
    failures.push(label);
    continue;
  }
  const result = spawnSync(process.execPath, [outFile], { cwd: root, encoding: "utf8", timeout: 120_000 });
  if (result.status === 0 && !/failed:\s*[1-9]/.test(result.stdout)) {
    console.log("pass");
  } else {
    console.log("FAIL");
    console.error(result.stdout);
    console.error(result.stderr);
    failures.push(label);
  }
}

console.log(`\nDone: ${RENDERER_TESTS.length - failures.length}/${RENDERER_TESTS.length} passed.`);
if (failures.length) process.exit(1);
