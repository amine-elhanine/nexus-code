import React, { useState, useEffect } from "react";
import { Server, Settings2, Trash2, Plus, RefreshCw, Loader2, Check } from "lucide-react";
import { ConfirmModal } from "../../modals/ConfirmModal.js";
import { Toggle } from "../common/Toggle.js";
import type { McpServerConfig, McpTransport, McpTestResult } from "../../types.js";

type McpFormState = {
  id?: string;
  name: string;
  transport: McpTransport;
  command: string;
  argsText: string;
  envText: string;
  url: string;
  headersText: string;
  enabled: boolean;
};

const EMPTY_MCP_FORM: McpFormState = {
  name: "",
  transport: "stdio",
  command: "",
  argsText: "",
  envText: "",
  url: "",
  headersText: "",
  enabled: true,
};

function parseNamedLines(text: string, separator: string) {
  return Object.fromEntries(
    text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const index = line.indexOf(separator);
        return index === -1 ? [line, ""] : [line.slice(0, index).trim(), line.slice(index + separator.length).trim()];
      })
  );
}

function formatNamedEntries(record: Record<string, string> | undefined, separator: string) {
  return Object.entries(record ?? {})
    .map(([key, value]) => `${key}${separator}${value}`)
    .join("\n");
}

function buildMcpPayload(form: McpFormState) {
  return {
    id: form.id,
    name: form.name,
    transport: form.transport,
    enabled: form.enabled,
    command: form.transport === "stdio" ? form.command : undefined,
    args: form.transport === "stdio" ? form.argsText.split("\n").map((line) => line.trim()).filter(Boolean) : undefined,
    env: form.transport === "stdio" ? parseNamedLines(form.envText, "=") : undefined,
    url: form.transport !== "stdio" ? form.url : undefined,
    headers: form.transport !== "stdio" ? parseNamedLines(form.headersText, ": ") : undefined,
  };
}

function formFromServer(server: McpServerConfig): McpFormState {
  return {
    id: server.id,
    name: server.name,
    transport: server.transport,
    enabled: server.enabled,
    command: server.command || "",
    argsText: (server.args || []).join("\n"),
    envText: formatNamedEntries(server.env, "="),
    url: server.url || "",
    headersText: formatNamedEntries(server.headers, ": "),
  };
}

