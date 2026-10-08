import path from "node:path";
import { FilesystemBackend } from "deepagents";
import { executeCommand, readCommandPolicy } from "./command-service.js";

/** Notebook agent workspace with shell approvals enforced at the backend boundary. */
export async function createNotebookAgentBackend(root: string, id: string, runId?: string) {
  const backend: any = new FilesystemBackend({ rootDir: path.resolve(root), virtualMode: true });
  backend.id = id;
  const commandPolicy = await readCommandPolicy(root);
  backend.execute = (command: string) => executeCommand(root, command, { runId, requireApproval: true, policy: commandPolicy });
  return backend;
}
