import assert from "node:assert/strict";
import test from "node:test";
import { parseGitStatusPorcelain } from "../dist-electron/diff-service.js";

test("git status: untracked files map to U, including files inside untracked dirs", () => {
  const out = [
    "?? gauss_seidel.py",
    "?? .streamlit/",
    "?? .streamlit/config.toml",
  ].join("\n");
  const entries = parseGitStatusPorcelain(out);
  assert.deepEqual(entries, [
    { path: "gauss_seidel.py", code: "U" },
    // Directory rows are dropped by --untracked-files=all upstream; if one
    // slips through, it still decorates harmlessly (the tree has no such row).
    { path: ".streamlit/", code: "U" },
    { path: ".streamlit/config.toml", code: "U" },
  ]);
});

test("git status: staged, modified, deleted and renamed codes", () => {
  const out = [
    "A  src/new.ts",
    "M  src/edit.ts",
    " D src/gone.ts",
    "R  old-name.ts -> new-name.ts",
    "MM both-touched.ts",
  ].join("\n");
  const entries = parseGitStatusPorcelain(out);
  assert.deepEqual(entries, [
    { path: "src/new.ts", code: "A" },
    { path: "src/edit.ts", code: "M" },
    { path: "src/gone.ts", code: "D" },
    { path: "new-name.ts", code: "R" },
    { path: "both-touched.ts", code: "M" },
  ]);
});

test("git status: quoted and Windows-style paths normalize", () => {
  const entries = parseGitStatusPorcelain('?? "folder with space/file name.py"\nM  src\\windows\\path.ts');
  assert.equal(entries[0].path, "folder with space/file name.py");
  assert.equal(entries[0].code, "U");
  assert.equal(entries[1].path, "src/windows/path.ts");
});

test("git status: garbage and empty input yield no entries", () => {
  assert.deepEqual(parseGitStatusPorcelain(""), []);
  assert.deepEqual(parseGitStatusPorcelain("short"), []);
});
