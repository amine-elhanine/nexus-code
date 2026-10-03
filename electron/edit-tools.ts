import { promises as fs } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

async function safePath(projectRoot: string, requested: string) {
  const root = await fs.realpath(path.resolve(projectRoot));
  const candidate = path.resolve(root, requested || ".");
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw new Error("Path escapes the selected project root.");
  }
  // Resolve the existing target, or the nearest existing parent for a new
  // file. This prevents a lexical-safe path from traversing an in-repo
  // symlink that points outside the selected project.
  let probe = candidate;
  while (probe !== root) {
    try {
      const realProbe = await fs.realpath(probe);
      if (realProbe !== root && !realProbe.startsWith(`${root}${path.sep}`)) {
        throw new Error("Path follows a symlink outside the selected project root.");
      }
      break;
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
      probe = path.dirname(probe);
    }
  }
  return candidate;
}

type PatchOp =
  | { kind: "add"; file: string; body: string }
  | { kind: "update"; file: string; body: string; expectedHash?: string }
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
    const hashMatch = current.file.match(/^(.*?)\s*\(sha256:\s*([a-f0-9]{64})\)\s*$/i);
    const file = (hashMatch?.[1] || current.file).trim();
    if (!file) {
      current = null;
      return;
    }
    if (current.header.startsWith("add")) ops.push({ kind: "add", file, body: current.body.join("\n") });
    else ops.push({ kind: "update", file, body: current.body.join("\n"), ...(hashMatch ? { expectedHash: hashMatch[2].toLowerCase() } : {}) });
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

const ATTACH_IMPORT_EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "text/x-tex": "tex",
  "text/markdown": "md",
  "text/plain": "txt",
  "text/csv": "csv",
  "application/json": "json",
  "text/yaml": "yaml",
};

function parseAttachedFile(source: string): { mime: string; data: Buffer; suggestedName: string } | null {
  // importableAttachments entries are `data:<mime>;base64,<payload>[#<name>]`.
  const hashIdx = source.lastIndexOf("#");
  const suggestedName = hashIdx > 0 ? decodeURIComponent(source.slice(hashIdx + 1)) : "attachment";
  const dataUrl = hashIdx > 0 ? source.slice(0, hashIdx) : source;
  const match = dataUrl.match(/^data:([^;,]+)?(?:;charset=[^;,]+)?;base64,([\s\S]+)$/);
  if (!match) return null;
  const mime = (match[1] || "application/octet-stream").toLowerCase();
  const data = Buffer.from(match[2].replace(/\s/g, ""), "base64");
  return { mime, data, suggestedName };
}

export function applySearchReplaceBlocks(original: string, updateBody: string): string | null {
  const blockRegex = /<<<<<<< SEARCH\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n>>>>>>>/g;
  const matches = [...updateBody.matchAll(blockRegex)];
  if (matches.length === 0) return null;

  let result = original.replace(/\r\n/g, "\n");
  for (const match of matches) {
    const search = match[1].replace(/\r\n/g, "\n");
    const replace = match[2].replace(/\r\n/g, "\n");

    // 1. Exact match
    if (result.includes(search)) {
      result = result.replace(search, replace);
      continue;
    }

    // 2. Trailing whitespace & line-ending normalized match
    const resultLines = result.split("\n");
    const searchLines = search.split("\n");
    const cleanSearchLines = searchLines.map((l) => l.trimEnd());

    let matchIdx = -1;
    for (let i = 0; i <= resultLines.length - searchLines.length; i++) {
      let matched = true;
      for (let j = 0; j < searchLines.length; j++) {
        if (resultLines[i + j].trimEnd() !== cleanSearchLines[j]) {
          matched = false;
          break;
        }
      }
      if (matched) {
        matchIdx = i;
        break;
      }
    }

    if (matchIdx !== -1) {
      resultLines.splice(matchIdx, searchLines.length, replace);
      result = resultLines.join("\n");
      continue;
    }

    // 3. Trimmed line matching (indentation-tolerant)
    const trimmedSearchLines = searchLines.map((l) => l.trim());
    for (let i = 0; i <= resultLines.length - searchLines.length; i++) {
      let matched = true;
      for (let j = 0; j < searchLines.length; j++) {
        if (resultLines[i + j].trim() !== trimmedSearchLines[j]) {
          matched = false;
          break;
        }
      }
      if (matched) {
        matchIdx = i;
        break;
      }
    }

    if (matchIdx !== -1) {
      resultLines.splice(matchIdx, searchLines.length, replace);
      result = resultLines.join("\n");
      continue;
    }

    throw new Error(`Search block not found in target file:\n${search.slice(0, 200)}`);
  }

  return result.replace(/\s+$/, "") + "\n";
}

