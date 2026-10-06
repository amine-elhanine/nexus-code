import { promises as fs } from "node:fs";
import path from "node:path";
import { composeContextBlock } from "./notebook-text.js";
import { collectDocumentEvidence, extractDocumentJson, fallbackTitle } from "./notebook-documents.js";
import { notebookSessionDir, type NotebookSourceCitation } from "./notebook-store.js";

// Grounded quiz generation for Notebook Mode: MCQ (4 options), True/False,
// or a mixed blend. Retrieval reuses the isolated notebook store via
// collectDocumentEvidence, so quizzes never leak across notebooks and every
// question stays traceable to cited passages.

export type NotebookQuizType = "mcq" | "truefalse" | "mixed";
export type NotebookQuizQuestionType = "mcq" | "boolean";

export type NotebookQuizQuestion = {
  id: string;
  type: NotebookQuizQuestionType;
  question: string;
  options?: string[];
  correctIndex?: number;
  correctBoolean?: boolean;
  explanation: string;
  citations: NotebookSourceCitation[];
};

export type NotebookQuiz = {
  id: string;
  notebookId: string;
  title: string;
  topic: string;
  quizType: NotebookQuizType;
  questionCount: number;
  questions: NotebookQuizQuestion[];
  citations: NotebookSourceCitation[];
  createdAt: string;
  updatedAt: string;
};

export type GenerateQuizInput = {
  topic?: string;
  count?: number;
  quizType?: NotebookQuizType;
  fileIds?: string[];
  providerId?: string;
  model?: string;
  instructions?: string;
  generate?: (system: string, user: string) => Promise<string>;
  onStatus?: (text: string) => void;
};

function uid(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function quizzesPath(notebookId: string) {
  return path.join(notebookSessionDir(notebookId), "quizzes.json");
}

async function readQuizzes(notebookId: string): Promise<NotebookQuiz[]> {
  try {
    return JSON.parse(await fs.readFile(quizzesPath(notebookId), "utf8")) as NotebookQuiz[];
  } catch {
    return [];
  }
}

async function writeQuizzes(notebookId: string, quizzes: NotebookQuiz[]) {
  await fs.mkdir(path.dirname(quizzesPath(notebookId)), { recursive: true });
  await fs.writeFile(quizzesPath(notebookId), JSON.stringify(quizzes, null, 2), "utf8");
}

export async function listNotebookQuizzes(notebookId: string): Promise<NotebookQuiz[]> {
  const quizzes = await readQuizzes(notebookId);
  return [...quizzes].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function deleteNotebookQuiz(notebookId: string, quizId: string): Promise<NotebookQuiz[]> {
  const quizzes = await readQuizzes(notebookId);
  const next = quizzes.filter((q) => q.id !== quizId);
  await writeQuizzes(notebookId, next);
  return next;
}

export function clampQuizCount(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return 5;
  return Math.min(20, Math.max(3, Math.round(n)));
}

export function normalizeQuizType(raw: unknown): NotebookQuizType {
  if (raw === "mcq" || raw === "truefalse" || raw === "mixed") return raw;
  return "mixed";
}

async function planWithLlm(system: string, user: string, input: GenerateQuizInput): Promise<string> {
  if (input.generate) return input.generate(system, user);
  const { listProviders } = await import("./store.js");
  const { createChatModel } = await import("./providers.js");
  const providers = await listProviders();
  const provider = input.providerId ? providers.find((p) => p.id === input.providerId) : providers[0];
  if (!provider) throw new Error("Configure a chat provider first (Providers button, top right).");
  const modelName = input.model || provider.models[0];
  if (!modelName) throw new Error("No chat model selected.");
  const llm = await createChatModel(provider, modelName);
  const res = await llm.invoke([
    { role: "system", content: system } as never,
    { role: "user", content: user } as never,
  ]);
  return typeof res.content === "string" ? res.content : JSON.stringify(res.content);
}

function citationByIndex(citations: NotebookSourceCitation[], index: number): NotebookSourceCitation | undefined {
  return citations.find((c) => c.index === index);
}

function parseCitationRefs(text: string): number[] {
  const out: number[] = [];
  const re = /\[S(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text || ""))) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0 && !out.includes(n)) out.push(n);
  }
  return out.slice(0, 4);
}

