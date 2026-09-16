export type StackCommands = {
  id: string;
  label: string;
  /** Ecosystem-standard test command (runs immediately when clicked). */
  testCmd: string;
  testLabel: string;
  /** Optional second command (typecheck / vet / check). */
  checkCmd?: string;
  checkLabel?: string;
};

/**
 * Pick terminal quick commands from root-level marker files so the toolbar
 * never offers `npm test` to a Python/Go/Java/… project (or vice versa).
 * Priority is explicit: a repo with both package.json and go.mod is treated
 * as Node-first (monorepos keep the JS entry point).
 */
export function detectStack(rootFiles: string[]): StackCommands | null {
  const names = new Set(rootFiles.map((f) => f.toLowerCase()));
  const hasExt = (ext: string) => rootFiles.some((f) => f.toLowerCase().endsWith(ext));

  if (names.has("package.json")) {
    return { id: "node", label: "Node", testCmd: "npm test", testLabel: "npm test", checkCmd: "npm run check", checkLabel: "typecheck" };
  }
  if (names.has("go.mod")) {
    return { id: "go", label: "Go", testCmd: "go test ./...", testLabel: "go test", checkCmd: "go vet ./...", checkLabel: "go vet" };
  }
  if (names.has("pom.xml")) {
    return { id: "java-maven", label: "Maven", testCmd: "mvn test", testLabel: "mvn test" };
  }
  if (names.has("build.gradle") || names.has("build.gradle.kts")) {
    return { id: "java-gradle", label: "Gradle", testCmd: "gradle test", testLabel: "gradle test" };
  }
  if (names.has("cargo.toml")) {
    return { id: "rust", label: "Cargo", testCmd: "cargo test", testLabel: "cargo test", checkCmd: "cargo check", checkLabel: "cargo check" };
  }
  if (hasExt(".sln") || hasExt(".csproj")) {
    return { id: "dotnet", label: ".NET", testCmd: "dotnet test", testLabel: "dotnet test" };
  }
  if (
    names.has("requirements.txt") || names.has("pyproject.toml") || names.has("setup.py") ||
    names.has("setup.cfg") || names.has("pipfile") || names.has("manage.py") ||
    names.has("app.py") || names.has("main.py")
  ) {
    return { id: "python", label: "Python", testCmd: "pytest", testLabel: "pytest" };
  }
  if (names.has("gemfile")) {
    return { id: "ruby", label: "Ruby", testCmd: "bundle exec rspec", testLabel: "rspec" };
  }
  if (names.has("composer.json")) {
    return { id: "php", label: "PHP", testCmd: "vendor/bin/phpunit", testLabel: "phpunit" };
  }
  return null;
}
