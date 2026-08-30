import { promises as fs, existsSync } from "node:fs";
import path from "node:path";

export type ArtifactStatus = "draft" | "pending_approval" | "approved" | "completed" | "rejected";

export type ArtifactItem = {
  id: string;
  sessionId: string;
  name: string;
  filename: string;
  path: string;
  content: string;
  status: ArtifactStatus;
  userFacing: boolean;
  requestFeedback: boolean;
  createdAt: string;
  updatedAt: string;
};

export function getArtifactsDir(projectRoot: string, sessionId: string): string {
  const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const nexusDir = path.join(projectRoot, ".nexus", "artifacts", safeSessionId);
  const forgeDir = path.join(projectRoot, ".forgepilot", "artifacts", safeSessionId);
  if (!existsSync(nexusDir) && existsSync(forgeDir)) {
    return forgeDir;
  }
  return nexusDir;
}

export async function saveArtifact(
  projectRoot: string,
  sessionId: string,
  filename: string,
  content: string,
  options?: {
    status?: ArtifactStatus;
    userFacing?: boolean;
    requestFeedback?: boolean;
    name?: string;
  }
): Promise<ArtifactItem> {
  const dir = getArtifactsDir(projectRoot, sessionId);
  await fs.mkdir(dir, { recursive: true });

  const safeFilename = path.basename(filename);
  const filePath = path.join(dir, safeFilename);
  const now = new Date().toISOString();

  await fs.writeFile(filePath, content, "utf8");

  // Save sidecar metadata JSON
  const metaPath = path.join(dir, `${safeFilename}.meta.json`);
  const artifact: ArtifactItem = {
    id: `${sessionId}_${safeFilename}`,
    sessionId,
    name: options?.name || (safeFilename === "implementation_plan.md" ? "Implementation Plan" : safeFilename === "walkthrough.md" ? "Walkthrough Report" : safeFilename),
    filename: safeFilename,
    path: filePath,
    content,
    status: options?.status || "draft",
    userFacing: options?.userFacing ?? true,
    requestFeedback: options?.requestFeedback ?? (safeFilename === "implementation_plan.md"),
    createdAt: now,
    updatedAt: now,
  };

  try {
    if (existsSync(metaPath)) {
      const prev = JSON.parse(await fs.readFile(metaPath, "utf8"));
      artifact.createdAt = prev.createdAt || now;
      if (!options?.status && prev.status) artifact.status = prev.status;
    }
  } catch { /* ignore */ }

  await fs.writeFile(metaPath, JSON.stringify(artifact, null, 2), "utf8");
  return artifact;
}

export async function getArtifact(
  projectRoot: string,
  sessionId: string,
  filename: string
): Promise<ArtifactItem | null> {
  const dir = getArtifactsDir(projectRoot, sessionId);
  const safeFilename = path.basename(filename);
  const filePath = path.join(dir, safeFilename);
  const metaPath = path.join(dir, `${safeFilename}.meta.json`);

  if (!existsSync(filePath)) return null;

  try {
    const content = await fs.readFile(filePath, "utf8");
    let meta: Partial<ArtifactItem> = {};
    if (existsSync(metaPath)) {
      meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
    }

    return {
      id: `${sessionId}_${safeFilename}`,
      sessionId,
      name: meta.name || safeFilename,
      filename: safeFilename,
      path: filePath,
      content,
      status: meta.status || "draft",
      userFacing: meta.userFacing ?? true,
      requestFeedback: meta.requestFeedback ?? false,
      createdAt: meta.createdAt || new Date().toISOString(),
      updatedAt: meta.updatedAt || new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export async function listArtifacts(projectRoot: string, sessionId: string): Promise<ArtifactItem[]> {
  const dir = getArtifactsDir(projectRoot, sessionId);
  if (!existsSync(dir)) return [];

  try {
    const files = await fs.readdir(dir);
    const artifacts: ArtifactItem[] = [];

    for (const f of files) {
      if (f.endsWith(".md") && !f.endsWith(".meta.json")) {
        const item = await getArtifact(projectRoot, sessionId, f);
        if (item) artifacts.push(item);
      }
    }

    return artifacts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } catch {
    return [];
  }
}

export async function updateArtifactStatus(
  projectRoot: string,
  sessionId: string,
  filename: string,
  status: ArtifactStatus
): Promise<ArtifactItem | null> {
  const artifact = await getArtifact(projectRoot, sessionId, filename);
  if (!artifact) return null;

  return saveArtifact(projectRoot, sessionId, filename, artifact.content, {
    status,
    name: artifact.name,
    userFacing: artifact.userFacing,
    requestFeedback: status === "pending_approval",
  });
}