export function applyUnifiedDiffHunks(original: string, updateBody: string): string | null {
  if (!/^@@ -\d+/m.test(updateBody)) return null;

  const hunkRegex = /@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@[^\n]*\n([\s\S]*?)(?=(?:\n@@ -|\n\*\*\*|$))/g;
  const hunks = [...updateBody.matchAll(hunkRegex)];
  if (hunks.length === 0) return null;

  const lines = original.replace(/\r\n/g, "\n").split("\n");

  for (const hunk of hunks) {
    const origStart = Math.max(0, parseInt(hunk[1], 10) - 1);
    const hunkBody = hunk[5];
    const hunkLines = hunkBody.split("\n");

    const expectedOldLines: string[] = [];
    const newLines: string[] = [];

    for (const hl of hunkLines) {
      if (hl.startsWith("+")) {
        newLines.push(hl.slice(1));
      } else if (hl.startsWith("-")) {
        expectedOldLines.push(hl.slice(1));
      } else if (hl.startsWith(" ")) {
        expectedOldLines.push(hl.slice(1));
        newLines.push(hl.slice(1));
      } else if (hl === "") {
        expectedOldLines.push("");
        newLines.push("");
      }
    }

    if (expectedOldLines.length === 0 && newLines.length === 0) continue;

    let matchIdx = -1;
    const searchRange = 50;
    const minStart = Math.max(0, origStart - searchRange);
    const maxStart = Math.min(lines.length - expectedOldLines.length, origStart + searchRange);

    const tryMatchAt = (start: number) => {
      for (let j = 0; j < expectedOldLines.length; j++) {
        if (lines[start + j].trimEnd() !== expectedOldLines[j].trimEnd()) {
          return false;
        }
      }
      return true;
    };

    for (let i = origStart; i <= maxStart; i++) {
      if (tryMatchAt(i)) { matchIdx = i; break; }
    }
    if (matchIdx === -1) {
      for (let i = origStart - 1; i >= minStart; i--) {
        if (tryMatchAt(i)) { matchIdx = i; break; }
      }
    }
    if (matchIdx === -1) {
      for (let i = 0; i <= lines.length - expectedOldLines.length; i++) {
        if (tryMatchAt(i)) { matchIdx = i; break; }
      }
    }

    if (matchIdx === -1) {
      throw new Error(`Unified diff hunk could not be located around line ${origStart + 1}`);
    }

    lines.splice(matchIdx, expectedOldLines.length, ...newLines);
  }

  return lines.join("\n").replace(/\s+$/, "") + "\n";
}

export function applyUpdatedFileContent(original: string, updateBody: string): string {
  const fromSearchReplace = applySearchReplaceBlocks(original, updateBody);
  if (fromSearchReplace !== null) return fromSearchReplace;

  const fromUnifiedDiff = applyUnifiedDiffHunks(original, updateBody);
  if (fromUnifiedDiff !== null) return fromUnifiedDiff;

  return updateBody.replace(/\s+$/, "") + "\n";
}

