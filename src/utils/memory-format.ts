/**
 * Pure parsers for Code-mode memory strings (renderer-side, mirroring the
 * backend's home-memory-service format so the Memory panel can display
 * structured rows instead of raw textareas):
 * - Project facts: markdown sections written by formatHomeMemory
 *   ("## User Profile", "## Preferences", "## Remembered Facts", "## Project Context").
 * - Project memory: one-line-per-run rolling log entries
 *   ("Recent work (YYYY-MM-DD): request → result" / "Interrupted work (…)").
 */

export type MemorySections = {
  profile: string[];
  preferences: string[];
  facts: string[];
  context: string[];
};

const SECTION_MATCHERS: Array<{ key: keyof MemorySections; pattern: RegExp }> = [
  // Tested against the header TITLE (the "## " prefix is already stripped).
  { key: "profile", pattern: /^(user\s+)?profile\b/i },
  { key: "preferences", pattern: /^(preferences|conventions|guidelines)\b/i },
  { key: "facts", pattern: /^(remembered(\s+facts)?|facts)\b/i },
  { key: "context", pattern: /^(project(\s+context)?|context|ongoing)\b/i },
];

function isBullet(line: string): boolean {
  return /^[\s]*([*•\-]|(\d+[\.\)]))\s+/.test(line);
}

function cleanBullet(line: string): string {
  return line.replace(/^[\s]*([*•\-]|(\d+[\.\)]))\s+/, "").trim();
}

export function parseMemorySections(raw: string | undefined | null): MemorySections {
  const result: MemorySections = { profile: [], preferences: [], facts: [], context: [] };
  if (!raw || !raw.trim()) return result;
  let current: keyof MemorySections | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    const header = trimmed.match(/^#{1,3}\s+(.+)$/);
    if (header) {
      current = null;
      for (const { key, pattern } of SECTION_MATCHERS) {
        if (pattern.test(header[1])) {
          current = key;
          break;
        }
      }
      continue;
    }
    if (!current || !trimmed || !isBullet(trimmed)) continue;
    const item = cleanBullet(trimmed);
    if (item && !result[current].some((existing) => existing.toLowerCase() === item.toLowerCase())) {
      result[current].push(item);
    }
  }
  return result;
}

export type WorkLogEntry = {
  date: string;
  text: string;
  kind: "work" | "interrupted";
};

const WORK_LOG_LINE = /^(Recent|Interrupted) work \((\d{4}-\d{2}-\d{2})\):\s*(.+)$/i;

export function parseWorkLog(raw: string | undefined | null): WorkLogEntry[] {
  if (!raw || !raw.trim()) return [];
  const out: WorkLogEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const match = line.trim().match(WORK_LOG_LINE);
    if (!match) continue;
    out.push({
      kind: match[1].toLowerCase() === "interrupted" ? "interrupted" : "work",
      date: match[2],
      text: match[3].trim(),
    });
  }
  return out;
}
