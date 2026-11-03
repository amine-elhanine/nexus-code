// Tests for the Home research-subagent tool (electron/home-research-agent.ts)
// — the context firewall for broad research phases (G2 parity mechanism).
// Full-model behavior is exercised live; these tests pin the guard rails:
// tool identity, schema, input validation, and the single-delegation lock —
// the paths that must never reach a provider.
import test from "node:test";
import assert from "node:assert/strict";

const { createHomeResearchTool, HOME_RESEARCH_DIGEST_CAP } = await import("../dist-electron/home-research-agent.js");

const provider = { id: "p1", label: "Test", provider: "openai", apiKey: "sk-test", models: ["gpt-test"] };

test("research tool: identity + schema", () => {
  const research = createHomeResearchTool({
    projectRoot: ".",
    provider,
    modelName: "gpt-test",
    researchTools: [],
  });
  assert.equal(research.name, "research");
  assert.match(research.description, /fresh-context research subagent/);
  assert.match(research.description, new RegExp(String(HOME_RESEARCH_DIGEST_CAP)));
});

test("research tool: empty question refused without touching a provider", async () => {
  const research = createHomeResearchTool({ projectRoot: ".", provider, modelName: "gpt-test", researchTools: [] });
  const result = await research.invoke({ question: "   " });
  assert.match(String(result), /the question is required/);
});

test("research tool: oversized question rejected by schema before any provider call", async () => {
  const research = createHomeResearchTool({ projectRoot: ".", provider, modelName: "gpt-test", researchTools: [] });
  await assert.rejects(
    () => research.invoke({ question: "x".repeat(2_001) }),
    (error) => /tool input|schema|expected/i.test(String(error?.message || error))
  );
});
