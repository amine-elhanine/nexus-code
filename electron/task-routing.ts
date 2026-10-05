// Request-routing and verification-command heuristics (pure functions over
// the request string and project files). Extracted from agent-service.ts.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

export type PackageManagerName = "npm" | "pnpm" | "yarn" | "bun";
export type PackageManager = { name: PackageManagerName; run: string; exec: string; install: string; testFile: (rel: string) => string };

/**
 * Detect the JS/TS package manager from explicit config first, then
 * lockfiles. Order matters: pnpm-lock.yaml / yarn.lock / bun.lock[b] win
 * over package-lock.json so monorepos with multiple lockfiles resolve to
 * the most specific one present.
 */
export function detectPackageManager(projectRoot: string): PackageManager {
  const fallback: PackageManager = {
    name: "npm",
    run: "npm run",
    exec: "npx",
    install: "npm install",
    testFile: (rel: string) => `npm test -- ${rel}`,
  };
  try {
    const root = path.resolve(projectRoot);
    // Explicit override: .nexus/package-manager.json { "name": "pnpm" } or
    // NEXUS_PACKAGE_MANAGER env (useful for tests / containers).
    const envName = (process.env.NEXUS_PACKAGE_MANAGER || "").toLowerCase();
    const overridePath = path.join(root, ".nexus", "package-manager.json");
    let override: string | null = null;
    if (existsSync(overridePath)) {
      try {
        override = String(JSON.parse(readFileSync(overridePath, "utf8"))?.name || "").toLowerCase();
      } catch { /* ignore malformed override */ }
    }
    const pick = (name: string): PackageManager | null => {
      if (name === "pnpm") return { name: "pnpm", run: "pnpm", exec: "pnpm exec", install: "pnpm install", testFile: (rel: string) => `pnpm test -- ${rel}` };
      if (name === "yarn") return { name: "yarn", run: "yarn", exec: "yarn exec", install: "yarn install", testFile: (rel: string) => `yarn test -- ${rel}` };
      if (name === "bun") return { name: "bun", run: "bun run", exec: "bunx", install: "bun install", testFile: (rel: string) => `bun test ${rel}` };
      if (name === "npm") return fallback;
      return null;
    };
    const fromEnv = envName ? pick(envName) : null;
    if (fromEnv) return fromEnv;
    const fromFile = override ? pick(override) : null;
    if (fromFile) return fromFile;
    // package.json packageManager field: "pnpm@9.1.0", "yarn@4", "bun@1".
    const pkgPath = path.join(root, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pmField = String(JSON.parse(readFileSync(pkgPath, "utf8"))?.packageManager || "").toLowerCase();
        if (pmField.startsWith("pnpm")) return pick("pnpm")!;
        if (pmField.startsWith("yarn")) return pick("yarn")!;
        if (pmField.startsWith("bun")) return pick("bun")!;
        if (pmField.startsWith("npm")) return fallback;
      } catch { /* ignore */ }
    }
    if (existsSync(path.join(root, "pnpm-lock.yaml"))) return pick("pnpm")!;
    if (existsSync(path.join(root, "yarn.lock"))) return pick("yarn")!;
    if (existsSync(path.join(root, "bun.lockb")) || existsSync(path.join(root, "bun.lock"))) return pick("bun")!;
    return fallback;
  } catch {
    return fallback;
  }
}

