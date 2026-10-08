import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

// Test against the compiled or source store methods
import {
  listProjects,
  upsertProject,
  deleteProject,
  listSessions,
  createSession,
  listHomeSessions,
  createHomeSession,
  getHomeSession,
  updateHomeSession,
  appendHomeSessionMessages,
  deleteHomeSession,
} from "../dist-electron/store.js";

test("Home Mode Isolation: dedicated home sessions and zero home projects", async () => {
  // 1. Create a home session
  const homeSession = await createHomeSession("My Dedicated Home Chat");
  assert.ok(homeSession.id.startsWith("homesess_"), "Home session should have homesess prefix");
  assert.equal(homeSession.title, "My Dedicated Home Chat");

  // 2. List home sessions
  const homeSessions = await listHomeSessions();
  const foundHome = homeSessions.find((s) => s.id === homeSession.id);
  assert.ok(foundHome, "Created home session must be listed in homeSessions");

  // 3. Verify listProjects() never contains a project with id 'home'
  const projects = await listProjects();
  const hasHomeProject = projects.some((p) => p.id === "home");
  assert.equal(hasHomeProject, false, "listProjects() must NOT contain a project with id 'home'");

  // 4. Update home session
  await updateHomeSession(homeSession.id, { title: "Renamed Home Chat" });
  const updated = await getHomeSession(homeSession.id);
  assert.equal(updated?.title, "Renamed Home Chat");

  // 5. Append messages to home session
  await appendHomeSessionMessages(homeSession.id, [
    { role: "user", text: "Hello Home Assistant!", createdAt: new Date().toISOString() },
    { role: "assistant", text: "Hello! How can I help you today?", createdAt: new Date().toISOString() },
  ]);
  const withMessages = await getHomeSession(homeSession.id);
  assert.equal(withMessages?.messages.length, 2);

  // 6. Verify Code Mode projects and sessions are separate
  const codeProject = await upsertProject({ name: "My Code Project", root: process.cwd() });
  assert.notEqual(codeProject.id, "home");
  const codeSession = await createSession(codeProject.id, "Code Task 1");

  const refreshedHome = await listHomeSessions();
  const refreshedCodeSessions = await listSessions(codeProject.id);

  // Ensure code session is NOT in home sessions
  assert.equal(refreshedHome.some((s) => s.id === codeSession.id), false);
  // Ensure home session is NOT in code sessions
  assert.equal(refreshedCodeSessions.some((s) => s.id === homeSession.id), false);

  // 7. Delete home session
  await deleteHomeSession(homeSession.id);
  const afterDelete = await listHomeSessions();
  assert.equal(afterDelete.some((s) => s.id === homeSession.id), false);

  // Clean up code project
  await deleteProject(codeProject.id);
});

test("Home Mode Skill Formatting: clean labels and path abstraction", async () => {
  const { extractSkillNameFromPath, describeToolCall } = await import("../dist-electron/agent-service.js");

  assert.equal(extractSkillNameFromPath("/system-skills/all/pdf/SKILL.md"), "pdf");
  assert.equal(extractSkillNameFromPath("/system-skills/home/remotion-video-creation/SKILL.md"), "remotion-video-creation");
  assert.equal(extractSkillNameFromPath(".nexus/skills/custom-skill/SKILL.md"), "custom-skill");
  assert.equal(extractSkillNameFromPath("C:\\Users\\user\\.nexus\\skills\\test-skill\\SKILL.md"), "test-skill");

  // Verify describeToolCall produces clean "Consulting skill: <name>"
  const desc = describeToolCall("read_file", { file_path: "/system-skills/all/pdf/SKILL.md", offset: 0, limit: 1000 });
  assert.equal(desc, "Consulting skill: pdf");

  const descRange = describeToolCall("read_file_range", { filePath: "/system-skills/all/pdf/SKILL.md", startLine: 1, endLine: 200 });
  assert.equal(descRange, "Consulting skill: pdf");

  // Regular files should still retain file:line description
  const normalDesc = describeToolCall("read_file_range", { filePath: "src/App.tsx", startLine: 1, endLine: 50 });
  assert.equal(normalDesc, "src/App.tsx:1-50");
});

test("Home Mode Continuity: complexity classification and continuation phrases", async () => {
  const { classifyTaskComplexity, isContinueRequest, inferHomeTaskContract } = await import("../dist-electron/agent-service.js");

  // Document and PDF requests must route to 'complex' so they are not trapped in 3-call efficiency mode
  assert.equal(classifyTaskComplexity("create a pdf report on the US-Iran war"), "complex");
  assert.equal(classifyTaskComplexity("generate a comprehensive pdf"), "complex");
  assert.equal(classifyTaskComplexity("write a word report for the meeting"), "complex");
  assert.equal(classifyTaskComplexity("continue working on the pdf i asked for"), "complex");
  assert.equal(classifyTaskComplexity("Add token validation to the API"), "complex");
  assert.equal(classifyTaskComplexity("Change the database schema for accounts"), "complex");
  assert.equal(classifyTaskComplexity("Add rate limiting to requests"), "complex");
  assert.equal(classifyTaskComplexity("Add a tooltip to the settings icon"), "simple");

  // Affirmative and continuation phrases must be recognized as continue requests
  assert.equal(isContinueRequest("ok"), true);
  assert.equal(isContinueRequest("okay"), true);
  assert.equal(isContinueRequest("sure"), true);
  assert.equal(isContinueRequest("go ahead"), true);
  assert.equal(isContinueRequest("proceed"), true);
  assert.equal(isContinueRequest("yes"), true);
  assert.equal(isContinueRequest("do it"), true);
  assert.equal(isContinueRequest("please do it"), true);
  assert.equal(isContinueRequest("continue"), true);
  assert.equal(isContinueRequest("finish the task"), true);
  assert.equal(isContinueRequest("finish it"), true);
  assert.equal(isContinueRequest("pick up where you left off"), true);

  // Non-continue requests should not be flagged as continue
  assert.equal(isContinueRequest("What is the capital of France?"), false);
  assert.equal(isContinueRequest("create a new file called test.txt"), false);

  // Home uses a generic output contract, not a PDF/course-specific branch.
  assert.deepEqual(inferHomeTaskContract("read the CrewAI docs and generate me a PDF course"), {
    expectsOutput: true,
    needsResearch: true,
    expectedFormats: ["pdf"],
  });
  assert.deepEqual(inferHomeTaskContract("what is CrewAI?"), {
    expectsOutput: false,
    needsResearch: false,
    expectedFormats: [],
  });
});
