// Persisted generation job table for Notebook studio outputs (documents,
// quizzes, flashcards, mindmaps, summaries, audio overviews).
//
// Ingestion has a real queue/status machine with startup recovery; generation
// runs were fire-and-forget IPC: an app restart mid-quiz/mid-document
// silently lost the work AND left no trace. This table gives every
// generation run a durable record — begun/finished/failed — and startup
// recovery marks runs interrupted by a restart, so nothing vanishes
// silently and a UI can surface job history.
//
// The table is an audit/recovery surface; live cancellation and concurrency
// gating stay with command-service's run state (unchanged).

import path from "node:path";
import { promises as fs } from "node:fs";
import { writeFileAtomic, withFileLock } from "./atomic-write.js";
import { notebooksDataRoot } from "./notebook-store.js";

export type GenerationJobKind = "document" | "quiz" | "flashcards" | "mindmap" | "summary" | "audio";
export type GenerationJobStatus = "running" | "done" | "failed";

export type GenerationJobRecord = {
  id: string;
  notebookId: string;
  kind: GenerationJobKind;
  status: GenerationJobStatus;
  topic?: string;
  startedAt: string;
  endedAt?: string;
  error?: string;
};

type JobTable = { jobs: GenerationJobRecord[] };

// Bounded: drop the oldest FINISHED records past this cap (running records
// are never dropped — they are recovered, not forgotten).
const JOB_TABLE_CAP = 300;

function jobsFile(): string {
  return path.join(notebooksDataRoot(), "generation-jobs.json");
}

async function readTable(): Promise<JobTable> {
  try {
    const raw = await fs.readFile(jobsFile(), "utf8");
    const parsed = JSON.parse(raw) as JobTable;
    return { jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [] };
  } catch {
    return { jobs: [] };
  }
}

async function writeTable(table: JobTable): Promise<void> {
  await writeFileAtomic(jobsFile(), JSON.stringify(table, null, 2));
}

let seq = 0;

/** Record a generation run start. Returns the job id to pass to finish. */
export async function beginGenerationJob(notebookId: string, kind: GenerationJobKind, topic?: string): Promise<string> {
  const id = `gen_${Date.now().toString(36)}_${(seq++).toString(36)}`;
  const record: GenerationJobRecord = {
    id,
    notebookId,
    kind,
    status: "running",
    topic: topic?.slice(0, 200),
    startedAt: new Date().toISOString(),
  };
  await withFileLock(jobsFile(), async () => {
    const table = await readTable();
    table.jobs.unshift(record);
    // Cap: keep running records, drop oldest finished beyond the cap.
    const running = table.jobs.filter((j) => j.status === "running");
    const finished = table.jobs.filter((j) => j.status !== "running").slice(0, Math.max(0, JOB_TABLE_CAP - running.length));
    table.jobs = [...running, ...finished];
    await writeTable(table);
  });
  return id;
}

/** Record a generation run end. error == null means success. */
export async function finishGenerationJob(jobId: string, error?: string): Promise<void> {
  await withFileLock(jobsFile(), async () => {
    const table = await readTable();
    const hit = table.jobs.find((j) => j.id === jobId);
    if (!hit) return;
    hit.status = error ? "failed" : "done";
    hit.endedAt = new Date().toISOString();
    if (error) hit.error = error.slice(0, 500);
    await writeTable(table);
  });
}

/** Startup recovery: a "running" record can only mean the app died or
 *  restarted mid-job — mark it failed (interrupted) so the history is honest
 *  and nothing looks perpetually in-flight. */
export async function recoverInterruptedGenerationJobs(): Promise<number> {
  let recovered = 0;
  await withFileLock(jobsFile(), async () => {
    const table = await readTable();
    const now = new Date().toISOString();
    for (const job of table.jobs) {
      if (job.status !== "running") continue;
      job.status = "failed";
      job.endedAt = now;
      job.error = "Interrupted: the app restarted while this job was running.";
      recovered++;
    }
    if (recovered > 0) await writeTable(table);
  });
  return recovered;
}

/** Job history, newest first. Optional filter by notebook. */
export async function listGenerationJobs(notebookId?: string): Promise<GenerationJobRecord[]> {
  const table = await readTable();
  return notebookId ? table.jobs.filter((j) => j.notebookId === notebookId) : table.jobs;
}
