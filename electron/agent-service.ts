import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { createDeepAgent, CompositeBackend, FilesystemBackend } from "deepagents";
import { todoListMiddleware } from "langchain";
import { createChatModel } from "./providers.js";
import { createCodeIntelligenceTools } from "./code-tools.js";
import { createBrowserTools } from "./browser-tool.js";
import { discoverProjectRules } from "./rules-service.js";
import { createSubagentDelegationTool, calculateAgentUsage, type SubagentItem } from "./subagent-service.js";
import { getWorkspaceDiffFiles } from "./diff-service.js";
import { getMcpTools } from "./mcp-service.js";
import { getSkillsConfig } from "./store.js";
import { GLOBAL_SKILLS_ROUTE, PROJECT_SKILLS_DIR, globalSkillsDir } from "./skills-service.js";
import { compactHistory, extractStreamUsage, estimateTokens } from "./context-service.js";
import { saveArtifact, type ArtifactItem } from "./artifacts-service.js";
import { TrajectoryLogger } from "./trajectory-service.js";
import type { ProviderConfig } from "./store.js";

export type AgentMode = "plan" | "ask" | "auto";
export type PlanItem = { content: string; status: "pending" | "in_progress" | "completed" };
export type AgentTurn = { role: "user" | "assistant"; text: string };
export type AgentSettings = { provider?: ProviderConfig; model?: string; apiKey?: string; baseUrl?: string; sandboxConfig?: any };
export type AgentUsage = { inputTokens: number; outputTokens: number; totalTokens: number; estimatedCost: number };
export type AgentEvent = {
  type: "status" | "tool" | "token" | "assistant" | "plan" | "error" | "usage" | "subagent" | "artifact";
  text: string;
  timestamp: string;
  items?: PlanItem[];
  usage?: AgentUsage;
  subagent?: SubagentItem;
  artifact?: ArtifactItem;
};
export type AgentMemoryContext = { projectMemory: string; sessionMemory: string };
export class RunCancelledError extends Error {
  constructor() {
    super("Agent run cancelled by user");
    this.name = "RunCancelledError";
  }
}

// LangGraph recursion budgets per mode
const MODE_LIMITS: Record<AgentMode, number> = { plan: 60, ask: 160, auto: 300 };
const MAX_REPAIRS: Record<AgentMode, number> = { plan: 0, ask: 1, auto: 3 };
const HISTORY_CHAR_CAP = 4000;
const VERIFY_OUTPUT_CAP = 4000;

const AgentState = Annotation.Root({
  projectRoot: Annotation<string>(),
  request: Annotation<string>(),
  response: Annotation<string>({ reducer: (_, value) => value, default: () => "" }),
  verifyFeedback: Annotation<string>({ reducer: (_, value) => value, default: () => "" }),
  repairs: Annotation<number>({ reducer: (_, value) => value, default: () => 0 }),
  verification: Annotation<string>({ reducer: (_, value) => value, default: () => "" }),
});

function textFromMessage(message: any) {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) return message.content.map((part: any) => (typeof part === "string" ? part : part?.text ?? "")).join("");
  return message.text ?? "";
}

function chunkText(chunk: any) {
  const content = chunk?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part: any) => (typeof part === "string" ? part : part?.text ?? "")).join("");
  return "";
}

function tail(value: string | undefined, cap: number) {
  if (!value) return "";
  return value.length > cap ? `…${value.slice(-cap)}` : value;
}

export function pickVerificationCommand(projectRoot: string): string | null {
  try {
    const root = path.resolve(projectRoot);
    const pkgPath = path.join(root, "package.json");
    if (existsSync(pkgPath)) {
      const scripts = JSON.parse(readFileSync(pkgPath, "utf8")).scripts ?? {};
      if (typeof scripts.typecheck === "string") return "npm run typecheck";
      if (existsSync(path.join(root, "tsconfig.json"))) return "tsc --noEmit";
      if (typeof scripts.check === "string") return "npm run check";
      if (typeof scripts.lint === "string") return "npm run lint";
    }

    if (existsSync(path.join(root, "Cargo.toml"))) return "cargo check";
    if (existsSync(path.join(root, "go.mod"))) return "go vet ./...";
    if (existsSync(path.join(root, "pyproject.toml")) || existsSync(path.join(root, "ruff.toml"))) return "ruff check";
    return null;
  } catch {
    return null;
  }
}

