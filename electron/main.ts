import { app, BrowserWindow, dialog, ipcMain, shell, session, protocol, net } from "electron";
import path from "node:path";
import { existsSync, promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import { runProjectAgent, RunCancelledError, clearLastRunCheckpoint, isContinueRequest, getLastRunCheckpoint, loadLastRunCheckpoint, summarizeCompletedSteps, type AgentMode, type AgentSettings, type AgentEvent, type HistoryInput } from "./agent-service.js";
import { PROVIDERS, fetchRemoteModels } from "./providers.js";
import {
  appendSessionMessages, createSession, deleteProject, deleteSession, ensureHomeProject, getProject, getSession,
  getSkillsConfig, listEmbeddingProviders, listMcpServers, listProjects, listProviders, listSessions,
  removeEmbeddingProvider, removeMcpServer, removeProvider, saveSkillsConfig, updateProjectMemory,
  updateSession, upsertEmbeddingProvider, upsertMcpServer, upsertProject, upsertProvider, getAppSettings, saveAppSettings, getNotebookParserConfig, saveNotebookParserConfig, type EmbeddingProviderConfig,
  type McpServerConfig, type ProviderConfig
} from "./store.js";
import { HOME_PROJECT_ID, cleanupHomeGeneratorScripts, downloadHomeFile, ensureHomeDir, listHomeFiles, listHomeSessionFiles, openHomeFolder, readHomeFile } from "./home-service.js";
import { testMcpServer } from "./mcp-service.js";
import { createSkill, deleteSkill, ensureSkillSourceDirs, importSkill, listAllSkills, listSkills, openSkillsFolder, readSkillContent, setSkillModes } from "./skills-service.js";
import { beginCommandRun, cancelCommandRun, endCommandRun, isCommandRunCancelled, runProjectCommand, getAgentBackend } from "./command-service.js";
import { createWorkspaceCheckpoint, deleteWorkspaceCheckpoint, getWorkspaceDiffFiles, restoreWorkspaceCheckpoint, revertAllWorkspaceChanges, revertWorkspaceFile } from "./diff-service.js";
import { getWorkspaceGit, listWorkspaceFiles, readWorkspaceFile, writeWorkspaceFile } from "./project-tools.js";
import {
  createSessionWorktree, getSessionWorktree, mergeWorktreeToMain, discardSessionWorktree,
  getSessionWorktreeDiff, isGitRepo
} from "./worktree-service.js";
import { commitSessionWork, ensureGitRepo, getHeadCommit } from "./repo-service.js";
import { listArtifacts, getArtifact, updateArtifactStatus, deleteSessionTelemetry, type ArtifactStatus } from "./artifacts-service.js";
import { readSessionTrajectory } from "./trajectory-service.js";
import { discoverProjectRules } from "./rules-service.js";
import { terminalService } from "./terminal-service.js";
import { discoverCustomCommands } from "./custom-commands-service.js";
import { daemonService } from "./daemon-service.js";
import { agentBrowserService, type AgentBrowserResponse } from "./browser-service.js";
import { updaterService, type UpdaterState } from "./updater-service.js";
import { cancelCommandApprovals, resolveCommandApproval, setApprovalNotifier, type CommandApprovalRequest } from "./approval-service.js";
import {
  appendNotebookMessage, createNotebook, createNotebookChat, deleteNotebook, deleteNotebookChat, deleteNotebookSource,
  deleteNotebookNote, getNotebookSettings, importSourceBuffer, listNotebookChats, listNotebookNotes, listNotebookSources, listNotebooks,
  notebookIndexStats, notebookSessionDir, pickAndImportSourceFiles, readSessionDigest, recentChatHistory, renameNotebook, saveNotebookNote, saveNotebookSettings,
} from "./notebook-store.js";
import { getNotebookEmbeddingConfig, saveNotebookEmbeddingConfig, testEmbeddingEndpoint, type EmbeddingEndpoint } from "./notebook-embeddings.js";
import { answerNotebookQuestion, getChunkPassage, hybridRetrieve } from "./notebook-rag.js";
import { enqueueIngest, recoverInterruptedJobs, reindexSessionFromLibrary, retrySource } from "./notebook-jobs.js";
import { sessionOutline } from "./notebook-library.js";

protocol.registerSchemesAsPrivileged([
  { scheme: "nexus-attachment", privileges: { standard: true, secure: true, supportFetchAPI: true } }
]);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | null = null;
let activeProjectId: string | null = null;
let activeSessionId: string | null = null;
let activeProjectRoot: string | null = null;
let settings: AgentSettings = { model: process.env.OPENAI_MODEL || "gpt-4.1-mini", baseUrl: process.env.OPENAI_BASE_URL || "" };
const activeRunSessions = new Set<string>();

const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function getAppIcon(): string | undefined {
  const candidates = [
    path.join(__dirname, "../public/icon.png"),
    path.join(__dirname, "../build/icon.png"),
    path.join(process.cwd(), "public/icon.png"),
    path.join(process.cwd(), "build/icon.png"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return undefined;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1540,
    height: 960,
    minWidth: 1180,
    minHeight: 720,
    backgroundColor: "#080a0f",
    title: "Nexus",
    frame: false,
    icon: getAppIcon(),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
    },
  });
  const devMode = process.argv.includes("--dev") || Boolean(process.env.VITE_DEV_SERVER_URL);
  if (devMode) void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL || "http://127.0.0.1:5173");
  else void mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  setApprovalNotifier((request) => mainWindow?.webContents.send("command:approval-request", request));
}

// Agent events are tagged with the session they belong to, so the renderer can
// route them to the right transcript even while several runs are live.
function emit(event: AgentEvent) {
  mainWindow?.webContents.send("agent:event", event);
}
function emitFor(sessionId: string, event: Omit<AgentEvent, "sessionId" | "timestamp">) {
  emit({ ...event, sessionId, timestamp: new Date().toISOString() });
}
function requireRoot() { if (!activeProjectRoot) throw new Error("Select or create a project first."); return activeProjectRoot; }

// Checkpoints left over from deleted/kept runs would keep the Undo card
// clickable forever; this clears the whole stack when a run's changes are
// accepted (Keep) or when rotating history.
const MAX_UNDO_LEVELS = 20;
async function clearCheckpoint(projectId: string, sessionId: string, root: string, checkpointId?: string) {
  const session = await getSession(projectId, sessionId).catch(() => null);
  const stack: string[] = (session as unknown as { checkpointIds?: string[] } | null)?.checkpointIds || [];
  const ids = new Set([...stack, ...(checkpointId ? [checkpointId] : [])]);
  for (const id of ids) {
    try { await deleteWorkspaceCheckpoint(root, id); } catch { /* best effort */ }
  }
  await updateSession(projectId, sessionId, { checkpointId: undefined, checkpointIds: [] });
}

async function pushCheckpoint(projectId: string, sessionId: string, root: string, checkpointId: string) {
  const session = await getSession(projectId, sessionId).catch(() => null);
  const prev: string[] = (session as unknown as { checkpointIds?: string[] } | null)?.checkpointIds
    || (session?.checkpointId ? [session.checkpointId] : []);
  const next = [...prev, checkpointId].slice(-MAX_UNDO_LEVELS);
  const pruned = prev.filter((id) => !next.includes(id));
  for (const id of pruned) {
    try { await deleteWorkspaceCheckpoint(root, id); } catch { /* best effort */ }
  }
  await updateSession(projectId, sessionId, { checkpointId, checkpointIds: next });
}

async function popCheckpoint(projectId: string, sessionId: string, root: string, checkpointId: string) {
  // Restore pops the id (or the top when the id is stale) so Undo is
  // multi-level: each click steps one run further back.
  const session = await getSession(projectId, sessionId).catch(() => null);
  const stack: string[] = (session as unknown as { checkpointIds?: string[] } | null)?.checkpointIds
    || (session?.checkpointId ? [session.checkpointId] : []);
  const idx = stack.lastIndexOf(checkpointId);
  const target = idx >= 0 ? checkpointId : stack[stack.length - 1];
  if (!target) return;
  const next = stack.filter((id, i) => (idx >= 0 ? i !== idx : i !== stack.length - 1));
  try { await deleteWorkspaceCheckpoint(root, target); } catch { /* best effort */ }
  await updateSession(projectId, sessionId, {
    checkpointId: next.length ? next[next.length - 1] : undefined,
    checkpointIds: next,
  });
}

// Attachment URLs are host-style (nexus-attachment://<hash>.png), so the file
// name lives in the hostname — pathname is empty. basename() alone resolves
// to "" (the attachments directory itself), whose fetch rejects with
// ERR_FILE_NOT_FOUND and crashes the main process uncaught.
function attachmentFileName(attachmentUrl: string): string {
  const parsed = new URL(attachmentUrl);
  const candidate = path.basename(parsed.pathname) || parsed.hostname || "";
  // Never allow traversal no matter what the renderer sends.
  return path.basename(candidate);
}

