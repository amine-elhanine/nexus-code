// Run-loop control: the doom-loop breaker circuit and the agent middleware
// that steers/blocks repetitive inspection and normalizes tool arguments.
// Extracted from agent-service.ts; now rides the agentcore middleware
// contract instead of LangChain's createMiddleware.
import type { AgentMiddleware, ToolCallRequest, ToolResult } from "./agentcore/middleware.js";
import { extractSkillNameFromPath } from "./tool-describe.js";
import { normalizeVirtualPath, normalizeCommandPaths } from "./path-utils.js";

// OpenCode-style doom-loop breaker: the model repeating the exact same tool
// call is stuck, not working. Thrown from the stream consumer and converted
// into a resumable partial result at the supervisor — never retried.
export class DoomLoopError extends Error {
  toolName: string;
  constructor(toolName: string, detail: string) {
    super(`DoomLoop: ${toolName} repeated without progress (${detail})`);
    this.name = "DoomLoopError";
    this.toolName = toolName;
  }
}

/**
 * Normalizes tool arguments so models passing `filePath` or `path` instead of
 * snake_case `file_path` for filesystem tools (read_file, write_file,
 * edit_file, delete) succeed without validation crashes, and strips host or
 * hallucinated POSIX project root prefixes before tools receive them.
 * Applied by the agent loop before every tool execution.
 */
export function normalizeToolCallArgs(call: { name: string; args: any }, projectRoot?: string): void {
  if (!call.args || typeof call.args !== "object") return;
  if ("filePath" in call.args && !("file_path" in call.args)) {
    call.args.file_path = call.args.filePath;
  }
  if ("path" in call.args && !("file_path" in call.args)) {
    call.args.file_path = call.args.path;
  }
  if (projectRoot) {
    const pathKeys = [
      "file_path",
      "filePath",
      "path",
      "file",
      "target",
      "dirPath",
      "dir_path",
      "directory",
      "search_path",
      "searchPath",
    ] as const;
    for (const key of pathKeys) {
      if (typeof call.args[key] === "string" && call.args[key]) {
        call.args[key] = normalizeVirtualPath(call.args[key], projectRoot);
      }
    }
    if (typeof call.args.command === "string") {
      call.args.command = normalizeCommandPaths(call.args.command, projectRoot);
    }
  }
}

/**
 * Research budgets for Home deliverable tasks. Research-heavy requests
 * (latest docs, comparisons, current facts) need room to browse; tasks that
 * just need to produce from local context get a tight budget so the agent
 * switches to creating instead of endlessly searching.
 */
export const RESEARCH_BUDGET_BASE = 8;
export const RESEARCH_BUDGET_WITH_RESEARCH = 20;

export function resolveResearchBudget(options: { outputRequired?: boolean; needsResearch?: boolean }): number | null {
  if (!options.outputRequired) return null;
  return options.needsResearch ? RESEARCH_BUDGET_WITH_RESEARCH : RESEARCH_BUDGET_BASE;
}

export type DeliverableReadyCheck = () => Promise<{ ready: boolean; files: string[]; summary: string } | null>;

const BINARY_FILE_EXT = /\.(png|jpe?g|gif|webp|ico|svgz|pdf|pptx|docx|xlsx|zip|tar|gz|7z|rar|mp3|mp4|wav|mov|bin|exe|dll)$/i;

const blocked = (content: string): ToolResult => ({ content, isError: true });

/** Extracts the plain text of a tool result (string or {content} shape). */
function resultText(result: ToolResult): string {
  if (typeof result === "string") return result;
  return result.content;
}

function withText(result: ToolResult, text: string): ToolResult {
  if (typeof result === "string") return text;
  return { ...result, content: text };
}