type RawQuizQuestion = {
  type?: unknown;
  question?: unknown;
  options?: unknown;
  correctIndex?: unknown;
  correctBoolean?: unknown;
  answer?: unknown;
  explanation?: unknown;
  citations?: unknown;
};

export function sanitizeQuestions(
  parsed: unknown,
  count: number,
  quizType: NotebookQuizType,
  citations: NotebookSourceCitation[]
): NotebookQuizQuestion[] {
  const root = (parsed || {}) as { questions?: unknown };
  if (!Array.isArray(root.questions)) throw new Error("Model did not return a questions array.");
  const questions: NotebookQuizQuestion[] = [];
  const wantBoolean = (i: number): boolean => {
    if (quizType === "mcq") return false;
    if (quizType === "truefalse") return true;
    return i % 2 === 1;
  };
  root.questions.slice(0, count).forEach((rawEntry, i) => {
    const raw = (rawEntry || {}) as RawQuizQuestion;
    const isBoolean = typeof raw.type === "string" && /bool|true|false|tf/i.test(String(raw.type)) ? true : wantBoolean(i);
    const question = String(raw.question || "").trim().slice(0, 500);
    if (!question) throw new Error(`Question ${i + 1} is missing text.`);
    const explanation = String(raw.explanation || "").trim().slice(0, 600) || "See the cited passage.";
    const refs = parseCitationRefs(`${question} ${explanation} ${Array.isArray(raw.citations) ? (raw.citations as unknown[]).join(" ") : ""}`);
    const linked = refs.map((n) => citationByIndex(citations, n)).filter((c): c is NotebookSourceCitation => Boolean(c));
    const fallbackCite = citations[i % Math.max(1, citations.length)];
    // Model-cited passages are verified; the positional fallback is an
    // unverified guess that the UI renders dimmed.
    const linkedCitations = linked.map((c) => ({ ...c, verified: true }));
    const fallbackCitations = fallbackCite ? [{ ...fallbackCite, verified: false }] : [];
    const questionCitations = (linkedCitations.length ? linkedCitations : fallbackCitations).slice(0, 2);
    if (isBoolean) {
      let correctBoolean: boolean | null = null;
      if (typeof raw.correctBoolean === "boolean") correctBoolean = raw.correctBoolean;
      else if (typeof raw.answer === "boolean") correctBoolean = raw.answer;
      else if (typeof raw.answer === "string") {
        const v = raw.answer.trim().toLowerCase();
        if (["true", "t", "yes", "correct"].includes(v)) correctBoolean = true;
        else if (["false", "f", "no", "incorrect"].includes(v)) correctBoolean = false;
      } else if (typeof raw.correctIndex === "number") correctBoolean = raw.correctIndex === 0;
      if (correctBoolean === null) throw new Error(`Question ${i + 1} is missing its True/False answer.`);
      questions.push({
        id: uid("q"),
        type: "boolean",
        question,
        correctBoolean,
        explanation,
        citations: questionCitations,
      });
    } else {
      if (!Array.isArray(raw.options) || raw.options.length < 3) throw new Error(`Question ${i + 1} needs at least 3 options.`);
      const options = (raw.options as unknown[]).map((o) => String(o || "").trim().slice(0, 200)).filter(Boolean).slice(0, 4);
      if (options.length < 3) throw new Error(`Question ${i + 1} needs at least 3 options.`);
      while (options.length < 4) options.push(`Option ${options.length + 1}`);
      let correctIndex = typeof raw.correctIndex === "number" ? raw.correctIndex : -1;
      if (!(correctIndex >= 0 && correctIndex < options.length) && typeof raw.answer === "string") {
        const idx = options.findIndex((o) => o.toLowerCase() === String(raw.answer).trim().toLowerCase());
        if (idx >= 0) correctIndex = idx;
      }
      if (!(correctIndex >= 0 && correctIndex < options.length)) throw new Error(`Question ${i + 1} is missing its correct option.`);
      questions.push({
        id: uid("q"),
        type: "mcq",
        question,
        options,
        correctIndex,
        explanation,
        citations: questionCitations,
      });
    }
  });
  if (!questions.length) throw new Error("Model returned no usable questions.");
  return questions;
}

