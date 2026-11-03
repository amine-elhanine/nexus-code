// Home-mode research subagent: a context firewall for broad research phases.
//
// The Tokyo Ghoul failure class: a Home presentation run executed 51 web
// searches, 78 browser fetches and 38 image searches IN THE MAIN CONTEXT —
// 160+ tool results competing with the actual deliverable work for the
// context window. ZCode/OpenCode solve this with subagent context isolation:
// research runs in a FRESH context with read-only tools and only a bounded
// digest returns to the parent.
//
// This module gives Home runs a single `research` tool that spawns exactly
// that: fresh deep-agent, web/search/browse/read tools only (no write path
// exists — the tool set is the firewall), recursion-capped, returning a
// ≤2000-char digest. Events ride the existing SubagentItem channel so the UI
// renders it as a regular subagent card.

import { z } from "zod";
import { tool } from "@langchain/core/tools";
import { HumanMessage } from "@langchain/core/messages";
import { createDeepAgent } from "deepagents";
import type { ProviderConfig } from "./store.js";
import { getAgentBackend, getRunAbortSignal } from "./command-service.js";
import { StreamUsageTracker } from "./context-service.js";
import { createProgressTracker, withRateLimitRetry, errorSummary } from "./rate-limit.js";
import type { AgentUsage } from "./agent-types.js";
import { calculateAgentUsage, type SubagentEventHandler } from "./subagent-service.js";

export const HOME_RESEARCH_DIGEST_CAP = 2_000;

const RESEARCH_SYSTEM_PROMPT = `You are a research specialist working inside a larger task. Your ONLY job is to answer the delegated research question thoroughly but concisely, using the web/search/browse/read tools available to you.

Rules:
- You cannot write, edit, or create anything. Research and report only.
- Search broadly first, then read only the most promising sources. Do not read the same source twice.
- Your FINAL response is a digest delivered back to the orchestrating agent. Structure it as:
  1. Direct answer / key findings (bullet points)
  2. Concrete specifics worth reusing (names, numbers, dates, file paths, exact quotes)
  3. Sources used (URLs)
- Keep the digest under ${HOME_RESEARCH_DIGEST_CAP} characters. Dense facts over prose. No preamble, no "I researched...".`;

export function createHomeResearchTool(options: {
  projectRoot: string;
  provider: ProviderConfig;
  modelName: string;
  reasoningEffort?: string;
  /** Read-only tool instances created for the parent run (search/browse). */
  researchTools: any[];
  onEvent?: SubagentEventHandler;
  onUsage?: (usage: AgentUsage) => void;
  isCancelled?: () => boolean;
  runId?: string;
}) {
  let active = 0;

  return tool(
    async ({ question }: { question: string }) => {
      if (active >= 1) {
        return "[Research failed: a research delegation is already running. Wait for it to finish, or work from its result once it returns.]";
      }
      const trimmed = String(question || "").trim();
      if (!trimmed) return "[Research failed: the question is required.]";
      if (trimmed.length > 2_000) return "[Research failed: the question must be under 2,000 characters. Narrow it to one focused question.]";
      active++;
      const subagentId = `sub-research-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const subagentItem = { id: subagentId, role: "researcher", task: trimmed, status: "running" as const, steps: [] };
      options.onEvent?.({ type: "subagent_start", subagent: { ...subagentItem } });
      try {
        const signal = options.runId ? getRunAbortSignal(options.runId) : undefined;
        const { backend } = await getAgentBackend({ id: "home-research", name: "home-research", root: options.projectRoot } as any, {
          readOnly: true,
          runId: options.runId,
        });
        const llm = await import("./providers.js").then((m) => m.createChatModel(options.provider, options.modelName, { reasoningEffort: options.reasoningEffort }));
        const researchAgent = await createDeepAgent({
          model: llm,
          backend: backend as any,
          tools: options.researchTools,
          systemPrompt: RESEARCH_SYSTEM_PROMPT,
        });

        const progress = createProgressTracker();
        const usage = new StreamUsageTracker();
        const isCancelled = () => Boolean(options.isCancelled?.());
        const consumeStream = async () => {
          progress.beginAttempt(1);
          const stream = await (researchAgent as any).stream(
            { messages: [new HumanMessage(trimmed)] },
            { streamMode: ["values", "updates", "messages"], recursionLimit: 24, signal }
          );
          let finalText = "";
          try {
            for await (const item of stream as AsyncIterable<any>) {
              if (isCancelled()) throw new Error("Research subagent cancelled by user");
              const [streamMode, payload] = Array.isArray(item) ? item : ["values", item];
              if (streamMode === "messages") {
                const [chunk] = Array.isArray(payload) ? payload : [payload];
                usage.noteChunk(chunk);
              } else if (streamMode === "values" && Array.isArray(payload?.messages)) {
                const last = payload.messages[payload.messages.length - 1];
                const content = last?.content;
                if (typeof content === "string" && content.trim()) finalText = content;
                else if (Array.isArray(content)) {
                  const text = content.map((part: any) => (typeof part === "string" ? part : String(part?.text ?? ""))).join("").trim();
                  if (text) finalText = text;
                }
              }
            }
          } finally {
            await stream?.return?.().catch(() => {});
          }
          return finalText;
        };

        const answer = await withRateLimitRetry(consumeStream, {
          maxAttempts: 3,
          baseDelayMs: 5_000,
          signal,
          prepareAttempt: () => {
            if (isCancelled()) throw new Error("Research subagent cancelled by user");
          },
        });

        const digest = answer.trim().slice(0, HOME_RESEARCH_DIGEST_CAP);
        const truncated = answer.trim().length > HOME_RESEARCH_DIGEST_CAP;
        // Same accounting semantics as the main run: exact tracker totals +
        // model-priced cost (subagent usage is additive to the parent's).
        const settled = calculateAgentUsage(usage.inputTokens, usage.outputTokens, options.modelName);
        options.onUsage?.(settled);
        options.onEvent?.({ type: "subagent_finish", subagent: { ...subagentItem, status: "completed", output: digest } });
        return `[Research digest — use these findings; do not repeat the searches]${truncated ? " (truncated)" : ""}\n${digest || "(no findings returned — the sources may be unreachable; proceed from your own knowledge and say so in the deliverable)"}`;
      } catch (error) {
        options.onEvent?.({ type: "subagent_finish", subagent: { ...subagentItem, status: "failed", output: errorSummary(error) } });
        return `[Research failed: ${errorSummary(error)} — proceed from your own knowledge and mark uncertain claims as such.]`;
      } finally {
        active--;
      }
    },
    {
      name: "research",
      description: `Delegate a focused research question to a fresh-context research subagent. It runs its own web searches, page reads and file reads in an isolated context and returns a compact digest (≤${HOME_RESEARCH_DIGEST_CAP} chars) with findings and sources. Use this INSTEAD of chaining many web_search/browser calls in the main conversation whenever the request needs broad research — it keeps the main context free for building the deliverable. One question per call; make it specific ("best free libraries for X with license names", not "tell me about X").`,
      schema: z.object({
        question: z.string().min(1).max(2_000).describe("One focused research question. Specific and self-contained — the subagent sees ONLY this question, not the conversation."),
      }),
    }
  );
}
