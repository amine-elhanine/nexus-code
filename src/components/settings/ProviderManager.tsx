import React, { useState } from "react";
import { Plus, Settings2, Trash2, KeyRound, X, RefreshCw, Loader2, Check } from "lucide-react";
import { ConfirmModal } from "../../modals/ConfirmModal.js";
import type { ChatEndpointKind, ProviderConfig, ProviderDefinition } from "../../types.js";

/** Provider-level default path (mirrors the backend resolver). */
function defaultEndpointFor(providerId: string): ChatEndpointKind {
  return providerId === "anthropic" ? "messages" : "chat";
}

const ENDPOINT_LABELS: Record<ChatEndpointKind, string> = {
  chat: "/chat/completions",
  responses: "/responses",
  messages: "/messages",
};

type ProviderFormState = {
  id?: string;
  provider: string;
  label: string;
  apiKey: string;
  baseUrl: string;
  models: string[];
  modelEndpoints: Partial<Record<string, ChatEndpointKind>>;
};

function emptyProviderForm(definitions: ProviderDefinition[]): ProviderFormState {
  const def = definitions[0];
  return {
    provider: def?.id || "openai",
    label: def?.label || "OpenAI",
    apiKey: "",
    baseUrl: def?.defaultBaseUrl || "",
    models: [...(def?.models || [])],
    modelEndpoints: {},
  };
}

function formFromProvider(provider: ProviderConfig): ProviderFormState {
  return {
    id: provider.id,
    provider: provider.provider,
    label: provider.label,
    apiKey: provider.apiKey || "",
    baseUrl: provider.baseUrl || "",
    models: provider.models && provider.models.length ? [...provider.models] : [],
    modelEndpoints: { ...(provider.modelEndpoints || {}) },
  };
}

