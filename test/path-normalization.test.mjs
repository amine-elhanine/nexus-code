import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { stripProjectRoot, normalizeVirtualPath, normalizeCommandPaths } from "../dist-electron/path-utils.js";
import { getAgentBackend } from "../dist-electron/command-service.js";
import { toolParameterNormalizationMiddleware } from "../dist-electron/loop-prevention.js";

test("stripProjectRoot strips Windows drive host paths", () => {
  const root = "C:\\Users\\melha_eay78bj\\Desktop\\test2";
  assert.equal(
    stripProjectRoot("C:\\Users\\melha_eay78bj\\Desktop\\test2\\src\\App.tsx", root),
    "src/App.tsx"
  );
  assert.equal(
    stripProjectRoot("C:/Users/melha_eay78bj/Desktop/test2/src/App.tsx", root),
    "src/App.tsx"
  );
  assert.equal(
    stripProjectRoot("c:\\users\\melha_eay78bj\\desktop\\test2\\src\\App.tsx", root),
    "src/App.tsx"
  );
});

test("stripProjectRoot strips hallucinated POSIX absolute paths without drive", () => {
  const root = "C:\\Users\\melha_eay78bj\\Desktop\\test2";
  assert.equal(
    stripProjectRoot("/Users/melha_eay78bj/Desktop/test2/dahab-coffee/src/Hero.tsx", root),
    "dahab-coffee/src/Hero.tsx"
  );
  assert.equal(
    stripProjectRoot("Users/melha_eay78bj/Desktop/test2/dahab-coffee/src/Hero.tsx", root),
    "dahab-coffee/src/Hero.tsx"
  );
});

test("stripProjectRoot strips Git Bash / MSYS format paths", () => {
  const root = "C:\\Users\\melha_eay78bj\\Desktop\\test2";
  assert.equal(
    stripProjectRoot("/c/Users/melha_eay78bj/Desktop/test2/dahab-coffee/src/Hero.tsx", root),
    "dahab-coffee/src/Hero.tsx"
  );
  assert.equal(
    stripProjectRoot("c/Users/melha_eay78bj/Desktop/test2/dahab-coffee/src/Hero.tsx", root),
    "dahab-coffee/src/Hero.tsx"
  );
});

test("stripProjectRoot returns empty string for the project root itself", () => {
  const root = "C:\\Users\\melha_eay78bj\\Desktop\\test2";
  assert.equal(stripProjectRoot("C:\\Users\\melha_eay78bj\\Desktop\\test2", root), "");
  assert.equal(stripProjectRoot("/Users/melha_eay78bj/Desktop/test2", root), "");
  assert.equal(stripProjectRoot("/Users/melha_eay78bj/Desktop/test2/", root), "");
  assert.equal(stripProjectRoot(".", root), "");
  assert.equal(stripProjectRoot("/", root), "");
});

test("stripProjectRoot leaves normal relative paths intact while removing leading slash", () => {
  const root = "C:\\Users\\melha_eay78bj\\Desktop\\test2";
  assert.equal(stripProjectRoot("src/App.tsx", root), "src/App.tsx");
  assert.equal(stripProjectRoot("/src/App.tsx", root), "src/App.tsx");
  assert.equal(stripProjectRoot("dahab-coffee/package.json", root), "dahab-coffee/package.json");
});

test("stripProjectRoot works on Unix / Linux / macOS paths", () => {
  const root = "/home/developer/workspace/my-project";
  assert.equal(
    stripProjectRoot("/home/developer/workspace/my-project/src/index.ts", root),
    "src/index.ts"
  );
  assert.equal(
    stripProjectRoot("home/developer/workspace/my-project/src/index.ts", root),
    "src/index.ts"
  );
  assert.equal(stripProjectRoot("/home/developer/workspace/my-project", root), "");
});

test("normalizeVirtualPath turns paths into clean virtual paths starting with /", () => {
  const root = "C:\\Users\\melha_eay78bj\\Desktop\\test2";
  assert.equal(
    normalizeVirtualPath("/Users/melha_eay78bj/Desktop/test2/dahab-coffee/src/Hero.tsx", root),
    "/dahab-coffee/src/Hero.tsx"
  );
  assert.equal(
    normalizeVirtualPath("C:\\Users\\melha_eay78bj\\Desktop\\test2\\src\\App.tsx", root),
    "/src/App.tsx"
  );
  assert.equal(normalizeVirtualPath("/Users/melha_eay78bj/Desktop/test2", root), "/");
  assert.equal(normalizeVirtualPath("src/App.tsx", root), "/src/App.tsx");
});

