# One-off: Phase 2.1 — neural 2-host TTS synthesis for Audio Overviews.
# Adds MP3 episode production to notebook-audio.ts, IPC read/download routes,
# preload bridge methods, and the renderer types. The AudioPlayerModal branch
# is applied separately.
p = 'electron/notebook-audio.ts'
s = open(p, encoding='utf8').read()

# 1. Type additions on AudioOverview
old = '''export type AudioOverview = {
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
};'''
assert old in s
new = '''export type AudioOverview = {
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
};'''
s = s.replace(old, new)

# 2. Synthesis engine + episode producer, appended before listNotebookAudioOverviews
anchor = 'export async function listNotebookAudioOverviews('
assert anchor in s
engine = '''// ── Neural TTS episode synthesis (OpenAI-compatible /audio/speech) ──────────

const TTS_MODEL = "gpt-4o-mini-tts";
const TTS_VOICES: Record<AudioOverviewTurn["speaker"], string> = { Alex: "alloy", Sam: "nova" };
const TTS_CONCURRENCY = 3;
const TTS_TIMEOUT_MS = 60_000;
const TTS_FALLBACK_MODELS = ["tts-1"];

function spokenText(text: string): string {
  return text.replace(/\\s*\\[S\\d+\\]/g, "").replace(/\\s+/g, " ").trim().slice(0, 4000);
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
    const base = String(def.baseUrl || (def.provider === "openai" ? "https://api.openai.com/v1" : "")).replace(/\\/+$/, "");
    if (!base) continue;
    return { id: def.id, label: def.label || def.id, base, apiKey: def.apiKey };
  }
  return null;
}

/** Parses the first MP3 frame header for the bitrate (CBR duration estimate). */
function mp3DurationMs(bytes: Buffer): number {
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
            if (model === TTS_MODEL && !/\\b(400|404)\\b/.test(String(error))) break;
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

''' + anchor
s = s.replace(anchor, engine, 1)

# 3. Hook synthesis into the generation flow (best-effort, after JSON save).
old2 = '''  const dir = audioDirPath(notebookId);
  await fs.mkdir(dir, { recursive: true });
  await writeFileAtomic(audioOverviewPath(notebookId, audioId), JSON.stringify(overview, null, 2));
  return overview;
}'''
assert old2 in s
new2 = '''  const dir = audioDirPath(notebookId);
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
}'''
s = s.replace(old2, new2)

open(p, 'w', encoding='utf8', newline='\n').write(s)
print("notebook-audio synthesis installed")
