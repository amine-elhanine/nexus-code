import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Atomic file write: temp file in the destination directory + rename, so a
 * crash mid-write can never leave a truncated JSON/journal behind. The rename
 * is atomic within a directory on Windows and POSIX alike.
 */
export async function writeFileAtomic(file: string, data: string | Uint8Array): Promise<void> {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, file);
  } catch (error) {
    try { await fs.unlink(tmp); } catch { /* temp already gone */ }
    throw error;
  }
}

/**
 * Serializes read-modify-write cycles per absolute file path: concurrent
 * callers queue instead of racing a stale snapshot over the newer content.
 */
const fileLocks = new Map<string, Promise<unknown>>();

export function withFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(file);
  const previous = fileLocks.get(key) || Promise.resolve();
  const run = previous.then(fn, fn);
  fileLocks.set(key, run.then(() => undefined, () => undefined));
  return run;
}
