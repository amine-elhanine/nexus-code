import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export type HomeArtifactCheck = {
  path: string;
  valid: boolean;
  size: number;
  checks: string[];
  error?: string;
};

const SOURCE_EXTENSIONS = /\.(?:py|js|jsx|ts|tsx|mjs|cjs|sh|ps1|bat|cmd)$/i;
const OFFICE_PARTS: Record<string, { main: string; marker: RegExp; contentType: string; slide?: boolean; worksheet?: boolean }> = {
  ".docx": {
    main: "word/document.xml",
    marker: /<(?:\w+:)?document(?:\s|>)/,
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
  },
  ".pptx": {
    main: "ppt/presentation.xml",
    marker: /<(?:\w+:)?presentation(?:\s|>)/,
    contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
    slide: true,
  },
  ".xlsx": {
    main: "xl/workbook.xml",
    marker: /<(?:\w+:)?workbook(?:\s|>)/,
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
    worksheet: true,
  },
};

type OfficeZipEntry = { dir?: boolean; async: (type: "string") => Promise<string> };

function isGeneratedSource(filePath: string): boolean {
  const name = path.basename(filePath);
  return SOURCE_EXTENSIONS.test(name) && /^(generate|create|build|make|render|export|convert|produce|tmp|temp)[-_]/i.test(name);
}

function validateHeader(filePath: string, bytes: Buffer): string | null {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".pdf" && bytes.subarray(0, 5).toString("ascii") !== "%PDF-") return "invalid PDF header";
  if ([...Object.keys(OFFICE_PARTS), ".zip"].includes(ext) && bytes.subarray(0, 2).toString("ascii") !== "PK") return "invalid ZIP-based document header";
  if (ext === ".pdf") {
    const tail = bytes.subarray(Math.max(0, bytes.length - 2048)).toString("latin1");
    if (!tail.includes("%%EOF")) return "PDF end marker not found";
  }
  if ([".png"].includes(ext) && bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return "invalid PNG header";
  if ([".jpg", ".jpeg"].includes(ext) && !(bytes[0] === 0xff && bytes[1] === 0xd8)) return "invalid JPEG header";
  return null;
}

async function validateOfficeStructure(filePath: string, bytes: Buffer): Promise<string | null> {
  const ext = path.extname(filePath).toLowerCase();
  const spec = OFFICE_PARTS[ext];
  if (!spec) return null;
  try {
    const mod = await import("jszip");
    const JSZip = (mod as unknown as { default: new () => { loadAsync: (buffer: Buffer) => Promise<{ files: Record<string, OfficeZipEntry> }> } }).default;
    const archive = await new JSZip().loadAsync(bytes);
    const files = archive.files;
    const contentTypes = files["[Content_Types].xml"];
    if (!contentTypes || contentTypes.dir) return "Office archive is missing [Content_Types].xml";
    const contentTypesXml = await contentTypes.async("string");
    if (!/<(?:\w+:)?Types(?:\s|>)/.test(contentTypesXml)) return "Office content types are malformed";
    if (!contentTypesXml.includes(spec.contentType)) return "Office content types do not declare the required main document part";
    const mainPart = files[spec.main];
    if (!mainPart || mainPart.dir) return `Office archive is missing ${spec.main}`;
    const mainXml = await mainPart.async("string");
    if (!spec.marker.test(mainXml)) return `${spec.main} has no valid root element`;
    if (spec.slide) {
      const slideEntry = Object.entries(files).find(([name, item]) => /^ppt\/slides\/slide\d+\.xml$/i.test(name) && !item.dir)?.[1];
      if (!slideEntry) return "PowerPoint archive contains no slides";
      if (!/<(?:\w+:)?sld(?:\s|>)/.test(await slideEntry.async("string"))) return "PowerPoint slide content is malformed";
    }
    if (spec.worksheet) {
      const worksheetEntry = Object.entries(files).find(([name, item]) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name) && !item.dir)?.[1];
      if (!worksheetEntry) return "Excel archive contains no worksheets";
      if (!/<(?:\w+:)?worksheet(?:\s|>)/.test(await worksheetEntry.async("string"))) return "Excel worksheet content is malformed";
    }
    return null;
  } catch {
    return "Office archive is corrupt or unreadable";
  }
}

async function validatePdfStructure(bytes: Buffer): Promise<string | null> {
  type PdfParser = { getText: () => Promise<{ pages?: unknown[] }>; destroy: () => Promise<void> };
  let parser: PdfParser | undefined;
  try {
    const mod = await import("pdf-parse");
    const PDFParse = (mod as unknown as { PDFParse: new (opts: { data: Buffer }) => PdfParser }).PDFParse;
    parser = new PDFParse({ data: bytes });
    const result = await parser.getText();
    if (!Array.isArray(result.pages) || result.pages.length === 0) return "PDF contains no readable pages";
    return null;
  } catch {
    return "PDF structure is corrupt or unreadable";
  } finally {
    await parser?.destroy().catch(() => {});
  }
}

