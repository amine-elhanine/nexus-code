import React, { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, RefreshCw, Globe, X, MessageSquare, Play, Plus, Bot } from "lucide-react";
import { CHROME_DESKTOP_UA } from "./ua.js";

type MiniWebview = {
  loadURL: (url: string) => Promise<void>;
  goBack: () => void;
  goForward: () => void;
  reload: () => void;
  getURL: () => string;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  addEventListener: (type: string, listener: (event?: { url?: string; title?: string }) => void) => void;
  removeEventListener: (type: string, listener: (event?: never) => void) => void;
};

type DaemonServer = { id: string; name: string; port: number; url: string; command: string };

type SideTab = {
  id: string;
  title: string;
  url: string;
  inputUrl: string;
  loading: boolean;
  isAgent: boolean;
};

const AGENT_TAB_ID = "agent-tab";
const NEW_TAB_URL = "https://www.google.com";
const MAX_USER_TABS = 7;

// Per-browser persisted state, keyed by scope ("home" | "code"). React
// reuses same-type components at the same tree position across renders —
// without this (plus distinct keys), switching areas would keep ONE shared
// tab state instead of two independent browsers.
type PersistedBrowser = { tabs: SideTab[]; activeTabId: string };
const browsersByScope: Record<string, PersistedBrowser> = {};
const mirroredByScope: Record<string, string | null> = {};
// Last agent-viewed URL per session: each chat's agent page memory, feeding
// the agent tab on mount and on chat switches within a mode.
const lastAgentUrlBySession: Record<string, string> = {};

