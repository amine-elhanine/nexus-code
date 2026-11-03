// Tests for the Home reliability gates: mid-run provider failover chain
// selection (electron/agent/provider-failover.ts) and the plan-as-hard-
// contract evidence check (planItemEvidence in electron/deliverable-inspect.ts).
import test from "node:test";
import assert from "node:assert/strict";

const { buildFailoverChain } = await import("../dist-electron/agent/provider-failover.js");
const { planItemEvidence } = await import("../dist-electron/deliverable-inspect.js");

const provider = (id, overrides = {}) => ({
  id,
  label: id,
  provider: "custom",
  apiKey: "key-" + id,
  baseUrl: "https://" + id + ".example.com/v1",
  models: [id + "-model-a", id + "-model-b"],
  ...overrides,
});

test("failover chain: ordered candidates exclude the active provider", () => {
  const all = [provider("nvidia"), provider("zai"), provider("openrouter")];
  const chain = buildFailoverChain(all[0], all);
  assert.deepEqual(chain.map((t) => t.config.id), ["zai", "openrouter"]);
  assert.equal(chain[0].model, "zai-model-a");
});

test("failover chain: skips keyless providers and providers without models", () => {
  const all = [
    provider("active"),
    // Hosted providers need a key; custom/ollama endpoints legitimately don't.
    provider("nokey", { apiKey: "", provider: "openai" }),
    provider("nomodels", { models: [] }),
    provider("ollama", { provider: "ollama", apiKey: "", baseUrl: "http://127.0.0.1:11434" }),
    provider("ok"),
  ];
  const chain = buildFailoverChain(all[0], all);
  assert.deepEqual(chain.map((t) => t.config.id), ["ollama", "ok"]);
});

test("failover chain: dedupes by id and tolerates an active provider absent from the list", () => {
  const all = [provider("zai"), provider("zai"), provider("openrouter")];
  const chain = buildFailoverChain({ ...provider("legacy-default"), id: "legacy-default" }, all);
  assert.deepEqual(chain.map((t) => t.config.id), ["zai", "openrouter"]);
});

test("failover chain: empty list or only-the-active provider yields no targets", () => {
  const only = [provider("active")];
  assert.deepEqual(buildFailoverChain(only[0], only), []);
  assert.deepEqual(buildFailoverChain(only[0], []), []);
});

test("plan evidence: file path matching a topic keyword is evidence", () => {
  assert.equal(planItemEvidence("Research the Battle of Troy", ["troy-presentation.pptx"], []), true);
});

test("plan evidence: item naming an extension matches a produced file of that type", () => {
  // "slides"/"deck" are format stopwords, so keyword matching alone can't
  // judge this item — the .pptx extension named in the item closes the gap.
  assert.equal(planItemEvidence("Create the slides for the deck (output: .pptx)", ["output/any-name.pptx"], []), true);
});

test("plan evidence: journal action sharing enough keywords is evidence", () => {
  assert.equal(
    planItemEvidence("Write the Troy heroes section", [], ["supervisor · wrote Troy heroes section into report", "progressed"]),
    true
  );
  assert.equal(planItemEvidence("Write the Troy heroes section", [], ["Ran the linter"], ), false);
});

test("plan evidence: items without judgeable keywords never block (lenient by design)", () => {
  // "Create the deck" — deck/create are stopwords → no keywords → evidenced.
  assert.equal(planItemEvidence("Create the deck", [], []), true);
  assert.equal(planItemEvidence("", [], []), true);
});
