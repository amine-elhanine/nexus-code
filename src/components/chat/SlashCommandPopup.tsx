import React, { useEffect, useRef } from "react";
import {
  Sparkles, Terminal, FileText, CheckCircle2, GitBranch, RotateCcw,
  HelpCircle, ShieldCheck, Wrench, BookOpen, Code2, Cpu
} from "lucide-react";

export type SlashCommand = {
  command: string;
  name?: string;
  description: string;
  mode?: "plan" | "auto" | "ask";
  promptTemplate?: string;
  source?: "builtin" | "project";
  icon?: React.ReactNode;
};

export const DEFAULT_SLASH_COMMANDS: SlashCommand[] = [
  { command: "/plan", name: "Plan", description: "Plan changes read-only & generate implementation plan", mode: "plan", icon: <FileText size={14} className="text-amber-400" /> },
  { command: "/auto", name: "Auto", description: "Autonomous end-to-end implementation with auto-repair", mode: "auto", icon: <Sparkles size={14} className="text-purple-400" /> },
  { command: "/ask", name: "Ask", description: "Standard interactive coding assistance & verification", mode: "ask", icon: <CheckCircle2 size={14} className="text-blue-400" /> },
  { command: "/review", name: "Review", description: "Perform deep code & security review of active file/diff", mode: "ask", icon: <ShieldCheck size={14} className="text-emerald-400" /> },
  { command: "/test", name: "Test", description: "Run project verification and targeted unit tests", mode: "auto", icon: <Terminal size={14} className="text-emerald-400" /> },
  { command: "/refactor", name: "Refactor", description: "Refactor logic for cleanliness, speed & readability", mode: "auto", icon: <Wrench size={14} className="text-cyan-400" /> },
  { command: "/docs", name: "Docs", description: "Generate comprehensive docstrings and documentation", mode: "auto", icon: <BookOpen size={14} className="text-pink-400" /> },
  { command: "/security", name: "Security", description: "Audit workspace for security risks and vulnerabilities", mode: "ask", icon: <ShieldCheck size={14} className="text-rose-400" /> },
  { command: "/diff", name: "Diff", description: "Inspect git diff of all changes in current workspace", icon: <GitBranch size={14} className="text-cyan-400" /> },
  { command: "/checkpoint", name: "Checkpoint", description: "Create or restore a workspace snapshot", icon: <RotateCcw size={14} className="text-orange-400" /> },
  { command: "/help", name: "Help", description: "Show available tools, commands, and agent capabilities", icon: <HelpCircle size={14} className="text-gray-400" /> },
];

function getCommandIcon(cmd: SlashCommand): React.ReactNode {
  if (cmd.icon) return cmd.icon;
  if (cmd.source === "project") return <Cpu size={14} className="text-purple-400" />;
  return <Sparkles size={14} className="text-purple-400" />;
}

interface SlashCommandPopupProps {
  filter: string;
  customCommands?: SlashCommand[];
  onSelect: (cmd: SlashCommand) => void;
  selectedIndex: number;
}

export const SlashCommandPopup: React.FC<SlashCommandPopupProps> = ({
  filter,
  customCommands = [],
  onSelect,
  selectedIndex,
}) => {
  const allCommands = [...DEFAULT_SLASH_COMMANDS];
  for (const cc of customCommands) {
    const existingIdx = allCommands.findIndex((c) => c.command === cc.command);
    if (existingIdx >= 0) {
      allCommands[existingIdx] = { ...allCommands[existingIdx], ...cc };
    } else {
      allCommands.push(cc);
    }
  }

  const query = filter.toLowerCase();
  const filtered = allCommands.filter(
    (c) =>
      c.command.toLowerCase().includes(query) ||
      (c.name && c.name.toLowerCase().includes(query)) ||
      c.description.toLowerCase().includes(query)
  );

  const menuRef = useRef<HTMLDivElement | null>(null);
  // Keep the keyboard-highlighted item in view as the user arrows through
  // a list taller than the popup (block: nearest avoids yanking on tiny moves).
  useEffect(() => {
    menuRef.current
      ?.querySelector(".slash-command-item.selected")
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex, query]);

  if (!filtered.length) return null;

  return (
    <div className="slash-command-menu" ref={menuRef}>
      <div className="slash-command-header">Commands & Shortcuts</div>
      {filtered.map((item, index) => {
        const isSelected = index === selectedIndex % filtered.length;
        return (
          <div
            key={item.command}
            className={`slash-command-item ${isSelected ? "selected" : ""}`}
            onClick={() => onSelect(item)}
          >
            <div className="slash-command-icon">{getCommandIcon(item)}</div>
            <div className="slash-command-details">
              <div className="slash-command-title-row">
                <span className="slash-command-name">{item.command}</span>
                {item.source === "project" && (
                  <span className="slash-project-badge">project</span>
                )}
                {item.mode && (
                  <span className="slash-mode-badge">{item.mode}</span>
                )}
              </div>
              <span className="slash-command-desc">{item.description}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
};