export async function validateHomeArtifact(root: string, relativePath: string): Promise<HomeArtifactCheck> {
  const normalized = relativePath.replace(/\\/g, "/");
  const resolvedRoot = path.resolve(root);
  const full = path.resolve(resolvedRoot, normalized);
  const rootWithSep = `${resolvedRoot}${path.sep}`;
  if (full !== resolvedRoot && !full.startsWith(rootWithSep)) {
    return { path: normalized, valid: false, size: 0, checks: [], error: "path escapes Home workspace" };
  }
  try {
    const [realRoot, realFile] = await Promise.all([fs.realpath(resolvedRoot), fs.realpath(full)]);
    const relativeToRoot = path.relative(realRoot, realFile);
    if (relativeToRoot === ".." || relativeToRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToRoot)) {
      return { path: normalized, valid: false, size: 0, checks: [], error: "path escapes Home workspace through a symbolic link" };
    }
    const stat = await fs.stat(full);
    if (!stat.isFile()) return { path: normalized, valid: false, size: 0, checks: [], error: "output is not a file" };
    if (stat.size === 0) return { path: normalized, valid: false, size: 0, checks: ["exists"], error: "output is empty" };
    const bytes = await fs.readFile(full);
    const headerError = validateHeader(normalized, bytes);
    if (headerError) return { path: normalized, valid: false, size: stat.size, checks: ["exists", "non-empty"], error: headerError };
    const checks = ["exists", "non-empty", "readable"];
    if (path.extname(normalized).toLowerCase() === ".pdf") {
      const pdfError = await validatePdfStructure(bytes);
      if (pdfError) return { path: normalized, valid: false, size: stat.size, checks, error: pdfError };
      checks.push("PDF pages parsed");
    }
    const officeError = await validateOfficeStructure(normalized, bytes);
    if (officeError) return { path: normalized, valid: false, size: stat.size, checks, error: officeError };
    if (OFFICE_PARTS[path.extname(normalized).toLowerCase()]) checks.push("office package structure valid");
    const textLike = /\.(?:txt|md|markdown|csv|json|html?|xml|tex|log)$/i.test(normalized);
    if (textLike && !bytes.toString("utf8").trim()) {
      return { path: normalized, valid: false, size: stat.size, checks, error: "text output contains no readable content" };
    }
    checks.push("structure plausible");
    return { path: normalized, valid: true, size: stat.size, checks };
  } catch (error) {
    return { path: normalized, valid: false, size: 0, checks: [], error: error instanceof Error ? error.message : String(error) };
  }
}

export async function validateHomeArtifacts(root: string, relativePaths: string[]): Promise<HomeArtifactCheck[]> {
  const unique = [...new Set(relativePaths.map((p) => p.replace(/\\/g, "/")))];
  return Promise.all(unique.map((relativePath) => validateHomeArtifact(root, relativePath)));
}

export type HomeArtifactContractCheck = {
  valid: boolean;
  checks: HomeArtifactCheck[];
  invalidArtifacts: HomeArtifactCheck[];
  missingFormats: string[];
};

/** Validate both that fresh output is readable and that explicit format asks are met. */
export async function validateHomeArtifactContract(
  root: string,
  freshPaths: string[],
  expectedFormats: string[] = []
): Promise<HomeArtifactContractCheck> {
  const candidates = selectHomeArtifactCandidates(freshPaths);
  const checks = candidates.length ? await validateHomeArtifacts(root, candidates) : [];
  const invalidArtifacts = checks.filter((check) => !check.valid);
  const missingFormats = [...new Set(expectedFormats.map((format) => (format.startsWith(".") ? format.slice(1) : format).toLowerCase()))]
    .filter((format) => !freshPaths.some((file) => path.extname(file).toLowerCase() === `.${format}`));
  return {
    valid: freshPaths.length > 0 && invalidArtifacts.length === 0 && missingFormats.length === 0,
    checks,
    invalidArtifacts,
    missingFormats,
  };
}

/** Prefer final-looking outputs when a run also leaves a generator script. */
export function selectHomeArtifactCandidates(relativePaths: string[]): string[] {
  const final = relativePaths.filter((p) => !isGeneratedSource(p));
  return final.length ? final : relativePaths;
}

// ── Artifact Canvas Version History (ChatGPT / Claude Desktop Parity) ───────

export type ArtifactVersionEntry = {
  version: number;
  updatedAt: string;
  sizeBytes: number;
  snapshotRelPath: string;
};