// Writes from delegated workers share one workspace. Serialize patch
// transactions per project so snapshots, validation, and rollback cannot
// interleave with another writer.
const projectWriteTails = new Map<string, Promise<void>>();
async function acquireProjectWriteLock(projectRoot: string): Promise<() => void> {
  const key = path.resolve(projectRoot);
  const previous = projectWriteTails.get(key) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  projectWriteTails.set(key, current);
  await previous;
  return () => {
    release();
    if (projectWriteTails.get(key) === current) projectWriteTails.delete(key);
  };
}

export function createEditTools(projectRoot: string, options: { attachedImages?: string[]; attachedFiles?: string[]; beforeEdit?: (info: { tool: string; files: string[] }) => Promise<string | null> } = {}) {
  const applyPatchTool = tool(
    async ({ patchText }: { patchText: string }) => {
      // Approval gate BEFORE the write lock and any filesystem side effect, so
      // a pending approval never blocks parallel tool calls.
      const previewOps = parsePatchText(patchText || "");
      if (previewOps.length && options.beforeEdit) {
        const denial = await options.beforeEdit({ tool: "apply_patch", files: previewOps.map((op) => (op.kind === "move" ? `${op.from} -> ${op.to}` : op.file)) });
        if (denial) return denial;
      }
      const releaseWrite = await acquireProjectWriteLock(projectRoot);
      type Snapshot = { path: string; existed: boolean; content?: Buffer; mode?: number };
      const snapshots = new Map<string, Snapshot>();
      const snapshot = async (target: string) => {
        if (snapshots.has(target)) return;
        try {
          const stat = await fs.stat(target);
          if (!stat.isFile()) throw new Error(`Target is not a regular file: ${target}`);
          snapshots.set(target, { path: target, existed: true, content: await fs.readFile(target), mode: stat.mode });
        } catch (error: any) {
          if (error?.code === "ENOENT") snapshots.set(target, { path: target, existed: false });
          else throw error;
        }
      };
      const restore = async (entry: Snapshot) => {
        if (entry.existed) {
          await fs.mkdir(path.dirname(entry.path), { recursive: true });
          await fs.writeFile(entry.path, entry.content!);
          if (entry.mode != null) await fs.chmod(entry.path, entry.mode);
        } else {
          await fs.rm(entry.path, { force: true });
        }
      };
      try {
        const ops = parsePatchText(patchText || "");
        if (!ops.length) return "No patch operations found. Use markers like '*** Update File: src/a.ts' followed by the new content.";
        // Validate every path and take all backups before changing anything.
        // This makes a multi-file patch recoverable if a later operation fails.
        const resolvedOps = await Promise.all(ops.map(async (op) => {
          if (op.kind === "move") return { ...op, fromPath: await safePath(projectRoot, op.from), toPath: await safePath(projectRoot, op.to) };
          return { ...op, targetPath: await safePath(projectRoot, op.file) };
        }));
        for (const op of resolvedOps) {
          if (op.kind === "move") {
            await snapshot(op.fromPath);
            await snapshot(op.toPath);
            if (!snapshots.get(op.fromPath)!.existed) throw new Error(`Cannot move missing file: ${op.from}`);
            if (snapshots.get(op.toPath)!.existed) throw new Error(`Move target already exists: ${op.to}`);
          } else {
            await snapshot(op.targetPath);
            if (op.kind === "add" && snapshots.get(op.targetPath)!.existed) throw new Error(`Cannot add over existing file: ${op.file}`);
            if (op.kind === "update" && !snapshots.get(op.targetPath)!.existed) throw new Error(`Cannot update missing file: ${op.file}`);
            if (op.kind === "update" && op.expectedHash) {
              const actualHash = crypto.createHash("sha256").update(snapshots.get(op.targetPath)!.content!).digest("hex");
              if (actualHash !== op.expectedHash) throw new Error(`Stale update rejected for ${op.file}: expected sha256 ${op.expectedHash}, found ${actualHash}`);
            }
          }
        }
        const applied: string[] = [];
        for (const op of resolvedOps) {
          if (op.kind === "delete") {
            await fs.rm(op.targetPath, { force: true });
            applied.push(`deleted ${op.file}`);
          } else if (op.kind === "move") {
            await fs.mkdir(path.dirname(op.toPath), { recursive: true });
            await fs.rename(op.fromPath, op.toPath);
            applied.push(`moved ${op.from} -> ${op.to}`);
          } else if (op.kind === "add") {
            await fs.mkdir(path.dirname(op.targetPath), { recursive: true });
            await fs.writeFile(op.targetPath, op.body.replace(/\s+$/, "") + "\n", "utf8");
            applied.push(`added ${op.file}`);
          } else {
            await fs.mkdir(path.dirname(op.targetPath), { recursive: true });
            const currentContent = snapshots.get(op.targetPath)?.content?.toString("utf8") ?? "";
            const finalContent = applyUpdatedFileContent(currentContent, op.body);
            await fs.writeFile(op.targetPath, finalContent, "utf8");
            applied.push(`updated ${op.file}`);
          }
        }
        return `Applied ${applied.length} patch operation(s):\n${applied.map((a) => `- ${a}`).join("\n")}`;
      } catch (error) {
        // Restore in reverse order so moves and dependent edits unwind safely.
        for (const entry of [...snapshots.values()].reverse()) {
          try { await restore(entry); } catch { /* preserve the original error */ }
        }
        return `apply_patch failed: ${error instanceof Error ? error.message : String(error)}`;
      } finally {
        releaseWrite();
      }
    },
    {
      name: "apply_patch",
      description:
        "Apply an atomic multi-file patch in one step (preferred over N sequential edits). Use markers '*** Add File: <path>', '*** Update File: <path> (sha256: <hash>)', '*** Delete File: <path>', '*** Move to: <new-path>'. Under '*** Update File', you may provide the full new file body OR surgical hunks using '<<<<<<< SEARCH ... ======= ... >>>>>>>' or unified diff hunks '@@ -line,count +line,count @@'. The optional hash rejects stale updates.",
      schema: z.object({
        patchText: z.string().describe("Patch text with *** markers, search/replace blocks or file bodies, paths relative to repo root"),
      }),
    }
  );
  const tools: any[] = [applyPatchTool];
  if (options.attachedImages?.length) {
    const importAttachmentTool = tool(
      async ({ index, targetPath }: { index: number; targetPath: string }) => {
        const source = options.attachedImages?.[index];
        if (!source) return `Attachment import failed: no attached image at index ${index}.`;
        const match = source.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,([\s\S]+)$/);
        if (!match) return "Attachment import failed: the selected attachment is not an available image file.";
        const destination = await safePath(projectRoot, targetPath);
        try { await fs.access(destination); return `Attachment import refused: ${targetPath} already exists.`; } catch { /* new file */ }
        const data = Buffer.from(match[2], "base64");
        if (!data.length || data.length > 20 * 1024 * 1024) return "Attachment import failed: image is empty or larger than 20 MB.";
        const ext = match[1].toLowerCase().replace("jpeg", "jpg");
        if (!/^[a-z0-9]+$/.test(ext)) return "Attachment import failed: unsupported image type.";
        const finalPath = destination.includes(".") ? destination : `${destination}.${ext}`;
        await fs.mkdir(path.dirname(finalPath), { recursive: true });
        await fs.writeFile(finalPath, data, { flag: "wx" });
        return `Imported attached image ${index} to ${path.relative(path.resolve(projectRoot), finalPath).replace(/\\/g, "/")}.`;
      },
      {
        name: "import_attached_image",
        description: "Import one user-attached image into the project only when the requested deliverable needs the actual asset. Attachments are numbered from 0; choose a project-relative target path such as public/assets/hero.png. Do not import reference-only images.",
        schema: z.object({
          index: z.number().int().min(0).describe("Zero-based attached image index"),
          targetPath: z.string().min(1).max(240).describe("Project-relative destination path"),
        }),
      }
    );
    tools.push(importAttachmentTool);
  }
  if (options.attachedFiles?.length) {
    const importAnyTool = tool(
      async ({ index, targetPath }: { index: number; targetPath: string }) => {
        const source = options.attachedFiles?.[index];
        if (!source) return `Attachment import failed: no attachment at index ${index}.`;
        const parsed = parseAttachedFile(source);
        if (!parsed) return "Attachment import failed: the selected attachment is not available.";
        if (!parsed.data.length || parsed.data.length > 20 * 1024 * 1024) return "Attachment import failed: file is empty or larger than 20 MB.";
        const destination = await safePath(projectRoot, targetPath);
        try { await fs.access(destination); return `Attachment import refused: ${targetPath} already exists.`; } catch { /* new file */ }
        let finalPath = destination;
        if (!path.basename(destination).includes(".")) {
          const fromName = (parsed.suggestedName.split(".").pop() || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
          const fromMime = ATTACH_IMPORT_EXT_BY_MIME[parsed.mime];
          const ext = /^[a-z0-9]{1,10}$/.test(fromName) ? fromName : fromMime || "bin";
          finalPath = `${destination}.${ext}`;
        }
        await fs.mkdir(path.dirname(finalPath), { recursive: true });
        await fs.writeFile(finalPath, parsed.data, { flag: "wx" });
        return `Imported attachment ${index} (${parsed.suggestedName}) to ${path.relative(path.resolve(projectRoot), finalPath).replace(/\\/g, "/")}.`;
      },
      {
        name: "import_attachment",
        description: "Import one user-attached file (image, PDF, Word, Excel, PowerPoint, TeX, text, …) into the project only when the requested deliverable needs the actual file. Attachments are numbered from 0; choose a project-relative target path such as docs/source.pdf or public/assets/hero.png. Do not import reference-only files.",
        schema: z.object({
          index: z.number().int().min(0).describe("Zero-based attachment index"),
          targetPath: z.string().min(1).max(240).describe("Project-relative destination path"),
        }),
      }
    );
    // Avoid double-registering when attachedFiles aliases attachedImages.
    if (!options.attachedImages?.length || options.attachedFiles !== options.attachedImages) {
      tools.push(importAnyTool);
    }
  }
  return tools;
}

