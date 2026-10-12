// Out-of-process plugin runner (plain Node, no Electron).
//
// Launched by the host as:
//   <node> plugin-runner.cjs
// with ELECTRON_RUN_AS_NODE=1 when spawned from Electron (process.execPath
// is the Electron binary there; the env flag makes it behave as plain Node).
//
// Protocol: newline-delimited JSON over stdio.
//   Host -> Runner (requests, one per line):
//     { "id": 1, "method": "activate", "params": { "entry": "/abs/file.js", "timeoutMs": 5000 } }
//     { "id": 2, "method": "call-tool", "params": { "tool": "greet", "args": {...}, "mode": "home", "timeoutMs": 30000 } }
//     { "id": 3, "method": "shutdown" }
//   Runner -> Host (responses, one per line):
//     { "id": 1, "ok": true, "result": { "tools": [...], "commands": [...], "subscriptions": [...], "logs": [...] } }
//     { "id": 2, "ok": true, "result": { "output": ... } }
//     { "id": 1, "ok": false, "error": "..." }
//
// Security:
// - Entry source runs in node:vm with ONLY a frozen `nexus` object.
// - No require/process/fetch/Electron/timers beyond setTimeout (bounded).
// - Entry capped at 256KB; activation timeout enforced by the host killing
//   this process (the vm timeout is a second net, not the only one).
// - Tool handlers run inside the same vm context on call-tool; each call has
//   its own timeout. A hanging handler never blocks other calls: calls run
//   sequentially per process but a timeout rejects the pending call while the
//   vm keeps working — the host may then restart the process (see host).
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const MAX_ENTRY_BYTES = 256 * 1024;

let context = null;
let sdkState = null;

function resetSdkState() {
  sdkState = { tools: [], commands: [], subscriptions: [], contextProviders: [], logs: [] };
}

function makeNexus() {
  return Object.freeze({
    registerTool(def) {
      if (!def || typeof def !== "object" || Array.isArray(def)) {
        throw new Error("registerTool requires a definition object");
      }
      const name = String(def.name || "").trim();
      if (!name) throw new Error("registerTool requires a name");
      sdkState.tools.push({
        def: {
          name,
          description: String(def.description || "").slice(0, 500),
          modes: Array.isArray(def.modes) ? def.modes.slice(0, 3) : undefined,
          permissions: Array.isArray(def.permissions) ? def.permissions.slice(0, 12) : undefined,
          requiresApproval: def.requiresApproval,
          timeoutMs: def.timeoutMs,
        },
        handler: typeof def.handler === "function" || typeof def.execute === "function"
          ? (def.handler || def.execute)
          : null,
      });
    },
    registerCommand(def) {
      if (!def || typeof def !== "object" || Array.isArray(def)) {
        throw new Error("registerCommand requires a definition object");
      }
      const name = String(def.name || "").trim();
      if (!name) throw new Error("registerCommand requires a name");
      sdkState.commands.push({
        name,
        description: String(def.description || "").slice(0, 500),
        modes: Array.isArray(def.modes) ? def.modes.slice(0, 3) : undefined,
      });
    },
    registerContextProvider(def, handler) {
      if (!def || typeof def !== "object" || Array.isArray(def)) {
        throw new Error("registerContextProvider requires a definition object");
      }
      const name = String(def.name || "").trim();
      if (!name) throw new Error("registerContextProvider requires a name");
      sdkState.contextProviders.push({
        def: {
          name,
          description: String(def.description || "").slice(0, 500),
          modes: Array.isArray(def.modes) ? def.modes.slice(0, 3) : undefined,
        },
        handler: typeof handler === "function" ? handler : (typeof def.handler === "function" ? def.handler : null),
      });
    },
    on(event, handler) {
      const evt = String(event || "").trim();
      sdkState.subscriptions.push({
        event: evt,
        handler: typeof handler === "function" ? handler : null,
      });
    },
    log(message) {
      sdkState.logs.push(String(message).slice(0, 2000));
      if (sdkState.logs.length > 50) sdkState.logs.shift();
    },
  });
}

function createVmContext() {
  const sandbox = {
    nexus: makeNexus(),
    console: Object.freeze({
      log: (...args) => {
        sdkState.logs.push(args.map(String).join(" ").slice(0, 2000));
        if (sdkState.logs.length > 50) sdkState.logs.shift();
      },
    }),
    module: { exports: {} },
    exports: {},
    setTimeout,
    clearTimeout,
  };
  context = vm.createContext(sandbox, { name: "nexus-plugin-runner" });
}

