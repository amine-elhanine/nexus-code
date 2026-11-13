import { promises as fs } from "node:fs";
import path from "node:path";

export type TrajectoryStep = {
  step_index: number;
  timestamp: string;
  source: "USER" | "MODEL" | "TOOL" | "SYSTEM";
  type: "USER_INPUT" | "PLANNER_RESPONSE" | "TOOL_CALL" | "TOOL_RESULT" | "STATUS" | "ERROR";
  content: string;
  thinking?: string;
  tool_calls?: Array<{ name: string; args: any }>;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number; estimatedCost: number | null };
};

// Trajectory JSONL is append-only per session and includes full tool-call
// args, so a long-lived session grew without bound. Cap: rotate once at 10
// MB (transcript.jsonl → transcript.1.jsonl), bounding a session at ~20 MB —
// recent history stays in the primary file the viewer reads.
const MAX_TRAJECTORY_BYTES = 10 * 1024 * 1024;

export class TrajectoryLogger {
  private logPath: string;
  private prevPath: string;
  private stepCount = 0;
  // Ordered, non-blocking writes: chained so the hot tool-event loop never
  // awaits disk I/O, while lines still land in step order.
  private tail: Promise<void> = Promise.resolve();

  constructor(projectRoot: string, sessionId: string) {
    const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const dir = path.join(projectRoot, ".nexus", "trajectories", safeSessionId);
    this.logPath = path.join(dir, "transcript.jsonl");
    this.prevPath = path.join(dir, "transcript.1.jsonl");
  }

  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.logPath), { recursive: true });
  }

  // Serialized behind this.tail, so no rename/write race is possible.
  private async rotateIfNeeded(): Promise<void> {
    try {
      const stat = await fs.stat(this.logPath);
      if (stat.size < MAX_TRAJECTORY_BYTES) return;
      await fs.rm(this.prevPath, { force: true });
      await fs.rename(this.logPath, this.prevPath);
    } catch { /* missing file — append continues either way */ }
  }

  log(step: Omit<TrajectoryStep, "step_index" | "timestamp">): Promise<void> {
    this.stepCount++;
    const entry: TrajectoryStep = {
      step_index: this.stepCount,
      timestamp: new Date().toISOString(),
      ...step,
    };
    const logPath = this.logPath;
    this.tail = this.tail
      .then(async () => {
        await this.rotateIfNeeded();
        await fs.appendFile(logPath, JSON.stringify(entry) + "\n", "utf8");
      })
      .catch(() => {
        // Non-blocking log failure
      });
    return this.tail;
  }
}

export async function readSessionTrajectory(projectRoot: string, sessionId: string): Promise<TrajectoryStep[]> {
  const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const primaryPath = path.join(projectRoot, ".nexus", "trajectories", safeSessionId, "transcript.jsonl");

  for (const logPath of [primaryPath]) {
    try {
      const content = await fs.readFile(logPath, "utf8");
      return content
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      // try next
    }
  }
  return [];
}
