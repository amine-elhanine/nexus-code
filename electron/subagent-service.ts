import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { createDeepAgent } from "deepagents";
import { z } from "zod";
import { createChatModel } from "./providers.js";
import { createCodeIntelligenceTools } from "./code-tools.js";
import { getAgentBackend } from "./command-service.js";
import { withRateLimitRetry, createProgressTracker, sanitizeResumeCheckpoint } from "./rate-limit.js";
import { StreamUsageTracker } from "./context-service.js";
import type { ProviderConfig } from "./store.js";
import type { AgentUsage } from "./agent-service.js";

export type SubagentRole = "researcher" | "tester" | "coder";

export type SubagentStep = {
  toolName: string;
  summary?: string;
  timestamp: string;
};

export type SubagentItem = {
  id: string;
  role: SubagentRole;
  task: string;
  status: "running" | "completed" | "failed";
  steps: SubagentStep[];
  output?: string;
  usage?: AgentUsage;
};

export type SubagentEventHandler = (event: {
  type: "subagent_start" | "subagent_step" | "subagent_finish";
  subagent: SubagentItem;
}) => void;

export const MAX_SUBAGENTS_PER_RUN = 3;
export const MAX_SUBAGENT_OUTPUT_CHARS = 12_000;
const activeSubagents = new Map<string, number>();

function runKey(runId?: string) { return runId || "global"; }
function tryAcquireSubagent(runId?: string): boolean {
  const key = runKey(runId);
  const active = activeSubagents.get(key) || 0;
  if (active >= MAX_SUBAGENTS_PER_RUN) return false;
  activeSubagents.set(key, active + 1);
  return true;
}
function releaseSubagent(runId?: string) {
  const key = runKey(runId);
  const next = (activeSubagents.get(key) || 1) - 1;
  if (next <= 0) activeSubagents.delete(key);
  else activeSubagents.set(key, next);
}

export function capSubagentOutput(output: string, maxChars = MAX_SUBAGENT_OUTPUT_CHARS): string {
  if (output.length <= maxChars) return output;
  const marker = `\n…[subagent output truncated: ${output.length} chars total]…\n`;
  if (maxChars <= marker.length) return marker.slice(0, maxChars);
  const available = maxChars - marker.length;
  const head = Math.ceil(available * 0.7);
  const tail = available - head;
  return `${output.slice(0, head)}${marker}${output.slice(-tail)}`;
}

export const SUBAGENT_CONFIGS: Record<
  SubagentRole,
  {
    title: string;
    description: string;
    systemPrompt: (projectRoot: string) => string;
    readOnly: boolean;
    recursionLimit: number;
  }
> = {
  researcher: {
    title: "Researcher",
    description: "Explore codebase architecture, search symbols, and summarize findings in read-only mode without mutating code.",
    readOnly: true,
    recursionLimit: 15,
    systemPrompt: (projectRoot: string) => `You are a Research Subagent in Nexus working on the repository at ${projectRoot}.
Your goal is to thoroughly explore the codebase to answer the lead agent's inquiry.
Working guidelines:
- Prefer grep_search with a tight query, then read at most 2 file ranges. Avoid outline -> definition -> references chains.
- Read only the relevant files or excerpts.
- You have READ-ONLY access. Writing, editing, and destructive commands are disabled.
- Return a structured, concise briefing highlighting exact file paths, line references, architecture decisions, and potential risks.`,
  },
  tester: {
    title: "Test & Debug",
    description: "Run targeted test commands, diagnose failure stack traces, and summarize reproduction steps.",
    readOnly: false,
    recursionLimit: 30,
    systemPrompt: (projectRoot: string) => `You are a Test & Debug Subagent in Nexus working on the repository at ${projectRoot}.
Your goal is to run targeted tests, diagnose failures, verify behavior, and report findings.
Working guidelines:
- Locate and execute the relevant test suites (e.g. npm test -- file, pytest).
- Inspect failure outputs, parse stack traces, and identify root causes.
- Provide a clear reproduction and diagnostic report back to the lead agent.`,
  },
  coder: {
    title: "Coder / Refactorer",
    description: "Perform focused, minimal code edits and refactoring for a specific subtask.",
    readOnly: false,
    recursionLimit: 35,
    systemPrompt: (projectRoot: string) => `You are a Coder Subagent in Nexus working on the repository at ${projectRoot}.
Your goal is to implement surgical code modifications for the assigned subtask.
Working guidelines:
- Keep changes minimal and adhere strictly to existing code style.
- Edit existing files rather than rewriting entire modules.
- Return a concise summary of files modified and rationale.`,
  },
};

