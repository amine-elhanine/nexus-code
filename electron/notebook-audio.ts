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
  /** Synthesized neural episode (present when a TTS-capable provider was configured). */
  audioFilename?: string;
  audioMimeType?: string;
  /** Cumulative start offset per turn in ms — drives transcript highlighting. */
  turnTimestampsMs?: number[];
  audioModel?: string;
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

  // Best-effort neural synthesis: a TTS-capable provider turns the script
  // into a downloadable MP3 episode; without one, the browser
  // speechSynthesis fallback plays the same script.
  let finalOverview = overview;
  try {
    finalOverview = await synthesizeAudioEpisode(notebookId, overview, input);
    if (finalOverview !== overview) {
      await writeFileAtomic(audioOverviewPath(notebookId, audioId), JSON.stringify(finalOverview, null, 2));
    }
  } catch { /* the script itself is still valid without audio */ }
  return finalOverview;
}

// ── Neural TTS episode synthesis (OpenAI-compatible /audio/speech) ──────────

const TTS_MODEL = "gpt-4o-mini-tts";
const TTS_VOICES: Record<AudioOverviewTurn["speaker"], string> = { Alex: "alloy", Sam: "nova" };
const TTS_CONCURRENCY = 3;
const TTS_TIMEOUT_MS = 60_000;
const TTS_FALLBACK_MODELS = ["tts-1"];

function spokenText(text: string): string {
  return text.replace(/\s*\[S\d+\]/g, "").replace(/\s+/g, " ").trim().slice(0, 4000);
}

/** Resolves an OpenAI-compatible provider whose /audio/speech endpoint can synthesize. */
async function pickTtsProvider(providerId?: string): Promise<{ id: string; label: string; base: string; apiKey: string } | null> {
  const { listProviders } = await import("./store.js");
  const providers = await listProviders().catch(() => []);
  const TTS_FAMILIES = new Set(["openai", "custom", "azure", "opencode-zen", "together", "fireworks"]);
  const ordered = [...providers].sort((a, b) => {
    const score = (p: any) => (p.id === providerId ? 2 : p.provider === "openai" ? 1 : p.provider === "custom" ? 0.5 : 0);
    return score(b) - score(a);
  });
  for (const p of ordered) {
    const def = p as any;
    if (!def.apiKey || !TTS_FAMILIES.has(def.provider)) continue;
    const base = String(def.baseUrl || (def.provider === "openai" ? "https://api.openai.com/v1" : "")).replace(/\/+$/, "");
    if (!base) continue;
    return { id: def.id, label: def.label || def.id, base, apiKey: def.apiKey };
  }
  return null;
}

/** Parses the first MP3 frame header for the bitrate (CBR duration estimate). */
export function mp3DurationMs(bytes: Buffer): number {
  const BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
  const SAMPLES: Record<number, number> = { 3: 44100, 2: 22050, 0: 11025 };
  for (let i = 0; i < Math.min(bytes.length - 4, 4096); i++) {
    if (bytes[i] !== 0xff || (bytes[i + 1] & 0xe0) !== 0xe0) continue;
    const version = (bytes[i + 1] >> 3) & 0x03;
    const layer = (bytes[i + 1] >> 1) & 0x03;
    if (layer !== 1) continue; // Layer III only
    const bitrate = BITRATES[(bytes[i + 2] >> 4) & 0x0f];
    const sampleRate = SAMPLES[version] ?? 44100;
    if (!bitrate) continue;
    const padding = (bytes[i + 2] >> 1) & 0x01;
    const frameLen = Math.floor((144_000 * bitrate) / sampleRate) + padding;
    if (frameLen < 24) continue;
    const frames = Math.max(1, Math.round(bytes.length / frameLen));
    const samplesPerFrame = version === 3 ? 1152 : 576;
    return (frames * samplesPerFrame * 1000) / sampleRate;
  }
  // No frame header found — assume a conservative 48 kbps.
  return (bytes.length * 8) / 48;
}