function resolveMiniUrl(input: string): string {
  const query = input.trim();
  if (!query) return NEW_TAB_URL;
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

function titleFor(url: string, isAgent: boolean): string {
  if (isAgent) return url === "about:blank" ? "Agent" : `Agent: ${shortHost(url)}`;
  return shortHost(url);
}

// Tabbed mini browser for the sidebar. The pinned Agent tab belongs to the
// agent: its navigations land there and never touch your tabs. In Watching
// mode the view flips to the agent tab automatically; otherwise a Follow
// banner offers it. Every tab keeps its own mounted webview (agent included),
// so switching tabs never reloads pages and the agent keeps working while
// you browse elsewhere.
export const SidebarBrowser: React.FC<{
  sessionId?: string | null;
  /** Which browser this is: separate partitions, separate jars. */
  browserScope: "home" | "code";
  projectRoot?: string;
  files?: Array<{ path: string; kind: "file" | "folder" }>;
  onSendToAgent?: (prompt: string) => void;
  onAgentNavigate?: () => void;
}> = ({ sessionId, browserScope, projectRoot, files = [], onSendToAgent, onAgentNavigate }) => {
  const makeTab = (id: string, url: string, isAgent: boolean): SideTab => ({
    id,
    title: titleFor(url, isAgent),
    url,
    inputUrl: url,
    loading: false,
    isAgent,
  });

  const firstUserTabId = useRef(`tab-${Date.now()}`).current;
  const sessionKey = sessionId || "none";
  const [tabs, setTabs] = useState<SideTab[]>(() => {
    const saved = browsersByScope[browserScope];
    if (saved) return saved.tabs;
    return [
      makeTab(AGENT_TAB_ID, lastAgentUrlBySession[sessionKey] || "about:blank", true),
      makeTab(firstUserTabId, NEW_TAB_URL, false),
    ];
  });
  const [activeTabId, setActiveTabId] = useState<string>(() => {
    const saved = browsersByScope[browserScope];
    if (saved && saved.tabs.some((t) => t.id === saved.activeTabId)) return saved.activeTabId;
    return firstUserTabId;
  });
  // Remount epoch per tab: only user/agent-initiated navigations remount the
  // webview (fresh src). Event-driven syncs (link clicks, SPA navs, titles)
  // update state WITHOUT remounting, or pages would reload in a loop.
  const [navEpoch, setNavEpoch] = useState<Record<string, number>>({});
  const [headless, setHeadless] = useState(true);
  const [agentBanner, setAgentBanner] = useState<string | null>(null);
  const [servers, setServers] = useState<DaemonServer[]>([]);
  const [startingServer, setStartingServer] = useState(false);
  const webviews = useRef<Record<string, MiniWebview | null>>({});

  const headlessRef = useRef(true);
  const sessionIdRef = useRef(sessionId);
  const onAgentNavigateRef = useRef<(() => void) | undefined>(undefined);
  headlessRef.current = headless;
  sessionIdRef.current = sessionId;
  onAgentNavigateRef.current = onAgentNavigate;

  // Persist this browser's tabs so a trip to the other mode (which unmounts
  // this instance) restores them on return — per scope, never shared.
  useEffect(() => {
    browsersByScope[browserScope] = { tabs, activeTabId };
  }, [browserScope, tabs, activeTabId]);

  const activeTab = tabs.find((t) => t.id === activeTabId) || tabs[0];

  function patchTab(tabId: string, patch: Partial<SideTab>) {
    setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, ...patch } : t)));
  }

  function bumpEpoch(tabId: string) {
    setNavEpoch((prev) => ({ ...prev, [tabId]: (prev[tabId] || 0) + 1 }));
  }

  function navigateTab(tabId: string, raw: string) {
    const finalUrl = resolveMiniUrl(raw);
    bumpEpoch(tabId);
    if (tabId === AGENT_TAB_ID) {
      // User took the wheel on the agent tab — next agent load re-syncs it.
      mirroredByScope[browserScope] = null;
    }
    patchTab(tabId, { url: finalUrl, inputUrl: finalUrl, title: titleFor(finalUrl, tabId === AGENT_TAB_ID), loading: true });
  }

  function newTab() {
    const userTabs = tabs.filter((t) => !t.isAgent).length;
    if (userTabs >= MAX_USER_TABS) return;
    const tab = makeTab(`tab-${Date.now()}`, NEW_TAB_URL, false);
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
  }

  function closeTab(tabId: string) {
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab || tab.isAgent) return; // agent tab is pinned
    const rest = tabs.filter((t) => t.id !== tabId);
    setTabs(rest);
    if (activeTabId === tabId && rest.length) {
      setActiveTabId(rest[rest.length - 1].id);
    }
    delete webviews.current[tabId];
  }

  function goActive(delta: -1 | 1) {
    const wv = webviews.current[activeTab.id];
    if (!wv) return;
    if (delta === -1 && wv.canGoBack()) wv.goBack();
    else if (delta === 1 && wv.canGoForward()) wv.goForward();
  }

  function reloadActive() {
    webviews.current[activeTab.id]?.reload();
  }

  async function startDevServer() {
    const api = window.forgepilot as unknown as {
      startDaemon?: (name: string, command: string, cwd?: string) => Promise<unknown>;
    };
    if (typeof api.startDaemon !== "function") return;
    setStartingServer(true);
    try {
      const packageFiles = files.filter((file) => file.kind === "file" && /(^|\/)package\.json$/i.test(file.path));
      const rootPackage = packageFiles.find((file) => file.path === "package.json");
      const packagePath = rootPackage?.path || packageFiles.sort((a, b) => a.path.split("/").length - b.path.split("/").length)[0]?.path;
      const packageDir = packagePath ? packagePath.slice(0, packagePath.lastIndexOf("/")) : "";
      const command = packageDir
        ? `npm --prefix "${packageDir}" run dev`
        : "npm run dev";
      await api.startDaemon("Dev Server", command, projectRoot || "");
    } catch { /* error surfaces in Services dialog */ }
    setStartingServer(false);
  }

  // Daemons + headless preference + agent activity subscription.
  useEffect(() => {
    const api = window.forgepilot as unknown as {
      listDaemons?: () => Promise<Array<{ id: string; name: string; status: string; port?: number; command: string }>>;
      getBrowserHeadless?: () => Promise<boolean>;
      onBrowserAgentActivity?: (listener: (payload: { url: string; timestamp: string; autoFollow?: boolean; sessionId?: string }) => void) => () => void;
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
      }).catch(() => {});
    }
    let unsubscribe: (() => void) | undefined;
    if (typeof api.onBrowserAgentActivity === "function") {
      unsubscribe = api.onBrowserAgentActivity((payload) => {
        if (!payload?.url) return;
        // Foreign sessions never touch this browser: each chat owns its
        // agent page, so a background run from another chat/area is ignored
        // here (its own sidebar mirrors it when mounted).
        if (payload.sessionId && payload.sessionId !== sessionIdRef.current) return;
        lastAgentUrlBySession[sessionIdRef.current || "none"] = payload.url;
        // Only page loads mirror into the agent tab — clicks/fills/etc. show
        // in the chat transcript; remounting on those would just flash.
        if (!payload.autoFollow) return;
        if (mirroredByScope[browserScope] !== payload.url) {
          mirroredByScope[browserScope] = payload.url;
          bumpEpoch(AGENT_TAB_ID);
          setTabs((prev) =>
            prev.map((t) =>
              t.isAgent ? { ...t, url: payload.url, inputUrl: payload.url, title: titleFor(payload.url, true), loading: true } : t
            )
          );
        }
        if (!headlessRef.current) {
          // Watching: flip to the agent tab so you see it work.
          setActiveTabId(AGENT_TAB_ID);
          onAgentNavigateRef.current?.();
        } else {
          setAgentBanner(payload.url);
        }
      });
    }
    return () => {
      clearInterval(interval);
      unsubscribe?.();
    };
  }, []);

  // Switching chats swaps the agent tab to that chat's own agent page (or a
  // blank tab for chats the agent never browsed in) — never another chat's.
  useEffect(() => {
    const remembered = lastAgentUrlBySession[sessionKey];
    if (!remembered) return;
    mirroredByScope[browserScope] = remembered;
    bumpEpoch(AGENT_TAB_ID);
    setTabs((prev) =>
      prev.map((t) =>
        t.isAgent ? { ...t, url: remembered, inputUrl: remembered, title: titleFor(remembered, true), loading: true } : t
      )
    );
    setAgentBanner(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey]);

  return (
    <div className="side-browser">
      <div className="side-browser-tabs" role="tablist" aria-label="Browser tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={tab.id === activeTabId}
            className={`side-tab${tab.id === activeTabId ? " active" : ""}${tab.isAgent ? " agent" : ""}`}
            onClick={() => {
              setActiveTabId(tab.id);
              if (tab.isAgent) setAgentBanner(null);
            }}
            title={tab.isAgent ? `Agent tab — ${tab.url}` : tab.url}
          >
            {tab.isAgent ? <Bot size={11} /> : <Globe size={11} />}
            <span>{tab.title}</span>
            {!tab.isAgent && tabs.length > 1 && (
              <i
                className="side-tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.id);
                }}
                title="Close tab"
              >
                <X size={10} />
              </i>
            )}
          </button>
        ))}
        <button
          type="button"
          className="side-tab-new"
          onClick={newTab}
          disabled={tabs.filter((t) => !t.isAgent).length >= MAX_USER_TABS}
          title="New tab"
        >
          <Plus size={12} />
        </button>
      </div>

      {agentBanner && activeTabId !== AGENT_TAB_ID && (
        <div className="browser-agent-banner">
          <span className="status-dot running" style={{ width: 6, height: 6 }} />
          <span>Agent: {shortHost(agentBanner)}</span>
          <button
            type="button"
            className="browser-btn highlight"
            onClick={() => {
              setActiveTabId(AGENT_TAB_ID);
              setAgentBanner(null);
              onAgentNavigateRef.current?.();
            }}
            title={`See what the agent is doing at ${agentBanner}`}
          >
            <span>Follow</span>
          </button>
          <button type="button" className="browser-btn icon-only" onClick={() => setAgentBanner(null)} title="Dismiss">
            <X size={11} />
          </button>
        </div>
      )}

      <form
        className="side-browser-bar"
        onSubmit={(e) => {
          e.preventDefault();
          navigateTab(activeTab.id, activeTab.inputUrl);
        }}
      >
        <button type="button" className="browser-btn icon-only" onClick={() => goActive(-1)} title="Back">
          <ArrowLeft size={13} />
        </button>
        <button type="button" className="browser-btn icon-only" onClick={() => goActive(1)} title="Forward">
          <ArrowRight size={13} />
        </button>
        <button type="button" className="browser-btn icon-only" onClick={reloadActive} title="Reload">
          <RefreshCw size={13} className={activeTab.loading ? "spin" : ""} />
        </button>
        {onSendToAgent && (
          <button
            type="button"
            className="browser-btn icon-only"
            onClick={() =>
              onSendToAgent(
                `Inspect and test the running web page at ${activeTab.url} (${activeTab.title}). Verify layout, check console errors or unexpected visual bugs, and validate features.`
              )
            }
            title="Ask the agent about this page"
          >
            <MessageSquare size={13} />
          </button>
        )}
        <input
          type="text"
          value={activeTab.inputUrl}
          onChange={(e) => patchTab(activeTab.id, { inputUrl: e.target.value })}
          placeholder="Search or enter address"
          spellCheck={false}
        />
      </form>

      {servers.length > 0 ? (
        <div className="side-browser-servers">
          {servers.map((srv) => (
            <button key={srv.id} type="button" className="bookmark-chip server-chip" onClick={() => navigateTab(activeTab.id, srv.url)} title={srv.command}>
              <span className="status-dot running" style={{ width: 6, height: 6 }} />
              <span>:{srv.port}</span>
            </button>
          ))}
        </div>
      ) : (
        projectRoot && (
          <div className="side-browser-servers">
            <button
              type="button"
              className="bookmark-chip server-chip"
              onClick={() => void startDevServer()}
              title="Start npm run dev as a background service"
            >
              <Play size={11} />
              <span>{startingServer ? "Starting…" : "Run project"}</span>
            </button>
          </div>
        )
      )}

      <div className="side-browser-view">
        {tabs.map((tab) => (
          <SideTabWebview
            key={`${tab.id}-${navEpoch[tab.id] || 0}`}
            tab={tab}
            visible={tab.id === activeTabId}
            partition={browserScope === "home" ? "persist:browser-home" : "persist:browser-code"}
            registerRef={(el) => {
              webviews.current[tab.id] = el;
            }}
            onEvent={(patch) => patchTab(tab.id, patch)}
          />
        ))}
      </div>
    </div>
  );
};

