// Home mode session/file/memory IPC routes (the Home area's own store).

import { ipcMain } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getHomeMemory, getHomeSession, listHomeSessions, createHomeSession, deleteHomeSession, updateHomeMemory, updateHomeSession } from "../store.js";
import { removeSessionFromManifest, downloadHomeFile, ensureHomeDir, listHomeFiles, listHomeSessionFiles, listHomeSessionFilesForDeletion, openHomeFolder, readHomeFile } from "../home-service.js";
import { homeTaskJournalPath } from "../home-task-service.js";
import { codeTaskJournalPath } from "../code-task-service.js";
import { deleteSessionTelemetry } from "../artifacts-service.js";
import { parseHomeMemory, removeMemoryFact } from "../home-memory-service.js";
import type { MainIpcContext } from "./context.js";

export function registerHomeRoutes(_ctx: MainIpcContext): void {
  ipcMain.handle("home:get", async () => {
    const homeRoot = await ensureHomeDir();
    return { project: { id: "home", name: "Home", root: homeRoot }, root: homeRoot };
  });
  ipcMain.handle("home:sessions:list", () => listHomeSessions());
  ipcMain.handle("home:sessions:create", (_event, title?: string) => createHomeSession(title));
  ipcMain.handle("home:sessions:activate", async (_event, sessionId: string) => getHomeSession(sessionId));
  ipcMain.handle("home:sessions:update", (_event, sessionId: string, patch: Parameters<typeof updateHomeSession>[1]) => updateHomeSession(sessionId, patch));
  ipcMain.handle("home:sessions:delete", async (_event, sessionId: string, options?: { deleteFiles?: boolean }) => {
    const root = await ensureHomeDir();
    if (options?.deleteFiles && root) {
      try {
        // Delete only high-confidence owned files: manifest entries and
        // transcript mentions. Proximity/oldest-session guesses are
        // display-only — deleting on them could remove the user's own files.
        const sessions = await listHomeSessions();
        const owned = await listHomeSessionFilesForDeletion(sessionId, sessions);
        for (const file of owned) {
          const abs = path.resolve(root, file.path);
          if (abs === root || !abs.startsWith(`${root}${path.sep}`)) continue;
          try {
            await fs.rm(abs, { force: true });
          } catch { /* best effort */ }
        }
        await removeSessionFromManifest(sessionId);
      } catch { /* best effort */ }
    }
    // Derived data cleanup: run checkpoints, trajectories, artifacts and task
    // journals used to grow forever for Home sessions (only Code wired this).
    try {
      await deleteSessionTelemetry(root, sessionId);
      await fs.rm(homeTaskJournalPath(root, sessionId), { force: true });
      await fs.rm(codeTaskJournalPath(root, sessionId), { force: true });
    } catch { /* best effort */ }
    await deleteHomeSession(sessionId);
    return { success: true };
  });
  ipcMain.handle("home:files", () => listHomeFiles());
  ipcMain.handle("home:sessionFiles", async (_event, sessionId: string) => {
    const sessions = await listHomeSessions();
    return listHomeSessionFiles(sessionId, sessions);
  });
  // High-confidence ownership only (manifest + transcript mentions) — this is
  // the list the "delete chat + files" dialog counts and deletes.
  ipcMain.handle("home:sessionFiles:forDeletion", async (_event, sessionId: string) => {
    const sessions = await listHomeSessions();
    return listHomeSessionFilesForDeletion(sessionId, sessions);
  });
  ipcMain.handle("home:readFile", (_event, relativePath: string) => readHomeFile(relativePath));
  ipcMain.handle("home:download", (_event, relativePath: string) => downloadHomeFile(relativePath));
  ipcMain.handle("home:openFolder", () => openHomeFolder());
  ipcMain.handle("home:memory:get", () => getHomeMemory());
  ipcMain.handle("home:memory:update", (_event, memory: string) => updateHomeMemory(memory));
  ipcMain.handle("home:memory:structured", async () => {
    const memory = await getHomeMemory();
    return { structure: parseHomeMemory(memory) };
  });
  ipcMain.handle("home:memory:fact:remove", async (_event, payload: { category: string; fact: string }) => {
    const current = await getHomeMemory();
    await updateHomeMemory(removeMemoryFact(current, payload.fact || ""));
    return parseHomeMemory(await getHomeMemory());
  });
}
