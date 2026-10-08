import { promises as fs } from "node:fs";
import path from "node:path";
import { executeCommand } from "./command-service.js";
import { DOC_SKILL_LIB } from "./doc-skills.js";
import {
  docsDir,
  fallbackTitle,
  registerNotebookDocument,
  safeStem,
  type GenerateDocumentInput,
  type NotebookDocument,
  type RankedPassage,
} from "./notebook-documents.js";
import type { NotebookSourceCitation } from "./notebook-store.js";

// Skill-based generation WITH the Home-style tool-calling agent loop
// (runProjectAgent, taskKind "general"): the model reads EVIDENCE.md plus the
// user's own installed skills, writes a generator script
// with write_file, runs it with execute, verifies the deliverable, and deletes
// the throwaway script. Facts are grounded strictly in the notebook evidence.
// Deterministic converters in notebook-documents.ts remain the fallback when
// this path throws.

export type AgentEvidence = {
  ranked: RankedPassage[];
  citations: NotebookSourceCitation[];
  topic: string;
  coverage?: { totalChunks: number; usedChunks: number; truncated: boolean; mode: "full" | "targeted" };
};

function evidenceMarkdown(evidence: AgentEvidence): string {
  const coverage = evidence.coverage;
  const scopeLine = coverage
    ? coverage.mode === "full"
      ? `Coverage: ${evidence.citations.length} passages covering all sections (${coverage.totalChunks} chunks in scope${coverage.truncated ? " — capped, most representative kept" : ""}). Plan the document so every section is represented.`
      : `Coverage: ${evidence.citations.length} passages relevant to the topic (from ${coverage.totalChunks} chunks in scope). Cover each one — do not stop after the first few.`
    : `Coverage: ${evidence.citations.length} passages. Cover each one — do not stop after the first few.`;
  const lines = [
    "# Evidence — the ONLY source of facts",
    "",
    "Use only what is below. Never invent facts, numbers, names, or examples.",
    "Keep every [Sn] marker next to the fact it supports.",
    scopeLine,
    "",
    `Topic: ${evidence.topic}`,
    "",
  ];
  let lastSource = "";
  for (const c of evidence.citations) {
    const chunk = evidence.ranked.find((r) => r.chunkId === c.chunkId);
    if (!chunk) continue;
    if (c.sourceName !== lastSource) {
      lines.push(`# Source file: ${c.sourceName}`, "");
      lastSource = c.sourceName;
    }
    lines.push(`## [S${c.index}] ${c.sourceName} — ${c.heading}`, "", chunk.text.trim(), "");
  }
  return lines.join("\n");
}

async function resolveProvider(input: GenerateDocumentInput) {
  const { listProviders } = await import("./store.js");
  const providers = await listProviders();
  const provider = input.providerId ? providers.find((p: { id: string }) => p.id === input.providerId) : providers[0];
  if (!provider) throw new Error("Configure a chat provider first (Providers button, top right).");
  const modelName = input.model || provider.models[0];
  if (!modelName) throw new Error("No chat model selected.");
  return { provider, modelName };
}

async function resolvePython(): Promise<string> {
  for (const bin of ["py", "python", "python3"]) {
    try {
      const res = await executeCommand(process.cwd(), `${bin} --version`, { timeoutSeconds: 20 });
      if (res.exitCode === 0 && /python\s+3/i.test(res.output)) return bin;
    } catch { /* try next */ }
  }
  throw new Error("No Python 3 found (tried py, python, python3) — install it or use the built-in renderer.");
}

/** Newest deliverable from the run (exact name preferred, any name accepted). */
async function findDeliverable(dirs: string[], exactAbs: string, ext: string, startMs: number): Promise<string | null> {
  try {
    const stat = await fs.stat(exactAbs);
    if (stat.isFile() && stat.size > 0) return exactAbs;
  } catch { /* fall through to discovery */ }
  let best: { abs: string; mtime: number } | null = null;
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.toLowerCase().endsWith(`.${ext}`)) continue;
      const abs = path.join(dir, entry);
      try {
        const stat = await fs.stat(abs);
        if (!stat.isFile() || !stat.size) continue;
        if (stat.mtimeMs < startMs - 60_000) continue;
        if (!best || stat.mtimeMs > best.mtime) best = { abs, mtime: stat.mtimeMs };
      } catch { /* ignore */ }
    }
  }
  return best?.abs || null;
}

/** Forward-slash path: safe inside single-quoted python strings on Windows. */
function pyPath(abs: string): string {
  return abs.split(path.sep).join("/");
}