export function pickVerificationCommand(projectRoot: string): string | null {
  try {
    const root = path.resolve(projectRoot);
    const pm = detectPackageManager(root);
    const pkgPath = path.join(root, "package.json");
    if (existsSync(pkgPath)) {
      const scripts = JSON.parse(readFileSync(pkgPath, "utf8")).scripts ?? {};
      // Named typecheck scripts are the source of truth; `check` scripts often
      // cover more tsconfigs than a bare `tsc --noEmit` would (multiple
      // projects), so prefer them over running tsc directly.
      if (typeof scripts.typecheck === "string") return `${pm.run} typecheck`;
      if (typeof scripts.check === "string") return `${pm.run} check`;
      if (existsSync(path.join(root, "tsconfig.json"))) return `${pm.exec} --no-install tsc --noEmit`;
      if (typeof scripts.lint === "string") return `${pm.run} lint`;
    }

    if (existsSync(path.join(root, "Cargo.toml"))) return "cargo check";
    if (existsSync(path.join(root, "go.mod"))) return "go vet ./...";
    // JVM: Maven first, then Gradle (wrapper preferred when checked in).
    if (existsSync(path.join(root, "pom.xml"))) return "mvn -q test";
    if (
      existsSync(path.join(root, "build.gradle")) ||
      existsSync(path.join(root, "build.gradle.kts")) ||
      existsSync(path.join(root, "settings.gradle")) ||
      existsSync(path.join(root, "settings.gradle.kts"))
    ) {
      if (process.platform === "win32" && existsSync(path.join(root, "gradlew.bat"))) return "gradlew.bat build";
      if (existsSync(path.join(root, "gradlew"))) return "./gradlew build";
      return "gradle build";
    }
    // .NET: any SDK-style project or solution at the root.
    try {
      const entries = readdirSync(root);
      if (entries.some((name) => /\.(csproj|fsproj|sln)$/i.test(name))) return "dotnet test";
    } catch { /* fall through to Python */ }
    // Python: Django check, then pytest when tests are present, then ruff,
    // then a dependency-free syntax compile as last resort.
    if (existsSync(path.join(root, "manage.py"))) return "python manage.py check";
    if (
      existsSync(path.join(root, "pytest.ini")) ||
      existsSync(path.join(root, "tox.ini")) ||
      existsSync(path.join(root, "tests")) ||
      existsSync(path.join(root, "test"))
    ) return "pytest -q";
    if (existsSync(path.join(root, "pyproject.toml")) || existsSync(path.join(root, "ruff.toml"))) return "ruff check";
    if (
      existsSync(path.join(root, "requirements.txt")) ||
      existsSync(path.join(root, "setup.py")) ||
      existsSync(path.join(root, "setup.cfg")) ||
      existsSync(path.join(root, "Pipfile")) ||
      existsSync(path.join(root, "poetry.lock"))
    ) return "python -m compileall -q .";
    return null;
  } catch {
    return null;
  }
}

/**
 * Project-level verification override. A repository may provide
 * `.nexus/verification.json` with `{ "commands": ["npm run check", "npm test"] }`
 * or the same object under `package.json.nexus.verification`. This keeps the
 * safe heuristics as a fallback while letting projects define their real build
 * and integration gates.
 */
export function pickVerificationCommands(projectRoot: string): string[] {
  try {
    const root = path.resolve(projectRoot);
    const candidates = [path.join(root, ".nexus", "verification.json")];
    const pkgPath = path.join(root, "package.json");
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      if (pkg?.nexus?.verification) candidates.push("package.json:nexus.verification");
      for (const candidate of candidates) {
        const raw = candidate === "package.json:nexus.verification" ? pkg.nexus.verification : JSON.parse(readFileSync(candidate, "utf8"));
        const commands = Array.isArray(raw) ? raw : raw?.commands;
        if (Array.isArray(commands)) {
          const valid = commands.filter((command: unknown): command is string => typeof command === "string" && Boolean(command.trim())).map((command) => command.trim()).slice(0, 8);
          if (valid.length) return valid;
        }
      }
    } else if (existsSync(candidates[0])) {
      const raw = JSON.parse(readFileSync(candidates[0], "utf8"));
      const commands = Array.isArray(raw) ? raw : raw?.commands;
      if (Array.isArray(commands)) return commands.filter((command: unknown): command is string => typeof command === "string" && Boolean(command.trim())).map((command) => command.trim()).slice(0, 8);
    }
  } catch { /* invalid configuration falls back to detection */ }
  const fallback = pickVerificationCommand(projectRoot);
  return fallback ? [fallback] : [];
}

/**
 * Finds package-local verification commands for changed files in a workspace.
 * Commands use the package manager's prefix/filter mechanism so the caller
 * can execute them from the repository root without changing process cwd.
 */
export function pickAffectedPackageCommands(projectRoot: string, modifiedFiles: string[]): string[] {
  try {
    const root = path.resolve(projectRoot);
    const pm = detectPackageManager(root);
    const commands: string[] = [];
    const seen = new Set<string>();
    for (const modified of modifiedFiles) {
      let directory = path.dirname(path.resolve(root, modified));
      while (directory.startsWith(root) && directory !== path.dirname(root)) {
        const packagePath = path.join(directory, "package.json");
        if (existsSync(packagePath)) {
          const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
          const relative = path.relative(root, directory).replace(/\\/g, "/") || ".";
          const scripts = pkg?.scripts || {};
          for (const name of ["check", "typecheck", "build", "test"]) {
            if (typeof scripts[name] !== "string") continue;
            const command = relative === "."
              ? `${pm.run} ${name}`
              : pm.name === "pnpm"
                ? `pnpm --dir "${relative}" run ${name}`
                : pm.name === "yarn"
                  ? `yarn --cwd "${relative}" run ${name}`
                  : pm.name === "bun"
                    ? `bun --cwd "${relative}" run ${name}`
                    : `npm --prefix "${relative}" run ${name}`;
            if (!seen.has(command)) { seen.add(command); commands.push(command); }
            break;
          }
          break;
        }
        directory = path.dirname(directory);
      }
      if (commands.length >= 8) break;
    }
    return commands.slice(0, 8);
  } catch {
    return [];
  }
}