async function synthesizeTurn(base: string, apiKey: string, model: string, voice: string, text: string): Promise<Buffer> {
  const response = await fetch(`${base}/audio/speech`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, voice, input: text, response_format: "mp3" }),
    signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`TTS ${response.status}: ${detail.slice(0, 200)}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 100) throw new Error("TTS returned an empty audio payload");
  return buffer;
}

/**
 * Produces the neural MP3 episode for a script (best-effort): synthesizes
 * every turn with the configured OpenAI-compatible provider, concatenates
 * the MP3 frames, records per-turn timestamps for transcript highlighting,
 * and persists `<audioDir>/<id>.mp3`. Returns the overview unchanged when
 * no TTS-capable provider exists or synthesis fails — the browser
 * speechSynthesis fallback covers playback in that case.
 */
export async function synthesizeAudioEpisode(
  notebookId: string,
  overview: AudioOverview,
  input: GenerateAudioOverviewInput = {}
): Promise<AudioOverview> {
  const onStatus = input.onStatus || (() => {});
  let provider: { id: string; label: string; base: string; apiKey: string } | null = null;
  try {
    provider = await pickTtsProvider(input.providerId);
  } catch { /* provider enumeration is best-effort */ }
  if (!provider) {
    onStatus("No TTS-capable provider — the episode will play with browser voices.");
    return overview;
  }

  onStatus(`Synthesizing ${overview.turns.length} host turns with ${provider.label} TTS…`);
  const buffers = new Array<Buffer | null>(overview.turns.length).fill(null);
  try {
    for (let batchStart = 0; batchStart < overview.turns.length; batchStart += TTS_CONCURRENCY) {
      if (input.isCancelled?.()) throw new Error("cancelled");
      const batch = overview.turns
        .map((turn, idx) => ({ turn, idx }))
        .slice(batchStart, batchStart + TTS_CONCURRENCY);
      await Promise.all(batch.map(async ({ turn, idx }) => {
        const text = spokenText(turn.text);
        if (!text) return;
        let lastError: unknown = null;
        for (const model of [TTS_MODEL, ...TTS_FALLBACK_MODELS]) {
          try {
            buffers[idx] = await synthesizeTurn(provider!.base, provider!.apiKey, model, TTS_VOICES[turn.speaker], text);
            break;
          } catch (error) {
            lastError = error;
            // A 400/404 on the modern model name falls back to tts-1 once;
            // anything else (auth, quota, network) aborts the episode.
            if (model === TTS_MODEL && !/\b(400|404)\b/.test(String(error))) break;
          }
        }
        if (!buffers[idx]) throw lastError instanceof Error ? lastError : new Error("TTS turn failed");
      }));
    }
  } catch (error) {
    onStatus(`Neural audio unavailable (${error instanceof Error ? error.message : String(error)}) — falling back to browser voices.`);
    return overview;
  }

  // Concatenate + timestamp.
  const chunks = buffers.map((b) => b!);
  const mp3 = Buffer.concat(chunks);
  const timestamps: number[] = [];
  let cursorMs = 0;
  for (const chunk of chunks) {
    timestamps.push(Math.round(cursorMs));
    cursorMs += mp3DurationMs(chunk);
  }
  const fileName = `${overview.id}.mp3`;
  const filePath = path.join(audioDirPath(notebookId), fileName);
  await fs.mkdir(audioDirPath(notebookId), { recursive: true });
  await writeFileAtomic(filePath, mp3);
  const durationMinutes = Math.max(0.1, Math.round((cursorMs / 60_000) * 10) / 10);
  onStatus(`Neural episode ready — ${(mp3.length / 1024 / 1024).toFixed(1)} MB, ~${durationMinutes} min`);
  return {
    ...overview,
    audioFilename: fileName,
    audioMimeType: "audio/mpeg",
    turnTimestampsMs: timestamps,
    audioModel: TTS_MODEL,
    durationMinutes,
    updatedAt: new Date().toISOString(),
  };
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

/** Loads the synthesized episode for renderer playback (base64 payload). */
export async function readNotebookAudioEpisode(notebookId: string, audioId: string): Promise<{ base64: string; mimeType: string } | null> {
  const overview = (await listNotebookAudioOverviews(notebookId)).find((a) => a.id === audioId);
  if (!overview?.audioFilename) return null;
  const safe = path.basename(overview.audioFilename).replace(/[^a-zA-Z0-9_.-]/g, "");
  try {
    const bytes = await fs.readFile(path.join(audioDirPath(notebookId), safe));
    if (bytes.length > 200 * 1024 * 1024) return null;
    return { base64: bytes.toString("base64"), mimeType: overview.audioMimeType || "audio/mpeg" };
  } catch {
    return null;
  }
}

/** Save dialog + file copy for the Download MP3 button. Returns the saved path or null. */
export async function saveNotebookAudioEpisode(notebookId: string, audioId: string): Promise<string | null> {
  const overview = (await listNotebookAudioOverviews(notebookId)).find((a) => a.id === audioId);
  if (!overview?.audioFilename) return null;
  const safe = path.basename(overview.audioFilename).replace(/[^a-zA-Z0-9_.-]/g, "");
  const source = path.join(audioDirPath(notebookId), safe);
  try {
    const { dialog } = await import("electron");
    const outcome = await dialog.showSaveDialog({
      defaultPath: `${overview.title.replace(/[^a-zA-Z0-9 _-]/g, "").slice(0, 80) || "audio-overview"}.mp3`,
      filters: [{ name: "Audio", extensions: ["mp3"] }],
    });
    if (outcome.canceled || !outcome.filePath) return null;
    await fs.copyFile(source, outcome.filePath);
    return outcome.filePath;
  } catch {
    return null;
  }
}

export async function deleteNotebookAudioOverview(notebookId: string, audioId: string): Promise<AudioOverview[]> {
  try {
    await fs.rm(audioOverviewPath(notebookId, audioId), { force: true });
  } catch { /* ignore */ }
  return listNotebookAudioOverviews(notebookId);
}
