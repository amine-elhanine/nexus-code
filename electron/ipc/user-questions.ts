// Approval + blocking-question IPC routes.
//
// - "command:approval": renderer answers an interactive approval prompt.
// - "question:resolve": renderer answers an agent ask_user request.
// - Returns the main-side askUserBlocking helper used by agent run routes to
//   send "question:request" and await resolution with a 120s deny-by-default.

import { ipcMain } from "electron";
import { resolveCommandApproval } from "../approval-service.js";
import type { MainIpcContext } from "./context.js";

export function registerUserQuestionRoutes(ctx: MainIpcContext): MainIpcContext["askUserBlocking"] {
  ipcMain.handle("command:approval", (_event, payload: { id: string; decision: "once" | "session" | "deny" }) => resolveCommandApproval(payload.id, payload.decision));

  // Blocking clarifying questions (ask_user): the agent waits for the user.
  // Renderer shows a modal via "question:request" and resolves via
  // "question:resolve". Timeout / cancel falls back to best-guess (null).
  const pendingUserQuestions = new Map<string, (answer: string | null) => void>();
  ipcMain.handle("question:resolve", (_event, payload: { id: string; answers?: Record<string, string> | null; cancelled?: boolean }) => {
    const resolve = pendingUserQuestions.get(payload.id);
    if (!resolve) return false;
    pendingUserQuestions.delete(payload.id);
    if (payload.cancelled || !payload.answers) resolve(null);
    else {
      const text = Object.entries(payload.answers)
        .map(([header, value]) => `${header}: ${value}`)
        .join("\n")
        .slice(0, 2000);
      resolve(text || null);
    }
    return true;
  });
  const askUserBlocking: MainIpcContext["askUserBlocking"] = (sessionId, questions) => {
    const id = `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    ctx.window()?.webContents.send("question:request", { id, sessionId, questions });
    return new Promise<string | null>((resolve) => {
      pendingUserQuestions.set(id, resolve);
      setTimeout(() => {
        if (pendingUserQuestions.has(id)) {
          pendingUserQuestions.delete(id);
          resolve(null);
        }
      }, 120000);
    });
  };
  return askUserBlocking;
}
