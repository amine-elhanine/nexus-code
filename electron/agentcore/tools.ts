// Agent tool model: the self-built replacement for @langchain/core's tool()
// factory. Same authoring ergonomics — a zod schema plus an execute function —
// but the object is plain data so the loop can send it to any provider wire
// format. The zod schema stays authoritative for validation and token
// estimation; the JSON-Schema projection is what providers receive.
import type { z } from "zod";
import { zodToJSONSchema } from "./zod-schema.js";

export interface ToolCallContext {
  signal?: AbortSignal;
  runId?: string;
}

export interface AgentTool {
  name: string;
  description: string;
  /** JSON Schema projection sent to providers. */
  parameters: Record<string, unknown>;
  /** Zod schema — validated before execute, reused for token estimation. */
  schema?: unknown;
  execute(args: any, ctx?: ToolCallContext): Promise<string> | string;
}

/**
 * Define an agent tool. Mirrors the old `tool(fn, { name, description,
 * schema })` call shape: args are zod-validated before `execute` runs, and a
 * validation failure returns a string error for the model instead of throwing.
 */
export function defineTool<S extends z.ZodTypeAny>(def: {
  name: string;
  description: string;
  schema: S;
  execute(args: z.output<S>, ctx?: ToolCallContext): Promise<string> | string;
}): AgentTool {
  const parameters = zodToJSONSchema(def.schema) ?? { type: "object", properties: {}, additionalProperties: true };
  return {
    name: def.name,
    description: def.description,
    parameters,
    schema: def.schema,
    execute: async (args: any, ctx?: ToolCallContext) => {
      let parsed: unknown = args ?? {};
      if (def.schema) {
        try {
          parsed = def.schema.parse(args ?? {});
        } catch (error: any) {
          const issues = error?.issues?.map((i: any) => `${i.path?.join(".") || "args"}: ${i.message}`).join("; ");
          return `[Invalid tool arguments] ${issues || error?.message || String(error)}`;
        }
      }
      return await def.execute(parsed as z.output<S>, ctx);
    },
  };
}

/** Normalize any tool-ish object into the AgentTool shape (MCP, plugins). */
export function asAgentTool(tool: {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  schema?: unknown;
  execute: (args: any, ctx?: ToolCallContext) => Promise<string> | string;
}): AgentTool {
  return {
    name: tool.name,
    description: tool.description || "",
    parameters: tool.parameters ?? zodToJSONSchema(tool.schema) ?? { type: "object", properties: {}, additionalProperties: true },
    schema: tool.schema,
    execute: tool.execute,
  };
}

/**
 * Function-first constructor matching the long-standing `tool(fn, { name,
 * description, schema })` call shape used across the tool modules — now the
 * agent-core factory instead of @langchain/core's. Args are zod-validated
 * before `execute` runs, exactly like the old factory.
 */
export function tool<S extends z.ZodTypeAny>(
  execute: (args: z.output<S>, ctx?: ToolCallContext) => Promise<string> | string,
  config: { name: string; description?: string; schema: S }
): AgentTool {
  return defineTool({
    name: config.name,
    description: config.description ?? "",
    schema: config.schema,
    execute,
  });
}

/** Tool names available to a run — used by prompt assembly and gating. */
export function toolNames(tools: AgentTool[]): string[] {
  return tools.map((t) => t.name).filter(Boolean);
}
