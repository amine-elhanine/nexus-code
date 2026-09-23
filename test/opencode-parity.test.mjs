import assert from "node:assert/strict";
import {
  applySearchReplaceBlocks,
  applyUnifiedDiffHunks,
  applyUpdatedFileContent,
} from "../electron/edit-tools.ts";
import { cleanTerminalOutput, capModelOutput } from "../electron/command-service.ts";
import { extractDiagnosticFeedback, MAX_REPAIRS } from "../electron/agent-service.ts";

console.log("=== OpenCode Parity & Self-Healing Tests ===");

// 1. Repair limit configuration
assert.equal(MAX_REPAIRS.ask, 3, "ask mode must allow 3 repair iterations");
assert.equal(MAX_REPAIRS.auto, 5, "auto mode must allow 5 repair iterations");
assert.equal(MAX_REPAIRS.plan, 0, "plan mode must allow 0 repairs (read-only)");
console.log("✓ Repair iteration budgets configured (ask: 3, auto: 5)");

// 2. Terminal output cleaning & carriage-return spinner collapse
const noisyTerminalOutput =
  "Installing packages...\r[=   ] 25%\r[==  ] 50%\r[=== ] 75%\r[====] 100%\nDone in 2.4s.\n\n\n\nAll modules installed.";
const cleanedTerminal = cleanTerminalOutput(noisyTerminalOutput);
assert.ok(!cleanedTerminal.includes("\r"), "Terminal output should collapse \\r overwrites");
assert.ok(!cleanedTerminal.includes("\n\n\n"), "Runs of 3+ newlines should be collapsed");
assert.ok(cleanedTerminal.includes("Done in 2.4s."), "Final status should be preserved");
console.log("✓ Terminal output spinner cleaning and newline compaction passed");

// 3. Search and replace hunk application with CRLF vs LF and whitespace tolerance
const originalCode = `export function add(a, b) {\r\n  // add numbers\r\n  return a + b;\r\n}\r\n`;
const searchReplaceHunk = `<<<<<<< SEARCH
  // add numbers
  return a + b;
=======
  // add numbers with validation
  if (typeof a !== "number" || typeof b !== "number") throw new Error("Invalid args");
  return a + b;
>>>>>>>`;
const updatedFromSR = applyUpdatedFileContent(originalCode, searchReplaceHunk);
assert.ok(updatedFromSR.includes("Invalid args"), "Updated content must contain replacement code");
assert.ok(updatedFromSR.includes("export function add"), "Untouched code must be preserved");
console.log("✓ Search & replace hunk with CRLF tolerance passed");

// 4. Unified diff hunk application with offset tolerance
const multiLineCode = `import path from "path";
import fs from "fs";

function readFile(p) {
  return fs.readFileSync(p, "utf8");
}

function writeFile(p, data) {
  fs.writeFileSync(p, data);
}

export { readFile, writeFile };
`;

const unifiedDiffHunk = `@@ -4,4 +4,5 @@
 function readFile(p) {
+  if (!p) throw new Error("Path required");
   return fs.readFileSync(p, "utf8");
 }`;

const updatedFromUD = applyUpdatedFileContent(multiLineCode, unifiedDiffHunk);
assert.ok(updatedFromUD.includes('if (!p) throw new Error("Path required");'));
assert.ok(updatedFromUD.includes("function writeFile"));
console.log("✓ Unified diff hunk application passed");

// 5. Smart Diagnostic Extraction
const verboseCompilerLog = `
Starting compilation with tsc --noEmit...
src/controllers/auth.ts(45,12): error TS2322: Type 'string' is not assignable to type 'number'.
    const userId: number = payload.id;
src/services/api.ts(120,7): error TS2339: Property 'fetchUsers' does not exist on type 'ApiClient'.
` + "Unrelated cascade noise line...\n".repeat(200) + `
Found 2 errors in 2 files.
`;

const diagnostics = extractDiagnosticFeedback(verboseCompilerLog, 3000);
assert.ok(diagnostics.includes("error TS2322: Type 'string' is not assignable to type 'number'"), "Root cause error TS2322 must be preserved");
assert.ok(diagnostics.includes("error TS2339: Property 'fetchUsers' does not exist"), "Secondary diagnostic TS2339 must be extracted");
assert.ok(diagnostics.includes("=== Extracted Diagnostics ==="), "Extracted diagnostic section must be present");
assert.ok(diagnostics.includes("Found 2 errors in 2 files"), "Tail summary must be included");
console.log("✓ Smart compiler diagnostic extraction passed");

console.log("\nAll OpenCode parity & self-healing tests passed successfully!");
