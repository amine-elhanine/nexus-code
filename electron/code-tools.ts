import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { ensureSymbolParsersReady, parseSymbolsWithTreeSitterSync, startSymbolParserWarmup, type SymbolEntry } from "./symbol-parser.js";
import { lspDefinition, lspDiagnostics, lspDocumentSymbols, lspReferences } from "./lsp-service.js";

export type { SymbolEntry };
// Warm the WASM grammars in the background so the sync parse path is
// AST-backed (not regex fallback) by the time an agent run starts.
startSymbolParserWarmup();

const execFileAsync = promisify(execFile);

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

async function safePath(projectRoot: string, requested: string) {
  const root = await fs.realpath(path.resolve(projectRoot));
  const candidate = path.resolve(root, requested || ".");
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw new Error("Path escapes the selected project root.");
  }
  let probe = candidate;
  while (probe !== root) {
    try {
      const realProbe = await fs.realpath(probe);
      if (realProbe !== root && !realProbe.startsWith(`${root}${path.sep}`)) {
        throw new Error("Path follows a symlink outside the selected project root.");
      }
      break;
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
      probe = path.dirname(probe);
    }
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

  // AST path when the WASM grammar for this extension has warmed; the regex
  // parser below remains the fallback (cold start, unsupported language).
  const ast = parseSymbolsWithTreeSitterSync(code, fileName);
  if (ast) return ast;
  return parseSymbolsFromCodeRegex(code, fileName);
}

/** Line-regex symbol extraction. Kept as fallback for unsupported languages
 *  and for the window before the WASM grammars finish warming. */
