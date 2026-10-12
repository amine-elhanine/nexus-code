# MCP & plugins (read this before conflating them)

Nexus has an existing MCP client (`electron/mcp-service.ts`,
`MultiServerMCPClient` pooling, per-server isolation on failure). This
release keeps it and clarifies boundaries:

- **Nexus plugin**: runs inside the approved extension environment
  (declarative data, or sandboxed `entry` via this SDK).
- **MCP client**: connects to an EXTERNAL server (local stdio process or
  remote HTTP). Configured in Settings → MCP; validated on save/test.
- **MCP server exposed by Nexus**: only explicitly authorized capabilities;
  not implemented in this increment (see limitations).
- **Adapter**: a skill (`SKILL.md`) + optional tool wrapper that packages a
  capability for either interface. `REQUIRED_MCP_SKILLS` /
  `filterSkillsByMcp` already gate skill recommendations on configured
  servers — plugins reuse this instead of duplicating it.

## External server safety

- `stdio.command/args/env` and remote `url/headers` come from user-saved
  config: saving such config IS the trust decision (same as installing a
  plugin). `mcp:test` spawns without persisting — still arbitrary exec, so
  it requires the same trust.
- Argument/result validation, per-call timeouts, disconnect/reconnect, and
  cancellation follow the existing client; MCP tools never bypass the
  permission model (a plugin still needs `mcp.connect` to reach them, and
  tool args still pass the execution boundary).
- Credentials (`env`, headers) stay in main-process memory, masked in the UI
  (`********` round-trip), never logged to plugins.
- Do NOT claim MCP tools are safe because the protocol is standard: a
  malicious server is arbitrary code execution + exfiltration. Review
  server sources like plugin sources.
