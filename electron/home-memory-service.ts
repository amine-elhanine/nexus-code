import { tool } from "./agentcore/tools.js";
import { z } from "zod";

/**
 * Home Memory Service:
 * Manages structured long-term memory for Nexus Home mode.
 *
 * Organizes memory into human-readable, user-editable Markdown sections:
 * - ## User Profile (roles, identity, location, background)
 * - ## Preferences (output formats, language, tone, tools)
 * - ## Project Context (ongoing goals, key topics)
 * - ## Recent Deliverables (bounded list of the latest 5 substantive outcomes)
 *
 * Preserves custom user notes and handles legacy plain-text memory seamlessly.
 */

export interface DeliverableItem {
  date: string;
  summary: string;
  sessionId?: string;
}

export type SemanticCategory = "profile" | "preference" | "context" | "fact" | "lesson";

export interface MemoryCandidate {
  category: SemanticCategory;
  fact: string;
}

export interface PendingMemoryCandidate extends MemoryCandidate {
  id: string;
  source: string;
  createdAt: string;
}

export interface HomeMemoryStructure {
  profile: string[];
  preferences: string[];
  /** Durable remembered facts (semantic). Distinct from ongoing project context. */
  facts: string[];
  /** Self-improved operational lessons, patterns, and verified workflows. */
  lessons?: string[];
  context: string[];
  recentDeliverables: DeliverableItem[];
  customNotes?: string;
}

const MAX_RECENT_DELIVERABLES = 5;

/**
 * Normalizes a bullet line (stripping leading `- `, `* `, `• `, and whitespace).
 */
function isBullet(line: string): boolean {
  return /^[\s]*([*•\-]|(\d+[\.\)]))\s+/.test(line);
}

function cleanBullet(line: string): string {
  return line.replace(/^[\s]*([*•\-]|(\d+[\.\)]))\s+/, "").trim();
}

/**
 * Parses existing markdown text (or legacy raw logs) into a structured memory object.
 */
