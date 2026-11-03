// Built-in tool catalog: registers every first-party LangChain tool family in
// the capability registry (owner "builtin") so there is ONE inventory of what
// the agent can do, in modes, regardless of execution path.
//
// Execution pipeline status (see docs/TOOL_PIPELINE.md):
// - built-ins currently execute on their per-family LangChain paths with
//   mode/permission gates applied at assembly time (agent-service.ts) and
//   plugin policy hooks applied by hooksMiddleware;
// - plugin tools execute through tool-executor.ts (validation, permission,
//   hooks, approval, redaction);
// - future migrations route a built-in through the executor without changing
//   its name — the registry id "builtin:<name>" stays stable as the key.
//
// IMPORTANT: entries here are metadata. `hooks-service.ts` treats only
// NON-builtin capability owners as "plugin-owned", so registering built-ins
// must never remove a tool from plugin policy-hook evaluation (there is a
// test asserting the hook evaluation still fires for a registered builtin).

import { registerCapability, getCapability, type CapabilityRecord } from "../capability-registry.js";
import type { PluginMode } from "../plugin-manifest.js";

type BuiltinToolEntry = {
  name: string;
  description: string;
  modes: PluginMode[];
};

const ALL: PluginMode[] = ["home", "code", "notebook"];

const CATALOG: BuiltinToolEntry[] = [
  // code-tools.ts — code intelligence (LSP/tree-sitter backed)
  { name: "read_file_range", description: "Read a file's lines with line numbers", modes: ALL },
  { name: "grep_search", description: "Ripgrep-style content search inside the project root", modes: ALL },
  { name: "get_symbol_outline", description: "Syntactic outline of a file (tree-sitter)", modes: ALL },
  { name: "find_symbol_definition", description: "LSP go-to-definition lookup", modes: ALL },
  { name: "find_symbol_references", description: "LSP references lookup", modes: ALL },
  { name: "get_diagnostics", description: "Typechecker/diagnostics for a file or project", modes: ALL },
  // edit-tools.ts — atomic multi-file patching (planned/ask-gated at assembly)
  { name: "apply_patch", description: "Atomic multi-file apply_patch-style edits", modes: ["code", "home"] },
  { name: "import_attached_image", description: "Import an attached image file into the workspace", modes: ["code", "home"] },
  { name: "import_attachment", description: "Import an attached document into the workspace", modes: ["code", "home"] },
  { name: "ask_user", description: "Blocking clarifying-question round-trip to the user", modes: ALL },
  { name: "materialize_skill_files", description: "Copy read-only skill helper files into the workspace", modes: ALL },
  // browser-tool.ts — hidden-webview inspection/automation
  { name: "browser_inspect", description: "Inspect and snapshot a page in the managed browser", modes: ALL },
  { name: "browser_act", description: "Act on a page (click/fill/navigate) in the managed browser", modes: ["home", "code"] },
  { name: "browser_fetch_api", description: "Fetch a JSON API in the managed browser partition", modes: ["home", "code"] },
  // websearch-tool.ts
  { name: "web_search", description: "Web search with content extraction", modes: ALL },
  { name: "web_image_search", description: "Image search for Home-mode visual deliverables", modes: ["home"] },
  // subagent-service.ts
  { name: "delegate_task", description: "Delegate an isolated subagent run", modes: ALL },
  // agent/background-jobs.ts
  { name: "run_background", description: "Start a background job (dev server etc.)", modes: ["code"] },
  { name: "job_status", description: "Inspect a background job's status/logs", modes: ["code"] },
  // agent-service.ts project memory helper
  { name: "project_memory", description: "Manage durable project memory facts", modes: ["code"] },
  // notebook-rag.ts grounded retrieval
  { name: "search_notebook_sources", description: "Hybrid vector/BM25 retrieval over notebook sources", modes: ["notebook"] },
  { name: "inspect_notebook_outline", description: "Outline of ingested notebook sources", modes: ["notebook"] },
  { name: "read_notebook_passage", description: "Read cited passage ranges from notebook sources", modes: ["notebook"] },
  { name: "evaluate_evidence", description: "Evaluate groundedness of a draft against sources", modes: ["notebook"] },
];

/**
 * Registers the whole built-in catalog into the "builtin" namespace.
 * Idempotent: already-registered ids come back as registry "duplicate"
 * results and are tolerated. Only ever writes into the "builtin" namespace —
 * never evicts or shadows a real plugin registration. Returns registered ids.
 */
export function ensureBuiltinToolCatalog(): string[] {
  const ids: string[] = [];
  for (const entry of CATALOG) {
    const res = registerCapability({
      owner: "builtin",
      name: entry.name,
      kind: "tool",
      description: entry.description,
      modes: entry.modes,
      permissions: [],
    });
    if (res.ok) ids.push(res.id);
    else if (res.error.code !== "duplicate") {
      // Catalog-table bug (bad mode, invalid name) — log loudly, never throw
      // from startup; the pipeline still works, just without the record.
      console.error(`[builtin-tool-catalog] failed to register builtin:${entry.name}`, res.error);
    }
  }
  return ids;
}

/** Test/diagnostic helper: single record lookup in the "builtin" namespace. */
export function getBuiltinToolRecord(name: string): CapabilityRecord | undefined {
  return getCapability(`builtin:${name}`);
}

/** Test/diagnostic helper: the source-of-truth catalog table entries. */
export function builtinCatalogEntries(): Array<Pick<CapabilityRecord, "id" | "name" | "modes" | "description">> {
  return CATALOG.map((e) => ({ id: `builtin:${e.name}`, name: e.name, modes: e.modes, description: e.description }));
}