export type ArtifactVersionManifest = {
  filePath: string;
  currentVersion: number;
  versions: ArtifactVersionEntry[];
};

function versionsDir(root: string): string {
  return path.join(root, ".nexus-versions");
}

function assertInsideRoot(root: string, relPath: string): { abs: string; cleanRel: string } {
  const resolvedRoot = path.resolve(root);
  const abs = path.resolve(resolvedRoot, relPath);
  const isWin = process.platform === "win32";
  const rootCmp = isWin ? resolvedRoot.toLowerCase() : resolvedRoot;
  const absCmp = isWin ? abs.toLowerCase() : abs;
  if (absCmp === rootCmp || !absCmp.startsWith(`${rootCmp}${path.sep}`)) {
    throw new Error(`Artifact path escapes workspace root: ${relPath}`);
  }
  const cleanRel = path.relative(resolvedRoot, abs).replace(/\\/g, "/");
  return { abs, cleanRel };
}

function manifestPath(root: string, cleanRel: string): string {
  const safeName = cleanRel.replace(/[\\/]/g, "__") + ".manifest.json";
  return path.join(versionsDir(root), safeName);
}

/** Record a new version snapshot whenever a file is created or updated in the Canvas workspace. */
export async function snapshotArtifactVersion(root: string, relPath: string): Promise<ArtifactVersionEntry | null> {
  try {
    const { abs, cleanRel } = assertInsideRoot(root, relPath);
    const stat = await fs.stat(abs);
    const vDir = versionsDir(root);
    await fs.mkdir(vDir, { recursive: true });

    const mPath = manifestPath(root, cleanRel);
    let manifest: ArtifactVersionManifest = { filePath: cleanRel, currentVersion: 0, versions: [] };
    try {
      manifest = JSON.parse(await fs.readFile(mPath, "utf8"));
    } catch { /* new manifest */ }

    // Skip creating a duplicate snapshot if bytes are identical to the latest version
    const latest = manifest.versions[manifest.versions.length - 1];
    if (latest) {
      try {
        const latestAbs = path.join(root, latest.snapshotRelPath);
        const [curBytes, prevBytes] = await Promise.all([fs.readFile(abs), fs.readFile(latestAbs)]);
        const curHash = crypto.createHash("sha256").update(curBytes).digest("hex");
        const prevHash = crypto.createHash("sha256").update(prevBytes).digest("hex");
        if (curHash === prevHash) return latest;
      } catch { /* proceed with snapshot */ }
    }

    const nextVer = manifest.currentVersion + 1;
    const snapFileName = `${cleanRel.replace(/[\\/]/g, "__")}.v${nextVer}`;
    const snapAbsPath = path.join(vDir, snapFileName);

    await fs.copyFile(abs, snapAbsPath);

    const entry: ArtifactVersionEntry = {
      version: nextVer,
      updatedAt: new Date().toISOString(),
      sizeBytes: stat.size,
      snapshotRelPath: `.nexus-versions/${snapFileName}`,
    };

    manifest.currentVersion = nextVer;
    manifest.versions.push(entry);
    // Keep max 20 versions per artifact
    if (manifest.versions.length > 20) {
      const removed = manifest.versions.shift();
      if (removed) {
        try { await fs.rm(path.join(root, removed.snapshotRelPath), { force: true }); } catch { /* ignore */ }
      }
    }

    await fs.writeFile(mPath, JSON.stringify(manifest, null, 2), "utf8");
    return entry;
  } catch {
    return null;
  }
}

/** List all available version snapshots for an artifact. */
export async function getArtifactVersions(root: string, relPath: string): Promise<ArtifactVersionManifest | null> {
  try {
    const { cleanRel } = assertInsideRoot(root, relPath);
    const mPath = manifestPath(root, cleanRel);
    const data = JSON.parse(await fs.readFile(mPath, "utf8"));
    return data;
  } catch {
    return null;
  }
}

/** Revert artifact content to an earlier version snapshot. */
export async function restoreArtifactVersion(root: string, relPath: string, version: number): Promise<boolean> {
  try {
    const { abs: targetAbs, cleanRel } = assertInsideRoot(root, relPath);
    const manifest = await getArtifactVersions(root, cleanRel);
    if (!manifest) return false;
    const target = manifest.versions.find((v) => v.version === version);
    if (!target) return false;
    const { abs: snapAbs } = assertInsideRoot(root, target.snapshotRelPath);
    await fs.copyFile(snapAbs, targetAbs);
    // Snapshot this restore action as the newest version (force snapshot even if hash matches an earlier entry)
    await snapshotArtifactVersion(root, cleanRel);
    return true;
  } catch {
    return false;
  }
}
