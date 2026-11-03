import { promises as fs } from "node:fs";
import path from "node:path";
import { uid, composeContextBlock } from "./notebook-text.js";
import { collectDocumentEvidence, extractDocumentJson, fallbackTitle } from "./notebook-documents.js";
import { assertNotebookGenerationActive, planNotebookWithLlm } from "./notebook-generation.js";
import { notebookSessionDir, type NotebookSourceCitation } from "./notebook-store.js";
import { writeFileAtomic } from "./atomic-write.js";

// ── Audio Overview (NotebookLM Parity) ───────────────────────────────────────
// Generates a 2-host conversational podcast ("Deep Dive") script grounded in
// source citations, plus structured timestamps for playback scrubbing.

export type AudioOverviewTurn = {
  speaker: "Alex" | "Sam";
  text: string;
  citations: NotebookSourceCitation[];
};

export type AudioOverviewChapter = {
  title: string;
  turnIndex: number;
};

export type AudioOverview = {
  id: string;
  notebookId: string;
  title: string;
  topic: string;
  durationMinutes: number;
  chapters: AudioOverviewChapter[];
  turns: AudioOverviewTurn[];
  citations: NotebookSourceCitation[];
  createdAt: string;
  updatedAt: string;
};

export type GenerateAudioOverviewInput = {
  topic?: string;
  fileIds?: string[];
  providerId?: string;
  model?: string;
  instructions?: string;
  runId?: string;
  isCancelled?: () => boolean;
  generate?: (system: string, user: string) => Promise<string>;
  onStatus?: (text: string) => void;
};

const AUDIO_DIR = "audio";

function audioDirPath(notebookId: string): string {
  return path.join(notebookSessionDir(notebookId), AUDIO_DIR);
}

function audioOverviewPath(notebookId: string, id: string): string {
  const safeId = path.basename(String(id || "")).replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safeId) throw new Error("Invalid audio overview ID");
  return path.join(audioDirPath(notebookId), `${safeId}.json`);
}

export function sanitizeAudioTurns(
  raw: any,
  citations: NotebookSourceCitation[]
): { turns: AudioOverviewTurn[]; chapters: AudioOverviewChapter[] } {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.turns)) {
    throw new Error("Audio overview JSON missing turns array");
  }
  const turns: AudioOverviewTurn[] = [];
  const chapters: AudioOverviewChapter[] = [];

  for (let i = 0; i < raw.turns.length; i++) {
    const t = raw.turns[i];
    const speaker: "Alex" | "Sam" = t.speaker === "Sam" ? "Sam" : "Alex";
    const text = String(t.text || "").trim();
    if (!text) continue;

    // Parse model [Sn] markers
    const matchedIndices = [...text.matchAll(/\[S(\d+)\]/g)].map((m) => parseInt(m[1], 10));
    const matchedCitations: NotebookSourceCitation[] = [];
    for (const idx of matchedIndices) {
      const found = citations.find((c) => c.index === idx);
      if (found && !matchedCitations.some((c) => c.index === idx)) {
        matchedCitations.push({ ...found, verified: true });
      }
    }

    if (t.chapter && typeof t.chapter === "string") {
      chapters.push({ title: t.chapter.trim(), turnIndex: turns.length });
    }

    turns.push({
      speaker,
      text,
      citations: matchedCitations,
    });
  }

  if (turns.length === 0) {
    throw new Error("No usable turns produced for Audio Overview");
  }

  // Fallback: if LLM placed chapter titles only in top-level raw.chapters array
  if (chapters.length === 0 && Array.isArray(raw.chapters)) {
    const validTitles = raw.chapters
      .filter((c: unknown) => typeof c === "string" && c.trim().length > 0)
      .map((c: string) => c.trim());
    if (validTitles.length > 0) {
      const step = Math.max(1, Math.floor(turns.length / validTitles.length));
      validTitles.forEach((title: string, idx: number) => {
        const turnIndex = Math.min(turns.length - 1, idx * step);
        if (!chapters.some((ch) => ch.turnIndex === turnIndex)) {
          chapters.push({ title, turnIndex });
        }
      });
    }
  }

  return { turns, chapters };
}

