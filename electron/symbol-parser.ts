// AST-based symbol extraction via web-tree-sitter (WASM — no native builds,
// which matters on Windows). Replaces the line-regex parser for supported
// languages once the grammar for the file's extension has warmed; the regex
// parser in code-tools.ts stays as the fallback, so behavior degrades but
// never breaks a run. Multi-line signatures, decorators, and class members —
// the cases the regex parser got wrong — parse correctly here.
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
// web-tree-sitter: 0.22.x exports the Parser constructor directly and only
// attaches .Language after init(); 0.25+ exports { Parser, Language } eagerly.
// tree-sitter-wasms ships dylink-format grammar WASMs, which require the
// 0.22.x loader — resolve both shapes lazily so either runtime works.
const treeSitterModule: any = require_("web-tree-sitter");
const ParserCtor: any = treeSitterModule.Parser ?? treeSitterModule;
function languageClass(): any {
  return treeSitterModule.Language ?? ParserCtor.Language;
}

export type SymbolEntry = {
  kind: "function" | "class" | "interface" | "type" | "variable" | "export" | "import" | "struct" | "enum" | "trait";
  name: string;
  line: number;
  signature: string;
};

type GrammarKey =
  | "typescript" | "tsx" | "javascript" | "python" | "go" | "rust" | "java"
  | "c_sharp" | "cpp" | "c" | "ruby" | "php" | "kotlin";

const EXTENSION_TO_GRAMMAR: Record<string, GrammarKey> = {
  ".ts": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".cs": "c_sharp",
  ".cpp": "cpp", ".cc": "cpp", ".hpp": "cpp", ".hh": "cpp",
  ".c": "c", ".h": "c",
  ".rb": "ruby",
  ".php": "php",
  ".kt": "kotlin", ".kts": "kotlin",
};

const MAX_SYMBOLS = 500;

let wasmDir: string | null = null;
function grammarWasmPath(grammar: GrammarKey): string {
  if (!wasmDir) {
    wasmDir = path.dirname(require_.resolve("tree-sitter-wasms/out/tree-sitter-python.wasm"));
  }
  return path.join(wasmDir, `tree-sitter-${grammar}.wasm`);
}

let initPromise: Promise<void> | null = null;
let initFailed = false;
const parsers = new Map<GrammarKey, any>();
const loading = new Map<GrammarKey, Promise<boolean>>();

/** Loads the WASM core + every supported grammar. Resolves true when at least
 *  one grammar is usable; false means callers stay on the regex parser. */
export async function ensureSymbolParsersReady(): Promise<boolean> {
  if (initFailed) return false;
  try {
    if (!initPromise) initPromise = Promise.resolve(ParserCtor.init());
    await initPromise;
  } catch {
    initFailed = true;
    return false;
  }
  const grammars = [...new Set(Object.values(EXTENSION_TO_GRAMMAR))] as GrammarKey[];
  const Language = languageClass();
  if (!Language?.load) {
    initFailed = true;
    return false;
  }
  const results = await Promise.all(grammars.map(async (grammar): Promise<boolean> => {
    if (parsers.has(grammar)) return true;
    let pending = loading.get(grammar);
    if (!pending) {
      pending = (async () => {
        try {
          const lang = await Language.load(grammarWasmPath(grammar));
          const parser = new ParserCtor();
          parser.setLanguage(lang);
          parsers.set(grammar, parser);
          return true;
        } catch {
          return false;
        }
      })();
      loading.set(grammar, pending);
    }
    return pending;
  }));
  return results.some(Boolean);
}

let warmStarted = false;
/** Fire-and-forget warmup so the sync parse path has parsers by run time. */
export function startSymbolParserWarmup(): void {
  if (warmStarted) return;
  warmStarted = true;
  void ensureSymbolParsersReady().catch(() => { /* regex fallback stays */ });
}

/** Sync parse for supported languages, or null when the grammar has not
 *  warmed / the language is unsupported / parsing failed (caller falls back
 *  to the regex parser). Safe to call on every read: unknown extension is a
 *  cheap map miss. */
export function parseSymbolsWithTreeSitterSync(code: string, fileName: string): SymbolEntry[] | null {
  const grammar = EXTENSION_TO_GRAMMAR[path.extname(fileName).toLowerCase()];
  if (!grammar) return null;
  const parser = parsers.get(grammar);
  if (!parser) return null;
  try {
    const tree = parser.parse(code);
    const root = tree?.rootNode;
    if (!root) return null;
    const symbols: SymbolEntry[] = collect(root, grammar);
    return symbols.length ? symbols : null;
  } catch {
    return null;
  }
}

type Matcher = { kind: SymbolEntry["kind"]; stopInside?: boolean };

