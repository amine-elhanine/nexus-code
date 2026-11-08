import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  Code2,
  FolderPlus,
  GitCompare,
  Globe,
  HardDrive,
  Keyboard,
  MessageSquare,
  Palette,
  PanelLeft,
  PanelRight,
  Plus,
  Search,
  Settings,
  Sparkles,
  Terminal,
  Wrench,
} from "lucide-react";

export interface CommandPaletteSessionItem {
  id: string;
  title?: string;
  name?: string;
  messages?: unknown[];
}

export interface CommandPaletteNotebookItem {
  id: string;
  name: string;
  sources?: unknown[];
  artifacts?: unknown[];
}

export interface CommandPaletteAction {
  id: string;
  group: string;
  label: string;
  subtitle?: string;
  shortcut?: string;
  icon: React.ReactNode;
  onSelect: () => void;
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  mainArea: "home" | "code" | "notebook";
  onSwitchArea: (area: "home" | "code" | "notebook") => void;
  onNewHomeChat: () => void;
  onNewCodeSession: () => void;
  onNewNotebook: () => void;
  onOpenProject: () => void;
  onToggleLeftSidebar: () => void;
  onToggleRightDrawer: () => void;
  onOpenContextTab: (tab: "diff" | "terminal" | "browser" | "memory" | "artifacts") => void;
  onOpenSettingsSection: (section?: string) => void;
  sessions: CommandPaletteSessionItem[];
  homeSessions: CommandPaletteSessionItem[];
  notebooks: CommandPaletteNotebookItem[];
  onSelectCodeSession: (id: string) => void;
  onSelectHomeSession: (id: string) => void;
  onSelectNotebook: (id: string) => void;
}

