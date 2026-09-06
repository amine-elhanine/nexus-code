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

export function pushLiveEvent(buckets: Record<string, ChatItem[]>, sessionId: string, item: ChatItem): Record<string, ChatItem[]> {
  return { ...buckets, [sessionId]: [...(buckets[sessionId] || []), item] };
}

export function getSessionUsage(session?: SessionRecord | null): AgentUsage | undefined {
  if (!session) return undefined;
  let inputTokens = session.usage?.inputTokens || 0;
  let outputTokens = session.usage?.outputTokens || 0;
  let totalTokens = session.usage?.totalTokens || 0;
  let costKnown = session.usage?.estimatedCost != null;

  // Aggregate all messages that contain usage info
  let msgInput = 0;
  let msgOutput = 0;
  let msgTotal = 0;
  let msgCost = 0;
  let msgCostKnown = true;
  for (const message of session.messages || []) {
    if (message.usage && message.role === "assistant") {
      msgInput += message.usage.inputTokens || 0;
      msgOutput += message.usage.outputTokens || 0;
      msgTotal += message.usage.totalTokens || 0;
      if (message.usage.estimatedCost == null) msgCostKnown = false;
      else msgCost += message.usage.estimatedCost;
    }
  }

  // If message sum is larger or session.usage was missing/underreported, use the full message aggregate
  if (msgTotal > totalTokens) {
    inputTokens = msgInput;
    outputTokens = msgOutput;
    totalTokens = msgTotal;
    costKnown = msgCostKnown;
    return {
      inputTokens,
      outputTokens,
      totalTokens,
      estimatedCost: costKnown ? Number(msgCost.toFixed(4)) : null,
    };
  }

  if (totalTokens > 0) {
    return {
      inputTokens,
      outputTokens,
      totalTokens,
      estimatedCost: costKnown ? Number((session.usage?.estimatedCost || 0).toFixed(4)) : null,
    };
  }
  return session.usage;
}
