#!/usr/bin/env node
// Nexus Agent CLI runner: executes tasks from the command line,
// supports interactive REPL mode (-i), session continuation (--session, --continue),
// session listing (--list-sessions), and structured JSONL event streaming (--json).
//
// Usage:
//   node scripts/agent-cli.mjs --project . --mode auto --request "Fix the failing test"
//   node scripts/agent-cli.mjs --project . --interactive
//   node scripts/agent-cli.mjs --project . --continue --request "Continue with next step"
//   node scripts/agent-cli.mjs --project . --list-sessions

import { parseArgs } from "node:util";
import path from "node:path";
import readline from "node:readline";
import { selectConfiguredProvider } from "./provider-selection.mjs";

const usage = () => {
  process.stderr.write(
    "Usage: nexus-agent --project <root> [--request <task>] [--interactive|-i] [--mode plan|ask|auto|full] [--session <id>] [--continue] [--list-sessions] [--json] [--without-assets skills,rules,agents,commands] [--provider <id|label>] [--model <name>] [--api-key <key>] [--base-url <url>]\n"
  );
};

const { values } = parseArgs({
  options: {
    project: { type: "string", default: "." },
    mode: { type: "string", default: "auto" },
    request: { type: "string", short: "q" },
    provider: { type: "string" },
    model: { type: "string" },
    "api-key": { type: "string" },
    "base-url": { type: "string" },
    "task-kind": { type: "string", default: "code" },
    "without-assets": { type: "string", default: "" },
    interactive: { type: "boolean", short: "i", default: false },
    session: { type: "string" },
    continue: { type: "boolean", default: false },
    "list-sessions": { type: "boolean", default: false },
    json: { type: "boolean", default: false },
  },
});

const { parseDisabledPromptAssets } = await import("../dist-electron/prompt-assets.js");
let disabledPromptAssets;
try {
  disabledPromptAssets = parseDisabledPromptAssets(values["without-assets"]);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(3);
}

let activeMode = ["plan", "ask", "auto", "full"].includes(String(values.mode)) ? values.mode : "auto";
const taskKind = String(values["task-kind"] || "code");
if (!["code", "general"].includes(taskKind)) {
  process.stderr.write(`Unknown task kind "${taskKind}". Choose code or general.\n`);
  process.exit(3);
}

const projectRoot = path.resolve(String(values.project));

const { listProviders, listProjects, appendSessionMessages } = await import("../dist-electron/store.js");
const { getAgentBackend, endCommandRun } = await import("../dist-electron/command-service.js");
const { runProjectAgent } = await import("../dist-electron/agent-service.js");

if (values["list-sessions"]) {
  const projects = await listProjects().catch(() => []);
  const proj = projects.find((p) => path.resolve(p.root) === projectRoot) || projects[0];
  if (!proj || !proj.sessions || proj.sessions.length === 0) {
    process.stdout.write("No sessions found for this project.\n");
    process.exit(0);
  }
  process.stdout.write(`Sessions for ${proj.name} (${proj.root}):\n`);
  for (const s of proj.sessions) {
    process.stdout.write(`- [${s.id}] ${s.title || "Untitled"} (${new Date(s.updatedAt || s.createdAt).toLocaleString()})\n`);
  }
  process.exit(0);
}

if (!values.interactive && (!values.request || !String(values.request).trim())) {
  usage();
  process.exit(3);
}