export function ProviderManager({
  providers,
  definitions,
  onProvidersChange,
}: {
  providers: ProviderConfig[];
  definitions: ProviderDefinition[];
  onProvidersChange: (providers: ProviderConfig[]) => void;
}) {
  const [form, setForm] = useState<ProviderFormState>(() => emptyProviderForm(definitions));
  const [newModelInput, setNewModelInput] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [fetchNote, setFetchNote] = useState("");
  const [fetchError, setFetchError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<ProviderConfig | null>(null);

  const api = window.nexus || window.forgepilot;
  const currentDef = definitions.find((d) => d.id === form.provider) || definitions[0];
  const isCustom = form.provider === "custom";

  function handleSelectDefinition(defId: string) {
    const def = definitions.find((d) => d.id === defId);
    if (!def) return;
    setForm((prev) => ({
      ...prev,
      provider: def.id,
      label: def.id === "custom" ? (prev.label || "Custom endpoint") : def.label,
      baseUrl: def.defaultBaseUrl || "",
      models: [...(def.models || [])],
    }));
    setNewModelInput("");
    setFetchNote("");
    setFetchError("");
  }

  function handleEdit(provider: ProviderConfig) {
    setForm(formFromProvider(provider));
    setIsEditing(true);
    setNewModelInput("");
    setFetchNote("");
    setFetchError("");
  }

  function handleNew() {
    setForm(emptyProviderForm(definitions));
    setIsEditing(false);
    setNewModelInput("");
    setFetchNote("");
    setFetchError("");
  }

  function updateModel(index: number, value: string) {
    setForm((prev) => {
      const next = [...prev.models];
      const oldName = next[index]?.trim();
      next[index] = value;
      // Carry a per-model path override across renames.
      const endpoints = { ...prev.modelEndpoints };
      if (oldName && endpoints[oldName] && value.trim() && value.trim() !== oldName) {
        endpoints[value.trim()] = endpoints[oldName];
        delete endpoints[oldName];
      }
      return { ...prev, models: next, modelEndpoints: endpoints };
    });
  }

  function removeModel(index: number) {
    setForm((prev) => {
      const removed = prev.models[index]?.trim();
      const next = prev.models.filter((_, i) => i !== index);
      const endpoints = { ...prev.modelEndpoints };
      if (removed) delete endpoints[removed];
      return { ...prev, models: next, modelEndpoints: endpoints };
    });
  }

  function setModelEndpoint(modelName: string, endpoint: "" | ChatEndpointKind) {
    const name = modelName.trim();
    if (!name) return;
    setForm((prev) => {
      const endpoints = { ...prev.modelEndpoints };
      if (!endpoint) delete endpoints[name];
      else endpoints[name] = endpoint;
      return { ...prev, modelEndpoints: endpoints };
    });
  }

  function handleAddModel() {
    const raw = newModelInput.trim();
    if (!raw) return;
    const items = raw.split(/[,\n]+/).map((s) => s.trim()).filter(Boolean);
    setForm((prev) => ({
      ...prev,
      models: Array.from(new Set([...prev.models, ...items])),
    }));
    setNewModelInput("");
  }

  async function handleDelete(providerId: string) {
    try {
      const remaining = await api.removeProvider(providerId);
      onProvidersChange(remaining);
      handleNew();
    } catch (error) {
      setFetchError(error instanceof Error ? error.message : "Unable to remove provider.");
    }
  }

  async function handleSave() {
    if (!form.provider) return;
    if (isCustom && !form.baseUrl.trim()) return;

    const parsedModels = form.models.map((m) => m.trim()).filter(Boolean);
    const models = parsedModels.length ? parsedModels : currentDef?.models || [];
    const label = isCustom ? (form.label.trim() || "Custom endpoint") : (currentDef?.label || form.label || "Provider");

    try {
      const saved = await api.saveProvider({
        id: isEditing ? form.id : undefined,
        provider: form.provider,
        label,
        apiKey: form.apiKey,
        baseUrl: form.baseUrl.trim() || undefined,
        models,
        modelEndpoints: form.modelEndpoints,
      });
      onProvidersChange(saved);
      handleNew();
    } catch (error) {
      setFetchError(error instanceof Error ? error.message : "Unable to save provider.");
    }
  }

  async function fetchModels() {
    setFetching(true);
    setFetchNote("");
    setFetchError("");
    try {
      const found = await api.fetchProviderModels(form.baseUrl || "", form.apiKey || "");
      const existing = form.models.map((item) => item.trim()).filter(Boolean);
      const merged = Array.from(new Set([...existing, ...found]));
      setForm((prev) => ({ ...prev, models: merged }));
      setFetchNote(`Fetched ${found.length} model${found.length === 1 ? "" : "s"} from the endpoint.`);
    } catch (error) {
      setFetchError(error instanceof Error ? error.message : "Unable to fetch models.");
    } finally {
      setFetching(false);
    }
  }

  return (
    <>
      <div className="provider-layout">
        <div className="provider-list">
          <div className="pane-top" style={{ padding: "0 0 8px 0" }}>
            <span>CONFIGURED PROVIDERS</span>
            <button className="pane-action" onClick={handleNew} title="Add new provider"><Plus size={14} /></button>
          </div>
          {providers.map((provider) => (
            <div className={`provider-card ${form.id === provider.id ? "active" : ""}`} key={provider.id}>
              <div className="provider-card-main" onClick={() => handleEdit(provider)} style={{ cursor: "pointer" }}>
                <span className="provider-logo">{provider.label.slice(0, 1)}</span>
                <div>
                  <strong>{provider.label}</strong>
                  <small>{provider.models.length} models · {provider.apiKey ? "key configured" : "local"}</small>
                </div>
              </div>
              <div className="provider-card-actions">
                <button onClick={(event) => { event.stopPropagation(); handleEdit(provider); }} title="Edit provider settings"><Settings2 size={13} /></button>
                <button className="danger" onClick={(event) => { event.stopPropagation(); setDeleteTarget(provider); }} title="Delete provider"><Trash2 size={13} /></button>
              </div>
            </div>
          ))}
          {!providers.length && (
            <div className="empty-provider">
              <KeyRound size={18} />
              <p>No providers configured.</p>
            </div>
          )}
        </div>
        <div className="provider-form">
          <div className="form-title">
            <span>{isEditing ? `Edit ${form.label || "connection"}` : "Add provider"}</span>
            <small>{isEditing ? "Editing connection" : "LangChain integration"}</small>
          </div>
          <label>
            Provider
            <select value={form.provider || "openai"} onChange={(e) => handleSelectDefinition(e.target.value)}>
              {definitions.map((def) => (
                <option key={def.id} value={def.id}>{def.label}</option>
              ))}
            </select>
          </label>
          {isCustom && (
            <label>
              Display name
              <input value={form.label || ""} onChange={(e) => setForm((prev) => ({ ...prev, label: e.target.value }))} placeholder="My local server" />
            </label>
          )}
          <label>
            API key
            <input
              type="password"
              value={form.apiKey || ""}
              onChange={(e) => setForm((prev) => ({ ...prev, apiKey: e.target.value }))}
              placeholder={isCustom ? "Optional — only if your endpoint requires a key" : currentDef?.envKey || "Provider API key"}
            />
          </label>
          <label>
            Base URL <small>{isCustom ? "required" : "optional"}</small>
            <input
              value={form.baseUrl || ""}
              onChange={(e) => setForm((prev) => ({ ...prev, baseUrl: e.target.value }))}
              placeholder={isCustom ? "http://127.0.0.1:1234/v1" : currentDef?.defaultBaseUrl || "Provider default"}
            />
          </label>
          <label style={{ marginBottom: "4px" }}>
            Models ({form.models.length}) <small>each model listed separately · default path {ENDPOINT_LABELS[defaultEndpointFor(form.provider)]}</small>
          </label>
          <div className="model-list-editor">
            {form.models.map((model, idx) => {
              const override = form.modelEndpoints[model.trim()];
              return (
              <div className="model-row-item" key={idx}>
                <input
                  value={model}
                  onChange={(e) => updateModel(idx, e.target.value)}
                  placeholder="e.g. gpt-4.1, claude-3-7-sonnet"
                />
                <select
                  value={override || ""}
                  onChange={(e) => setModelEndpoint(model, e.target.value as "" | ChatEndpointKind)}
                  title={override ? `Uses ${ENDPOINT_LABELS[override]} (override)` : `Uses default ${ENDPOINT_LABELS[defaultEndpointFor(form.provider)]}`}
                  className={override ? "model-endpoint-select overridden" : "model-endpoint-select"}
                >
                  <option value="">Default</option>
                  <option value="chat">/chat</option>
                  <option value="responses">/resp</option>
                  <option value="messages">/msg</option>
                </select>
                <button
                  type="button"
                  onClick={() => removeModel(idx)}
                  title="Remove model"
                >
                  <X size={13} />
                </button>
              </div>
              );
            })}
            {!form.models.length && (
              <div style={{ color: "#6e7c8e", fontSize: "10.5px", padding: "4px 0" }}>
                No models added yet. Add a model below.
              </div>
            )}
          </div>
          <div className="model-add-bar">
            <input
              value={newModelInput}
              onChange={(e) => setNewModelInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleAddModel();
                }
              }}
              placeholder="Model name (e.g. gpt-5.5-mini)"
            />
            <button
              type="button"
              className="secondary"
              disabled={!newModelInput.trim()}
              onClick={handleAddModel}
            >
              <Plus size={13} /> Add
            </button>
          </div>
          {isCustom && (
            <div className="provider-fetch">
              <button className="secondary" disabled={fetching || !form.baseUrl.trim()} onClick={() => void fetchModels()}>
                {fetching ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />} Fetch models from endpoint
              </button>
            </div>
          )}
          {fetchNote && <div style={{ margin: "6px 0", color: "var(--green)", fontSize: "11px" }}>{fetchNote}</div>}
          {fetchError && <div style={{ margin: "6px 0", color: "var(--red)", fontSize: "11px" }}>{fetchError}</div>}
          <div className="settings-note" style={{ marginTop: 2 }}>
            <span>Per-model path is for gateways that split models across endpoints (e.g. OpenCode Zen: /chat, /responses, /messages). Leave on Default unless a model fails.</span>
          </div>
          <div className="modal-actions" style={{ marginTop: "16px" }}>
            {isEditing && <button className="secondary" onClick={handleNew}>Cancel edit</button>}
            <button className="primary full" disabled={!form.provider || (isCustom && !form.baseUrl.trim())} onClick={() => void handleSave()}>
              <Check size={14} /> {isEditing ? "Save changes" : "Add provider"}
            </button>
          </div>
        </div>
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
