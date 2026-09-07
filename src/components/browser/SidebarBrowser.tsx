import React, { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, RefreshCw, Globe, X } from "lucide-react";
import { CHROME_DESKTOP_UA } from "./IntegratedBrowserView.js";

type MiniWebview = {
  addEventListener: (type: string, listener: (event?: { url?: string }) => void) => void;
  removeEventListener: (type: string, listener: (event?: never) => void) => void;
};

type DaemonServer = { id: string; name: string; port: number; url: string; command: string };

// Last agent-viewed URL, module-level so it survives tab switches: the agent
// keeps browsing while this panel is closed.
let lastAgentUrl: string | null = null;

function resolveMiniUrl(input: string): string {
  const query = input.trim();
  if (!query) return "https://www.google.com";
  if (/^https?:\/\//i.test(query)) return query;
  if (/^localhost(:\d+)?(\/.*)?$/i.test(query) || /^127\.0\.0\.1(:\d+)?(\/.*)?$/i.test(query)) {
    return `http://${query}`;
  }
  const isDomain = /^([a-z0-9]+(-[a-z0-9]+)*\.)+[a-z]{2,}(:\d+)?(\/.*)?$/i.test(query);
  if (isDomain && !query.includes(" ")) return `https://${query}`;
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

function shortHost(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
      return `localhost:${parsed.port || "80"}`;
    }
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return url.slice(0, 24);
  }
}

// Compact browser for the sidebar: address bar, history controls, dev-server
// chips, and the page itself. Follows the agent (auto in Watching mode,
// banner otherwise) exactly like the full Browser tab.
export const SidebarBrowser: React.FC = () => {
  const [url, setUrl] = useState("https://www.google.com");
  const [inputUrl, setInputUrl] = useState("https://www.google.com");
  const [history, setHistory] = useState<string[]>(["https://www.google.com"]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [headless, setHeadless] = useState(true);
  const [agentUrl, setAgentUrl] = useState<string | null>(null);
  const [servers, setServers] = useState<DaemonServer[]>([]);
  const webviewRef = useRef<MiniWebview | null>(null);

  const headlessRef = useRef(true);
  const navigateRef = useRef<(raw: string) => void>(() => {});
  headlessRef.current = headless;

  function navigate(raw: string) {
    const finalUrl = resolveMiniUrl(raw);
    setUrl(finalUrl);
    setInputUrl(finalUrl);
    setLoading(true);
    setHistory((prev) => {
      const base = prev.slice(0, historyIndex + 1);
      return [...base, finalUrl];
    });
    setHistoryIndex((prev) => prev + 1);
  }
  navigateRef.current = navigate;

  function go(delta: -1 | 1) {
    const next = historyIndex + delta;
    if (next < 0 || next >= history.length) return;
    setHistoryIndex(next);
    setUrl(history[next]);
    setInputUrl(history[next]);
    setLoading(true);
  }

  useEffect(() => {
    const api = window.forgepilot as unknown as {
      listDaemons?: () => Promise<Array<{ id: string; name: string; status: string; port?: number; command: string }>>;
      getBrowserHeadless?: () => Promise<boolean>;
      onBrowserAgentActivity?: (listener: (payload: { url: string; timestamp: string; autoFollow?: boolean }) => void) => () => void;
    };
    const loadServers = () => {
      if (typeof api.listDaemons !== "function") return;
      api
        .listDaemons()
        .then((daemons) =>
          setServers(
            (daemons || [])
              .filter((d) => d.status === "running" && d.port)
              .map((d) => ({ id: d.id, name: d.name, port: d.port!, url: `http://localhost:${d.port}`, command: d.command }))
          )
        )
        .catch(() => {});
    };
    void loadServers();
    const interval = setInterval(loadServers, 5000);
    if (typeof api.getBrowserHeadless === "function") {
      api.getBrowserHeadless().then((value) => {
        setHeadless(value);
        headlessRef.current = value;
        if (!value && lastAgentUrl) navigateRef.current(lastAgentUrl);
      }).catch(() => {});
    }
    let unsubscribe: (() => void) | undefined;
    if (typeof api.onBrowserAgentActivity === "function") {
      unsubscribe = api.onBrowserAgentActivity((payload) => {
        if (!payload?.url) return;
        lastAgentUrl = payload.url;
        setAgentUrl(payload.url);
        if (payload.autoFollow && !headlessRef.current) navigateRef.current(payload.url);
      });
    }
    return () => {
      clearInterval(interval);
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    const el = webviewRef.current;
    if (!el) return undefined;
    const onStop = () => setLoading(false);
    el.addEventListener("did-stop-loading", onStop);
    el.addEventListener("did-fail-load", onStop);
    return () => {
      el.removeEventListener("did-stop-loading", onStop as never);
      el.removeEventListener("did-fail-load", onStop as never);
    };
  }, [url]);

  const showBanner = agentUrl && agentUrl !== url;

  return (
    <div className="side-browser">
      {showBanner && (
        <div className="browser-agent-banner">
          <span className="status-dot running" style={{ width: 6, height: 6 }} />
          <span>Agent: {shortHost(agentUrl)}</span>
          <button type="button" className="browser-btn highlight" onClick={() => navigate(agentUrl)} title={`Follow the agent to ${agentUrl}`}>
            <span>Follow</span>
          </button>
          <button type="button" className="browser-btn icon-only" onClick={() => setAgentUrl(null)} title="Dismiss">
            <X size={11} />
          </button>
        </div>
      )}
      <form
        className="side-browser-bar"
        onSubmit={(e) => {
          e.preventDefault();
          navigate(inputUrl);
        }}
      >
        <button type="button" className="browser-btn icon-only" onClick={() => go(-1)} disabled={historyIndex <= 0} title="Back">
          <ArrowLeft size={13} />
        </button>
        <button type="button" className="browser-btn icon-only" onClick={() => go(1)} disabled={historyIndex >= history.length - 1} title="Forward">
          <ArrowRight size={13} />
        </button>
        <button type="button" className="browser-btn icon-only" onClick={() => navigate(url)} title="Reload">
          <RefreshCw size={13} className={loading ? "spin" : ""} />
        </button>
        <input
          type="text"
          value={inputUrl}
          onChange={(e) => setInputUrl(e.target.value)}
          placeholder="Search or enter address"
          spellCheck={false}
        />
      </form>
      {servers.length > 0 && (
        <div className="side-browser-servers">
          {servers.map((srv) => (
            <button key={srv.id} type="button" className="bookmark-chip server-chip" onClick={() => navigate(srv.url)} title={srv.command}>
              <span className="status-dot running" style={{ width: 6, height: 6 }} />
              <span>:{srv.port}</span>
            </button>
          ))}
        </div>
      )}
      <div className="side-browser-view">
        {typeof window !== "undefined" && (window.nexus || window.forgepilot) ? (
          <webview
            key={url}
            ref={webviewRef as never}
            src={url}
            useragent={CHROME_DESKTOP_UA}
            className="browser-iframe"
            partition="persist:browser"
            webpreferences="contextIsolation=yes"
          />
        ) : (
          <div className="empty-pane">
            <Globe size={16} />
            <span>Browser unavailable.</span>
          </div>
        )}
      </div>
    </div>
  );
};