/**
 * Opencode-style fast path: for small diffs, lint only the changed files
 * instead of typechecking the whole project. Returns null when no fast
 * scoped check applies (caller falls back to pickVerificationCommand).
 */
export function pickFileScopedVerification(projectRoot: string, modifiedFiles: string[]): string | null {
  try {
    if (!modifiedFiles.length || modifiedFiles.length > 5) return null;
    const root = path.resolve(projectRoot);
    const pm = detectPackageManager(root);
    const quoted = modifiedFiles.map((f) => `"${f.replace(/"/g, "")}"`).join(" ");
    const pkgPath = path.join(root, "package.json");
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      const devDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      const hasEslint = Boolean(devDeps.eslint || typeof pkg.scripts?.lint === "string");
      if (hasEslint) return `${pm.exec} eslint ${quoted}`;
      return null;
    }
    // Python-only change with a ruff config: lint just the touched files.
    if (
      modifiedFiles.length > 0 &&
      modifiedFiles.every((f) => f.endsWith(".py")) &&
      (existsSync(path.join(root, "pyproject.toml")) || existsSync(path.join(root, "ruff.toml")))
    ) {
      return `ruff check ${quoted}`;
    }
    return null;
  } catch {
    return null;
  }
}

export function findTargetedTests(projectRoot: string, modifiedFiles: string[]): string | null {
  try {
    const root = path.resolve(projectRoot);
    const pm = detectPackageManager(root);
    const hasPackageJson = existsSync(path.join(root, "package.json"));
    let hasTestScript = false;
    if (hasPackageJson) {
      const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
      hasTestScript = typeof pkg.scripts?.test === "string";
    }

    const hasPom = existsSync(path.join(root, "pom.xml"));
    const hasGradle =
      existsSync(path.join(root, "build.gradle")) ||
      existsSync(path.join(root, "build.gradle.kts")) ||
      existsSync(path.join(root, "settings.gradle")) ||
      existsSync(path.join(root, "settings.gradle.kts"));
    let hasDotnet = false;
    try {
      hasDotnet = readdirSync(root).some((name) => /\.(csproj|fsproj|sln)$/i.test(name));
    } catch { /* ignore */ }

    // Heuristic: check if any modified file has a corresponding test file
    for (const file of modifiedFiles) {
      const parsed = path.parse(file);
      const candidates = [
        path.join(root, parsed.dir, `${parsed.name}.test${parsed.ext}`),
        path.join(root, parsed.dir, `${parsed.name}.spec${parsed.ext}`),
        path.join(root, "test", `${parsed.name}.test${parsed.ext}`),
        path.join(root, "tests", `test_${parsed.name}${parsed.ext}`),
      ];
      // Java: Foo.java <-> FooTest.java in the same package or under src/test.
      if (parsed.ext === ".java") {
        candidates.push(
          path.join(root, parsed.dir, `${parsed.name}Test.java`),
          path.join(root, parsed.dir, `Test${parsed.name}.java`),
        );
      }
      for (const cand of candidates) {
        if (existsSync(cand)) {
          const rel = path.relative(root, cand).replace(/\\/g, "/");
          if (hasTestScript) return pm.testFile(rel);
          if (parsed.ext === ".py") return `pytest ${rel}`;
          if (parsed.ext === ".rs") return `cargo test ${parsed.name}`;
          if (parsed.ext === ".go") return `go test ./${path.dirname(rel)}`;
          if (parsed.ext === ".java") {
            const testClass = path.basename(cand, ".java");
            if (hasPom) return `mvn -q -Dtest=${testClass} test`;
            if (hasGradle) return `gradle test --tests "*${testClass}*"`;
          }
          if (parsed.ext === ".cs" && hasDotnet) return "dotnet test";
          return null;
        }
      }
      // .NET without a colocated test file: a test run still validates the change.
      if (parsed.ext === ".cs" && hasDotnet) return "dotnet test";
    }
    return null;
  } catch {
    return null;
  }
}