function parseSymbolsFromCodeRegex(arg1: string, arg2: string): SymbolEntry[] {
  let code = arg1;
  let fileName = arg2;
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

export type DiagnosticItem = { file: string; line: number; col: number; code: string; message: string };

function parseTscLine(line: string): DiagnosticItem | null {
  const m = line.match(/^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+([A-Z0-9]+):\s*(.+)$/);
  if (!m) return null;
  return { file: m[1].replace(/\\/g, "/"), line: Number(m[2]), col: Number(m[3]), code: m[5], message: m[6].slice(0, 300) };
}

/**
 * Structured diagnostics for the agent (LSP-lite without native deps).
 * Runs the project's real checker scoped to the requested files when
 * possible, falling back to a full fast check with output filtered.
 * Always capped and never throws — returns human-readable text.
 */
export async function runDiagnostics(projectRoot: string, files: string[] = []): Promise<{ items: DiagnosticItem[]; summary: string }> {
  const root = path.resolve(projectRoot);
  const cleanFiles = files.map((f) => f.replace(/"/g, "").trim()).filter(Boolean).slice(0, 10);
  const items: DiagnosticItem[] = [];
  try {
    const pkgPath = path.join(root, "package.json");
    if (existsSync(pkgPath) || existsSync(path.join(root, "tsconfig.json"))) {
      // Prefer tsc; eslint is a lint fast-path handled by verify, not here.
      const tscArgs = ["--no-install", "tsc", "--noEmit", "--pretty", "false"];
      try {
        await execFileAsync("npx", tscArgs, { cwd: root, timeout: 60000, maxBuffer: 8_000_000 });
        return { items, summary: "No TypeScript errors." };
      } catch (error: any) {
        const output = String(error?.stdout || error?.output || error?.message || "");
        for (const line of output.split(/\r?\n/)) {
          const parsed = parseTscLine(line);
          if (!parsed) continue;
          if (cleanFiles.length && !cleanFiles.some((f) => parsed.file.endsWith(f.replace(/^\.\//, "")))) continue;
          items.push(parsed);
          if (items.length >= 50) break;
        }
        if (!items.length) return { items, summary: "TypeScript check passed (no parseable errors)." };
        const summary = items.map((d) => `${d.file}:${d.line}:${d.col} ${d.code} ${d.message}`).join("\n");
        return { items, summary: `TypeScript diagnostics (${items.length}):\n${summary}`.slice(0, 4000) };
      }
    }
    if (cleanFiles.length && cleanFiles.every((f) => f.endsWith(".py"))) {
      // Type-aware pyright diagnostics first (ruff is lint-only); fall back
      // when no language server is available for this project.
      if (cleanFiles.length === 1) {
        const lspItems = await lspDiagnostics(root, path.resolve(root, cleanFiles[0])).catch(() => null);
        if (lspItems) {
          const summary = lspItems.length
            ? lspItems.map((d) => `${cleanFiles[0]}:${d.line}:${d.col} ${d.code} ${d.message}`).join("\n").slice(0, 4000)
            : `No pyright errors in ${cleanFiles[0]}.`;
          return { items: lspItems.slice(0, 50), summary };
        }
      }
      try {
        await execFileAsync("ruff", ["check", "--output-format", "concise", ...cleanFiles], { cwd: root, timeout: 30000, maxBuffer: 4_000_000 });
        return { items, summary: "No ruff errors." };
      } catch (error: any) {
        const output = String(error?.stdout || error?.output || error?.message || "").slice(0, 4000);
        return { items, summary: output || "Ruff reported issues." };
      }
    }
    if (cleanFiles.length === 1 && cleanFiles[0].endsWith(".py")) {
      try {
        await execFileAsync("python", ["-m", "py_compile", cleanFiles[0]], { cwd: root, timeout: 30000, maxBuffer: 1_000_000 });
        return { items, summary: `No syntax errors in ${cleanFiles[0]}.` };
      } catch (error: any) {
        return { items, summary: String(error?.stdout || error?.message || "Python syntax error.").slice(0, 2000) };
      }
    }
    return { items, summary: "No supported checker found for diagnostics (need tsconfig.json/package.json or Python files)." };
  } catch (error) {
    return { items, summary: `Diagnostics failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1000) };
  }
}

export function createCodeIntelligenceTools(projectRoot: string) {
  const getSymbolOutlineTool = tool(
    async ({ filePath }: { filePath: string }) => {
      try {
        await ensureSymbolParsersReady().catch(() => false);
        const target = await safePath(projectRoot, filePath);
        const content = await fs.readFile(target, "utf8");
        const lines = content.split(/\r?\n/).length;
        // Type-aware document symbols first; the AST parser covers languages
        // and installs without a language server.
        const lspSymbols = await lspDocumentSymbols(projectRoot, target).catch(() => []);
        const symbols: SymbolEntry[] = lspSymbols.length
          ? lspSymbols
              .sort((a, b) => a.line - b.line)
              .map((s) => ({ kind: s.kind, name: s.name, line: s.line, signature: s.detail || s.name }))
          : parseSymbolsFromCode(content, path.basename(target));
        return formatOutline(symbols, filePath, lines);
      } catch (error) {
        return `Failed to generate outline for ${filePath}: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
    {
      name: "get_symbol_outline",
      description: "Extract structural symbols (functions, classes, interfaces, types, structs) from a code file via AST parsing — accurate for multi-line signatures, decorators, and class members. Much faster and more token-efficient than read_file for exploring structure.",
      schema: z.object({
        filePath: z.string().describe("Relative path to the source file (e.g. src/App.tsx)"),
      }),
    }
  );

  const findSymbolDefinitionTool = tool(
    async ({ symbol }: { symbol: string }) => {
      const cleanSymbol = symbol.trim();
      if (!cleanSymbol) return "Symbol name is required.";

      await ensureSymbolParsersReady().catch(() => false);
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
      // Type-aware fast path: a language server resolves the FIRST textual hit
      // to its true declaration — disambiguating overloads and same-name
      // locals that the grep ranking cannot. Absent servers degrade silently.
      if (hits.length) {
        const first = hits[0];
        const lsp = await lspDefinition(projectRoot, path.resolve(projectRoot, first.path), first.line, Math.max(0, first.text.indexOf(cleanSymbol))).catch(() => null);
        if (lsp && lsp.length) {
          const rel = (p: string) => path.relative(projectRoot, p).replace(/\\/g, "/");
          const lines = lsp.slice(0, 25).map((loc) => `${rel(loc.path)}:L${loc.line}:C${loc.col} (type-aware)`);
          return `Found ${lsp.length} definition(s) for "${cleanSymbol}" (language server):\n${lines.join("\n")}`;
        }
      }
      if (!scored.length) return `No declaration found for symbol "${cleanSymbol}" in workspace.`;
      const lines = scored.map(({ hit, isDeclaration }) => `${hit.path}:L${hit.line}${isDeclaration ? "" : " (reference)"} -> ${hit.text.trim().slice(0, 100)}`);
      return `Found ${scored.length} declaration candidate(s) for "${cleanSymbol}":\n${lines.join("\n")}`;
    },
    {
      name: "find_symbol_definition",
      description: "Search the codebase for where a function, class, interface, type, or struct is declared. Type-aware (resolves overloads and same-name locals) when a language server is available; falls back to ranked text search.",
      schema: z.object({
        symbol: z.string().describe("The symbol or function name to locate (e.g. 'runProjectAgent' or 'PlanItem')"),
      }),
    }
  );

  const findSymbolReferencesTool = tool(
    async ({ symbol }: { symbol: string }) => {
      const cleanSymbol = symbol.trim();
      if (!cleanSymbol) return "Symbol name is required.";

      await ensureSymbolParsersReady().catch(() => false);
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
      // Type-aware fast path: references from a language server understand
      // shadowing and distinct symbols that share a name. A server only
      // indexes documents it has opened, so the results are UNIONED with the
      // text hits (deduped by path:line) — grep guarantees recall, the
      // server guarantees precision.
      if (hits.length) {
        const first = hits[0];
        const lsp = await lspReferences(projectRoot, path.resolve(projectRoot, first.path), first.line, Math.max(0, first.text.indexOf(cleanSymbol))).catch(() => null);
        if (lsp) {
          const rel = (p: string) => path.relative(projectRoot, p).replace(/\\/g, "/");
          // Canonical key: LSP locations arrive with forward slashes from the
          // file:// URI; grep hits go through path.resolve (backslashes).
          const key = (p: string, line: number) => `${path.resolve(p).replace(/\\/g, "/").toLowerCase()}:${line}`;
          const seen = new Set(lsp.map((loc) => key(loc.path, loc.line)));
          const lspLines = lsp.slice(0, 40).map((loc) => `${rel(loc.path)}:L${loc.line} (type-aware)`);
          const extraLines = hits
            .map((h) => ({ path: path.resolve(projectRoot, h.path), line: h.line }))
            .filter((loc) => !seen.has(key(loc.path, loc.line)))
            .slice(0, Math.max(0, 40 - lspLines.length))
            .map((loc) => `${rel(loc.path)}:L${loc.line}`);
          const all = [...lspLines, ...extraLines];
          if (all.length) {
            return `Found ${all.length} reference(s) to "${cleanSymbol}":\n${all.join("\n")}`;
          }
        }
      }
      if (!hits.length) return `No references found for symbol "${cleanSymbol}" in workspace.`;
      return `Found ${hits.length} reference(s) to "${cleanSymbol}":\n${hits.map((hit) => `${hit.path}:L${hit.line}: ${hit.text.trim().slice(0, 100)}`).join("\n")}`;
    },
    {
      name: "find_symbol_references",
      description: "Find all usages and references of a symbol (function, class, variable, type) across the workspace files. Type-aware (understands shadowing and distinct same-name symbols) when a language server is available; falls back to text search.",
      schema: z.object({
        symbol: z.string().describe("The symbol name to find references for"),
      }),
    }
  );

  const readFileRangeTool = tool(
    async ({ filePath, startLine = 1, endLine = 100 }: { filePath: string; startLine?: number; endLine?: number }) => {
      try {
        const target = await safePath(projectRoot, filePath);
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

      let searchRoot: string;
      try {
        searchRoot = pathPrefix ? await safePath(projectRoot, pathPrefix) : path.resolve(projectRoot);
      } catch (error) {
        // A model may occasionally pass a host-root path after web research.
        // Keep the agent loop alive and let it retry with a workspace-relative path.
        return `Search path rejected: ${error instanceof Error ? error.message : String(error)} Use a path relative to the selected project root, or omit pathPrefix to search the workspace.`;
      }
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
  const getDiagnosticsTool = tool(
    async ({ files }: { files?: string[] }) => {
      try {
        const { summary } = await runDiagnostics(projectRoot, files ?? []);
        return summary;
      } catch (error) {
        return `Diagnostics failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
    {
      name: "get_diagnostics",
      description: "Run the project's real language checker (tsc --noEmit, ruff, py_compile) and return structured file:line:col errors, optionally filtered to the given relative file paths. Use this instead of guessing whether edits compile.",
      schema: z.object({
        files: z.array(z.string()).optional().describe("Optional relative file paths to filter diagnostics (max 10). Omit for whole-project check."),
      }),
    }
  );

  return [findSymbolReferencesTool, readFileRangeTool, grepSearchTool, getDiagnosticsTool];
}

// Opencode parity: the backend already exposes read/grep/glob, so the LLM
// only needs a small core.
export const CORE_CODE_TOOL_NAMES = ["read_file_range", "grep_search", "get_diagnostics"];

export function pickRuntimeCodeTools(allTools: any[], complexity: "simple" | "complex"): any[] {
  if (complexity === "simple") {
    return allTools.filter((t) => CORE_CODE_TOOL_NAMES.includes(t.name));
  }
  // Complex tasks keep the reference lookup alongside the core; definition
  // queries go through grep_search instead of a dedicated tool.
  return allTools.filter((t) => [...CORE_CODE_TOOL_NAMES, "find_symbol_references"].includes(t.name));
}
