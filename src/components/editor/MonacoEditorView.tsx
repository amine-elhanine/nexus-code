import React, { useState, useRef } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import {
  FileCode2, Save, X, Eye, Code2, GitBranch, WrapText, Map,
  FileJson, FileText, Sparkles
} from "lucide-react";

interface MonacoEditorViewProps {
  activeFile: string;
  openFiles: string[];
  setActiveFile: (file: string) => void;
  setOpenFiles: React.Dispatch<React.SetStateAction<string[]>>;
  content: string;
  setContent: (content: string) => void;
  dirty: boolean;
  save: () => void;
}

function detectLanguage(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "ts":
    case "tsx":
    case "cts":
    case "mts":
      return "typescript";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "javascript";
    case "json":
      return "json";
    case "py":
      return "python";
    case "rs":
      return "rust";
    case "go":
      return "go";
    case "html":
    case "htm":
      return "html";
    case "css":
    case "scss":
    case "less":
      return "css";
    case "md":
    case "markdown":
      return "markdown";
    case "sql":
      return "sql";
    case "yml":
    case "yaml":
      return "yaml";
    case "sh":
    case "bash":
    case "ps1":
      return "shell";
    case "xml":
    case "svg":
      return "xml";
    case "c":
    case "h":
    case "cpp":
    case "hpp":
      return "cpp";
    default:
      return "plaintext";
  }
}

export const MonacoEditorView: React.FC<MonacoEditorViewProps> = ({
  activeFile,
  openFiles,
  setActiveFile,
  setOpenFiles,
  content,
  setContent,
  dirty,
  save,
}) => {
  const [wordWrap, setWordWrap] = useState<"on" | "off">("on");
  const [minimap, setMinimap] = useState(false);
  const editorRef = useRef<any>(null);

  const language = detectLanguage(activeFile);

  const handleEditorDidMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;

    // Define custom dark theme matching ForgePilot aesthetics
    monaco.editor.defineTheme("forgepilot-dark", {
      base: "vs-dark",
      inherit: true,
      rules: [
        { token: "comment", foreground: "6272a4", fontStyle: "italic" },
        { token: "keyword", foreground: "ff79c6" },
        { token: "string", foreground: "f1fa8c" },
        { token: "number", foreground: "bd93f9" },
        { token: "type", foreground: "8be9fd" },
        { token: "function", foreground: "50fa7b" },
      ],
      colors: {
        "editor.background": "#0b0c16",
        "editor.foreground": "#e2e8f0",
        "editor.lineHighlightBackground": "#17182b",
        "editorLineNumber.foreground": "#4a4c68",
        "editorLineNumber.activeForeground": "#a78bfa",
        "editorIndentGuide.background": "#1e2038",
        "editorIndentGuide.activeBackground": "#3b3e66",
        "editorCursor.foreground": "#a78bfa",
        "editor.selectionBackground": "#3f3b6d",
      },
    });

    monaco.editor.setTheme("forgepilot-dark");

    // Add Ctrl+S / Cmd+S save hotkey
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      save();
    });
  };

  const closeTab = (fileToClose: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const remaining = openFiles.filter((f) => f !== fileToClose);
    setOpenFiles(remaining);
    if (activeFile === fileToClose) {
      setActiveFile(remaining[remaining.length - 1] || "");
    }
  };

  if (!activeFile) {
    return (
      <div className="monaco-empty-state">
        <Code2 size={32} className="monaco-empty-icon" />
        <h3>No file open</h3>
        <p>Select a file from the explorer on the left to view or edit code.</p>
      </div>
    );
  }

  return (
    <div className="monaco-editor-container">
      {/* File Tabs */}
      <div className="monaco-tab-bar">
        <div className="monaco-tab-list">
          {openFiles.map((file) => {
            const fileName = file.split("/").pop() || file;
            const isActive = file === activeFile;
            return (
              <div
                key={file}
                className={`monaco-tab ${isActive ? "active" : ""}`}
                onClick={() => setActiveFile(file)}
                title={file}
              >
                <FileCode2 size={13} className="monaco-tab-icon" />
                <span className="monaco-tab-title">{fileName}</span>
                {isActive && dirty && <span className="monaco-dirty-dot" title="Unsaved changes">●</span>}
                <button
                  className="monaco-tab-close"
                  onClick={(e) => closeTab(file, e)}
                  title="Close tab"
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}
        </div>

        {/* Editor Toolbar Actions */}
        <div className="monaco-toolbar">
          <span className="monaco-lang-badge">{language}</span>
          <button
            className={`monaco-tool-btn ${wordWrap === "on" ? "active" : ""}`}
            onClick={() => setWordWrap((w) => (w === "on" ? "off" : "on"))}
            title="Toggle word wrap"
          >
            <WrapText size={13} />
          </button>
          <button
            className={`monaco-tool-btn ${minimap ? "active" : ""}`}
            onClick={() => setMinimap((m) => !m)}
            title="Toggle minimap"
          >
            <Map size={13} />
          </button>
          <button
            className={`monaco-save-btn ${dirty ? "dirty" : ""}`}
            onClick={save}
            disabled={!dirty}
            title="Save file (Ctrl+S)"
          >
            <Save size={13} />
            <span>Save</span>
          </button>
        </div>
      </div>

      {/* Monaco Instance */}
      <div className="monaco-editor-wrapper">
        <Editor
          height="100%"
          language={language}
          value={content}
          theme="forgepilot-dark"
          onChange={(value) => setContent(value || "")}
          onMount={handleEditorDidMount}
          options={{
            fontSize: 13,
            lineHeight: 20,
            fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
            wordWrap,
            minimap: { enabled: minimap },
            scrollBeyondLastLine: false,
            smoothScrolling: true,
            cursorBlinking: "smooth",
            cursorSmoothCaretAnimation: "on",
            renderLineHighlight: "all",
            padding: { top: 12, bottom: 12 },
            tabSize: 2,
            insertSpaces: true,
            formatOnPaste: true,
            automaticLayout: true,
          }}
        />
      </div>
    </div>
  );
};