/**
 * Opencode-style question tool (v2: blocking with timeout). The agent pauses
 * until the user answers in the UI; on timeout / no UI it falls back to
 * best-guess so runs never stall forever.
 */
export function createQuestionTool(onAsk?: (questions: Array<{ header: string; question: string; options: string[] }>) => Promise<string | null | void> | void, options: { maxCalls?: number; timeoutMs?: number } = {}) {
  const maxCalls = options.maxCalls ?? 1;
  const timeoutMs = options.timeoutMs ?? 120000;
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
        let answer: string | null | void = null;
        try {
          const pending = onAsk?.(normalized);
          answer = pending instanceof Promise
            ? await Promise.race([
                pending,
                new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
              ])
            : pending;
        } catch {
          answer = null;
        }
        if (typeof answer === "string" && answer.trim()) {
          return `User answered:\n${answer.trim().slice(0, 2000)}\nProceed with these answers.`;
        }
        return `Recorded ${normalized.length} clarifying question(s) for the user. Proceed with your best guess for now; the user will correct you if needed. Do not block waiting for an answer.`;
      } catch (error) {
        return `ask_user failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
    {
      name: "ask_user",
      description:
        "Ask the user clarifying questions when genuinely ambiguous (use sparingly — at most once per task, max 4 questions). Waits for the user's answer; if none arrives, proceed with best guess.",
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
