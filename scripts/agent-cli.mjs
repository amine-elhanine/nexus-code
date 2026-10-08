#!/usr/bin/env node
// Headless agent runner: executes ONE agent task from the command line,
// streams the live AgentEvent feed as JSONL on stdout, and exits with the
// verification outcome — so Nexus runs in CI and scripts.
//
// Usage:
//   node scripts/agent-cli.mjs --project . --mode auto --request "Fix the failing test"
//   node scripts/agent-cli.mjs --project . --task-kind general --request "Create a report.md"
//
// Provider selection (first match wins):
//   1. --provider <id|label> from the app's configured providers (the shared
//      nexus-state.json); without an explicit provider, selects a usable
//      plaintext-key provider, keyless Ollama, or endpoint-configured custom.
//      Keys encrypted by the app's safeStorage cannot be decrypted headless —
//      pass --api-key or NEXUS_API_KEY instead.
//   2. --api-key / NEXUS_API_KEY / OPENAI_API_KEY with NEXUS_PROVIDER_KIND
//      (default "openai") and NEXUS_BASE_URL.
//
// Exit codes: 0 = verification passed or none needed, 1 = verification
// failed, 2 = interrupted (budget/doom-loop), 3 = configuration error.
// Risky commands are DENIED headless unless NEXUS_APPROVAL=allow.
import { parseArgs } from "node:util";
import path from "node:path";
import { selectConfiguredProvider } from "./provider-selection.mjs";

const usage = () => {
  process.stderr.write(
    "Usage: nexus-agent --project <root> --request <task> [--mode plan|ask|auto] [--without-assets skills,rules,agents,commands] [--provider <id|label>] [--model <name>] [--api-key <key>] [--base-url <url>]\n"
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

const mode = ["plan", "ask", "auto"].includes(String(values.mode)) ? values.mode : "auto";
const taskKind = String(values["task-kind"] || "code");
if (!["code", "general"].includes(taskKind)) {
  process.stderr.write(`Unknown task kind "${taskKind}". Choose code or general.\n`);
  process.exit(3);
}
if (!values.request || !String(values.request).trim()) {
  usage();
  process.exit(3);
}
const projectRoot = path.resolve(String(values.project));

const { listProviders } = await import("../dist-electron/store.js");
const { getAgentBackend, endCommandRun } = await import("../dist-electron/command-service.js");
const { runProjectAgent } = await import("../dist-electron/agent-service.js");

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
let model;
try {
  ({ provider, model } = await resolveProvider());
} catch (error) {
  process.stderr.write(`Provider setup failed: ${error?.message || error}\n`);
  process.exit(3);
}

const projectRecord = {
  id: "headless",
  name: path.basename(projectRoot),
  root: projectRoot,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  memory: "",
  sessions: [],
};

let backend;
try {
  ({ backend } = await getAgentBackend(projectRecord, { runId: "headless" }));
} catch (error) {
  process.stderr.write(`Workspace setup failed: ${error?.message || error}\n`);
  process.exit(3);
}

process.on("exit", () => endCommandRun("headless"));

let result = null;
try {
  result = await runProjectAgent({
    projectRoot,
    telemetryRoot: projectRoot,
    sessionId: undefined,
    request: String(values.request),
    settings: { provider, model, baseUrl: provider.baseUrl },
    memory: { projectMemory: "", sessionMemory: "" },
    history: [],
    mode,
    agentBackend: backend,
    onEvent: (event) => {
      // JSONL event stream on stdout; the human summary goes to stderr.
      process.stdout.write(`${JSON.stringify(event)}\n`);
    },
    isCancelled: () => false,
    taskKind,
    skillsMode: taskKind === "general" ? "home" : "code",
    disabledPromptAssets,
  });
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
