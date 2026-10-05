import React, { useState } from "react";
import { Plus, Trash2, KeyRound, X, RefreshCw, Loader2, Check, Power, PowerOff } from "lucide-react";
import { ConfirmModal } from "../../modals/ConfirmModal.js";
import type { ChatEndpointKind, ProviderConfig, ProviderDefinition } from "../../types.js";

/**
 * Two-step provider management (the API key can no longer be lost by
 * editing): (1) create the connection alone — type, base URL, key entered
 * exactly once; (2) manage models individually through granular operations
 * that never carry the key. Editing a connection touches label/URL only;
 * replacing the key is an explicit separate action.
 */

/** Provider-level default path (mirrors the backend resolver). */
function defaultEndpointFor(providerId: string): ChatEndpointKind {
  return providerId === "anthropic" ? "messages" : "chat";
}

const ENDPOINT_LABELS: Record<ChatEndpointKind, string> = {
  chat: "/chat/completions",
  responses: "/responses",
  messages: "/messages",
};

type Pane =
  | { kind: "create" }
  | { kind: "detail"; providerId: string };

export function ProviderManager({
  providers,
  definitions,
  onProvidersChange,
}: {
  providers: ProviderConfig[];
  definitions: ProviderDefinition[];
  onProvidersChange: (providers: ProviderConfig[]) => void;
}) {
  const [pane, setPane] = useState<Pane>({ kind: "create" });
  const [fetching, setFetching] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<ProviderConfig | null>(null);

  // Create-form state
  const [newDefId, setNewDefId] = useState(definitions[0]?.id || "openai");
  const [newLabel, setNewLabel] = useState("");
  const [newBaseUrl, setNewBaseUrl] = useState(definitions[0]?.defaultBaseUrl || "");
  const [newApiKey, setNewApiKey] = useState("");

  // Detail (connection) draft state
  const [baseUrlDraft, setBaseUrlDraft] = useState("");
  const [labelDraft, setLabelDraft] = useState("");
  const [keyInput, setKeyInput] = useState("");

  // Model add bar
  const [modelInput, setModelInput] = useState("");

  const api = window.nexus || window.forgepilot;
  const selected = pane.kind === "detail" ? providers.find((p) => p.id === pane.providerId) : undefined;
  const createDef = definitions.find((d) => d.id === newDefId) || definitions[0];
  const isCustomCreate = newDefId === "custom";
  const isCustom = selected?.provider === "custom";
  const needsKey = (defId: string) => defId !== "ollama" && defId !== "custom";

  function applyProvider(updated: ProviderConfig) {
    onProvidersChange(providers.map((p) => (p.id === updated.id ? updated : p)));
  }

  function resetCreateForm(defId?: string) {
    const def = definitions.find((d) => d.id === defId) || definitions[0];
    setNewDefId(def?.id || "openai");
    setNewLabel("");
    setNewBaseUrl(def?.defaultBaseUrl || "");
    setNewApiKey("");
  }

  function openDetail(provider: ProviderConfig) {
    setPane({ kind: "detail", providerId: provider.id });
    setBaseUrlDraft(provider.baseUrl || "");
    setLabelDraft(provider.label);
    setKeyInput("");
    setModelInput("");
    setNote("");
    setError("");
  }

  function openCreate() {
    resetCreateForm();
    setPane({ kind: "create" });
    setNote("");
    setError("");
  }

  async function handleCreate() {
    if (!createDef) return;
    if (isCustomCreate && !newBaseUrl.trim()) return;
    if (needsKey(newDefId) && !newApiKey.trim()) return;
    try {
      const created = await api.createProvider({
        provider: newDefId,
        label: isCustomCreate ? newLabel.trim() || "Custom endpoint" : createDef.label,
        apiKey: newApiKey.trim(),
        baseUrl: newBaseUrl.trim() || undefined,
      });
      onProvidersChange([...providers, created]);
      openDetail(created);
      setNote(`Connection created. Now add the models you want to use.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create the connection.");
    }
  }

  async function saveConnection() {
    if (!selected) return;
    try {
      const updated = await api.updateProviderMeta(selected.id, {
        label: isCustom ? labelDraft : undefined,
        baseUrl: baseUrlDraft,
      });
      applyProvider(updated);
      setNote("Connection updated.");
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update the connection.");
    }
  }

  async function replaceKey() {
    if (!selected || !keyInput.trim()) return;
    try {
      const updated = await api.updateProviderKey(selected.id, keyInput.trim());
      applyProvider(updated);
      setKeyInput("");
      setNote("API key updated.");
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update the API key.");
    }
  }

  async function toggleEnabled(provider: ProviderConfig) {
    try {
      const updated = await api.setProviderEnabled(provider.id, provider.enabled === false);
      applyProvider(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to change the connection.");
    }
  }

  async function addModels() {
    if (!selected) return;
    const items = modelInput.split(/[,\n]+/).map((s) => s.trim()).filter(Boolean);
    if (!items.length) return;
    try {
      const updated = await api.addProviderModels(selected.id, items);
      applyProvider(updated);
      setModelInput("");
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to add the model.");
    }
  }

  async function renameModel(oldName: string, newNameRaw: string) {
    if (!selected) return;
    const newName = newNameRaw.trim();
    if (!newName || newName === oldName) return;
    try {
      const updated = await api.updateProviderModel(selected.id, oldName, { newName });
      applyProvider(updated);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to rename the model.");
      openDetail(selected); // reset the row to the stored name
    }
  }

  async function setModelEndpoint(model: string, endpoint: "" | ChatEndpointKind) {
    if (!selected) return;
    try {
      const updated = await api.updateProviderModel(selected.id, model, { endpoint });
      applyProvider(updated);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to set the model path.");
    }
  }

  async function removeModel(model: string) {
    if (!selected) return;
    try {
      const updated = await api.removeProviderModel(selected.id, model);
      applyProvider(updated);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to remove the model.");
    }
  }

  async function fetchModels() {
    if (!selected) return;
    setFetching(true);
    setNote("");
    setError("");
    try {
      // The renderer only holds a key mask — the server resolves the stored
      // key for this provider before calling the endpoint.
      const found = await api.fetchProviderModels({ providerId: selected.id, baseUrl: baseUrlDraft || selected.baseUrl || "" });
      const fresh = found.filter((m) => !(selected.models || []).includes(m));
      if (fresh.length) {
        const updated = await api.addProviderModels(selected.id, fresh);
        applyProvider(updated);
      }
      setNote(`Fetched ${found.length} model${found.length === 1 ? "" : "s"}${fresh.length ? `, ${fresh.length} new` : " — all already added"}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to fetch models.");
    } finally {
      setFetching(false);
    }
  }

  async function handleDelete(providerId: string) {
    try {
      const remaining = await api.removeProvider(providerId);
      onProvidersChange(remaining);
      openCreate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to remove provider.");
    }
  }

  const connectionDirty = selected && (baseUrlDraft !== (selected.baseUrl || "") || (isCustom && labelDraft !== selected.label));

  return (
    <>
      <div className="provider-layout">
        <div className="provider-list">
          <div className="pane-top" style={{ padding: "0 0 8px 0" }}>
            <span>CONFIGURED PROVIDERS</span>
            <button className="pane-action" onClick={openCreate} title="Add new provider"><Plus size={14} /></button>
          </div>
          {providers.map((provider) => {
            const enabled = provider.enabled !== false;
            return (
              <div className={`provider-card ${pane.kind === "detail" && pane.providerId === provider.id ? "active" : ""}`} key={provider.id}>
                <div className="provider-card-main" onClick={() => openDetail(provider)} style={{ cursor: "pointer", opacity: enabled ? undefined : 0.55 }}>
                  <span className="provider-logo">{provider.label.slice(0, 1)}</span>
                  <div>
                    <strong>{provider.label}</strong>
                    <small>
                      {(provider.models || []).length} models · {provider.apiKey ? "key configured" : provider.keyNeedsReentry ? "key needs re-entry (could not be decrypted)" : provider.provider === "ollama" ? "local" : "no API key"}
                      {!enabled ? " · disabled" : ""}
                    </small>
                  </div>
                </div>
                <div className="provider-card-actions">
                  <button onClick={(event) => { event.stopPropagation(); void toggleEnabled(provider); }} title={enabled ? "Disable — hides its models from the pickers" : "Enable"}>
                    {enabled ? <Power size={13} /> : <PowerOff size={13} style={{ color: "var(--orange)" }} />}
                  </button>
                  <button className="danger" onClick={(event) => { event.stopPropagation(); setDeleteTarget(provider); }} title="Delete provider"><Trash2 size={13} /></button>
                </div>
              </div>
            );
          })}
          {!providers.length && (
            <div className="empty-provider">
              <KeyRound size={18} />
              <p>No providers configured.</p>
            </div>
          )}
        </div>

        {pane.kind === "create" ? (
          <div className="provider-form">
            <div className="form-title">
              <span>Add provider</span>
              <small>Step 1 · connection</small>
            </div>
            <label>
              Provider
              <select value={newDefId} onChange={(e) => resetCreateForm(e.target.value)}>
                {definitions.map((def) => (
                  <option key={def.id} value={def.id}>{def.label}</option>
                ))}
              </select>
            </label>
            {isCustomCreate && (
              <label>
                Display name
                <input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="My local server" />
              </label>
            )}
            <label>
              API key {!needsKey(newDefId) && <small>optional</small>}
              <input
                type="password"
                value={newApiKey}
                onChange={(e) => setNewApiKey(e.target.value)}
                placeholder={needsKey(newDefId) ? createDef?.envKey || "Provider API key" : "Only if your endpoint requires a key"}
              />
            </label>
            <label>
              Base URL <small>{isCustomCreate ? "required" : "optional"}</small>
              <input
                value={newBaseUrl}
                onChange={(e) => setNewBaseUrl(e.target.value)}
                placeholder={isCustomCreate ? "http://127.0.0.1:1234/v1" : createDef?.defaultBaseUrl || "Provider default"}
              />
            </label>
            <div className="settings-note">
              <span>Models are added in the next step, individually — nothing is lost if you skip a field now; every part stays editable.</span>
            </div>
            {error && <div style={{ margin: "6px 0", color: "var(--red)", fontSize: "11px" }}>{error}</div>}
            <div className="modal-actions" style={{ marginTop: "12px" }}>
              <button
                className="primary full"
                disabled={!createDef || (isCustomCreate && !newBaseUrl.trim()) || (needsKey(newDefId) && !newApiKey.trim())}
                onClick={() => void handleCreate()}
              >
                <Check size={14} /> Create connection
              </button>
            </div>
          </div>
        ) : selected ? (
          <div className="provider-form">
            <div className="form-title">
              <span>{selected.label}</span>
              <small>{selected.enabled === false ? "Disabled" : "Connection · edit parts independently"}</small>
            </div>

            <label>
              Base URL <small>{isCustom ? "required" : "optional"}</small>
              <input
                value={baseUrlDraft}
                onChange={(e) => setBaseUrlDraft(e.target.value)}
                placeholder={isCustom ? "http://127.0.0.1:1234/v1" : definitions.find((d) => d.id === selected.provider)?.defaultBaseUrl || "Provider default"}
              />
            </label>
            {isCustom && (
              <label>
                Display name
                <input value={labelDraft} onChange={(e) => setLabelDraft(e.target.value)} />
              </label>
            )}
            <div className="modal-actions" style={{ marginTop: "8px", justifyContent: "flex-start" }}>
              <button className="secondary" disabled={!connectionDirty} onClick={() => void saveConnection()}>
                <Check size={13} /> Save connection
              </button>
            </div>

            <label style={{ marginTop: "10px" }}>
              Replace API key <small>{selected.apiKey ? "stored — leave empty to keep it" : selected.keyNeedsReentry ? "could not be decrypted — re-enter it" : selected.provider === "ollama" ? "optional" : "none stored"}</small>
              <input
                type="password"
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                placeholder={selected.apiKey ? "•••••••• (unchanged)" : "Enter API key"}
              />
            </label>
            {selected.keyNeedsReentry && (
              <div style={{ margin: "-2px 0 6px 0", color: "var(--red)", fontSize: "11px" }}>
                The stored key could not be decrypted on this machine — re-enter it to use this provider.
              </div>
            )}
            {!selected.keyNeedsReentry && !selected.apiKey && selected.provider !== "ollama" && (
              <div style={{ margin: "-2px 0 6px 0", color: "var(--red)", fontSize: "11px" }}>
                No API key is stored for this connection — requests will fail until you enter one.
              </div>
            )}
            <div className="modal-actions" style={{ marginTop: "4px", justifyContent: "flex-start" }}>
              <button className="secondary" disabled={!keyInput.trim()} onClick={() => void replaceKey()}>
                <KeyRound size={13} /> Update key
              </button>
            </div>

            <div className="form-title" style={{ marginTop: "16px", marginBottom: "6px" }}>
              <span>Models ({(selected.models || []).length})</span>
              <small>default path {ENDPOINT_LABELS[defaultEndpointFor(selected.provider)]}</small>
            </div>
            <div className="model-list-editor">
              {(selected.models || []).map((model) => {
                const override = (selected.modelEndpoints || {})[model];
                return (
                  <div className="model-row-item" key={model}>
                    <input
                      defaultValue={model}
                      key={model}
                      onBlur={(e) => void renameModel(model, e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); } }}
                      title="Edit the name, then press Enter"
                    />
                    <select
                      value={override || ""}
                      onChange={(e) => void setModelEndpoint(model, e.target.value as "" | ChatEndpointKind)}
                      title={override ? `Uses ${ENDPOINT_LABELS[override]} (override)` : `Uses default ${ENDPOINT_LABELS[defaultEndpointFor(selected.provider)]}`}
                      className={override ? "model-endpoint-select overridden" : "model-endpoint-select"}
                    >
                      <option value="">Default</option>
                      <option value="chat">/chat</option>
                      <option value="responses">/resp</option>
                      <option value="messages">/msg</option>
                    </select>
                    <button type="button" onClick={() => void removeModel(model)} title="Remove model">
                      <X size={13} />
                    </button>
                  </div>
                );
              })}
              {!(selected.models || []).length && (
                <div style={{ color: "var(--muted)", fontSize: "10.5px", padding: "4px 0" }}>
                  No models yet. Add one below, or fetch the list from the endpoint.
                </div>
              )}
            </div>
            <div className="model-add-bar">
              <input
                value={modelInput}
                onChange={(e) => setModelInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void addModels(); } }}
                placeholder="Model name (e.g. gpt-5.5-mini)"
              />
              <button type="button" className="secondary" disabled={!modelInput.trim()} onClick={() => void addModels()}>
                <Plus size={13} /> Add
              </button>
            </div>
            <div className="provider-fetch">
              <button className="secondary" disabled={fetching} onClick={() => void fetchModels()}>
                {fetching ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />} Fetch models from endpoint
              </button>
            </div>
            {note && <div style={{ margin: "6px 0", color: "var(--green)", fontSize: "11px" }}>{note}</div>}
            {error && <div style={{ margin: "6px 0", color: "var(--red)", fontSize: "11px" }}>{error}</div>}
            <div className="settings-note" style={{ marginTop: 2 }}>
              <span>Per-model path is for gateways that split models across endpoints (e.g. OpenCode Zen: /chat, /responses, /messages). Leave on Default unless a model fails.</span>
            </div>
          </div>
        ) : null}
      </div>
      {deleteTarget && (
        <ConfirmModal
          title={`Delete ${deleteTarget.label}?`}
          message={`Are you sure you want to remove the "${deleteTarget.label}" connection? Any sessions currently using this model will be reset.`}
          confirmLabel="Delete provider"
          danger
          onConfirm={() => {
            const id = deleteTarget.id;
            setDeleteTarget(null);
            void handleDelete(id);
          }}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </>
  );
}
