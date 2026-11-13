// The agent loop — the self-built replacement for deepagents' createDeepAgent.
// A plain ReAct cycle: stream a model call, forward token/thinking deltas,
// execute the requested tools through the middleware chain, append results,
// repeat until the model answers or the step budget is exhausted.
//
// Semantics preserved from the deepagents runtime:
// - messages[] is mutated IN PLACE (assistant + tool messages appended), so
//   callers keep one authoritative transcript exactly like the old
//   `runMessages` closure state — resume, compaction and checkpointing keep
//   working against the same array reference.
// - Tool results are string content (adapter layers guarantee provider-safe
//   wire shapes).
// - Skills listed via `skills` are appended to the system prompt as a
//   progressive-disclosure section (the deepagents SkillsMiddleware shape).
// - write_todos tool available for plan tracking (todoListMiddleware parity).
import type { ChatClient, ChatRequest } from "./llm/types.js";
import type { ChatMessage, ToolCall } from "./messages.js";
import { assistantMsg, toolMsg } from "./messages.js";
import type { AgentTool } from "./tools.js";
import { runToolMiddleware, type AgentMiddleware, type ToolCallRequest } from "./middleware.js";
import { normalizeArgAliases } from "../loop-prevention.js";

/** The run consumed its step budget without a final answer — resumable, not fatal. */
export class StepBudgetExceededError extends Error {
  constructor(stepBudget: number) {
    super(`Step budget exhausted after ${stepBudget} model steps`);
    this.name = "StepBudgetExceededError";
  }
}

export type AgentLoopEvent =
  | { type: "token"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "tool_result"; call: ToolCall; result: string; isError: boolean }
  | { type: "usage"; usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheCreationTokens?: number } }
  | { type: "step"; messages: ChatMessage[] }
  | { type: "done"; messages: ChatMessage[]; answer: string; toolCallCount: number };

export interface SkillListing {
  name: string;
  description: string;
  path: string;
}

export interface RunAgentLoopOptions {
  client: ChatClient;
  system?: string;
  /** The conversation. Mutated in place — assistant and tool messages append here. */
  messages: ChatMessage[];
  tools: AgentTool[];
  middleware?: AgentMiddleware[];
  /** Max MODEL invocations for this loop segment (not tool calls). */
  stepBudget: number;
  signal?: AbortSignal;
  onEvent?: (event: AgentLoopEvent) => void;
  /** Virtual skill listings appended to the system prompt (deepagents parity). */
  skills?: SkillListing[];
  temperature?: number;
  maxOutputTokens?: number;
  reasoningEffort?: string;
  /** Strip hallucinated host/project-root prefixes from path args. */
  normalizeArgs?: (call: ToolCall) => void;
  runId?: string;
}

const SKILL_READ_LINE_LIMIT = 250;

/** deepagents SkillsMiddleware parity: progressive-disclosure skills section. */
export function buildSkillsSection(skills: SkillListing[] | undefined, sourcePaths?: string[]): string {
  if (!skills || skills.length === 0) return "";
  const locations = sourcePaths?.length
    ? `Skill locations: ${sourcePaths.map((s) => `\`${s}\``).join(", ")}`
    : "Skill locations are shown per skill below.";
  const list = skills.map((skill) => `- **${skill.name}**: ${skill.description}\n  → Read \`${skill.path}\` for full instructions`).join("\n");
  return `

## Skills System

You have access to a skills library that provides specialized capabilities and domain knowledge.

${locations}

**Available Skills:**

${list}

**How to Use Skills (Progressive Disclosure):**

1. **Recognize when a skill applies**: Check if the user's task matches any skill's description.
2. **Read the skill's full instructions**: Use \`read_file\` on the path shown above. Pass \`limit=${SKILL_READ_LINE_LIMIT}\` since the default of 100 lines is too small for most skill files.
3. **Follow the skill's instructions**: SKILL.md contains step-by-step workflows, best practices, and examples. Never browse skill folders to discover skills — read the listed path directly.

When the user's request matches a skill's domain, read that skill BEFORE producing the deliverable.`;
}

/** write_todos: the todoListMiddleware parity tool. Plan items ride the
 *  tool_call event — the run extracts PlanItems from args (planItemsFromArgs). */
export function createTodoTool(): AgentTool {
  const state = { items: [] as Array<{ content: string; status: string }> };
  return {
    name: "write_todos",
    description:
      "Create or update your working plan for this task. Call this before starting complex work, and update it as items complete — mark items in_progress while working and completed when done. Do not finish the task with pending items.",
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description: "The full todo list (replaces the previous list)",
          items: {
            type: "object",
            properties: {
              content: { type: "string", description: "One concrete step" },
              status: { type: "string", enum: ["pending", "in_progress", "completed"], description: "Current status of this step" },
            },
            required: ["content", "status"],
          },
        },
      },
      required: ["items"],
    },
    execute: async (args: { items?: Array<{ content: string; status: string }> }) => {
      const items = Array.isArray(args?.items) ? args.items.filter((i) => i?.content) : [];
      state.items = items;
      if (!items.length) return "Todo list cleared.";
      const done = items.filter((i) => i.status === "completed").length;
      return `Todo list updated (${done}/${items.length} completed):\n${items.map((i) => `- [${i.status === "completed" ? "x" : i.status === "in_progress" ? "~" : " "}] ${i.content} (${i.status})`).join("\n")}`;
    },
  };
}

