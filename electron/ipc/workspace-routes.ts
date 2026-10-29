// Workspace IPC routes — file listing/reading/writing, diff/revert, Undo
// checkpoints, git worktrees, artifacts, trajectories, and attachments.
// Every path-based handler funnels through ctx.requireRoot() so containment
// always applies to the ACTIVE project root.

import { ipcMain, dialog, app } from "electron";
import crypto from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";
import { getWorkspaceDiffFiles, getWorkspaceGitStatus, restoreWorkspaceCheckpoint, revertAllWorkspaceChanges, revertWorkspaceFile, revertWorkspaceHunk } from "../diff-service.js";
import { getWorkspaceGit, listWorkspaceFiles, readWorkspaceFile, readWorkspaceFileBase64, safePath, writeWorkspaceFile } from "../project-tools.js";
import { ensureGitRepo } from "../repo-service.js";
import { createSessionWorktree, getSessionWorktree, mergeWorktreeToMain, discardSessionWorktree, getSessionWorktreeDiff, isGitRepo } from "../worktree-service.js";
import { listArtifacts, getArtifact, updateArtifactStatus, type ArtifactStatus } from "../artifacts-service.js";
import { readSessionTrajectory } from "../trajectory-service.js";
import { boundedExecFile } from "../shell-subprocess.js";
import { runProjectCommand } from "../command-service.js";
import { ATTACHMENT_EXT_BY_MIME, resolveAttachmentBytes } from "../attachment-utils.js";
import { clearCheckpoint, popCheckpoint } from "../checkpoint-stack.js";
import { getSession } from "../store.js";
import type { MainIpcContext } from "./context.js";

const execFileAsync = boundedExecFile;