export function findTargetedTests(projectRoot: string, modifiedFiles: string[]): string | null {
  try {
    const root = path.resolve(projectRoot);
    const hasPackageJson = existsSync(path.join(root, "package.json"));
    let hasTestScript = false;
    if (hasPackageJson) {
      const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
      hasTestScript = typeof pkg.scripts?.test === "string";
    }

    // Heuristic: check if any modified file has a corresponding test file
    for (const file of modifiedFiles) {
      const parsed = path.parse(file);
      const candidates = [
        path.join(root, parsed.dir, `${parsed.name}.test${parsed.ext}`),
        path.join(root, parsed.dir, `${parsed.name}.spec${parsed.ext}`),
        path.join(root, "test", `${parsed.name}.test${parsed.ext}`),
        path.join(root, "tests", `test_${parsed.name}${parsed.ext}`),
      ];
      for (const cand of candidates) {
        if (existsSync(cand)) {
          const rel = path.relative(root, cand).replace(/\\/g, "/");
          if (hasTestScript) return `npm test -- ${rel}`;
          if (parsed.ext === ".py") return `pytest ${rel}`;
          if (parsed.ext === ".rs") return `cargo test ${parsed.name}`;
          if (parsed.ext === ".go") return `go test ./${path.dirname(rel)}`;
          return `node ${rel}`;
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

function planItemsFromArgs(args: any): PlanItem[] | null {
  if (!args || typeof args !== "object") return null;
  const rawList = Array.isArray(args.items) ? args.items : Array.isArray(args.todos) ? args.todos : Array.isArray(args.plan) ? args.plan : null;
  if (!rawList) return null;
  const items = rawList
    .map((item: any) => {
      if (typeof item === "string") return { content: item, status: "pending" as const };
      const content = String(item?.content || item?.task || item?.title || "").trim();
      const rawStatus = String(item?.status || "pending").toLowerCase();
      const status: PlanItem["status"] = rawStatus === "completed" || rawStatus === "done" ? "completed" : rawStatus === "in_progress" || rawStatus === "active" ? "in_progress" : "pending";
      return { content, status };
    })
    .filter((item: PlanItem) => item.content);
  return items.length ? items : null;
}

const ARG_KEYS = ["filePath", "file", "path", "command", "symbol", "pattern", "query", "dir", "url"];
function toolCallSummary(call: any) {
  const args = call?.args;
  if (args && typeof args === "object") {
    const parts: string[] = [];
    for (const key of ARG_KEYS) {
      const value = (args as any)[key];
      if (typeof value === "string" && value) parts.push(`${key}=${value.length > 48 ? `${value.slice(0, 48)}…` : value}`);
      if (parts.length >= 2) break;
    }
    if (parts.length) return parts.join(" ");
  }
  return "";
}

function buildSystemPrompt(mode: AgentMode, projectRoot: string, providerLabel: string, modelName: string, memory: AgentMemoryContext, projectRulesSection: string = "") {
  let common = `You are Nexus, an advanced autonomous coding agent working on a local repository. The repository is exposed at the virtual root / — use paths relative to the repository root (for example src/App.tsx).

Project root on host (metadata only): ${projectRoot}
Provider: ${providerLabel} / ${modelName}

Project memory:
${tail(memory.projectMemory, 2000) || "(empty)"}

Session memory:
${tail(memory.sessionMemory, 3000) || "(empty)"}

Working rules:
- Inspect the relevant code before proposing or making changes; never assume file contents.
- Use get_symbol_outline, find_symbol_definition, or find_symbol_references for fast structural exploration before reading full files.
- Use browser_inspect or browser_fetch_api when asked to verify web applications, dev servers (e.g. localhost:3000), or API health.
- You can delegate isolated sub-tasks to specialized subagents via delegate_task(role, task):
  * 'researcher': read-only codebase exploration without polluting your main context.
  * 'tester': run test commands and diagnose failures.
  * 'coder': surgical refactoring and code modification.
- Keep diffs minimal and focused; prefer editing existing files over rewriting them.
- Maintain your todo list as you work through multi-step tasks.
- Additional MCP tools (if listed in your tools) come from user-configured MCP servers; prefer them for the capabilities they expose (e.g. search, APIs, external systems).
- Skills listed in your instructions can be loaded on demand by reading their SKILL.md — consult one before doing work it covers.
- Never expose secrets or run destructive commands.
- Finish by reporting files changed, commands run, and remaining risks.`;

  if (projectRulesSection) {
    common += `\n\n${projectRulesSection}`;
  }

  if (mode === "plan") return `${common}\n\nMODE: PLAN. Investigate the repository and return a structured markdown implementation plan with sections: # Objective, ## Proposed Changes, ## Risks, ## Verification Plan. Writing, editing, deleting and command execution are disabled — gather information with read, search, and symbol tools only, and do not attempt to change anything.`;
  if (mode === "auto") return `${common}\n\nMODE: AUTO. Work autonomously end to end: plan, implement, then verify with the available checks. If a check fails, fix your changes before finishing.`;
  return `${common}\n\nMODE: ASK. Implement the requested change, keep it minimal, and verify with the available checks before answering.`;
}

export async function runProjectAgent(options: {
  projectRoot: string;
  telemetryRoot?: string;
  sessionId?: string;
  request: string;
  images?: string[];
  settings: AgentSettings;
  memory: AgentMemoryContext;
  history: AgentTurn[];
  mode: AgentMode;
  sandboxBackend: unknown;
  onEvent: (event: AgentEvent) => void;
  isCancelled: () => boolean;
}) {
  const { projectRoot, telemetryRoot, sessionId, request, images, settings, memory, history, mode, sandboxBackend, onEvent, isCancelled } = options;
  const targetTelemetryRoot = telemetryRoot || projectRoot;
  const emit = (type: AgentEvent["type"], text: string, items?: PlanItem[], usage?: AgentUsage, subagent?: SubagentItem, artifact?: ArtifactItem) => {
    if (text || items?.length || usage || subagent || artifact) onEvent({ type, text, timestamp: new Date().toISOString(), items, usage, subagent, artifact });
  };

  const trajectory = sessionId ? new TrajectoryLogger(targetTelemetryRoot, sessionId) : null;
  if (trajectory) {
    await trajectory.init();
    await trajectory.log({ source: "USER", type: "USER_INPUT", content: request });
  }

  const provider = settings.provider ?? {
    id: "default",
    label: "OpenAI",
    provider: "openai",
    apiKey: settings.apiKey || process.env.OPENAI_API_KEY || "",
    baseUrl: settings.baseUrl,
    models: [settings.model || process.env.OPENAI_MODEL || "gpt-4.1-mini"],
  };
  const modelName = settings.model || provider.models[0] || "";
  if (!modelName) {
    emit("error", "No model selected for this session. Configure a provider and model first.");
    throw new Error("Missing model");
  }
  if (!provider.apiKey && provider.provider !== "ollama" && provider.provider !== "custom") {
    emit("error", `No API key configured for ${provider.label}. Add it in Providers.`);
    throw new Error("Missing model API key");
  }
  if (!sandboxBackend) {
    emit("error", "No sandbox backend is available for this project.");
    throw new Error("Missing sandbox backend");
  }
  emit("status", `Starting agent · ${provider.label} / ${modelName} · ${mode} mode`);
  const llm = await createChatModel(provider, modelName);

  let mcpTools: any[] = [];
  try {
    const { tools, serverNames } = await getMcpTools();
    mcpTools = tools;
    if (tools.length) emit("status", `Connected to MCP · ${tools.length} tool${tools.length === 1 ? "" : "s"} from ${serverNames.join(", ")}`);
  } catch (error) {
    emit("error", `MCP servers could not be reached, continuing without them: ${error instanceof Error ? error.message : String(error)}`);
  }

  const rulesResult = await discoverProjectRules(projectRoot);
  if (rulesResult.hasRules) {
    emit("status", `Loaded ${rulesResult.ruleFiles.length} project rule file${rulesResult.ruleFiles.length === 1 ? "" : "s"} (${rulesResult.ruleFiles.map((r) => r.filename).join(", ")})`);
  }

  const runCommand = async (command: string) => {
    try {
      return await Promise.resolve((sandboxBackend as any)?.execute?.(command));
    } catch (error) {
      return { output: error instanceof Error ? error.message : String(error), exitCode: 1, truncated: false };
    }
  };

  const skillsConfig = await getSkillsConfig();
  const skills = skillsConfig.enabled ? [PROJECT_SKILLS_DIR, GLOBAL_SKILLS_ROUTE] : [];
  const agentBackend = skills.length
    ? new CompositeBackend(sandboxBackend as any, { [GLOBAL_SKILLS_ROUTE]: new FilesystemBackend({ rootDir: globalSkillsDir(), virtualMode: true }) })
    : sandboxBackend;

  const codeTools = createCodeIntelligenceTools(projectRoot);
  const browserTools = createBrowserTools(projectRoot, settings.sandboxConfig);
  const subagentTool = createSubagentDelegationTool({
    projectRoot,
    provider,
    modelName,
    sandboxConfig: settings.sandboxConfig || { provider: "local", enabled: true, requireApproval: false, allowNetwork: false, commandTimeoutSeconds: 120 },
    projectRecord: { id: "current", name: "current", root: projectRoot },
    mcpTools,
    skills,
    skillsBackend: agentBackend,
    onEvent: (subEvent) => {
      if (subEvent.subagent.usage) {
        totalInputTokens += subEvent.subagent.usage.inputTokens;
        totalOutputTokens += subEvent.subagent.usage.outputTokens;
      }
      emit("subagent", subEvent.type === "subagent_start" ? `Delegated task to ${subEvent.subagent.role} subagent` : subEvent.type === "subagent_finish" ? `Subagent [${subEvent.subagent.role}] completed` : `Subagent working...`, undefined, undefined, subEvent.subagent);
    },
    isCancelled,
  });

  const deepAgent = await createDeepAgent({
    model: llm,
    backend: agentBackend as any,
    middleware: [todoListMiddleware()],
    tools: [...codeTools, ...browserTools, subagentTool, ...mcpTools],
    skills,
    systemPrompt: buildSystemPrompt(mode, projectRoot, provider.label, modelName, memory, rulesResult.combinedPromptSection),
  });

  // Apply context compaction on history
  const compactedHistory = compactHistory(history);
  const priorMessages = compactedHistory.map((turn) =>
    turn.role === "assistant"
      ? new AIMessage(tail(turn.text, HISTORY_CHAR_CAP))
      : new HumanMessage(tail(turn.text, HISTORY_CHAR_CAP))
  );

  let initialHumanMessage: HumanMessage;
  if (images && images.length > 0) {
    const contentParts: any[] = [{ type: "text", text: request }];
    for (const img of images) {
      contentParts.push({
        type: "image_url",
        image_url: { url: img },
      });
    }
    initialHumanMessage = new HumanMessage({ content: contentParts });
  } else {
    initialHumanMessage = new HumanMessage(request);
  }

  let totalOutputTokens = 0;
  let totalInputTokens = Math.round(
    (priorMessages.reduce((sum, m) => sum + (typeof m.content === "string" ? m.content.length : 0), 0) + request.length + 1500) / 4
  );

  const streamDeepAgent = async (extra: HumanMessage[]) => {
    let finalMessages: any[] = [];
    const stream = await (deepAgent as any).stream(
      { messages: [...priorMessages, initialHumanMessage, ...extra] },
      { streamMode: ["values", "updates", "messages"], recursionLimit: MODE_LIMITS[mode] }
    );
    for await (const item of stream as AsyncIterable<any>) {
      if (isCancelled()) throw new RunCancelledError();
      const [streamMode, payload] = Array.isArray(item) ? item : ["values", item];
      if (streamMode === "values" && Array.isArray(payload?.messages)) {
        finalMessages = payload.messages;
        continue;
      }
      if (streamMode === "updates" && payload && typeof payload === "object") {
        for (const delta of Object.values<any>(payload)) {
          for (const message of delta?.messages ?? []) {
            if (Array.isArray(message?.tool_calls)) {
              for (const call of message.tool_calls) {
                const name = call?.name || "tool";
                if (/todo/i.test(name)) {
                  const items = planItemsFromArgs(call.args);
                  if (items) emit("plan", "Working plan", items);
                  continue;
                }
                const summary = toolCallSummary(call);
                const desc = summary ? `${name}(${summary})` : `${name}()`;
                emit("tool", desc);
                if (trajectory) {
                  await trajectory.log({ source: "TOOL", type: "TOOL_CALL", content: desc, tool_calls: [{ name, args: call.args }] });
                }
              }
            }
            if (message?.type === "tool") {
              emit("tool", `${message.name || "tool"} ✓`);
              if (trajectory) {
                await trajectory.log({ source: "TOOL", type: "TOOL_RESULT", content: `${message.name || "tool"} finished` });
              }
            }
          }
        }
        continue;
      }
      if (streamMode === "messages") {
        const [chunk] = Array.isArray(payload) ? payload : [payload];
        const exact = extractStreamUsage(chunk);
        if (exact?.inputTokens) totalInputTokens = exact.inputTokens;
        if (exact?.outputTokens) totalOutputTokens = exact.outputTokens;

        const text = chunkText(chunk);
        if (text) {
          if (!exact) totalOutputTokens += Math.max(1, estimateTokens(text));
          emit("token", text);
        }
      }
    }
    return textFromMessage(finalMessages[finalMessages.length - 1]) || "Agent finished without a textual response.";
  };

  const graph = new StateGraph(AgentState as any)
    .addNode("brief", async () => {
      const msg = `Preparing context · ${history.length} prior turn${history.length === 1 ? "" : "s"} · ${mode} mode`;
      emit("status", msg);
      if (trajectory) await trajectory.log({ source: "SYSTEM", type: "STATUS", content: msg });
      return {};
    })
    .addNode("deep_agent", async (state: any) => {
      if (isCancelled()) throw new RunCancelledError();
      const extra = state.verifyFeedback ? [new HumanMessage(state.verifyFeedback)] : [];
      emit("status", state.verifyFeedback ? "Repairing verification failures" : "Agent is working on the task");
      const answer = await streamDeepAgent(extra);
      return { response: answer, verifyFeedback: "" };
    })
    .addNode("verify", async (state: any) => {
      if (isCancelled()) throw new RunCancelledError();

      const currentRepairs = Number(state.repairs) || 0;
      const maxRepairs = MAX_REPAIRS[mode] ?? 1;

      // 1. Static checks cascade (typecheck -> tsc -> check -> lint -> multi-language)
      const command = pickVerificationCommand(projectRoot);
      if (command) {
        emit("status", `Verifying changes with \`${command}\``);
        const result = await runCommand(command);
        if (isCancelled()) throw new RunCancelledError();
        const output = String((result as any)?.output ?? "").trim();
        if ((result as any)?.exitCode !== 0) {
          emit("tool", `Verification failed · ${command}`);
          if (currentRepairs < maxRepairs && output) {
            return {
              repairs: currentRepairs + 1,
              verifyFeedback: `The verification command \`${command}\` failed (repair attempt ${currentRepairs + 1} of ${maxRepairs}):\n\n${tail(output, VERIFY_OUTPUT_CAP)}\n\nFix these failures with minimal, focused changes, then summarize what you changed.`,
            };
          }
          return { verification: "failed" };
        }
        emit("tool", `Verification passed · ${command}`);
      }

      // 2. Targeted test detection for modified files
      const diffFiles = await getWorkspaceDiffFiles(projectRoot);
      const targetTestCmd = findTargetedTests(projectRoot, diffFiles.map((d) => d.path));
      if (targetTestCmd) {
        emit("status", `Running targeted test \`${targetTestCmd}\``);
        const testResult = await runCommand(targetTestCmd);
        if (isCancelled()) throw new RunCancelledError();
        const testOutput = String((testResult as any)?.output ?? "").trim();
        if ((testResult as any)?.exitCode !== 0) {
          emit("tool", `Targeted test failed · ${targetTestCmd}`);
          if (currentRepairs < maxRepairs && testOutput) {
            return {
              repairs: currentRepairs + 1,
              verifyFeedback: `Targeted test \`${targetTestCmd}\` failed (repair attempt ${currentRepairs + 1} of ${maxRepairs}):\n\n${tail(testOutput, VERIFY_OUTPUT_CAP)}\n\nFix the code to pass this test.`,
            };
          }
          return { verification: "failed" };
        }
        emit("tool", `Targeted test passed · ${targetTestCmd}`);
      }

      return { verification: command || targetTestCmd ? "passed" : "none" };
    })
    .addEdge(START, "brief")
    .addEdge("brief", "deep_agent")
    .addConditionalEdges("deep_agent", () => (mode === "plan" ? "end" : "verify"), { verify: "verify", end: END })
    .addConditionalEdges("verify", (state: any) => (state.verifyFeedback ? "deep_agent" : "end"), { deep_agent: "deep_agent", end: END })
    .compile();

  const result: any = await graph.invoke({ projectRoot, request });
  const usage: AgentUsage = calculateAgentUsage(totalInputTokens, totalOutputTokens);
  emit("assistant", result.response, undefined, usage);
  emit("usage", `Token usage · ${usage.totalTokens} tokens (~$${usage.estimatedCost})`, undefined, usage);

  if (trajectory) {
    await trajectory.log({ source: "MODEL", type: "PLANNER_RESPONSE", content: result.response, usage });
  }

  // Automatic Artifact Generation:
  // In Plan mode -> save implementation_plan.md
  // In Auto mode with file changes -> save walkthrough.md
  let artifact: ArtifactItem | undefined;
  if (sessionId) {
    try {
      if (mode === "plan") {
        artifact = await saveArtifact(targetTelemetryRoot, sessionId, "implementation_plan.md", result.response, {
          status: "pending_approval",
          requestFeedback: true,
          name: "Implementation Plan",
        });
        emit("artifact", `Generated Implementation Plan`, undefined, undefined, undefined, artifact);
      } else if (mode === "auto") {
        const diffFiles = await getWorkspaceDiffFiles(projectRoot);
        if (diffFiles.length > 0) {
          const changedSummary = `### Files Modified (${diffFiles.length})\n` + diffFiles.map((d) => `- \`${d.path}\` (+${d.additions} / -${d.deletions})`).join("\n");
          const walkthroughContent = `# Walkthrough - ${request.slice(0, 60)}\n\n## Changes Summary\n${changedSummary}\n\n## Verification\nStatus: **${result.verification}**\n\n## Outcome\n${result.response}`;
          artifact = await saveArtifact(targetTelemetryRoot, sessionId, "walkthrough.md", walkthroughContent, {
            status: "completed",
            requestFeedback: false,
            name: "Walkthrough Report",
          });
          emit("artifact", `Generated Walkthrough Report`, undefined, undefined, undefined, artifact);
        }
      }
    } catch { /* ignore artifact save errors */ }
  }

  return {
    response: result.response as string,
    verification: (result.verification as string) || "none",
    memoryEntry: `Task: ${request}\nOutcome: ${tail(result.response, 600)}\nVerification: ${(result.verification as string) || "none"}`,
    usage,
    artifact,
  };
}
