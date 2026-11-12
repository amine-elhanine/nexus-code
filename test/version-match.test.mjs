// Regression test: ensure package.json version matches CHANGELOG.md latest release header.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");

const match = changelog.match(/##\s*\[(\d+\.\d+\.\d+)\]/);
assert.ok(match, "CHANGELOG.md must contain a version header like ## [0.5.0]");

const changelogVersion = match[1];
assert.equal(
  pkg.version,
  changelogVersion,
  `package.json version (${pkg.version}) must match latest CHANGELOG.md version (${changelogVersion})`
);

console.log(`✓ Version metadata matches: ${pkg.version}`);
