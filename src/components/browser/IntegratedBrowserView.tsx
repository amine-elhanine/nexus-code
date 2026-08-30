import React, { useState, useEffect, useRef } from "react";
import {
  Globe, ArrowLeft, ArrowRight, RefreshCw, ExternalLink, Smartphone,
  Tablet, Monitor, Laptop, Play, Server, MessageSquare, ChevronDown, Check,
  Plus, X, Copy, Home, Search, BookOpen, Compass, Shield
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

  const activeTab = tabs.find((t) => t.id === activeTabId) || tabs[0];

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

  const handleBack = () => {
    if (activeTab.historyIndex > 0) {
      const newIndex = activeTab.historyIndex - 1;
      const prevUrl = activeTab.history[newIndex];
      setTabs((prev) =>
        prev.map((t) =>
          t.id === activeTab.id
            ? {
                ...t,
                url: prevUrl,
                inputUrl: prevUrl,
                title: getTitleFromUrl(prevUrl),
                historyIndex: newIndex,
                isLoading: true,
              }
            : t
        )
      );
      setReloadKey((k) => k + 1);
    }
  };

  const handleForward = () => {
    if (activeTab.historyIndex < activeTab.history.length - 1) {
      const newIndex = activeTab.historyIndex + 1;
      const nextUrl = activeTab.history[newIndex];
      setTabs((prev) =>
        prev.map((t) =>
          t.id === activeTab.id
            ? {
                ...t,
                url: nextUrl,
                inputUrl: nextUrl,
                title: getTitleFromUrl(nextUrl),
                historyIndex: newIndex,
                isLoading: true,
              }
            : t
        )
      );
      setReloadKey((k) => k + 1);
    }
  };

  const handleReload = () => {
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
        </div>
      </div>

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
            <webview
              key={`${activeTab.id}-${reloadKey}`}
              src={activeTab.url}
              useragent={CHROME_DESKTOP_UA}
              className="browser-iframe"
              allowpopups={true}
              partition="persist:browser"
              webpreferences="contextIsolation=yes"
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
