import path from "node:path";
import { WorkspaceBackend } from "./agentcore/backend.js";
import { executeCommand, readCommandPolicyWithTrust } from "./command-service.js";

/** Notebook agent workspace with shell approvals enforced at the backend boundary. */
export async function createNotebookAgentBackend(root: string, id: string, runId?: string) {
  const backend = new WorkspaceBackend({ rootDir: path.resolve(root), id });
  const { policy: commandPolicy, trustedAllow } = await readCommandPolicyWithTrust(root);
  backend.execute = (command: string) => executeCommand(root, command, { runId, requireApproval: true, policy: commandPolicy, policyTrusted: trustedAllow });
  // Legacy-state guard is baked into the WorkspaceBackend write/edit paths.
  return backend;
}
