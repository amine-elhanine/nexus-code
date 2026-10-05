// Session export: renders a persisted session transcript into a single
// self-contained HTML file (no hosted share-links infra; the file lives on
// the user's disk). The renderer is a pure function so it is unit-testable.
import type { SessionRecord } from "./store.js";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAndFormat(text: string): string {
  return escapeHtml(text)
    .replace(/\r\n/g, "\n")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>");
}

const EVENT_LABELS: Record<string, string> = {
  status: "status",
  tool: "tool",
  plan: "plan",
  error: "error",
  usage: "usage",
  subagent: "subagent",
  artifact: "artifact",
};

function renderPlan(items: Array<{ content: string; status: string }>): string {
  if (!items?.length) return "";
  const rows = items
    .map((item) => {
      const mark = item.status === "completed" ? "✓" : item.status === "in_progress" ? "•" : "○";
      return `<li class="plan-item plan-${escapeHtml(item.status)}">${mark} ${escapeAndFormat(item.content)}</li>`;
    })
    .join("");
  return `<ul class="session-plan">${rows}</ul>`;
}

function renderMessage(message: SessionRecord["messages"][number]): string {
  const time = new Date(message.createdAt).toLocaleString();
  if (message.role === "event") {
    const kind = EVENT_LABELS[message.kind || "status"] || message.kind || "event";
    return `<div class="msg msg-event kind-${escapeHtml(kind)}"><span class="event-kind">${escapeHtml(kind)}</span><span class="event-text">${escapeAndFormat(message.text || "")}</span><time>${escapeHtml(time)}</time></div>`;
  }
  const role = message.role === "user" ? "user" : "assistant";
  const plan = message.plan ? renderPlan(message.plan) : "";
  const detail = message.detail ? `<details class="msg-detail"><summary>tool output</summary><pre>${escapeHtml(message.detail)}</pre></details>` : "";
  return `<div class="msg msg-${role}"><div class="msg-head"><span class="role">${role}</span><time>${escapeHtml(time)}</time></div><div class="msg-body">${escapeAndFormat(message.text || "")}${plan}${detail}</div></div>`;
}

/** Pure: builds the full standalone HTML document for a session. */
export function renderSessionHtml(session: SessionRecord, projectLabel: string): string {
  const messages = (session.messages || []).map(renderMessage).join("\n");
  const created = new Date(session.createdAt).toLocaleString();
  const usageLine = session.usage ? ` · ${session.usage.totalTokens.toLocaleString()} tokens` : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nexus session — ${escapeHtml(session.title || session.id)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 14px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; background: #0b0e14; color: #dbe2ef; }
  .wrap { max-width: 900px; margin: 0 auto; padding: 24px 16px 80px; }
  header { border-bottom: 1px solid #232a38; padding-bottom: 14px; margin-bottom: 18px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .meta { color: #8a94a8; font-size: 12px; }
  .msg { border: 1px solid #232a38; border-radius: 10px; padding: 10px 14px; margin: 10px 0; }
  .msg-user { border-color: #2c3d5e; background: rgba(64, 108, 190, 0.08); }
  .msg-assistant { border-color: #233526; background: rgba(52, 211, 153, 0.05); }
  .msg-event { border-style: dashed; color: #8a94a8; font-size: 12px; display: flex; gap: 8px; align-items: baseline; }
  .msg-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 4px; }
  .role { font-weight: 600; text-transform: uppercase; font-size: 11px; letter-spacing: 0.06em; color: #9db4d8; }
  .msg-assistant .role { color: #7cc8a8; }
  time { color: #6b7486; font-size: 11px; }
  .event-kind { text-transform: uppercase; font-size: 10px; letter-spacing: 0.06em; color: #6b7486; flex: none; }
  .event-text { flex: 1; overflow-wrap: anywhere; }
  .kind-error .event-text, .kind-error .event-kind { color: #e08484; }
  code { background: #161c28; border-radius: 4px; padding: 1px 5px; font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
  .session-plan { margin: 8px 0 2px; padding-left: 18px; }
  .plan-item { list-style: none; }
  .plan-completed { color: #7cc8a8; }
  .plan-in_progress { color: #e3c46b; }
  .msg-detail { margin-top: 8px; }
  .msg-detail summary { cursor: pointer; color: #6b7486; font-size: 11px; }
  .msg-detail pre { background: #10151f; border: 1px solid #1c2330; border-radius: 8px; padding: 8px 10px; overflow: auto; font-size: 11px; max-height: 320px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>${escapeHtml(session.title || "Nexus session")}</h1>
    <div class="meta">${escapeHtml(projectLabel)} · started ${escapeHtml(created)} · ${session.messages?.length ?? 0} messages${escapeHtml(usageLine)}</div>
  </header>
  ${messages || '<p class="meta">No messages recorded.</p>'}
</div>
</body>
</html>`;
}

/** Renders + writes the export file, returning its absolute path. */
export async function exportSessionHtml(session: SessionRecord, projectLabel: string, outputDir: string): Promise<string> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const path = await import("node:path");
  await mkdir(outputDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeTitle = (session.title || session.id).replace(/[^\w.-]+/g, "_").slice(0, 60);
  const file = path.join(outputDir, `nexus-session-${safeTitle}-${stamp}.html`);
  await writeFile(file, renderSessionHtml(session, projectLabel), "utf8");
  return file;
}
