import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getProjectIndexSection } from "../dist-electron/project-index-service.js";
import { pickAffectedPackageCommands } from "../dist-electron/agent-service.js";

const root = await mkdtemp(path.join(os.tmpdir(), "nexus-large-index-"));
try {
  await mkdir(path.join(root, "packages", "core", "src"), { recursive: true });
  await mkdir(path.join(root, "packages", "app", "src"), { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ private: true }));
  await writeFile(path.join(root, "packages", "core", "package.json"), JSON.stringify({ scripts: { check: "tsc --noEmit" } }));
  await writeFile(path.join(root, "packages", "app", "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
  await writeFile(path.join(root, "packages", "core", "src", "api.ts"), "export function createUser(name: string) { return { name }; }\n");
  await writeFile(path.join(root, "packages", "app", "src", "consumer.ts"), "import { createUser } from '../../core/src/api';\nexport const user = createUser('x');\n");

  const index = await getProjectIndexSection(root, "createUser API");
  assert.match(index, /packages\/core\/src\/api\.ts/);
  assert.match(index, /packages\/app\/src\/consumer\.ts/);
  const disk = JSON.parse(await readFile(path.join(root, ".nexus", "project-index.json"), "utf8"));
  assert.deepEqual(disk.files["packages/app/src/consumer.ts"].dependencies, ["packages/core/src/api.ts"]);

  const commands = pickAffectedPackageCommands(root, ["packages/app/src/consumer.ts"]);
  assert.deepEqual(commands, ['npm --prefix "packages/app" run test']);
  console.log("PASS: persistent project index and affected-package verification");
} finally {
  await rm(root, { recursive: true, force: true });
}
