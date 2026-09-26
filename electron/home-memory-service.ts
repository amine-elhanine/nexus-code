import { tool } from "@langchain/core/tools";
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

export type SemanticCategory = "profile" | "preference" | "context" | "fact";

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
    context: [],
    recentDeliverables: [],
    customNotes: "",
  };

  if (!raw || !raw.trim()) return result;

  const lines = raw.split("\n");
  type Section = "profile" | "preferences" | "facts" | "context" | "deliverables" | "custom" | "unknown";
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
  } else {
    if (!existsIn(struct.context)) struct.context.push(cleaned);
  }

  return formatHomeMemory(struct);
}

/**
 * Removes a fact matching a query substring from memory.
 */
export function removeMemoryFact(raw: string, query: string): string {
  const struct = parseHomeMemory(raw);
  const target = query.toLowerCase().trim();
  if (!target) return raw;

  struct.profile = struct.profile.filter((p) => !p.toLowerCase().includes(target));
  struct.preferences = struct.preferences.filter((p) => !p.toLowerCase().includes(target));
  struct.facts = struct.facts.filter((f) => !f.toLowerCase().includes(target));
  struct.context = struct.context.filter((c) => !c.toLowerCase().includes(target));
  struct.recentDeliverables = struct.recentDeliverables.filter((d) => !d.summary.toLowerCase().includes(target));

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
  push("## Remembered Facts", [...topFacts, ...fallbackFacts].slice(0, 10));

  const rankedDeliverables = struct.recentDeliverables
    .map((d) => ({ d, score: score(d.summary) }))
    .sort((a, b) => b.score - a.score);
  const topDeliverables = rankedDeliverables
    .filter((r) => r.score > 0)
    .slice(0, 3)
    .map((r) => `- [${r.d.date}] ${r.d.summary}`);
  push("## Recent Deliverables", topDeliverables);

  const totalFacts = struct.facts.length + struct.context.length;
  const shownFacts = (sections.join("\n").match(/^- /gm) || []).length;
  const hidden = Math.max(0, totalFacts + struct.recentDeliverables.length - shownFacts);
  const out = sections.join("\n\n").trim();
  if (!out) return "";
  return hidden > 0 ? `${out}\n\n[+${hidden} more memorized item(s) not shown — ask to recall a specific topic]` : out;
}

/**
 * Parses LLM-produced memory candidates. Accepts raw JSON or fenced JSON of
 * the form { "candidates": [{ "category": "profile|preference|fact|context", "fact": "..." }] }.
 * Invalid entries are dropped; at most 3 candidates returned.
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
    const validCategories: SemanticCategory[] = ["profile", "preference", "fact", "context"];
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
      if (out.length >= 3) break;
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
    /\b(my name is|call me|i am a|i'm a|i work as|i study|i'm studying|my role is|i live in|i'm from|my preference is|i prefer|je m'appelle|mon nom est|je suis|j'étudie|j'etudie|je travaille|je préfère|je prefere)\b/i.test(
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
 */
export function createHomeMemoryTool(options: {
  onRemember: (category: SemanticCategory, fact: string) => Promise<void> | void;
  onForget: (query: string) => Promise<void> | void;
}) {
  return tool(
    async ({ action, category, fact }: { action: "remember" | "forget"; category?: SemanticCategory; fact: string }) => {
      try {
        if (action === "remember") {
          const cat = category || "preference";
          await options.onRemember(cat, fact);
          return `Successfully saved to long-term memory under [${cat}]: "${fact}".`;
        } else {
          await options.onForget(fact);
          return `Successfully removed matching item(s) from long-term memory for: "${fact}".`;
        }
      } catch (err) {
        return `Failed to update memory: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
    {
      name: "manage_memory",
      description:
        "Manage long-term memory shared across all Home chats. Call this tool when the user asks you to remember something, states an enduring personal preference (e.g. tone, language, tools, formatting), shares their background/role, or asks to forget a past preference. Do NOT call this tool for temporary conversational details.",
      schema: z.object({
        action: z.enum(["remember", "forget"]).describe("Whether to remember a new fact/preference or forget an existing one."),
        category: z.enum(["profile", "preference", "fact", "context"]).optional().describe("Category: 'profile' (role, background, identity), 'preference' (output formats, style, language), 'fact' (durable personal facts), or 'context' (ongoing project goals). Defaults to 'preference'."),
        fact: z.string().describe("The concise fact, preference, or query to remember or forget."),
      }),
    }
  );
}