export type TaskComplexity = "simple" | "complex";

const COMPLEX_TASK_PATTERN =
  /\b(refactor|migrate|redesign|overhaul|multi[- ]?step|all files|entire (codebase|project|app|repo)|codebase-wide|end[- ]to[- ]end|from scratch)\b/i;
// Building something new from zero is a multi-file project even when the
// request is one short sentence ("build me an app..."). Single-file creates
// ("create a file/component/function") stay simple.
const BUILD_TASK_PATTERN =
  /\b(build|building|rebuild|scaffold|scaffolding|bootstrap|bootstrapping|launch|launching|set\s+up\s+a\s+new)\b/i;
const CREATE_PROJECT_PATTERN =
  /\b(create|creating|make|making|develop|developing|generate|generating|build|building|launch|launching|start)\b.{0,40}\b(app|application|website|site|platform|portal|hub|project|dashboard|chat\s*app|web\s*app)\b/i;
const LANDING_PAGE_BUILD_PATTERN = /\b(build|create|make|develop|design|generate)\b.{0,80}\b(landing\s*page|marketing\s*page|homepage|portfolio\s*site)\b/i;
// Deliverable builds (slides, docs, spreadsheets) are multi-step projects
// even in one short sentence: read the skill, write a generator script,
// run it, verify the file. Classifying them "simple" caps the run at ~3
// tool calls — the agent burns them all on skill exploration and never acts.
const DOC_BUILD_PATTERN =
  /\b(pdf|presentation|power ?point|pptx?|slide deck|slideshow|slides?|spreadsheet|excel|xlsx?|workbook|word documents?|docx?|latex|document|report)\b/i;
// "Create/write a report/memo/summary" is a document build even without a
// format keyword: research + write + save is multi-step, never a lookup.
const DOC_WRITE_PATTERN =
  /\b(create|make|generate|write|draft)\b.{0,40}\b(report|document|memo|letter|resume|summary|writeup|write-up)\b/i;

/**
 * Pure document builds (slides/docs/sheets via local skills + write_file +
 * execute) virtually never need user MCP servers — but every bound MCP tool
 * (e.g. 26 GitHub tools) inflates each model call and slows flaky endpoints.
 * Skip MCP only when the request shows no research/external-service intent.
 */
export function shouldSkipMcpForTask(request: string): boolean {
  const text = request || "";
  const isBuild = DOC_BUILD_PATTERN.test(text) || DOC_WRITE_PATTERN.test(text) || BUILD_TASK_PATTERN.test(text) || LANDING_PAGE_BUILD_PATTERN.test(text);
  if (!isBuild) return false;
  if (/\b(research|search(ing)?|find|latest|compare|gather|lookup|investigate|github|repos?|issues?|pull request|prs?|gists?|jira|notion|slack|drive|gmail)\b/i.test(text)) return false;
  return true;
}
const WEB_TASK_PATTERN = /\b(localhost|127\.0\.0\.1|https?:\/\/|web ?(app|page|server)|browser|api .*(health|endpoint)|dev server)\b/i;
// Edit verbs: the request wants the code changed, not explained.
const EDIT_VERB_PATTERN =
  /\b(fix|implement|add|change|update|create|delete|remove|write|move|rename|migrate|debug|resolve|handle|support|enable|wire|integrate|replace)\b/i;
