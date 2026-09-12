import React, { useEffect, useRef } from "react";
import { CHROME_DESKTOP_UA } from "./IntegratedBrowserView.js";

type BridgeRequest = { id: string; scope?: string; kind: string; url?: string; js?: string; keyCode?: string };
type BridgeReply = { ok: boolean; url?: string; title?: string; value?: unknown; dataUrl?: string; width?: number; height?: number; error?: string };

// Minimal webview surface this host needs (full API lives on the real
// element; only called members are declared).
type AgentWebview = {
  loadURL: (url: string) => Promise<void>;
  executeJavaScript: (code: string) => Promise<unknown>;
  goBack: () => void;
  reload: () => void;
  canGoBack: () => boolean;
  getURL: () => string;
  sendInputEvent: (event: { type: string; keyCode?: string }) => void;
  capturePage: () => Promise<{ toDataURL: () => string; getSize: () => { width: number; height: number } }>;
  addEventListener: (type: string, listener: (event?: { errorDescription?: string; url?: string }) => void) => void;
  removeEventListener: (type: string, listener: (event?: never) => void) => void;
};

const SETTLE_MS = 600;

// Always-mounted, offscreen-positioned (never display:none — backgrounded
// webviews throttle timers/loads) twin webviews that execute the agent's
// browsing ops — one per browser, fully separate sessions:
// persist:browser-home and persist:browser-code share NOTHING (cookies,
// storage, cache, logins). Same partitions as the visible sidebar browsers,
// so the agent and the user always meet in the same jar.
export const AgentBrowserHost: React.FC = () => {
  const homeRef = useRef<AgentWebview | null>(null);
  const codeRef = useRef<AgentWebview | null>(null);

  useEffect(() => {
    const api = (window.nexus || window.forgepilot) as unknown as {
      onAgentBrowserRequest?: (handler: (req: BridgeRequest) => Promise<BridgeReply>) => () => void;
    };
    if (typeof api.onAgentBrowserRequest !== "function") return undefined;

    function waitFor(wv: AgentWebview, okEvents: string[], timeoutMs: number): Promise<void> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error("Page load timed out."));
        }, timeoutMs);
        const cleanup = () => {
          clearTimeout(timer);
          for (const ev of okEvents) wv.removeEventListener(ev, onOk as never);
          wv.removeEventListener("did-fail-load", onFail as never);
        };
        const onOk = () => {
          cleanup();
          resolve();
        };
        const onFail = (event?: { errorDescription?: string }) => {
          cleanup();
          reject(new Error(`Page failed to load: ${event?.errorDescription || "unknown error"}`));
        };
        for (const ev of okEvents) wv.addEventListener(ev, onOk);
        wv.addEventListener("did-fail-load", onFail);
      });
    }

    const settle = () => new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

    return api.onAgentBrowserRequest(async (req): Promise<BridgeReply> => {
      const scope = req.scope === "home" ? "home" : "code";
      const wv = (scope === "home" ? homeRef : codeRef).current;
      if (!wv) return { ok: false, error: "Agent webview is not mounted yet." };
      try {
        switch (req.kind) {
          case "load": {
            if (!req.url) return { ok: false, error: "No URL to load." };
            const gate = waitFor(wv, ["did-finish-load"], 18000);
            void wv.loadURL(req.url).catch(() => {});
            await gate;
            await settle();
            let title = "";
            try {
              title = String(await wv.executeJavaScript("document.title || ''"));
            } catch { /* title is best-effort */ }
            return { ok: true, url: wv.getURL(), title };
          }
          case "eval": {
            const value = await wv.executeJavaScript(req.js || "null");
            return { ok: true, value: value ?? null };
          }
          case "back": {
            if (!wv.canGoBack()) return { ok: false, error: "No back history in the agent browser." };
            const gate = waitFor(wv, ["did-finish-load", "did-navigate-in-page"], 12000);
            wv.goBack();
            await gate;
            await settle();
            return { ok: true, url: wv.getURL() };
          }
          case "reload": {
            const gate = waitFor(wv, ["did-finish-load", "did-navigate-in-page"], 12000);
            wv.reload();
            try {
              await gate;
            } catch { /* proceed even if the event never fires */ }
            await settle();
            return { ok: true, url: wv.getURL() };
          }
          case "press": {
            wv.sendInputEvent({ type: "keyDown", keyCode: req.keyCode });
            wv.sendInputEvent({ type: "keyUp", keyCode: req.keyCode });
            await new Promise((resolve) => setTimeout(resolve, 400));
            return { ok: true, url: wv.getURL() };
          }
          case "shot": {
            const image = await wv.capturePage();
            const size = image.getSize();
            return { ok: true, dataUrl: image.toDataURL(), width: size.width, height: size.height };
          }
          default:
            return { ok: false, error: `Unknown agent browser op "${req.kind}".` };
        }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    });
  }, []);

  return (
    <div className="agent-webview-host" aria-hidden="true">
      <webview
        ref={homeRef as never}
        src="about:blank"
        useragent={CHROME_DESKTOP_UA}
        partition="persist:browser-home"
        webpreferences="contextIsolation=yes"
      />
      <webview
        ref={codeRef as never}
        src="about:blank"
        useragent={CHROME_DESKTOP_UA}
        partition="persist:browser-code"
        webpreferences="contextIsolation=yes"
      />
    </div>
  );
};