async function countSlides(py: string, abs: string): Promise<number> {
  try {
    const res = await executeCommand(
      path.dirname(abs),
      `${py} -c "from pptx import Presentation; print(len(Presentation('${pyPath(abs)}').slides))"`,
      { timeoutSeconds: 60 }
    );
    const n = Number((res.output.match(/(\d+)/) || [])[1]);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

async function countDocxSections(py: string, abs: string): Promise<number> {
  try {
    const res = await executeCommand(
      path.dirname(abs),
      `${py} -c "from docx import Document; print(sum(1 for p in Document('${pyPath(abs)}').paragraphs if (p.style.name or '').startswith('Heading')))"`,
      { timeoutSeconds: 60 }
    );
    const n = Number((res.output.match(/(\d+)/) || [])[1]);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * Skill-driven generation via the Home-style tool loop. Resolves with the
 * finished document, or throws (the caller falls back to the deterministic
 * converters).
 */
export async function generateNotebookDocumentViaAgent(
  notebookId: string,
  input: GenerateDocumentInput,
  evidence: AgentEvidence
): Promise<NotebookDocument> {
  const status = input.onStatus || (() => {});
  const t0 = Date.now();
  const isSlides = input.kind === "slides";
  const skillName = isSlides ? "pptx" : input.format === "pdf" ? "pdf" : input.format === "xlsx" ? "xlsx" : "docx";
  const lib = DOC_SKILL_LIB[skillName];
  const ext = input.format;
  const workId = `nbdoc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const runId = input.runId || `nbdoc-${workId}`;
  const checkCancelled = () => {
    if (input.isCancelled?.()) throw new Error("Document generation cancelled.");
  };

  status("Preparing the document agent (resolving Python)…");
  const py = await resolvePython();
  checkCancelled();

  status(`Installing ${lib} (one-time setup)…`);
  const installed = await executeCommand(process.cwd(), `${py} -m pip install ${lib}`, { timeoutSeconds: 240, runId, requireApproval: true });
  checkCancelled();
  if (installed.exitCode !== 0) {
    throw new Error(`${lib} install failed: ${installed.output.slice(-400)}`);
  }

  const root = docsDir(notebookId);
  const workDir = path.join(root, ".work", workId);
  await fs.mkdir(workDir, { recursive: true });
  const evidenceText = evidenceMarkdown(evidence);
  await fs.writeFile(path.join(workDir, "EVIDENCE.md"), evidenceText, "utf8");

  const outFile = `${isSlides ? "presentation" : "report"}_${workId}.${ext}`;
  const artifact = isSlides ? "presentation (.pptx)" : ext === "pdf" ? "PDF report (.pdf)" : "Word report (.docx)";

  // Test seam (mirrors the old single-shot path): deterministic callers can
  // inject `generate` to skip the LLM agent loop entirely.
  if (input.generate) {
    checkCancelled();
    const reply = await input.generate("notebook-doc-agent", `Topic: ${evidence.topic}\n\n${evidenceText}`);
    checkCancelled();
    const title = parseAgentTitle(reply) || fallbackTitle(evidence.topic, input.kind);
    const script = extractPythonBlock(reply);
    if (!script) throw new Error("The model did not return a usable generator script.");
    await fs.writeFile(path.join(workDir, "generate_doc.py"), script, "utf8");
    const run = await executeCommand(workDir, `${py} generate_doc.py`, { timeoutSeconds: 300, runId, requireApproval: true });
    checkCancelled();
    if (run.exitCode !== 0) throw new Error(`Generator script failed: ${run.output.slice(-600)}`);
    return finishDeliverable(notebookId, input, evidence, { root, workDir, workId, outFile, ext, isSlides, py, t0, title, status });
  }

  const { provider, modelName } = await resolveProvider(input);

  // Isolated backend rooted at the run workdir: the agent can only see
  // EVIDENCE.md + what it creates there — never other notebooks. Keep the
  // shared approval gate on shell commands, including package installation.
  const { getAgentBackend } = await import("./command-service.js");
  const { backend } = await getAgentBackend(
    { id: `notebook-${notebookId}`, name: `notebook-${notebookId}`, root: workDir } as never,
    { runId }
  );
  const { beginCommandRun, endCommandRun, isCommandRunCancelled } = await import("./command-service.js");
  // IPC callers register the run before any async setup. Direct callers still
  // get a complete run lifecycle here.
  const ownsRun = !input.runId;
  if (ownsRun) beginCommandRun(runId);
  try {
    status("The agent is designing your document from your sources…");
    const { runProjectAgent } = await import("./agent-service.js");
    const request = [
      `Build a ${artifact} about: ${evidence.topic || "(full overview of the sources)"}.`,
      ``,
      `Today is ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })} — use it for cover/footer dates and to resolve relative ranges like "last decade".`,
      ``,
      `Workspace: you are inside an isolated folder containing EVIDENCE.md — the ONLY source of facts. Read it first with read_file (it may take several reads; it covers ${evidence.citations.length} passages).`,
      `Check your installed skills first: if one covers the requested file type, read its SKILL.md BEFORE writing code. Skill reads are free.`,
      `Plan first: EVIDENCE.md already tells you the coverage (all sections, or all topic-relevant passages). Draft the document structure covering ALL of it — one section/slide group per source section — then build. Do not stop after the first few passages.`,
      `Coverage is mandatory: every '# Source file:' section in EVIDENCE.md must be represented by at least one slide (presentations) or subsection (reports). Group the final Sources slide/section by file.`,
      `Workflow: write a Python generator script with write_file (e.g. generate_doc.py), run it with execute (${py} generate_doc.py), verify the output exists with ls, fix and re-run on failure.`,
      `The script MUST write exactly ${outFile} in the CURRENT working directory (relative path, no subfolders).`,
      `Design bar (match Home quality): ${isSlides ? "16:9 widescreen, title slide with kicker + deck title + subtitle + section panel, one idea per slide with kicker/title/3-5 short bullets, highlight cards, Sources slide, footer with deck title + date + slide number." : "Title + Executive summary + 4-7 Heading-1 sections with flowing paragraphs and bullet lists, tables only for tabular data, final Sources section, styled headings — never raw markdown."}`,
      `Grounding: facts come ONLY from EVIDENCE.md. Keep every [Sn] citation marker next to the fact it supports. Never invent numbers, names, or examples.`,
      input.instructions ? `Notebook goal:\n${input.instructions}` : ``,
      ``,
      `When done, delete the throwaway generator script with delete so only ${outFile} remains, and reply with first line TITLE: <short document title>.`,
    ].join("\n");

    const result = await runProjectAgent({
      projectRoot: workDir,
      telemetryRoot: workDir,
      sessionId: `nbdoc-${workId}`,
      request,
      attachmentDocs: [{ name: "EVIDENCE.md", mimeType: "text/markdown", text: evidenceText.slice(0, 20000), truncated: evidenceText.length > 20000 }],
      settings: { provider, model: modelName },
      memory: { projectMemory: "", sessionMemory: "" },
      history: [],
      mode: "auto",
      taskKind: "general",
      skillsMode: "notebook",
      agentBackend: backend,
      onEvent: (event) => {
        if (event.type === "status" || event.type === "tool") status(event.text);
      },
      isCancelled: () => isCommandRunCancelled(runId),
    });
    const title = parseAgentTitle(result.response) || fallbackTitle(evidence.topic, input.kind);
    return finishDeliverable(notebookId, input, evidence, { root, workDir, workId, outFile, ext, isSlides, py, t0, title, status });
  } finally {
    if (ownsRun) endCommandRun(runId);
  }
}

/** First "TITLE: ..." line of the agent's final reply. */
function parseAgentTitle(reply: string): string {
  const m = (reply || "").match(/^\s*TITLE\s*:\s*(.+)$/mi);
  return (m?.[1] || "").trim().slice(0, 160);
}

/** Best-effort python block extraction for the `generate` test seam. */
function extractPythonBlock(reply: string): string | null {
  const fence = (reply || "").match(/```(?:python|py)?\s*\n([\s\S]*?)```/i);
  const script = (fence ? fence[1] : reply).trim();
  if (!script || script.length < 100) return null;
  return script;
}

async function finishDeliverable(
  notebookId: string,
  input: GenerateDocumentInput,
  evidence: AgentEvidence,
  ctx: { root: string; workDir: string; workId: string; outFile: string; ext: string; isSlides: boolean; py: string; t0: number; title: string; status: (t: string) => void }
): Promise<NotebookDocument> {
  const { root, workDir, workId, outFile, ext, isSlides, py, t0, title, status } = ctx;
  const produced = await findDeliverable([root, workDir], path.join(root, outFile), ext, t0);
  if (!produced) {
    throw new Error(`Agent ran but no .${ext} file appeared.`);
  }
  const buffer = await fs.readFile(produced);

  const finalName = `${safeStem(title, isSlides ? "presentation" : "report")}_${workId.slice(-6)}.${ext}`;
  const finalAbs = path.join(root, finalName);
  if (produced !== finalAbs) {
    await fs.rename(produced, finalAbs);
  }
  try {
    await fs.rm(workDir, { recursive: true, force: true });
  } catch { /* best effort */ }

  status("Reading back the finished document…");
  const count = isSlides ? await countSlides(py, finalAbs) : ext === "docx" ? await countDocxSections(py, finalAbs) : 0;
  const preview = [
    `# ${title}`,
    "",
    ...evidence.citations.slice(0, 24).map((c) => `- [S${c.index}] ${c.sourceName} — ${c.heading.slice(0, 120)}`),
  ].join("\n");

  return registerNotebookDocument(notebookId, {
    kind: input.kind,
    format: input.format,
    title,
    filename: finalName,
    size: buffer.length,
    prompt: input.prompt,
    preview,
    citations: evidence.citations,
    sectionCount: isSlides ? 0 : count,
    slideCount: isSlides ? count : 0,
    engine: "skill-agent",
  });
}
