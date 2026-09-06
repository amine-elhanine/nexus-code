import { promises as fs } from "node:fs";
import path from "node:path";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

function safePath(projectRoot: string, requested: string) {
  const root = path.resolve(projectRoot);
  const candidate = path.resolve(root, requested || ".");
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw new Error("Path escapes the selected project root.");
  }
  return candidate;
}

type PatchOp =
  | { kind: "add"; file: string; body: string }
  | { kind: "update"; file: string; body: string }
  | { kind: "delete"; file: string }
  | { kind: "move"; from: string; to: string };

/**
 * Opencode-style apply_patch: one atomic multi-file edit instead of N
 * sequential edit_file calls. Marker format (paths relative to root):
 *   *** Add File: src/new.ts
 *   <body>
 *   *** Update File: src/existing.ts
 *   <body>
 *   *** Move to: src/renamed.ts  (follows an Update/Add block as source)
 *   *** Delete File: src/obsolete.ts
 */
export function parsePatchText(patchText: string): PatchOp[] {
  const ops: PatchOp[] = [];
  const lines = patchText.split(/\r?\n/);
  let current: { header: string; file: string; body: string[] } | null = null;
  const flush = () => {
    if (!current) return;
    const file = current.file.trim();
    if (!file) {
      current = null;
      return;
    }
    if (current.header.startsWith("add")) ops.push({ kind: "add", file, body: current.body.join("\n") });
    else ops.push({ kind: "update", file, body: current.body.join("\n") });
    current = null;
  };
  for (const line of lines) {
    const m = line.match(/^\*\*\*\s*(Add File|Update File|Delete File|Move to)\s*:?\s*(.*)$/i);
    if (m) {
      const kind = m[1].toLowerCase();
      const target = (m[2] || "").trim();
      if (kind.startsWith("delete")) {
        flush();
        if (target) ops.push({ kind: "delete", file: target });
      } else if (kind.startsWith("move")) {
        // Move applies to the pending block: rename its file to target.
        if (current && target) {
          const body = current.body.join("\n");
          ops.push({ kind: "move", from: current.file.trim(), to: target });
          current = null;
        } else if (target) {
          flush();
        }
      } else {
        flush();
        current = { header: kind, file: target, body: [] };
      }
    } else if (current) {
      current.body.push(line);
    }
  }
  flush();
  return ops;
}

export function createEditTools(projectRoot: string) {
  const applyPatchTool = tool(
    async ({ patchText }: { patchText: string }) => {
      try {
        const ops = parsePatchText(patchText || "");
        if (!ops.length) return "No patch operations found. Use markers like '*** Update File: src/a.ts' followed by the new content.";
        const applied: string[] = [];
        for (const op of ops) {
          if (op.kind === "delete") {
            const target = safePath(projectRoot, op.file);
            await fs.rm(target, { force: true });
            applied.push(`deleted ${op.file}`);
          } else if (op.kind === "move") {
            const from = safePath(projectRoot, op.from);
            const to = safePath(projectRoot, op.to);
            await fs.mkdir(path.dirname(to), { recursive: true });
            await fs.rename(from, to);
            applied.push(`moved ${op.from} -> ${op.to}`);
          } else if (op.kind === "add") {
            const target = safePath(projectRoot, op.file);
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.writeFile(target, op.body.replace(/\s+$/, "") + "\n", "utf8");
            applied.push(`added ${op.file}`);
          } else {
            const target = safePath(projectRoot, op.file);
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.writeFile(target, op.body.replace(/\s+$/, "") + "\n", "utf8");
            applied.push(`updated ${op.file}`);
          }
        }
        return `Applied ${applied.length} patch operation(s):\n${applied.map((a) => `- ${a}`).join("\n")}`;
      } catch (error) {
        return `apply_patch failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
    {
      name: "apply_patch",
      description:
        "Apply an atomic multi-file patch in one step (preferred over N sequential edits). Use markers '*** Add File: <path>', '*** Update File: <path>', '*** Delete File: <path>', '*** Move to: <new-path>' with file bodies after Add/Update markers.",
      schema: z.object({
        patchText: z.string().describe("Patch text with *** markers and file bodies, paths relative to repo root"),
      }),
    }
  );
  return [applyPatchTool];
}

/**
 * Opencode-style question tool (v1: non-blocking). Emits the question to the
 * transcript via onAsk so the user sees it; returns a directive so the agent
 * proceeds with its best guess instead of stalling or guessing silently.
 */
export function createQuestionTool(onAsk?: (questions: Array<{ header: string; question: string; options: string[] }>) => void, options: { maxCalls?: number } = {}) {
  const maxCalls = options.maxCalls ?? 1;
  let calls = 0;
  const askTool = tool(
    async ({ questions }: { questions: Array<{ header: string; question: string; options?: string[] }> }) => {
      try {
        calls++;
        if (calls > maxCalls) {
          return "You already asked the user; do not ask again. Proceed with your best guess and finish the task.";
        }
        const normalized = (questions || [])
          .filter((q) => q && q.question)
          .slice(0, 4)
          .map((q) => ({ header: q.header || "Question", question: q.question, options: (q.options || []).slice(0, 6) }));
        if (!normalized.length) return "No questions provided.";
        onAsk?.(normalized);
        return `Recorded ${normalized.length} clarifying question(s) for the user. Proceed with your best guess for now; the user will correct you if needed. Do not block waiting for an answer.`;
      } catch (error) {
        return `ask_user failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
    {
      name: "ask_user",
      description:
        "Ask the user clarifying questions when genuinely ambiguous (use sparingly — at most once per task, max 4 questions). Proceed with best guess afterwards; do not block.",
      schema: z.object({
        questions: z
          .array(
            z.object({
              header: z.string().describe("Short label, e.g. 'Scope'"),
              question: z.string().describe("Full question text"),
              options: z.array(z.string()).optional().describe("Suggested answer options"),
            })
          )
          .describe("Questions for the user"),
      }),
    }
  );
  return askTool;
}
