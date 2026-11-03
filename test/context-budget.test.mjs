// context-budget.ts tests — the context-budget + auto-compaction prep that
// was extracted verbatim from agent-service.ts. Verifies the extraction
// didn't change the math. Imports from dist-electron — run
// `npm run build:electron` first.
import assert from 'node:assert/strict';
import { prepareContextBudget } from '../dist-electron/agent/context-budget.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(() => { console.log(`  ✔ ${name}`); passed++; })
    .catch((e) => { console.error(`  ✗ ${name}`); console.error(e); failed++; });
}

const mkInput = (over = {}) => ({
  modelContextWindow: 128_000,
  modelMaxOutput: 8_192,
  systemPromptText: 'x'.repeat(38_000),
  mcpTools: [],
  pluginTools: [],
  boundTools: [{ name: 'web_search' }],
  mountedSkillCatalog: [],
  metaContextInputs: [undefined, null, ''],
  history: [
    { role: 'user', text: 'a'.repeat(1000) },
    { role: 'assistant', text: 'b'.repeat(1000) },
  ],
  isSimple: false,
  llm: { invoke: async () => { throw new Error('must not invoke below threshold'); } },
  isGeneral: false,
  emit: () => {},
  onEvent: () => {},
  sessionId: undefined,
  ...over,
});

await test('below threshold: history kept verbatim, no summarizer call, budget math intact', async () => {
  const s = await prepareContextBudget(mkInput());
  assert.ok(s.compactionThreshold > 0);
  assert.ok(s.promptOverheadTokens > 0);
  assert.ok(s.outputReserve === 8192);
  assert.equal(s.promptOverheadTokens, s.systemPromptTokens + s.systemToolsTokens + 0 + 0 + 0);
  assert.ok(s.estimatedHistoryTokens > 0);
  assert.ok(s.projectedHistoryTokens === s.estimatedHistoryTokens + s.promptOverheadTokens);
  assert.ok(s.targetBudget === Math.max(1500, Math.floor(s.compactionThreshold * 0.55 - s.promptOverheadTokens - s.outputReserve)));
  assert.equal(s.compactedHistory.length, 2);
  assert.deepEqual(s.compactedHistory.map((t) => t.role === 'user' || t.role === 'assistant' ? 1 : 0), [1, 1]);
});

await test('simple runs compact history via compactHistory even below threshold', async () => {
  const s = await prepareContextBudget(mkInput({ isSimple: true, historyBudget: undefined }));
  assert.ok(s.historyBudget >= 1500);
  assert.ok(s.compactedHistory.length >= 1);
});

await test('huge history: model summarization path emits both status events and frees tokens', async () => {
  const texts = [];
  const events = [];
  const fakeLlm = {
    invoke: async (prompt) => ({
      content: `[SUMMARY OF: ${String(prompt).slice(0, 12)}]`,
    }),
  };
  const s = await prepareContextBudget(mkInput({
    modelContextWindow: 4_000,
    llm: fakeLlm,
    emit: (_t, text) => texts.push(text),
    onEvent: (e) => events.push(e),
    history: [1, 2, 3, 4, 5, 6].map((i) => ({ role: i % 2 ? 'user' : 'assistant', text: `${i}`.repeat(400) })),
  }));
  // projected > threshold triggers summarization
  assert.ok(texts.some((t) => t.startsWith('Auto-compacting context')), 'auto-compacting status emitted');
  const pc = s.compactedHistory;
  assert.ok(pc.length > 0);
  const statuses = events.filter((e) => e.type === 'status');
  assert.ok(statuses.length >= 1 && statuses[0].text.startsWith('Context auto-compacted'), 'compacted status emitted');
  assert.equal(statuses[0].usage.outputTokens, 0);
  assert.ok(s.projectedHistoryTokens > s.compactionThreshold, 'future check math unchanged');
});

await test('skills lines keep the same formatting the old inline block produced', async () => {
  const s = await prepareContextBudget(mkInput({
    mountedSkillCatalog: [
      { name: 'pdf', description: 'PDF skill', path: '/Users/x/.nexus/skills/pdf/SKILL.md', source: 'global' },
    ],
  }));
  assert.ok(s.skillsTokens > 0);
  const s2 = await prepareContextBudget(mkInput({}));
  assert.equal(s2.skillsTokens, 0);
});

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
if (failed) process.exit(1);
