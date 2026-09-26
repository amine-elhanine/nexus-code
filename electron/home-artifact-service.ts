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

function isGeneratedSource(filePath: string): boolean {
  const name = path.basename(filePath);
  return SOURCE_EXTENSIONS.test(name) && /^(generate|create|build|make|render|export|convert|produce|tmp|temp)[-_]/i.test(name);
}

function validateHeader(filePath: string, bytes: Buffer): string | null {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".pdf" && bytes.subarray(0, 5).toString("ascii") !== "%PDF-") return "invalid PDF header";
  if ([".docx", ".pptx", ".xlsx", ".zip"].includes(ext) && bytes.subarray(0, 2).toString("ascii") !== "PK") return "invalid ZIP-based document header";
  if ([".png"].includes(ext) && bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return "invalid PNG header";
  if ([".jpg", ".jpeg"].includes(ext) && !(bytes[0] === 0xff && bytes[1] === 0xd8)) return "invalid JPEG header";
  return null;
}

export async function validateHomeArtifact(root: string, relativePath: string): Promise<HomeArtifactCheck> {
  const normalized = relativePath.replace(/\\/g, "/");
  const full = path.resolve(root, normalized);
  const rootWithSep = `${path.resolve(root)}${path.sep}`;
  if (full !== path.resolve(root) && !full.startsWith(rootWithSep)) {
    return { path: normalized, valid: false, size: 0, checks: [], error: "path escapes Home workspace" };
  }
  try {
    const stat = await fs.stat(full);
    if (!stat.isFile()) return { path: normalized, valid: false, size: 0, checks: [], error: "output is not a file" };
    if (stat.size === 0) return { path: normalized, valid: false, size: 0, checks: ["exists"], error: "output is empty" };
    const bytes = await fs.readFile(full);
    const headerError = validateHeader(normalized, bytes);
    if (headerError) return { path: normalized, valid: false, size: stat.size, checks: ["exists", "non-empty"], error: headerError };
    const checks = ["exists", "non-empty", "readable"];
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

/** Prefer final-looking outputs when a run also leaves a generator script. */
export function selectHomeArtifactCandidates(relativePaths: string[]): string[] {
  const final = relativePaths.filter((p) => !isGeneratedSource(p));
  return final.length ? final : relativePaths;
}
