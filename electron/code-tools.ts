import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

const execFileAsync = promisify(execFile);

export type SymbolEntry = {
  kind: "function" | "class" | "interface" | "type" | "variable" | "export" | "import" | "struct" | "enum" | "trait";
  name: string;
  line: number;
  signature: string;
};

const IGNORED_DIRS = new Set([
  ".git",
  ".nexus",
  ".forgepilot",
  ".deepagents",
  "node_modules",
  "dist",
  "dist-electron",
  ".next",
  ".turbo",
  "coverage",
  ".venv",
  "venv",
  "target",
  "build",
  "__pycache__",
]);

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".kt", ".c", ".cpp", ".h", ".hpp",
  ".cs", ".rb", ".php", ".swift", ".json", ".md", ".yaml", ".yml",
  ".toml", ".css", ".scss", ".html", ".sql", ".sh", ".bash",
]);

function safePath(projectRoot: string, requested: string) {
  const root = path.resolve(projectRoot);
  const candidate = path.resolve(root, requested || ".");
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw new Error("Path escapes the selected project root.");
  }
  return candidate;
}

function isCodeFile(name: string) {
  return CODE_EXTENSIONS.has(path.extname(name).toLowerCase());
}

export function parseSymbolsFromCode(arg1: string, arg2: string): SymbolEntry[] {
  let code = arg1;
  let fileName = arg2;
  // Auto-detect argument order if fileName was passed first
  if (arg1.includes("\n") || (!arg2.includes("\n") && arg1.length > arg2.length)) {
    code = arg1;
    fileName = arg2;
  } else if (arg2.includes("\n") || (!arg1.includes("\n") && arg2.length > arg1.length)) {
    code = arg2;
    fileName = arg1;
  }

  const lines = code.split(/\r?\n/);
  const symbols: SymbolEntry[] = [];
  const lowerFile = (fileName || "").toLowerCase();
  const isPython = lowerFile.endsWith(".py");
  const isGo = lowerFile.endsWith(".go");
  const isRust = lowerFile.endsWith(".rs");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const lineNum = i + 1;

    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
      continue;
    }

    if (isPython) {
      const defMatch = trimmed.match(/^(?:async\s+)?def\s+([a-zA-Z0-9_]+)\s*\((.*?)\)?:/);
      if (defMatch) {
        symbols.push({ kind: "function", name: defMatch[1], line: lineNum, signature: `def ${defMatch[1]}(${defMatch[2] || ""}):` });
        continue;
      }
      const classMatch = trimmed.match(/^class\s+([a-zA-Z0-9_]+)(?:\((.*?)\))?:/);
      if (classMatch) {
        symbols.push({ kind: "class", name: classMatch[1], line: lineNum, signature: `class ${classMatch[1]}` });
        continue;
      }
    } else if (isGo) {
      const funcMatch = trimmed.match(/^func\s+(?:\((?:[a-zA-Z0-9_* ]+)\)\s+)?([a-zA-Z0-9_]+)\s*\((.*?)\)/);
      if (funcMatch) {
        symbols.push({ kind: "function", name: funcMatch[1], line: lineNum, signature: `func ${funcMatch[1]}(${funcMatch[2].slice(0, 50)})` });
        continue;
      }
      const typeMatch = trimmed.match(/^type\s+([a-zA-Z0-9_]+)\s+(struct|interface)/);
      if (typeMatch) {
        symbols.push({ kind: typeMatch[2] === "struct" ? "struct" : "interface", name: typeMatch[1], line: lineNum, signature: `type ${typeMatch[1]} ${typeMatch[2]}` });
        continue;
      }
    } else if (isRust) {
      const fnMatch = trimmed.match(/^(?:pub(?:\s*\([^)]*\))?\s+)?(?:async\s+)?fn\s+([a-zA-Z0-9_]+)\s*(?:<[^>]*>)?\s*\((.*?)\)/);
      if (fnMatch) {
        symbols.push({ kind: "function", name: fnMatch[1], line: lineNum, signature: `fn ${fnMatch[1]}(${fnMatch[2].slice(0, 50)})` });
        continue;
      }
      const structMatch = trimmed.match(/^(?:pub(?:\s*\([^)]*\))?\s+)?struct\s+([a-zA-Z0-9_]+)/);
      if (structMatch) {
        symbols.push({ kind: "struct", name: structMatch[1], line: lineNum, signature: `struct ${structMatch[1]}` });
        continue;
      }
      const enumMatch = trimmed.match(/^(?:pub(?:\s*\([^)]*\))?\s+)?enum\s+([a-zA-Z0-9_]+)/);
      if (enumMatch) {
        symbols.push({ kind: "enum", name: enumMatch[1], line: lineNum, signature: `enum ${enumMatch[1]}` });
        continue;
      }
      const traitMatch = trimmed.match(/^(?:pub(?:\s*\([^)]*\))?\s+)?trait\s+([a-zA-Z0-9_]+)/);
      if (traitMatch) {
        symbols.push({ kind: "trait", name: traitMatch[1], line: lineNum, signature: `trait ${traitMatch[1]}` });
        continue;
      }
    } else {
      // TypeScript / JavaScript
      const funcMatch = trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z0-9_]+)\s*(?:<[^>]*>)?\s*\((.*?)\)/);
      if (funcMatch) {
        symbols.push({ kind: "function", name: funcMatch[1], line: lineNum, signature: `function ${funcMatch[1]}(${funcMatch[2].slice(0, 60)})` });
        continue;
      }

      const arrowMatch = trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+([a-zA-Z0-9_]+)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s*)?(?:\([^)]*\)|[a-zA-Z0-9_]+)\s*=>/);
      if (arrowMatch) {
        symbols.push({ kind: "function", name: arrowMatch[1], line: lineNum, signature: `const ${arrowMatch[1]} = (...) =>` });
        continue;
      }

      const classMatch = trimmed.match(/^(?:export\s+)?(?:abstract\s+)?class\s+([a-zA-Z0-9_]+)/);
      if (classMatch) {
        symbols.push({ kind: "class", name: classMatch[1], line: lineNum, signature: `class ${classMatch[1]}` });
        continue;
      }

      const interfaceMatch = trimmed.match(/^(?:export\s+)?interface\s+([a-zA-Z0-9_]+)/);
      if (interfaceMatch) {
        symbols.push({ kind: "interface", name: interfaceMatch[1], line: lineNum, signature: `interface ${interfaceMatch[1]}` });
        continue;
      }

      const typeMatch = trimmed.match(/^(?:export\s+)?type\s+([a-zA-Z0-9_]+)\s*(?:<[^>]*>)?\s*=/);
      if (typeMatch) {
        symbols.push({ kind: "type", name: typeMatch[1], line: lineNum, signature: `type ${typeMatch[1]} = ...` });
        continue;
      }

      const enumMatch = trimmed.match(/^(?:export\s+)?(?:const\s+)?enum\s+([a-zA-Z0-9_]+)/);
      if (enumMatch) {
        symbols.push({ kind: "enum", name: enumMatch[1], line: lineNum, signature: `enum ${enumMatch[1]}` });
        continue;
      }

      const methodMatch = trimmed.match(/^(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*(?:async\s+)?([a-zA-Z0-9_]+)\s*\((.*?)\)\s*(?::\s*[^{]+)?\s*\{/);
      if (methodMatch && !["if", "for", "while", "switch", "catch"].includes(methodMatch[1])) {
        symbols.push({ kind: "function", name: methodMatch[1], line: lineNum, signature: `method ${methodMatch[1]}(${methodMatch[2].slice(0, 60)})` });
        continue;
      }
    }
  }

  return symbols;
}