// Per-grammar node-type → symbol-kind maps. "stopInside" marks function-like
// nodes whose bodies must not yield nested symbols.
const TS_DECLARATIONS: Record<string, Matcher> = {
  function_declaration: { kind: "function", stopInside: true },
  generator_function_declaration: { kind: "function", stopInside: true },
  class_declaration: { kind: "class" },
  abstract_class_declaration: { kind: "class" },
  interface_declaration: { kind: "interface" },
  type_alias_declaration: { kind: "type" },
  enum_declaration: { kind: "enum" },
};
const TS_MEMBER_NODES = new Set(["method_definition", "function_signature", "method_signature", "abstract_method_signature"]);

const PY_DECLARATIONS: Record<string, Matcher> = {
  function_definition: { kind: "function", stopInside: true },
  class_definition: { kind: "class" },
};

const GO_DECLARATIONS: Record<string, Matcher> = {
  function_declaration: { kind: "function", stopInside: true },
  method_declaration: { kind: "function", stopInside: true },
};

const RUST_DECLARATIONS: Record<string, Matcher> = {
  function_item: { kind: "function", stopInside: true },
  struct_item: { kind: "struct" },
  enum_item: { kind: "enum" },
  trait_item: { kind: "trait" },
  type_item: { kind: "type" },
};

const JAVA_DECLARATIONS: Record<string, Matcher> = {
  method_declaration: { kind: "function", stopInside: true },
  constructor_declaration: { kind: "function", stopInside: true },
  class_declaration: { kind: "class" },
  interface_declaration: { kind: "interface" },
  enum_declaration: { kind: "enum" },
  record_declaration: { kind: "class" },
};

const CS_DECLARATIONS: Record<string, Matcher> = {
  method_declaration: { kind: "function", stopInside: true },
  constructor_declaration: { kind: "function", stopInside: true },
  class_declaration: { kind: "class" },
  interface_declaration: { kind: "interface" },
  struct_declaration: { kind: "struct" },
  enum_declaration: { kind: "enum" },
  record_declaration: { kind: "type" },
  property_declaration: { kind: "variable" },
};

const C_DECLARATIONS: Record<string, Matcher> = {
  function_definition: { kind: "function", stopInside: true },
  struct_specifier: { kind: "struct" },
  class_specifier: { kind: "class" },
  enum_specifier: { kind: "enum" },
  type_definition: { kind: "type" },
};

const RUBY_DECLARATIONS: Record<string, Matcher> = {
  method: { kind: "function", stopInside: true },
  singleton_method: { kind: "function", stopInside: true },
  class: { kind: "class" },
  module: { kind: "class" },
};

const PHP_DECLARATIONS: Record<string, Matcher> = {
  function_definition: { kind: "function", stopInside: true },
  method_declaration: { kind: "function", stopInside: true },
  class_declaration: { kind: "class" },
  interface_declaration: { kind: "interface" },
  trait_declaration: { kind: "class" },
};

const KOTLIN_DECLARATIONS: Record<string, Matcher> = {
  function_declaration: { kind: "function", stopInside: true },
  class_declaration: { kind: "class" },
  object_declaration: { kind: "class" },
};

const DECLARATIONS_BY_GRAMMAR: Partial<Record<GrammarKey, Record<string, Matcher>>> = {
  typescript: TS_DECLARATIONS,
  tsx: TS_DECLARATIONS,
  javascript: TS_DECLARATIONS,
  python: PY_DECLARATIONS,
  go: GO_DECLARATIONS,
  rust: RUST_DECLARATIONS,
  java: JAVA_DECLARATIONS,
  c_sharp: CS_DECLARATIONS,
  cpp: C_DECLARATIONS,
  c: C_DECLARATIONS,
  ruby: RUBY_DECLARATIONS,
  php: PHP_DECLARATIONS,
  kotlin: KOTLIN_DECLARATIONS,
};

function declarationsFor(grammar: GrammarKey): Record<string, Matcher> {
  return DECLARATIONS_BY_GRAMMAR[grammar] ?? {};
}

