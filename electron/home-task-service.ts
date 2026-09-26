import { promises as fs } from "node:fs";
import path from "node:path";

export type HomeTaskPhase = "planning" | "research" | "execution" | "validation" | "complete" | "blocked";
export type HomeTaskStatus = "active" | "completed" | "interrupted" | "blocked" | "failed";

export type HomeTaskAction = {
  at: string;
  tool: string;
  summary: string;
  result?: string;
  progressed: boolean;
};

export type HomeTaskJournal = {
  version: 1;
  sessionId: string;
  goal: string;
  expectsOutput: boolean;
  needsResearch: boolean;
  phase: HomeTaskPhase;
  status: HomeTaskStatus;
  actions: HomeTaskAction[];
  outputs: string[];
  completedAt?: string;
  lastProgressAt: string;
  noProgressCount: number;
};

const JOURNAL_DIR = path.join(".nexus", "home-tasks");
const MAX_ACTIONS = 120;

function safeSessionId(sessionId: string): string {
  return String(sessionId || "unknown").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 160);
}

export function homeTaskJournalPath(root: string, sessionId: string): string {
  return path.join(root, JOURNAL_DIR, `${safeSessionId(sessionId)}.json`);
}

export function createHomeTaskJournal(input: {
  sessionId: string;
  goal: string;
  expectsOutput: boolean;
  needsResearch: boolean;
}): HomeTaskJournal {
  const now = new Date().toISOString();
  return {
    version: 1,
    sessionId: input.sessionId,
    goal: input.goal,
    expectsOutput: input.expectsOutput,
    needsResearch: input.needsResearch,
    phase: input.needsResearch ? "planning" : "execution",
    status: "active",
    actions: [],
    outputs: [],
    lastProgressAt: now,
    noProgressCount: 0,
  };
}

export async function loadHomeTaskJournal(root: string, sessionId: string): Promise<HomeTaskJournal | null> {
  try {
    const raw = await fs.readFile(homeTaskJournalPath(root, sessionId), "utf8");
    const parsed = JSON.parse(raw) as HomeTaskJournal;
    if (parsed?.version !== 1 || parsed.sessionId !== sessionId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function saveHomeTaskJournal(root: string, journal: HomeTaskJournal): Promise<void> {
  const file = homeTaskJournalPath(root, journal.sessionId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(journal, null, 2), "utf8");
}

export function recordHomeTaskAction(
  journal: HomeTaskJournal,
  action: Omit<HomeTaskAction, "at"> & { phase?: HomeTaskPhase; outputs?: string[] },
): HomeTaskJournal {
  const now = new Date().toISOString();
  const nextActions = [
    ...journal.actions,
    { at: now, tool: action.tool, summary: action.summary, result: action.result, progressed: action.progressed },
  ].slice(-MAX_ACTIONS);
  const nextOutputs = [...new Set([...journal.outputs, ...(action.outputs || [])])].slice(-40);
  return {
    ...journal,
    phase: action.phase || journal.phase,
    actions: nextActions,
    outputs: nextOutputs,
    lastProgressAt: action.progressed ? now : journal.lastProgressAt,
    noProgressCount: action.progressed ? 0 : journal.noProgressCount + 1,
  };
}

export function finishHomeTaskJournal(journal: HomeTaskJournal, status: HomeTaskStatus, phase: HomeTaskPhase = "complete"): HomeTaskJournal {
  return {
    ...journal,
    status,
    phase,
    completedAt: new Date().toISOString(),
  };
}