export async function generateNotebookAudioOverview(
  notebookId: string,
  input: GenerateAudioOverviewInput = {}
): Promise<AudioOverview> {
  assertNotebookGenerationActive(input);
  input.onStatus?.("Retrieving source documents for podcast script…");

  const topic = (input.topic || "").trim() || "overview of key ideas and insights";
  const scope = input.fileIds?.length ? input.fileIds : undefined;
  const evidence = await collectDocumentEvidence(notebookId, topic, scope);

  if (!evidence.ranked.length || evidence.citations.length === 0) {
    throw new Error("No sources available in this notebook to create an Audio Overview.");
  }

  const contextBlock = composeContextBlock(
    evidence.ranked.map((r) => ({ headingPath: [r.sourceName, ...r.headingPath], text: r.text })),
    35000
  );

  const systemPrompt = [
    "You are an expert podcast producer and scriptwriter creating a lively, engaging NotebookLM-style 'Deep Dive' Audio Overview.",
    "Format:",
    "Two hosts, Alex (inquisitive, energetic, analogies) and Sam (expert, grounded, insightful synthesizer).",
    "They discuss the provided sources naturally with banter, thought-provoking questions, back-and-forth flow, and clear explanations.",
    "CRITICAL GROUNDING RULE: Every claim must be supported by the sources. Include source markers [S1], [S2] etc. inside the text when discussing evidence.",
    "Output MUST be valid JSON only matching this schema:",
    `{
  "title": "Engaging Podcast Episode Title",
  "chapters": ["Intro: The Core Problem", "Key Discovery", "Implications & Summary"],
  "turns": [
    { "speaker": "Alex", "text": "Welcome to the deep dive! Today we're looking at something fascinating...", "chapter": "Intro: The Core Problem" },
    { "speaker": "Sam", "text": "Right, and what stands out immediately from [S1] is how..." }
  ]
}`,
    input.instructions ? `User instructions: ${input.instructions}` : "",
  ].filter(Boolean).join("\n\n");

  const userPrompt = [
    input.topic ? `Episode Focus Topic: ${input.topic}` : "Episode Focus: Comprehensive deep dive across all notebook sources.",
    `Citation markers available: ${evidence.citations.map((c) => `[S${c.index}] ${c.sourceName} — ${c.heading}`).join("; ")}`,
    "Source Passages:",
    contextBlock,
  ].join("\n\n");

  input.onStatus?.("Scripting conversational episode between Alex & Sam…");
  const rawResponse = await planNotebookWithLlm(systemPrompt, userPrompt, input);
  const parsed = extractDocumentJson(rawResponse) as any;
  const { turns, chapters } = sanitizeAudioTurns(parsed, evidence.citations);

  const title = String(parsed?.title || fallbackTitle(turns[0]?.text || "Audio Overview", "report"));
  const audioId = uid("audio");
  const wordCount = turns.reduce((sum, t) => sum + t.text.split(/\s+/).length, 0);
  // Average speaking pace ~140 words per minute
  const durationMinutes = Math.max(1, Math.round((wordCount / 140) * 10) / 10);

  const overview: AudioOverview = {
    id: audioId,
    notebookId,
    title,
    topic: input.topic || "General Overview",
    durationMinutes,
    chapters,
    turns,
    citations: evidence.citations,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const dir = audioDirPath(notebookId);
  await fs.mkdir(dir, { recursive: true });
  await writeFileAtomic(audioOverviewPath(notebookId, audioId), JSON.stringify(overview, null, 2));
  return overview;
}

export async function listNotebookAudioOverviews(notebookId: string): Promise<AudioOverview[]> {
  const dir = audioDirPath(notebookId);
  try {
    const entries = await fs.readdir(dir);
    const overviews: AudioOverview[] = [];
    for (const f of entries) {
      if (f.endsWith(".json")) {
        try {
          const content = await fs.readFile(path.join(dir, f), "utf8");
          overviews.push(JSON.parse(content));
        } catch { /* skip corrupted */ }
      }
    }
    return overviews.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    return [];
  }
}

export async function deleteNotebookAudioOverview(notebookId: string, audioId: string): Promise<AudioOverview[]> {
  try {
    await fs.rm(audioOverviewPath(notebookId, audioId), { force: true });
  } catch { /* ignore */ }
  return listNotebookAudioOverviews(notebookId);
}