/**
 * Loop Prevention Middleware:
 * Detects and breaks repetitive read/inspection tool loops (e.g., repeatedly calling
 * read_file, grep_search, or glob on the same file/target without any edits or modifying commands).
 *
 * Modifying actions (write_file, edit_file, delete, apply_patch, execute) reset inspection tracking.
 *
 * Repetition 2: Injects a proactive steering notice into the tool message advising the model
 *               that the file has not changed, build/tests already passed, and to mark todos completed.
 * Repetition 3+: Blocks execution of the tool, returning an intervention result directing the model
 *                to update its todo list and provide its final answer immediately.
 *
 * Research tools (web_search, browser_inspect/fetch, browser_act navigate/text)
 * get per-target handling instead of a run abort: 2nd fetch of the same
 * URL/query executes with a steer-forward nudge, 3rd+ is banned for that
 * target only with guidance to try a different source — the run continues
 * on other plan items. The doom-loop breaker stays as the final circuit
 * breaker for models that ignore the bans entirely.
 */
export function loopPreventionMiddleware(options: {
  general?: boolean;
  outputRequired?: boolean;
  needsResearch?: boolean;
  beforeModify?: () => string | null;
  checkDeliverableReady?: DeliverableReadyCheck;
} = {}): AgentMiddleware {
  let lastReadSig: string | null = null;
  let consecutiveCount = 0;
  let researchCallCount = 0;
  const researchBudget = options.general ? resolveResearchBudget(options) : null;
  const inspectionCounts = new Map<string, number>();
  const modifyTargetCounts = new Map<string, number>();
  let postDeliverableModifyCount = 0;

  // SKILL.md content never changes mid-run: the first read loads it, every
  // repeat is pure waste (observed as skill→plan→todos→repair→skill testing
  // loops on slow endpoints). Track by skill NAME (not path) so virtual-path
  // variants (/system-skills/x vs system-skills/x) can't dodge the guard.
  const loadedSkills = new Set<string>();

  const isModifying = (name: string) => /^(write_file|edit_file|delete|apply_patch|execute)$/i.test(name);
  const isInspection = (name: string) => /^(read_file|read_file_range|grep_search|glob|ls|view_file|search_code|code_structure|code_symbol)$/i.test(name);
  const isFileRead = (name: string) => /^(read_file|read_file_range)$/i.test(name);
  const isResearchTool = (name: string, args?: any) => {
    if (/^(web_search|web_image_search|web_video_search|browser_fetch_api|browser_inspect|search_web|fetch_url)$/i.test(name)) return true;
    // browser_act covers both research (navigate/text) and interaction
    // (click/fill/type). Only the research actions consume the budget.
    if (/^browser_act$/i.test(name)) {
      const action = String(args?.action || "").trim().toLowerCase();
      return action === "navigate" || action === "text";
    }
    return false;
  };

  // Per-target research repeat tracking: same URL/query fetched repeatedly
  // without progress gets a temporary per-run ban (that target only).
  const researchTargetCounts = new Map<string, number>();
  const bannedResearchTargets = new Set<string>();

  const normalizeResearchUrl = (raw: unknown): string => {
    const text = String(raw || "").trim();
    if (!text) return "";
    try {
      const parsed = new URL(text.includes("://") ? text : `https://${text}`);
      const host = parsed.hostname.toLowerCase();
      if (!host) return text.toLowerCase();
      const path = parsed.pathname.replace(/\/+$/, "") || "/";
      return `${host}${path}${parsed.search || ""}`.toLowerCase();
    } catch {
      return text.toLowerCase().replace(/\s+/g, "");
    }
  };

  // Stable per-target key so repeats of the same link/query are detected
  // across URL spellings (trailing slash, case, fragment).
  const researchTargetKey = (name: string, args?: any): string | null => {
    const tool = name.toLowerCase();
    if (tool === "web_search" || tool === "search_web") {
      const query = String(args?.query || "").trim().toLowerCase().replace(/\s+/g, " ");
      return query ? `q:${query}` : null;
    }
    if (tool === "browser_fetch_api" || tool === "fetch_url" || tool === "browser_inspect") {
      const url = normalizeResearchUrl(args?.url);
      return url ? `u:${url}` : null;
    }
    if (tool === "browser_act") {
      const action = String(args?.action || "").trim().toLowerCase();
      if (action === "navigate") {
        const url = normalizeResearchUrl(args?.url);
        return url ? `u:${url}` : null;
      }
      return null;
    }
    return null;
  };

  const normalizePath = (args: any) => {
    if (!args || typeof args !== "object") return "";
    const p = String(args.file_path || args.filePath || args.path || args.file || args.query || args.pattern || "");
    return p.replace(/\\/g, "/").replace(/^\/+/, "").trim();
  };

  return {
    name: "loopPreventionMiddleware",
    wrapToolCall: async (request: ToolCallRequest, next: (req: ToolCallRequest) => Promise<ToolResult>): Promise<ToolResult> => {
      const toolName = String(request.call?.name ?? "");
      const args = (request.call?.args ?? {}) as any;
      const toolCallId = request.toolCallId;

      if (isModifying(toolName)) {
        const gate = options.beforeModify?.();
        if (gate) {
          return blocked(gate);
        }

        // Post-deliverable completion gate for Home deliverable runs:
        // Once the requested deliverable is already verified on disk, allow at most 1
        // rebuild. Block subsequent QA/diagnostic scripts or endless generator tweaking.
        if (options.general && options.outputRequired && options.checkDeliverableReady) {
          try {
            const readyInfo = await options.checkDeliverableReady();
            if (readyInfo && readyInfo.ready) {
              postDeliverableModifyCount++;
              const rawTarget = String(args.file_path || args.filePath || args.command || "");
              const isDiagnosticOrTemp = /validate|contrast|inspect|scan|debug|find|check|test/i.test(rawTarget);
              if (isDiagnosticOrTemp || postDeliverableModifyCount >= 3) {
                return blocked(`[DELIVERABLE ALREADY VERIFIED]: Your output (${readyInfo.files.join(", ")}: ${readyInfo.summary}) already exists on disk and passed structural and content verification. Stop writing validation/debug scripts or tweaking the generator. Delete any temporary helper scripts (.py/.js) you created in this run, mark any remaining todos as completed, and present your final response to the user now.`);
              }
            }
          } catch { /* best effort */ }
        }

        // Edit-run churn detector: track repeated edits/runs on the same target
        const modTarget = normalizePath(args) || String(args.command || "").slice(0, 80);
        if (modTarget) {
          const modCount = (modifyTargetCounts.get(modTarget) ?? 0) + 1;
          modifyTargetCounts.set(modTarget, modCount);
          if (modCount >= 5 && options.general) {
            return blocked(`[EDIT/EXECUTION CHURN DETECTED]: Target '${modTarget}' has been modified or executed ${modCount} times without concluding the task. Stop tweaking minor parameters. If the deliverable exists, verify it with 'ls' and present your result immediately.`);
          }
        }

        inspectionCounts.clear();
        lastReadSig = null;
        consecutiveCount = 0;
        researchCallCount = 0;
        researchTargetCounts.clear();
        bannedResearchTargets.clear();
        return next(request);
      }

      // Per-target repeat ban for research: same URL/query stuck in a loop
      // gets banned (that link only) with a steer-forward to the next source
      // instead of aborting the whole run. Banned calls never execute and
      // never consume the research budget.
      if (isResearchTool(toolName, args)) {
        const targetKey = researchTargetKey(toolName, args);
        if (targetKey && bannedResearchTargets.has(targetKey)) {
          return blocked(`[RESEARCH TARGET BANNED]: '${targetKey.slice(2)}' was already fetched repeatedly without progress and is banned for the rest of this run. Do NOT retry it. Move on: try a different source URL or a rephrased query, or continue with the next pending plan item (e.g. if LangChain docs failed, research LangGraph next).`);
        }
        if (targetKey) {
          const repeatCount = (researchTargetCounts.get(targetKey) ?? 0) + 1;
          researchTargetCounts.set(targetKey, repeatCount);
          if (repeatCount >= 3) {
            bannedResearchTargets.add(targetKey);
            return blocked(`[RESEARCH TARGET BANNED]: '${targetKey.slice(2)}' failed or repeated ${repeatCount}x without progress — it is now banned for this run. Do NOT retry it. Switch to a different source or rephrased query and continue with the next plan item.`);
          }
          if (repeatCount === 2) {
            const result = await next(request);
            let currentContent = resultText(result);
            currentContent += `\n\n[Notice: You already fetched '${targetKey.slice(2)}'. If this result is not useful, do NOT fetch it again — try a different source URL or a rephrased query, or move to the next plan item.]`;
            const budgetBlocked = researchBudget !== null && (() => {
              researchCallCount++;
              return researchCallCount > researchBudget;
            })();
            if (budgetBlocked) {
              return `[SUPERVISOR INTERVENTION] The research budget for this task has been reached (${researchBudget} web lookups). Use the evidence already collected and take the next result-producing action. Do not perform another web search or page fetch unless it directly unblocks creation of the requested output.`;
            }
            return withText(result, currentContent);
          }
        }
      }

      if (researchBudget !== null && isResearchTool(toolName, args)) {
        researchCallCount++;
        if (researchCallCount > researchBudget) {
          return `[SUPERVISOR INTERVENTION] The research budget for this task has been reached (${researchBudget} web lookups). Use the evidence already collected and take the next result-producing action. Do not perform another web search or page fetch unless it directly unblocks creation of the requested output.`;
        }
      }

      // Binary / archive file read guard: reading binary files into LLM context as text
      // corrupts context, triggers token errors, or stalls the run.
      if (isFileRead(toolName)) {
        const filePath = normalizePath(args);
        if (BINARY_FILE_EXT.test(filePath)) {
          return blocked(`[BINARY FILE]: '${filePath}' is a binary file and cannot be read as text. If this is an image or deliverable, reference it by path or check its size/existence with 'ls'. Do not call read_file on binary or archive files.`);
        }

        const skill = extractSkillNameFromPath(filePath);
        if (skill) {
          const key = skill.toLowerCase();
          if (loadedSkills.has(key)) {
            return blocked(`[SKILL ALREADY LOADED]: Skill '${skill}' is already loaded above — its instructions have not changed. Do NOT re-read any SKILL.md file. Proceed directly: write_file the generator script, execute it, verify the output with ls, then present the result.`);
          }
          const result = await next(request);
          loadedSkills.add(key);
          return result;
        }
      }

      if (isInspection(toolName)) {
        const target = normalizePath(args);
        const sig = `${toolName}:${target}`;
        const totalCount = (inspectionCounts.get(sig) ?? 0) + 1;
        inspectionCounts.set(sig, totalCount);

        if (sig === lastReadSig) {
          consecutiveCount++;
        } else {
          lastReadSig = sig;
          consecutiveCount = 1;
        }

        // 3rd+ consecutive repetition or 4th total inspection without modifying actions:
        // Intervene and short-circuit! Do NOT re-execute the tool.
        if (consecutiveCount >= 3 || totalCount >= 4) {
          return blocked(`[LOOP PREVENTION NOTICE]: You have already inspected '${target || toolName}' multiple times (${totalCount}x) without making any workspace edits or code changes. The file content has not changed.\n\nCRITICAL INSTRUCTIONS:\n1. Stop inspecting or re-reading files.\n2. If build or tests already passed and required changes are in place, call write_todos to mark remaining in-progress todos as completed.\n3. Output your final response to the user immediately detailing the changes made.`);
        }

        const result = await next(request);

        // 2nd consecutive repetition or 2nd total inspection of the same target:
        // Append proactive steering notice to guide the model before a hard block.
        if (consecutiveCount === 2 || totalCount === 2) {
          const nudge = `\n\n[Notice: You already inspected '${target || toolName}'. The content has not changed. Do NOT re-read or inspect this again. If your build or verification passed, update your todo list to completed with write_todos and present your final response now.]`;
          return withText(result, resultText(result) + nudge);
        }

        return result;
      }

      return next(request);
    },
  };
}
