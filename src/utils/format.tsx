import React from "react";
import { FileJson, FileCode2, File } from "lucide-react";
import type { AgentUsage, SessionRecord, ChatItem } from "../types.js";

export function nowIso(): string {
  return new Date().toISOString();
}

export function timeLabel(value: string): string {
  return value === "now" ? "now" : new Date(value).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

export function fileIcon(file: string) {
  return file.endsWith(".json") ? (
    <FileJson size={14} />
  ) : file.endsWith(".ts") || file.endsWith(".tsx") ? (
    <FileCode2 size={14} />
  ) : (
    <File size={14} />
  );
}

export function pushLiveEvent(events: ChatItem[], item: ChatItem): ChatItem[] {
  return [...events, item];
}

export function getSessionUsage(session?: SessionRecord | null): AgentUsage | undefined {
  if (!session) return undefined;
  let inputTokens = session.usage?.inputTokens || 0;
  let outputTokens = session.usage?.outputTokens || 0;
  let totalTokens = session.usage?.totalTokens || 0;
  let estimatedCost = session.usage?.estimatedCost || 0;

  // Aggregate all messages that contain usage info
  let msgInput = 0;
  let msgOutput = 0;
  let msgTotal = 0;
  let msgCost = 0;
  for (const message of session.messages || []) {
    if (message.usage) {
      msgInput += message.usage.inputTokens || 0;
      msgOutput += message.usage.outputTokens || 0;
      msgTotal += message.usage.totalTokens || 0;
      msgCost += message.usage.estimatedCost || 0;
    }
  }

  // If message sum is larger or session.usage was missing/underreported, use the full message aggregate
  if (msgTotal > totalTokens) {
    inputTokens = msgInput;
    outputTokens = msgOutput;
    totalTokens = msgTotal;
    estimatedCost = Number(msgCost.toFixed(4));
  }

  if (totalTokens > 0) {
    return {
      inputTokens,
      outputTokens,
      totalTokens,
      estimatedCost: Number(estimatedCost.toFixed(4)),
    };
  }
  return session.usage;
}
