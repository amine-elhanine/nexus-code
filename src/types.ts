export type PlanItem = { content: string; status: "pending" | "in_progress" | "completed" };
export type AgentUsage = { inputTokens: number; outputTokens: number; totalTokens: number; estimatedCost: number | null };
export function formatCost(cost: number | null | undefined): string {
  return cost == null ? "—" : `~$${cost.toFixed(4)}`;
}
export type SubagentRole = "researcher" | "tester" | "coder";
export type SubagentStep = { toolName: string; summary?: string; timestamp: string };
export type SubagentItem = { id: string; role: SubagentRole; task: string; status: "running" | "completed" | "failed"; steps: SubagentStep[]; output?: string; usage?: AgentUsage };
export type ArtifactStatus = "draft" | "pending_approval" | "approved" | "completed" | "rejected";
export type ArtifactItem = { id: string; sessionId: string; name: string; filename: string; path: string; content: string; status: ArtifactStatus; userFacing: boolean; requestFeedback: boolean; createdAt: string; updatedAt: string };
export type AgentEvent = { type: "status" | "tool" | "token" | "assistant" | "plan" | "error" | "usage" | "subagent" | "artifact"; sessionId: string; text: string; timestamp: string; items?: PlanItem[]; usage?: AgentUsage; subagent?: SubagentItem; artifact?: ArtifactItem; detail?: string };
export type ProviderDefinition = { id: string; label: string; packageName: string; envKey: string; defaultBaseUrl?: string; models: string[] };
export type ProviderConfig = { id: string; label: string; provider: string; apiKey: string; baseUrl?: string; models: string[]; modelEndpoints?: Partial<Record<string, ChatEndpointKind>> };
export type ChatEndpointKind = "chat" | "responses" | "messages";
export type SessionRecord = { id: string; title: string; createdAt: string; updatedAt: string; memory: string; checkpointId?: string; checkpointIds?: string[]; usage?: AgentUsage; messages: Array<{ role: "user" | "assistant" | "event"; text: string; images?: string[]; kind?: AgentEvent["type"]; createdAt: string; plan?: PlanItem[]; usage?: AgentUsage; subagent?: SubagentItem; artifact?: ArtifactItem }>; model?: { providerId: string; model: string } };
export type ChatAttachment = { url: string; name: string; mimeType: string; size: number };
export type ProjectRecord = { id: string; name: string; root: string; createdAt: string; updatedAt: string; memory: string; sessions: SessionRecord[] };
export type AppView = "chat" | "files" | "diff" | "terminal" | "browser" | "memory";
export type ChatItem = { role: "user" | "assistant" | "event"; text: string; images?: string[]; attachments?: ChatAttachment[]; kind?: AgentEvent["type"]; createdAt: string; plan?: PlanItem[]; usage?: AgentUsage; subagent?: SubagentItem; artifact?: ArtifactItem; detail?: string };
export type FileEntry = { path: string; kind: "file" | "folder" };
export type WorkspaceDiffFile = { path: string; directory: string; name: string; additions: number; deletions: number; status: string; patch: string };
export type DiffSide = { number?: number; text: string };
export type SplitDiffRow = { kind: "context" | "change" | "added" | "deleted" | "hunk"; old?: DiffSide; new?: DiffSide; text?: string };
export type NotebookMeta = { id: string; name: string; description?: string; createdAt: string; updatedAt: string };
export type NotebookSourceStatus = "uploaded" | "parsing" | "chunking" | "indexing" | "ready" | "failed";
export type NotebookSource = { id: string; notebookId: string; filename: string; size: number; chars: number; chunks: number; status: NotebookSourceStatus; parser?: string; fingerprint?: string; pageCount?: number; error?: string; createdAt: string; updatedAt: string };
export type NotebookCitation = { index: number; sourceId: string; sourceName: string; chunkId: string; heading: string; excerpt: string; snippet: string; score: number };
export type NotebookEvaluation = { groundedness: number; verdict: "grounded" | "partial" | "ungrounded"; issues: string[] };
export type NotebookMessageMetadata = { routing?: string; topScore?: number; refused?: boolean; fallbackModel?: boolean };
export type NotebookChatMessage = { id?: string; role: "user" | "assistant"; text: string; createdAt: string; citations?: NotebookCitation[]; evaluation?: NotebookEvaluation; retrieval?: Array<{ chunkId: string; sourceName: string; score: number; methods: string[] }>; metadata?: NotebookMessageMetadata };
export type NotebookChat = { id: string; notebookId: string; title: string; createdAt: string; updatedAt: string; messages: NotebookChatMessage[] };
export type NotebookSettings = { instructions: string; updatedAt: string };
export type NotebookNote = { id: string; notebookId: string; title: string; content: string; citations: NotebookCitation[]; createdAt: string; updatedAt: string };
export type NotebookStats = { sources: number; readySources: number; chunks: number; sections: number; embeddingModel: string | null; dims: number; entities: number; conversations: number; digest: { topics: string[]; updatedAt: string } | null; updatedAt: string | null };
export type NotebookEmbeddingConfig = { providerId: string; model: string };
export type EmbeddingEndpointKind = "openai" | "ollama" | "gemini" | "cohere";
export type EmbeddingProviderConfig = { id: string; name: string; kind: EmbeddingEndpointKind; baseUrl?: string; apiKey: string; models: string[] };
export type NotebookRagAnswer = { answer: string; sources: NotebookCitation[]; retrieval: Array<{ chunkId: string; sourceName: string; score: number; methods: string[] }>; metadata: NotebookMessageMetadata; embeddingModel: string; dims: number };
export type NotebookPassage = { chunkId: string; sourceId: string; sourceName: string; headingPath: string[]; text: string; prevText: string | null; nextText: string | null; sectionSummary: string | null };
export type McpTransport = "stdio" | "http" | "sse";
export type McpServerConfig = { id: string; name: string; enabled: boolean; transport: McpTransport; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> };
export type McpTestResult = { ok: boolean; tools: string[]; error?: string };
export type SkillInfo = { name: string; description: string; path: string; source: "global" | "project" };
export type ConfirmDialogState = {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
};
export type TrajectoryStep = { step_index: number; timestamp: string; source: string; type: string; content: string; thinking?: string; tool_calls?: Array<{ name: string; args: any }>; usage?: AgentUsage };
export type UpdaterState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "up-to-date"; version: string }
  | { status: "available"; version: string }
  | { status: "downloading"; version: string; percent: number }
  | { status: "downloaded"; version: string }
  | { status: "error"; message: string };
