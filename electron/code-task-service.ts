import { promises as fs } from "node:fs";
import path from "node:path";

export type CodeTaskPhase = "planning" | "implementation" | "verification" | "review" | "completed" | "blocked";
export type CodeTaskStatus = "active" | "completed" | "interrupted" | "blocked" | "failed";

export type CodeTaskContract = {
  expectsChanges: boolean;
  needsVerification: boolean;
};

/** Require edits only for clear change requests, not reviews or explanations. */
export function inferCodeTaskContract(request: string): CodeTaskContract {
  const text = (request || "").trim();
  const asksForChanges = /\b(add|build|change|create|develop|fix|implement|migrate|modify|refactor|remove|replace|scaffold|set\s+up|update|write)\b/i.test(text);
  const isReadOnlyIntent = /^\s*(explain|describe|how|why|what|where|review|audit|inspect|analy[sz]e|find|locate|list|show|check|test|run)\b/i.test(text);
  const expectsChanges = asksForChanges && !isReadOnlyIntent;
  return { expectsChanges, needsVerification: expectsChanges || /\b(test|verify|check|build|compile|lint)\b/i.test(text) };
}

export type CodeTaskAction = {
  at: string;
  tool: string;
  summary: string;
  result?: string;
  progressed: boolean;
};

export type CodeTaskJournal = {
  version: 1;
  sessionId: string;
  goal: string;
  mode: "plan" | "ask" | "auto";
  phase: CodeTaskPhase;
  status: CodeTaskStatus;
  plan: Array<{ content: string; status: "pending" | "in_progress" | "completed" }>;
  actions: CodeTaskAction[];
  changedFiles: string[];
  verification: Array<{ command: string; passed: boolean; output?: string }>;
  completedAt?: string;
  lastProgressAt: string;
  noProgressCount: number;
};

const JOURNAL_DIR = path.join(".nexus", "code-tasks");
const MAX_ACTIONS = 180;
const MAX_VERIFICATION = 40;

function safeSessionId(sessionId: string): string {
  return String(sessionId || "unknown").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 160);
}

export function codeTaskJournalPath(root: string, sessionId: string): string {
  return path.join(root, JOURNAL_DIR, `${safeSessionId(sessionId)}.json`);
}

export function createCodeTaskJournal(input: {
  sessionId: string;
  goal: string;
  mode: "plan" | "ask" | "auto";
  resume?: CodeTaskJournal | null;
}): CodeTaskJournal {
  if (input.resume) {
    return { ...input.resume, status: "active", completedAt: undefined };
  }
  return {
    version: 1,
    sessionId: input.sessionId,
    goal: input.goal,
    mode: input.mode,
    phase: input.mode === "plan" ? "planning" : "planning",
    status: "active",
    plan: [],
    actions: [],
    changedFiles: [],
    verification: [],
    lastProgressAt: new Date().toISOString(),
    noProgressCount: 0,
  };
}

export async function loadCodeTaskJournal(root: string, sessionId: string): Promise<CodeTaskJournal | null> {
  try {
    const raw = await fs.readFile(codeTaskJournalPath(root, sessionId), "utf8");
    const parsed = JSON.parse(raw) as CodeTaskJournal;
    if (parsed?.version !== 1 || parsed.sessionId !== sessionId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function saveCodeTaskJournal(root: string, journal: CodeTaskJournal): Promise<void> {
  const file = codeTaskJournalPath(root, journal.sessionId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(journal, null, 2), "utf8");
}

export function recordCodeTaskAction(
  journal: CodeTaskJournal,
  action: Omit<CodeTaskAction, "at"> & {
    phase?: CodeTaskPhase;
    changedFiles?: string[];
    verification?: { command: string; passed: boolean; output?: string };
  },
): CodeTaskJournal {
  const now = new Date().toISOString();
  const nextActions = [...journal.actions, { at: now, tool: action.tool, summary: action.summary, result: action.result, progressed: action.progressed }].slice(-MAX_ACTIONS);
  const nextFiles = [...new Set([...journal.changedFiles, ...(action.changedFiles || [])])].slice(-100);
  const nextVerification = action.verification
    ? [...journal.verification, action.verification].slice(-MAX_VERIFICATION)
    : journal.verification;
  return {
    ...journal,
    phase: action.phase || journal.phase,
    actions: nextActions,
    changedFiles: nextFiles,
    verification: nextVerification,
    lastProgressAt: action.progressed ? now : journal.lastProgressAt,
    noProgressCount: action.progressed ? 0 : journal.noProgressCount + 1,
  };
}

export function recordCodeTaskPlan(
  journal: CodeTaskJournal,
  plan: Array<{ content: string; status: "pending" | "in_progress" | "completed" }>,
): CodeTaskJournal {
  return { ...journal, plan: plan.slice(0, 40) };
}

export function finishCodeTaskJournal(journal: CodeTaskJournal, status: CodeTaskStatus): CodeTaskJournal {
  return {
    ...journal,
    status,
    phase: status === "completed" ? "completed" : status === "blocked" ? "blocked" : journal.phase,
    completedAt: new Date().toISOString(),
  };
}
