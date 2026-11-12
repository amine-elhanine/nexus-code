// Zod schemas for renderer→main IPC payloads at the trust boundary.
//
// The renderer is NOT trusted: it is sandboxed, but a compromised renderer
// (XSS, malicious webview content) can call any exposed channel. These
// schemas fail closed with a clear error on malformed payloads instead of
// letting bad types/sizes reach stores, services, or providers.
//
// Design rules:
// - Validate-and-throw only: handlers keep forwarding the ORIGINAL payload,
//   so valid calls behave byte-for-byte as before (no silent field stripping).
// - Narrow, not exhaustive: shape/type/size/enum checks that mirror what the
//   services already assume; no opinionated business rules here (services own
//   those, e.g. path containment in project-tools, permission gates).
// - Trusted internal main→main calls are NOT routed through these schemas.

import { z } from "zod";

/** Throw a clear fail-closed error when the payload does not match the schema. */
export function assertPayload(
  schema: { safeParse(input: unknown): { success: boolean; error?: { issues?: Array<{ message: string; path?: unknown[] }> } } },
  input: unknown,
  label: string,
): void {
  const parsed = schema.safeParse(input);
  if (parsed.success) return;
  const issues = parsed.error?.issues ?? [];
  const detail = issues
    .slice(0, 5)
    .map((issue) => `${issue.path?.length ? issue.path.join(".") + ": " : ""}${issue.message}`)
    .join("; ");
  throw new Error(`Invalid ${label} payload: ${detail || "schema mismatch"}`);
}

/** Same contract, returning a boolean for callers that prefer look-before-run. */
export function payloadMatches(schema: Parameters<typeof assertPayload>[0], input: unknown): boolean {
  return schema.safeParse(input).success;
}

const NonEmptyString = z.string().min(1).max(4_000);
// Renderer-sent identifiers (session/project/provider/notebook/chat ids).
const IdString = z.string().min(1).max(200);
// OPTIONAL model-selection fields (providerId/model/effort) the renderer
// populates straight from possibly-empty session/model state — "" arrives on
// the wire as a legitimate "unset" (observed live: effort: "" on home:run).
// Only size-bounded here; services treat "" as absent.
const OptionalId = z.string().max(200).optional();
const OptionalModel = z.string().max(200).optional();
const OptionalEffort = z.string().max(40).optional();

// ---------------------------------------------------------------- providers

export const ProviderCreateSchema = z.looseObject({
  provider: NonEmptyString,
  label: NonEmptyString,
  apiKey: z.string().max(4_096),
  baseUrl: z.string().max(2_048).optional(),
});

export const ProviderUpdateMetaSchema = z.looseObject({
  label: z.string().max(200).optional(),
  baseUrl: z.string().max(2_048).optional(),
});

export const ProviderUpdateKeySchema = z.tuple([IdString, z.string().max(4_096)]);

export const ProviderSetEnabledSchema = z.tuple([IdString, z.boolean()]);

export const ProviderModelsAddSchema = z.tuple([
  IdString,
  z.array(NonEmptyString).min(1).max(200),
  z.record(z.string(), z.array(NonEmptyString)).optional(),
]);

export const ProviderModelsUpdateSchema = z.tuple([
  IdString,
  NonEmptyString,
  z.looseObject({
    newName: z.string().max(200).optional(),
    endpoint: z.enum(["", "chat", "responses", "messages"]).optional(),
    efforts: z.array(NonEmptyString).max(20).optional(),
  }),
]);

export const ProviderModelDetectSchema = z.tuple([IdString, NonEmptyString]);

export const ProviderModelsRemoveSchema = z.tuple([IdString, NonEmptyString]);

export const ProviderRemoveSchema = z.tuple([IdString]);

export const ProviderFetchModelsSchema = z.looseObject({
  providerId: OptionalId,
  baseUrl: z.string().max(2_048).optional(),
  apiKey: z.string().max(4_096).optional(),
});

// ---------------------------------------------------------------------- MCP

export const McpSaveSchema = z.looseObject({
  id: IdString.optional(),
  name: NonEmptyString,
  enabled: z.boolean(),
  transport: z.enum(["stdio", "http", "sse"]),
  command: z.string().max(1_024).optional(),
  args: z.array(z.string().max(4_096)).max(100).optional(),
  env: z.record(z.string(), z.string().max(16_384)).optional(),
  url: z.string().max(2_048).optional(),
  headers: z.record(z.string(), z.string().max(16_384)).optional(),
});