function buildSignature(node: any, parenScan: boolean): string {
  const raw: string = typeof node?.text === "string" ? node.text : "";
  if (!raw) return "";
  if (!parenScan) {
    // Class/interface/struct headers have no parameter list — keep just the
    // header (first line, body brace dropped) instead of a paren scan that
    // would run into the body's first call.
    const firstLine = (raw.split("\n")[0] ?? raw).replace(/\s*;\s*$/, "").trim();
    const brace = firstLine.indexOf("{");
    const sig = brace >= 0 ? firstLine.slice(0, brace).trim() : firstLine;
    return sig.length > 120 ? `${sig.slice(0, 120)}…` : sig;
  }
  // Extend through a balanced parameter list so multi-line signatures survive
  // (the old regex parser truncated them at the first line break).
  let depth = 0;
  let started = false;
  let end = -1;
  for (let i = 0; i < raw.length && i < 800; i++) {
    const ch = raw[i];
    if (ch === "(") { depth++; started = true; }
    else if (ch === ")") {
      depth--;
      if (started && depth === 0) { end = i + 1; break; }
    }
  }
  let sig = end > 0 ? raw.slice(0, end) : (raw.split("\n")[0] ?? raw);
  if (end > 0) {
    // TS-style return type sits between the closing paren and the body.
    const rest = raw.slice(end);
    const bodyBrace = rest.indexOf("{");
    const ret = (bodyBrace >= 0 ? rest.slice(0, bodyBrace) : rest.split("\n")[0] ?? "").trim();
    if (ret) sig += ret.startsWith(":") ? ret : ` ${ret}`;
  }
  sig = sig.replace(/\s+/g, " ").trim();
  return sig.length > 120 ? `${sig.slice(0, 120)}…` : sig;
}

function nodeName(node: any, grammar: GrammarKey): string {
  const named = node.childForFieldName?.("name");
  if (named?.text) return named.text;
  // C/C++ function definitions hide the name inside the declarator chain:
  // function_definition → declarator(function_declarator) → declarator(name).
  if (grammar === "cpp" || grammar === "c") {
    const declarator = node.childForFieldName?.("declarator");
    const inner = declarator?.childForFieldName?.("declarator") ?? declarator;
    if (inner?.text) return inner.text.replace(/^\*+/, "").trim();
  }
  return "";
}

function pushSymbol(out: SymbolEntry[], node: any, kind: SymbolEntry["kind"], grammar: GrammarKey): void {
  if (out.length >= MAX_SYMBOLS) return;
  const name = nodeName(node, grammar);
  if (!name || /[\s:;]/.test(name)) return;
  out.push({
    kind,
    name,
    line: (node.startPosition?.row ?? 0) + 1,
    signature: buildSignature(node, kind === "function"),
  });
}

function collect(root: any, grammar: GrammarKey): SymbolEntry[] {
  const out: SymbolEntry[] = [];
  const declarations = declarationsFor(grammar);

  const walk = (node: any, insideFunction: boolean, depth: number): void => {
    if (!node || out.length >= MAX_SYMBOLS || depth > 60) return;
    for (const child of node.namedChildren ?? []) {
      if (!child) continue;
      const type: string = child.type;

      if (grammar === "go" && type === "type_spec") {
        const typeChild = child.childForFieldName?.("type");
        const goKind: SymbolEntry["kind"] | null =
          typeChild?.type === "struct_type" ? "struct" :
          typeChild?.type === "interface_type" ? "interface" : null;
        if (goKind && !insideFunction) pushSymbol(out, child, goKind, grammar);
        walk(child, insideFunction, depth + 1);
        continue;
      }

      if ((grammar === "typescript" || grammar === "tsx" || grammar === "javascript") &&
          !insideFunction &&
          (type === "lexical_declaration" || type === "variable_declaration" || type === "field_definition" || type === "public_field_definition" || type === "property_definition")) {
        const declarator = type === "lexical_declaration" || type === "variable_declaration"
          ? (child.namedChildren ?? []).find((n: any) => n?.type === "variable_declarator")
          : child;
        const name = declarator?.childForFieldName?.("name")?.text ?? "";
        const value = declarator?.childForFieldName?.("value");
        const isFunctionish = !!value && TS_MEMBER_NODES.has(value.type) || ["arrow_function", "function_expression", "function"].includes(value?.type);
        if (name && !/[\s:;]/.test(name)) {
          if (out.length < MAX_SYMBOLS) {
            out.push({
              kind: isFunctionish ? "function" : "variable",
              name,
              line: (child.startPosition?.row ?? 0) + 1,
              signature: buildSignature(child, isFunctionish),
            });
          }
        }
        walk(child, true, depth + 1);
        continue;
      }

      // Class methods (method_definition) are members, not in the top-level
      // declaration map: capture them once and stop inside their bodies.
      if (TS_MEMBER_NODES.has(type) && type === "method_definition" && !insideFunction) {
        pushSymbol(out, child, "function", grammar);
        walk(child, true, depth + 1);
        continue;
      }

      const matcher = declarations[type];
      if (matcher && !insideFunction) {
        pushSymbol(out, child, matcher.kind, grammar);
        walk(child, Boolean(matcher.stopInside), depth + 1);
        continue;
      }

      // Decorated python definitions wrap the real def — descend unchanged.
      walk(child, insideFunction, depth + 1);
    }
  };

  walk(root, false, 0);
  return out;
}
