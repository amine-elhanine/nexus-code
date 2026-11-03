// Home-workspace file snapshots (detect files produced by a Home run).
// Extracted verbatim from agent-service.ts; no behavior change.

import { promises as fsPromises } from "node:fs";
import path from "node:path";

export type HomeFileSnapshot = Map<string, number>;

export async function snapshotHomeFiles(root: string): Promise<HomeFileSnapshot> {
  const snapshot: HomeFileSnapshot = new Map();
  async function walk(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[] = [];
    try { entries = await fsPromises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      try {
        const stat = await fsPromises.stat(full);
        snapshot.set(path.relative(root, full).replace(/\\/g, "/"), stat.mtimeMs);
      } catch { /* best effort */ }
    }
  }
  await walk(root);
  return snapshot;
}

export async function findFreshHomeFiles(root: string, baseline: HomeFileSnapshot, startedAt: number): Promise<string[]> {
  const current = await snapshotHomeFiles(root);
  return [...current.entries()]
    .filter(([relative, mtime]) => !baseline.has(relative) || mtime >= startedAt - 1000)
    .map(([relative]) => relative)
    .sort();
}
