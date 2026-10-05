import crypto from "node:crypto";

export type CommandApprovalRequest = {
  id: string;
  runId?: string;
  command: string;
  cwd: string;
  reason: string;
  approvalKey?: string;
  createdAt: string;
};

export type ApprovalDecision = "once" | "session" | "deny";
type Pending = CommandApprovalRequest & { resolve: (decision: ApprovalDecision) => void; timer: NodeJS.Timeout };
let notify: ((request: CommandApprovalRequest) => void) | null = null;
const pending = new Map<string, Pending>();
const sessionApprovals = new Map<string, Set<string>>();
const APPROVAL_TIMEOUT_MS = 120_000;

export function setApprovalNotifier(listener: ((request: CommandApprovalRequest) => void) | null) {
  notify = listener;
}

export function requestCommandApproval(input: Omit<CommandApprovalRequest, "id" | "createdAt">): Promise<ApprovalDecision> {
  if (input.runId && input.approvalKey && sessionApprovals.get(input.runId)?.has(input.approvalKey)) return Promise.resolve("session");
  if (!notify) {
    // Headless/CI: no UI is attached. Deny by default (safe); NEXUS_APPROVAL=allow
    // explicitly opts unattended runs into auto-approving risky commands.
    if (process.env.NEXUS_APPROVAL === "allow") return Promise.resolve("session");
    return Promise.resolve("deny");
  }
  const request: CommandApprovalRequest = { ...input, id: `approval_${crypto.randomUUID()}`, createdAt: new Date().toISOString() };
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(request.id);
      resolve("deny");
    }, APPROVAL_TIMEOUT_MS);
    pending.set(request.id, { ...request, resolve, timer });
    notify?.(request);
  });
}

export function resolveCommandApproval(id: string, decision: ApprovalDecision | boolean): boolean {
  const request = pending.get(id);
  if (!request) return false;
  clearTimeout(request.timer);
  pending.delete(id);
  const resolved: ApprovalDecision = typeof decision === "boolean" ? (decision ? "once" : "deny") : decision;
  if (resolved === "session" && request.runId && request.approvalKey) {
    const set = sessionApprovals.get(request.runId) || new Set<string>();
    set.add(request.approvalKey);
    sessionApprovals.set(request.runId, set);
  }
  request.resolve(resolved);
  return true;
}

export function cancelCommandApprovals(runId?: string) {
  for (const [id, request] of pending) {
    if (runId && request.runId !== runId) continue;
    clearTimeout(request.timer);
    pending.delete(id);
    request.resolve("deny");
  }
  if (runId) sessionApprovals.delete(runId);
  else sessionApprovals.clear();
}

export function pendingApprovalCount() { return pending.size; }
