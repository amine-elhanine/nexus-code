// Shared main-process context handed to IPC route modules.
//
// The old main.ts mega-file registered every handler inside one closure over
// module-level state (active project/session/root, settings, run tracking).
// main.ts keeps owning that single source of truth; route modules receive
// this context so reads/writes stay consistent with whatever has been
// activated elsewhere.

import type { BrowserWindow } from "electron";
import type { AgentEvent, AgentSettings } from "../agent-types.js";

export interface MainIpcContext {
  /** Current (possibly not yet created/recreated) main window. */
  window(): BrowserWindow | null;
  /** Active project/session/root state — read-only view. */
  active(): { projectId: string | null; sessionId: string | null; projectRoot: string | null };
  /** Mutate the active project/session/root (any subset). */
  setActive(next: { projectId?: string | null; sessionId?: string | null; projectRoot?: string | null }): void;
  /** Root required for workspace operations; throws when none is active. */
  requireRoot(): string;
  /** Legacy inline agent settings (kept compatible — masked at the API). */
  settings: { get(): AgentSettings; set(next: AgentSettings): void };
  /** Live run/generation ids across Code, Home and Notebook runs. */
  activeRunSessions: Set<string>;
  /** Blocking ask_user bridge — provided by the user-question routes. */
  askUserBlocking(
    sessionId: string,
    questions: Array<{ header: string; question: string; options: string[] }>,
  ): Promise<string | null>;
  /** Transcript event emission (single + per-session channels). */
  emit(event: AgentEvent): void;
  emitFor(sessionId: string, event: Omit<AgentEvent, "sessionId" | "timestamp">): void;
}
