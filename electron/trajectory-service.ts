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
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number; estimatedCost: number };
};

export class TrajectoryLogger {
  private logPath: string;
  private stepCount = 0;

  constructor(projectRoot: string, sessionId: string) {
    const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const dir = path.join(projectRoot, ".nexus", "trajectories", safeSessionId);
    this.logPath = path.join(dir, "transcript.jsonl");
  }

  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.logPath), { recursive: true });
  }

  async log(step: Omit<TrajectoryStep, "step_index" | "timestamp">): Promise<void> {
    this.stepCount++;
    const entry: TrajectoryStep = {
      step_index: this.stepCount,
      timestamp: new Date().toISOString(),
      ...step,
    };

    try {
      await fs.appendFile(this.logPath, JSON.stringify(entry) + "\n", "utf8");
    } catch {
      // Non-blocking log failure
    }
  }
}

export async function readSessionTrajectory(projectRoot: string, sessionId: string): Promise<TrajectoryStep[]> {
  const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const primaryPath = path.join(projectRoot, ".nexus", "trajectories", safeSessionId, "transcript.jsonl");
  const fallbackPath = path.join(projectRoot, ".forgepilot", "trajectories", safeSessionId, "transcript.jsonl");

  for (const logPath of [primaryPath, fallbackPath]) {
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