async function resolveProvider() {
  const explicitKey = String(values["api-key"] || process.env.NEXUS_API_KEY || process.env.OPENAI_API_KEY || "");
  const modelFlag = String(values.model || process.env.NEXUS_MODEL || "");
  const baseUrlFlag = String(values["base-url"] || process.env.NEXUS_BASE_URL || "");

  let provider = null;
  if (values.provider || !explicitKey) {
    const all = await listProviders().catch(() => []);
    provider = selectConfiguredProvider(all, values.provider);
    if (values.provider && !provider) {
      process.stderr.write(`No configured provider matches "${values.provider}".\n`);
      process.exit(3);
    }
  }

  if (provider && explicitKey) provider = { ...provider, apiKey: explicitKey };
  if (!provider) {
    if (!explicitKey) {
      process.stderr.write(
        "No usable API key: configure a provider in the Nexus app (plaintext keys work headless), pass --api-key, or set NEXUS_API_KEY / OPENAI_API_KEY.\n"
      );
      process.exit(3);
    }
    provider = {
      id: "headless",
      label: "Headless",
      provider: process.env.NEXUS_PROVIDER_KIND || "openai",
      apiKey: explicitKey,
      baseUrl: baseUrlFlag || undefined,
      models: [],
    };
  }
  const model = modelFlag || provider.models?.[0] || process.env.OPENAI_MODEL || "gpt-4.1-mini";
  return { provider, model };
}

let provider;
let activeModel;
try {
  ({ provider, model: activeModel } = await resolveProvider());
} catch (error) {
  process.stderr.write(`Provider setup failed: ${error?.message || error}\n`);
  process.exit(3);
}

// Find or register project record
const allProjects = await listProjects().catch(() => []);
let matchedProject = allProjects.find((p) => path.resolve(p.root) === projectRoot);
if (!matchedProject) {
  matchedProject = {
    id: "headless",
    name: path.basename(projectRoot),
    root: projectRoot,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    memory: "",
    sessions: [],
  };
}

let activeSession = null;
if (values.session && matchedProject.sessions?.length) {
  activeSession = matchedProject.sessions.find((s) => s.id === values.session || s.id.includes(values.session)) || null;
} else if (values.continue && matchedProject.sessions?.length) {
  activeSession = matchedProject.sessions[0];
}

let conversationHistory = [];
if (activeSession?.messages?.length) {
  conversationHistory = activeSession.messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      role: m.role,
      text: m.text,
    }));
}

let backend;
async function refreshBackend() {
  ({ backend } = await getAgentBackend(matchedProject, {
    runId: activeSession?.id || "headless",
    readOnly: activeMode === "plan",
    fullAccess: activeMode === "full",
  }));
}
try {
  await refreshBackend();
} catch (error) {
  process.stderr.write(`Workspace setup failed: ${error?.message || error}\n`);
  process.exit(3);
}

process.on("exit", () => endCommandRun(activeSession?.id || "headless"));

async function executeTurn(userPrompt) {
  const userCreatedAt = new Date().toISOString();
  conversationHistory.push({ role: "user", text: userPrompt });

  const isJsonOutput = values.json || !values.interactive;
  let streamedTokens = false;

  const result = await runProjectAgent({
    projectRoot,
    telemetryRoot: projectRoot,
    sessionId: activeSession?.id || "headless",
    request: userPrompt,
    settings: { provider, model: activeModel, baseUrl: provider.baseUrl },
    memory: { projectMemory: matchedProject.memory || "", sessionMemory: activeSession?.memory || "" },
    history: conversationHistory.slice(0, -1),
    mode: activeMode,
    agentBackend: backend,
    onEvent: (event) => {
      if (isJsonOutput) {
        process.stdout.write(`${JSON.stringify(event)}\n`);
      } else {
        if (event.type === "thinking" && event.text) {
          process.stderr.write(`\x1b[90m${event.text}\x1b[0m`);
        } else if (event.type === "tool") {
          process.stderr.write(`\n\x1b[36m⚙ ${event.text}\x1b[0m\n`);
        } else if (event.type === "token" && event.text) {
          streamedTokens = true;
          process.stdout.write(event.text);
        } else if (event.type === "assistant" && event.text && !streamedTokens) {
          process.stdout.write(event.text);
        }
      }
    },
    isCancelled: () => false,
    taskKind,
    skillsMode: taskKind === "general" ? "home" : "code",
    disabledPromptAssets,
  });

  const assistantReply = String(result.response || "");
  conversationHistory.push({ role: "assistant", text: assistantReply });

  // Append only the new turn to the persistent session so original timestamps and event items remain intact
  if (matchedProject.id !== "headless" && activeSession) {
    try {
      await appendSessionMessages(matchedProject.id, activeSession.id, [
        { role: "user", text: userPrompt, createdAt: userCreatedAt },
        { role: "assistant", text: assistantReply, createdAt: new Date().toISOString(), usage: result.usage },
      ]);
    } catch { /* ignore update error in CLI */ }
  }

  return result;
}

