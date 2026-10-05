// Run-loop control: the doom-loop breaker circuit and the LangChain middleware
// that steers/blocks repetitive inspection and normalizes tool arguments.
// Extracted from agent-service.ts.
import { ToolMessage } from "@langchain/core/messages";
import { createMiddleware } from "langchain";
import { extractSkillNameFromPath } from "./tool-describe.js";

// OpenCode-style doom-loop breaker: the model repeating the exact same tool
// call is stuck, not working. Thrown from the stream consumer and converted
// into a resumable partial result at graph.invoke — never retried.
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
 * snake_case `file_path` for DeepAgents filesystem tools (read_file, write_file,
 * edit_file, delete) succeed without validation crashes.
 */
export function toolParameterNormalizationMiddleware() {
  const normalize = (toolCalls: any[]) => {
    if (!Array.isArray(toolCalls)) return;
    for (const tc of toolCalls) {
      if (tc?.args && typeof tc.args === "object") {
        if ("filePath" in tc.args && !("file_path" in tc.args)) {
          tc.args.file_path = tc.args.filePath;
        }
        if ("path" in tc.args && !("file_path" in tc.args)) {
          tc.args.file_path = tc.args.path;
        }
      }
    }
  };

  return createMiddleware({
    name: "toolParameterNormalizationMiddleware",
    wrapModelCall: async (request: any, handler: any) => {
      const response = await handler(request);
      if (response && Array.isArray((response as any).tool_calls)) {
        normalize((response as any).tool_calls);
      }
      return response;
    },
    afterModel: (state: any) => {
      const messages = state?.messages;
      if (!messages || messages.length === 0) return undefined;
      for (const msg of messages) {
        if (msg?.tool_calls) {
          normalize(msg.tool_calls);
        }
      }
      return undefined;
    },
  });
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
 * Repetition 3+: Blocks execution of the tool, returning an intervention ToolMessage directing the model
 *                to update its todo list and provide its final answer immediately.
 */
export function loopPreventionMiddleware(options: { general?: boolean; outputRequired?: boolean; beforeModify?: () => string | null } = {}) {
  let lastReadSig: string | null = null;
  let consecutiveCount = 0;
  let researchCallCount = 0;
  const inspectionCounts = new Map<string, number>();
  // SKILL.md content never changes mid-run: the first read loads it, every
  // repeat is pure waste (observed as skill→plan→todos→repair→skill testing
  // loops on slow endpoints). Track by skill NAME (not path) so virtual-path
  // variants (/system-skills/x vs system-skills/x) can't dodge the guard.
  const loadedSkills = new Set<string>();

  const isModifying = (name: string) => /^(write_file|edit_file|delete|apply_patch|execute)$/i.test(name);
  const isInspection = (name: string) => /^(read_file|read_file_range|grep_search|glob|ls|view_file|search_code|code_structure|code_symbol)$/i.test(name);
  const isFileRead = (name: string) => /^(read_file|read_file_range)$/i.test(name);
  const isResearchTool = (name: string) => /^(web_search|browser_fetch_api|browser_inspect|search_web|fetch_url)$/i.test(name);

  const normalizePath = (args: any) => {
    if (!args || typeof args !== "object") return "";
    const p = String(args.file_path || args.filePath || args.path || args.file || args.query || args.pattern || "");
    return p.replace(/\\/g, "/").replace(/^\/+/, "").trim();
  };

  return createMiddleware({
    name: "loopPreventionMiddleware",
    wrapToolCall: async (request: any, handler: any) => {
      const toolName = String(request.tool?.name ?? request.toolCall?.name ?? "");
      const args = request.toolCall?.args ?? {};
      const toolCallId = String(request.toolCall?.id ?? "");

      if (isModifying(toolName)) {
        const gate = options.beforeModify?.();
        if (gate) {
          return new ToolMessage({
            tool_call_id: toolCallId,
            name: toolName,
            status: "error",
            content: gate,
          });
        }
        inspectionCounts.clear();
        lastReadSig = null;
        consecutiveCount = 0;
        researchCallCount = 0;
        return handler(request);
      }

      if (options.general && options.outputRequired && isResearchTool(toolName)) {
        researchCallCount++;
        if (researchCallCount > 8) {
          return new ToolMessage({
            tool_call_id: toolCallId,
            name: toolName,
            content: "[SUPERVISOR INTERVENTION] The research budget for this task has been reached. Use the evidence already collected and take the next result-producing action. Do not perform another web search or page fetch unless it directly unblocks creation of the requested output.",
          });
        }
      }

      // Skill reads bypass the generic inspection counters (a plan/todos call
      // in between would reset them): first read executes, repeats get a
      // cached steer-forward instead of the file content.
      if (isFileRead(toolName)) {
        const skill = extractSkillNameFromPath(normalizePath(args));
        if (skill) {
          const key = skill.toLowerCase();
          if (loadedSkills.has(key)) {
            return new ToolMessage({
              tool_call_id: toolCallId,
              name: toolName,
              status: "error",
              content: `[SKILL ALREADY LOADED]: Skill '${skill}' is already loaded above — its instructions have not changed. Do NOT re-read any SKILL.md file. Proceed directly: write_file the generator script, execute it, verify the output with ls, then present the result.`,
            });
          }
          const result = await handler(request);
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
          return new ToolMessage({
            tool_call_id: toolCallId,
            name: toolName,
            status: "error",
            content: `[LOOP PREVENTION NOTICE]: You have already inspected '${target || toolName}' multiple times (${totalCount}x) without making any workspace edits or code changes. The file content has not changed.\n\nCRITICAL INSTRUCTIONS:\n1. Stop inspecting or re-reading files.\n2. If build or tests already passed and required changes are in place, call write_todos to mark remaining in-progress todos as completed.\n3. Output your final response to the user immediately detailing the changes made.`,
          });
        }

        const result = await handler(request);

        // 2nd consecutive repetition or 2nd total inspection of the same target:
        // Append proactive steering notice to guide the model before a hard block.
        if (consecutiveCount === 2 || totalCount === 2) {
          const currentContent = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
          const nudge = `\n\n[Notice: You already inspected '${target || toolName}'. The content has not changed. Do NOT re-read or inspect this again. If your build or verification passed, update your todo list to completed with write_todos and present your final response now.]`;
          result.content = currentContent + nudge;
        }

        return result;
      }

      return handler(request);
    },
  });
}
