// Agent middleware contract — the self-built replacement for LangChain's
// createMiddleware. Nexus only ever used wrapToolCall (hooks enforcement,
// loop prevention); the model-request normalization the old stack did through
// wrapModelCall now happens inside the loop before tool execution. A middleware
// may execute the call via `next` and post-process the result, or short-circuit
// with its own result (steering notice / denial) without running the tool.

import type { ToolCall } from "./messages.js";
import type { AgentTool, ToolCallContext } from "./tools.js";

export type ToolResult = string | { content: string; isError?: boolean };

export interface ToolCallRequest {
  call: ToolCall;
  tool?: AgentTool;
  toolCallId: string;
  runId?: string;
}

export interface AgentMiddleware {
  name: string;
  wrapToolCall?(
    request: ToolCallRequest,
    next: (request: ToolCallRequest) => Promise<ToolResult>
  ): Promise<ToolResult>;
}

export function asToolResult(result: ToolResult): { content: string; isError: boolean } {
  if (typeof result === "string") return { content: result, isError: false };
  return { content: result.content, isError: Boolean(result.isError) };
}

/**
 * Runs the middleware chain around one tool execution: first-registered
 * middleware is outermost (mirrors the old array order passed to
 * createDeepAgent). Every middleware is awaited in order.
 */
export async function runToolMiddleware(
  middlewares: AgentMiddleware[],
  request: ToolCallRequest,
  execute: (request: ToolCallRequest) => Promise<ToolResult>
): Promise<{ content: string; isError: boolean }> {
  const dispatch = async (index: number, req: ToolCallRequest): Promise<ToolResult> => {
    if (index >= middlewares.length) return execute(req);
    const middleware = middlewares[index];
    if (!middleware?.wrapToolCall) return dispatch(index + 1, req);
    return middleware.wrapToolCall(req, (nextReq) => dispatch(index + 1, nextReq));
  };
  return asToolResult(await dispatch(0, request));
}

export type { ToolCallContext };