export function parseHomeMemory(raw: string): HomeMemoryStructure {
  const result: HomeMemoryStructure = {
    profile: [],
    preferences: [],
    facts: [],
    lessons: [],
    context: [],
    recentDeliverables: [],
    customNotes: "",
  };

  if (!raw || !raw.trim()) return result;

  const lines = raw.split("\n");
  type Section = "profile" | "preferences" | "facts" | "lessons" | "context" | "deliverables" | "custom" | "unknown";
  let currentSection: Section = "unknown";
  const unparsedLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Check for Markdown headers
    const headerMatch = trimmed.match(/^#{1,3}\s+(.+)$/i);
    if (headerMatch) {
      const title = headerMatch[1].toLowerCase();
      if (/profile|identity|background|bio/i.test(title)) {
        currentSection = "profile";
        continue;
      } else if (/preference|style|conventions|guideline/i.test(title)) {
        currentSection = "preferences";
        continue;
      } else if (/remembered facts|remembered|facts(?!.*deliverable)/i.test(title)) {
        currentSection = "facts";
        continue;
      } else if (/lesson|learned|pattern|workflow|gotcha|self-improvement/i.test(title)) {
        currentSection = "lessons";
        continue;
      } else if (/context|project|topics|ongoing/i.test(title)) {
        currentSection = "context";
        continue;
      } else if (/deliverable|recent work|recent activity|recent/i.test(title)) {
        currentSection = "deliverables";
        continue;
      } else {
        currentSection = "custom";
        unparsedLines.push(line);
        continue;
      }
    }

    if (!trimmed) {
      if (currentSection === "custom" || currentSection === "unknown") {
        unparsedLines.push(line);
      }
      continue;
    }

    // Check for bullet items under specific sections
    if (currentSection === "profile") {
      if (isBullet(trimmed)) {
        const item = cleanBullet(trimmed);
        if (item) result.profile.push(item);
      } else {
        currentSection = "custom";
        unparsedLines.push(line);
      }
    } else if (currentSection === "preferences") {
      if (isBullet(trimmed)) {
        const item = cleanBullet(trimmed);
        if (item) result.preferences.push(item);
      } else {
        currentSection = "custom";
        unparsedLines.push(line);
      }
    } else if (currentSection === "context") {
      if (isBullet(trimmed)) {
        const item = cleanBullet(trimmed);
        if (item) result.context.push(item);
      } else {
        currentSection = "custom";
        unparsedLines.push(line);
      }
    } else if (currentSection === "facts") {
      if (isBullet(trimmed)) {
        const item = cleanBullet(trimmed);
        if (item) result.facts.push(item);
      } else {
        currentSection = "custom";
        unparsedLines.push(line);
      }
    } else if (currentSection === "lessons") {
      if (isBullet(trimmed)) {
        const item = cleanBullet(trimmed);
        if (item) result.lessons!.push(item);
      } else {
        currentSection = "custom";
        unparsedLines.push(line);
      }
    } else if (currentSection === "deliverables") {
      if (isBullet(trimmed)) {
        const cleaned = cleanBullet(trimmed);
        const match = cleaned.match(/^\[?(\d{4}-\d{2}-\d{2})\]?[:\s\-]+(.+)$/);
        if (match) {
          const body = match[2].trim();
          const chatMatch = body.match(/^(.*)\s+\(chat:([A-Za-z0-9_-]{4,})\)\s*$/);
          if (chatMatch) {
            result.recentDeliverables.push({ date: match[1], summary: chatMatch[1].trim(), sessionId: chatMatch[2] });
          } else {
            result.recentDeliverables.push({ date: match[1], summary: body });
          }
        } else if (cleaned) {
          result.recentDeliverables.push({ date: new Date().toISOString().slice(0, 10), summary: cleaned });
        }
      } else {
        currentSection = "custom";
        unparsedLines.push(line);
      }
    } else {
      // Legacy "Recent work (YYYY-MM-DD): task → response" line detection
      const legacyMatch = trimmed.match(/^Recent work \((\d{4}-\d{2}-\d{2})\):\s*(.+)$/i);
      if (legacyMatch) {
        result.recentDeliverables.push({ date: legacyMatch[1], summary: legacyMatch[2].trim() });
      } else {
        unparsedLines.push(line);
      }
    }
  }

  // Deduplicate entries
  result.profile = Array.from(new Set(result.profile));
  result.preferences = Array.from(new Set(result.preferences));
  result.facts = Array.from(new Set(result.facts));
  result.lessons = Array.from(new Set(result.lessons || []));
  result.context = Array.from(new Set(result.context));

  // Cap recent deliverables
  if (result.recentDeliverables.length > MAX_RECENT_DELIVERABLES) {
    result.recentDeliverables = result.recentDeliverables.slice(-MAX_RECENT_DELIVERABLES);
  }

  const customText = unparsedLines.join("\n").trim();
  if (customText) {
    result.customNotes = customText;
  }

  return result;
}

/**
 * Formats a structured memory object back into clear, human-readable Markdown.
 */
export function formatHomeMemory(struct: HomeMemoryStructure): string {
  const sections: string[] = [];

  if (struct.profile.length > 0) {
    sections.push(`## User Profile\n${struct.profile.map((p) => `- ${p}`).join("\n")}`);
  }

  if (struct.preferences.length > 0) {
    sections.push(`## Preferences\n${struct.preferences.map((p) => `- ${p}`).join("\n")}`);
  }

  if (struct.facts.length > 0) {
    sections.push(`## Remembered Facts\n${struct.facts.map((f) => `- ${f}`).join("\n")}`);
  }

  if (struct.lessons && struct.lessons.length > 0) {
    sections.push(`## Learned Patterns & Lessons\n${struct.lessons.map((l) => `- ${l}`).join("\n")}`);
  }

  if (struct.context.length > 0) {
    sections.push(`## Project Context\n${struct.context.map((c) => `- ${c}`).join("\n")}`);
  }

  if (struct.recentDeliverables.length > 0) {
    const items = struct.recentDeliverables
      .slice(-MAX_RECENT_DELIVERABLES)
      .map((d) => `- [${d.date}] ${d.summary}${d.sessionId ? ` (chat:${d.sessionId})` : ""}`);
    sections.push(`## Recent Deliverables\n${items.join("\n")}`);
  }

  if (struct.customNotes && struct.customNotes.trim()) {
    sections.push(struct.customNotes.trim());
  }

  return sections.join("\n\n").trim();
}

