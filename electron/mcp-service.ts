import { MultiServerMCPClient } from "langchain-mcp-adapters";
import { listMcpServers, onMcpConfigChanged, type McpServerConfig } from "./store.js";

// One MCP client is kept warm per config fingerprint so agent runs reuse live
// connections; any config change (or disable) drops the cache and the next run
// reconnects from scratch.
type McpCache = { fingerprint: string; client: MultiServerMCPClient; toolCount: number } | null;
let cache: McpCache = null;
onMcpConfigChanged(() => { void cache?.client.close().catch(() => {}); cache = null; });

function connectionFor(server: McpServerConfig): Record<string, unknown> | null {
  if (server.transport === "stdio") {
    if (!server.command) return null;
    return { transport: "stdio", command: server.command, args: server.args ?? [], env: server.env ?? undefined };
  }
  if (!server.url) return null;
  return { transport: server.transport, url: server.url, headers: server.headers ?? undefined };
}

function fingerprint(servers: McpServerConfig[]) { return JSON.stringify(servers.map((server) => ({ id: server.id, enabled: server.enabled, transport: server.transport, command: server.command, args: server.args, env: server.env, url: server.url, headers: server.headers }))); }

function clientConfigFor(servers: McpServerConfig[]) {
  const config: Record<string, unknown> = {};
  for (const server of servers) {
    if (!server.enabled) continue;
    const connection = connectionFor(server);
    if (connection) config[server.name || server.id] = connection;
  }
  return config;
}

export async function getMcpTools(): Promise<{ tools: any[]; serverNames: string[] }> {
  const servers = (await listMcpServers()).filter((server) => server.enabled);
  const mark = fingerprint(servers);
  if (cache && cache.fingerprint === mark) return { tools: await cache.client.getTools(), serverNames: servers.map((server) => server.name) };
  if (cache) await cache.client.close().catch(() => {});
  cache = null;
  const config = clientConfigFor(servers);
  if (!Object.keys(config).length) return { tools: [], serverNames: [] };
  const client = new MultiServerMCPClient(config as never);
  const tools = await client.getTools();
  cache = { fingerprint: mark, client, toolCount: tools.length };
  return { tools, serverNames: servers.map((server) => server.name) };
}

export type McpTestResult = { ok: boolean; tools: string[]; error?: string };

export async function testMcpServer(server: Omit<McpServerConfig, "id" | "enabled">): Promise<McpTestResult> {
  const config = clientConfigFor([{ ...server, id: "test", enabled: true, name: server.name || "test" }]);
  if (!Object.keys(config).length) return { ok: false, tools: [], error: "Nothing to connect to — fill in the connection fields first." };
  const client = new MultiServerMCPClient(config as never);
  try {
    const tools = await client.getTools();
    return { ok: true, tools: tools.map((tool) => tool.name) };
  } catch (error) {
    return { ok: false, tools: [], error: error instanceof Error ? error.message : String(error) };
  } finally {
    await client.close().catch(() => {});
  }
}

export async function hasEnabledMcpServers() {
  return (await listMcpServers()).some((server) => server.enabled);
}