function textFromMessage(message: any): string {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content.map((part: any) => (typeof part === "string" ? part : part?.text ?? "")).join("");
  }
  return message.text ?? "";
}

// Mirrors describeToolCall in agent-service.ts (kept separate to avoid a
// require cycle). Backend tools use snake_case `file_path`, which a naive
// key scan misses — leaving subagent steps as bare `read_file()`.
function shortLine(value: string, max = 90) {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function toolCallSummary(call: any): string {
  const args = call?.args;
  if (!args || typeof args !== "object") return "";
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const name = call?.name || "";
  const file = str((args as any).file_path || (args as any).filePath || (args as any).file || (args as any).path);
  if (name === "execute") return shortLine(str((args as any).command), 110);
  if (name === "read_file_range" && file) return `${file}:${(args as any).startLine ?? 1}-${(args as any).endLine ?? 100}`;
  if (name === "grep_search") {
    const query = str((args as any).query);
    const scope = str((args as any).pathPrefix);
    return query ? (scope ? `"${shortLine(query, 60)}" in ${scope}` : `"${shortLine(query, 60)}"`) : "";
  }
  if (name === "apply_patch") {
    const files: string[] = [];
    for (const line of str((args as any).patchText).split(/\r?\n/)) {
      const m = line.match(/^\*\*\*\s*(?:Add File|Update File|Delete File|Move to)\s*:?\s*(.*)$/i);
      if (m && m[1].trim() && files.length < 4) files.push(m[1].trim());
    }
    return files.join(", ");
  }
  if (name === "ask_user" && Array.isArray((args as any).questions)) {
    return (args as any).questions.map((q: any) => str(q?.header || q?.question)).filter(Boolean).slice(0, 3).join(" · ");
  }
  if (name === "delegate_task") {
    const role = str((args as any).role);
    const task = shortLine(str((args as any).task), 80);
    return role && task ? `[${role}] ${task}` : role || task;
  }
  if (file) return file;
  const parts: string[] = [];
  for (const key of ["command", "url", "pattern", "query", "symbol", "task"]) {
    const val = (args as any)[key];
    if (typeof val === "string" && val.trim()) {
      parts.push(shortLine(val, 70));
      if (parts.length >= 2) break;
    }
  }
  return parts.join(" · ");
}

export type ModelPricing = { inputPerMillion: number; outputPerMillion: number };

export const MODEL_PRICING: Record<string, ModelPricing> = {
  "gpt-4o": { inputPerMillion: 2.50, outputPerMillion: 10.00 },
  "gpt-4o-mini": { inputPerMillion: 0.15, outputPerMillion: 0.60 },
  "gpt-4.1": { inputPerMillion: 2.00, outputPerMillion: 8.00 },
  "gpt-4.1-mini": { inputPerMillion: 0.15, outputPerMillion: 0.60 },
  "gpt-5.5": { inputPerMillion: 3.00, outputPerMillion: 12.00 },
  "gpt-5.5-mini": { inputPerMillion: 0.20, outputPerMillion: 0.80 },
  "o3": { inputPerMillion: 5.00, outputPerMillion: 20.00 },
  "o4-mini": { inputPerMillion: 1.10, outputPerMillion: 4.40 },
  "claude-3-5-sonnet": { inputPerMillion: 3.00, outputPerMillion: 15.00 },
  "claude-sonnet-4-6": { inputPerMillion: 3.00, outputPerMillion: 15.00 },
  "claude-opus-4-6": { inputPerMillion: 15.00, outputPerMillion: 75.00 },
  "claude-haiku-4-5": { inputPerMillion: 0.80, outputPerMillion: 4.00 },
  "gemini-1.5-pro": { inputPerMillion: 1.25, outputPerMillion: 5.00 },
  "gemini-1.5-flash": { inputPerMillion: 0.075, outputPerMillion: 0.30 },
  "gemini-2.5-flash": { inputPerMillion: 0.10, outputPerMillion: 0.40 },
  "gemini-3.7-pro": { inputPerMillion: 1.25, outputPerMillion: 5.00 },
  "gemini-3.7-flash": { inputPerMillion: 0.10, outputPerMillion: 0.40 },
  "deepseek-chat": { inputPerMillion: 0.14, outputPerMillion: 0.28 },
  "deepseek-reasoner": { inputPerMillion: 0.55, outputPerMillion: 2.19 },
  "mistral-large-latest": { inputPerMillion: 2.00, outputPerMillion: 6.00 },
  "codestral-latest": { inputPerMillion: 0.30, outputPerMillion: 0.90 },
};

export function getModelPricing(modelName?: string): ModelPricing | null {
  if (!modelName) return null;
  const normalized = modelName.toLowerCase();
  // Longest key wins: "gpt-4.1" would otherwise shadow "gpt-4.1-mini" and
  // price every mini model at the full rate. Unknown models (Ollama, free
  // tiers, aggregator catalogues) have no fabricated price — the UI shows "—".
  let bestKey: string | null = null;
  for (const key of Object.keys(MODEL_PRICING)) {
    if (normalized.includes(key.toLowerCase()) && (!bestKey || key.length > bestKey.length)) bestKey = key;
  }
  return bestKey ? MODEL_PRICING[bestKey] : null;
}

export function calculateAgentUsage(inputTokens: number, outputTokens: number, modelName?: string): AgentUsage {
  const pricing = getModelPricing(modelName);
  const totalTokens = inputTokens + outputTokens;
  const cost = pricing === null ? null : Number(((inputTokens / 1_000_000) * pricing.inputPerMillion + (outputTokens / 1_000_000) * pricing.outputPerMillion).toFixed(4));
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    estimatedCost: cost,
  };
}

