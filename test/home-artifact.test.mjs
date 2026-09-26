import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  selectHomeArtifactCandidates,
  validateHomeArtifacts,
} from "../dist-electron/home-artifact-service.js";

test("Home artifact validation checks nested outputs and basic structure", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-home-artifact-"));
  try {
    await fs.mkdir(path.join(root, "nested"), { recursive: true });
    await fs.writeFile(path.join(root, "nested", "course.pdf"), "%PDF-1.7\ncourse content", "ascii");
    await fs.writeFile(path.join(root, "generate-course.py"), "print('generator')", "utf8");
    await fs.writeFile(path.join(root, "broken.pdf"), "not a pdf", "utf8");

    const candidates = selectHomeArtifactCandidates(["nested/course.pdf", "generate-course.py", "broken.pdf"]);
    assert.deepEqual(candidates, ["nested/course.pdf", "broken.pdf"]);
    const checks = await validateHomeArtifacts(root, candidates);
    assert.equal(checks.find((check) => check.path === "nested/course.pdf")?.valid, true);
    assert.equal(checks.find((check) => check.path === "broken.pdf")?.valid, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
