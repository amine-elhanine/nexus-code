// Background command execution for agent runs (G4 parity: OpenCode's
// `background: true` shells / ZCode's background commands).
//
// A long build, install or dev-server command must not hold the whole agent
// turn hostage while the model has nothing to do but wait. These tools start
// a command through the SAME executeCommand pipeline (policy gates, approval
// prompts, env scrub, run-scoped abort) without awaiting it, and expose a
// status tool so the model can collect results after doing other work.
//
// V1 honesty note: unlike OpenCode we do NOT auto-resume the run on job
// completion (that needs graph-level injection); the tool descriptions tell
// the model to check ONCE after doing other work instead of sleep-polling.

import { z } from "zod";
import { tool } from "@langchain/core/tools";
import { executeCommand, readCommandPolicyWithTrust } from "../command-service.js";

const MAX_OUTPUT_TAIL_CHARS = 2_000;
const MAX_ACTIVE_JOBS = 3;

type BackgroundJob = {
  id: string;
  command: string;
  startedAt: number;
  settled: boolean;
  exitCode: number | null;
  failed: boolean;
  outputTail: string;
};

export function createBackgroundTools(options: {
  projectRoot: string;
  runId?: string;
  fullAccess?: boolean;
  /** Tests/headless: disable the approval prompt inside the job. */
  requireApproval?: boolean;
}) {
  const jobs = new Map<string, BackgroundJob>();
  let counter = 0;

  const tailOf = (text: string): string => {
    const cleaned = String(text || "");
    return cleaned.length > MAX_OUTPUT_TAIL_CHARS ? `…${cleaned.slice(-MAX_OUTPUT_TAIL_CHARS)}` : cleaned;
  };

  const describe = (job: BackgroundJob): string => {
    const seconds = Math.round((Date.now() - job.startedAt) / 100) / 10;
    const status = job.settled ? (job.failed ? `FAILED (exit ${job.exitCode})` : `completed (exit ${job.exitCode})`) : "still running";
    return `job ${job.id} · ${status} · ${seconds}s elapsed\ncommand: ${job.command}\noutput (tail):\n${job.outputTail || "(no output yet)"}`;
  };

  const runBackground = tool(
    async ({ command }: { command: string }) => {
      const activeCount = [...jobs.values()].filter((job) => !job.settled).length;
      if (activeCount >= MAX_ACTIVE_JOBS) {
        return `[run_background refused: ${MAX_ACTIVE_JOBS} jobs are already running. Collect results with job_status before starting more.]`;
      }
      counter += 1;
      const id = `bg_${counter}`;
      const job: BackgroundJob = { id, command, startedAt: Date.now(), settled: false, exitCode: null, failed: false, outputTail: "" };
      jobs.set(id, job);
      // The same pipeline as the foreground `execute` tool: policy allow/deny
      // list, approval prompts (which may wait on the user inside the job),
      // env scrub and run-scoped abort all apply unchanged.
      const promise = executeCommand(options.projectRoot, command, {
        runId: options.runId,
        requireApproval: options.requireApproval ?? true,
        fullAccess: options.fullAccess,
        onOutput: (chunk) => {
          job.outputTail = tailOf(job.outputTail + chunk);
        },
      });
      void promise
        .then((result) => {
          job.settled = true;
          // executeCommand RESOLVES non-zero exits (stdout/stderr carried) —
          // only a non-zero exitCode marks the job failed.
          job.exitCode = (result as any)?.exitCode ?? 0;
          job.failed = job.exitCode !== 0;
          job.outputTail = tailOf(String((result as any)?.output ?? "") || job.outputTail);
        })
        .catch((error) => {
          job.settled = true;
          job.failed = true;
          job.exitCode = (error as any)?.exitCode ?? 1;
          job.outputTail = tailOf(`${job.outputTail}\n${error?.message || String(error)}`);
        });
      return [
        `Background job ${id} started (approval and policy gates apply — a prompt may appear while it waits).`,
        `Do NOT sleep or poll in a loop: continue other work and call job_status ONCE after you expect this to have finished.`,
        `Current output tail:`,
        job.outputTail || "(no output yet)",
      ].join("\n");
    },
    {
      name: "run_background",
      description:
        "Start a long-running shell command (build, install, dev server, test suite) in the background and continue working immediately. " +
        "Returns a job id right away. The command runs under the exact same permission pipeline as execute (policy + approval). " +
        "Do not sleep-poll: do other useful work, then check job_status once. Foreground execute is still right for quick commands.",
      schema: z.object({
        command: z.string().min(1).max(8_000).describe("The shell command to run in the background."),
      }),
    }
  );

  const jobStatus = tool(
    async ({ jobId }: { jobId?: string }) => {
      if (jobId) {
        const job = jobs.get(jobId);
        if (!job) return `[job_status: unknown job "${jobId}". Known jobs: ${[...jobs.keys()].join(", ") || "none"}]`;
        return describe(job);
      }
      if (jobs.size === 0) return "[job_status: no background jobs have been started this run.]";
      return [...jobs.values()].map(describe).join("\n\n");
    },
    {
      name: "job_status",
      description:
        "Check background jobs started with run_background: status, elapsed time and the last 2000 characters of output. " +
        "Call WITHOUT an id for a one-line summary of every job, or with a specific job id for its full tail. " +
        "Check once after you expect completion — not in a polling loop.",
      schema: z.object({
        jobId: z.string().max(40).optional().describe("Specific job id (e.g. bg_1). Omit to summarize all jobs."),
      }),
    }
  );

  return [runBackground, jobStatus];
}
