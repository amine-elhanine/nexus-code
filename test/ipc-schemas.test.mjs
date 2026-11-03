// Tests for the renderer→main IPC trust-boundary schemas (electron/ipc/schemas.ts).
//
// The schemas are validate-and-throw: valid payloads pass untouched (the
// handler forwards the ORIGINAL payload), malformed/oversized ones fail
// closed with a labeled error. These tests pin that contract so future
// schema edits don't silently loosen the boundary.
import test from "node:test";
import assert from "node:assert/strict";

const {
  assertPayload, AgentRunSchema, HomeRunSchema, WorkspaceWriteSchema, WorkspaceReadSchema,
  AttachmentSaveSchema, AgentCancelSchema, ConfigToggleSchema, McpSaveSchema,
} = await import("../dist-electron/ipc/schemas.js");

test("ipc schemas: valid payloads pass and extra keys are tolerated (looseObject)", () => {
  const payload = {
    request: "fix the bug",
    providerId: "p1",
    unknownJunk: { nested: true }, // renderer junk must not be rejected, only bounded types/sizes
  };
  assert.doesNotThrow(() => assertPayload(AgentRunSchema, payload, "agent:run"));
  assert.doesNotThrow(() => assertPayload(ConfigToggleSchema, { enabled: true }, "rules:config:save"));
});

test("ipc schemas: oversized request fails closed with the channel label", () => {
  const huge = "x".repeat(400_001);
  assert.throws(
    () => assertPayload(AgentRunSchema, { request: huge }, "agent:run"),
    (error) => /Invalid agent:run payload/.test(String(error?.message))
  );
});

test("ipc schemas: home:run requires sessionId and rejects wrong types", () => {
  assert.throws(() => assertPayload(HomeRunSchema, { request: "hi" }, "home:run"));
  assert.throws(() => assertPayload(HomeRunSchema, { sessionId: 42, request: "hi" }, "home:run"));
  assert.doesNotThrow(() => assertPayload(HomeRunSchema, { sessionId: "s1", request: "hi" }, "home:run"));
  // "" is the renderer's legitimate "unset" for optional model-selection
  // fields (observed live: effort: "" broke the first schema wiring).
  assert.doesNotThrow(() => assertPayload(HomeRunSchema, { sessionId: "s1", request: "hi", effort: "", model: "", providerId: "" }, "home:run"));
  assert.doesNotThrow(() => assertPayload(AgentRunSchema, { request: "hi", effort: "", mode: "ask" }, "agent:run"));
});

test("ipc schemas: workspace write tuple validates path + content size", () => {
  assert.doesNotThrow(() => assertPayload(WorkspaceWriteSchema, ["src/app.ts", "export {};"], "workspace:write"));
  assert.throws(() => assertPayload(WorkspaceWriteSchema, ["", "content"], "workspace:write"));
  assert.throws(() => assertPayload(WorkspaceWriteSchema, ["a.ts", "x".repeat(20_000_001)], "workspace:write"));
  assert.throws(() => assertPayload(WorkspaceReadSchema, [123], "workspace:read"));
});

test("ipc schemas: attachment cap matches the 25MB service limit path", () => {
  // 25MB base64 ≈ 33.4M chars — under the 34M schema cap so the service's
  // own "too large" error stays reachable; above it the schema rejects first.
  const ok = "A".repeat(34_000_000);
  const tooBig = "A".repeat(34_000_001);
  assert.doesNotThrow(() => assertPayload(AttachmentSaveSchema, { data: ok }, "attachments:save"));
  assert.throws(() => assertPayload(AttachmentSaveSchema, { data: tooBig }, "attachments:save"));
});

test("ipc schemas: cancel tolerates a missing session id", () => {
  assert.doesNotThrow(() => assertPayload(AgentCancelSchema, [undefined], "agent:cancel"));
  assert.doesNotThrow(() => assertPayload(AgentCancelSchema, ["session-1"], "agent:cancel"));
  assert.throws(() => assertPayload(AgentCancelSchema, [123], "agent:cancel"));
});

test("ipc schemas: mcp save constrains transport enum and env value size", () => {
  const base = { name: "srv", enabled: true, transport: "stdio", command: "npx" };
  assert.doesNotThrow(() => assertPayload(McpSaveSchema, base, "mcp:save"));
  assert.throws(() => assertPayload(McpSaveSchema, { ...base, transport: "carrier-pigeon" }, "mcp:save"));
  assert.throws(() => assertPayload(McpSaveSchema, { ...base, env: { K: "x".repeat(16_385) } }, "mcp:save"));
});
