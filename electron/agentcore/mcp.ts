// MCP tool integration over the raw @modelcontextprotocol/sdk — replaces
// langchain-mcp-adapters. One warm Client per config fingerprint; when the
// aggregated load fails, fall back to per-server clients and keep only the
// healthy servers' tools (fault isolation). Tools become AgentTools whose
// inputSchema passes through unvalidated, matching the adapter's lenient
// behavior.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { asAgentTool, type AgentTool } from "./tools.js";
import type { McpServerConfig } from "../store.js";

type IsolatedServer = { name: string; client: Client; tools: AgentTool[] };
type McpCache = { fingerprint: string; clients: Client[]; tools: AgentTool[]; serverNames: string[] } | null;
let cache: McpCache = null;

async function closeCache() {
  if (!cache) return;
  for (const client of cache.clients) {
    try { await client.close(); } catch { /* already closed */ }
  }
  cache = null;
}

/** Close every cached MCP client (stdio transports spawn child processes —
 *  call at app shutdown so they don't outlive the app). */
export async function shutdownMcp(): Promise<void> {
  await closeCache();
}

export function onMcpConfigChanged(listener: () => void) { void listener; }

function fingerprint(servers: McpServerConfig[]) {
  return JSON.stringify(servers.map((server) => ({ id: server.id, enabled: server.enabled, transport: server.transport, command: server.command, args: server.args, env: server.env, url: server.url, headers: server.headers })));
}

function transportFor(server: McpServerConfig) {
  if (server.transport === "stdio") {
    if (!server.command) return null;
    return new StdioClientTransport({
      command: server.command,
      args: server.args ?? [],
      ...(server.env ? { env: { ...server.env } as Record<string, string> } : {}),
    });
  }
  if (!server.url) return null;
  const headers = (server.headers ?? {}) as Record<string, string>;
  if (server.transport === "sse") {
    return new SSEClientTransport(new URL(server.url), { ...(Object.keys(headers).length ? { requestInit: { headers } } : {}) });
  }
  return new StreamableHTTPClientTransport(new URL(server.url), { ...(Object.keys(headers).length ? { requestInit: { headers } } : {}) });
}

async function connectClient(server: McpServerConfig): Promise<Client | null> {
  const transport = transportFor(server);
  if (!transport) return null;
  const client = new Client({ name: "nexus", version: "0.5.0" });
  const timeoutMs = 20_000;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.connect(transport),
      new Promise<never>((_, reject) => {
        timeoutTimer = setTimeout(() => reject(new Error(`${server.name || server.id} connection timed out after ${timeoutMs / 1000}s`)), timeoutMs);
      }),
    ]);
  } catch (error) {
    // The losing side of the race must not leak: on timeout the connect
    // attempt keeps running with its spawned transport (stdio servers are
    // child processes) unless the client is closed. Without this, every
    // timed-out stdio server left one orphan process behind.
    try { await client.close(); } catch { /* never connected or already closed */ }
    if (timeoutTimer) clearTimeout(timeoutTimer);
    throw error;
  }
  if (timeoutTimer) clearTimeout(timeoutTimer);
  return client;
}

async function toolsForClient(client: Client): Promise<AgentTool[]> {
  const listing = await client.listTools();
  return (listing.tools ?? []).map((tool) => asAgentTool({
    name: String(tool.name),
    description: String(tool.description ?? ""),
    parameters: (tool.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
    execute: async (args: unknown) => {
      const result = await client.callTool({ name: tool.name, arguments: (args ?? {}) as Record<string, unknown> });
      return stringifyMcpResult(result);
    },
  }));
}

function stringifyMcpResult(result: unknown): string {
  const content = (result as any)?.content;
  if (typeof (result as any)?.content === "string") return (result as any).content;
  if (Array.isArray(content)) {
    return content.map((block: any) => {
      if (typeof block === "string") return block;
      if (block?.type === "text") return String(block.text ?? "");
      try { return JSON.stringify(block).slice(0, 2000); } catch { return ""; }
    }).filter(Boolean).join("\n");
  }
  if ((result as any)?.isError) {
    const text = typeof content === "string" ? content : stringifyMcpResult(content);
    return `[Tool error] ${text}`;
  }
  try { return JSON.stringify(result ?? "") ?? ""; } catch { return ""; }
}

export async function getMcpTools(): Promise<{ tools: AgentTool[]; serverNames: string[]; warnings?: string[] }> {
  const { listMcpServers } = await import("../store.js");
  const servers = (await listMcpServers()).filter((server) => server.enabled);
  const mark = fingerprint(servers);
  if (cache && cache.fingerprint === mark) {
    return { tools: cache.tools, serverNames: cache.serverNames };
  }
  await closeCache();
  if (!servers.length) return { tools: [], serverNames: [] };

  // Connect each server independently: one dead server must not cost the run
  // every MCP tool.
  const clients: Client[] = [];
  const tools: AgentTool[] = [];
  const healthy: string[] = [];
  const warnings: string[] = [];
  for (const server of servers) {
    try {
      const client = await connectClient(server);
      if (!client) continue;
      const serverTools = await toolsForClient(client);
      clients.push(client);
      tools.push(...serverTools);
      healthy.push(server.name || server.id);
    } catch (error) {
      warnings.push(`${server.name || server.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (clients.length) cache = { fingerprint: mark, clients, tools, serverNames: healthy };
  return { tools, serverNames: healthy, warnings: warnings.length ? warnings : undefined };
}

export type McpTestResult = { ok: boolean; tools: string[]; error?: string };

export async function testMcpServer(server: Omit<McpServerConfig, "id" | "enabled">): Promise<McpTestResult> {
  try {
    const client = await connectClient({ ...server, id: "test", enabled: true, name: server.name || "test" } as McpServerConfig);
    if (!client) return { ok: false, tools: [], error: "Nothing to connect to — fill in the connection fields first." };
    try {
      const listing = await client.listTools();
      return { ok: true, tools: (listing.tools ?? []).map((tool) => String(tool.name)) };
    } finally {
      await client.close().catch(() => {});
    }
  } catch (error) {
    return { ok: false, tools: [], error: error instanceof Error ? error.message : String(error) };
  }
}

export async function hasEnabledMcpServers() {
  const { listMcpServers } = await import("../store.js");
  return (await listMcpServers()).some((server) => server.enabled);
}
