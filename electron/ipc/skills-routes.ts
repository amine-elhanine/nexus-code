// Configuration toggles + Skills IPC routes.
//
// Security note: skills:import sources must originate from a native dialog
// pick in this session — skills:import otherwise accepts any renderer-
// supplied path, which combined with skills:read is an arbitrary-file-copy-
// and-read primitive for a compromised renderer. The set is bounded and
// entries expire.

import { ipcMain, dialog } from "electron";
import path from "node:path";
import {
  getHooksConfig, getRulesConfig, getSkillsConfig, saveHooksConfig, saveRulesConfig, saveSkillsConfig,
} from "../store.js";
import {
  changeSkillScope, createSkill, deleteSkill, ensureSkillSourceDirs, importSkill, listAllSkills, openSkillsFolder,
  readSkillContent, setSkillModes,
} from "../skills-service.js";
import type { MainIpcContext } from "./context.js";

export function registerSkillsRoutes(ctx: MainIpcContext): void {
  ipcMain.handle("hooks:config:get", () => getHooksConfig());
  ipcMain.handle("hooks:config:save", (_event, config: { enabled: boolean }) => saveHooksConfig(config));
  ipcMain.handle("rules:config:get", () => getRulesConfig());
  ipcMain.handle("rules:config:save", (_event, config: { enabled: boolean }) => saveRulesConfig(config));
  ipcMain.handle("skills:config:get", () => getSkillsConfig());
  ipcMain.handle("skills:config:save", (_event, config: { enabled: boolean }) => saveSkillsConfig(config));
  ipcMain.handle("skills:list", async () => {
    const projectRoot = ctx.active().projectRoot;
    await ensureSkillSourceDirs(projectRoot);
    return listAllSkills(projectRoot);
  });
  ipcMain.handle("skills:read", async (_event, skillPath: string) => readSkillContent(skillPath, ctx.active().projectRoot));
  // Import sources must originate from a native dialog pick in this session.
  // The set is bounded and entries expire.
  const dialogPickedSkillSources = new Map<string, number>();
  const rememberPickedSkillSources = (paths: string[]) => {
    const now = Date.now();
    for (const [key, at] of dialogPickedSkillSources) { if (now - at > 30 * 60_000) dialogPickedSkillSources.delete(key); }
    for (const p of paths.slice(0, 100)) dialogPickedSkillSources.set(path.resolve(p), now);
  };
  ipcMain.handle("skills:pick-file", async () => {
    const result = await dialog.showOpenDialog({ properties: ["openFile", "multiSelections"], filters: [{ name: "Skill file", extensions: ["md", "zip"] }] });
    const paths = result.canceled ? [] : result.filePaths;
    rememberPickedSkillSources(paths);
    return paths;
  });
  ipcMain.handle("skills:pick-folder", async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory", "multiSelections"] });
    const paths = result.canceled ? [] : result.filePaths;
    rememberPickedSkillSources(paths);
    return paths;
  });
  ipcMain.handle("skills:import", async (_event, input: { sourcePath: string; scope: "global" | "project" }) => {
    const pickedAt = dialogPickedSkillSources.get(path.resolve(String(input?.sourcePath || "")));
    if (!pickedAt || Date.now() - pickedAt > 30 * 60_000) {
      throw new Error("Import refused: the source path was not picked through the file dialog in this session. Use the Choose File / Choose Folder buttons, then import.");
    }
    const root = input.scope === "project" ? ctx.requireRoot() : (ctx.active().projectRoot || "");
    const res = await importSkill(root, input.sourcePath, input.scope);
    ctx.window()?.webContents.send("skills:changed");
    return res;
  });
  ipcMain.handle("skills:create", async (_event, input: { name: string; description?: string; scope: "global" | "project"; content?: string; modes?: string[] }) => {
    const root = input.scope === "project" ? ctx.requireRoot() : (ctx.active().projectRoot || "");
    const res = await createSkill(root, input);
    ctx.window()?.webContents.send("skills:changed");
    return res;
  });
  ipcMain.handle("skills:delete", async (_event, skillPath: string) => {
    await deleteSkill(skillPath, ctx.active().projectRoot);
    ctx.window()?.webContents.send("skills:changed");
  });
  ipcMain.handle("skills:set-modes", async (_event, input: { skillPath: string; modes: string[] }) => {
    const res = await setSkillModes(input.skillPath, input.modes, ctx.active().projectRoot);
    ctx.window()?.webContents.send("skills:changed");
    return res;
  });
  ipcMain.handle("skills:change-scope", async (_event, input: { skillPath: string; targetScope: "global" | "project" }) => {
    const res = await changeSkillScope(input.skillPath, input.targetScope, ctx.active().projectRoot);
    ctx.window()?.webContents.send("skills:changed");
    return res;
  });
  ipcMain.handle("skills:open-folder", async (_event, scope: "global" | "project") => {
    const root = scope === "project" ? ctx.requireRoot() : (ctx.active().projectRoot || "");
    return openSkillsFolder(scope, root);
  });
}