test("normalizeCommandPaths strips host and pseudo-POSIX paths from cd statements", () => {
  const root = "C:\\Users\\melha_eay78bj\\Desktop\\test2";
  assert.equal(
    normalizeCommandPaths("cd /Users/melha_eay78bj/Desktop/test2/dahab-coffee && npm run dev", root),
    "cd dahab-coffee && npm run dev"
  );
  assert.equal(
    normalizeCommandPaths('cd "/Users/melha_eay78bj/Desktop/test2/dahab-coffee" && npm run dev', root),
    'cd "dahab-coffee" && npm run dev'
  );
  assert.equal(
    normalizeCommandPaths('cd "C:\\Users\\melha_eay78bj\\Desktop\\test2" && npm test', root),
    "cd . && npm test"
  );
  assert.equal(
    normalizeCommandPaths("cd /Users/melha_eay78bj/Desktop/test2 && npm test", root),
    "cd . && npm test"
  );
  assert.equal(
    normalizeCommandPaths("npm test", root),
    "npm test"
  );
});

test("getAgentBackend intercepts resolvePath and prevents nested Users directory creation", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-path-test-"));
  try {
    const project = { id: "test-proj", root: tmpDir, name: "test" };
    const { backend } = await getAgentBackend(project);

    // Simulate model passing a hallucinated POSIX path of the project root
    const fakePosix = tmpDir.replace(/^[a-zA-Z]:/, "").replace(/\\/g, "/") + "/subfolder/file.txt";
    const resolved = backend.resolvePath(fakePosix);

    // It must resolve INSIDE the temp dir at subfolder/file.txt
    const expected = path.resolve(tmpDir, "subfolder/file.txt");
    assert.equal(path.resolve(resolved), expected);

    // Perform a write via the backend
    await backend.write(fakePosix, "hello world");

    // Verify physical file was written at expected location
    const content = await fs.readFile(expected, "utf8");
    assert.equal(content, "hello world");

    // Crucially: no "Users" directory was created inside the project root!
    const entries = await fs.readdir(tmpDir);
    assert.ok(!entries.includes("Users"), `Unexpected "Users" directory created in project root: ${entries.join(", ")}`);
    assert.ok(entries.includes("subfolder"));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("toolParameterNormalizationMiddleware normalizes hallucinated paths in tool calls", async () => {
  const root = "C:\\Users\\melha_eay78bj\\Desktop\\test2";
  const mw = toolParameterNormalizationMiddleware(root);

  // Test wrapModelCall
  const mockResponse = {
    tool_calls: [
      {
        name: "write_file",
        args: {
          filePath: "/Users/melha_eay78bj/Desktop/test2/dahab-coffee/src/Hero.tsx",
          content: "export const Hero = () => null;",
        },
      },
      {
        name: "execute",
        args: {
          command: "cd /Users/melha_eay78bj/Desktop/test2/dahab-coffee && npm run dev",
        },
      },
    ],
  };

  const handler = async () => mockResponse;
  const wrapped = mw.wrapModelCall;
  const result = await wrapped({}, handler);

  const tc1 = result.tool_calls[0];
  assert.equal(tc1.args.file_path, "/dahab-coffee/src/Hero.tsx");
  assert.equal(tc1.args.filePath, "/dahab-coffee/src/Hero.tsx");

  const tc2 = result.tool_calls[1];
  assert.equal(tc2.args.command, "cd dahab-coffee && npm run dev");
});

test("apply_patch handles hallucinated POSIX path without creating nested Users directory", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-patch-test-"));
  try {
    const { createEditTools } = await import("../dist-electron/edit-tools.js");
    const tools = createEditTools(tmpDir);
    const applyPatch = tools.find((t) => t.name === "apply_patch");
    assert.ok(applyPatch, "apply_patch tool not found");

    const posixPrefix = tmpDir.replace(/^[a-zA-Z]:/, "").replace(/\\/g, "/");
    const patchText = `*** Add File: ${posixPrefix}/src/NewComponent.tsx
export const NewComponent = () => <div>Hello</div>;
`;

    const res = await applyPatch.invoke({ patchText });
    assert.match(String(res), /added/i);

    const targetFile = path.resolve(tmpDir, "src/NewComponent.tsx");
    const content = await fs.readFile(targetFile, "utf8");
    assert.match(content, /Hello/);

    const entries = await fs.readdir(tmpDir);
    assert.ok(!entries.includes("Users"), `Unexpected "Users" directory created by apply_patch: ${entries.join(", ")}`);
    assert.ok(entries.includes("src"));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