export function CommandPalette({
  open,
  onClose,
  mainArea,
  onSwitchArea,
  onNewHomeChat,
  onNewCodeSession,
  onNewNotebook,
  onOpenProject,
  onToggleLeftSidebar,
  onToggleRightDrawer,
  onOpenContextTab,
  onOpenSettingsSection,
  sessions,
  homeSessions,
  notebooks,
  onSelectCodeSession,
  onSelectHomeSession,
  onSelectNotebook,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const actions = useMemo<CommandPaletteAction[]>(() => {
    const base: CommandPaletteAction[] = [
      // Mode Switching
      {
        id: "mode-home",
        group: "Modes",
        label: "Switch to Home (ChatGPT Mode)",
        subtitle: mainArea === "home" ? "Currently active" : "Conversation-first AI assistant, web research & canvas",
        shortcut: "Ctrl+1",
        icon: <Sparkles size={15} />,
        onSelect: () => onSwitchArea("home"),
      },
      {
        id: "mode-code",
        group: "Modes",
        label: "Switch to Code (Codex Mode)",
        subtitle: mainArea === "code" ? "Currently active" : "Agentic coding workspace, diff review & terminal",
        shortcut: "Ctrl+2",
        icon: <Code2 size={15} />,
        onSelect: () => onSwitchArea("code"),
      },
      {
        id: "mode-notebook",
        group: "Modes",
        label: "Switch to Notebook (NotebookLM Studio)",
        subtitle: mainArea === "notebook" ? "Currently active" : "Source-grounded Q&A, citations & studio generators",
        shortcut: "Ctrl+3",
        icon: <BookOpen size={15} />,
        onSelect: () => onSwitchArea("notebook"),
      },

      // Quick Actions
      {
        id: "act-new-chat",
        group: "Quick Actions",
        label: "New Home Conversation",
        subtitle: "Start a fresh ChatGPT-style conversation in Home mode",
        shortcut: "Ctrl+N",
        icon: <Plus size={15} />,
        onSelect: () => {
          onSwitchArea("home");
          onNewHomeChat();
        },
      },
      {
        id: "act-new-task",
        group: "Quick Actions",
        label: "New Coding Task Thread",
        subtitle: "Launch a new Codex agent session in the active repository",
        icon: <Code2 size={15} />,
        onSelect: () => {
          onSwitchArea("code");
          onNewCodeSession();
        },
      },
      {
        id: "act-new-notebook",
        group: "Quick Actions",
        label: "Create New Notebook",
        subtitle: "Create a source-grounded research notebook",
        icon: <BookOpen size={15} />,
        onSelect: () => {
          onSwitchArea("notebook");
          onNewNotebook();
        },
      },
      {
        id: "act-open-repo",
        group: "Quick Actions",
        label: "Open Repository Folder...",
        subtitle: "Add or switch to a local codebase directory",
        icon: <FolderPlus size={15} />,
        onSelect: () => {
          onSwitchArea("code");
          onOpenProject();
        },
      },
      {
        id: "act-toggle-left",
        group: "Workspace Panels",
        label: "Toggle Left Sidebar",
        subtitle: "Show or hide the navigation & history rail",
        shortcut: "Ctrl+B",
        icon: <PanelLeft size={15} />,
        onSelect: onToggleLeftSidebar,
      },
      {
        id: "act-toggle-right",
        group: "Workspace Panels",
        label: "Toggle Right Inspector Drawer",
        subtitle: "Show or hide the context inspector panel",
        shortcut: "Ctrl+J",
        icon: <PanelRight size={15} />,
        onSelect: onToggleRightDrawer,
      },
      {
        id: "panel-diff",
        group: "Workspace Panels",
        label: "Open Diff Viewer",
        subtitle: "Review inline and side-by-side split file changes",
        icon: <GitCompare size={15} />,
        onSelect: () => {
          onSwitchArea("code");
          onOpenContextTab("diff");
        },
      },
      {
        id: "panel-terminal",
        group: "Workspace Panels",
        label: "Open Integrated Terminal",
        subtitle: "Interactive PTY shell and command output",
        icon: <Terminal size={15} />,
        onSelect: () => {
          onSwitchArea("code");
          onOpenContextTab("terminal");
        },
      },
      {
        id: "panel-browser",
        group: "Workspace Panels",
        label: "Open Integrated Browser",
        subtitle: "Live preview and web inspection drawer",
        icon: <Globe size={15} />,
        onSelect: () => onOpenContextTab("browser"),
      },

      // Settings Sections
      {
        id: "set-appearance",
        group: "Settings",
        label: "Settings: Appearance & Themes",
        subtitle: "Switch between 10 dark and warm daylight palettes",
        shortcut: "Ctrl+,",
        icon: <Palette size={15} />,
        onSelect: () => onOpenSettingsSection("appearance"),
      },
      {
        id: "set-providers",
        group: "Settings",
        label: "Settings: AI Providers & Models",
        subtitle: "Configure OpenAI, Anthropic, Gemini, Ollama & custom endpoints",
        icon: <Wrench size={15} />,
        onSelect: () => onOpenSettingsSection("providers"),
      },
      {
        id: "set-shortcuts",
        group: "Settings",
        label: "Settings: Keyboard Shortcuts",
        subtitle: "View all workspace and composer keybindings",
        icon: <Keyboard size={15} />,
        onSelect: () => onOpenSettingsSection("shortcuts"),
      },
      {
        id: "set-storage",
        group: "Settings",
        label: "Settings: Data & Storage",
        subtitle: "Manage Nexus workspace folder, local database, and exports",
        icon: <HardDrive size={15} />,
        onSelect: () => onOpenSettingsSection("storage"),
      },
      {
        id: "set-general",
        group: "Settings",
        label: "Open All Settings",
        subtitle: "MCP servers, skills, marketplace, rules, daemons & updates",
        icon: <Settings size={15} />,
        onSelect: () => onOpenSettingsSection("appearance"),
      },
    ];

    // Add recent Home conversations
    for (const s of homeSessions.slice(0, 5)) {
      base.push({
        id: `home-sess-${s.id}`,
        group: "Recent Conversations",
        label: s.title || s.name || "Untitled chat",
        subtitle: `Home Chat · ${s.messages?.length || 0} messages`,
        icon: <MessageSquare size={14} />,
        onSelect: () => {
          onSwitchArea("home");
          onSelectHomeSession(s.id);
        },
      });
    }

    // Add recent Code sessions
    for (const s of sessions.slice(0, 5)) {
      base.push({
        id: `code-sess-${s.id}`,
        group: "Recent Coding Tasks",
        label: s.title || s.name || "Untitled task",
        subtitle: `Code Mode · ${s.messages?.length || 0} turns`,
        icon: <Code2 size={14} />,
        onSelect: () => {
          onSwitchArea("code");
          onSelectCodeSession(s.id);
        },
      });
    }

    // Add recent Notebooks
    for (const nb of notebooks.slice(0, 5)) {
      base.push({
        id: `nb-${nb.id}`,
        group: "Notebooks",
        label: nb.name,
        subtitle: `Notebook · ${nb.sources?.length ?? 0} sources`,
        icon: <BookOpen size={14} />,
        onSelect: () => {
          onSwitchArea("notebook");
          onSelectNotebook(nb.id);
        },
      });
    }

    const q = query.trim().toLowerCase();
    if (!q) return base;
    return base.filter(
      (item) =>
        item.label.toLowerCase().includes(q) ||
        item.group.toLowerCase().includes(q) ||
        (item.subtitle && item.subtitle.toLowerCase().includes(q)),
    );
  }, [
    query,
    mainArea,
    onSwitchArea,
    onNewHomeChat,
    onNewCodeSession,
    onNewNotebook,
    onOpenProject,
    onToggleLeftSidebar,
    onToggleRightDrawer,
    onOpenContextTab,
    onOpenSettingsSection,
    sessions,
    homeSessions,
    notebooks,
    onSelectCodeSession,
    onSelectHomeSession,
    onSelectNotebook,
  ]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  if (!open) return null;

  const grouped = actions.reduce<Record<string, CommandPaletteAction[]>>((acc, item) => {
    (acc[item.group] ||= []).push(item);
    return acc;
  }, {});

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => (actions.length ? (prev + 1) % actions.length : 0));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => (actions.length ? (prev - 1 + actions.length) % actions.length : 0));
      return;
    }
    if (e.key === "Enter" && actions[selectedIndex]) {
      e.preventDefault();
      const target = actions[selectedIndex];
      onClose();
      target.onSelect();
    }
  };

  let flatCursor = -1;

  return (
    <div className="cmdk-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label="Command Palette">
      <div className="cmdk-modal" onClick={(e) => e.stopPropagation()} onKeyDown={handleKeyDown}>
        <div className="cmdk-search-bar">
          <Search size={17} className="cmdk-search-icon" />
          <input
            ref={inputRef}
            type="text"
            className="cmdk-search-input"
            placeholder="Type a command, switch modes, or search conversations & notebooks..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="button" className="cmdk-esc-badge" onClick={onClose}>
            ESC
          </button>
        </div>

        <div className="cmdk-list">
          {actions.length === 0 ? (
            <div style={{ padding: "28px 16px", textAlign: "center", color: "var(--text-tertiary)", fontSize: 12.5 }}>
              No matching commands, conversations, or notebooks found for "{query}".
            </div>
          ) : (
            Object.entries(grouped).map(([groupName, groupItems]) => (
              <div key={groupName}>
                <div className="cmdk-group-title">{groupName}</div>
                {groupItems.map((item) => {
                  flatCursor += 1;
                  const idx = flatCursor;
                  const isSelected = idx === selectedIndex;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={`cmdk-item ${isSelected ? "selected" : ""}`}
                      onMouseEnter={() => setSelectedIndex(idx)}
                      onClick={() => {
                        onClose();
                        item.onSelect();
                      }}
                    >
                      <span className="cmdk-item-icon">{item.icon}</span>
                      <span className="cmdk-item-main">
                        <span className="cmdk-item-label">{item.label}</span>
                        {item.subtitle && <span className="cmdk-item-sub">{item.subtitle}</span>}
                      </span>
                      {item.shortcut && <kbd className="cmdk-item-shortcut">{item.shortcut}</kbd>}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="cmdk-footer">
          <div className="cmdk-footer-hints">
            <span>
              <kbd>↑↓</kbd> Navigate
            </span>
            <span>
              <kbd>↵</kbd> Execute
            </span>
            <span>
              <kbd>ESC</kbd> Close
            </span>
          </div>
          <span>Nexus Command Palette</span>
        </div>
      </div>
    </div>
  );
}
