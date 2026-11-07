// One-shot invocation helper — the replacement for the old ChatModel.invoke()
// call sites that just need a text answer back (summaries, routers,
// extractors). Streaming is unnecessary for these; complete() runs the same
// adapter path without the event forwarding.
import type { ChatClient } from "./types.js";
import { userMsg, type ChatMessage } from "../messages.js";

export async function invokeChatText(
  client: ChatClient,
  input: string | ChatMessage[],
  options?: { signal?: AbortSignal; temperature?: number }
): Promise<string> {
  const messages: ChatMessage[] = typeof input === "string" ? [userMsg(input)] : input;
  const result = await client.complete({ messages, signal: options?.signal, temperature: options?.temperature });
  return result.text;
}