// The model APIs need a fetchable URL for images: nexus-attachment:// is a
// renderer-only scheme. Convert saved attachments back to inline base64
// data URLs before they go anywhere near a provider.
const ATTACHMENT_MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ppsx: "application/vnd.openxmlformats-officedocument.presentationml.slideshow",
  tex: "text/x-tex",
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  yaml: "text/yaml",
  yml: "text/yaml",
  xml: "application/xml",
  html: "text/html",
  htm: "text/html",
  log: "text/plain",
  toml: "text/plain",
};
const ATTACHMENT_EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.openxmlformats-officedocument.presentationml.slideshow": "ppsx",
  "text/x-tex": "tex",
  "text/markdown": "md",
  "text/plain": "txt",
  "text/csv": "csv",
  "text/tab-separated-values": "tsv",
  "application/json": "json",
  "text/yaml": "yaml",
  "application/xml": "xml",
  "text/html": "html",
};

function attachmentMimeForFileName(fileName: string): string {
  const ext = path.extname(fileName).slice(1).toLowerCase();
  return ATTACHMENT_MIME_BY_EXT[ext] || "application/octet-stream";
}

async function resolveImageForModel(imageUrl: string): Promise<string> {
  if (!imageUrl.startsWith("nexus-attachment://")) return imageUrl;
  const fileName = attachmentFileName(imageUrl);
  if (!fileName) throw new Error("Invalid attachment URL.");
  const filePath = path.join(app.getPath("userData"), "attachments", fileName);
  const buffer = await fs.readFile(filePath);
  const ext = path.extname(fileName).slice(1).toLowerCase();
  const mime = ATTACHMENT_MIME_BY_EXT[ext] || "application/octet-stream";
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

// Raw bytes for any attachment URL (nexus-attachment:// file or inline
// data: URL). Used to extract document text for the model and to let the
// agent import non-image files into the project.
async function resolveAttachmentBytes(attachmentUrl: string): Promise<{ buffer: Buffer; fileName: string; mimeType: string }> {
  if (attachmentUrl.startsWith("data:")) {
    const match = attachmentUrl.match(/^data:([^;,]+)?(?:;[^;,=]+=[^;,]+)*;base64,([\s\S]+)$/);
    if (!match) throw new Error("Unsupported attachment encoding.");
    const mimeType = (match[1] || "application/octet-stream").toLowerCase();
    const buffer = Buffer.from(match[2].replace(/\s/g, ""), "base64");
    const ext = ATTACHMENT_EXT_BY_MIME[mimeType] || "bin";
    return { buffer, fileName: `attachment.${ext}`, mimeType };
  }
  if (attachmentUrl.startsWith("nexus-attachment://")) {
    const fileName = attachmentFileName(attachmentUrl);
    if (!fileName) throw new Error("Invalid attachment URL.");
    const filePath = path.join(app.getPath("userData"), "attachments", fileName);
    const buffer = await fs.readFile(filePath);
    return { buffer, fileName, mimeType: attachmentMimeForFileName(fileName) };
  }
  throw new Error("Unsupported attachment URL.");
}

app.whenReady().then(async () => {
  // Set standard Chrome desktop User-Agent to avoid webview blocks
  session.defaultSession.setUserAgent(CHROME_UA);

  // Window control IPC handlers
  ipcMain.handle("window:minimize", () => { mainWindow?.minimize(); });
  ipcMain.handle("window:maximize", () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize();
      return false;
    } else {
      mainWindow?.maximize();
      return true;
    }
  });
  ipcMain.handle("window:close", () => { mainWindow?.close(); });
  ipcMain.handle("window:isMaximized", () => mainWindow?.isMaximized() ?? false);
  ipcMain.handle("command:approval", (_event, payload: { id: string; decision: "once" | "session" | "deny" }) => resolveCommandApproval(payload.id, payload.decision));

  // Two fully separate browser sessions — Home and Code share nothing
  // (cookies, storage, cache, logins). Each mode's visible tabs and the
  // agent's hidden webview for that mode all live in the same partition.
  for (const partition of ["persist:browser-home", "persist:browser-code"]) {
    const browserSession = session.fromPartition(partition);
    browserSession.setUserAgent(CHROME_UA);
    browserSession.webRequest.onHeadersReceived((details, callback) => {
      const responseHeaders = { ...details.responseHeaders };
      delete responseHeaders["x-frame-options"];
      delete responseHeaders["X-Frame-Options"];
      if (responseHeaders["content-security-policy"]) {
        responseHeaders["content-security-policy"] = responseHeaders["content-security-policy"].map((csp) =>
          csp.replace(/frame-ancestors[^;]+;?/gi, "")
        );
      }
      if (responseHeaders["Content-Security-Policy"]) {
        responseHeaders["Content-Security-Policy"] = responseHeaders["Content-Security-Policy"].map((csp) =>
          csp.replace(/frame-ancestors[^;]+;?/gi, "")
        );
      }
      callback({ responseHeaders });
    });
  }

  protocol.handle("nexus-attachment", async (request) => {
    try {
      const fileName = attachmentFileName(request.url);
      if (!fileName) return new Response("Invalid attachment URL.", { status: 400 });
      const filePath = path.join(app.getPath("userData"), "attachments", fileName);
      await fs.access(filePath);
      return net.fetch(`file://${filePath}`);
    } catch {
      // Missing file (stale transcript reference, cleaned folder, …) must
      // render as a broken image — never as an uncaught main-process error.
      return new Response("Attachment not found.", { status: 404 });
    }
  });

  // Home area bootstrap: fixed folder + built-in project (id "home") so
  // general-assistant sessions persist like coding sessions. Best-effort —
  // Home is created lazily by its IPC handlers if this fails.
  try {
    const homeRoot = await ensureHomeDir();
    await ensureHomeProject(HOME_PROJECT_ID, "Home", homeRoot);
  } catch { /* lazy fallback in home:get */ }

  // Notebook recovery: files stuck mid-ingestion reset to `uploaded` and
  // re-queue. Re-running converges by design (stable IDs + replace writes).
  void recoverInterruptedJobs()
    .then((requeued) => {
      if (requeued) console.log(`[notebook] recovered ${requeued} interrupted ingestion job(s).`);
    })
    .catch(() => { /* best effort */ });

  ipcMain.handle("home:get", async () => {
    const homeRoot = await ensureHomeDir();
    const project = await ensureHomeProject(HOME_PROJECT_ID, "Home", homeRoot);
    return { project, root: homeRoot };
  });
  ipcMain.handle("home:files", () => listHomeFiles());
  ipcMain.handle("home:sessionFiles", async (_event, sessionId: string) => {
    const sessions = await listSessions(HOME_PROJECT_ID);
    return listHomeSessionFiles(sessionId, sessions.map((s) => ({ id: s.id, createdAt: s.createdAt })));
  });
  ipcMain.handle("home:readFile", (_event, relativePath: string) => readHomeFile(relativePath));
  ipcMain.handle("home:download", (_event, relativePath: string) => downloadHomeFile(relativePath));
  ipcMain.handle("home:openFolder", () => openHomeFolder());

  // Notebook (NotebookLM-style isolated RAG): each notebook owns its sources,
  // vector index and conversations. Retrieval never crosses notebook boundaries.
  ipcMain.handle("notebook:list", () => listNotebooks());
  ipcMain.handle("notebook:create", (_event, name: string, description?: string) => createNotebook(name, description));
  ipcMain.handle("notebook:rename", (_event, notebookId: string, name: string, description?: string) => renameNotebook(notebookId, name, description));
  ipcMain.handle("notebook:delete", (_event, notebookId: string) => deleteNotebook(notebookId));
  ipcMain.handle("notebook:stats", (_event, notebookId: string) => notebookIndexStats(notebookId));
  ipcMain.handle("notebook:sources", (_event, notebookId: string) => listNotebookSources(notebookId));
  ipcMain.handle("notebook:pickFiles", async (_event, notebookId: string) => {
    const before = new Set((await listNotebookSources(notebookId)).map((s) => s.id));
    const sources = await pickAndImportSourceFiles(notebookId);
    // Upload returns immediately; background jobs do parse → chunk → index.
    for (const source of sources) {
      if (!before.has(source.id) && source.status === "uploaded") enqueueIngest(notebookId, source.id);
    }
    return sources;
  });
  ipcMain.handle("notebook:uploadContent", async (_event, notebookId: string, filename: string, content: string) => {
    const record = await importSourceBuffer(notebookId, filename, Buffer.from(content, "utf8"));
    enqueueIngest(notebookId, record.id);
    return listNotebookSources(notebookId);
  });
  ipcMain.handle("notebook:uploadBase64", async (_event, notebookId: string, filename: string, base64: string) => {
    const record = await importSourceBuffer(notebookId, filename, Buffer.from(base64, "base64"));
    enqueueIngest(notebookId, record.id);
    return listNotebookSources(notebookId);
  });
  ipcMain.handle("notebook:importYouTube", async (_event, notebookId: string, url: string) => {
    const { fetchYouTubeTranscript, youTubeSourceFilename, youTubeTranscriptDocument } = await import("./notebook-youtube.js");
    const transcript = await fetchYouTubeTranscript(url);
    const record = await importSourceBuffer(notebookId, youTubeSourceFilename(transcript.title), Buffer.from(youTubeTranscriptDocument(transcript), "utf8"));
    enqueueIngest(notebookId, record.id);
    return listNotebookSources(notebookId);
  });
  ipcMain.handle("notebook:importWebsite", async (_event, notebookId: string, url: string) => {
    const { crawlWebsite, websiteCrawlDocument, websiteSourceFilename } = await import("./notebook-web.js");
    const crawl = await crawlWebsite(url);
    if (!crawl.pages.some((p) => !p.thin && p.text.trim())) {
      throw new Error("No readable content found — the site may render in JavaScript or block automated fetching.");
    }
    const firstTitle = crawl.pages.find((p) => !p.thin && p.text.trim())?.title || crawl.host;
    const record = await importSourceBuffer(notebookId, websiteSourceFilename(crawl.host, firstTitle), Buffer.from(websiteCrawlDocument(crawl), "utf8"));
    enqueueIngest(notebookId, record.id);
    return listNotebookSources(notebookId);
  });
  ipcMain.handle("notebook:deleteSource", async (_event, notebookId: string, sourceId: string) => deleteNotebookSource(notebookId, sourceId));
  ipcMain.handle("notebook:reindexSource", async (_event, notebookId: string, sourceId: string) => {
    // Retry: wipe the file's derived data and re-enqueue from raw bytes.
    await retrySource(notebookId, sourceId);
    return { sources: await listNotebookSources(notebookId) };
  });
  ipcMain.handle("notebook:reindexAll", async (_event, notebookId: string) => {
    // Embedding-model change recovery: re-embed relational chunks in place.
    const result = await reindexSessionFromLibrary(notebookId);
    return { result, sources: await listNotebookSources(notebookId) };
  });
  ipcMain.handle("notebook:outline", (_event, notebookId: string) => sessionOutline(notebookSessionDir(notebookId), notebookId));
  ipcMain.handle("notebook:digest", (_event, notebookId: string) => readSessionDigest(notebookId));
  ipcMain.handle("notebook:settings:get", (_event, notebookId: string) => getNotebookSettings(notebookId));
  ipcMain.handle("notebook:settings:save", (_event, notebookId: string, instructions: string) => saveNotebookSettings(notebookId, instructions));
  ipcMain.handle("notebook:notes:list", (_event, notebookId: string) => listNotebookNotes(notebookId));
  ipcMain.handle("notebook:notes:save", (_event, input: Parameters<typeof saveNotebookNote>[0]) => saveNotebookNote(input));
  ipcMain.handle("notebook:notes:delete", (_event, notebookId: string, noteId: string) => deleteNotebookNote(notebookId, noteId));
  ipcMain.handle("notebook:documents:list", async (_event, notebookId: string) => {
    const { listNotebookDocuments } = await import("./notebook-documents.js");
    return listNotebookDocuments(notebookId);
  });
  ipcMain.handle("notebook:document:generate", async (_event, payload: { notebookId: string; kind: "report" | "slides"; format: "docx" | "pdf" | "pptx"; prompt?: string; fileIds?: string[]; providerId?: string; model?: string }) => {
    const { generateNotebookDocument } = await import("./notebook-documents.js");
    const notebookSettings = await getNotebookSettings(payload.notebookId);
    const statusKey = `nbdoc:${payload.notebookId}`;
    emitFor(statusKey, { type: "status", text: "Generating document…" });
    const { doc, fallbackReason } = await generateNotebookDocument(payload.notebookId, {
      kind: payload.kind,
      format: payload.format,
      prompt: payload.prompt,
      fileIds: payload.fileIds?.length ? payload.fileIds : undefined,
      providerId: payload.providerId,
      model: payload.model,
      instructions: notebookSettings.instructions,
      onStatus: (text) => emitFor(statusKey, { type: "status", text }),
    });
    emitFor(statusKey, { type: "status", text: `Saved ${doc.filename}` });
    return { doc, fallbackReason };
  });
  ipcMain.handle("notebook:document:delete", async (_event, notebookId: string, docId: string) => {
    const { deleteNotebookDocument } = await import("./notebook-documents.js");
    return deleteNotebookDocument(notebookId, docId);
  });
  ipcMain.handle("notebook:document:download", async (_event, notebookId: string, docId: string) => {
    const { downloadNotebookDocument } = await import("./notebook-documents.js");
    return downloadNotebookDocument(notebookId, docId);
  });
  ipcMain.handle("notebook:document:read", async (_event, notebookId: string, docId: string) => {
    const { readNotebookDocument } = await import("./notebook-documents.js");
    return readNotebookDocument(notebookId, docId);
  });
  ipcMain.handle("notebook:quizzes:list", async (_event, notebookId: string) => {
    const { listNotebookQuizzes } = await import("./notebook-quiz.js");
    return listNotebookQuizzes(notebookId);
  });
  ipcMain.handle("notebook:quiz:generate", async (_event, payload: { notebookId: string; topic?: string; count?: number; quizType?: "mcq" | "truefalse" | "mixed"; fileIds?: string[]; providerId?: string; model?: string }) => {
    const { generateNotebookQuiz } = await import("./notebook-quiz.js");
    const notebookSettings = await getNotebookSettings(payload.notebookId);
    const statusKey = `nbquiz:${payload.notebookId}`;
    emitFor(statusKey, { type: "status", text: "Generating quiz…" });
    const quiz = await generateNotebookQuiz(payload.notebookId, {
      topic: payload.topic,
      count: payload.count,
      quizType: payload.quizType,
      fileIds: payload.fileIds?.length ? payload.fileIds : undefined,
      providerId: payload.providerId,
      model: payload.model,
      instructions: notebookSettings.instructions,
      onStatus: (text) => emitFor(statusKey, { type: "status", text }),
    });
    emitFor(statusKey, { type: "status", text: `Saved ${quiz.title}` });
    return { quiz };
  });
  ipcMain.handle("notebook:quiz:delete", async (_event, notebookId: string, quizId: string) => {
    const { deleteNotebookQuiz } = await import("./notebook-quiz.js");
    return deleteNotebookQuiz(notebookId, quizId);
  });
  ipcMain.handle("notebook:flashcards:list", async (_event, notebookId: string) => {
    const { listNotebookFlashcardSets } = await import("./notebook-flashcards.js");
    return listNotebookFlashcardSets(notebookId);
  });
  ipcMain.handle("notebook:flashcards:generate", async (_event, payload: { notebookId: string; topic?: string; count?: number; fileIds?: string[]; providerId?: string; model?: string }) => {
    const { generateNotebookFlashcards } = await import("./notebook-flashcards.js");
    const notebookSettings = await getNotebookSettings(payload.notebookId);
    const statusKey = `nbfiches:${payload.notebookId}`;
    emitFor(statusKey, { type: "status", text: "Generating flashcards…" });
    const set = await generateNotebookFlashcards(payload.notebookId, {
      topic: payload.topic,
      count: payload.count,
      fileIds: payload.fileIds?.length ? payload.fileIds : undefined,
      providerId: payload.providerId,
      model: payload.model,
      instructions: notebookSettings.instructions,
      onStatus: (text) => emitFor(statusKey, { type: "status", text }),
    });
    emitFor(statusKey, { type: "status", text: `Saved ${set.title}` });
    return { set };
  });
  ipcMain.handle("notebook:flashcards:delete", async (_event, notebookId: string, setId: string) => {
    const { deleteNotebookFlashcardSet } = await import("./notebook-flashcards.js");
    return deleteNotebookFlashcardSet(notebookId, setId);
  });
  ipcMain.handle("notebook:mindmaps:list", async (_event, notebookId: string) => {
    const { listNotebookMindmaps } = await import("./notebook-mindmaps.js");
    return listNotebookMindmaps(notebookId);
  });
  ipcMain.handle("notebook:mindmaps:generate", async (_event, payload: { notebookId: string; topic?: string; maxNodes?: number; fileIds?: string[]; providerId?: string; model?: string }) => {
    const { generateNotebookMindmap } = await import("./notebook-mindmaps.js");
    const notebookSettings = await getNotebookSettings(payload.notebookId);
    const statusKey = `nbmap:${payload.notebookId}`;
    emitFor(statusKey, { type: "status", text: "Generating mind map…" });
    const map = await generateNotebookMindmap(payload.notebookId, {
      topic: payload.topic,
      maxNodes: payload.maxNodes,
      fileIds: payload.fileIds?.length ? payload.fileIds : undefined,
      providerId: payload.providerId,
      model: payload.model,
      instructions: notebookSettings.instructions,
      onStatus: (text) => emitFor(statusKey, { type: "status", text }),
    });
    emitFor(statusKey, { type: "status", text: `Saved ${map.title}` });
    return { map };
  });
  ipcMain.handle("notebook:mindmaps:delete", async (_event, notebookId: string, mapId: string) => {
    const { deleteNotebookMindmap } = await import("./notebook-mindmaps.js");
    return deleteNotebookMindmap(notebookId, mapId);
  });
  ipcMain.handle("notebook:summaries:list", async (_event, notebookId: string) => {
    const { listNotebookSummaries } = await import("./notebook-summaries.js");
    return listNotebookSummaries(notebookId);
  });
  ipcMain.handle("notebook:summaries:generate", async (_event, payload: { notebookId: string; topic?: string; length?: "brief" | "standard" | "detailed"; fileIds?: string[]; providerId?: string; model?: string }) => {
    const { generateNotebookSummary } = await import("./notebook-summaries.js");
    const notebookSettings = await getNotebookSettings(payload.notebookId);
    const statusKey = `nbsum:${payload.notebookId}`;
    emitFor(statusKey, { type: "status", text: "Generating summary…" });
    const summary = await generateNotebookSummary(payload.notebookId, {
      topic: payload.topic,
      length: payload.length,
      fileIds: payload.fileIds?.length ? payload.fileIds : undefined,
      providerId: payload.providerId,
      model: payload.model,
      instructions: notebookSettings.instructions,
      onStatus: (text) => emitFor(statusKey, { type: "status", text }),
    });
    emitFor(statusKey, { type: "status", text: `Saved ${summary.title}` });
    return { summary };
  });
  ipcMain.handle("notebook:summaries:delete", async (_event, notebookId: string, summaryId: string) => {
    const { deleteNotebookSummary } = await import("./notebook-summaries.js");
    return deleteNotebookSummary(notebookId, summaryId);
  });
  ipcMain.handle("notebook:passage", (_event, notebookId: string, chunkId: string) => getChunkPassage(notebookId, chunkId));
  ipcMain.handle("notebook:chats", (_event, notebookId: string) => listNotebookChats(notebookId));
  ipcMain.handle("notebook:createChat", (_event, notebookId: string, title?: string) => createNotebookChat(notebookId, title));
  ipcMain.handle("notebook:deleteChat", (_event, notebookId: string, chatId: string) => deleteNotebookChat(notebookId, chatId));
  ipcMain.handle("notebook:retrieve", (_event, notebookId: string, query: string, topK?: number, fileIds?: string[]) => hybridRetrieve(notebookId, query, topK || 8, fileIds));
  ipcMain.handle("notebook:ask", async (_event, payload: { notebookId: string; chatId: string; question: string; fileIds?: string[]; providerId?: string; model?: string; topK?: number }) => {
    const started = Date.now();
    // Persist the user turn FIRST: a crash mid-answer must not lose it.
    await appendNotebookMessage(payload.notebookId, payload.chatId, {
      role: "user",
      text: payload.question,
      createdAt: new Date().toISOString(),
    });
    emitFor(payload.chatId, { type: "status", text: "Searching notebook sources…" });
    const history = (await recentChatHistory(payload.notebookId, payload.chatId))
      .slice(0, -1)
      .map((m) => ({ role: m.role as "user" | "assistant", text: m.text }));
    const notebookSettings = await getNotebookSettings(payload.notebookId);
    const appSettings = await getAppSettings();
    beginCommandRun(payload.chatId);
    try {
      const result = await answerNotebookQuestion(payload.notebookId, payload.question, history, {
        fileIds: payload.fileIds?.length ? payload.fileIds : undefined,
        chatProviderId: payload.providerId,
        chatModel: payload.model,
        topK: payload.topK || 8,
        instructions: notebookSettings.instructions,
        rerank: appSettings.notebookRerankEnabled ? {
          enabled: true,
          providerId: appSettings.notebookRerankProviderId,
          model: appSettings.notebookRerankModel,
        } : undefined,
        runId: payload.chatId,
        isCancelled: () => isCommandRunCancelled(payload.chatId),
        onStatus: (text) => emitFor(payload.chatId, { type: "status", text }),
        onToken: (delta) => emitFor(payload.chatId, { type: "token", text: delta }),
        onTool: (name, summary, detail) => emitFor(payload.chatId, { type: "tool", text: summary || name, detail }),
      });
      const chat = await appendNotebookMessage(payload.notebookId, payload.chatId, {
        role: "assistant",
        text: result.answer,
        createdAt: new Date().toISOString(),
        citations: result.sources,
        retrieval: result.retrieval,
        metadata: result.metadata,
        steps: result.steps,
        evaluation: result.evaluation,
      });
      const summary = result.metadata.refused
        ? "not covered in your files — refused rather than guessed"
        : `answered from ${result.sources.length} passage${result.sources.length === 1 ? "" : "s"} in ${((Date.now() - started) / 1000).toFixed(1)}s`;
      emitFor(payload.chatId, { type: "status", text: summary });
      return { result, chat };
    } catch (error) {
      if (error instanceof RunCancelledError || isCommandRunCancelled(payload.chatId)) {
        const chat = await appendNotebookMessage(payload.notebookId, payload.chatId, {
          role: "assistant",
          text: "Run cancelled by user.",
          createdAt: new Date().toISOString(),
        });
        emitFor(payload.chatId, { type: "status", text: "Run cancelled." });
        return {
          result: {
            answer: "Run cancelled by user.",
            sources: [],
            retrieval: [],
            metadata: { routing: "retrieve", topScore: 0, refused: false, fallbackModel: false },
            embeddingModel: "",
            dims: 0,
          },
          chat,
        };
      }
      throw error;
    } finally {
      endCommandRun(payload.chatId);
    }
  });
  ipcMain.handle("notebook:embedding:get", () => getNotebookEmbeddingConfig());
  ipcMain.handle("notebook:embedding:save", (_event, config: { providerId: string; model: string }) => saveNotebookEmbeddingConfig(config));
  ipcMain.handle("notebook:embedding-providers:list", async () => (await listEmbeddingProviders()).map((p) => ({ ...p, apiKey: p.apiKey ? "********" : "" })));
  ipcMain.handle("notebook:embedding-provider:save", async (_event, input: Omit<EmbeddingProviderConfig, "id"> & { id?: string }) => {
    const existing = input.id ? (await listEmbeddingProviders()).find((p) => p.id === input.id) : undefined;
    const payload = { ...input, apiKey: input.apiKey === "********" ? existing?.apiKey || "" : input.apiKey };
    return (await upsertEmbeddingProvider(payload)).map((p) => ({ ...p, apiKey: p.apiKey ? "********" : "" }));
  });
  ipcMain.handle("notebook:embedding-provider:remove", async (_event, providerId: string) => (await removeEmbeddingProvider(providerId)).map((p) => ({ ...p, apiKey: p.apiKey ? "********" : "" })));
  ipcMain.handle("notebook:embedding-provider:test", async (_event, input: EmbeddingEndpoint & { model: string; id?: string }) => {
    let apiKey = input.apiKey || "";
    // Saved providers come back with a masked key — resolve the real one so
    // testing an existing entry doesn't authenticate with "********".
    if (apiKey === "********" && input.id) {
      apiKey = (await listEmbeddingProviders()).find((p) => p.id === input.id)?.apiKey || "";
    }
    return testEmbeddingEndpoint({ ...input, apiKey });
  });

  ipcMain.handle("projects:list", () => listProjects());
  ipcMain.handle("project:select", async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    if (result.canceled || !result.filePaths[0]) return null;
    const root = result.filePaths[0];
    const project = await upsertProject({ name: path.basename(root), root });
    activeProjectId = project.id; activeProjectRoot = project.root;
    // Every project must be undo-capable: init git when missing (best-effort).
    try { await ensureGitRepo(root); } catch { /* non-git projects simply lose Undo */ }
    const sessions = await listSessions(project.id);
    const session = sessions[0] || await createSession(project.id);
    activeSessionId = session.id;
    return { project, session };
  });
  ipcMain.handle("project:create", async (_event, input: { name: string; root: string }) => {
    const project = await upsertProject(input); activeProjectId = project.id; activeProjectRoot = project.root;
    try { await ensureGitRepo(input.root); } catch { /* best effort */ }
    const session = (await listSessions(project.id))[0] || await createSession(project.id);
    activeSessionId = session.id; return { project, session };
  });
  ipcMain.handle("project:activate", async (_event, projectId: string) => {
    const project = await getProject(projectId); if (!project) throw new Error("Project not found.");
    activeProjectId = project.id; activeProjectRoot = project.root; const session = project.sessions[0] || await createSession(project.id); activeSessionId = session.id;
    try { await ensureGitRepo(project.root); } catch { /* best effort */ }
    return { project, session };
  });
  ipcMain.handle("project:get-active", async () => activeProjectId ? { project: await getProject(activeProjectId), session: activeSessionId ? await getSession(activeProjectId, activeSessionId) : null } : null);
  ipcMain.handle("project:delete", async (_event, projectId: string) => {
    await deleteProject(projectId);
    if (projectId === activeProjectId) { activeProjectId = null; activeSessionId = null; activeProjectRoot = null; }
    return listProjects();
  });

  ipcMain.handle("sessions:list", (_event, projectId: string) => listSessions(projectId));
  ipcMain.handle("session:create", async (_event, projectId: string, title?: string) => {
    const session = await createSession(projectId, title);
    activeProjectId = projectId; activeSessionId = session.id;
    const project = await getProject(projectId);
    activeProjectRoot = project?.root || null;
    return session;
  });
  ipcMain.handle("session:activate", async (_event, projectId: string, sessionId: string) => {
    const session = await getSession(projectId, sessionId); if (!session) throw new Error("Session not found.");
    const project = await getProject(projectId);
    activeProjectId = projectId; activeSessionId = sessionId; activeProjectRoot = project?.root || null;
    return session;
  });
  ipcMain.handle("session:update", (_event, projectId: string, sessionId: string, patch: Parameters<typeof updateSession>[2]) => updateSession(projectId, sessionId, patch));
  ipcMain.handle("session:delete", async (_event, projectId: string, sessionId: string, options?: { deleteFiles?: boolean }) => {
    const project = await getProject(projectId);
    const root = project?.root || activeProjectRoot;
    // Home deliverables live in the Nexus folder and are only attributed to a
    // session by timestamp heuristic — remove them only with explicit consent,
    // and only files actually created after the session started (pre-existing
    // files that merely surfaced under it are kept).
    if (projectId === HOME_PROJECT_ID && options?.deleteFiles && root) {
      try {
        const sessions = await listSessions(projectId);
        const target = sessions.find((s) => s.id === sessionId);
        const created = target ? new Date(target.createdAt).getTime() : NaN;
        const owned = await listHomeSessionFiles(sessionId, sessions.map((s) => ({ id: s.id, createdAt: s.createdAt })));
        for (const file of owned) {
          const mtime = new Date(file.modified).getTime();
          if (!Number.isNaN(created) && (!Number.isNaN(mtime) && mtime < created - 60_000)) continue;
          const abs = path.resolve(root, file.path);
          if (abs === root || !abs.startsWith(`${root}${path.sep}`)) continue;
          try {
            await fs.rm(abs, { force: true });
          } catch { /* one bad file never fails the delete */ }
        }
      } catch { /* file cleanup is best-effort */ }
    }
    const updated = await deleteSession(projectId, sessionId);
    if (root) {
      await discardSessionWorktree(root, sessionId);
      await deleteSessionTelemetry(root, sessionId);
    }
    clearLastRunCheckpoint(sessionId);
    if (sessionId === activeSessionId) {
      const next = updated.sessions[0] || await createSession(projectId);
      activeSessionId = next.id;
    }
    return updated;
  });

  ipcMain.handle("memory:project:update", (_event, projectId: string, memory: string) => updateProjectMemory(projectId, memory));
  ipcMain.handle("memory:session:update", (_event, projectId: string, sessionId: string, memory: string) => updateSession(projectId, sessionId, { memory }));

  ipcMain.handle("providers:definitions", () => PROVIDERS);
  ipcMain.handle("providers:list", async () => (await listProviders()).map((provider) => ({ ...provider, apiKey: provider.apiKey ? "********" : "" })));
  ipcMain.handle("provider:save", async (_event, input: Omit<ProviderConfig, "id"> & { id?: string }) => {
    const existing = input.id ? (await listProviders()).find((provider) => provider.id === input.id) : undefined;
    const payload = { ...input, apiKey: input.apiKey === "********" ? existing?.apiKey || "" : input.apiKey };
    return (await upsertProvider(payload)).map((provider) => ({ ...provider, apiKey: provider.apiKey ? "********" : "" }));
  });
  ipcMain.handle("provider:remove", async (_event, providerId: string) => (await removeProvider(providerId)).map((provider) => ({ ...provider, apiKey: provider.apiKey ? "********" : "" })));
  ipcMain.handle("providers:fetch-models", async (_event, input: { baseUrl?: string; apiKey?: string }) => fetchRemoteModels(input?.baseUrl || "", input?.apiKey));

  ipcMain.handle("mcp:list", () => listMcpServers());
  ipcMain.handle("mcp:save", (_event, input: Omit<McpServerConfig, "id"> & { id?: string }) => upsertMcpServer(input));
  ipcMain.handle("mcp:remove", (_event, serverId: string) => removeMcpServer(serverId));
  ipcMain.handle("mcp:test", (_event, input: Omit<McpServerConfig, "id" | "enabled">) => testMcpServer(input));

  ipcMain.handle("skills:config:get", () => getSkillsConfig());
  ipcMain.handle("skills:config:save", (_event, config: { enabled: boolean }) => saveSkillsConfig(config));
  ipcMain.handle("skills:list", async () => {
    await ensureSkillSourceDirs(activeProjectRoot);
    return listAllSkills(activeProjectRoot);
  });
  ipcMain.handle("skills:read", async (_event, skillPath: string) => readSkillContent(skillPath, activeProjectRoot));
  ipcMain.handle("skills:pick-file", async () => {
    const result = await dialog.showOpenDialog({ properties: ["openFile", "multiSelections"], filters: [{ name: "Skill file", extensions: ["md", "zip"] }] });
    return result.canceled ? [] : result.filePaths;
  });
  ipcMain.handle("skills:pick-folder", async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory", "multiSelections"] });
    return result.canceled ? [] : result.filePaths;
  });
  ipcMain.handle("skills:import", async (_event, input: { sourcePath: string; scope: "global" | "project" }) => {
    const root = input.scope === "project" ? requireRoot() : (activeProjectRoot || "");
    return importSkill(root, input.sourcePath, input.scope);
  });
  ipcMain.handle("skills:create", async (_event, input: { name: string; description?: string; scope: "global" | "project"; content?: string; modes?: string[] }) => {
    const root = input.scope === "project" ? requireRoot() : (activeProjectRoot || "");
    return createSkill(root, input);
  });
  ipcMain.handle("skills:delete", async (_event, skillPath: string) => deleteSkill(skillPath, activeProjectRoot));
  ipcMain.handle("skills:set-modes", async (_event, input: { skillPath: string; modes: string[] }) => setSkillModes(input.skillPath, input.modes, activeProjectRoot));
  ipcMain.handle("skills:open-folder", async (_event, scope: "global" | "project") => {
    const root = scope === "project" ? requireRoot() : (activeProjectRoot || "");
    return openSkillsFolder(scope, root);
  });

  ipcMain.handle("settings:get", () => ({ ...settings, apiKey: settings.apiKey ? "********" : "" }));
  ipcMain.handle("settings:save", (_event, next: AgentSettings) => {
    settings = { ...settings, ...next };
    if (next.apiKey === "********") delete settings.apiKey;
    return { ...settings, apiKey: settings.apiKey ? "********" : "" };
  });
  ipcMain.handle("app-settings:get", () => getAppSettings());
  ipcMain.handle("app-settings:save", (_event, input: Parameters<typeof saveAppSettings>[0]) => saveAppSettings(input));
  ipcMain.handle("notebook:parser:get", async () => {
    const config = await getNotebookParserConfig();
    return { ...config, apiKey: config.apiKey ? "********" : "" };
  });
  ipcMain.handle("notebook:parser:save", async (_event, input: Parameters<typeof saveNotebookParserConfig>[0]) => {
    const existing = await getNotebookParserConfig();
    const config = await saveNotebookParserConfig({ ...input, apiKey: input.apiKey === "********" ? existing.apiKey : input.apiKey });
    return { ...config, apiKey: config.apiKey ? "********" : "" };
  });

  ipcMain.handle("workspace:list", () => listWorkspaceFiles(requireRoot()));
  ipcMain.handle("workspace:read", (_event, file: string) => readWorkspaceFile(requireRoot(), file));
  ipcMain.handle("workspace:readHead", async (_event, file: string) => {
    const root = requireRoot();
    const wt = activeSessionId ? await getSessionWorktree(root, activeSessionId) : null;
    const targetRoot = wt?.worktreePath || root;
    const normalized = file.replace(/\\/g, "/").replace(/^\.\//, "");
    try {
      const { stdout } = await execFileAsync("git", ["show", `HEAD:${normalized}`], { cwd: targetRoot, maxBuffer: 4_000_000 });
      return stdout;
    } catch {
      return "";
    }
  });
  ipcMain.handle("attachments:save", async (_event, payload: { data: string; filename?: string }) => {
    const attachmentsDir = path.join(app.getPath("userData"), "attachments");
    await fs.mkdir(attachmentsDir, { recursive: true });

    // Accept any data URL (images, PDFs, Office docs, TeX, …), not just
    // images. Extension prefers the original filename so .docx stays .docx
    // (mime sniffing alone can't distinguish Office containers); the data-URL
    // mime is the fallback. The hash covers raw bytes so identical uploads
    // dedupe to one file.
    let base64Data = payload.data;
    let mimeType = "application/octet-stream";
    const match = payload.data.match(/^data:([^;,]+)?(?:;[^;,=]+=[^;,]+)*;base64,([\s\S]+)$/);
    if (match) {
      mimeType = (match[1] || "application/octet-stream").toLowerCase();
      base64Data = match[2].replace(/\s/g, "");
    }
    const originalExt = (payload.filename?.split(".").pop() || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
    const mimeExt = ATTACHMENT_EXT_BY_MIME[mimeType];
    // Trust a sane filename extension first (docx/xlsx/pptx/tex/…); fall back
    // to the mime-derived one; never trust exotic suffixes on disk.
    const ext = /^[a-z0-9]{1,10}$/.test(originalExt) && originalExt !== "bin"
      ? originalExt === "jpeg" ? "jpg" : originalExt
      : mimeExt || "bin";
    const buffer = Buffer.from(base64Data, "base64");
    if (!buffer.length) throw new Error("Attachment is empty.");
    if (buffer.length > 25 * 1024 * 1024) throw new Error("Attachment is larger than 25 MB.");
    const hash = crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 16);
    const safeBase = (payload.filename || "attachment").split(/[\\/]/).pop()!.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 60) || "attachment";
    const fileName = `${hash}-${safeBase.includes(".") ? safeBase : `${safeBase}.${ext}`}`;
    const normalizedName = fileName.toLowerCase().endsWith(`.${ext}`) ? fileName : `${fileName}.${ext}`;
    const filePath = path.join(attachmentsDir, normalizedName);
    await fs.writeFile(filePath, buffer);
    return { fileName: normalizedName, filePath, url: `nexus-attachment://${normalizedName}`, mimeType };
  });
  // Raw bytes for previewing an attachment in-app (same IPC pattern as
  // home:readFile for generated artifacts — never depends on custom-scheme
  // fetch from the renderer, which images don't need but documents do).
  ipcMain.handle("attachments:read", async (_event, attachmentUrl: string) => {
    const { buffer, fileName, mimeType } = await resolveAttachmentBytes(String(attachmentUrl || ""));
    return { base64: buffer.toString("base64"), fileName, mimeType, size: buffer.length };
  });
  ipcMain.handle("workspace:write", (_event, file: string, content: string) => writeWorkspaceFile(requireRoot(), file, content));
  ipcMain.handle("workspace:diff", async () => {
    const root = requireRoot();
    const wt = activeSessionId ? await getSessionWorktree(root, activeSessionId) : null;
    return getWorkspaceDiffFiles(wt?.worktreePath || root);
  });
  ipcMain.handle("workspace:git", () => getWorkspaceGit(requireRoot()));
  ipcMain.handle("workspace:command", async (_event, command: string) => {
    const project = activeProjectId ? await getProject(activeProjectId) : null;
    if (!project) throw new Error("Active project not found.");
    const result = await runProjectCommand(project, command);
    return result.output || "Command completed successfully.";
  });

  ipcMain.handle("workspace:revert-file", async (_event, file: string) => {
    const root = requireRoot();
    const wt = activeSessionId ? await getSessionWorktree(root, activeSessionId) : null;
    return revertWorkspaceFile(wt?.worktreePath || root, file);
  });
  ipcMain.handle("workspace:revert-all", async () => {
    const root = requireRoot();
    const wt = activeSessionId ? await getSessionWorktree(root, activeSessionId) : null;
    return revertAllWorkspaceChanges(wt?.worktreePath || root);
  });
  ipcMain.handle("checkpoint:restore", async (_event, checkpointId: string) => {
    const root = requireRoot();
    const wt = activeSessionId ? await getSessionWorktree(root, activeSessionId) : null;
    const ok = await restoreWorkspaceCheckpoint(wt?.worktreePath || root, checkpointId);
    // Multi-level Undo: popping here keeps checkpointId/checkpointIds in sync
    // so each click steps one run further back without renderer bookkeeping.
    try {
      if (activeProjectId && activeSessionId) await popCheckpoint(activeProjectId, activeSessionId, wt?.worktreePath || root, checkpointId);
    } catch { /* restore already succeeded */ }
    return ok;
  });
  ipcMain.handle("checkpoint:clear", async () => {
    const root = requireRoot();
    if (!activeProjectId || !activeSessionId) return false;
    const wt = activeSessionId ? await getSessionWorktree(root, activeSessionId) : null;
    const session = await getSession(activeProjectId, activeSessionId);
    await clearCheckpoint(activeProjectId, activeSessionId, wt?.worktreePath || root, session?.checkpointId);
    return true;
  });
  ipcMain.handle("project:ensure-repo", async () => {
    const root = requireRoot();
    return ensureGitRepo(root);
  });

  // Worktree IPC handlers
  ipcMain.handle("worktree:create", async (_event, sessionId: string) => {
    const root = requireRoot();
    return createSessionWorktree(root, sessionId);
  });
  ipcMain.handle("worktree:status", async (_event, sessionId: string) => {
    const root = requireRoot();
    const wt = await getSessionWorktree(root, sessionId);
    const isGit = await isGitRepo(root);
    return { isGit, worktree: wt };
  });
  ipcMain.handle("worktree:merge", async (_event, sessionId: string, commitMessage?: string) => {
    const root = requireRoot();
    return mergeWorktreeToMain(root, sessionId, commitMessage);
  });
  ipcMain.handle("worktree:discard", async (_event, sessionId: string) => {
    const root = requireRoot();
    return discardSessionWorktree(root, sessionId);
  });
  ipcMain.handle("worktree:diff", async (_event, sessionId: string) => {
    const root = requireRoot();
    return getSessionWorktreeDiff(root, sessionId);
  });

  // Artifacts IPC handlers
  ipcMain.handle("artifacts:list", async (_event, sessionId: string) => {
    const root = requireRoot();
    return listArtifacts(root, sessionId);
  });
  ipcMain.handle("artifacts:get", async (_event, sessionId: string, filename: string) => {
    const root = requireRoot();
    return getArtifact(root, sessionId, filename);
  });
  ipcMain.handle("artifacts:update-status", async (_event, sessionId: string, filename: string, status: ArtifactStatus) => {
    const root = requireRoot();
    return updateArtifactStatus(root, sessionId, filename, status);
  });

  // Trajectory IPC handler
  ipcMain.handle("trajectory:get", async (_event, sessionId: string) => {
    const root = requireRoot();
    return readSessionTrajectory(root, sessionId);
  });

  ipcMain.handle("project:getRules", async (_event, projectId: string) => {
    const project = await getProject(projectId);
    if (!project) return { hasRules: false, ruleFiles: [], combinedPromptSection: "" };
    return await discoverProjectRules(project.root);
  });

  ipcMain.handle("terminal:create", async (_event, { id, cwd, cols, rows }: { id: string; cwd?: string; cols?: number; rows?: number }) => {
    const root = cwd || activeProjectRoot || process.cwd();
    const session = await terminalService.createSession(id, root, (data) => {
      mainWindow?.webContents.send("terminal:data", { id, data });
    }, { cols, rows });
    // The live session holds an onData callback and a ChildProcess handle; both
    // are uncloneable over IPC, so only plain serializable fields cross back.
    return { id: session.id, mode: session.mode, cols: session.cols, rows: session.rows, alive: session.alive };
  });

  ipcMain.handle("terminal:write", (_event, { id, data }: { id: string; data: string }) => {
    return terminalService.write(id, data);
  });

  ipcMain.handle("terminal:kill", (_event, id: string) => {
    return terminalService.killSession(id);
  });

  ipcMain.handle("terminal:resize", (_event, { id, cols, rows }: { id: string; cols?: number; rows?: number }) => {
    return terminalService.resize(id, cols || 80, rows || 24);
  });

  // Custom Slash Commands (optional scope: "home" | "code" | "notebook" — omit for all)
  ipcMain.handle("commands:listCustom", async (_event, scope?: "home" | "code" | "notebook") => {
    return await discoverCustomCommands(activeProjectRoot || undefined, scope);
  });

  // Background Daemons & Services
  ipcMain.handle("daemons:list", () => {
    return daemonService.listDaemons();
  });

  ipcMain.handle("daemons:start", (_event, { name, command, cwd }: { name: string; command: string; cwd?: string }) => {
    const root = cwd || activeProjectRoot || process.cwd();
    const created = daemonService.startDaemon(name, command, root);
    // Stream this service's output under its id (the renderer filters live
    // log lines by selected service id).
    daemonService.subscribeToLogs(created.id, (data) => {
      mainWindow?.webContents.send("daemon:log", { id: created.id, data });
    });
    return created;
  });

  ipcMain.handle("daemons:stop", (_event, id: string) => {
    return daemonService.stopDaemon(id);
  });

  ipcMain.handle("daemons:remove", (_event, id: string) => {
    return daemonService.removeDaemon(id);
  });

  ipcMain.handle("daemons:restart", (_event, id: string) => {
    return daemonService.restartDaemon(id);
  });

  ipcMain.handle("daemons:logs", (_event, id: string) => {
    return daemonService.getDaemonLogs(id);
  });

  // Browser External Navigation
  ipcMain.handle("browser:openExternal", async (_event, url: string) => {
    if (/^https?:\/\//i.test(url)) {
      await shell.openExternal(url);
      return true;
    }
    return false;
  });

  // Agent browser: headless toggle + activity forwarded to the built-in
  // Browser tab so the user can follow what the agent is viewing.
  agentBrowserService.onActivity = (activity) => {
    mainWindow?.webContents.send("browser:agent-activity", activity);
  };
  // Agent browser bridge: tool calls in main execute against the hidden
  // in-app webview (AgentBrowserHost in the renderer) and reply here.
  agentBrowserService.setSender((msg) => {
    mainWindow?.webContents.send("browser:agent-request", msg);
  });
  ipcMain.on("browser:agent-reply", (_event, payload: AgentBrowserResponse) => {
    agentBrowserService.handleReply(payload);
  });
  ipcMain.handle("browser:headless:get", () => agentBrowserService.isHeadless());
  ipcMain.handle("browser:headless:set", (_event, value: boolean) => agentBrowserService.setHeadless(value));

  // In-app updates: renderer gets status events + manual check/install.
  updaterService.onStatus((state: UpdaterState) => {
    mainWindow?.webContents.send("updater:status", state);
  });
  updaterService.init();
  // Lets a (re)loaded renderer pick up the current state — e.g. an update
  // that finished downloading before the UI subscribed — instead of
  // sitting on "idle" with no install button.
  ipcMain.handle("updater:getState", () => updaterService.getState());
  ipcMain.handle("updater:check", () => updaterService.check(false));
  ipcMain.handle("updater:quit-and-install", () => {
    updaterService.quitAndInstall();
    return true;
  });
  ipcMain.handle("app:getVersion", () => app.getVersion());

  // Each run collects its own transcript events so they can be persisted to the
  // session in one batch — tool traces and plans survive an app restart now.
  type RunTranscript = { items: Array<{ role: "event"; text: string; kind: AgentEvent["type"]; createdAt: string; plan?: AgentEvent["items"]; subagent?: AgentEvent["subagent"]; artifact?: AgentEvent["artifact"]; usage?: AgentEvent["usage"]; detail?: string }> };

  ipcMain.handle("agent:run", async (_event, payload: { request: string; images?: string[]; attachments?: Array<{ url: string; name: string; mimeType: string; size: number }>; providerId?: string; model?: string; mode?: string }) => {
    const root = requireRoot();
    if (!activeProjectId || !activeSessionId) throw new Error("Create a session first.");
    if (activeRunSessions.has(activeSessionId)) throw new Error("An agent run is already in progress in this session.");

    const sessionId = activeSessionId;
    const projectId = activeProjectId;
    activeRunSessions.add(sessionId);
    beginCommandRun(sessionId);
    const transcript: RunTranscript = { items: [] };
    // Prelude heartbeat: if the run ever wedges before the agent emits,
    // the UI shows the last reached stage instead of a mystery spinner.
    emitFor(sessionId, { type: "status", text: "Opening session…" });
    try {
      const project = await getProject(projectId);
      const session = await getSession(projectId, sessionId);
      if (!project || !session) throw new Error("Active project/session not found.");

      const mode: AgentMode = payload.mode === "plan" || payload.mode === "auto" ? payload.mode : "ask";
      const configured = payload.providerId ? (await listProviders()).find((provider) => provider.id === payload.providerId) : undefined;
      const provider = configured || (await listProviders())[0];
      const runSettings: AgentSettings = provider ? { provider, model: payload.model || session.model?.model } : { ...settings };

      if (session.title === "New coding task" && payload.request) {
        await updateSession(projectId, sessionId, { title: payload.request.slice(0, 60) });
      }

      // Check if session has an explicit active worktree
      let executionRoot = root;
      if (await isGitRepo(root)) {
        try {
          const wt = await getSessionWorktree(root, sessionId);
          if (wt) executionRoot = wt.worktreePath;
        } catch {
          executionRoot = root;
        }
      }

      const history: HistoryInput[] = (() => {
        // Same-session memory: last user/assistant turns plus recent tool
        // activity (with truncated results) so the run reuses prior reads
        // instead of re-reading the project from scratch every request.
        const recent = session.messages.slice(-80);
        const turns = recent.filter((m) => m.role === "user" || m.role === "assistant").slice(-16);
        const events = recent.filter((m) => m.role === "event").slice(-40);
        const keep = new Set([...turns, ...events]);
        return recent.filter((m) => keep.has(m)).map((message) =>
          message.role === "event"
            ? {
                role: "event" as const,
                text: message.text,
                kind: message.kind,
                detail: message.detail,
                plan: message.plan,
                subagent: message.subagent
                  ? { role: message.subagent.role, task: message.subagent.task, status: message.subagent.status }
                  : undefined,
              }
            : { role: message.role as "user" | "assistant", text: message.text }
        );
      })();

      // Continue-resume: a bare "continue" after an interrupt/stop must pick
      // up the prior run's tool checkpoint, plan and diff — otherwise the
      // model restarts from scratch. The checkpoint cache covers same-process
      // resume; the transcript-derived note covers app restarts.
      const wantResume = isContinueRequest(payload.request || "");
      // Memory first, disk second: checkpoints are mirrored to
      // .nexus/run-checkpoints/ so "continue" survives an app restart.
      const stored = wantResume ? getLastRunCheckpoint(sessionId) ?? await loadLastRunCheckpoint(root, sessionId) : null;
      let resumeNote: string | null = null;
      if (wantResume) {
        const planEvents = session.messages.filter((m) => m.role === "event" && m.kind === "plan" && m.plan?.length);
        const lastPlan = planEvents.length ? planEvents[planEvents.length - 1].plan! : null;
        const errorEvents = session.messages.filter((m) => m.role === "event" && m.kind === "error");
        const lastError = errorEvents.length ? errorEvents[errorEvents.length - 1].text : null;
        const assistants = session.messages.filter((m) => m.role === "assistant");
        const lastAssistant = assistants.length ? assistants[assistants.length - 1].text.slice(-1500) : null;
        let diffSummary = "";
        try {
          const diffs = await getWorkspaceDiffFiles(executionRoot);
          if (diffs.length) diffSummary = `\nFiles already changed:\n${diffs.slice(0, 20).map((d) => `- ${d.path} (+${d.additions}/-${d.deletions})`).join("\n")}`;
        } catch { /* diff is best-effort */ }
        const planSummary = (stored?.planItems ?? lastPlan)?.length
          ? `\nWorking plan status:\n${(stored?.planItems ?? lastPlan)!.map((p) => `- [${p.status === "completed" ? "x" : " "}] ${p.content} (${p.status})`).join("\n")}`
          : "";
        // Explicit done-list: weak models re-do finished steps from prose
        // instructions alone; a concrete ledger survives where they don't.
        const ledger = stored?.messages?.length ? summarizeCompletedSteps(stored.messages) : [];
        const ledgerSummary = ledger.length
          ? `\nSteps already DONE (never repeat — results are in history):\n${ledger.map((s) => `- ${s}`).join("\n")}`
          : "";
        resumeNote = `[System Note: The user asked to continue the previous interrupted run. All preceding tool executions and results ${stored ? `(${stored.messages.length} checkpointed messages) ` : ""}are already complete.${planSummary}${ledgerSummary}${lastError ? `\nLast stop reason: ${lastError.slice(0, 500)}` : ""}${lastAssistant ? `\nLast assistant summary: ${lastAssistant}` : ""}${diffSummary}\n\nIMPORTANT: Do NOT restart from the beginning, do NOT re-create the todo list from scratch, and do NOT repeat completed tool actions or file reads. Proceed directly with the next unfinished step.]`;
      }

      const backendRecord = { ...project, root: executionRoot };
      emitFor(sessionId, { type: "status", text: "Preparing workspace…" });
      const { backend } = await getAgentBackend(backendRecord, { readOnly: mode === "plan", runId: sessionId });
      // Undo-ready baseline: HEAD before the run + file snapshot. Best-effort
      // so non-git projects still run (their Undo simply no-ops).
      let preRunHead: string | null = null;
      try { preRunHead = await getHeadCommit(executionRoot); } catch { preRunHead = null; }
      const checkpointId = `cp_${Date.now().toString(36)}`;
      await createWorkspaceCheckpoint(executionRoot, checkpointId, { headCommit: preRunHead });
      await appendSessionMessages(projectId, sessionId, [{ role: "user", text: payload.request, images: payload.images, attachments: payload.attachments, createdAt: new Date().toISOString() }]);

      // Renderer-only attachment URLs become inline data URLs for the model.
      const modelImages = payload.images?.length
        ? await Promise.all(payload.images.map((img) => resolveImageForModel(img).catch(() => img)))
        : undefined;

      // Document attachments (pdf/docx/xlsx/pptx/tex/…) are extracted to text
      // here so the model actually sees them. Images stay vision-only; text
      // files are decoded inline; Office/PDF go through the notebook parsers.
      // Each file is capped so one giant spreadsheet can't eat the context.
      const ATTACH_DOC_CHAR_CAP = 20_000;
      const attachmentDocs: Array<{ name: string; mimeType: string; text: string; truncated: boolean }> = [];
      if (payload.attachments?.length) {
        const { parseToMarkdown } = await import("./notebook-parse.js");
        for (const attachment of payload.attachments) {
          try {
            const isImage = (attachment.mimeType || "").toLowerCase().startsWith("image/");
            if (isImage) continue;
            const { buffer, fileName, mimeType } = await resolveAttachmentBytes(attachment.url);
            const name = attachment.name || fileName;
            const mime = attachment.mimeType || mimeType;
            // Small text-ish files: decode directly, no parser overhead.
            if (/^(text\/|application\/json|application\/xml)/.test(mime.toLowerCase()) || /\.(txt|tex|md|markdown|csv|tsv|json|yaml|yml|xml|html|htm|log|toml)$/i.test(name)) {
              const text = buffer.toString("utf8").replace(/^\uFEFF/, "").replace(/\u0000/g, "");
              if (!text.trim()) continue;
              const truncated = text.length > ATTACH_DOC_CHAR_CAP;
              attachmentDocs.push({ name, mimeType: mime, text: truncated ? text.slice(0, ATTACH_DOC_CHAR_CAP) : text, truncated });
              continue;
            }
            try {
              const parsed = await parseToMarkdown(buffer, name);
              if (!parsed.markdown.trim()) continue;
              const truncated = parsed.markdown.length > ATTACH_DOC_CHAR_CAP || parsed.truncated;
              attachmentDocs.push({ name, mimeType: mime, text: parsed.markdown.slice(0, ATTACH_DOC_CHAR_CAP), truncated });
            } catch {
              // Unparseable binary (legacy .doc/.ppt/.xls, …): still tell the
              // model the file exists so it can ask for another format.
              attachmentDocs.push({ name, mimeType: mime, text: `[Binary file ${name} could not be text-extracted in-app. Ask the user for a .docx/.xlsx/.pptx/.pdf/.txt export if its contents are needed.]`, truncated: false });
            }
          } catch {
            // One bad attachment must never fail the whole run.
          }
        }
      }
      // Import tool needs the raw bytes for every attachment (images + docs)
      // so the agent can materialize them in the project on request.
      const importableAttachments: string[] = [];
      if (payload.attachments?.length) {
        for (const attachment of payload.attachments) {
          try {
            const { buffer, mimeType } = await resolveAttachmentBytes(attachment.url);
            const mime = attachment.mimeType || mimeType;
            importableAttachments.push(`data:${mime};base64,${buffer.toString("base64")}#${encodeURIComponent(attachment.name || "attachment")}`);
          } catch { /* skip unreadable */ }
        }
      } else if (modelImages?.length) {
        importableAttachments.push(...modelImages);
      }

      // Home sessions run the general assistant: same tool loop, but no
      // code-project verification and a Home-oriented system prompt.
      const isHomeRun = project.id === HOME_PROJECT_ID;
      const runStartMs = Date.now();
      let result: Awaited<ReturnType<typeof runProjectAgent>>;
      try {
        result = await runProjectAgent({
          projectRoot: executionRoot,
          telemetryRoot: root,
          taskKind: isHomeRun ? "general" : "code",
          skillsMode: isHomeRun ? "home" : "code",
          sessionId,
          request: payload.request,
          images: modelImages,
          attachments: modelImages,
          attachmentDocs,
          importableAttachments: importableAttachments.length ? importableAttachments : undefined,
          settings: runSettings,
          memory: { projectMemory: project.memory, sessionMemory: session.memory },
          history,
          mode,
          agentBackend: backend,
          resumeMessages: stored?.messages ?? null,
          resumePlanItems: stored?.planItems ?? null,
          resumeNote,
          onEvent: (event) => {
            // Token chunks stay ephemeral (streaming display only); everything
            // else is captured for the persisted transcript.
            if (event.type !== "token") {
              transcript.items.push({
                role: "event",
                text: event.text,
                kind: event.type,
                createdAt: event.timestamp,
                plan: event.items,
                subagent: event.subagent,
                artifact: event.artifact,
                usage: event.type === "usage" ? undefined : event.usage,
                detail: event.detail,
              });
            }
            emit(event);
          },
          isCancelled: () => isCommandRunCancelled(sessionId),
        });
      } catch (error) {
        const errorText = error instanceof Error ? error.message : String(error);
        // Failed runs leave a persistent error entry so the transcript tells
        // the truth after a reload, not just in the live view.
        await appendSessionMessages(projectId, sessionId, [
          ...transcript.items,
          { role: "event", kind: "error", text: `Agent run failed: ${errorText}`, createdAt: new Date().toISOString() },
        ]);
        emitFor(sessionId, { type: "error", text: `Agent run failed: ${errorText}` });
        if (error instanceof RunCancelledError) return "Run cancelled by user.";
        throw error;
      }

      await appendSessionMessages(projectId, sessionId, [
        ...transcript.items,
        { role: "assistant", text: result.response, createdAt: new Date().toISOString(), usage: result.usage },
      ]);
      // Home safety net: if the agent left its throwaway generator script
      // behind (e.g. generate_report.py next to report.docx), remove it so
      // only the requested deliverable(s) remain. Recorded in-transcript.
      if (isHomeRun) {
        try {
          const deleted = await cleanupHomeGeneratorScripts(runStartMs, payload.request || "");
          if (deleted.length) {
            await appendSessionMessages(projectId, sessionId, [
              { role: "event", kind: "tool", text: `Cleaned up generator script${deleted.length === 1 ? "" : "s"}: ${deleted.join(", ")}`, createdAt: new Date().toISOString() },
            ]);
          }
        } catch { /* best effort — deliverable already exists */ }
      }
      // Worktree-scoped auto-commit: isolated session branches get a durable
      // per-task commit (undo resets it); the user's main branch is never
      // auto-committed. Best-effort — a commit failure never fails the run.
      if (!isHomeRun && mode !== "plan") {
        try {
          const wt = await getSessionWorktree(root, sessionId).catch(() => null);
          if (wt && path.resolve(executionRoot) === path.resolve(wt.worktreePath)) {
            const shortRequest = (payload.request || "agent task").replace(/\s+/g, " ").slice(0, 80);
            const newHead = await commitSessionWork(executionRoot, `nexus(session-${sessionId}): ${shortRequest}`);
            if (newHead && newHead !== preRunHead) {
              transcript.items.push({
                role: "event",
                text: `Auto-committed session work (${newHead.slice(0, 7)}) — Undo restores files and rolls back Nexus-only commits.`,
                kind: "tool",
                createdAt: new Date().toISOString(),
              });
            }
          }
        } catch { /* best effort */ }
      }
      // Multi-level Undo: push (never clear) so each click steps one run back.
      await pushCheckpoint(projectId, sessionId, executionRoot, checkpointId);
      // Memories are rolling windows, not append-only logs: entries are
      // individually capped upstream, and the totals are capped here so
      // hundreds of runs cannot bloat every future prompt.
      const nextSessionMemory = [session.memory, result.memoryEntry].filter(Boolean).join("\n\n");
      const nextProjectMemory = [project.memory, result.projectMemoryLogEntry].filter(Boolean).join("\n");
      // pushCheckpoint already updated the stack; only memory remains here.
      await updateSession(projectId, sessionId, {
        memory: nextSessionMemory.slice(-4000),
      });
      // Keep the memory log bounded; agent-service returns a capped entry.
      await updateProjectMemory(projectId, nextProjectMemory.slice(-2000));
      return result.response;
    } finally {
      activeRunSessions.delete(sessionId);
      endCommandRun(sessionId);
    }
  });

  ipcMain.handle("agent:cancel", (_event, sessionId?: string) => { cancelCommandRun(sessionId); cancelCommandApprovals(sessionId); return true; });

  createWindow();
  // Silent startup update check (packaged builds only — dev runs report
  // up-to-date locally). Delayed so it never slows down launch.
  if (app.isPackaged) {
    setTimeout(() => {
      void updaterService.check(true).catch(() => {});
    }, 15000);
  }
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("before-quit", () => {
  void daemonService.stopAllDaemons().catch(() => {});
  terminalService.killAll();
  agentBrowserService.destroy();
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