export function McpManager() {
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [form, setForm] = useState<McpFormState | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<McpTestResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [deleteServer, setDeleteServer] = useState<McpServerConfig | null>(null);

  const api = window.nexus || window.forgepilot;

  useEffect(() => {
    void api.listMcpServers().then(setServers).finally(() => setLoading(false));
  }, []);

  function refreshForm(next: McpFormState) {
    setForm(next);
    setNote("");
    setError("");
    setTestResult(null);
  }

  async function save() {
    if (!form) return;
    setNote("");
    setError("");
    try {
      setServers(await api.saveMcpServer(buildMcpPayload(form)));
      setNote("Server saved. New tools are picked up on the next agent run.");
      setForm(null);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to save this MCP server.");
    }
  }

  async function remove(server: McpServerConfig) {
    try {
      setServers(await api.removeMcpServer(server.id));
      if (form?.id === server.id) setForm(null);
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : "Unable to remove this server.");
    }
  }

  async function toggleEnabled(server: McpServerConfig) {
    try {
      setServers(await api.saveMcpServer({ ...server, enabled: !server.enabled }));
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : "Unable to update this server.");
    }
  }

  async function test() {
    if (!form) return;
    setTesting(true);
    setTestResult(null);
    setError("");
    try {
      setTestResult(await api.testMcpServer(buildMcpPayload(form)));
    } finally {
      setTesting(false);
    }
  }

  const isStdio = form?.transport === "stdio";

  return (
    <>
      <div className="provider-layout">
        <div className="provider-list">
          {servers.map((server) => (
            <div className={`mcp-card${server.enabled ? " enabled" : " disabled"}`} key={server.id}>
              <div className="mcp-card-main">
                <span className={`mcp-card-icon${server.enabled ? " enabled" : ""}`}>
                  <Server size={14} />
                </span>
                <div className="mcp-card-info">
                  <div className="mcp-card-head-row">
                    <strong className="mcp-card-name">{server.name}</strong>
                    <span className={`mcp-status-badge ${server.enabled ? "enabled" : "disabled"}`}>
                      {server.enabled ? "ACTIVE" : "OFF"}
                    </span>
                  </div>
                  <div className="mcp-card-detail">
                    <span className="mcp-transport-chip">{server.transport}</span>
                    <span className="mcp-command-line" title={server.transport === "stdio" ? `${server.command} ${(server.args || []).join(" ")}` : server.url}>
                      {server.transport === "stdio" ? server.command : server.url}
                    </span>
                  </div>
                </div>
              </div>
              <div className="mcp-card-actions">
                <div className="mcp-toggle-wrap" title={server.enabled ? "Disable this server" : "Enable this server"}>
                  <Toggle
                    checked={server.enabled}
                    onChange={() => void toggleEnabled(server)}
                  />
                </div>
                <button className="mcp-icon-btn" onClick={() => refreshForm(formFromServer(server))} title="Edit server settings">
                  <Settings2 size={13} />
                </button>
                <button className="mcp-icon-btn danger" onClick={() => setDeleteServer(server)} title="Remove server">
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}
          {!servers.length && !loading && (
            <div className="empty-provider">
              <Server size={22} />
              <p>No MCP servers configured yet.</p>
              <small style={{ color: "var(--muted)", fontSize: "10px" }}>Click "Add a server" to connect GitHub, filesystem, database, or API tools.</small>
            </div>
          )}
        </div>
        <div className="provider-form">
          <div className="form-title">
            <span>{form?.id ? "Edit MCP server" : "Add MCP server"}</span>
            <small>langchain-mcp-adapters</small>
          </div>
          {!form && (
            <button className="secondary full" onClick={() => refreshForm(EMPTY_MCP_FORM)}>
              <Plus size={13} /> Add a server
            </button>
          )}
          {form && (
            <>
              <label>
                Display name
                <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="filesystem" />
              </label>
              <label>
                Transport
                <select value={form.transport} onChange={(event) => refreshForm({ ...form, transport: event.target.value as McpTransport })}>
                  <option value="stdio">stdio — launch a local command</option>
                  <option value="http">HTTP — Streamable HTTP endpoint</option>
                  <option value="sse">SSE — Server-Sent Events endpoint</option>
                </select>
              </label>
              {isStdio && (
                <>
                  <label>
                    Command
                    <input value={form.command} onChange={(event) => setForm({ ...form, command: event.target.value })} placeholder="npx" />
                  </label>
                  <label>
                    Arguments <small>one per line</small>
                    <textarea value={form.argsText} onChange={(event) => setForm({ ...form, argsText: event.target.value })} rows={3} placeholder={"-y\n@modelcontextprotocol/server-filesystem\nC:\\projects"} />
                  </label>
                  <label>
                    Environment <small>KEY=VALUE per line</small>
                    <textarea value={form.envText} onChange={(event) => setForm({ ...form, envText: event.target.value })} rows={2} placeholder={"API_KEY=abc123"} />
                  </label>
                </>
              )}
              {!isStdio && (
                <>
                  <label>
                    URL
                    <input value={form.url} onChange={(event) => setForm({ ...form, url: event.target.value })} placeholder="https://mcp.example.com/mcp" />
                  </label>
                  <label>
                    Headers <small>Key: Value per line</small>
                    <textarea value={form.headersText} onChange={(event) => setForm({ ...form, headersText: event.target.value })} rows={2} placeholder={"Authorization: Bearer abc123"} />
                  </label>
                </>
              )}
              <div className="provider-fetch">
                <button className="secondary" disabled={testing || (isStdio ? !form.command.trim() : !form.url.trim())} onClick={() => void test()}>
                  {testing ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />} Test connection
                </button>
                {testResult?.ok && (
                  <small className="fetch-ok">Connected · {testResult.tools.length} tool{testResult.tools.length === 1 ? "" : "s"}: {testResult.tools.join(", ") || "(none)"}</small>
                )}
                {testResult && !testResult.ok && <small className="fetch-error">{testResult.error}</small>}
              </div>
              <div className="mcp-form-toggle-row">
                <Toggle
                  checked={form.enabled}
                  onChange={(next) => setForm({ ...form, enabled: next })}
                  title={form.enabled ? "Disable this server" : "Enable this server"}
                />
                <div className="mcp-form-toggle-text">
                  <strong>Enabled for agent runs</strong>
                  <small>When enabled, all tools from this MCP server are automatically available in chat sessions.</small>
                </div>
              </div>
              <div className="modal-actions">
                <button className="secondary" onClick={() => { setForm(null); setError(""); setNote(""); }}>Cancel</button>
                <button className="primary" disabled={!form.name.trim()} onClick={() => void save()}><Check size={14} /> Save server</button>
              </div>
            </>
          )}
          {note && <small className="fetch-ok">{note}</small>}
          {error && <small className="fetch-error">{error}</small>}
        </div>
      </div>
      {deleteServer && (
        <ConfirmModal
          title={`Remove "${deleteServer.name}"?`}
          message="This will remove the MCP server configuration and disconnect its tools."
          confirmLabel="Remove server"
          danger
          onConfirm={() => {
            const s = deleteServer;
            setDeleteServer(null);
            void remove(s);
          }}
          onCancel={() => setDeleteServer(null)}
        />
      )}
    </>
  );
}
