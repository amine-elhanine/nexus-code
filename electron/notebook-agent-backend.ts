import path from "node:path";
import { WorkspaceBackend, applyEditApprovalGate, applyPostEditDiagnostics } from "./agentcore/backend.js";
import { executeCommand, readCommandPolicyWithTrust } from "./command-service.js";

/**
 * Notebook agent workspace with shell approvals enforced at the backend
 * boundary. Gate coverage now matches getAgentBackend (Phase-1 unification):
 * the edit-approval gate and LSP post-edit diagnostics were previously
 * omitted here entirely, so Settings → editPolicy "ask" was silently ignored
 * for notebook file mutations.
 */
export async function createNotebookAgentBackend(
  root: string,
  id: string,
  runId?: string,
  options: { editPolicy?: "auto" | "ask" } = {}
) {
  const backend = new WorkspaceBackend({ rootDir: path.resolve(root), id });
  const { policy: commandPolicy, trustedAllow } = await readCommandPolicyWithTrust(root);
  backend.execute = (command: string) => executeCommand(root, command, { runId, requireApproval: true, policy: commandPolicy, policyTrusted: trustedAllow });
  // Legacy-state guard is baked into the WorkspaceBackend write/edit paths.
  if (options.editPolicy === "ask") {
    applyEditApprovalGate(backend, path.resolve(root), runId);
  }
  applyPostEditDiagnostics(backend, path.resolve(root));
  return backend;
}
