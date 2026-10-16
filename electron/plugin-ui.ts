// Plugin UI file serving (testable helper; wired to IPC in main.ts).
//
// A plugin's `ui` contributions reference static HTML files inside the
// plugin dir (e.g. "./ui/calendar.html"). The renderer must never read
// plugin files directly: it asks the main process for the EXACT entry
// string declared in the validated manifest, and the main process returns
// the file text after containment + type + size checks. The renderer then
// mounts it in a sandboxed iframe (allow-scripts only, opaque origin).
//
// This module does no Electron imports so unit tests can exercise it.

import { promises as fs } from "node:fs";
import path from "node:path";
import type { ValidatedPluginManifest } from "./plugin-manifest.js";

export const MAX_UI_HTML_BYTES = 512 * 1024; // 512KB per UI file

export type UiFileRequest = { pluginId: string; entry: string };

export function validateUiRequest(input: unknown): { ok: true; request: UiFileRequest } | { ok: false; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "UI request must be an object." };
  }
  const { pluginId, entry } = input as { pluginId?: unknown; entry?: unknown };
  if (typeof pluginId !== "string" || !/^[a-z0-9][a-z0-9._-]*$/i.test(pluginId.trim()) || pluginId.trim().length > 64) {
    return { ok: false, error: "Invalid plugin id." };
  }
  if (typeof entry !== "string" || !entry.trim() || entry.length > 256) {
    return { ok: false, error: "Invalid UI entry." };
  }
  return { ok: true, request: { pluginId: pluginId.trim().toLowerCase(), entry: entry.trim() } };
}

/**
 * Resolve + read a declared UI file. The requested `entry` must EXACTLY match
 * a `ui[].entry` string in the validated manifest — arbitrary paths are never
 * served, even inside the plugin dir.
 */
export async function readPluginUiHtml(
  pluginDir: string,
  manifest: ValidatedPluginManifest,
  entry: string
): Promise<{ title: string; slot: string; html: string }> {
  const declared = manifest.ui.find((u) => u.entry === entry);
  if (!declared) {
    throw new Error("UI entry is not declared in the plugin manifest.");
  }
  const normalized = entry.replace(/\\/g, "/");
  if (!/\.html?$/i.test(normalized)) {
    throw new Error("Only .html UI files can be served.");
  }
  const root = path.resolve(pluginDir);
  const resolved = path.resolve(root, normalized);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error("UI entry escapes plugin directory.");
  }
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat || !stat.isFile()) throw new Error("UI file is missing.");
  if (stat.size > MAX_UI_HTML_BYTES) {
    throw new Error(`UI file exceeds ${MAX_UI_HTML_BYTES} bytes.`);
  }
  if (stat.size === 0) throw new Error("UI file is empty.");
  const html = await fs.readFile(resolved, "utf8");
  if (!html.trim()) throw new Error("UI file is empty.");
  // Refuse active server-side constructs: the file is mounted as static
  // markup with scripts; anything else is a packaging error.
  if (/<\s*(object|embed|applet)\b/i.test(html)) {
    throw new Error("UI file contains a forbidden element (<object>/<embed>/<applet>).");
  }
  return { title: declared.title, slot: declared.slot, html };
}
