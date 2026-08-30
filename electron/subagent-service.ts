import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { createDeepAgent } from "deepagents";
import { z } from "zod";
import { createChatModel } from "./providers.js";
import { createCodeIntelligenceTools } from "./code-tools.js";
import { getSandboxAgentBackend } from "./sandbox-service.js";
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
    recursionLimit: 25,
    systemPrompt: (projectRoot: string) => `You are a Research Subagent in Nexus working on the repository at ${projectRoot}.
Your goal is to thoroughly explore the codebase to answer the lead agent's inquiry.
Working guidelines:
- Use get_symbol_outline and find_symbol_definition for fast structural exploration.
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

function toolCallSummary(call: any): string {
  const args = call?.args;
  if (args && typeof args === "object") {
    const parts: string[] = [];
    for (const key of ["filePath", "file", "path", "command", "symbol", "query"]) {
      const val = (args as any)[key];
      if (typeof val === "string" && val) parts.push(`${key}=${val.length > 40 ? `${val.slice(0, 40)}…` : val}`);
      if (parts.length >= 2) break;
    }
    if (parts.length) return parts.join(" ");
  }
  return "";
}

import { extractStreamUsage } from "./context-service.js";

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

export function getModelPricing(modelName?: string): ModelPricing {
  if (!modelName) return { inputPerMillion: 0.15, outputPerMillion: 0.60 };
  const normalized = modelName.toLowerCase();
  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (normalized.includes(key.toLowerCase())) return pricing;
  }
  return { inputPerMillion: 0.15, outputPerMillion: 0.60 };
}

export function calculateAgentUsage(inputTokens: number, outputTokens: number, modelName?: string): AgentUsage {
  const pricing = getModelPricing(modelName);
  const totalTokens = inputTokens + outputTokens;
  const cost = (inputTokens / 1_000_000) * pricing.inputPerMillion + (outputTokens / 1_000_000) * pricing.outputPerMillion;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    estimatedCost: Number(cost.toFixed(4)),
  };
}

export async function executeSubagentTask(options: {
  role: SubagentRole;
  task: string;
  projectRoot: string;
  provider: ProviderConfig;
  modelName: string;
  sandboxConfig: any;
  projectRecord: any;
  mcpTools?: any[];
  skills?: string[];
  skillsBackend?: any;
  onEvent?: SubagentEventHandler;
  isCancelled?: () => boolean;
}): Promise<string> {
  const { role, task, projectRoot, provider, modelName, sandboxConfig, projectRecord, mcpTools, skills, skillsBackend, onEvent, isCancelled } = options;
  const config = SUBAGENT_CONFIGS[role] || SUBAGENT_CONFIGS.researcher;
  const subagentId = `sub-${role}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

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

    const { backend } = await getSandboxAgentBackend(projectRecord, sandboxConfig, {
      readOnly: config.readOnly,
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

    const stream = await (subAgent as any).stream(
      { messages: [new HumanMessage(task)] },
      { streamMode: ["values", "updates", "messages"], recursionLimit: config.recursionLimit }
    );

    let finalMessages: any[] = [];
    let totalInputTokens = Math.max(1, Math.round((task.length + 800) / 4));
    let totalOutputTokens = 0;

    for await (const item of stream as AsyncIterable<any>) {
      if (isCancelled?.()) throw new Error("Subagent cancelled by user");
      const [streamMode, payload] = Array.isArray(item) ? item : ["values", item];

      if (streamMode === "values" && Array.isArray(payload?.messages)) {
        finalMessages = payload.messages;
      }

      if (streamMode === "messages") {
        const [chunk] = Array.isArray(payload) ? payload : [payload];
        const exact = extractStreamUsage(chunk);
        if (exact?.inputTokens) totalInputTokens = exact.inputTokens;
        if (exact?.outputTokens) totalOutputTokens = exact.outputTokens;
      }

      if (streamMode === "updates" && payload && typeof payload === "object") {
        for (const delta of Object.values<any>(payload)) {
          for (const message of delta?.messages ?? []) {
            if (Array.isArray(message?.tool_calls)) {
              for (const call of message.tool_calls) {
                const toolName = call?.name || "tool";
                const summary = toolCallSummary(call);
                const step: SubagentStep = {
                  toolName: summary ? `${toolName}(${summary})` : toolName,
                  summary,
                  timestamp: new Date().toISOString(),
                };
                subagentItem.steps.push(step);
                onEvent?.({ type: "subagent_step", subagent: { ...subagentItem } });
              }
            }
          }
        }
      }
    }

    const lastMsg = finalMessages[finalMessages.length - 1];
    const answer = textFromMessage(lastMsg) || `Subagent [${config.title}] completed task without text output.`;
    if (!totalOutputTokens) totalOutputTokens = Math.max(1, Math.round(answer.length / 4));

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
  }
}

export function createSubagentDelegationTool(options: {
  projectRoot: string;
  provider: ProviderConfig;
  modelName: string;
  sandboxConfig: any;
  projectRecord: any;
  mcpTools?: any[];
  skills?: string[];
  skillsBackend?: any;
  onEvent?: SubagentEventHandler;
  isCancelled?: () => boolean;
}) {
  return tool(
    async ({ role, task }: { role: "researcher" | "tester" | "coder"; task: string }) => {
      return await executeSubagentTask({
        role,
        task,
        projectRoot: options.projectRoot,
        provider: options.provider,
        modelName: options.modelName,
        sandboxConfig: options.sandboxConfig,
        projectRecord: options.projectRecord,
        mcpTools: options.mcpTools,
        skills: options.skills,
        skillsBackend: options.skillsBackend,
        onEvent: options.onEvent,
        isCancelled: options.isCancelled,
      });
    },
    {
      name: "delegate_task",
      description: "Delegate an isolated sub-task to a specialized subagent. 'researcher' explores files, symbols, and patterns in read-only mode to prevent polluting main context. 'tester' runs test suites and diagnoses errors. 'coder' applies surgical modifications.",
      schema: z.object({
        role: z.enum(["researcher", "tester", "coder"]).describe("The specialized role: 'researcher' for codebase investigation, 'tester' for test execution, 'coder' for code editing."),
        task: z.string().describe("Clear, actionable instructions for the subagent describing what to find, test, or implement."),
      }),
    }
  );
}