export async function executeSubagentTask(options: {
  role: SubagentRole;
  task: string;
  projectRoot: string;
  provider: ProviderConfig;
  modelName: string;
  projectRecord: any;
  mcpTools?: any[];
  skills?: string[];
  skillsBackend?: any;
  onEvent?: SubagentEventHandler;
  isCancelled?: () => boolean;
  runId?: string;
}): Promise<string> {
  const { role, task, projectRoot, provider, modelName, projectRecord, mcpTools, skills, skillsBackend, onEvent, isCancelled, runId } = options;
  const config = SUBAGENT_CONFIGS[role] || SUBAGENT_CONFIGS.researcher;
  const subagentId = `sub-${role}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  if (!task.trim()) return `[Subagent: ${config.title} Failed]\nA subagent task is required.`;
  if (task.length > 4_000) return `[Subagent: ${config.title} Failed]\nSubagent task is too large; narrow it to a focused subtask (maximum 4,000 characters).`;
  if (!tryAcquireSubagent(runId)) return `[Subagent: ${config.title} Failed]\nSubagent concurrency limit reached (${MAX_SUBAGENTS_PER_RUN} active tasks for this run).`;

  const subagentItem: SubagentItem = {
    id: subagentId,
    role,
    task,
    status: "running",
    steps: [],
  };

  onEvent?.({ type: "subagent_start", subagent: { ...subagentItem } });

  try {
    if (isCancelled?.()) throw new Error("Subagent cancelled by user");

    const { backend } = await getAgentBackend(projectRecord, {
      readOnly: config.readOnly,
      runId,
    });

    const llm = await createChatModel(provider, modelName);
    const codeTools = createCodeIntelligenceTools(projectRoot);
    const tools = [...codeTools, ...(mcpTools || [])];

    const subAgent = await createDeepAgent({
      model: llm,
      backend: (skillsBackend || backend) as any,
      tools,
      skills: skills || [],
      systemPrompt: config.systemPrompt(projectRoot),
    });

    let finalMessages: any[] = [];
    const usage = new StreamUsageTracker();

    // Mirrors the main agent: a provider 429 or dropped connection during a
    // delegated task must not fail the whole parent run, so the stream is
    // consumed under bounded retry with the same progress-based counter reset,
    // and mid-stream failures resume from the furthest complete superstep.
    let runMessages: any[] = [new HumanMessage(task)];
    const progress = createProgressTracker();
    let retryCount = 0;

    const consumeStream = async () => {
      retryCount++;
      progress.beginAttempt(runMessages.length);
      let messagesToStream = runMessages;
      if (retryCount > 1 && runMessages.length > 1) {
        messagesToStream = [
          ...runMessages,
          new HumanMessage("[System Note: Stream resumed after temporary provider interruption. All preceding tool actions are complete. Continue directly with the subagent task without repeating completed steps.]"),
        ];
      }
      const stream = await (subAgent as any).stream(
        { messages: messagesToStream },
        { streamMode: ["values", "updates", "messages"], recursionLimit: config.recursionLimit }
      );
      try {
        for await (const item of stream as AsyncIterable<any>) {
          if (isCancelled?.()) throw new Error("Subagent cancelled by user");
          const [streamMode, payload] = Array.isArray(item) ? item : ["values", item];

          if (streamMode === "values" && Array.isArray(payload?.messages)) {
            finalMessages = payload.messages;
            progress.noteSuperstep(payload.messages.length);
          }

          if (streamMode === "messages") {
            const [chunk] = Array.isArray(payload) ? payload : [payload];
            usage.noteChunk(chunk);
          }

          if (streamMode === "updates" && payload && typeof payload === "object") {
            for (const delta of Object.values<any>(payload)) {
              for (const message of delta?.messages ?? []) {
                if (Array.isArray(message?.tool_calls)) {
                  for (const call of message.tool_calls) {
                    const toolName = call?.name || "tool";
                    const summary = toolCallSummary(call);
                    const step: SubagentStep = {
                      toolName: summary ? `${toolName} · ${summary}` : toolName,
                      summary,
                      timestamp: new Date().toISOString(),
                    };
                    if (subagentItem.steps.length < 100) subagentItem.steps.push(step);
                    onEvent?.({ type: "subagent_step", subagent: { ...subagentItem } });
                  }
                }
                if (message?.type === "tool") {
                  progress.noteToolResult();
                }
              }
            }
          }
        }
      } catch (error) {
        // Keep the furthest complete superstep as the resume checkpoint so the
        // next attempt continues instead of restarting the delegated task.
        // Trailing unanswered tool calls are pruned before resuming.
        if (finalMessages.length > 0) {
          runMessages = sanitizeResumeCheckpoint(finalMessages);
        }
        throw error;
      }
    };

    await withRateLimitRetry(consumeStream, {
      madeProgress: () => progress.madeProgress(),
      onRetry: ({ delayMs, attempt, maxAttempts, kind, reason, reset }) => {
        const prefix = reset
          ? "Resuming from checkpoint"
          : kind === "rate-limit"
            ? "Rate limited"
            : "Connection problem";
        subagentItem.steps.push({
          toolName: `${prefix} (${reason}) — retry ${attempt}/${maxAttempts} in ${Math.round(delayMs / 1000)}s`,
          timestamp: new Date().toISOString(),
        });
        onEvent?.({ type: "subagent_step", subagent: { ...subagentItem } });
      },
    });

    const lastMsg = finalMessages[finalMessages.length - 1];
    const answer = capSubagentOutput(textFromMessage(lastMsg) || `Subagent [${config.title}] completed task without text output.`);
    let totalInputTokens = usage.inputTokens;
    let totalOutputTokens = usage.outputTokens;
    if (!usage.sawExactOutput && totalOutputTokens === 0) totalOutputTokens = Math.max(1, Math.round(answer.length / 4));
    if (!usage.sawExactInput && totalInputTokens === 0) totalInputTokens = Math.max(1, Math.round((task.length + 800) / 4));

    subagentItem.status = "completed";
    subagentItem.output = answer;
    subagentItem.usage = calculateAgentUsage(totalInputTokens, totalOutputTokens, modelName);

    onEvent?.({ type: "subagent_finish", subagent: { ...subagentItem } });
    return `[Subagent: ${config.title}]\n${answer}`;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    subagentItem.status = "failed";
    subagentItem.output = `Subagent failed: ${errorMsg}`;
    onEvent?.({ type: "subagent_finish", subagent: { ...subagentItem } });
    return `[Subagent: ${config.title} Failed]\n${errorMsg}`;
  } finally {
    releaseSubagent(runId);
  }
}

export function createSubagentDelegationTool(options: {
  projectRoot: string;
  provider: ProviderConfig;
  modelName: string;
  projectRecord: any;
  mcpTools?: any[];
  skills?: string[];
  skillsBackend?: any;
  onEvent?: SubagentEventHandler;
  isCancelled?: () => boolean;
  runId?: string;
}) {
  return tool(
    async ({ role, task }: { role: "researcher" | "tester" | "coder"; task: string }) => {
      return await executeSubagentTask({
        role,
        task,
        projectRoot: options.projectRoot,
        provider: options.provider,
        modelName: options.modelName,
        projectRecord: options.projectRecord,
        mcpTools: options.mcpTools,
        skills: options.skills,
        skillsBackend: options.skillsBackend,
        onEvent: options.onEvent,
        isCancelled: options.isCancelled,
        runId: options.runId,
      });
    },
    {
      name: "delegate_task",
      description: "Delegate an isolated sub-task to a specialized subagent (use sparingly, only for genuinely independent multi-file work — never for simple lookups or single-file edits). 'researcher' explores files, symbols, and patterns in read-only mode to prevent polluting main context. 'tester' runs test suites and diagnoses errors. 'coder' applies surgical modifications.",
      schema: z.object({
        role: z.enum(["researcher", "tester", "coder"]).describe("The specialized role: 'researcher' for codebase investigation, 'tester' for test execution, 'coder' for code editing."),
        task: z.string().min(1).max(4_000).describe("Clear, focused instructions for the subagent describing what to find, test, or implement. Maximum 4,000 characters."),
      }),
    }
  );
}