export function formatOutline(arg1: any, arg2: any, arg3?: number): string {
  const symbols: SymbolEntry[] = Array.isArray(arg1) ? arg1 : Array.isArray(arg2) ? arg2 : [];
  const fileName: string = typeof arg1 === "string" ? arg1 : typeof arg2 === "string" ? arg2 : "file";
  const totalLines = typeof arg3 === "number" ? arg3 : symbols.length ? symbols[symbols.length - 1].line : 0;

  if (!symbols.length) return `File: ${fileName} (${totalLines} lines) - No top-level symbols found.`;
  const formatted = symbols
    .map((s) => `  L${s.line}: [${s.kind}] ${s.signature}`)
    .join("\n");
  return `File: ${fileName} (${totalLines} lines, ${symbols.length} symbols):\n${formatted}`;
}

// git grep is the fast path for workspace search: it respects .gitignore, runs
// in-process in the git binary and skips binary files automatically. The
// filesystem walk remains as the fallback for non-git projects.
export type GrepHit = { path: string; line: number; text: string };

async function gitGrep(projectRoot: string, pattern: string, extraArgs: string[] = []): Promise<GrepHit[] | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["grep", "-n", "-I", "--no-color", "-E", "-e", pattern, ...extraArgs],
      { cwd: path.resolve(projectRoot), maxBuffer: 4_000_000 }
    );
    const hits: GrepHit[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      if (!line) continue;
      const sep = line.indexOf(":");
      const lineSep = line.indexOf(":", sep + 1);
      if (sep === -1 || lineSep === -1) continue;
      const file = line.slice(0, sep);
      const lineNo = Number(line.slice(sep + 1, lineSep));
      if (!Number.isFinite(lineNo)) continue;
      hits.push({ path: file, line: lineNo, text: line.slice(lineSep + 1) });
    }
    return hits;
  } catch (error: any) {
    // git grep exits 1 on "no matches" — that is a valid empty result.
    if (error?.code === 1 && typeof error?.stdout === "string") return [];
    return null; // not a git repo, or git missing — fall back to the walk
  }
}

