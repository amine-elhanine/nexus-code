// Sample `tool:before` hook: exit non-zero to DENY the tool call.
// Reads the event payload as JSON on stdin: { tool, args, event }.
// Denials are monotonic — no later hook can override this denial.
"use strict";

let input = "";
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  try {
    const payload = JSON.parse(input || "{}");
    const tool = String(payload.tool || "");
    if (tool.includes("rm") || tool.includes("delete")) {
      console.error(`event-guard: refusing destructive tool "${tool}" — ask the user first.`);
      process.exit(1);
    }
  } catch {
    // Malformed payload: abstain (exit 0) for observational safety.
  }
  process.exit(0);
});