/**
 * Adds an enduring fact, preference, or context item to the Home memory.
 */
export function addMemoryFact(
  raw: string,
  category: SemanticCategory,
  fact: string
): string {
  const struct = parseHomeMemory(raw);
  const cleaned = fact.replace(/^[\s\-*•]+/, "").trim().slice(0, 300);
  if (!cleaned) return raw;

  const existsIn = (list: string[]) => list.some((p) => p.toLowerCase() === cleaned.toLowerCase());
  if (category === "profile") {
    if (!existsIn(struct.profile)) struct.profile.push(cleaned);
  } else if (category === "preference") {
    if (!existsIn(struct.preferences)) struct.preferences.push(cleaned);
  } else if (category === "fact") {
    if (!existsIn(struct.facts)) struct.facts.push(cleaned);
  } else if (category === "lesson") {
    struct.lessons = struct.lessons || [];
    if (!existsIn(struct.lessons)) struct.lessons.push(cleaned);
  } else {
    if (!existsIn(struct.context)) struct.context.push(cleaned);
  }

  return formatHomeMemory(struct);
}

/**
 * Removes a fact from memory. Matches the exact fact only: a substring match
 * turned "forget Paris" into deleting "Paris-based projects" and truncating
 * deliverable summaries that merely mentioned the word. Returns how many
 * entries were removed so the caller can tell "removed" apart from
 * "nothing matched" instead of claiming success for both.
 */
export function removeMemoryFactWithCount(raw: string, query: string): { memory: string; removed: number } {
  const struct = parseHomeMemory(raw);
  const target = query.toLowerCase().trim();
  if (!target) return { memory: raw, removed: 0 };

  const isTarget = (item: string) => item.toLowerCase().trim() === target;
  const lessons = struct.lessons || [];
  const removed =
    struct.profile.filter(isTarget).length +
    struct.preferences.filter(isTarget).length +
    struct.facts.filter(isTarget).length +
    lessons.filter(isTarget).length +
    struct.context.filter(isTarget).length +
    struct.recentDeliverables.filter((d) => isTarget(d.summary)).length;
  struct.profile = struct.profile.filter((p) => !isTarget(p));
  struct.preferences = struct.preferences.filter((p) => !isTarget(p));
  struct.facts = struct.facts.filter((f) => !isTarget(f));
  struct.lessons = lessons.filter((l) => !isTarget(l));
  struct.context = struct.context.filter((c) => !isTarget(c));
  struct.recentDeliverables = struct.recentDeliverables.filter((d) => !isTarget(d.summary));

  return { memory: formatHomeMemory(struct), removed };
}

export function removeMemoryFact(raw: string, query: string): string {
  return removeMemoryFactWithCount(raw, query).memory;
}

/**
 * Hard cap on tracked memory items across all sections (agent-recorded facts
 * grow without bound over months). Evicts the OLDEST items from the least
 * durable sections first (context → facts → lessons → preferences → profile) and
 * re-formats. No-op under the cap.
 */
export function capMemoryItems(raw: string, maxItems: number): string {
  const struct = parseHomeMemory(raw);
  const lessons = struct.lessons || [];
  struct.lessons = lessons;
  let over =
    struct.profile.length +
    struct.preferences.length +
    struct.facts.length +
    lessons.length +
    struct.context.length -
    maxItems;
  for (const key of ["context", "facts", "lessons", "preferences", "profile"] as const) {
    if (over <= 0) break;
    const list = struct[key] ?? [];
    const drop = Math.min(over, list.length);
    if (drop > 0) {
      struct[key] = list.slice(drop);
      over -= drop;
    }
  }
  return formatHomeMemory(struct);
}

/**
 * Appends a deliverable to the rolling Recent Deliverables section (capped at 5).
 * The originating chat session id is kept so the UI can link back to it.
 */
export function recordDeliverable(raw: string, task: string, summary: string, sessionId?: string): string {
  const struct = parseHomeMemory(raw);
  const date = new Date().toISOString().slice(0, 10);
  const cleanTask = task.replace(/[\r\n]+/g, " ").trim().slice(0, 120);
  const cleanSummary = summary.replace(/[\r\n]+/g, " ").trim().slice(0, 150);

  const entry = cleanSummary ? `${cleanTask} → ${cleanSummary}` : cleanTask;
  struct.recentDeliverables.push({ date, summary: entry, sessionId });

  if (struct.recentDeliverables.length > MAX_RECENT_DELIVERABLES) {
    struct.recentDeliverables = struct.recentDeliverables.slice(-MAX_RECENT_DELIVERABLES);
  }

  return formatHomeMemory(struct);
}

