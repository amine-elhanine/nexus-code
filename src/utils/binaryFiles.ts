// Binary-file classification for the Code-mode file tree.
//
// Text/code files open in the Monaco editor as before. Anything here is a
// container or media format that would decode to mojibake as UTF-8, so it is
// routed to the file previewer instead (FilePreviewModal renders the
// document kinds natively and offers download/reveal for the rest).

/** Binary formats the previewer can actually render. */
export const RENDERABLE_BINARY_EXTS = new Set([
  "pdf",
  "docx", "pptx", "ppsx",
  "xlsx", "xls",
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "tiff",
]);

/** Known binary formats the previewer can't render — it still shows a clean download card instead of mojibake. */
export const OTHER_BINARY_EXTS = new Set([
  "doc", "ppt", "odt", "ods", "odp",
  "zip", "jar", "gz", "tgz", "bz2", "xz", "7z", "rar", "tar",
  "exe", "dll", "so", "dylib", "msi", "apk", "dmg", "iso", "appimage",
  "o", "obj", "lib", "a", "class", "pyc", "pyo", "wasm",
  "woff", "woff2", "ttf", "otf", "eot",
  "mp4", "mp3", "m4a", "mov", "avi", "mkv", "wav", "flac", "webm",
  "sqlite", "sqlite3", "db",
  "psd", "ai", "sketch", "bin", "dat", "pak",
]);

export const KNOWN_BINARY_EXTS = new Set([...RENDERABLE_BINARY_EXTS, ...OTHER_BINARY_EXTS]);

function extOf(filePath: string): string {
  const name = (filePath || "").split("/").pop() || "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "";
  return name.slice(dot + 1).toLowerCase();
}

/** True when the file is a known binary that must never be loaded into the code editor. */
export function isKnownBinaryFile(filePath: string): boolean {
  return KNOWN_BINARY_EXTS.has(extOf(filePath));
}

/** True when the previewer can render the file's content (not just offer a download). */
export function isRenderablePreview(filePath: string): boolean {
  return RENDERABLE_BINARY_EXTS.has(extOf(filePath));
}
