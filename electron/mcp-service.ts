// MCP tool integration now lives in agentcore/mcp.ts (raw
// @modelcontextprotocol/sdk instead of langchain-mcp-adapters). This module
// keeps the established import surface for the rest of the app.
export { getMcpTools, testMcpServer, hasEnabledMcpServers, type McpTestResult } from "./agentcore/mcp.js";
