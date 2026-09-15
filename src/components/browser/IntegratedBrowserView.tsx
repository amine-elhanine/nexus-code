import React, { useState, useEffect, useRef } from "react";
import {
  Globe, ArrowLeft, ArrowRight, RefreshCw, ExternalLink, Smartphone,
  Tablet, Monitor, Laptop, Play, Server, MessageSquare, ChevronDown, Check,
  Plus, X, Copy, Home, Search, BookOpen, Compass, Shield, Eye, EyeOff
} from "lucide-react";

export type DeviceMode = "responsive" | "desktop" | "tablet" | "mobile";
export type SearchEngine = "google" | "duckduckgo" | "bing";

export interface BrowserTab {
  id: string;
  title: string;
  url: string;
  inputUrl: string;
  history: string[];
  historyIndex: number;
  isLoading: boolean;
}

interface RunningServer {
  id: string;
  name: string;
  port: number;
  url: string;
  command: string;
}

interface IntegratedBrowserViewProps {
  projectRoot?: string;
  onSendToAgent?: (prompt: string) => void;
}

const DEFAULT_BOOKMARKS = [
  { name: "Google", url: "https://www.google.com", icon: "🔍" },
  { name: "MDN Docs", url: "https://developer.mozilla.org", icon: "📘" },
  { name: "GitHub", url: "https://github.com", icon: "🐙" },
  { name: "StackOverflow", url: "https://stackoverflow.com", icon: "⚡" },
  { name: "npm", url: "https://www.npmjs.com", icon: "📦" },
  { name: "Tailwind", url: "https://tailwindcss.com/docs", icon: "🎨" },
];

function resolveUrlOrSearch(input: string, engine: SearchEngine): string {
  const query = input.trim();
  if (!query) return "https://www.google.com";

  // Check if it already has protocol
  if (/^https?:\/\//i.test(query)) {
    return query;
  }

  // Check if it's localhost or IP address
  if (/^localhost(:\d+)?(\/.*)?$/i.test(query) || /^127\.0\.0\.1(:\d+)?(\/.*)?$/i.test(query)) {
    return `http://${query}`;
  }

  // Check if it's a domain name (e.g. github.com, mdn.io, sub.domain.org/path)
  const isDomain = /^([a-z0-9]+(-[a-z0-9]+)*\.)+[a-z]{2,}(:\d+)?(\/.*)?$/i.test(query);
  if (isDomain && !query.includes(" ")) {
    return `https://${query}`;
  }

  // Otherwise, treat as search query
  const encoded = encodeURIComponent(query);
  if (engine === "duckduckgo") {
    return `https://duckduckgo.com/?q=${encoded}`;
  }
  if (engine === "bing") {
    return `https://www.bing.com/search?q=${encoded}`;
  }
  return `https://www.google.com/search?q=${encoded}`;
}

function getTitleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
      return `Localhost:${parsed.port || "80"}`;
    }
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return url.slice(0, 20);
  }
}

export const CHROME_DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// The minimal <webview> API surface used below; Electron injects the full
// element with these imperative methods. It is NOT a plain HTMLElement
// subtype — its event listener signatures differ — so only the members the
// component actually calls are declared here.
type ElectronWebview = {
  goBack: () => void;
  goForward: () => void;
  reload: () => void;
  stop: () => void;
  getURL: () => string;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  addEventListener: (type: string, listener: (event: { url?: string; title?: string; isTopLevel?: boolean }) => void) => void;
  removeEventListener: (type: string, listener: (event: never) => void) => void;
};

// Last agent-viewed URL, kept at module level so it survives tab unmounts:
// the agent keeps browsing while the Browser tab is closed, and Watching
// mode syncs to it the next time the tab opens.
let lastAgentUrl: string | null = null;