// Bug language: debugging is never a 3-call lookup — it needs
// reproduce + locate + fix + verify, so it must never route simple.
const BUG_PATTERN =
  /\b(bug|error|failing|failed|broken|crash|issue|wrong|exception|stack|traceback|doesn'?t work|not working)\b/i;

/** Heuristic router: trivial lookups / single edits skip planning, delegation and full verification. */
export function classifyTaskComplexity(request: string): TaskComplexity {
  const text = (request || "").trim();
  if (!text) return "simple";
  // Pure questions are lookups, not projects — even long ones. Only promote
  // when the text carries explicit edit verbs.
  if (/^(what|where|which|how\s+(does|do|is|are|can)|why|explain|describe|show|list|tell\s+me)\b/i.test(text) &&
    !/\b(fix|implement|add|change|refactor|update|create|delete|remove|write|move|rename|migrate)\b/i.test(text)) {
    return "simple";
  }
  if (COMPLEX_TASK_PATTERN.test(text)) return "complex";
  if (BUILD_TASK_PATTERN.test(text) || CREATE_PROJECT_PATTERN.test(text) || LANDING_PAGE_BUILD_PATTERN.test(text)) return "complex";
  if (DOC_BUILD_PATTERN.test(text)) return "complex";
  if (DOC_WRITE_PATTERN.test(text)) return "complex";
  // Debugging always needs reproduce + locate + fix + verify: never simple.
  if (BUG_PATTERN.test(text) && EDIT_VERB_PATTERN.test(text)) return "complex";
  // An edit verb with any scope signal is real work, not a lookup: two files,
  // a non-trivial description, pasted code/traces, or verify/test language.
  const fileMentions = (text.match(/[\w\-./]+\.\w{1,5}/g) || []).length;
  const hasPastedContext = /```/.test(text) || /^\s*at\s+\S+.*:\d+/m.test(text) || /\b(Error|Exception|Traceback)\s*:/.test(text);
  if (
    EDIT_VERB_PATTERN.test(text) &&
    (fileMentions >= 2 ||
      text.length > 120 ||
      hasPastedContext ||
      /\b(verify|test|tests|check)\b/i.test(text))
  ) {
    return "complex";
  }
  // Long multi-sentence briefs are real projects, not quick tasks.
  const sentences = text.split(/[.!?\n]+/).map((s) => s.trim()).filter(Boolean);
  if (text.length > 350 || (sentences.length >= 3 && text.length > 180)) return "complex";
  // Explicit multi-file / multi-stage signals.
  if (fileMentions >= 3) return "complex";
  if (/\b(and then|then verify|step \d|first .* then)\b/i.test(text) && text.length > 120) return "complex";
  return "simple";
}

export function isWebTask(request: string): boolean {
  return WEB_TASK_PATTERN.test(request || "");
}

/** True when the user wants a brand-new project scaffolded, not an edit. */
export function isNewProjectTask(request: string): boolean {
  const text = (request || "").trim();
  if (!text) return false;
  // Explicit existing-project signals win over build verbs: "add a dashboard
  // to this repo" is an edit inside the workspace, not a greenfield scaffold
  // (which would nest a fresh Vite app + npm install into the current repo).
  if (/\b(into|in)\s+(this|the|our|my)\s+(repo|repository|project|codebase|app)\b/i.test(text)) return false;
  if (/\bexisting\s+(repo|repository|project|codebase|app)\b/i.test(text)) return false;
  return BUILD_TASK_PATTERN.test(text) || CREATE_PROJECT_PATTERN.test(text);
}

// A resume is ONLY a bare continue command ("continue", "please continue",
// "continue from where you stopped"). The old start-anchored `\b` match
// treated genuine new tasks as resumes: "Finish the login page" or
// "Proceed with checkout" injected the previous run's checkpoint plus a
// "do NOT restart, proceed with the next unfinished step" order — so the
// agent ignored the new request and kept working on the old task.
const CONTINUE_PHRASES = [
  "continue",
  "resume",
  "go on",
  "proceed",
  "keep going",
  "carry on",
  "finish it",
  "finish",
  "finish the task",
  "finish it up",
  "complete it",
  "keep working",
  "continue now",
  "continue the task",
  "pick up where you left off",
  "pick up from where you left off",
  "pick up where you stopped",
  "pick up from where you stopped",
  "continue from where you stopped",
  "continue from where you left off",
  "ok",
  "okay",
  "sure",
  "go ahead",
  "yes",
  "do it",
  "please do it",
  "proceed please",
];
export function isContinueRequest(request: string): boolean {
  const text = (request || "").trim().replace(/[.!…]+$/g, "").trim().toLowerCase();
  if (!text) return false;
  const bare = text.startsWith("please ") ? text.slice("please ".length).trim() : text;
  const core = bare.endsWith(" please") ? bare.slice(0, -" please".length).trim() : bare;
  if ((CONTINUE_PHRASES as string[]).includes(core)) return true;
  if (/^(?:continue|resume|pick\s+up)\s+(?:from\s+)?where\b.{0,60}$/i.test(core)) return true;
  if (/^(?:continue|resume|keep\s+going|keep\s+working|go\s+ahead)\b.{0,40}$/i.test(core)) return true;
  if (/^(?:ok|okay|sure|yes|do\s+it|proceed)\b.{0,20}$/i.test(core)) return true;
  return false;
}
