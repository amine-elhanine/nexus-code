// Electron main process: app lifecycle, window/security setup, service
// bootstrap, and IPC route registration. All per-domain handlers live in
// ./ipc/*-routes modules (see ipc/context.ts for the shared contract they
// receive). IPC channel names and payloads are unchanged from the previous
// monolithic registration and are exercised by test/renderer-security and
// test/ipc-adversarial.

import { app, BrowserWindow, ipcMain, shell, session, protocol, net } from "electron";
import path from "node:path";
import { existsSync, promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { setApprovalNotifier } from "./approval-service.js";
import { onNotebookJobProgress, recoverInterruptedJobs } from "./notebook-jobs.js";
import { terminalService } from "./terminal-service.js";
import { daemonService } from "./daemon-service.js";
import { agentBrowserService } from "./browser-service.js";
import { updaterService } from "./updater-service.js";
import { ensureHomeDir } from "./home-service.js";
import { attachmentFileName } from "./attachment-utils.js";
import { ensureBuiltinToolCatalog } from "./agent/builtin-tool-catalog.js";
import type { AgentEvent, AgentSettings } from "./agent-service.js";
import type { MainIpcContext } from "./ipc/context.js";
import { registerWindowRoutes } from "./ipc/window-routes.js";
import { registerUserQuestionRoutes } from "./ipc/user-questions.js";
import { registerHomeRoutes } from "./ipc/home-routes.js";
import { registerHomeRunRoutes } from "./ipc/home-run-routes.js";
import { registerNotebookRoutes } from "./ipc/notebook-routes.js";
import { registerProjectRoutes, registerProjectExtraRoutes } from "./ipc/project-routes.js";
import { registerProviderRoutes } from "./ipc/provider-routes.js";
import { registerSkillsRoutes } from "./ipc/skills-routes.js";
import { registerPluginRoutes } from "./ipc/plugin-routes.js";
import { registerSettingsRoutes } from "./ipc/settings-routes.js";
import { registerWorkspaceRoutes } from "./ipc/workspace-routes.js";
import { registerTerminalRoutes } from "./ipc/terminal-routes.js";
import { registerBrowserRoutes } from "./ipc/browser-routes.js";
import { registerAgentRoutes } from "./ipc/agent-routes.js";

protocol.registerSchemesAsPrivileged([
  { scheme: "nexus-attachment", privileges: { standard: true, secure: true, supportFetchAPI: true } }
]);

// Prevent ERR_HTTP2_PROTOCOL_ERROR across webviews for sites with broken HTTP/2 framing/LiteSpeed/Cloudflare
app.commandLine.appendSwitch("disable-http2");

// Single instance: two app instances would concurrently rewrite
// nexus-state.json and double-bind daemons/terminals/pty hosts.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Register the built-in tool catalog once at startup: the capability registry
// then has a single inventory of first-party tools (metadata only; execution
// pipelines are unchanged — see agent/builtin-tool-catalog.ts).
ensureBuiltinToolCatalog();
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

/** True only when running from source (`npm run dev`) — never in a packaged build. */
function isDevMode(): boolean {
  return process.argv.includes("--dev") || Boolean(process.env.VITE_DEV_SERVER_URL);
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
      // Chromium renderer sandbox is ON by default. The preload runs with
      // contextBridge/ipcRenderer only (verified by test/renderer-security
      // canary: sandboxed renderer + real preload bundle). The env escape
      // hatch is for local diagnosis only and must never ship disabled —
      // it is honored only when the dev flag (--dev) is also present, so a
      // packaged build can never silently run with the sandbox off.
      sandbox:
        process.env.NEXUS_SANDBOX === "0" && isDevMode()
          ? false
          : true,
      webviewTag: true,
      // Required for the built-in Chromium PDF viewer: the Home and Notebook
      // file previews render generated PDFs in an <iframe src="blob:…">.
      plugins: true,
    },
  });
  mainWindow.on("maximize", () => { mainWindow?.webContents.send("window:maximize-change", true); });
  mainWindow.on("unmaximize", () => { mainWindow?.webContents.send("window:maximize-change", false); });

  const devMode = isDevMode();
  if (devMode) void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL || "http://127.0.0.1:5173");
  else void mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  // A top-level navigation away from the app shell is never legitimate —
  // renderer XSS must not be able to pivot the window to a attacker page.
  // The initial loadURL/loadFile does not fire this; user/link navigations do.
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const allowed =
      url.startsWith("file://") ||
      url.startsWith("devtools://") ||
      url.startsWith("nexus-attachment://") ||
      /^https?:\/\/127\.0\.0\.1:5173/.test(url);
    if (!allowed) event.preventDefault();
  });
  // Any <webview> that attaches must be a plain content surface: strip the
  // host preload and node access so a compromised renderer cannot grant a
  // guest (or itself through the guest) Electron/node capabilities. The
  // browser views are declared without preload, so this changes nothing for
  // them — it closes the door on renderer-injected webview attributes.
  mainWindow.webContents.on("will-attach-webview", (_event, webPreferences) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
  });
  setApprovalNotifier((request) => mainWindow?.webContents.send("command:approval-request", request));
  onNotebookJobProgress((progress) => mainWindow?.webContents.send("notebook:progress", progress));
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

const ipcContext: MainIpcContext = {
  window: () => mainWindow,
  active: () => ({ projectId: activeProjectId, sessionId: activeSessionId, projectRoot: activeProjectRoot }),
  setActive: (next) => {
    if ("projectId" in next) activeProjectId = next.projectId ?? null;
    if ("sessionId" in next) activeSessionId = next.sessionId ?? null;
    if ("projectRoot" in next) activeProjectRoot = next.projectRoot ?? null;
  },
  requireRoot,
  settings: {
    get: () => settings,
    set: (next) => { settings = next; },
  },
  activeRunSessions,
  // Assigned by registerUserQuestionRoutes below, before any agent route can
  // invoke it (runs cannot start before registration finishes).
  askUserBlocking: () => { throw new Error("ask_user bridge is not ready yet."); },
  emit,
  emitFor,
};

app.whenReady().then(async () => {
  // Set standard Chrome desktop User-Agent to avoid webview blocks
  session.defaultSession.setUserAgent(CHROME_UA);

  // Window + approval/question routes (askUserBlocking is wired into ctx here)
  registerWindowRoutes(ipcContext);
  ipcContext.askUserBlocking = registerUserQuestionRoutes(ipcContext);

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

  // Home area bootstrap: ensure fixed ~/Documents/Nexus folder exists.
  try {
    await ensureHomeDir();
  } catch { /* lazy fallback in home:get */ }

  // Notebook recovery: files stuck mid-ingestion reset to `uploaded` and
  // re-queue. Re-running converges by design (stable IDs + replace writes).
  void recoverInterruptedJobs()
    .then((requeued) => {
      if (requeued) console.log(`[notebook] recovered ${requeued} interrupted ingestion job(s).`);
    })
    .catch(() => { /* best effort */ });

  // Domain IPC routes (channel names / payloads identical to before).
  registerHomeRoutes(ipcContext);
  registerNotebookRoutes(ipcContext);
  registerProjectRoutes(ipcContext);
  registerProjectExtraRoutes(ipcContext);
  registerProviderRoutes(ipcContext);
  registerSkillsRoutes(ipcContext);
  registerPluginRoutes(ipcContext);
  registerSettingsRoutes(ipcContext);
  registerWorkspaceRoutes(ipcContext);
  registerTerminalRoutes(ipcContext);
  registerBrowserRoutes(ipcContext);
  registerAgentRoutes(ipcContext);
  registerHomeRunRoutes(ipcContext);

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