export const IntegratedBrowserView: React.FC<IntegratedBrowserViewProps> = ({
  projectRoot,
  onSendToAgent,
}) => {
  const [tabs, setTabs] = useState<BrowserTab[]>([
    {
      id: "tab-1",
      title: "Local Dev (5173)",
      url: "http://localhost:5173",
      inputUrl: "http://localhost:5173",
      history: ["http://localhost:5173"],
      historyIndex: 0,
      isLoading: false,
    },
  ]);
  const [activeTabId, setActiveTabId] = useState<string>("tab-1");
  const [deviceMode, setDeviceMode] = useState<DeviceMode>("responsive");
  const [searchEngine, setSearchEngine] = useState<SearchEngine>("duckduckgo");
  const [detectedServers, setDetectedServers] = useState<RunningServer[]>([]);
  const [isStartingServer, setIsStartingServer] = useState(false);
  const [copiedNote, setCopiedNote] = useState(false);
  const [reloadKey, setReloadKey] = useState(1);
  const [browserHeadless, setBrowserHeadless] = useState(true);
  const [agentUrl, setAgentUrl] = useState<string | null>(null);
  const webviewRefs = useRef<Record<string, ElectronWebview | null>>({});
  // Stable handles for the mount-once agent-activity subscription below.
  const headlessRef = useRef(true);
  const activeTabIdRef = useRef(activeTabId);
  const activeTabUrlRef = useRef(tabs.find((t) => t.id === activeTabId)?.url || "");
  const navigateRef = useRef<((tabId: string, rawInput: string) => void) | null>(null);
  headlessRef.current = browserHeadless;
  activeTabIdRef.current = activeTabId;

  const activeTab = tabs.find((t) => t.id === activeTabId) || tabs[0];
  activeTabUrlRef.current = activeTab.url;

  const loadServers = async () => {
    try {
      const daemons = await window.forgepilot.listDaemons();
      const servers: RunningServer[] = [];
      for (const d of daemons) {
        if (d.status === "running" && d.port) {
          servers.push({
            id: d.id,
            name: d.name,
            port: d.port,
            url: `http://localhost:${d.port}`,
            command: d.command,
          });
        }
      }
      setDetectedServers(servers);
    } catch {
      setDetectedServers([]);
    }
  };

  useEffect(() => {
    void loadServers();
    const interval = setInterval(() => {
      void loadServers();
    }, 2500);
    return () => clearInterval(interval);
  }, []);

  // Agent browser: headless preference + live follow. Headless ON: the agent
  // works in the hidden webview and this tab only shows a Follow banner.
  // Headless OFF (Watching): the visible tab navigates along with the agent
  // automatically — the built-in browser IS the agent's browser.
  // (navigateRef/activeTabIdRef are assigned below during render — stable by
  // the time any activity event fires.)
  useEffect(() => {
    const api = window.forgepilot as unknown as {
      getBrowserHeadless?: () => Promise<boolean>;
      setBrowserHeadless?: (v: boolean) => Promise<boolean>;
      onBrowserAgentActivity?: (listener: (payload: { url: string; timestamp: string; autoFollow?: boolean }) => void) => () => void;
    };
    if (typeof api.getBrowserHeadless === "function") {
      api.getBrowserHeadless().then((value) => {
        setBrowserHeadless(value);
        headlessRef.current = value;
        // Mount sync: if Watching and the agent already went somewhere while
        // this tab was closed, jump there instead of showing a stale page.
        // (Compares URLs — the old check compared the URL against the tab
        // ID, which is never equal, so it re-navigated on every mount.)
        if (!value && lastAgentUrl && lastAgentUrl !== activeTabUrlRef.current) {
          navigateRef.current?.(activeTabIdRef.current, lastAgentUrl);
        }
      }).catch(() => {});
    }
    if (typeof api.onBrowserAgentActivity === "function") {
      return api.onBrowserAgentActivity((payload) => {
        if (!payload?.url) return;
        lastAgentUrl = payload.url;
        setAgentUrl(payload.url);
        // Skip if the visible tab is already there — otherwise repeated
        // activity for the same page remounts the webview in a loop.
        if (payload.autoFollow && !headlessRef.current && payload.url !== activeTabUrlRef.current) {
          navigateRef.current?.(activeTabIdRef.current, payload.url);
        }
      });
    }
    return undefined;
  }, []);

  const toggleBrowserHeadless = async () => {
    const next = !browserHeadless;
    setBrowserHeadless(next);
    try {
      const api = window.forgepilot as unknown as { setBrowserHeadless?: (v: boolean) => Promise<boolean> };
      if (typeof api.setBrowserHeadless === "function") {
        setBrowserHeadless(await api.setBrowserHeadless(next));
      }
    } catch {
      setBrowserHeadless(!next);
    }
  };

  const navigateTab = (tabId: string, rawInput: string) => {
    const finalUrl = resolveUrlOrSearch(rawInput, searchEngine);
    setTabs((prev) =>
      prev.map((t) => {
        if (t.id !== tabId) return t;
        const newHistory = [...t.history.slice(0, t.historyIndex + 1), finalUrl];
        return {
          ...t,
          url: finalUrl,
          inputUrl: finalUrl,
          title: getTitleFromUrl(finalUrl),
          history: newHistory,
          historyIndex: newHistory.length - 1,
          isLoading: true,
        };
      })
    );
    setReloadKey((k) => k + 1);
  };
  navigateRef.current = navigateTab;

  const activeWebview = () => webviewRefs.current[activeTabId] || null;

  // Back/forward/reload drive the live webview so page state (scroll, forms,
  // JS) survives navigation instead of remounting it from scratch.
  const handleBack = () => {
    const webview = activeWebview();
    if (webview?.canGoBack?.()) {
      webview.goBack();
    } else if (activeTab.historyIndex > 0) {
      const newIndex = activeTab.historyIndex - 1;
      const prevUrl = activeTab.history[newIndex];
      setTabs((prev) =>
        prev.map((t) =>
          t.id === activeTab.id
            ? { ...t, url: prevUrl, inputUrl: prevUrl, title: getTitleFromUrl(prevUrl), historyIndex: newIndex, isLoading: true }
            : t
        )
      );
      setReloadKey((k) => k + 1);
    }
  };

  const handleForward = () => {
    const webview = activeWebview();
    if (webview?.canGoForward?.()) {
      webview.goForward();
    } else if (activeTab.historyIndex < activeTab.history.length - 1) {
      const newIndex = activeTab.historyIndex + 1;
      const nextUrl = activeTab.history[newIndex];
      setTabs((prev) =>
        prev.map((t) =>
          t.id === activeTab.id
            ? { ...t, url: nextUrl, inputUrl: nextUrl, title: getTitleFromUrl(nextUrl), historyIndex: newIndex, isLoading: true }
            : t
        )
      );
      setReloadKey((k) => k + 1);
    }
  };

  const handleReload = () => {
    const webview = activeWebview();
    if (webview?.reload) {
      webview.reload();
      return;
    }
    setTabs((prev) =>
      prev.map((t) => (t.id === activeTab.id ? { ...t, isLoading: true } : t))
    );
    setReloadKey((k) => k + 1);
  };

  const handleNewTab = (initialUrl = "https://www.google.com") => {
    const newId = `tab-${Date.now()}`;
    const newTab: BrowserTab = {
      id: newId,
      title: getTitleFromUrl(initialUrl),
      url: initialUrl,
      inputUrl: initialUrl,
      history: [initialUrl],
      historyIndex: 0,
      isLoading: false,
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newId);
  };

  const handleCloseTab = (e: React.MouseEvent, tabId: string) => {
    e.stopPropagation();
    if (tabs.length === 1) {
      // Don't close last tab, just reset it
      navigateTab(tabId, "https://www.google.com");
      return;
    }
    const remaining = tabs.filter((t) => t.id !== tabId);
    setTabs(remaining);
    if (activeTabId === tabId) {
      setActiveTabId(remaining[remaining.length - 1].id);
    }
  };

  const handleOpenExternal = async () => {
    try {
      await window.forgepilot.openExternal(activeTab.url);
    } catch {
      window.open(activeTab.url, "_blank");
    }
  };

  const handleCopyUrl = () => {
    void navigator.clipboard.writeText(activeTab.url);
    setCopiedNote(true);
    setTimeout(() => setCopiedNote(false), 1800);
  };

  const handleSendToAgent = () => {
    if (onSendToAgent) {
      onSendToAgent(
        `Inspect and test the running web page at ${activeTab.url} (${activeTab.title}). Verify layout, check console errors or unexpected visual bugs, and validate features.`
      );
    }
  };

  const handleStartDevServer = async (command = "npm run dev") => {
    setIsStartingServer(true);
    try {
      await window.forgepilot.startDaemon("Dev Server", command, projectRoot || "");
      setTimeout(async () => {
        await loadServers();
        setIsStartingServer(false);
      }, 1500);
    } catch {
      setIsStartingServer(false);
    }
  };

  const getViewportDimensions = (): { width: string; height?: string; maxWidth?: string } => {
    switch (deviceMode) {
      case "mobile":
        return { width: "375px", height: "667px", maxWidth: "375px" };
      case "tablet":
        return { width: "768px", height: "1024px", maxWidth: "768px" };
      case "desktop":
        return { width: "1280px", maxWidth: "1280px" };
      case "responsive":
      default:
        return { width: "100%" };
    }
  };

  const viewportStyle = getViewportDimensions();

  return (
    <div className="integrated-browser-view">
      {/* 1. Browser Tab Strip */}
      <div className="browser-tab-strip">
        <div className="browser-tabs-container">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`browser-tab ${tab.id === activeTabId ? "active" : ""}`}
              onClick={() => setActiveTabId(tab.id)}
            >
              <Globe size={12} className="tab-icon" />
              <span className="tab-title">{tab.title}</span>
              <button
                type="button"
                className="tab-close-btn"
                onClick={(e) => handleCloseTab(e, tab.id)}
                title="Close Tab"
              >
                <X size={11} />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="browser-new-tab-btn"
            onClick={() => handleNewTab("https://www.google.com")}
            title="New Tab"
          >
            <Plus size={13} />
          </button>
        </div>

        {/* Search Engine Switcher */}
        <div className="browser-engine-switch">
          <select
            value={searchEngine}
            onChange={(e) => setSearchEngine(e.target.value as SearchEngine)}
            title="Default search engine for keywords"
          >
            <option value="google">Google</option>
            <option value="duckduckgo">DuckDuckGo</option>
            <option value="bing">Bing</option>
          </select>
        </div>
      </div>

      {/* 2. Top Browser Navigation & Address Bar */}
      <div className="browser-navbar">
        {/* Navigation History Controls */}
        <div className="browser-nav-group">
          <button
            className="browser-btn icon-only"
            onClick={handleBack}
            disabled={activeTab.historyIndex <= 0}
            title="Back"
          >
            <ArrowLeft size={13} />
          </button>
          <button
            className="browser-btn icon-only"
            onClick={handleForward}
            disabled={activeTab.historyIndex >= activeTab.history.length - 1}
            title="Forward"
          >
            <ArrowRight size={13} />
          </button>
          <button
            className="browser-btn icon-only"
            onClick={handleReload}
            title="Reload Page (Ctrl+R)"
          >
            <RefreshCw size={13} className={activeTab.isLoading ? "spin" : ""} />
          </button>
          <button
            className="browser-btn icon-only"
            onClick={() => navigateTab(activeTab.id, detectedServers[0]?.url || "http://localhost:5173")}
            title="Go to Local Dev Server"
          >
            <Home size={13} />
          </button>
        </div>

        {/* URL / Search Input Bar */}
        <form
          className="browser-url-form"
          onSubmit={(e) => {
            e.preventDefault();
            navigateTab(activeTab.id, activeTab.inputUrl);
          }}
        >
          <div className="browser-url-bar">
            <Search size={13} className="browser-globe-icon" />
            <input
              type="text"
              value={activeTab.inputUrl}
              onChange={(e) => {
                const val = e.target.value;
                setTabs((prev) =>
                  prev.map((t) => (t.id === activeTab.id ? { ...t, inputUrl: val } : t))
                );
              }}
              placeholder="Search Google or enter web address (e.g. github.com, localhost:5173)"
              spellCheck={false}
            />

            {detectedServers.length > 0 && (
              <div className="browser-server-selector">
                <select
                  value={activeTab.url.startsWith("http://localhost") ? activeTab.url : ""}
                  onChange={(e) => {
                    if (e.target.value) navigateTab(activeTab.id, e.target.value);
                  }}
                  title="Switch to detected dev server"
                >
                  <option value="" disabled>
                    Dev Servers ({detectedServers.length})
                  </option>
                  {detectedServers.map((srv) => (
                    <option key={srv.id} value={srv.url}>
                      {srv.name} (:{srv.port})
                    </option>
                  ))}
                </select>
                <ChevronDown size={11} className="select-arrow" />
              </div>
            )}
          </div>
        </form>

        {/* Viewport Presets Switcher */}
        <div className="browser-device-switch">
          <button
            className={`device-btn ${deviceMode === "responsive" ? "active" : ""}`}
            onClick={() => setDeviceMode("responsive")}
            title="Responsive (100% width)"
          >
            <Monitor size={13} />
            <span>Full</span>
          </button>
          <button
            className={`device-btn ${deviceMode === "desktop" ? "active" : ""}`}
            onClick={() => setDeviceMode("desktop")}
            title="Desktop Viewport (1280px)"
          >
            <Laptop size={13} />
            <span>Desktop</span>
          </button>
          <button
            className={`device-btn ${deviceMode === "tablet" ? "active" : ""}`}
            onClick={() => setDeviceMode("tablet")}
            title="Tablet Viewport (768px)"
          >
            <Tablet size={13} />
            <span>Tablet</span>
          </button>
          <button
            className={`device-btn ${deviceMode === "mobile" ? "active" : ""}`}
            onClick={() => setDeviceMode("mobile")}
            title="Mobile Viewport (375px)"
          >
            <Smartphone size={13} />
            <span>Mobile</span>
          </button>
        </div>

        {/* Action Controls */}
        <div className="browser-actions-group">
          <button
            className="browser-btn"
            onClick={handleCopyUrl}
            title="Copy current URL to clipboard"
          >
            {copiedNote ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
            <span>{copiedNote ? "Copied" : "Copy"}</span>
          </button>

          {onSendToAgent && (
            <button
              className="browser-btn highlight"
              onClick={handleSendToAgent}
              title="Pass live website context to Agent for automated testing"
            >
              <MessageSquare size={13} />
              <span>Ask Agent</span>
            </button>
          )}

          <button
            className="browser-btn"
            onClick={handleOpenExternal}
            title="Open in System Default Browser (Chrome, Edge, Firefox, Safari)"
          >
            <ExternalLink size={13} />
            <span>Open in Browser</span>
          </button>

          <button
            className={`browser-btn ${browserHeadless ? "" : "highlight"}`}
            onClick={() => void toggleBrowserHeadless()}
            title={browserHeadless ? "Agent browsing runs hidden. Click to show the agent's browser window while it works." : "Agent browser window is visible. Click to run agent browsing hidden in the background."}
          >
            {browserHeadless ? <EyeOff size={13} /> : <Eye size={13} />}
            <span>{browserHeadless ? "Headless" : "Watching"}</span>
          </button>
        </div>
      </div>

      {agentUrl && (
        <div className="browser-agent-banner">
          <span className="status-dot running" style={{ width: 6, height: 6 }} />
          <span>Agent is viewing {getTitleFromUrl(agentUrl)}</span>
          <button
            type="button"
            className="browser-btn highlight"
            onClick={() => navigateTab(activeTab.id, agentUrl)}
            title={`Follow the agent to ${agentUrl}`}
          >
            <span>Follow</span>
          </button>
          <button
            type="button"
            className="browser-btn icon-only"
            onClick={() => setAgentUrl(null)}
            title="Dismiss"
          >
            <X size={11} />
          </button>
        </div>
      )}

      {/* 3. Quick Bookmarks Bar */}
      <div className="browser-bookmarks-bar">
        {detectedServers.map((srv) => (
          <button
            key={srv.id}
            type="button"
            className="bookmark-chip server-chip"
            onClick={() => navigateTab(activeTab.id, srv.url)}
          >
            <span className="status-dot running" style={{ width: 6, height: 6 }} />
            <span>{srv.name} (:{srv.port})</span>
          </button>
        ))}
        {DEFAULT_BOOKMARKS.map((bm) => (
          <button
            key={bm.name}
            type="button"
            className="bookmark-chip"
            onClick={() => navigateTab(activeTab.id, bm.url)}
          >
            <span>{bm.icon}</span>
            <span>{bm.name}</span>
          </button>
        ))}
      </div>

      {/* 4. Main Viewport Container */}
      <div className={`browser-viewport-container ${deviceMode}`}>
        <div
          className={`browser-frame-wrapper ${deviceMode !== "responsive" ? "device-framed" : ""}`}
          style={viewportStyle}
        >
          {deviceMode !== "responsive" && (
            <div className="device-frame-header">
              <span className="device-pill" />
              <span className="device-label">
                {deviceMode === "mobile"
                  ? "iPhone 375 × 667"
                  : deviceMode === "tablet"
                  ? "iPad 768 × 1024"
                  : "Desktop 1280px"}
              </span>
            </div>
          )}

          {typeof window !== "undefined" && (window.nexus || window.forgepilot) ? (
            <BrowserWebview
              key={activeTab.id}
              tab={activeTab}
              reloadKey={reloadKey}
              onLoadingChange={(loading, tabId) =>
                setTabs((prev) => prev.map((t) => (t.id === (tabId || activeTab.id) ? { ...t, isLoading: loading } : t)))
              }
              onNavigated={(url, title, tabId) =>
                setTabs((prev) =>
                  prev.map((t) =>
                    t.id === (tabId || activeTab.id)
                      ? { ...t, url, inputUrl: url, title: title || getTitleFromUrl(url), isLoading: false }
                      : t
                  )
                )
              }
              registerRef={(el) => { webviewRefs.current[activeTab.id] = el; }}
            />
          ) : (
            <iframe
              key={`${activeTab.id}-${reloadKey}`}
              src={activeTab.url}
              title={`Nexus Browser - ${activeTab.title}`}
              className="browser-iframe"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads allow-top-navigation-by-user-activation"
              onLoad={() => {
                setTabs((prev) =>
                  prev.map((t) => (t.id === activeTab.id ? { ...t, isLoading: false } : t))
                );
              }}
            />
          )}
        </div>

        {/* Quick Launch Drawer when No Server is Active */}
        {!detectedServers.length && activeTab.url.includes("localhost") && (
          <div className="browser-no-server-bar">
            <div className="no-server-info">
              <Server size={14} className="text-amber-400" />
              <span>No dev server detected running on localhost.</span>
            </div>
            <div className="no-server-actions">
              <button
                className="primary-sm"
                onClick={() => void handleStartDevServer("npm run dev")}
                disabled={isStartingServer}
              >
                <Play size={12} fill="currentColor" />
                <span>{isStartingServer ? "Starting..." : "Start npm run dev"}</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

// The webview keeps its own load state via DOM events: did-start-loading /
// did-stop-loading clear the spinner, did-navigate-in-page and
// did-navigate update URL/title WITHOUT remounting.
//
// Critical: the committed `src` only changes on explicit user navigations
// (navigateTab/back/forward bump `reloadKey`, tab switches change `tab.id`).
// Event-synced URLs from the live page only update React state for the
// address bar — never `src`. Keying or re-setting `src` from the synced URL
// makes the webview re-navigate to the page it just reached: an endless
// reload loop (especially on SPAs, redirects, and title updates).
function BrowserWebview({
  tab,
  reloadKey,
  onLoadingChange,
  onNavigated,
  registerRef,
}: {
  tab: BrowserTab;
  reloadKey: number;
  onLoadingChange: (loading: boolean, tabId?: string) => void;
  onNavigated: (url: string, title?: string, tabId?: string) => void;
  registerRef: (el: ElectronWebview | null) => void;
}) {
  const ref = useRef<ElectronWebview | null>(null);
  // Committed src for this mount — updated only for explicit navigations.
  const committedSrc = useRef(tab.url);
  const lastNav = useRef({ id: tab.id, key: reloadKey });
  if (lastNav.current.id !== tab.id || lastNav.current.key !== reloadKey) {
    lastNav.current = { id: tab.id, key: reloadKey };
    committedSrc.current = tab.url;
  }
  const onLoadingChangeRef = useRef(onLoadingChange);
  onLoadingChangeRef.current = onLoadingChange;
  const onNavigatedRef = useRef(onNavigated);
  onNavigatedRef.current = onNavigated;
  const registerRefRef = useRef(registerRef);
  registerRefRef.current = registerRef;
  const lastSynced = useRef({ url: tab.url, title: tab.title });
  if (lastSynced.current.url !== tab.url && lastNav.current.key === reloadKey) {
    // Keep the guard in sync when the parent commits a new explicit URL.
    lastSynced.current = { url: tab.url, title: tab.title };
  }

  useEffect(() => {
    registerRefRef.current(ref.current);
    return () => registerRefRef.current(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const ownId = lastNav.current.id;
    const emitLoading = (loading: boolean) => onLoadingChangeRef.current(loading, ownId);
    const handleLoadStart = () => emitLoading(true);
    const handleLoadStop = () => emitLoading(false);
    const handleNavigate = (event: { url?: string }) => {
      let currentUrl: string | undefined;
      try {
        currentUrl = el.getURL?.() || event.url;
      } catch {
        currentUrl = event.url;
      }
      if (!currentUrl) return;
      if (lastSynced.current.url === currentUrl) {
        emitLoading(false);
        return;
      }
      lastSynced.current = { url: currentUrl, title: lastSynced.current.title };
      onNavigatedRef.current(currentUrl, undefined, ownId);
    };
    const handleTitle = (event: { title?: string }) => {
      if (!event.title) return;
      let currentUrl: string;
      try {
        currentUrl = el.getURL?.() || committedSrc.current;
      } catch {
        currentUrl = committedSrc.current;
      }
      if (lastSynced.current.url === currentUrl && lastSynced.current.title === event.title) return;
      lastSynced.current = { url: currentUrl, title: event.title };
      onNavigatedRef.current(currentUrl, event.title, ownId);
    };
    el.addEventListener("did-start-loading", handleLoadStart);
    el.addEventListener("did-stop-loading", handleLoadStop);
    el.addEventListener("did-fail-load", handleLoadStop);
    el.addEventListener("did-navigate", handleNavigate);
    el.addEventListener("did-navigate-in-page", handleNavigate);
    el.addEventListener("page-title-set", handleTitle as never);
    el.addEventListener("page-title-updated", handleTitle as never);
    return () => {
      el.removeEventListener("did-start-loading", handleLoadStart as never);
      el.removeEventListener("did-stop-loading", handleLoadStop as never);
      el.removeEventListener("did-fail-load", handleLoadStop as never);
      el.removeEventListener("did-navigate", handleNavigate as never);
      el.removeEventListener("did-navigate-in-page", handleNavigate as never);
      el.removeEventListener("page-title-set", handleTitle as never);
      el.removeEventListener("page-title-updated", handleTitle as never);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id, reloadKey]);

  return (
    <webview
      key={`wv-${tab.id}-${reloadKey}`}
      ref={ref as never}
      src={committedSrc.current}
      useragent={CHROME_DESKTOP_UA}
      className="browser-iframe"
      partition="persist:browser"
      webpreferences="contextIsolation=yes"
    />
  );
}
