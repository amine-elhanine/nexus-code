// Human- and model-facing descriptions of tool activity: one-line activity
// feed labels, transcript excerpts, skill-name extraction, and the session
// tool-history context block. Extracted from agent-service.ts.

// One-line, human-readable detail for a tool call, shown in the activity
// feed (e.g. "read_file · src/App.tsx:1-120", "execute · npm run check").
// Must track the REAL arg schemas: the DeepAgents FilesystemBackend tools
// use snake_case `file_path` (not `filePath`), `apply_patch` takes a single
// `patchText` blob, `ask_user` takes `questions[]`, etc. A generic key scan
// misses those and the UI ends up showing bare `read_file()` / `execute()`.
function shortLine(value: string, max = 90) {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function patchFilesSummary(patchText: string): string {
  const files: string[] = [];
  for (const line of patchText.split(/\r?\n/)) {
    const m = line.match(/^\*\*\*\s*(?:Add File|Update File|Delete File|Move to)\s*:?\s*(.*)$/i);
    if (m && m[1].trim() && files.length < 4) files.push(m[1].trim());
  }
  if (!files.length) return "";
  const extra = (patchText.match(/^\*\*\*\s*(?:Add File|Update File|Delete File)/gim) || []).length;
  return extra > files.length ? `${files.join(", ")} (+${extra - files.length} more)` : files.join(", ");
}

export function extractSkillNameFromPath(filePath: string): string | null {
  if (!filePath) return null;
  const normalized = filePath.replace(/\\/g, "/");
  const skillMdMatch = normalized.match(/(?:^|\/)([a-zA-Z0-9_-]+)\/SKILL\.md$/i);
  if (skillMdMatch) return skillMdMatch[1];

  const prefixMatch = normalized.match(/(?:system-skills|global-skills|\.nexus\/skills)\/(?:[a-zA-Z0-9_-]+\/)?([a-zA-Z0-9_-]+)/i);
  if (prefixMatch) {
    const candidate = prefixMatch[1];
    if (!/^SKILL$/i.test(candidate)) return candidate;
  }

  const skillsMatch = normalized.match(/\/skills\/([a-zA-Z0-9_-]+)/i);
  if (skillsMatch && !/^SKILL$/i.test(skillsMatch[1])) return skillsMatch[1];

  return null;
}

/**
 * Skill names already loaded in this run, derived from tool-call history.
 * Used in repair/resume feedback so the model is told exactly which skills
 * need no re-reading (the middleware enforces the same at execution time).
 */
export function loadedSkillNamesFromMessages(messages: any[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const scanArgs = (args: unknown) => {
    if (!args || typeof args !== "object") return;
    const a = args as Record<string, unknown>;
    const file = String(a.file_path || a.filePath || a.file || a.path || "");
    if (!file) return;
    const skill = extractSkillNameFromPath(file);
    if (skill && !seen.has(skill.toLowerCase())) {
      seen.add(skill.toLowerCase());
      names.push(skill);
    }
  };
  for (const message of messages || []) {
    if (!message || typeof message !== "object") continue;
    const direct = (message as { tool_calls?: unknown }).tool_calls;
    if (Array.isArray(direct)) {
      for (const call of direct) scanArgs((call as { args?: unknown })?.args);
    }
    const extra = (message as { additional_kwargs?: { tool_calls?: unknown } }).additional_kwargs?.tool_calls;
    if (Array.isArray(extra)) {
      for (const call of extra) {
        const fnArgs = (call as { function?: { arguments?: unknown } })?.function?.arguments;
        if (typeof fnArgs === "string") {
          try {
            scanArgs(JSON.parse(fnArgs));
          } catch { /* ignore unparseable */ }
        } else {
          scanArgs((call as { args?: unknown })?.args);
        }
      }
    }
  }
  return names;
}

export function describeToolCall(name: string, args: any): string {
  if (!args || typeof args !== "object") return "";
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  // Backend tools use `file_path`; custom tools use `filePath`.
  const file = str(args.file_path || args.filePath || args.file || args.path);
  switch (name) {
    case "read_file": {
      if (!file) return "";
      const skill = extractSkillNameFromPath(file);
      if (skill) return `Consulting skill: ${skill}`;
      const hasRange = args.offset != null || args.limit != null;
      return hasRange ? `${file}:${args.offset ?? 0}+${args.limit ?? 100}` : file;
    }
    case "write_file":
    case "edit_file":
    case "delete":
      return file;
    case "ls":
      return str(args.path) || "/";
    case "glob": {
      const pattern = str(args.pattern);
      const base = str(args.path);
      return base && base !== "/" ? `${pattern} in ${base}` : pattern;
    }
    case "grep": {
      const pattern = str(args.pattern);
      if (!pattern) return "";
      const scope = str(args.glob || args.path);
      return scope && scope !== "/" ? `"${shortLine(pattern, 60)}" in ${scope}` : `"${shortLine(pattern, 60)}"`;
    }
    case "execute":
      return shortLine(str(args.command), 110);
    case "read_file_range": {
      if (!file) return "";
      const skill = extractSkillNameFromPath(file);
      if (skill) return `Consulting skill: ${skill}`;
      return `${file}:${args.startLine ?? 1}-${args.endLine ?? 100}`;
    }
    case "grep_search": {
      const query = str(args.query);
      if (!query) return "";
      const scope = str(args.pathPrefix);
      return scope ? `"${shortLine(query, 60)}" in ${scope}` : `"${shortLine(query, 60)}"`;
    }
    case "find_symbol_definition":
    case "find_symbol_references":
      return str(args.symbol);
    case "get_symbol_outline":
      return file;
    case "apply_patch": {
      const files = patchFilesSummary(str(args.patchText));
      return files || shortLine(str(args.patchText), 60);
    }
    case "ask_user": {
      const questions = Array.isArray(args.questions) ? args.questions : [];
      const headers = questions.map((q: any) => str(q?.header || q?.question)).filter(Boolean).slice(0, 3);
      return headers.length ? `needs input: ${shortLine(headers.join(" · "), 90)}` : "";
    }
    case "delegate_task": {
      const role = str(args.role);
      const task = shortLine(str(args.task), 80);
      return role && task ? `[${role}] ${task}` : role || task;
    }
    case "web_search":
      return str(args.query) ? `"${shortLine(str(args.query), 70)}"` : "";
    case "browser_inspect":
      return str(args.url);
    case "browser_fetch_api": {
      const url = str(args.url);
      const method = str(args.method);
      return method && method !== "GET" ? `${method} ${url}` : url;
    }
    default: {
      // Fallback for MCP tools and future tools: scan common key names,
      // including snake_case variants the old scanner missed.
      const parts: string[] = [];
      for (const key of ["file_path", "filePath", "file", "path", "command", "url", "pattern", "query", "symbol", "role", "task"]) {
        const value = (args as any)[key];
        if (typeof value === "string" && value.trim()) {
          parts.push(shortLine(value, 70));
          if (parts.length >= 2) break;
        }
      }
      return parts.join(" · ");
    }
  }
}

export function toolCallSummary(call: any) {
  return describeToolCall(call?.name || "", call?.args);
}

// Pulls the `login` out of a GitHub get_me result (JSON string, object, or
// LangChain message content). Returns null when no login is recognizable.
export function extractGithubLogin(raw: unknown): string | null {
  const texts: string[] = [];
  if (typeof raw === "string") texts.push(raw);
  else if (Array.isArray(raw)) {
    for (const block of raw) {
      if (typeof block === "string") texts.push(block);
      else if (block && typeof block === "object") {
        const o = block as Record<string, unknown>;
        if (typeof o.text === "string") texts.push(o.text);
        if (typeof o.login === "string") return o.login;
      }
    }
  } else if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    if (typeof o.login === "string") return o.login;
    try { texts.push(JSON.stringify(o)); } catch { /* ignore */ }
  }
  for (const text of texts) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object" && typeof (parsed as Record<string, unknown>).login === "string") {
        return (parsed as Record<string, unknown>).login as string;
      }
    } catch { /* not JSON — fall through to regex */ }
    const match = text.match(/"login"\s*:\s*"([^"]+)"/);
    if (match) return match[1];
  }
  return null;
}

// Truncated plain-text excerpt of a LangChain ToolMessage payload for
// transcript persistence. Caps size so one giant grep dump can't bloat every
// future prompt in the session.
export function toolResultExcerpt(content: unknown, cap = 1500): string {
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object") {
          const o = block as Record<string, unknown>;
          if (typeof o.text === "string") return o.text;
          if (typeof o.output === "string") return o.output;
          try {
            return JSON.stringify(o).slice(0, 500);
          } catch {
            return "";
          }
        }
        return "";
      })
      .join("\n");
  } else if (content != null) {
    try {
      text = typeof content === "object" ? JSON.stringify(content) : String(content);
    } catch {
      text = "";
    }
  }
  text = text.trim();
  if (text.length > cap) text = text.slice(0, cap) + `… [truncated ${text.length - cap} chars]`;
  return text;
}