export function registerWorkspaceRoutes(ctx: MainIpcContext): void {
  ipcMain.handle("workspace:list", () => listWorkspaceFiles(ctx.requireRoot()));
  ipcMain.handle("workspace:read", (_event, file: string) => readWorkspaceFile(ctx.requireRoot(), file));
  // Base64 read for the file previewer (pptx/docx/xlsx/pdf/images) — the code
  // editor path above refuses binary content, this one serves it.
  ipcMain.handle("workspace:readBase64", (_event, file: string) => readWorkspaceFileBase64(ctx.requireRoot(), file));
  ipcMain.handle("workspace:gitStatus", () => getWorkspaceGitStatus(ctx.requireRoot()));
  ipcMain.handle("workspace:downloadFile", async (_event, file: string) => {
    const root = ctx.requireRoot();
    const source = safePath(root, file);
    const { canceled, filePath } = await dialog.showSaveDialog({
      defaultPath: path.basename(source),
      title: "Download file",
    });
    if (canceled || !filePath) return null;
    await fs.copyFile(source, filePath);
    return filePath;
  });
  ipcMain.handle("workspace:readHead", async (_event, file: string) => {
    const root = ctx.requireRoot();
    const activeSessionId = ctx.active().sessionId;
    const wt = activeSessionId ? await getSessionWorktree(root, activeSessionId) : null;
    const targetRoot = wt?.worktreePath || root;
    const normalized = file.replace(/\\/g, "/").replace(/^\.\//, "");
    try {
      const { stdout } = await execFileAsync("git", ["show", `HEAD:${normalized}`], { cwd: targetRoot, maxBuffer: 4_000_000 });
      // `git show HEAD:binary` dumps raw bytes into a UTF-8 string — the diff
      // view only wants text, so blank out anything with NUL bytes.
      if (stdout.includes("\u0000")) return "";
      return stdout;
    } catch {
      return "";
    }
  });
  ipcMain.handle("attachments:save", async (_event, payload: { data: string; filename?: string }) => {
    const attachmentsDir = path.join(app.getPath("userData"), "attachments");
    await fs.mkdir(attachmentsDir, { recursive: true });

    // Accept any data URL (images, PDFs, Office docs, TeX, …), not just
    // images. Extension prefers the original filename so .docx stays .docx
    // (mime sniffing alone can't distinguish Office containers); the data-URL
    // mime is the fallback. The hash covers raw bytes so identical uploads
    // dedupe to one file.
    let base64Data = payload.data;
    let mimeType = "application/octet-stream";
    const match = payload.data.match(/^data:([^;,]+)?(?:;[^;,=]+=[^;,]+)*;base64,([\s\S]+)$/);
    if (match) {
      mimeType = (match[1] || "application/octet-stream").toLowerCase();
      base64Data = match[2].replace(/\s/g, "");
    }
    const originalExt = (payload.filename?.split(".").pop() || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
    const mimeExt = ATTACHMENT_EXT_BY_MIME[mimeType];
    // Trust a sane filename extension first (docx/xlsx/pptx/tex/…); fall back
    // to the mime-derived one; never trust exotic suffixes on disk.
    const ext = /^[a-z0-9]{1,10}$/.test(originalExt) && originalExt !== "bin"
      ? originalExt === "jpeg" ? "jpg" : originalExt
      : mimeExt || "bin";
    const buffer = Buffer.from(base64Data, "base64");
    if (!buffer.length) throw new Error("Attachment is empty.");
    if (buffer.length > 25 * 1024 * 1024) throw new Error("Attachment is larger than 25 MB.");
    const hash = crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 16);
    const safeBase = (payload.filename || "attachment").split(/[\\/]/).pop()!.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 60) || "attachment";
    const fileName = `${hash}-${safeBase.includes(".") ? safeBase : `${safeBase}.${ext}`}`;
    const normalizedName = fileName.toLowerCase().endsWith(`.${ext}`) ? fileName : `${fileName}.${ext}`;
    const filePath = path.join(attachmentsDir, normalizedName);
    await fs.writeFile(filePath, buffer);
    return { fileName: normalizedName, filePath, url: `nexus-attachment://${normalizedName}`, mimeType };
  });
  // Raw bytes for previewing an attachment in-app (same IPC pattern as
  // home:readFile for generated artifacts — never depends on custom-scheme
  // fetch from the renderer, which images don't need but documents do).
  ipcMain.handle("attachments:read", async (_event, attachmentUrl: string) => {
    const { buffer, fileName, mimeType } = await resolveAttachmentBytes(String(attachmentUrl || ""));
    return { base64: buffer.toString("base64"), fileName, mimeType, size: buffer.length };
  });
  ipcMain.handle("workspace:write", (_event, file: string, content: string) => writeWorkspaceFile(ctx.requireRoot(), file, content));
  ipcMain.handle("workspace:diff", async () => {
    const root = ctx.requireRoot();
    const activeSessionId = ctx.active().sessionId;
    const wt = activeSessionId ? await getSessionWorktree(root, activeSessionId) : null;
    return getWorkspaceDiffFiles(wt?.worktreePath || root);
  });
  ipcMain.handle("workspace:git", () => getWorkspaceGit(ctx.requireRoot()));
  ipcMain.handle("workspace:command", async (_event, command: string) => {
    const { getProject } = await import("../store.js");
    const activeProjectId = ctx.active().projectId;
    const project = activeProjectId ? await getProject(activeProjectId) : null;
    if (!project) throw new Error("Active project not found.");
    const result = await runProjectCommand(project, command);
    return result.output || "Command completed successfully.";
  });

  ipcMain.handle("workspace:revert-file", async (_event, file: string) => {
    const root = ctx.requireRoot();
    const activeSessionId = ctx.active().sessionId;
    const wt = activeSessionId ? await getSessionWorktree(root, activeSessionId) : null;
    return revertWorkspaceFile(wt?.worktreePath || root, file);
  });
  ipcMain.handle("workspace:revert-hunk", async (_event, file: string, hunkHeader: string) => {
    const root = ctx.requireRoot();
    const activeSessionId = ctx.active().sessionId;
    const wt = activeSessionId ? await getSessionWorktree(root, activeSessionId) : null;
    return revertWorkspaceHunk(wt?.worktreePath || root, file, hunkHeader);
  });
  ipcMain.handle("workspace:revert-all", async () => {
    const root = ctx.requireRoot();
    const activeSessionId = ctx.active().sessionId;
    const wt = activeSessionId ? await getSessionWorktree(root, activeSessionId) : null;
    return revertAllWorkspaceChanges(wt?.worktreePath || root);
  });
  ipcMain.handle("checkpoint:restore", async (_event, checkpointId: string) => {
    const root = ctx.requireRoot();
    const active = ctx.active();
    const wt = active.sessionId ? await getSessionWorktree(root, active.sessionId) : null;
    const ok = await restoreWorkspaceCheckpoint(wt?.worktreePath || root, checkpointId);
    // Multi-level Undo: popping here keeps checkpointId/checkpointIds in sync
    // so each click steps one run further back without renderer bookkeeping.
    try {
      if (active.projectId && active.sessionId) await popCheckpoint(active.projectId, active.sessionId, wt?.worktreePath || root, checkpointId);
    } catch { /* restore already succeeded */ }
    return ok;
  });
  ipcMain.handle("checkpoint:clear", async () => {
    const root = ctx.requireRoot();
    const active = ctx.active();
    if (!active.projectId || !active.sessionId) return false;
    const wt = active.sessionId ? await getSessionWorktree(root, active.sessionId) : null;
    const session = await getSession(active.projectId, active.sessionId);
    await clearCheckpoint(active.projectId, active.sessionId, wt?.worktreePath || root, session?.checkpointId);
    return true;
  });
  ipcMain.handle("project:ensure-repo", async () => {
    return ensureGitRepo(ctx.requireRoot());
  });

  // Worktree IPC handlers
  ipcMain.handle("worktree:create", async (_event, sessionId: string) => {
    const root = ctx.requireRoot();
    return createSessionWorktree(root, sessionId);
  });
  ipcMain.handle("worktree:status", async (_event, sessionId: string) => {
    const root = ctx.requireRoot();
    const wt = await getSessionWorktree(root, sessionId);
    const isGit = await isGitRepo(root);
    return { isGit, worktree: wt };
  });
  ipcMain.handle("worktree:merge", async (_event, sessionId: string, commitMessage?: string) => {
    const root = ctx.requireRoot();
    return mergeWorktreeToMain(root, sessionId, commitMessage);
  });
  ipcMain.handle("worktree:abort-merge", async (_event, sessionId?: string) => {
    const root = ctx.requireRoot();
    const { abortWorktreeMerge, getSessionWorktree } = await import("../worktree-service.js");
    // Only abort when the calling session actually owns a worktree here — a
    // bare abort would also kill a merge the user started manually in a terminal.
    if (sessionId) {
      const wt = await getSessionWorktree(root, sessionId);
      if (!wt?.worktreePath) return false;
    }
    return abortWorktreeMerge(root);
  });
  ipcMain.handle("worktree:discard", async (_event, sessionId: string) => {
    const root = ctx.requireRoot();
    return discardSessionWorktree(root, sessionId);
  });
  ipcMain.handle("worktree:diff", async (_event, sessionId: string) => {
    const root = ctx.requireRoot();
    return getSessionWorktreeDiff(root, sessionId);
  });

  // Artifacts IPC handlers
  ipcMain.handle("artifacts:list", async (_event, sessionId: string) => {
    const root = ctx.requireRoot();
    return listArtifacts(root, sessionId);
  });
  ipcMain.handle("artifacts:get", async (_event, sessionId: string, filename: string) => {
    const root = ctx.requireRoot();
    return getArtifact(root, sessionId, filename);
  });
  ipcMain.handle("artifacts:update-status", async (_event, sessionId: string, filename: string, status: ArtifactStatus) => {
    const root = ctx.requireRoot();
    return updateArtifactStatus(root, sessionId, filename, status);
  });

  // Trajectory IPC handler
  ipcMain.handle("trajectory:get", async (_event, sessionId: string) => {
    const root = ctx.requireRoot();
    return readSessionTrajectory(root, sessionId);
  });
}