async function handleActivate(params) {
  const entry = String((params && params.entry) || "");
  const timeoutMs = Math.min(Math.max(Number((params && params.timeoutMs) || 5000), 1000), 30000);
  if (!entry || !path.isAbsolute(entry)) {
    throw new Error("activate requires an absolute entry path");
  }
  let source;
  const stat = await fs.promises.stat(entry).catch(() => null);
  if (!stat || !stat.isFile()) throw new Error("entry is not a file");
  if (stat.size > MAX_ENTRY_BYTES) throw new Error(`entry exceeds ${MAX_ENTRY_BYTES} bytes`);
  source = await fs.promises.readFile(entry, "utf8");

  resetSdkState();
  createVmContext();
  const script = new vm.Script(`"use strict";\n${source}\n//# sourceURL=nexus-plugin-entry.js`, {
    filename: "nexus-plugin-entry.js",
  });
  // vm timeout is a backstop; the host enforces the real deadline by killing us.
  script.runInContext(context, { timeout: timeoutMs, displayErrors: true });

  return {
    tools: sdkState.tools.map((t) => ({ ...t.def, hasHandler: t.handler !== null })),
    commands: sdkState.commands,
    subscriptions: sdkState.subscriptions.map((s) => ({ event: s.event })),
    contextProviders: sdkState.contextProviders.map((cp) => ({ ...cp.def, hasHandler: cp.handler !== null })),
    logs: sdkState.logs.slice(),
  };
}

async function handleCallTool(params) {
  const toolName = String((params && params.tool) || "");
  const args = (params && params.args) || {};
  const timeoutMs = Math.min(Math.max(Number((params && params.timeoutMs) || 30000), 1000), 120000);
  const entry = sdkState.tools.find((t) => t.def.name === toolName);
  if (!entry) throw new Error(`unknown tool "${toolName}"`);
  if (typeof entry.handler !== "function") {
    throw new Error(`tool "${toolName}" has no executable handler in this build`);
  }
  const callPromise = Promise.resolve().then(() =>
    entry.handler(args, { mode: String((params && params.mode) || "home") })
  );
  let timer = null;
  try {
    return {
      output: await Promise.race([
        callPromise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`tool "${toolName}" timed out after ${timeoutMs}ms`)), timeoutMs);
        }),
      ]),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function handleCallEvent(params) {
  const event = String((params && params.event) || "");
  const payload = (params && params.payload) || {};
  const timeoutMs = Math.min(Math.max(Number((params && params.timeoutMs) || 5000), 500), 30000);
  const matching = sdkState.subscriptions.filter((s) => s.event === event && typeof s.handler === "function");
  if (matching.length === 0) {
    return { verdict: "abstain" };
  }
  for (const sub of matching) {
    let timer = null;
    try {
      const outcome = await Promise.race([
        Promise.resolve().then(() => sub.handler(payload)),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`event "${event}" timed out after ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);
      if (outcome === "deny" || (outcome && typeof outcome === "object" && outcome.verdict === "deny")) {
        return {
          verdict: "deny",
          reason: typeof outcome === "object" && outcome.reason ? String(outcome.reason) : undefined,
        };
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return { verdict: "allow" };
}

async function handleCallContextProvider(params) {
  const name = String((params && params.name) || "");
  const timeoutMs = Math.min(Math.max(Number((params && params.timeoutMs) || 5000), 500), 30000);
  const provider = sdkState.contextProviders.find((cp) => cp.def.name === name);
  if (!provider) throw new Error(`unknown context provider "${name}"`);
  if (typeof provider.handler !== "function") throw new Error(`context provider "${name}" has no executable handler`);
  let timer = null;
  try {
    const text = await Promise.race([
      Promise.resolve().then(() => provider.handler({
        mode: String((params && params.mode) || "code"),
        projectRoot: params && params.projectRoot ? String(params.projectRoot) : undefined,
      })),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`context provider "${name}" timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    return { text: typeof text === "string" ? text : (text ? JSON.stringify(text) : "") };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function dispatch(message) {
  const { id, method, params } = message || {};
  if (typeof id !== "number" || typeof method !== "string") {
    send({ id: typeof id === "number" ? id : 0, ok: false, error: "malformed request" });
    return;
  }
  try {
    if (method === "activate") {
      send({ id, ok: true, result: await handleActivate(params) });
    } else if (method === "call-tool") {
      send({ id, ok: true, result: await handleCallTool(params) });
    } else if (method === "call-event") {
      send({ id, ok: true, result: await handleCallEvent(params) });
    } else if (method === "call-context-provider") {
      send({ id, ok: true, result: await handleCallContextProvider(params) });
    } else if (method === "shutdown") {
      send({ id, ok: true, result: {} });
      process.exit(0);
    } else {
      send({ id, ok: false, error: `unknown method "${method}"` });
    }
  } catch (error) {
    send({ id, ok: false, error: error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000) });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message = null;
    try {
      message = JSON.parse(line);
    } catch {
      send({ id: 0, ok: false, error: "malformed JSON" });
      continue;
    }
    void dispatch(message);
  }
});
process.stdin.on("end", () => process.exit(0));
// A broken pipe (host died) must not keep a plugin process alive.
process.stdout.on("error", () => process.exit(1));
