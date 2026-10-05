// State-split scenario: runs in a child process with APPDATA pointed at a
// scratch dir so the real nexus-state.json is never touched. Invoked by
// state-split.test.mjs — one scenario per process (the store caches state at
// module scope, so scenarios need process isolation).
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const scenario = process.env.SCENARIO;
const appdata = process.env.SCRATCH_APPDATA;
assert.ok(scenario && appdata, 'SCENARIO and SCRATCH_APPDATA required');
process.env.APPDATA = appdata;

const { upsertProject, createSession, appendSessionMessages, getSession, listProjects, getProject } = await import('../dist-electron/store.js');

const statePath = path.join(appdata, 'nexus', 'nexus-state.json');
const sessionsRoot = path.join(appdata, 'nexus', 'sessions');

if (scenario === 'basic-split') {
  const project = await upsertProject({ name: 'p1', root: appdata });
  const pid = project.id;
  const session = await createSession(project.id, 'split test');
  await appendSessionMessages(project.id, session.id, [
    { role: 'user', text: 'hello', createdAt: new Date().toISOString() },
    { role: 'assistant', text: 'hi there', createdAt: new Date().toISOString() },
  ]);

  // State file: index row only, version stamped.
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.equal(state.stateVersion, 2, 'state file carries stateVersion 2');
  const stored = state.projects.find((p) => p.id === pid).sessions.find((s) => s.id === session.id);
  assert.equal(stored.messages.length, 0, 'state file holds no transcript');

  // Per-session file holds the transcript.
  const file = path.join(sessionsRoot, pid, `${session.id}.json`);
  const data = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(data.messages.length, 2);
  assert.equal(data.messages[1].text, 'hi there');

  // API boundary hydrates transparently.
  const hydrated = await getSession(project.id, session.id);
  assert.equal(hydrated.messages.length, 2);
  assert.ok(hydrated.usage && hydrated.usage.totalTokens >= 0, 'usage recomputed on hydration');
  console.log('OK basic-split');
  process.exit(0);
}

if (scenario === 'cold-hydration') {
  // A session file written by a "previous app run" is picked up with no cache.
  const project = await upsertProject({ name: 'p2', root: appdata });
  const session = await createSession(project.id, 'cold');
  const file = path.join(sessionsRoot, project.id, `${session.id}.json`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ version: 1, messages: [
    { role: 'user', text: 'from an earlier run', createdAt: new Date().toISOString() },
  ] }), 'utf8');

  const hydrated = await getSession(project.id, session.id);
  assert.equal(hydrated.messages.length, 1);
  assert.equal(hydrated.messages[0].text, 'from an earlier run');
  console.log('OK cold-hydration');
  process.exit(0);
}

if (scenario === 'migration') {
  // Craft a v1 state file with embedded transcripts; loading migrates it.
  const legacy = {
    projects: [{
      id: 'legacy-p', name: 'legacy', root: appdata, createdAt: '', updatedAt: '', memory: '',
      sessions: [{
        id: 'legacy-s1', title: 'old chat', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', memory: '',
        messages: [
          { role: 'user', text: 'old question', createdAt: '2026-01-01T00:00:00Z' },
          { role: 'assistant', text: 'old answer', createdAt: '2026-01-01T00:00:01Z' },
        ],
      }],
    }],
    providers: [],
    embeddingProviders: [],
    homeSessions: [{
      id: 'legacy-home', title: 'old home chat', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', memory: '',
      messages: [{ role: 'user', text: 'home question', createdAt: '2026-01-01T00:00:00Z' }],
    }],
  };
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(legacy, null, 2), 'utf8');

  const projects = await listProjects();
  const migrated = projects.find((p) => p.id === 'legacy-p').sessions.find((s) => s.id === 'legacy-s1');
  assert.equal(migrated.messages.length, 2, 'index row hydrated from the new file');

  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.equal(state.stateVersion, 2, 'state migrated to version 2');
  assert.equal(state.projects[0].sessions[0].messages.length, 0, 'transcript removed from state');
  const backup = JSON.parse(await fs.readFile(`${statePath}.pre-split`, 'utf8'));
  assert.equal(backup.projects[0].sessions[0].messages.length, 2, 'backup keeps the embedded transcript');
  assert.ok(backup.stateVersion === undefined, 'backup is pre-split');

  const data = JSON.parse(await fs.readFile(path.join(sessionsRoot, 'legacy-p', 'legacy-s1.json'), 'utf8'));
  assert.equal(data.messages.length, 2);
  const homeData = JSON.parse(await fs.readFile(path.join(sessionsRoot, 'home', 'legacy-home.json'), 'utf8'));
  assert.equal(homeData.messages.length, 1);
  console.log('OK migration');
  process.exit(0);
}

throw new Error(`unknown scenario ${scenario}`);