// One mounted webview per tab (CSS-hidden when inactive): pages keep their
// state, the agent tab keeps working while you browse elsewhere, and
// did-navigate events keep each tab's address bar truthful.
//
// Critical: the webview's committed `src` is captured ONCE per mount
// (explicit user/agent navigations remount via the nav-epoch key above).
// Event-synced URLs (link clicks, SPA pushState, title updates) only update
// React state for the address bar — they are NEVER fed back into `src`.
// Feeding them back makes the webview re-navigate to the page it just
// reached, which reloads forever.
function SideTabWebview({
  tab,
  visible,
  partition,
  registerRef,
  onEvent,
}: {
  tab: SideTab;
  visible: boolean;
  partition: string;
  registerRef: (el: MiniWebview | null) => void;
  onEvent: (patch: Partial<SideTab>) => void;
}) {
  const ref = useRef<MiniWebview | null>(null);
  // Committed on mount only — epoch bumps remount for explicit navigations.
  const committedSrc = useRef(tab.url);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const isAgentRef = useRef(tab.isAgent);
  isAgentRef.current = tab.isAgent;
  // Last URL/title already synced to state — skips no-op updates so a chatty
  // page (title flips, same-document navs) can't cause a render/reload storm.
  const lastSynced = useRef<{ url: string; title: string }>({ url: tab.url, title: tab.title });

  useEffect(() => {
    registerRef(ref.current);
    return () => registerRef(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync state from the live page: link clicks, JS navigations, titles.
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const emit = (patch: Partial<SideTab>) => onEventRef.current(patch);
    const onStart = () => emit({ loading: true });
    const onStop = () => emit({ loading: false });
    const onNav = (event?: { url?: string; title?: string }) => {
      let currentUrl: string | undefined;
      try {
        currentUrl = el.getURL?.() || event?.url;
      } catch {
        currentUrl = event?.url;
      }
      if (currentUrl) {
        const nextTitle = event?.title || titleFor(currentUrl, isAgentRef.current);
        const prev = lastSynced.current;
        if (prev.url === currentUrl && prev.title === nextTitle) return;
        lastSynced.current = { url: currentUrl, title: nextTitle };
        emit({ loading: false, url: currentUrl, inputUrl: currentUrl, title: nextTitle });
      } else if (event?.title) {
        if (lastSynced.current.title === event.title) return;
        lastSynced.current = { url: lastSynced.current.url, title: event.title };
        emit({ loading: false, title: event.title });
      } else {
        emit({ loading: false });
      }
    };
    el.addEventListener("did-start-loading", onStart);
    el.addEventListener("did-stop-loading", onStop);
    el.addEventListener("did-fail-load", onStop);
    el.addEventListener("did-navigate", onNav);
    el.addEventListener("did-navigate-in-page", onNav);
    el.addEventListener("page-title-updated", onNav as never);
    return () => {
      el.removeEventListener("did-start-loading", onStart as never);
      el.removeEventListener("did-stop-loading", onStop as never);
      el.removeEventListener("did-fail-load", onStop as never);
      el.removeEventListener("did-navigate", onNav as never);
      el.removeEventListener("did-navigate-in-page", onNav as never);
      el.removeEventListener("page-title-updated", onNav as never);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id]);

  // Remounts (epoch bumps from user/agent navigations) arrive with a fresh
  // src on first render — no sync-back needed afterwards.
  if (typeof window === "undefined" || (!window.nexus && !window.forgepilot)) {
    return (
      <div className="empty-pane" style={{ display: visible ? undefined : "none" }}>
        <Globe size={16} />
        <span>Browser unavailable.</span>
      </div>
    );
  }

  return (
    <webview
      ref={ref as never}
      src={committedSrc.current}
      useragent={CHROME_DESKTOP_UA}
      className="browser-iframe"
      partition={partition}
      webpreferences="contextIsolation=yes"
      style={{ display: visible ? undefined : "none", flex: visible ? 1 : undefined }}
    />
  );
}


