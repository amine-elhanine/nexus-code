import test from "node:test";
import assert from "node:assert/strict";

import {
  truncateSessionFromMessage,
  truncateHomeSessionFromMessage,
  forkSessionAtMessage,
  forkHomeSessionAtMessage,
  createSession,
  createHomeSession,
  appendHomeSessionMessages,
  upsertProject,
  deleteProject,
  deleteHomeSession,
  updateSession,
} from "../dist-electron/store.js";

test("session branching and truncation", async (t) => {
  const codeProject = await upsertProject({ name: "Branch Test Proj", root: process.cwd() });
  const codeSession = await createSession(codeProject.id, "Branch Code Session");

  // Populate code session with 5 messages
  await updateSession(codeProject.id, codeSession.id, {
    messages: [
      { role: "user", text: "Turn 1", createdAt: new Date().toISOString() },
      { role: "assistant", text: "Answer 1", createdAt: new Date().toISOString() },
      { role: "user", text: "Turn 2", createdAt: new Date().toISOString() },
      { role: "assistant", text: "Answer 2", createdAt: new Date().toISOString() },
      { role: "user", text: "Turn 3", createdAt: new Date().toISOString() },
    ],
  });

  const homeSession = await createHomeSession("Branch Home Session");
  await appendHomeSessionMessages(homeSession.id, [
    { role: "user", text: "Home 1", createdAt: new Date().toISOString() },
    { role: "assistant", text: "Reply 1", createdAt: new Date().toISOString() },
    { role: "user", text: "Home 2", createdAt: new Date().toISOString() },
    { role: "assistant", text: "Reply 2", createdAt: new Date().toISOString() },
  ]);

  await t.test("truncateSessionFromMessage truncates messages from index", async () => {
    const updated = await truncateSessionFromMessage(codeProject.id, codeSession.id, 2);
    assert.equal(updated.messages.length, 2);
    assert.equal(updated.messages[0].text, "Turn 1");
    assert.equal(updated.messages[1].text, "Answer 1");
  });

  await t.test("forkSessionAtMessage creates branched session with history up to index", async () => {
    const forked = await forkSessionAtMessage(codeProject.id, codeSession.id, 1, "Branched Code Session");
    assert.notEqual(forked.id, codeSession.id);
    assert.equal(forked.title, "Branched Code Session");
    assert.equal(forked.messages.length, 2);
    assert.equal(forked.messages[0].text, "Turn 1");
    assert.equal(forked.messages[1].text, "Answer 1");
  });

  await t.test("truncateHomeSessionFromMessage truncates home session", async () => {
    const updated = await truncateHomeSessionFromMessage(homeSession.id, 2);
    assert.equal(updated.messages.length, 2);
    assert.equal(updated.messages[0].text, "Home 1");
    assert.equal(updated.messages[1].text, "Reply 1");
  });

  await t.test("forkHomeSessionAtMessage forks home session cleanly", async () => {
    const forked = await forkHomeSessionAtMessage(homeSession.id, 1, "Branched Home");
    assert.notEqual(forked.id, homeSession.id);
    assert.equal(forked.title, "Branched Home");
    assert.equal(forked.messages.length, 2);
    assert.equal(forked.messages[0].text, "Home 1");
    assert.equal(forked.messages[1].text, "Reply 1");
  });

  // Cleanup
  await deleteProject(codeProject.id);
  await deleteHomeSession(homeSession.id);
});