/**
 * Relevance-ranked memory slice for prompt injection. Profile + preferences
 * are always included (they are small and broadly relevant); remembered
 * facts, project context and recent deliverables are scored by keyword
 * overlap with the current request and only the top items within budget are
 * kept. Returns markdown in the same section format.
 */
const MEMORY_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "for", "with", "about", "into", "that",
  "this", "what", "when", "where", "which", "who", "whom", "whose", "how",
  "does", "do", "is", "are", "was", "were", "be", "been", "have", "has",
  "had", "will", "would", "should", "could", "can", "may", "might", "must",
  "shall", "from", "your", "yours", "you", "me", "my", "please", "tell",
  "show", "give", "list", "find",
]);

function memoryKeywords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9_@.-]+/g)
      .map((w) => w.trim())
      .filter((w) => w.length >= 3 && !MEMORY_STOPWORDS.has(w))
  );
}

export function selectRelevantHomeMemory(raw: string, request: string, budgetChars = 2000): string {
  if (!raw || !raw.trim()) return "";
  const struct = parseHomeMemory(raw);
  const query = memoryKeywords(request || "");
  const score = (text: string): number => {
    if (!query.size) return 0;
    const words = memoryKeywords(text);
    let hits = 0;
    for (const w of words) if (query.has(w)) hits++;
    return hits;
  };

  const sections: string[] = [];
  let used = 0;
  const push = (header: string, lines: string[]) => {
    if (!lines.length) return;
    const block = `${header}\n${lines.join("\n")}`;
    if (used + block.length > budgetChars && used > 0) return;
    sections.push(block.length > budgetChars - used && used > 0 ? block.slice(0, Math.max(0, budgetChars - used)) : block);
    used += block.length;
  };

  // Semantic identity is always relevant.
  push("## User Profile", struct.profile.map((p) => `- ${p}`));
  push("## Preferences", struct.preferences.map((p) => `- ${p}`));

  const rankedFacts = [...struct.facts, ...struct.context]
    .map((f) => ({ text: f, score: score(f) }))
    .sort((a, b) => b.score - a.score);
  const topFacts = rankedFacts.filter((f) => f.score > 0).map((f) => `- ${f.text}`);
  const fallbackFacts = query.size === 0 ? rankedFacts.slice(0, 5).map((f) => `- ${f.text}`) : [];
  const shownFacts = [...topFacts, ...fallbackFacts].slice(0, 10);
  push("## Remembered Facts", shownFacts);

  const lessons = struct.lessons ?? [];
  const rankedLessons = lessons
    .map((l, idx) => ({ text: l, score: score(l), idx }))
    .sort((a, b) => b.score - a.score || b.idx - a.idx);
  const matchingLessons = rankedLessons.filter((l) => l.score > 0).map((l) => l.text);
  const recentLessons = lessons.slice(-3).reverse();
  const shownLessons: string[] = [];
  const seenLessons = new Set<string>();
  for (const item of [...matchingLessons, ...recentLessons]) {
    const key = item.toLowerCase();
    if (!seenLessons.has(key)) {
      seenLessons.add(key);
      shownLessons.push(`- ${item}`);
    }
    if (shownLessons.length >= 6) break;
  }
  push("## Learned Patterns & Lessons", shownLessons);

  const rankedDeliverables = struct.recentDeliverables
    .map((d) => ({ d, score: score(d.summary) }))
    .sort((a, b) => b.score - a.score);
  const topDeliverables = rankedDeliverables
    .filter((r) => r.score > 0)
    .slice(0, 3)
    .map((r) => `- [${r.d.date}] ${r.d.summary}`);
  push("## Recent Deliverables", topDeliverables);

  // Count only tracked categories as hidden: profile/preference bullets also
  // render as "- " lines and previously inflated the "[+N more]" figure.
  const totalFacts = struct.facts.length + struct.context.length + lessons.length;
  const hidden = Math.max(0, totalFacts - shownFacts.length - shownLessons.length + struct.recentDeliverables.length - topDeliverables.length);
  const out = sections.join("\n\n").trim();
  if (!out) return "";
  return hidden > 0 ? `${out}\n\n[+${hidden} more memorized item(s) not shown — ask to recall a specific topic]` : out;
}