export const McpTestSchema = McpSaveSchema.omit({ id: true, enabled: true });

export const McpRemoveSchema = z.tuple([IdString]);

// ------------------------------------------------------------------- skills

export const SkillCreateSchema = z.looseObject({
  name: z.string().min(1).max(120),
  description: z.string().max(1_000).optional(),
  scope: z.enum(["global", "project"]),
  content: z.string().max(1_000_000).optional(),
  modes: z.array(z.string().max(40)).max(10).optional(),
});

export const SkillSetModesSchema = z.looseObject({
  skillPath: z.string().min(1).max(1_024),
  modes: z.array(z.string().max(40)).max(10),
});

export const SkillChangeScopeSchema = z.looseObject({
  skillPath: z.string().min(1).max(1_024),
  targetScope: z.enum(["global", "project"]),
});

// ---------------------------------------------------------------- notebook

const FileIds = z.array(IdString).max(200).optional();
const ModelOverrides = {
  providerId: OptionalId,
  model: OptionalModel,
};

export const NotebookDocumentGenerateSchema = z.looseObject({
  notebookId: IdString,
  kind: z.enum(["report", "slides"]),
  format: z.enum(["docx", "pdf", "pptx"]),
  prompt: z.string().max(20_000).optional(),
  fileIds: FileIds,
  ...ModelOverrides,
});

export const NotebookGeneratePayloadSchema = z.looseObject({
  notebookId: IdString,
  topic: z.string().max(500).optional(),
  count: z.number().int().min(1).max(50).optional(),
  fileIds: FileIds,
  ...ModelOverrides,
});

export const NotebookMindmapGenerateSchema = z.looseObject({
  notebookId: IdString,
  topic: z.string().max(500).optional(),
  maxNodes: z.number().int().min(3).max(100).optional(),
  fileIds: FileIds,
  ...ModelOverrides,
});

export const NotebookSummaryGenerateSchema = z.looseObject({
  notebookId: IdString,
  topic: z.string().max(500).optional(),
  length: z.enum(["brief", "standard", "detailed"]).optional(),
  fileIds: FileIds,
  ...ModelOverrides,
});

export const NotebookAskSchema = z.looseObject({
  notebookId: IdString,
  chatId: IdString,
  question: z.string().min(1).max(20_000),
  fileIds: FileIds,
  effort: OptionalEffort,
  topK: z.number().int().min(1).max(50).optional(),
  ...ModelOverrides,
});

export const NotebookEmbeddingProviderSchema = z.looseObject({
  id: IdString.optional(),
  label: z.string().max(200),
  baseUrl: z.string().min(1).max(2_048),
  apiKey: z.string().max(4_096),
  model: NonEmptyString,
  dims: z.number().int().min(1).max(10_000).optional(),
}).loose();

export const NotebookEmbeddingSaveSchema = z.looseObject({
  providerId: IdString,
  model: NonEmptyString,
});

// -------------------------------------------------------------- attachments

// 25 MB attachment cap (see attachments:save) → base64 is at most ~33.4M chars;
// allow 34M so byte-exact caps reproduce the original "too large" error path.
export const AttachmentSaveSchema = z.looseObject({
  data: z.string().min(1).max(34_000_000),
  filename: z.string().max(255).optional(),
});

// ------------------------------------------------------------ agent runs

const RunAttachments = z.array(z.looseObject({
  url: z.string().min(1).max(2_048),
  name: z.string().max(255).optional(),
  mimeType: z.string().max(200).optional(),
  size: z.number().int().min(0).optional(),
})).max(20).optional();

export const AgentRunSchema = z.looseObject({
  request: z.string().min(0).max(400_000),
  images: z.array(z.string().max(2_048)).max(10).optional(),
  attachments: RunAttachments,
  providerId: OptionalId,
  model: OptionalModel,
  effort: OptionalEffort,
  contextWindow: z.number().int().min(1_000).max(100_000_000).optional(),
  maxOutput: z.number().int().min(16).max(1_000_000).optional(),
  mode: z.enum(["plan", "ask", "auto", "full"]).optional(),
  sessionId: IdString.optional(),
  projectId: IdString.optional(),
});

