// Zod → JSON Schema. The project pins zod v4, whose native toJSONSchema covers
// every builtin tool schema; MCP tools arrive pre-serialized as raw JSON
// Schema and skip this path entirely. Extracted from the token-estimation
// walker in context-service.ts so tool definitions and estimators share it.

import { z } from "zod";

export function zodToJSONSchema(schema: unknown): Record<string, unknown> | null {
  if (!schema || typeof schema !== "object") return null;
  try {
    const json = z.toJSONSchema(schema as z.ZodTypeAny, { io: "input", unrepresentable: "any" });
    if (json && typeof json === "object") return json as Record<string, unknown>;
  } catch { /* not a zod v4 schema */ }
  return null;
}

/** Rough schema size text for token estimation (shared by context-budget). */
export function schemaToText(schema: unknown, depth = 0): string {
  if (!schema || depth > 8) return "";
  if (typeof schema === "string") return schema;
  const json = zodToJSONSchema(schema);
  if (json) return JSON.stringify(json);
  try {
    if (typeof (schema as any).shape === "object" && (schema as any).shape) {
      return `{${Object.entries((schema as any).shape).map(([key, value]) => `${key}:${schemaToText(value, depth + 1)}`).join(",")}}`;
    }
  } catch { /* fall through */ }
  try { return JSON.stringify(schema) || ""; } catch { return ""; }
}
