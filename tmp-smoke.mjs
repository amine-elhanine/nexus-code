import path from "node:path";
import os from "node:os";
import { app } from "electron";
import { testMcpServer } from "./dist-electron/mcp-service.js";
import { createSkill, listSkills } from "./dist-electron/skills-service.js";

app.whenReady().then(async () => {
  try {
    const test = await testMcpServer({ name: "echo", transport: "stdio", command: "node", args: [path.resolve("tmp-mcp-server.mjs")] });
    console.log("MCP stdio test:", JSON.stringify(test));
    if (!test.ok || !test.tools.includes("echo")) throw new Error("echo tool not discovered");

    const projectRoot = path.join(os.tmpdir(), `forgepilot-smoke-${Date.now()}`);
    const skill = await createSkill(projectRoot, { name: "smoke-skill", description: "smoke test skill", scope: "project" });
    console.log("Skill created:", skill.name, "at", skill.path);
    const skills = await listSkills(projectRoot);
    console.log("Skills listed:", skills.map((s) => `${s.source}:${s.name}`).join(", "));

    const globalSkill = await createSkill(projectRoot, { name: `global-skill-${Date.now().toString(36)}`, scope: "global" });
    console.log("Global skill created:", globalSkill.name);
    const all = await listSkills(projectRoot);
    if (!all.some((s) => s.name === globalSkill.name && s.source === "global")) throw new Error("new global skill not listed");
    if (!all.some((s) => s.name === "smoke-skill" && s.source === "project")) throw new Error("project skill not listed");

    // Verify agent construction with the composite skills backend (no model call).
    const { createDeepAgent, CompositeBackend, FilesystemBackend } = await import("deepagents");
    const { ChatOpenAI } = await import("@langchain/openai");
    const sandboxBackend = new FilesystemBackend({ rootDir: projectRoot, virtualMode: true });
    const agentBackend = new CompositeBackend(sandboxBackend, { "/global-skills": new FilesystemBackend({ rootDir: path.join(os.tmpdir(), "forgepilot-global-skills"), virtualMode: true }) });
    const agent = await createDeepAgent({
      model: new ChatOpenAI({ apiKey: "not-needed", model: "gpt-4.1-mini" }),
      backend: agentBackend,
      skills: [".deepagents/skills", "/global-skills"],
      tools: [],
    });
    console.log("Agent constructed with composite skills backend:", Boolean(agent));

    console.log("SMOKE OK");
  } catch (error) {
    console.error("SMOKE FAIL:", error);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
