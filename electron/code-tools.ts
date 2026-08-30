import { promises as fs } from "node:fs";
import path from "node:path";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

export type SymbolEntry = {
  kind: "function" | "class" | "interface" | "type" | "variable" | "export" | "import" | "struct" | "enum" | "trait";
  name: string;
  line: number;
  signature: string;
};

const IGNORED_DIRS = new Set([
  ".git",
  ".forgepilot",
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

      const matches: string[] = [];
      async function searchDir(dir: string, depth = 0) {
        if (depth > 8 || matches.length >= 25) return;
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
            await searchDir(full, depth + 1);
          } else if (CODE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
            try {
              const content = await fs.readFile(full, "utf8");
              const symbols = parseSymbolsFromCode(content, entry.name);
              const found = symbols.filter((s) => s.name.toLowerCase() === cleanSymbol.toLowerCase());
              for (const item of found) {
                const rel = path.relative(projectRoot, full).replace(/\\/g, "/");
                matches.push(`${rel}:L${item.line} -> ${item.signature}`);
              }
            } catch { /* ignore */ }
          }
        }
      }

      await searchDir(path.resolve(projectRoot));
      if (!matches.length) return `No declaration found for symbol "${cleanSymbol}" in workspace.`;
      return `Found ${matches.length} declaration(s) for "${cleanSymbol}":\n${matches.join("\n")}`;
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
      const refRegex = new RegExp(`\\b${escaped}\\b`, "g");
      const references: string[] = [];

      async function searchRefs(dir: string, depth = 0) {
        if (depth > 8 || references.length >= 40) return;
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
            await searchRefs(full, depth + 1);
          } else if (CODE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
            try {
              const content = await fs.readFile(full, "utf8");
              const lines = content.split(/\r?\n/);
              for (let i = 0; i < lines.length; i++) {
                if (references.length >= 40) break;
                refRegex.lastIndex = 0;
                if (refRegex.test(lines[i])) {
                  const rel = path.relative(projectRoot, full).replace(/\\/g, "/");
                  references.push(`${rel}:L${i + 1}: ${lines[i].trim().slice(0, 100)}`);
                }
              }
            } catch { /* ignore */ }
          }
        }
      }

      await searchRefs(path.resolve(projectRoot));
      if (!references.length) return `No references found for symbol "${cleanSymbol}" in workspace.`;
      return `Found ${references.length} reference(s) to "${cleanSymbol}":\n${references.join("\n")}`;
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

      const results: string[] = [];
      const searchRoot = pathPrefix ? safePath(projectRoot, pathPrefix) : path.resolve(projectRoot);

      async function walkGrep(dir: string, depth = 0) {
        if (depth > 10 || results.length >= 50) return;
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
            await walkGrep(full, depth + 1);
          } else {
            const ext = path.extname(entry.name).toLowerCase();
            if (CODE_EXTENSIONS.has(ext) || !ext) {
              try {
                const stat = await fs.stat(full);
                if (stat.size > 2_000_000) continue; // Skip files > 2MB
                const content = await fs.readFile(full, "utf8");
                const lines = content.split(/\r?\n/);
                for (let i = 0; i < lines.length; i++) {
                  if (results.length >= 50) break;
                  regex.lastIndex = 0;
                  if (regex.test(lines[i])) {
                    const rel = path.relative(projectRoot, full).replace(/\\/g, "/");
                    results.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
                  }
                }
              } catch { /* ignore read errors */ }
            }
          }
        }
      }

      await walkGrep(searchRoot);
      if (!results.length) return `No matches found for query "${cleanQuery}".`;
      return `Found ${results.length} match(es) for "${cleanQuery}":\n${results.join("\n")}`;
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

  return [getSymbolOutlineTool, findSymbolDefinitionTool, findSymbolReferencesTool, readFileRangeTool, grepSearchTool];
}