if (values.interactive) {
  process.stderr.write(`\x1b[1m\x1b[34m=== Nexus Agent REPL ===\x1b[0m\n`);
  process.stderr.write(`Project: ${projectRoot}\n`);
  process.stderr.write(`Mode: ${activeMode} | Model: ${activeModel}\n`);
  if (activeSession) {
    process.stderr.write(`Resumed Session: ${activeSession.id} (${activeSession.title})\n`);
  }
  process.stderr.write(`Commands: /help, /mode <mode>, /model <name>, /diff, /quit\n\n`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    prompt: "\x1b[32mnexus > \x1b[0m",
  });

  rl.prompt();

  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      rl.prompt();
      return;
    }

    if (trimmed === "/quit" || trimmed === "/exit") {
      process.stderr.write("Goodbye.\n");
      process.exit(0);
    } else if (trimmed === "/help") {
      process.stderr.write("Available commands:\n");
      process.stderr.write("  /diff           Show current Git diff\n");
      process.stderr.write("  /mode <mode>    Switch mode (plan | ask | auto | full)\n");
      process.stderr.write("  /model <name>   Switch active model\n");
      process.stderr.write("  /session        Print current session ID\n");
      process.stderr.write("  /quit, /exit    Exit REPL\n");
      rl.prompt();
      return;
    } else if (trimmed === "/diff") {
      const diffRes = await backend.execute("git status --short && git diff --stat").catch(() => null);
      process.stderr.write((diffRes?.output || "No changes.") + "\n");
      rl.prompt();
      return;
    } else if (trimmed.startsWith("/mode ")) {
      const nextMode = trimmed.slice(6).trim();
      if (["plan", "ask", "auto", "full"].includes(nextMode)) {
        activeMode = nextMode;
        await refreshBackend().catch(() => {});
        process.stderr.write(`Mode switched to: ${activeMode}\n`);
      } else {
        process.stderr.write("Valid modes: plan, ask, auto, full\n");
      }
      rl.prompt();
      return;
    } else if (trimmed.startsWith("/model ")) {
      activeModel = trimmed.slice(7).trim();
      process.stderr.write(`Model switched to: ${activeModel}\n`);
      rl.prompt();
      return;
    } else if (trimmed === "/session") {
      process.stderr.write(`Session ID: ${activeSession?.id || "None (ephemeral)"}\n`);
      rl.prompt();
      return;
    }

    try {
      const res = await executeTurn(trimmed);
      if (!values.json) {
        process.stderr.write(`\n\x1b[90m[verification: ${res.verification}]\x1b[0m\n\n`);
      }
    } catch (err) {
      process.stderr.write(`\nError: ${err?.message || err}\n\n`);
    }
    rl.prompt();
  });

  rl.on("close", () => {
    process.exit(0);
  });
} else {
  // One-shot execution
  let result = null;
  try {
    result = await executeTurn(String(values.request));
  } catch (error) {
    process.stderr.write(`Run failed: ${error?.message || error}\n`);
    process.exit(3);
  }

  process.stderr.write(
    `\n[verification: ${result.verification}] ${String(result.response || "").slice(0, 600)}${String(result.response || "").length > 600 ? "…" : ""}\n`
  );
  process.stdout.write(
    `${JSON.stringify({ type: "result", response: result.response, verification: result.verification, usage: result.usage, disabledPromptAssets })}\n`
  );
  process.exit(result.verification === "passed" || result.verification === "none" ? 0 : result.verification === "interrupted" ? 2 : 1);
}
