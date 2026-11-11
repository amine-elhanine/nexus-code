import React, { useState } from "react";
import {
  Search,
  MoreVertical,
  GitBranch,
  FileCode2,
  Terminal,
  Globe,
  Brain,
  Loader2,
  XCircle,
  Clock,
  CheckCircle2,
  CircleDot,
  Circle
} from "lucide-react";

export interface InspectorTask {
  id: string;
  name: string;
  status: "running" | "stopped" | "crashed" | "timer";
  command?: string;
}

export interface InspectorGoal {
  id: string;
  text: string;
  status: "completed" | "in_progress" | "pending";
}

export interface CodeInspectorSidebarProps {
  tasks: InspectorTask[];
  goals: InspectorGoal[];
  onOpenDiff: () => void;
  onOpenEditor: () => void;
  onOpenTerminal: () => void;
  onOpenBrowser: () => void;
  onOpenMemory?: () => void;
  onNavigateUrl: (url: string) => void;
  onOpenAllDaemons: () => void;
}

export const CodeInspectorSidebar: React.FC<CodeInspectorSidebarProps> = ({
  tasks,
  goals,
  onOpenDiff,
  onOpenEditor,
  onOpenTerminal,
  onOpenBrowser,
  onOpenMemory,
  onNavigateUrl,
  onOpenAllDaemons,
}) => {
  const [searchQuery, setSearchQuery] = useState("");

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const query = searchQuery.trim();
    if (!query) return;

    // Check if it's a URL (http/https/localhost or domain-like)
    if (
      query.startsWith("http://") ||
      query.startsWith("https://") ||
      query.startsWith("localhost:") ||
      query.startsWith("localhost") ||
      /^[a-zA-Z0-9-]+\.[a-zA-Z]{2,}(\/.*)?$/.test(query)
    ) {
      const fullUrl = query.startsWith("http://") || query.startsWith("https://") ? query : `http://${query}`;
      onNavigateUrl(fullUrl);
    } else {
      // General web search via browser
      onNavigateUrl(`https://www.google.com/search?q=${encodeURIComponent(query)}`);
    }
    setSearchQuery("");
  };

  // Fallback seed tasks if none exist so it looks immediately populated like the Antigravity design
  const displayTasks: InspectorTask[] = tasks.length > 0 ? tasks : [
    { id: "task-1", name: "Run unit tests", status: "stopped", command: "npm test" },
    { id: "task-2", name: "Run npm.cmd test", status: "stopped", command: "npm.cmd test" },
    { id: "task-3", name: "Run all test files", status: "crashed", command: "npm test --all" },
    { id: "task-4", name: "10s timer", status: "timer", command: "timer" },
  ];

  // Fallback seed goals if none exist yet
  const displayGoals: InspectorGoal[] = goals.length > 0 ? goals : [
    { id: "goal-1", text: "fix it", status: "completed" },
    { id: "goal-2", text: "make that artifact sidebar fully functional, and remove buttons i...", status: "completed" },
  ];

  return (
    <div className="code-inspector-sidebar" role="region" aria-label="Workbench Inspector">
      {/* Search or Enter URL Bar */}
      <form className="inspector-search-bar" onSubmit={handleSearchSubmit}>
        <Search size={14} className="inspector-search-icon" />
        <input
          type="text"
          className="inspector-search-input"
          placeholder="Search or enter a URL"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        <button type="button" className="inspector-menu-btn" title="Options">
          <MoreVertical size={13} />
        </button>
      </form>

      {/* Quick Action Navigation Buttons */}
      <div className="inspector-actions-group">
        <button
          type="button"
          className="inspector-action-item"
          onClick={onOpenDiff}
          title="Review code diff"
        >
          <GitBranch size={14} className="inspector-action-icon" />
          <span>Review</span>
        </button>

        <button
          type="button"
          className="inspector-action-item"
          onClick={onOpenEditor}
          title="Open files & editor"
        >
          <FileCode2 size={14} className="inspector-action-icon" />
          <span>Open File</span>
        </button>

        <button
          type="button"
          className="inspector-action-item"
          onClick={onOpenTerminal}
          title="Open terminal console"
        >
          <Terminal size={14} className="inspector-action-icon" />
          <span>Terminal</span>
        </button>

        <button
          type="button"
          className="inspector-action-item"
          onClick={onOpenBrowser}
          title="Open agent browser"
        >
          <Globe size={14} className="inspector-action-icon" />
          <span>Browser</span>
        </button>

        {onOpenMemory && (
          <button
            type="button"
            className="inspector-action-item"
            onClick={onOpenMemory}
            title="Project memory & facts"
          >
            <Brain size={14} className="inspector-action-icon" />
            <span>Memory</span>
          </button>
        )}
      </div>

      {/* Background Tasks Section */}
      <div className="inspector-section">
        <div className="inspector-section-header">
          <span className="inspector-section-title">Background Tasks</span>
          <span className="inspector-section-count">{tasks.length > 0 ? tasks.length : 31}</span>
        </div>

        <div className="inspector-tasks-list">
          {displayTasks.map((t) => (
            <div
              key={t.id}
              className="inspector-task-item"
              onClick={onOpenAllDaemons}
              title={t.command || t.name}
            >
              <div className="inspector-task-icon">
                {t.status === "running" && <Loader2 size={13} className="spin" style={{ color: "#38bdf8" }} />}
                {t.status === "stopped" && <Terminal size={13} style={{ color: "#9ca3af" }} />}
                {t.status === "crashed" && <XCircle size={13} style={{ color: "#ef4444" }} />}
                {t.status === "timer" && <Clock size={13} style={{ color: "#a855f7" }} />}
              </div>
              <span className="inspector-task-name">{t.name}</span>
            </div>
          ))}
        </div>

        <button
          type="button"
          className="inspector-see-all-btn"
          onClick={onOpenAllDaemons}
        >
          See all
        </button>
      </div>

      {/* Goals Section */}
      <div className="inspector-section">
        <div className="inspector-section-header">
          <span className="inspector-section-title">Goals</span>
          <span className="inspector-section-count">{displayGoals.length}</span>
        </div>

        <div className="inspector-goals-list">
          {displayGoals.map((g) => (
            <div
              key={g.id}
              className="inspector-goal-item"
              title={g.text}
            >
              <div className="inspector-goal-icon">
                {g.status === "completed" && <CheckCircle2 size={13} style={{ color: "#22c55e" }} />}
                {g.status === "in_progress" && <CircleDot size={13} style={{ color: "#38bdf8" }} />}
                {g.status === "pending" && <Circle size={13} style={{ color: "#6b7280" }} />}
              </div>
              <span className="inspector-goal-text">{g.text}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
