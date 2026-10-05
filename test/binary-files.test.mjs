import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isKnownBinaryFile, isRenderablePreview } from "../src/utils/binaryFiles.ts";
import { readWorkspaceFile, readWorkspaceFileBase64 } from "../dist-electron/project-tools.js";

// ---- Extension classification (renderer routing) ----

test("binaryFiles: office/zip/media/fonts classify as binary", () => {
  for (const file of ["report.pptx", "doc.docx", "Book1.xlsx", "doc.pdf", "photo.PNG", "archive.zip", "app.exe", "font.woff2", "video.mp4", "deep/folder/My Deck.pptx"]) {
    assert.ok(isKnownBinaryFile(file), `${file} should be binary`);
  }
});

test("binaryFiles: text/code files stay in the editor", () => {
  for (const file of ["main.tsx", "README.md", "data.json", "styles.css", "app.py", "logo.svg", "notes.csv", "Makefile", "Dockerfile"]) {
    assert.ok(!isKnownBinaryFile(file), `${file} should stay in the editor`);
  }
  assert.ok(!isKnownBinaryFile("no-extension"), "extensionless files are not binary by name");
});

test("binaryFiles: renderable preview set vs download-only set", () => {
  assert.ok(isRenderablePreview("slide.pptx") && isRenderablePreview("doc.docx") && isRenderablePreview("x.pdf") && isRenderablePreview("sheet.xlsx") && isRenderablePreview("i.png"));
  assert.ok(!isRenderablePreview("archive.zip") && !isRenderablePreview("app.exe"), "zip/exe get a download card, not a render");
  assert.ok(!isRenderablePreview("main.ts"), "text files are editor territory");
});

// ---- Backend read boundary (project-tools) ----

function makeProject() {
  return mkdtempSync(path.join(tmpdir(), "nexus-bin-"));
}

test("workspace read: binary file content is refused, not mojibake", async () => {
  const dir = makeProject();
  try {
    // Fake .pptx: ZIP local-file header followed by NUL bytes — exactly what
    // UTF-8-decoding an Office container turns into editor garbage.
    const fake = Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.alloc(64, 0)]);
    writeFileSync(path.join(dir, "deck.pptx"), fake);
    await assert.rejects(
      () => readWorkspaceFile(dir, "deck.pptx"),
      /Binary file/,
      "readWorkspaceFile must refuse binary content",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("workspace read: text files still load normally", async () => {
  const dir = makeProject();
  try {
    writeFileSync(path.join(dir, "app.ts"), "export const x = 1;\n");
    const result = await readWorkspaceFile(dir, "app.ts");
    assert.equal(result.content, "export const x = 1;\n");
    assert.equal(result.lines, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("workspace readBase64: exact byte round-trip for preview", async () => {
  const dir = makeProject();
  try {
    // Bytes that would NOT survive a UTF-8 text round-trip (high + NUL bytes).
    const payload = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00, 0xfe, 0x80, 0x41]);
    writeFileSync(path.join(dir, "real.pptx"), payload);
    const result = await readWorkspaceFileBase64(dir, "real.pptx");
    assert.equal(result.name, "real.pptx");
    assert.equal(result.path, "real.pptx");
    assert.equal(result.size, payload.length);
    assert.deepEqual(Buffer.from(result.base64, "base64"), payload);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("workspace readBase64: path escape is rejected", async () => {
  const dir = makeProject();
  try {
    await assert.rejects(() => readWorkspaceFileBase64(dir, "../outside.txt"), /escapes|Not a file|no such/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