export const HomeRunSchema = z.looseObject({
  sessionId: IdString,
  request: z.string().min(0).max(400_000),
  images: z.array(z.string().max(2_048)).max(10).optional(),
  attachments: RunAttachments,
  providerId: OptionalId,
  model: OptionalModel,
  effort: OptionalEffort,
  contextWindow: z.number().int().min(1_000).max(100_000_000).optional(),
  maxOutput: z.number().int().min(16).max(1_000_000).optional(),
});

// --------------------------------------------------------------- settings

/** Records of secrets must round-trip through masking; model fields stay free. */
export const AgentSettingsSaveSchema = z.looseObject({
  provider: z.record(z.string(), z.unknown()).optional(),
  model: z.string().max(200).optional(),
  apiKey: z.string().max(4_096).optional(),
  baseUrl: z.string().max(2_048).optional(),
  effort: z.string().max(40).optional(),
  reasoningEffort: z.string().max(40).optional(),
  contextWindow: z.number().int().min(0).max(100_000_000).optional(),
  maxOutput: z.number().int().min(0).max(1_000_000).optional(),
}).loose();

export const AppSettingsSaveSchema = z.looseObject({
  browserHeadless: z.boolean().optional(),
  editPolicy: z.enum(["auto", "ask"]).optional(),
  notebookRerankEnabled: z.boolean().optional(),
  notebookRerankProviderId: IdString.optional(),
  notebookRerankModel: NonEmptyString.optional(),
  notebookVisionEnabled: z.boolean().optional(),
  notebookVisionProviderId: IdString.optional(),
  notebookVisionModel: NonEmptyString.optional(),
  theme: z.string().max(40).optional(),
}).loose();

export const EmbeddingProviderUpsertSchema = NotebookEmbeddingProviderSchema;

// ------------------------------------------------------------- config toggles

export const ConfigToggleSchema = z.looseObject({ enabled: z.boolean() });

// -------------------------------------------------------------- workspace

// Relative workspace path (safePath in project-tools owns containment; this
// only bounds type/size before it gets there).
const WorkspacePath = z.string().min(1).max(2_048);

export const WorkspaceReadSchema = z.tuple([WorkspacePath]);
export const WorkspaceWriteSchema = z.tuple([WorkspacePath, z.string().max(20_000_000)]);
export const WorkspaceCommandSchema = z.tuple([z.string().min(1).max(16_000)]);
export const WorkspaceRevertHunkSchema = z.tuple([WorkspacePath, z.string().min(1).max(1_000)]);
export const WorktreeMergeSchema = z.tuple([IdString, z.string().max(2_000).optional()]);
export const ArtifactUpdateStatusSchema = z.tuple([
  IdString,
  z.string().min(1).max(255),
  z.enum(["draft", "pending_approval", "approved", "completed", "rejected"]),
]);

// ------------------------------------------------------------------- skills

export const SkillsImportSchema = z.looseObject({
  sourcePath: z.string().min(1).max(2_048),
  scope: z.enum(["global", "project"]),
});

// ---------------------------------------------------------------- notebook

export const NotebookParserSaveSchema = z.looseObject({
  provider: z.enum(["local", "llamaparse"]).optional(),
  enabled: z.boolean().optional(),
  apiKey: z.string().max(4_096).optional(),
  baseUrl: z.string().max(2_048).optional(),
  tier: z.enum(["fast", "cost_effective", "agentic", "agentic_plus"]).optional(),
  version: z.string().max(40).optional(),
  timeoutSeconds: z.number().int().min(1).max(600).optional(),
});

// Single attachment URL (attachments:read).
export const AttachmentReadSchema = z.tuple([z.string().min(1).max(2_048)]);

// --------------------------------------------------------------- run cancel

// Cancel may be called without a session id (cancels all pending approvals).
export const AgentCancelSchema = z.tuple([IdString.optional()]);

// ------------------------------------------------------------ session update

// session:update patch — what the renderer may legitimately write on a session
// record. Deliberately STRICT: messages/usage/checkpointIds are main-owned
// state (compaction, run bookkeeping) and a compromised renderer must not be
// able to overwrite them through this channel. Title/model are the only
// renderer-driven fields today.
export const SessionUpdateSchema = z.object({
  title: z.string().max(300).optional(),
  model: z.object({
    providerId: OptionalId,
    model: OptionalModel,
    effort: OptionalEffort,
  }).optional(),
}).strict();