export async function generateNotebookQuiz(
  notebookId: string,
  input: GenerateQuizInput
): Promise<NotebookQuiz> {
  const status = input.onStatus || (() => {});
  const topic = (input.topic || "").trim() || "overview of the uploaded sources";
  const count = clampQuizCount(input.count);
  const quizType = normalizeQuizType(input.quizType);
  const scope = input.fileIds?.length ? input.fileIds : undefined;

  status("Searching notebook sources…");
  const evidence = await collectDocumentEvidence(notebookId, topic, scope);
  if (!evidence.ranked.length) {
    throw new Error("Not covered in your files — upload the relevant sources or widen the file scope first.");
  }
  status(`Using ${evidence.ranked.length} passages from ${evidence.coverage.filesUsed}/${evidence.coverage.filesTotal} files…`);

  const context = composeContextBlock(
    evidence.ranked.map((r) => ({ headingPath: [r.sourceName, ...r.headingPath], text: r.text })),
    40000
  );
  const typeLine =
    quizType === "mcq"
      ? "Every question MUST be type \"mcq\" with exactly 4 options and a correctIndex (0-3)."
      : quizType === "truefalse"
        ? "Every question MUST be type \"boolean\" with a correctBoolean (true/false). No options."
        : "Alternate types: even positions (0,2,4…) are \"mcq\" with exactly 4 options + correctIndex, odd positions are \"boolean\" with correctBoolean.";
  const baseInstructions = input.instructions ? `\nNotebook goal:\n${input.instructions}` : "";
  const system = `You are a precise exam author. Reply with a single JSON object only, no markdown fences, no prose: {"title": string, "questions": [{"type": "mcq"|"boolean", "question": string, "options": string[4], "correctIndex": number, "correctBoolean": boolean, "explanation": string}]}. Rules: exactly ${count} questions; ${typeLine} every question grounded in SOURCES with its [S1]/[S2] marker kept in the question or explanation; one idea per question; distractors plausible but clearly wrong; explanation is 1-2 sentences.${baseInstructions}`;
  const user = `Topic: ${topic}\nCount: ${count}\nCitation markers available: ${evidence.citations.map((c) => `[S${c.index}] ${c.sourceName} — ${c.heading}`).join("; ")}\n\nSOURCES:\n${context}`;

  status("Drafting grounded quiz questions…");
  let parsed: unknown;
  try {
    parsed = extractDocumentJson(await planWithLlm(system, user, input));
    sanitizeQuestions(parsed, count, quizType, evidence.citations);
  } catch {
    status("First draft came back malformed — retrying with stricter format…");
    const repairSystem = `${system}\nCRITICAL: your previous reply was not usable. Reply with a single valid JSON object only — no markdown fences, no prose before or after.`;
    parsed = extractDocumentJson(await planWithLlm(repairSystem, user, input));
  }
  const questions = sanitizeQuestions(parsed, count, quizType, evidence.citations);
  const rawTitle = ((parsed || {}) as { title?: unknown }).title;
  const title = (typeof rawTitle === "string" && rawTitle.trim() ? rawTitle.trim() : fallbackTitle(topic, "report")).slice(0, 120);
  const now = new Date().toISOString();
  const quiz: NotebookQuiz = {
    id: uid("quiz"),
    notebookId,
    title: title || `Quiz — ${topic}`.slice(0, 120),
    topic,
    quizType,
    questionCount: questions.length,
    questions,
    citations: evidence.citations,
    createdAt: now,
    updatedAt: now,
  };
  const quizzes = await readQuizzes(notebookId);
  await writeQuizzes(notebookId, [quiz, ...quizzes]);
  return quiz;
}
