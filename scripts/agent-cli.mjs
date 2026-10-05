#!/usr/bin/env node
// Headless Code-mode runner: executes ONE agent task from the command line,
// streams the live AgentEvent feed as JSONL on stdout, and exits with the
// verification outcome — so Nexus runs in CI and scripts.
//
// Usage:
//   node scripts/agent-cli.mjs --project . --mode auto --request "Fix the failing test"
//
// Provider selection (first match wins):
//   1. --provider <id|label> from the app's configured providers (the shared
//      nexus-state.json); keys encrypted by the app's safeStorage cannot be
//      decrypted headless — pass --api-key or NEXUS_API_KEY instead.
//   2. --api-key / NEXUS_API_KEY / OPENAI_API_KEY with NEXUS_PROVIDER_KIND
//      (default "openai") and NEXUS_BASE_URL.
//
// Exit codes: 0 = verification passed or none needed, 1 = verification
// failed, 2 = interrupted (budget/doom-loop), 3 = configuration error.
// Risky commands are DENIED headless unless NEXUS_APPROVAL=allow.
import { parseArgs } from "node:util";
import path from "node:path";

const usage = () => {
  process.stderr.write(
    "Usage: nexus-agent --project <root> --request <task> [--mode plan|ask|auto] [--provider <id|label>] [--model <name>] [--api-key <key>] [--base-url <url>]\n"
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
  },
});

const mode = ["plan", "ask", "auto"].includes(String(values.mode)) ? values.mode : "auto";
if (!values.request || !String(values.request).trim()) {
  usage();
  process.exit(3);
}
const projectRoot = path.resolve(String(values.project));

const { listProviders } = await import("../dist-electron/store.js");
const { getAgentBackend, endCommandRun } = await import("../dist-electron/command-service.js");
const { runProjectAgent } = await import("../dist-electron/agent-service.js");

const ENCRYPTED_PREFIX = "safeStorage:v1:";

async function resolveProvider() {
  const explicitKey = String(values["api-key"] || process.env.NEXUS_API_KEY || process.env.OPENAI_API_KEY || "");
  const modelFlag = String(values.model || process.env.NEXUS_MODEL || "");
  const baseUrlFlag = String(values["base-url"] || process.env.NEXUS_BASE_URL || "");

  let provider = null;
  if (values.provider) {
    const wanted = String(values.provider).toLowerCase();
    const all = await listProviders().catch(() => []);
    provider = all.find((p) => p.id?.toLowerCase() === wanted || p.label?.toLowerCase() === wanted) ?? null;
    if (!provider) {
      process.stderr.write(`No configured provider matches "${values.provider}".\n`);
      process.exit(3);
    }
  } else if (!explicitKey) {
    // Pick the first configured provider with a key this headless process can
    // actually use (plaintext or legacy); safeStorage-encrypted keys are tied
    // to the desktop app's OS profile.
    const all = await listProviders().catch(() => []);
    provider = all.find((p) => p.apiKey && !p.apiKey.startsWith(ENCRYPTED_PREFIX)) ?? null;
    if (provider && provider.apiKey.startsWith(ENCRYPTED_PREFIX)) provider = null;
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
    taskKind: "code",
    skillsMode: "code",
  });
} catch (error) {
  process.stderr.write(`Run failed: ${error?.message || error}\n`);
  process.exit(3);
}

process.stderr.write(
  `\n[verification: ${result.verification}] ${String(result.response || "").slice(0, 600)}${String(result.response || "").length > 600 ? "…" : ""}\n`
);
process.stdout.write(
  `${JSON.stringify({ type: "result", response: result.response, verification: result.verification, usage: result.usage })}\n`
);
process.exit(result.verification === "passed" || result.verification === "none" ? 0 : result.verification === "interrupted" ? 2 : 1);
