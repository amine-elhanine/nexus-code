// Unit tests for loopPreventionMiddleware in agent-service
import assert from "node:assert/strict";
import { ToolMessage } from "@langchain/core/messages";
import { loopPreventionMiddleware } from "../dist-electron/agent-service.js";

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

console.log("\n=== Loop Prevention Middleware Tests ===");

await test("first inspection executes normally without notice", async () => {
  const middleware = loopPreventionMiddleware();
  let executed = false;
  const handler = async () => {
    executed = true;
    return new ToolMessage({ content: "const x = 1;", tool_call_id: "c1", name: "read_file" });
  };

  const res = await middleware.wrapToolCall(
    { toolCall: { name: "read_file", args: { file_path: "src/App.tsx" }, id: "c1" } },
    handler
  );

  assert.equal(executed, true);
  assert.equal(res.content, "const x = 1;");
  assert.equal(res.status, undefined);
});

await test("second consecutive inspection appends steering notice to content", async () => {
  const middleware = loopPreventionMiddleware();
  const handler = async () => new ToolMessage({ content: "const x = 1;", tool_call_id: "c1", name: "read_file" });

  await middleware.wrapToolCall(
    { toolCall: { name: "read_file", args: { file_path: "src/App.tsx" }, id: "c1" } },
    handler
  );
  const res2 = await middleware.wrapToolCall(
    { toolCall: { name: "read_file", args: { file_path: "src/App.tsx" }, id: "c2" } },
    handler
  );

  assert.ok(res2.content.includes("const x = 1;"));
  assert.ok(res2.content.includes("[Notice: You already inspected 'src/App.tsx'"));
});

await test("third consecutive inspection is short-circuited with intervention ToolMessage", async () => {
  const middleware = loopPreventionMiddleware();
  let calls = 0;
  const handler = async () => {
    calls++;
    return new ToolMessage({ content: "const x = 1;", tool_call_id: "c1", name: "read_file" });
  };

  await middleware.wrapToolCall({ toolCall: { name: "read_file", args: { file_path: "src/App.tsx" }, id: "c1" } }, handler);
  await middleware.wrapToolCall({ toolCall: { name: "read_file", args: { file_path: "src/App.tsx" }, id: "c2" } }, handler);
  
  // 3rd call should NOT reach the handler
  const res3 = await middleware.wrapToolCall({ toolCall: { name: "read_file", args: { file_path: "src/App.tsx" }, id: "c3" } }, handler);

  assert.equal(calls, 2); // handler was called only twice, 3rd was short-circuited
  assert.equal(res3.status, "error");
  assert.ok(res3.content.includes("[LOOP PREVENTION NOTICE]"));
  assert.ok(res3.content.includes("Stop inspecting or re-reading files"));
  assert.ok(res3.content.includes("write_todos"));
});

await test("modifying action resets loop prevention counter", async () => {
  const middleware = loopPreventionMiddleware();
  let readCalls = 0;
  const readHandler = async () => {
    readCalls++;
    return new ToolMessage({ content: "code", tool_call_id: "r", name: "read_file" });
  };
  const execHandler = async () => new ToolMessage({ content: "build ok", tool_call_id: "e", name: "execute" });

  // 2 reads
  await middleware.wrapToolCall({ toolCall: { name: "read_file", args: { file_path: "src/App.tsx" }, id: "r1" } }, readHandler);
  await middleware.wrapToolCall({ toolCall: { name: "read_file", args: { file_path: "src/App.tsx" }, id: "r2" } }, readHandler);

  // Modifying action occurs (e.g. execute or edit_file)
  await middleware.wrapToolCall({ toolCall: { name: "execute", args: { command: "npm run build" }, id: "e1" } }, execHandler);

  // Next read of App.tsx should now be considered fresh (call #1 after reset)
  const resFresh = await middleware.wrapToolCall({ toolCall: { name: "read_file", args: { file_path: "src/App.tsx" }, id: "r3" } }, readHandler);

  assert.equal(readCalls, 3);
  assert.equal(resFresh.content, "code"); // No nudge attached because count reset to 1
  assert.equal(resFresh.status, undefined);
});

await test("path normalization handles Windows slashes and leading slashes", async () => {
  const middleware = loopPreventionMiddleware();
  const handler = async () => new ToolMessage({ content: "code", tool_call_id: "r", name: "read_file" });

  await middleware.wrapToolCall({ toolCall: { name: "read_file", args: { file_path: "src\\App.tsx" }, id: "r1" } }, handler);
  const res2 = await middleware.wrapToolCall({ toolCall: { name: "read_file", args: { filePath: "/src/App.tsx" }, id: "r2" } }, handler);

  // Should detect as same target despite \\ vs / and filePath vs file_path
  assert.ok(res2.content.includes("[Notice: You already inspected 'src/App.tsx'"));
});

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);
