// Message/text helpers shared by the agent run pipeline.
// Extracted verbatim from agent-service.ts; no behavior change.

import { ToolMessage } from "@langchain/core/messages";

// Verify/repair output cap: diagnostic feedback injected back into the model
// conversation is truncated to this many characters.
export const VERIFY_OUTPUT_CAP = 4000;
// History message char cap (per-message transcript excerpt bound).
export const HISTORY_CHAR_CAP = 4000;

// Tool results with structured (array) content — e.g. embedded image parts —
// permanently poison OpenAI-compatible providers that only accept string tool
// content ("Failed to deserialize … ChatCompletionRequestToolMessageContent").
// The failure is payload-SHAPED, not transient: every retry, recovery pass and
// "continue" re-sends the same tool message and 400s forever, burning the
// whole step budget. Flattening to plain text at the stream boundary makes the
// transcript provider-safe; images are referenced instead of inlined (the
// model can re-read them from disk by path when a vision path exists).
export function flattenToolMessageContent(messages: any[]): { messages: any[]; flattened: number; omittedImages: number } {
  let flattened = 0;
  let omittedImages = 0;
  const out = messages.map((message) => {
    const content = message?.content;
    if (message?._getType?.() !== "tool" || !Array.isArray(content)) return message;
    const textParts: string[] = [];
    for (const part of content) {
      if (typeof part === "string") textParts.push(part);
      else if (part?.type === "text" && typeof part.text === "string") textParts.push(part.text);
      else if (part?.type === "image_url" || part?.type === "image" || part?.type === "input_image") omittedImages++;
    }
    flattened++;
    let text = textParts.join("\n").trim();
    if (omittedImages && text) text += `\n[${omittedImages} image part(s) removed from this tool result — if the image matters, reference it by its file path instead.]`;
    else if (omittedImages && !text) text = `[${omittedImages} image part(s) removed from this tool result — reference the image by its file path instead.]`;
    const next = new ToolMessage({
      content: text || "(empty tool result)",
      tool_call_id: message.tool_call_id,
      ...(message.name ? { name: message.name } : {}),
    });
    // Preserve any additional fields the original message carried (status,
    // artifact markers) so downstream consumers see the same shape.
    for (const [key, value] of Object.entries(message)) {
      if (!(key in next) && key !== "content" && value !== undefined) {
        try { (next as any)[key] = value; } catch { /* read-only field */ }
      }
    }
    return next;
  });
  return { messages: out, flattened, omittedImages };
}

export function extractDiagnosticFeedback(rawOutput: string, cap = VERIFY_OUTPUT_CAP): string {
  if (!rawOutput) return "";
  const cleaned = rawOutput.trim();
  if (cleaned.length <= cap) return cleaned;

  const lines = cleaned.split(/\r?\n/);
  const isDiagnostic = (line: string) =>
    /(?:error\s+[A-Z0-9]+:|error:|failed:|failure:|exception:|syntaxerror|typeerror|referenceerror|assertionerror|errno\s+\d+|undefined reference|cannot find module|\bFAILED\b)/i.test(line);

  const keyLines: string[] = [];
  for (let i = 0; i < lines.length && keyLines.length < 30; i++) {
    if (isDiagnostic(lines[i])) {
      keyLines.push(lines[i]);
      if (i + 1 < lines.length && lines[i + 1].trim() && !isDiagnostic(lines[i + 1])) {
        keyLines.push(`    ${lines[i + 1].trim()}`);
      }
    }
  }

  const budgetPerSection = Math.floor((cap - 200) / 3);
  const head = cleaned.slice(0, budgetPerSection);
  const tailPart = cleaned.slice(-budgetPerSection);

  if (keyLines.length > 0) {
    const diagnosticSummary = `=== Extracted Diagnostics ===\n${keyLines.slice(0, 20).join("\n")}`.slice(0, budgetPerSection);
    return `${head}\n\n${diagnosticSummary}\n\n…[truncated ${Math.max(0, cleaned.length - budgetPerSection * 2)} chars]…\n\n${tailPart}`;
  }

  const half = Math.floor((cap - 100) / 2);
  return `${cleaned.slice(0, half)}\n\n…[truncated ${Math.max(0, cleaned.length - half * 2)} chars]…\n\n${cleaned.slice(-half)}`;
}

export function textFromMessage(message: any) {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) return message.content.map((part: any) => (typeof part === "string" ? part : part?.text ?? "")).join("");
  return message.text ?? "";
}

export function chunkText(chunk: any) {
  const content = chunk?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part: any) => (typeof part === "string" ? part : part?.text ?? "")).join("");
  return "";
}

export function tail(value: string | undefined, cap: number) {
  if (!value) return "";
  return value.length > cap ? `…${value.slice(-cap)}` : value;
}

// Memory entries are summaries, NOT transcripts: the full answer already
// lives in chat history. Storing verbatim tails of long responses (e.g. a
// 15-row table cut to its last 4 rows) misleads future runs into thinking
// the fragment is the complete fact. These helpers collapse large tables
// and truncate on line boundaries with an explicit marker.
export function compactTablesForMemory(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const isTableRow = /^\s*\|.*\|\s*$/.test(line);
    if (isTableRow) {
      let j = i;
      while (j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j])) j++;
      const blockSize = j - i;
      // Keep small tables verbatim; collapse large ones to a row-count note.
      if (blockSize > 6) {
        const header = lines[i].trim();
        out.push(header);
        out.push(`| …[table with ${blockSize - 2} more rows — see chat transcript for full data]… |`);
        const last = lines[j - 1].trim();
        if (last !== header) out.push(last);
      } else {
        for (let k = i; k < j; k++) out.push(lines[k]);
      }
      i = j;
    } else {
      out.push(line);
      i++;
    }
  }
  return out.join("\n");
}

export function truncateOnLines(value: string, cap: number): string {
  const compacted = compactTablesForMemory(value.trim());
  if (compacted.length <= cap) return compacted;
  const marker = "\n…[summary truncated — see chat transcript for full details]…\n";
  const budget = cap - marker.length;
  const headBudget = Math.floor(budget * 0.6);
  const tailBudget = budget - headBudget;
  let head = compacted.slice(0, headBudget);
  const headBreak = head.lastIndexOf("\n");
  if (headBreak > headBudget * 0.5) head = head.slice(0, headBreak);
  let tailPart = compacted.slice(-tailBudget);
  const tailBreak = tailPart.indexOf("\n");
  if (tailBreak >= 0 && tailBreak < tailBudget * 0.5) tailPart = tailPart.slice(tailBreak + 1);
  return `${head}${marker}${tailPart}`;
}

export function firstMeaningfulLine(value: string, cap: number): string {
  const compacted = compactTablesForMemory(value.trim());
  const line = compacted.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !/^\|?\s*:?-+:?/.test(l) && l !== "…") || "";
  const flat = line.replace(/\s+/g, " ");
  return flat.length > cap ? `${flat.slice(0, cap)}…` : flat;
}
