import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";

import {
  selectHomeArtifactCandidates,
  validateHomeArtifact,
  validateHomeArtifactContract,
  validateHomeArtifacts,
} from "../dist-electron/home-artifact-service.js";

function minimalPdf(text = "Readable Home report") {
  const stream = `BT /F1 12 Tf 72 72 Td (${text.replace(/[()\\]/g, "\\$&")}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf, "ascii"));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, "ascii");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "ascii");
}

test("Home artifact validation checks nested outputs and basic structure", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-home-artifact-"));
  try {
    await fs.mkdir(path.join(root, "nested"), { recursive: true });
    await fs.writeFile(path.join(root, "nested", "course.pdf"), minimalPdf());
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

test("Home artifact validation rejects a symlink that points outside the workspace", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-home-artifact-link-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-home-artifact-outside-"));
  try {
    await fs.writeFile(path.join(outside, "secret.md"), "# Outside workspace\n", "utf8");
    try {
      await fs.symlink(outside, path.join(root, "linked"), "junction");
    } catch (error) {
      if (process.platform === "win32") return;
      throw error;
    }
    const result = await validateHomeArtifact(root, "linked/secret.md");
    assert.equal(result.valid, false);
    assert.match(result.error || "", /escapes Home workspace through a symbolic link/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("Home output contract rejects a valid artifact in the wrong requested format", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-home-contract-format-"));
  try {
    await fs.writeFile(path.join(root, "report.md"), "# Report\n\nReadable output.", "utf8");
    const result = await validateHomeArtifactContract(root, ["report.md"], ["pdf"]);
    assert.equal(result.valid, false);
    assert.deepEqual(result.missingFormats, ["pdf"]);
    assert.equal(result.invalidArtifacts.length, 0, "the Markdown artifact itself is valid");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Home output contract accepts each requested format when fresh outputs are readable", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-home-contract-multi-"));
  try {
    await fs.mkdir(path.join(root, "nested"), { recursive: true });
    await fs.writeFile(path.join(root, "nested", "report.pdf"), minimalPdf("Contract PDF"));
    await fs.writeFile(path.join(root, "report.md"), "# Report\n\nReadable output.", "utf8");
    const result = await validateHomeArtifactContract(root, ["nested/report.pdf", "report.md"], ["pdf", "md"]);
    assert.equal(result.valid, true);
    assert.deepEqual(result.missingFormats, []);
    assert.deepEqual(result.invalidArtifacts, []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Home artifact validation parses Office archives and requires their main content parts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-home-office-"));
  try {
    const office = [
      ["docx", "word/document.xml", "<w:document></w:document>", "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"],
      ["pptx", "ppt/presentation.xml", "<p:presentation></p:presentation>", "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"],
      ["xlsx", "xl/workbook.xml", "<workbook></workbook>", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"],
    ];
    for (const [ext, mainPart, mainXml, contentType] of office) {
      const zip = new JSZip();
      zip.file("[Content_Types].xml", `<Types><Override PartName="/${mainPart}" ContentType="${contentType}"/></Types>`);
      zip.file(mainPart, mainXml);
      if (ext === "pptx") zip.file("ppt/slides/slide1.xml", "<p:sld></p:sld>");
      if (ext === "xlsx") zip.file("xl/worksheets/sheet1.xml", "<worksheet></worksheet>");
      await fs.writeFile(path.join(root, `valid.${ext}`), await zip.generateAsync({ type: "nodebuffer" }));
    }
    const brokenZip = new JSZip();
    brokenZip.file("[Content_Types].xml", `<Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
    await fs.writeFile(path.join(root, "missing-content.docx"), await brokenZip.generateAsync({ type: "nodebuffer" }));
    await fs.writeFile(path.join(root, "corrupt.pptx"), Buffer.from("PK not really a zip"));
    await fs.writeFile(path.join(root, "truncated.pdf"), "%PDF-1.7\nmissing EOF", "ascii");
    const wrongContentTypeZip = new JSZip();
    wrongContentTypeZip.file("[Content_Types].xml", "<Types><Override PartName=\"/word/document.xml\" ContentType=\"application/xml\"/></Types>");
    wrongContentTypeZip.file("word/document.xml", "<w:document></w:document>");
    await fs.writeFile(path.join(root, "wrong-content-type.docx"), await wrongContentTypeZip.generateAsync({ type: "nodebuffer" }));

    const checks = await validateHomeArtifacts(root, ["valid.docx", "valid.pptx", "valid.xlsx", "missing-content.docx", "corrupt.pptx", "truncated.pdf", "wrong-content-type.docx"]);
    for (const name of ["valid.docx", "valid.pptx", "valid.xlsx"]) assert.equal(checks.find((item) => item.path === name)?.valid, true, `${name} should validate`);
    assert.match(checks.find((item) => item.path === "missing-content.docx")?.error || "", /missing word\/document\.xml/);
    assert.match(checks.find((item) => item.path === "corrupt.pptx")?.error || "", /corrupt or unreadable/);
    assert.match(checks.find((item) => item.path === "truncated.pdf")?.error || "", /end marker/);
    assert.match(checks.find((item) => item.path === "wrong-content-type.docx")?.error || "", /do not declare the required main document part/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Home artifact validation rejects a PDF that only imitates its header and end marker", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-home-pdf-spoof-"));
  try {
    const spoofed = path.join(root, "spoofed.pdf");
    await fs.writeFile(spoofed, "%PDF-1.7\nThis is not a PDF document.\n%%EOF\n", "ascii");
    const result = await validateHomeArtifact(root, "spoofed.pdf");
    assert.equal(result.valid, false);
    assert.match(result.error || "", /PDF structure is corrupt or unreadable/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