/**
 * Searches or lists structured long-term memory entries so the agent can actively
 * inspect stored facts, preferences, lessons, and deliverables on demand.
 */
export function searchMemoryFacts(raw: string, query?: string): string {
  if (!raw || !raw.trim()) return "Memory is currently empty.";
  const struct = parseHomeMemory(raw);
  const q = (query || "").trim();
  if (!q) {
    const formatted = formatHomeMemory(struct);
    return formatted || "Memory is currently empty.";
  }
  const lower = q.toLowerCase();
  const keywords = memoryKeywords(q);
  const matches = (text: string) => {
    const t = text.toLowerCase();
    if (t.includes(lower)) return true;
    if (!keywords.size) return false;
    const itemWords = memoryKeywords(text);
    for (const kw of keywords) {
      if (itemWords.has(kw)) return true;
    }
    return false;
  };
  const filtered: HomeMemoryStructure = {
    profile: struct.profile.filter(matches),
    preferences: struct.preferences.filter(matches),
    facts: struct.facts.filter(matches),
    lessons: (struct.lessons ?? []).filter(matches),
    context: struct.context.filter(matches),
    recentDeliverables: struct.recentDeliverables.filter((d) => matches(d.summary)),
  };
  const out = formatHomeMemory(filtered);
  return out || `No memory entries matched "${q}".`;
}

/**
 * Parses LLM-produced memory candidates. Accepts raw JSON or fenced JSON of
 * the form { "candidates": [{ "category": "profile|preference|fact|context|lesson", "fact": "..." }] }.
 * Invalid entries are dropped; at most 4 candidates returned.
 */
