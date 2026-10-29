// Plan-item parsing and the persisted tool-history context block.
// Extracted verbatim from agent-service.ts; no behavior change.

import type { HistoryInput, PlanItem } from "../agent-types.js";

export function planItemsFromArgs(args: any): PlanItem[] | null {
  if (!args || typeof args !== "object") return null;
  const rawList = Array.isArray(args.items) ? args.items : Array.isArray(args.todos) ? args.todos : Array.isArray(args.plan) ? args.plan : null;
  if (!rawList) return null;
  const items = rawList
    .map((item: any) => {
      if (typeof item === "string") return { content: item, status: "pending" as const };
      const content = String(item?.content || item?.task || item?.title || "").trim();
      const rawStatus = String(item?.status || "pending").toLowerCase();
      const status: PlanItem["status"] = rawStatus === "completed" || rawStatus === "done" ? "completed" : rawStatus === "in_progress" || rawStatus === "active" ? "in_progress" : "pending";
      return { content, status };
    })
    .filter((item: PlanItem) => item.content);
  return items.length ? items : null;
}

// Builds the "what prior runs already did" context block from persisted
// session events (OpenCode/Pi-style: tool history rides along in-session).
// Call + result pairs are merged, plans expanded, noise (status/usage/
// artifact/token) skipped. Newest-first under the token budget so recent work
// always survives; returns null when there is nothing worth carrying.
export function buildToolContextBlock(items: HistoryInput[] | undefined | null, maxTokens = 4000): string | null {
  if (!items || items.length === 0) return null;
  const maxChars = Math.max(500, maxTokens * 4);
  const PER_ITEM_CAP = 1200;
  const lines: string[] = [];
  // First pass: merge call/result pairs chronologically.
  const push = (head: string, tail = "") => {
    lines.push(tail ? `${head.slice(0, 200)}\n  ↳ ${tail.slice(0, PER_ITEM_CAP)}` : head.slice(0, 200));
  };
  let pendingName: string | null = null;
  for (const item of items) {
    if (item.role !== "event") {
      pendingName = null;
      continue;
    }
    const kind = item.kind || "status";
    if (kind === "status" || kind === "usage" || kind === "token" || kind === "artifact") continue;
    if (kind === "plan" && item.plan?.length) {
      pendingName = null;
      push(`plan: ${item.plan.map((p) => `[${p.status === "completed" ? "x" : " "}] ${p.content}`).join("; ")}`);
      continue;
    }
    if (kind === "error") {
      pendingName = null;
      push(`error: ${item.text}`);
      continue;
    }
    if (kind === "subagent" && item.subagent) {
      pendingName = null;
      push(`subagent [${item.subagent.role}] ${item.subagent.status}: ${item.subagent.task}`.slice(0, 300));
      continue;
    }
    if (kind !== "tool") {
      pendingName = null;
      continue;
    }
    const text = item.text || "";
    if (text.endsWith("✓")) {
      const name = text.slice(0, -1).trim();
      if (pendingName && pendingName.split(" · ")[0] === name && item.detail && lines.length) {
        const idx = lines.length - 1;
        lines[idx] = `${lines[idx].slice(0, 200)}\n  ↳ ${item.detail.slice(0, PER_ITEM_CAP)}`;
      } else if (item.detail) {
        push(name, item.detail);
      }
      pendingName = null;
      continue;
    }
    pendingName = text;
    push(text, item.detail || "");
  }
  if (!lines.length) return null;
  // Second pass: newest-first under budget.
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (used + lines[i].length > maxChars && kept.length > 0) break;
    kept.unshift(lines[i]);
    used += lines[i].length;
    if (used >= maxChars) break;
  }
  if (!kept.length) return null;
  return (
    `[Session tool history — work already done in this session, newest last. ` +
    `Do NOT re-run these tool calls or re-read these files unless they changed since; build on the results below.]\n` +
    kept.map((l) => `• ${l}`).join("\n")
  );
}
