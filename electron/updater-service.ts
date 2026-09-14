import { app } from "electron";
import { createRequire } from "node:module";

// electron-updater ships CJS without ESM named exports, and this codebase
// compiles to ESM — load it through createRequire instead of import.
const require = createRequire(import.meta.url);
const { autoUpdater } = require("electron-updater") as {
  autoUpdater: {
    autoDownload: boolean;
    autoInstallOnAppQuit: boolean;
    forceDevUpdateConfig: boolean;
    on: (event: string, listener: (...args: any[]) => void) => void;
    checkForUpdates: () => Promise<unknown>;
    quitAndInstall: (isSilent?: boolean, isForceRunAfter?: boolean) => void;
  };
};

export type UpdaterState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "up-to-date"; version: string }
  | { status: "available"; version: string }
  | { status: "downloading"; version: string; percent: number }
  | { status: "downloaded"; version: string }
  | { status: "error"; message: string };

export type UpdaterListener = (state: UpdaterState) => void;

// In-app updates via electron-updater (GitHub Releases feed from
// package.json build.publish). Flow: startup auto-check (packaged builds
// only) → available → auto-download with progress → downloaded → user clicks
// restart → quitAndInstall. Nothing renders unless a newer release exists.
class UpdaterService {
  private listener: UpdaterListener | null = null;
  private started = false;
  private lastState: UpdaterState = { status: "idle" };
  // Version of the update currently being downloaded (or downloaded and
  // awaiting restart). Tracked explicitly because download-progress events
  // don't carry it and lastState may be mid-transition when they arrive.
  private pendingVersion = "";

  onStatus(listener: UpdaterListener | null) {
    this.listener = listener;
  }

  getState(): UpdaterState {
    return this.lastState;
  }

  private emit(state: UpdaterState) {
    // A downloaded update is pending restart: nothing may hide the install
    // affordance again. A later re-check that re-finds the same update just
    // re-downloads (ending in downloaded again); a check that reports
    // anything else while an update sits uninstalled must not clear it —
    // otherwise the topbar button appears for a second and vanishes.
    // update-downloaded always wins so a newer version refreshes the pill.
    if (this.lastState.status === "downloaded" && state.status !== "downloaded") return;
    this.lastState = state;
    try {
      this.listener?.(state);
    } catch { /* renderer listener is best-effort */ }
  }

  init() {
    if (this.started) return;
    this.started = true;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    // Local testing only: NEXUS_UPDATE_DEV=1 makes dev runs read a
    // dev-app-update.yml next to package.json instead of refusing outright.
    if (!app.isPackaged && process.env.NEXUS_UPDATE_DEV === "1") {
      autoUpdater.forceDevUpdateConfig = true;
    }
    autoUpdater.on("checking-for-update", () => this.emit({ status: "checking" }));
    autoUpdater.on("update-available", (info) => {
      this.pendingVersion = info?.version ?? "";
      this.emit({ status: "available", version: this.pendingVersion });
    });
    autoUpdater.on("update-not-available", (info) =>
      this.emit({ status: "up-to-date", version: info?.version ?? app.getVersion() })
    );
    autoUpdater.on("download-progress", (progress) => {
      this.emit({ status: "downloading", version: this.pendingVersion, percent: Math.round(progress?.percent ?? 0) });
    });
    autoUpdater.on("update-downloaded", (info) => {
      this.pendingVersion = info?.version ?? this.pendingVersion;
      this.emit({ status: "downloaded", version: this.pendingVersion });
    });
    autoUpdater.on("error", (error) =>
      this.emit({
        status: "error",
        message: error instanceof Error ? error.message : String(error ?? "Update check failed."),
      })
    );
  }

  // auto=true (startup): stays silent unless something is actually available.
  // auto=false (user clicked Check): always reports the outcome.
  async check(auto = false): Promise<UpdaterState> {
    // Unpacked dev runs have no release feed — report current instead of
    // erroring, unless explicitly testing the flow.
    if (!app.isPackaged && process.env.NEXUS_UPDATE_DEV !== "1") {
      const state: UpdaterState = { status: "up-to-date", version: app.getVersion() };
      if (!auto) this.emit(state);
      return state;
    }
    this.emit({ status: "checking" });
    try {
      await autoUpdater.checkForUpdates();
      // "available" (+progress, +downloaded) or "up-to-date" arrive via the
      // event handlers above while awaiting.
      return this.lastState;
    } catch (error) {
      const state: UpdaterState = {
        status: "error",
        message: error instanceof Error ? error.message : String(error ?? "Update check failed."),
      };
      this.emit(state);
      return state;
    }
  }

  quitAndInstall() {
    try {
      autoUpdater.quitAndInstall(false, true);
    } catch {
      app.relaunch();
      app.exit(0);
    }
  }
}

export const updaterService = new UpdaterService();