async function walkSearch(
  projectRoot: string,
  matchesFile: (name: string) => boolean,
  scanContent: (full: string, rel: string, stat: { size: number }) => Promise<GrepHit[]>
): Promise<GrepHit[]> {
  const hits: GrepHit[] = [];
  async function walk(dir: string, depth = 0) {
    if (depth > 8 || hits.length >= 200) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (matchesFile(entry.name)) {
        try {
          const stat = await fs.stat(full);
          if (stat.size > 2_000_000) continue;
          const found = await scanContent(full, path.relative(projectRoot, full).replace(/\\/g, "/"), stat);
          for (const hit of found) {
            if (hits.length >= 200) return;
            hits.push(hit);
          }
        } catch { /* ignore read errors */ }
      }
    }
  }
  await walk(path.resolve(projectRoot));
  return hits;
}

export function createCodeIntelligenceTools(projectRoot: string) {
  const getSymbolOutlineTool = tool(
    async ({ filePath }: { filePath: string }) => {
      try {
        const target = safePath(projectRoot, filePath);
        const content = await fs.readFile(target, "utf8");
        const lines = content.split(/\r?\n/).length;
        const symbols = parseSymbolsFromCode(content, path.basename(target));
        return formatOutline(symbols, filePath, lines);
      } catch (error) {
        return `Failed to generate outline for ${filePath}: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
    {
      name: "get_symbol_outline",
      description: "Extract structural symbols (functions, classes, interfaces, types, structs) from a code file without loading the entire body into memory. Much faster and more token-efficient than read_file for exploring structure.",
      schema: z.object({
        filePath: z.string().describe("Relative path to the source file (e.g. src/App.tsx)"),
      }),
    }
  );

  const findSymbolDefinitionTool = tool(
    async ({ symbol }: { symbol: string }) => {
      const cleanSymbol = symbol.trim();
      if (!cleanSymbol) return "Symbol name is required.";

      const escaped = cleanSymbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      let hits = await gitGrep(projectRoot, `\\b${escaped}\\b`);
      if (hits === null) {
        hits = await walkSearch(projectRoot, isCodeFile, async (full, rel) => {
          const content = await fs.readFile(full, "utf8");
          const symbols = parseSymbolsFromCode(content, path.basename(full));
          return symbols
            .filter((s) => s.name.toLowerCase() === cleanSymbol.toLowerCase())
            .map((s) => ({ path: rel, line: s.line, text: s.signature }));
        });
      }

      // A definition line declares the symbol (declaration regex match), not
      // just mentions it; rank those first and cap the output.
      const scored = hits
        .map((hit) => {
          const declMatch = hit.text.match(/(function|fn|def|class|interface|type|struct|enum|trait|const|let|var)\s+([A-Za-z0-9_]+)/);
          const isDeclaration = Boolean(declMatch && declMatch[2].toLowerCase() === cleanSymbol.toLowerCase());
          return { hit, isDeclaration };
        })
        .sort((a, b) => Number(b.isDeclaration) - Number(a.isDeclaration))
        .slice(0, 25);
      if (!scored.length) return `No declaration found for symbol "${cleanSymbol}" in workspace.`;
      const lines = scored.map(({ hit, isDeclaration }) => `${hit.path}:L${hit.line}${isDeclaration ? "" : " (reference)"} -> ${hit.text.trim().slice(0, 100)}`);
      return `Found ${scored.length} declaration candidate(s) for "${cleanSymbol}":\n${lines.join("\n")}`;
    },
    {
      name: "find_symbol_definition",
      description: "Search the codebase for where a function, class, interface, type, or struct is declared.",
      schema: z.object({
        symbol: z.string().describe("The symbol or function name to locate (e.g. 'runProjectAgent' or 'PlanItem')"),
      }),
    }
  );

  const findSymbolReferencesTool = tool(
    async ({ symbol }: { symbol: string }) => {
      const cleanSymbol = symbol.trim();
      if (!cleanSymbol) return "Symbol name is required.";

      const escaped = cleanSymbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = `\\b${escaped}\\b`;
      let hits: GrepHit[] | null = await gitGrep(projectRoot, pattern);
      if (hits === null) {
        const refRegex = new RegExp(pattern, "g");
        hits = await walkSearch(projectRoot, isCodeFile, async (full, rel) => {
          const content = await fs.readFile(full, "utf8");
          const lines = content.split(/\r?\n/);
          const found: GrepHit[] = [];
          for (let i = 0; i < lines.length; i++) {
            refRegex.lastIndex = 0;
            if (refRegex.test(lines[i])) found.push({ path: rel, line: i + 1, text: lines[i] });
          }
          return found;
        });
      }
      hits = hits.slice(0, 40);
      if (!hits.length) return `No references found for symbol "${cleanSymbol}" in workspace.`;
      return `Found ${hits.length} reference(s) to "${cleanSymbol}":\n${hits.map((hit) => `${hit.path}:L${hit.line}: ${hit.text.trim().slice(0, 100)}`).join("\n")}`;
    },
    {
      name: "find_symbol_references",
      description: "Find all usages and references of a symbol (function, class, variable, type) across the workspace files.",
      schema: z.object({
        symbol: z.string().describe("The symbol name to find references for"),
      }),
    }
  );

  const readFileRangeTool = tool(
    async ({ filePath, startLine = 1, endLine = 100 }: { filePath: string; startLine?: number; endLine?: number }) => {
      try {
        const target = safePath(projectRoot, filePath);
        const content = await fs.readFile(target, "utf8");
        const lines = content.split(/\r?\n/);
        const totalLines = lines.length;
        const start = Math.max(1, Math.min(startLine, totalLines));
        const end = Math.max(start, Math.min(endLine, totalLines));

        const slice = lines.slice(start - 1, end);
        const formatted = slice.map((line, idx) => `${start + idx} | ${line}`).join("\n");
        return `File: ${filePath} (lines ${start}-${end} of ${totalLines}):\n${formatted}`;
      } catch (error) {
        return `Failed to read file range for ${filePath}: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
    {
      name: "read_file_range",
      description: "Read a specific line range from a file (e.g. lines 50-120) instead of loading the entire file into context. Use this for inspecting targeted sections of large files.",
      schema: z.object({
        filePath: z.string().describe("Relative path to the file"),
        startLine: z.number().optional().describe("Starting line number (1-indexed, default 1)"),
        endLine: z.number().optional().describe("Ending line number (inclusive, default 100)"),
      }),
    }
  );

  const grepSearchTool = tool(
    async ({ query, pathPrefix, isRegex = false, caseSensitive = false }: { query: string; pathPrefix?: string; isRegex?: boolean; caseSensitive?: boolean }) => {
      const cleanQuery = query.trim();
      if (!cleanQuery) return "Query is required for grep search.";

      let regex: RegExp;
      try {
        regex = isRegex ? new RegExp(cleanQuery, caseSensitive ? "g" : "gi") : new RegExp(cleanQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), caseSensitive ? "g" : "gi");
      } catch (err) {
        return `Invalid regex pattern: ${err instanceof Error ? err.message : String(err)}`;
      }

      const searchRoot = pathPrefix ? safePath(projectRoot, pathPrefix) : path.resolve(projectRoot);
      const fixedString = isRegex ? cleanQuery : cleanQuery.replace(/[.*+?^$+( )|[\]\\]/g, (c) => (c === "\n" ? "\\n" : `\\${c}`));
      let hits: GrepHit[] | null = pathPrefix
        ? null // git grep is root-wide; a scoped prefix goes straight to the walk
        : await gitGrep(projectRoot, fixedString, caseSensitive ? [] : ["-i"]);

      if (hits === null) {
        hits = await walkSearch(searchRoot, (name) => {
          const ext = path.extname(name).toLowerCase();
          return CODE_EXTENSIONS.has(ext) || !ext;
        }, async (full, rel) => {
          const content = await fs.readFile(full, "utf8");
          const lines = content.split(/\r?\n/);
          const found: GrepHit[] = [];
          for (let i = 0; i < lines.length; i++) {
            regex.lastIndex = 0;
            if (regex.test(lines[i])) found.push({ path: rel, line: i + 1, text: lines[i] });
          }
          return found;
        });
      }

      hits = hits.slice(0, 50);
      if (!hits.length) return `No matches found for query "${cleanQuery}".`;
      return `Found ${hits.length} match(es) for "${cleanQuery}":\n${hits.map((hit) => `${hit.path}:${hit.line}: ${hit.text.trim()}`).join("\n")}`;
    },
    {
      name: "grep_search",
      description: "Fast workspace search for text patterns or regular expressions across project files. Returns matching line numbers and snippet lines.",
      schema: z.object({
        query: z.string().describe("Search string or regular expression"),
        pathPrefix: z.string().optional().describe("Optional subdirectory or file prefix to limit search scope"),
        isRegex: z.boolean().optional().describe("Whether query should be treated as a regular expression (default false)"),
        caseSensitive: z.boolean().optional().describe("Whether match should be case sensitive (default false)"),
      }),
    }
  );

  // Small surface on purpose (opencode-style): ripgrep search, range reads and
  // one symbol-reference escape hatch. The backend already exposes read/grep/
  // glob, so outline/definition tools were pure choice-overload — their pure
  // parsers (parseSymbolsFromCode/formatOutline) stay exported for tests.
  return [findSymbolReferencesTool, readFileRangeTool, grepSearchTool];
}

// Opencode parity: the backend already exposes read/grep/glob, so the LLM
// only needs a small core.
export const CORE_CODE_TOOL_NAMES = ["read_file_range", "grep_search"];

export function pickRuntimeCodeTools(allTools: any[], complexity: "simple" | "complex"): any[] {
  if (complexity === "simple") {
    return allTools.filter((t) => CORE_CODE_TOOL_NAMES.includes(t.name));
  }
  // Complex tasks keep the reference lookup alongside the core; definition
  // queries go through grep_search instead of a dedicated tool.
  return allTools.filter((t) => [...CORE_CODE_TOOL_NAMES, "find_symbol_references"].includes(t.name));
}