/** Normalizes assistant text from streamed deltas. */
function normalizeToolArgs(call: ToolCall, normalizeArgs?: (call: ToolCall) => void): void {
  if (!call.args || typeof call.args !== "object") call.args = {};
  // Alias mapping delegated to the shared implementation (loop-prevention) —
  // the private copy here had drifted from the middleware's version.
  normalizeArgAliases(call);
  normalizeArgs?.(call);
}

export async function* runAgentLoop(options: RunAgentLoopOptions): AsyncGenerator<AgentLoopEvent, { messages: ChatMessage[]; answer: string }, unknown> {
  const { client, messages, tools, middleware = [], stepBudget, signal, onEvent } = options;
  if (signal?.aborted) throw new Error("Run cancelled");
  const toolByName = new Map(tools.map((t) => [t.name, t]));
  let toolCallCount = 0;
  let answer = "";

  for (let step = 0; step < stepBudget; step++) {
    if (signal?.aborted) throw new Error("Run cancelled");

    const request: ChatRequest = {
      messages,
      system: options.system,
      tools: tools.length ? tools : undefined,
      temperature: options.temperature ?? 0.1,
      maxOutputTokens: options.maxOutputTokens,
      reasoningEffort: options.reasoningEffort,
      signal,
    };

    let text = "";
    const argsBuffers = new Map<string, { name: string; json: string }>();
    let pendingCalls: ToolCall[] = [];
    let usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheCreationTokens?: number } | undefined;
    let stopReason: "stop" | "tool" | "length" = "stop";

    for await (const event of client.stream(request)) {
      if (signal?.aborted) throw new Error("Run cancelled");
      if (event.type === "text") {
        text += event.delta;
        onEvent?.({ type: "token", delta: event.delta });
      } else if (event.type === "thinking") {
        onEvent?.({ type: "thinking", delta: event.delta });
      } else if (event.type === "tool_call") {
        const existing = argsBuffers.get(event.id) ?? { name: event.name, json: "" };
        if (event.name && !existing.name) existing.name = event.name;
        existing.json += event.argsDelta;
        argsBuffers.set(event.id, existing);
        // Emit once the args parse (or on stream end) — below.
      } else if (event.type === "done") {
        usage = event.usage;
        stopReason = event.stopReason;
        if (event.text && !text) text = event.text;
        pendingCalls = event.toolCalls;
      }
    }

    if (usage) onEvent?.({ type: "usage", usage });

    // Finalize tool calls: parse accumulated argument JSON.
    const calls: ToolCall[] = pendingCalls.length
      ? pendingCalls
      : [...argsBuffers.entries()].map(([id, buf]) => {
          let args: unknown = {};
          try { args = buf.json ? JSON.parse(buf.json) : {}; } catch { args = { _raw: buf.json }; }
          return { id, name: buf.name || "tool", args };
        });

    const assistant = assistantMsg(text || "", calls.length ? calls : undefined);
    (assistant as any).stopReason = stopReason;
    if (usage) (assistant as any).usage = usage;
    messages.push(assistant);

    if (!calls.length) {
      answer = text;
      onEvent?.({ type: "step", messages: [...messages] });
      onEvent?.({ type: "done", messages: [...messages], answer, toolCallCount });
      return { messages, answer };
    }

    for (const call of calls) {
      if (signal?.aborted) throw new Error("Run cancelled");
      normalizeToolArgs(call, options.normalizeArgs);
      toolCallCount++;
      const tool = toolByName.get(call.name);
      onEvent?.({ type: "tool_call", call });
      const request2: ToolCallRequest = { call, tool, toolCallId: call.id, runId: options.runId };
      let result: { content: string; isError: boolean };
      if (!tool) {
        result = {
          content: `Error: unknown tool '${call.name}'. Available tools: ${[...toolByName.keys()].join(", ") || "(none)"}. Use one of the listed tools exactly as named.`,
          isError: true,
        };
      } else {
        try {
          result = await runToolMiddleware(middleware, request2, async (req) => {
            const out = await tool.execute(req.call.args, { signal, runId: options.runId });
            return out;
          });
        } catch (error: any) {
          result = { content: `Tool execution error: ${error instanceof Error ? error.message : String(error)}`, isError: true };
        }
      }
      messages.push(toolMsg(call.id, result.content, call.name, result.isError));
      onEvent?.({ type: "tool_result", call, result: result.content, isError: result.isError });
    }
    onEvent?.({ type: "step", messages: [...messages] });
  }

  throw new StepBudgetExceededError(stepBudget);
}