export function parseCandidateFacts(text: string): MemoryCandidate[] {
  if (!text || !text.trim()) return [];
  try {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const raw = (fenced ? fenced[1] : text).trim();
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) return [];
    const parsed = JSON.parse(raw.slice(start, end + 1)) as { candidates?: Array<{ category?: string; fact?: string }> };
    const list = Array.isArray(parsed.candidates) ? parsed.candidates : [];
    const validCategories: SemanticCategory[] = ["profile", "preference", "fact", "context", "lesson"];
    const out: MemoryCandidate[] = [];
    for (const item of list) {
      const cat = String(item?.category || "").toLowerCase().trim();
      const fact = String(item?.fact || "").replace(/\s+/g, " ").trim().slice(0, 200);
      if (!fact || fact.length < 8) continue;
      // Skip transient data (tables, long lists, URLs) — episodic, not semantic.
      if (/\|.*\|/.test(fact) || /https?:\/\//.test(fact)) continue;
      const category = (validCategories.includes(cat as SemanticCategory) ? cat : "fact") as SemanticCategory;
      if (out.some((c) => c.fact.toLowerCase() === fact.toLowerCase())) continue;
      out.push({ category, fact });
      if (out.length >= 4) break;
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Decides whether a Home run deserves the post-run memory-extraction call.
 * Identity signals in the request ("my name is…", "je m'appelle…") always
 * qualify — even when the answer is a short acknowledgement — because the
 * durable fact lives in the request itself. Everything else needs a
 * substantive answer; greetings never qualify.
 */
export function shouldExtractMemory(request: string, response: string): boolean {
  const req = (request || "").trim();
  const res = (response || "").trim();
  if (!req || !res || res.length > 12000) return false;
  const isGreeting =
    /^(hi|hello|hey|yo|good\s+(morning|afternoon|evening)|thanks|thank you|ok|okay|continue)\b/i.test(req) &&
    req.length < 30;
  const hasIdentitySignal =
    /\b(my name is|call me|i am a|i'm a|i work as|i study|i'm studying|my role is|i live in|i'm from|my preference is|i prefer|je m'appelle|mon nom est|je suis (?:un|une)|j'étudie|j'etudie|je travaille|je préfère|je prefere)\b/i.test(
      req
    );
  if (hasIdentitySignal) return res.length >= 10;
  if (isGreeting) return false;
  return res.length >= 100;
}

/**
 * Evaluates whether a Home run was substantive enough to warrant logging in Recent Deliverables.
 * Filters out trivial chit-chat, greetings, identity questions, and bare affirmations.
 */
export function isSubstantiveHomeTask(
  request: string,
  response: string,
  hasFileModifications: boolean
): boolean {
  // If the agent created, downloaded, or edited files, it's always substantive
  if (hasFileModifications) return true;

  const req = request.trim().toLowerCase();

  // Filter out greetings and chit-chat
  if (/^(hi|hello|hey|yo|greetings|good\s+(morning|afternoon|evening))\b/i.test(req) && req.length < 30) {
    return false;
  }

  // Filter out identity / capability questions
  if (/^(who are you|what can you do|help|what are your capabilities)\b/i.test(req)) {
    return false;
  }

  // Filter out affirmations / continue commands
  if (/^(continue|proceed|go on|next|yes|ok|okay|sure|thanks|thank you)\b/i.test(req) && req.length < 30) {
    return false;
  }

  // Filter out trivial math or definitions without tool usage
  if (/^(what is|calculate|solve)?\s*[\d\s+\-*/^()=.]+\??$/i.test(req) && response.length < 100) {
    return false;
  }

  // Substantive responses (explanations, outlines, research summaries)
  return response.trim().length >= 100;
}

/**
 * Creates the `manage_memory` tool for Home Mode, allowing the agent to
 * explicitly save or delete enduring user profile details, preferences, and project context.
 * Name and description are overridable so Code mode can mount the same
 * machinery as a project-scoped `project_memory` tool.
 */
export function createHomeMemoryTool(options: {
  onRemember: (category: SemanticCategory, fact: string) => Promise<void> | void;
  /** Returns how many entries were removed, so "forget" can't claim success for a no-op. */
  onForget: (query: string) => Promise<number | void> | number | void;
  /** Optional live memory reader enabling active `search` and `list` recall. */
  onRead?: () => Promise<string> | string;
  name?: string;
  description?: string;
}) {
  return tool(
    async ({ action, category, fact }: { action: "remember" | "forget" | "search" | "list"; category?: SemanticCategory; fact?: string }) => {
      try {
        const text = String(fact || "").trim();
        if (action === "list" || action === "search") {
          const raw = options.onRead ? await options.onRead() : "";
          return searchMemoryFacts(raw, action === "search" ? text : undefined);
        }
        if (action === "remember") {
          if (!text) return "A non-empty fact is required when action='remember'.";
          const cat = category || "preference";
          await options.onRemember(cat, text);
          return `Successfully saved to long-term memory under [${cat}]: "${text}".`;
        }
        if (!text) return "The exact wording of the fact is required when action='forget'.";
        const removed = await options.onForget(text);
        if (typeof removed === "number" && removed > 0) {
          return `Removed ${removed} item(s) from long-term memory.`;
        }
        return `No exact match found in memory for "${text}" — nothing was removed. Retry with the exact wording shown in the Memory tab.`;
      } catch (err) {
        return `Failed to update memory: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
    {
      name: options.name || "manage_memory",
      description:
        options.description ||
        "Manage long-term memory shared across all Home chats. Call this tool to remember enduring user details, preferences, or reusable self-improvement lessons, search or list past memory, or forget outdated items. Do NOT call this tool for temporary conversational details. For action='forget', pass the item's EXACT current wording — paraphrases do not match (use action='search' or 'list' first to find exact wording).",
      schema: z.object({
        action: z.enum(["remember", "forget", "search", "list"]).describe("Whether to remember a new fact/lesson, forget an existing one, search memory by keyword, or list all stored memory."),
        category: z.enum(["profile", "preference", "fact", "context", "lesson"]).optional().describe("Category: 'profile' (role, background, identity), 'preference' (output formats, style, language), 'fact' (durable personal facts), 'lesson' (reusable workflow/self-improvement lessons and pitfalls), or 'context' (ongoing project goals). Defaults to 'preference'."),
        fact: z.string().optional().default("").describe("The concise fact, preference, lesson, or search/forget query (optional for action='list')."),
      }),
    }
  );
}
