import React, { useEffect, useState } from "react";
import { Eye, EyeOff, KeyRound, FolderOpen, ChevronRight, Globe, Puzzle, Server, Terminal, Download, RefreshCw, Loader2, Check, BookOpen, Plus, Settings2, Trash2, X, Palette } from "lucide-react";
import { Modal } from "../components/common/Modal.js";
import { ProviderManager } from "../components/settings/ProviderManager.js";
import { McpManager } from "../components/settings/McpManager.js";
import { SkillsManager } from "../components/settings/SkillsManager.js";
import { MemoryRow } from "../views/MemoryView.js";
import { APP_THEMES, applyTheme, getStoredThemeId } from "../state/theme.js";
import type { EmbeddingEndpointKind, EmbeddingProviderConfig, ProviderConfig, ProviderDefinition, UpdaterState } from "../types.js";

type SettingsSection = "appearance" | "browser" | "providers" | "notebook" | "mcp" | "skills" | "services" | "updates" | "workspace";

export function SettingsModal({
  area,
  hasProject,
  skillsEnabled,
  onToggleSkills,
  providers,
  providerDefinitions,
  onProvidersChange,
  onManageServices,
  updater,
  appVersion,
  onCheckUpdates,
  onQuitAndInstall,
  onClose,
}: {
  area: "home" | "code" | "notebook";
  hasProject: boolean;
  skillsEnabled: boolean;
  onToggleSkills: (enabled: boolean) => Promise<void>;
  providers: ProviderConfig[];
  providerDefinitions: ProviderDefinition[];
  onProvidersChange: (providers: ProviderConfig[]) => void;
  onManageServices: () => void;
  updater: UpdaterState;
  appVersion: string;
  onCheckUpdates: () => void;
  onQuitAndInstall: () => void;
  onClose: () => void;
}) {
  const api = window.nexus || window.forgepilot;
  const [section, setSection] = useState<SettingsSection>("appearance");
  const [themeId, setThemeId] = useState(() => getStoredThemeId());
  const [themeNote, setThemeNote] = useState("");
  const [headless, setHeadless] = useState(true);
  const [rerankEnabled, setRerankEnabled] = useState(false);
  const [rerankProviderId, setRerankProviderId] = useState("");
  const [rerankModel, setRerankModel] = useState("");
  const [rerankNote, setRerankNote] = useState("");
  const [visionEnabled, setVisionEnabled] = useState(true);
  const [visionProviderId, setVisionProviderId] = useState("");
  const [visionModel, setVisionModel] = useState("");
  const [visionNote, setVisionNote] = useState("");
  const [parserEnabled, setParserEnabled] = useState(false);
  const [parserProvider, setParserProvider] = useState<"local" | "llamaparse">("local");
  const [parserApiKey, setParserApiKey] = useState("");
  const [parserBaseUrl, setParserBaseUrl] = useState("https://api.cloud.llamaindex.ai");
  const [parserTier, setParserTier] = useState("cost_effective");
  const [parserVersion, setParserVersion] = useState("latest");
  const [parserTimeout, setParserTimeout] = useState("600");
  const [parserNote, setParserNote] = useState("");

  useEffect(() => {
    const typed = api as unknown as { getBrowserHeadless?: () => Promise<boolean> };
    if (typeof typed.getBrowserHeadless === "function") {
      typed.getBrowserHeadless().then(setHeadless).catch(() => {});
    }
  }, []);

  useEffect(() => {
    const typed = api as unknown as { getNotebookParser?: () => Promise<{ provider: "local" | "llamaparse"; enabled: boolean; apiKey: string; baseUrl: string; tier: string; version: string; timeoutSeconds: number }> };
    typed.getNotebookParser?.().then((value) => {
      setParserEnabled(value.enabled);
      setParserProvider(value.provider);
      setParserApiKey(value.apiKey || "");
      setParserBaseUrl(value.baseUrl || "https://api.cloud.llamaindex.ai");
      setParserTier(value.tier || "cost_effective");
      setParserVersion(value.version || "latest");
      setParserTimeout(String(value.timeoutSeconds || 600));
    }).catch(() => {});
  }, []);

  useEffect(() => {
    const typed = api as unknown as { getAppSettings?: () => Promise<{ notebookRerankEnabled?: boolean; notebookRerankProviderId?: string; notebookRerankModel?: string; notebookVisionEnabled?: boolean; notebookVisionProviderId?: string; notebookVisionModel?: string; theme?: string }> };
    typed.getAppSettings?.().then((value) => {
      setRerankEnabled(Boolean(value.notebookRerankEnabled));
      setRerankProviderId(value.notebookRerankProviderId || "");
      setRerankModel(value.notebookRerankModel || "");
      setVisionEnabled(value.notebookVisionEnabled !== false);
      setVisionProviderId(value.notebookVisionProviderId || "");
      setVisionModel(value.notebookVisionModel || "");
      if (typeof value.theme === "string" && value.theme) {
        setThemeId(applyTheme(value.theme));
      } else {
        applyTheme(getStoredThemeId());
      }
    }).catch(() => {
      applyTheme(getStoredThemeId());
    });
  }, []);

  async function selectTheme(nextId: string) {
    const applied = applyTheme(nextId);
    setThemeId(applied);
    setThemeNote("");
    try {
      const typed = api as unknown as { saveAppSettings?: (value: unknown) => Promise<unknown> };
      if (typeof typed.saveAppSettings === "function") {
        await typed.saveAppSettings({ theme: applied });
      }
    } catch (error) {
      setThemeNote(error instanceof Error ? error.message : "Could not save theme.");
    }
  }

  async function saveRerankConfig() {
    const typed = api as unknown as { saveAppSettings?: (value: unknown) => Promise<unknown> };
    if (!typed.saveAppSettings) return;
    try {
      await typed.saveAppSettings({ notebookRerankEnabled: rerankEnabled, notebookRerankProviderId: rerankProviderId || undefined, notebookRerankModel: rerankModel.trim() || undefined });
      setRerankNote(rerankEnabled ? "Saved. Notebook answers will use this model to rerank evidence." : "Saved. Local reranking remains active.");
    } catch (error) {
      setRerankNote(error instanceof Error ? error.message : "Could not save reranking settings.");
    }
  }

  async function saveVisionConfig() {
    const typed = api as unknown as { saveAppSettings?: (value: unknown) => Promise<unknown> };
    if (!typed.saveAppSettings) return;
    try {
      await typed.saveAppSettings({ notebookVisionEnabled: visionEnabled, notebookVisionProviderId: visionProviderId || undefined, notebookVisionModel: visionModel.trim() || undefined });
      setVisionNote(visionEnabled ? "Saved. New image and scanned-PDF ingestion will use this model." : "Saved. Visual analysis is disabled.");
    } catch (error) {
      setVisionNote(error instanceof Error ? error.message : "Could not save vision settings.");
    }
  }

  async function saveParserConfig() {
    const typed = api as unknown as { saveNotebookParser?: (value: unknown) => Promise<unknown> };
    if (!typed.saveNotebookParser) return;
    try {
      await typed.saveNotebookParser({
        enabled: parserEnabled,
        provider: parserProvider,
        apiKey: parserApiKey || undefined,
        baseUrl: parserBaseUrl.trim() || "https://api.cloud.llamaindex.ai",
        tier: parserTier,
        version: parserVersion.trim() || "latest",
        timeoutSeconds: Number(parserTimeout) || 600,
      });
      setParserNote(parserEnabled && parserProvider === "llamaparse" ? "Saved. New notebook files will be parsed with LlamaParse." : "Saved. Local parsing is active.");
    } catch (error) {
      setParserNote(error instanceof Error ? error.message : "Could not save parser settings.");
    }
  }

  async function setHeadlessValue(next: boolean) {
    setHeadless(next);
    try {
      const typed = api as unknown as { setBrowserHeadless?: (v: boolean) => Promise<boolean> };
      if (typeof typed.setBrowserHeadless === "function") {
        setHeadless(await typed.setBrowserHeadless(next));
      }
    } catch {
      setHeadless(!next);
    }
  }

  const [embeddingProviderId, setEmbeddingProviderId] = useState("");
  const [embeddingModel, setEmbeddingModel] = useState("text-embedding-3-small");
  const [embeddingNote, setEmbeddingNote] = useState("");
  const [embProviders, setEmbProviders] = useState<EmbeddingProviderConfig[]>([]);
  const [embForm, setEmbForm] = useState<{ id?: string; name: string; kind: EmbeddingEndpointKind; baseUrl: string; apiKey: string; models: string[] }>({
    name: "",
    kind: "openai",
    baseUrl: "",
    apiKey: "",
    models: [],
  });
  const [isEditingEmb, setIsEditingEmb] = useState(false);
  const [newEmbModel, setNewEmbModel] = useState("");
  const [testingEmb, setTestingEmb] = useState(false);
  const [embTestNote, setEmbTestNote] = useState("");
  const [embTestError, setEmbTestError] = useState("");

  const EMB_KINDS: Array<{ id: EmbeddingEndpointKind; label: string; showBase: boolean; basePlaceholder: string; keyHint: string; modelPlaceholder: string }> = [
    { id: "openai", label: "OpenAI-compatible", showBase: true, basePlaceholder: "http://127.0.0.1:1234/v1 (blank = api.openai.com)", keyHint: "Optional — only if the endpoint requires a key", modelPlaceholder: "text-embedding-3-small" },
    { id: "ollama", label: "Ollama", showBase: true, basePlaceholder: "http://127.0.0.1:11434", keyHint: "Not needed for Ollama", modelPlaceholder: "nomic-embed-text" },
    { id: "gemini", label: "Google Gemini", showBase: false, basePlaceholder: "", keyHint: "Google AI Studio key (required)", modelPlaceholder: "text-embedding-004" },
    { id: "cohere", label: "Cohere", showBase: false, basePlaceholder: "", keyHint: "Cohere API key (required)", modelPlaceholder: "embed-english-v3.0" },
  ];
  const embKindMeta = EMB_KINDS.find((k) => k.id === embForm.kind) || EMB_KINDS[0];

  type EmbApi = {
    getNotebookEmbedding?: () => Promise<{ providerId: string; model: string }>;
    saveNotebookEmbedding?: (cfg: { providerId: string; model: string }) => Promise<{ providerId: string; model: string }>;
    listEmbeddingProviders?: () => Promise<EmbeddingProviderConfig[]>;
    saveEmbeddingProvider?: (p: unknown) => Promise<EmbeddingProviderConfig[]>;
    removeEmbeddingProvider?: (id: string) => Promise<EmbeddingProviderConfig[]>;
    testEmbeddingProvider?: (input: { id?: string; kind: string; baseUrl?: string; apiKey?: string; model: string }) => Promise<{ dims: number }>;
  };
  const embApi = api as unknown as EmbApi;

  useEffect(() => {
    if (typeof embApi.getNotebookEmbedding === "function") {
      embApi.getNotebookEmbedding().then((cfg) => {
        setEmbeddingProviderId(cfg.providerId || "");
        setEmbeddingModel(cfg.model || "text-embedding-3-small");
      }).catch(() => {});
    }
    if (typeof embApi.listEmbeddingProviders === "function") {
      embApi.listEmbeddingProviders().then(setEmbProviders).catch(() => {});
    }
  }, []);

  async function saveEmbeddingConfig() {
    try {
      if (typeof embApi.saveNotebookEmbedding === "function") {
        await embApi.saveNotebookEmbedding({ providerId: embeddingProviderId, model: embeddingModel.trim() || "text-embedding-3-small" });
        setEmbeddingNote("Saved. Re-index notebook sources to apply the new embedding space.");
      } else {
        setEmbeddingNote("Notebook backend is unavailable in this build.");
      }
    } catch (error) {
      setEmbeddingNote(error instanceof Error ? error.message : "Save failed.");
    }
  }

  function resetEmbForm() {
    setEmbForm({ name: "", kind: "openai", baseUrl: "", apiKey: "", models: [] });
    setIsEditingEmb(false);
    setNewEmbModel("");
    setEmbTestNote("");
    setEmbTestError("");
  }

  function useOpenRouterEmbeddingPreset() {
    setEmbForm({
      name: "OpenRouter",
      kind: "openai",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "",
      models: ["openai/text-embedding-3-small"],
    });
    setIsEditingEmb(false);
    setNewEmbModel("");
    setEmbTestNote("");
    setEmbTestError("");
  }

  function useMistralEmbeddingPreset() {
    setEmbForm({
      name: "Mistral",
      kind: "openai",
      baseUrl: "https://api.mistral.ai/v1",
      apiKey: "",
      models: ["mistral-embed"],
    });
    setIsEditingEmb(false);
    setNewEmbModel("");
    setEmbTestNote("");
    setEmbTestError("");
  }

  function handleEditEmb(provider: EmbeddingProviderConfig) {
    setEmbForm({ id: provider.id, name: provider.name, kind: provider.kind, baseUrl: provider.baseUrl || "", apiKey: provider.apiKey || "", models: [...provider.models] });
    setIsEditingEmb(true);
    setNewEmbModel("");
    setEmbTestNote("");
    setEmbTestError("");
  }

  async function handleSaveEmb() {
    if (!embForm.name.trim() || typeof embApi.saveEmbeddingProvider !== "function") return;
    try {
      const saved = await embApi.saveEmbeddingProvider({
        id: isEditingEmb ? embForm.id : undefined,
        name: embForm.name.trim(),
        kind: embForm.kind,
        baseUrl: embForm.baseUrl.trim() || undefined,
        apiKey: embForm.apiKey,
        models: embForm.models,
      });
      setEmbProviders(saved);
      resetEmbForm();
    } catch (error) {
      setEmbTestError(error instanceof Error ? error.message : "Unable to save embedding provider.");
    }
  }

  async function handleDeleteEmb(providerId: string) {
    if (typeof embApi.removeEmbeddingProvider !== "function") return;
    if (!window.confirm("Delete this embedding provider? Notebooks using it will fall back to local embeddings.")) return;
    try {
      const remaining = await embApi.removeEmbeddingProvider(providerId);
      setEmbProviders(remaining);
      if (embeddingProviderId === providerId) setEmbeddingProviderId("");
      if (embForm.id === providerId) resetEmbForm();
    } catch (error) {
      setEmbTestError(error instanceof Error ? error.message : "Unable to delete embedding provider.");
    }
  }

  async function testEndpoint(id: string | undefined, kind: string, baseUrl: string, apiKey: string, model: string) {
    if (typeof embApi.testEmbeddingProvider !== "function" || !model.trim()) return;
    setTestingEmb(true);
    setEmbTestNote("");
    setEmbTestError("");
    try {
      const result = await embApi.testEmbeddingProvider({ id, kind, baseUrl: baseUrl.trim() || undefined, apiKey, model: model.trim() });
      setEmbTestNote(`Connection OK — endpoint returned ${result.dims}-dimensional embeddings.`);
    } catch (error) {
      setEmbTestError(error instanceof Error ? error.message : "Connection test failed.");
    } finally {
      setTestingEmb(false);
    }
  }

  const activeEmbProvider = embProviders.find((p) => p.id === embeddingProviderId);

  const items: Array<{ id: SettingsSection; label: string; icon: React.ReactNode; hidden?: boolean }> = [
    { id: "appearance", label: "Appearance", icon: <Palette size={13} /> },
    { id: "browser", label: "Browser", icon: <Globe size={13} /> },
    { id: "providers", label: "Providers", icon: <KeyRound size={13} /> },
    { id: "notebook", label: "Notebook", icon: <BookOpen size={13} /> },
    { id: "mcp", label: "MCP servers", icon: <Server size={13} /> },
    { id: "skills", label: "Skills", icon: <Puzzle size={13} /> },
    { id: "services", label: "Services", icon: <Terminal size={13} /> },
    { id: "updates", label: "Updates", icon: <Download size={13} /> },
    { id: "workspace", label: "Workspace", icon: <FolderOpen size={13} />, hidden: area !== "home" },
  ];

  return (
    <Modal title="Settings" subtitle="Application preferences. Changes apply immediately." onClose={onClose}>
      <div className="settings-layout">
        <aside className="settings-side">
          {items
            .filter((item) => !item.hidden)
            .map((item) => (
              <button
                key={item.id}
                type="button"
                className={section === item.id ? "active" : ""}
                onClick={() => setSection(item.id)}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            ))}
        </aside>
        <section className="settings-body">
          {section === "appearance" && (
            <div className="setting-card">
              <div className="setting-row">
                <span className="setting-icon"><Palette size={14} /></span>
                <div className="setting-text">
                  <strong>Color theme</strong>
                  <small>Pick a palette for the whole app. Changes apply immediately and are saved.</small>
                </div>
              </div>
              <div className="theme-grid">
                {APP_THEMES.map((theme) => {
                  const selected = theme.id === themeId;
                  return (
                    <button
                      key={theme.id}
                      type="button"
                      className={`theme-card${selected ? " selected" : ""}`}
                      onClick={() => void selectTheme(theme.id)}
                      title={theme.description}
                    >
                      <span className="theme-preview" style={{ background: theme.swatches[0] }}>
                        <span className="theme-preview-top" style={{ background: theme.swatches[1] }}>
                          <i style={{ background: "#ff5f57" }} />
                          <i style={{ background: "#febc2e" }} />
                          <i style={{ background: theme.accent }} />
                        </span>
                        <span className="theme-preview-body">
                          <span className="theme-preview-side" style={{ background: theme.swatches[1] }} />
                          <span className="theme-preview-main" style={{ background: theme.swatches[1] }}>
                            <i style={{ background: theme.accent, width: "70%" }} />
                            <i style={{ background: theme.swatches[3], width: "45%" }} />
                            <i style={{ background: "currentColor", opacity: 0.25, width: "85%" }} />
                          </span>
                        </span>
                      </span>
                      <span className="theme-meta">
                        <span>
                          <strong>{theme.name}</strong>
                          <small>{theme.description}</small>
                        </span>
                        <span className="theme-check"><Check size={12} /></span>
                      </span>
                      <span className="theme-swatches">
                        {theme.swatches.map((color) => (
                          <i key={color} style={{ background: color }} />
                        ))}
                      </span>
                    </button>
                  );
                })}
              </div>
              {!!themeNote && <div className="settings-note" style={{ marginTop: 8 }}><Check size={12} /><span>{themeNote}</span></div>}
            </div>
          )}

          {section === "browser" && (
            <div className="setting-card">
              <div className="setting-row">
                <span className="setting-icon">{headless ? <EyeOff size={14} /> : <Eye size={14} />}</span>
                <div className="setting-text">
                  <strong>Agent browser visibility</strong>
                  <small>
                    {headless
                      ? "Hidden — the agent inspects and operates pages in the background."
                      : "Watching — the built-in Browser tab follows the agent live."}
                  </small>
                </div>
              </div>
              <div className="seg" role="group" aria-label="Agent browser visibility">
                <button
                  type="button"
                  className={headless ? "active" : ""}
                  onClick={() => void setHeadlessValue(true)}
                >
                  <EyeOff size={12} /> Headless
                </button>
                <button
                  type="button"
                  className={!headless ? "active" : ""}
                  onClick={() => void setHeadlessValue(false)}
                >
                  <Eye size={12} /> Watching
                </button>
              </div>
              <div className="settings-note" style={{ marginTop: "10px" }}>
                <Globe size={12} />
                <span>Same switch lives in the Browser tab toolbar. Follow the agent with the Follow banner there.</span>
              </div>
            </div>
          )}

          {section === "providers" && (
            <ProviderManager providers={providers} definitions={providerDefinitions} onProvidersChange={onProvidersChange} />
          )}

          {section === "notebook" && (
            <>
            <div className="setting-card">
              <div className="setting-row">
                <span className="setting-icon"><BookOpen size={14} /></span>
                <div className="setting-text">
                  <strong>Active notebook embeddings</strong>
                  <small>Vector space for Notebook RAG. Changing it requires re-indexing sources (Notebook → source → re-index).</small>
                </div>
              </div>
              <label className="field-label" style={{ marginTop: 10 }}>Embedding provider</label>
              <select value={embeddingProviderId} onChange={(e) => setEmbeddingProviderId(e.target.value)} className="select-field">
                <option value="">Local built-in (offline, no key)</option>
                {embProviders.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              <label className="field-label" style={{ marginTop: 10 }}>Embedding model</label>
              <input
                value={embeddingModel}
                onChange={(e) => setEmbeddingModel(e.target.value)}
                placeholder="text-embedding-3-small"
                className="text-field"
                list="emb-active-models"
              />
              {!!activeEmbProvider?.models.length && (
                <datalist id="emb-active-models">
                  {activeEmbProvider.models.map((m: string) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              )}
              <div className="modal-actions" style={{ marginTop: 12 }}>
                <button
                  className="secondary"
                  disabled={testingEmb || !embeddingProviderId || !embeddingModel.trim()}
                  onClick={() => {
                    const p = embProviders.find((x) => x.id === embeddingProviderId);
                    if (p) void testEndpoint(p.id, p.kind, p.baseUrl || "", p.apiKey, embeddingModel);
                  }}
                  title="Embed one short text with the selected provider + model"
                >
                  {testingEmb ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} Test
                </button>
                <button className="primary full" onClick={() => void saveEmbeddingConfig()}>
                  <Check size={14} /> Save embedding config
                </button>
              </div>
              {!!embeddingNote && <div className="settings-note" style={{ marginTop: 8 }}><Check size={12} /><span>{embeddingNote}</span></div>}
            </div>

            <div className="setting-card" style={{ marginTop: 12 }}>
              <div className="setting-row">
                <span className="setting-icon"><BookOpen size={14} /></span>
                <div className="setting-text">
                  <strong>Document parser</strong>
                  <small>LlamaParse handles OCR, layouts, tables, figures, slides, and scanned pages before the notebook indexes the result. The local parser remains available as an offline fallback.</small>
                </div>
              </div>
              <label className="toggle-row" style={{ marginTop: 10 }}>
                <input type="checkbox" checked={parserEnabled} onChange={(e) => setParserEnabled(e.target.checked)} />
                <span>Use configured parser for new and re-indexed files</span>
              </label>
              <label className="field-label" style={{ marginTop: 10 }}>Parser</label>
              <select className="select-field" value={parserProvider} onChange={(e) => setParserProvider(e.target.value as "local" | "llamaparse")}>
                <option value="llamaparse">LlamaParse (Llama Cloud)</option>
                <option value="local">Local/offline parser</option>
              </select>
              {parserProvider === "llamaparse" && <>
                <label className="field-label" style={{ marginTop: 10 }}>Llama Cloud API key</label>
                <input className="text-field" type="password" value={parserApiKey} onChange={(e) => setParserApiKey(e.target.value)} placeholder="Paste your Llama Cloud API key" />
                <label className="field-label" style={{ marginTop: 10 }}>Base URL</label>
                <input className="text-field" value={parserBaseUrl} onChange={(e) => setParserBaseUrl(e.target.value)} placeholder="https://api.cloud.llamaindex.ai" />
                <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  <label>Tier<select className="select-field" value={parserTier} onChange={(e) => setParserTier(e.target.value)}><option value="cost_effective">Cost effective</option><option value="agentic">Agentic</option><option value="agentic_plus">Agentic plus</option><option value="fast">Fast</option></select></label>
                  <label>Version<input className="text-field" value={parserVersion} onChange={(e) => setParserVersion(e.target.value)} placeholder="latest" /></label>
                </div>
                <label className="field-label" style={{ marginTop: 10 }}>Timeout (seconds)</label>
                <input className="text-field" type="number" min={30} max={3600} value={parserTimeout} onChange={(e) => setParserTimeout(e.target.value)} />
              </>}
              <div className="modal-actions" style={{ marginTop: 12 }}><button className="primary full" onClick={() => void saveParserConfig()}><Check size={14} /> Save parser config</button></div>
              {!!parserNote && <div className="settings-note" style={{ marginTop: 8 }}><Check size={12} /><span>{parserNote}</span></div>}
            </div>

            <div className="setting-card" style={{ marginTop: 12 }}>
              <div className="setting-row">
                <span className="setting-icon"><Eye size={14} /></span>
                <div className="setting-text">
                  <strong>Vision model</strong>
                  <small>Used for standalone images, embedded Office images, PDF figures, and scanned PDF pages. Leave the model blank to use the provider default.</small>
                </div>
              </div>
              <label className="toggle-row" style={{ marginTop: 10 }}>
                <input type="checkbox" checked={visionEnabled} onChange={(e) => setVisionEnabled(e.target.checked)} />
                <span>Enable visual analysis during ingestion</span>
              </label>
              <label className="field-label" style={{ marginTop: 10 }}>Vision provider</label>
              <select className="select-field" value={visionProviderId} onChange={(e) => { setVisionProviderId(e.target.value); setVisionModel(""); }} disabled={!visionEnabled}>
                <option value="">Use first configured provider</option>
                {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}
              </select>
              <label className="field-label" style={{ marginTop: 10 }}>Vision model</label>
              <input className="text-field" value={visionModel} onChange={(e) => setVisionModel(e.target.value)} placeholder="Use provider default vision model" disabled={!visionEnabled} list="vision-models" />
              <datalist id="vision-models">
                {(providers.find((provider) => provider.id === visionProviderId)?.models || []).map((model) => <option key={model} value={model} />)}
              </datalist>
              <div className="modal-actions" style={{ marginTop: 12 }}>
                <button className="primary full" onClick={() => void saveVisionConfig()}><Check size={14} /> Save vision config</button>
              </div>
              {!!visionNote && <div className="settings-note" style={{ marginTop: 8 }}><Check size={12} /><span>{visionNote}</span></div>}
            </div>

            <div className="setting-card" style={{ marginTop: 12 }}>
              <div className="setting-row">
                <span className="setting-icon"><Settings2 size={14} /></span>
                <div className="setting-text">
                  <strong>Evidence reranking</strong>
                  <small>Optionally ask a configured chat model to judge which retrieved passages best answer each question. This adds latency and model cost.</small>
                </div>
              </div>
              <label className="toggle-row" style={{ marginTop: 10 }}>
                <input type="checkbox" checked={rerankEnabled} onChange={(e) => setRerankEnabled(e.target.checked)} />
                <span>Enable model-based reranking</span>
              </label>
              <label className="field-label" style={{ marginTop: 10 }}>Reranker provider</label>
              <select className="select-field" value={rerankProviderId} onChange={(e) => { setRerankProviderId(e.target.value); setRerankModel(""); }} disabled={!rerankEnabled}>
                <option value="">Use first configured provider</option>
                {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}
              </select>
              <label className="field-label" style={{ marginTop: 10 }}>Reranker model</label>
              <input
                className="text-field"
                value={rerankModel}
                onChange={(e) => setRerankModel(e.target.value)}
                list="reranker-models"
                placeholder="Use provider default model"
                disabled={!rerankEnabled}
              />
              <datalist id="reranker-models">
                {(providers.find((provider) => provider.id === rerankProviderId)?.models || []).map((model) => <option key={model} value={model} />)}
              </datalist>
              <div className="modal-actions" style={{ marginTop: 12 }}>
                <button className="primary full" onClick={() => void saveRerankConfig()}><Check size={14} /> Save reranking config</button>
              </div>
              {!!rerankNote && <div className="settings-note" style={{ marginTop: 8 }}><Check size={12} /><span>{rerankNote}</span></div>}
            </div>

            <div className="setting-card" style={{ marginTop: 12 }}>
              <div className="pane-top" style={{ padding: "0 0 8px 0" }}>
                <span>CUSTOM EMBEDDING PROVIDERS</span>
                <div style={{ display: "flex", gap: 4 }}>
                  <button className="secondary" style={{ padding: "4px 7px", fontSize: 9 }} onClick={useOpenRouterEmbeddingPreset} title="Use the OpenRouter embedding preset">OpenRouter preset</button>
                  <button className="secondary" style={{ padding: "4px 7px", fontSize: 9 }} onClick={useMistralEmbeddingPreset} title="Use the Mistral embedding preset">Mistral preset</button>
                  <button className="pane-action" onClick={resetEmbForm} title="Add new embedding provider"><Plus size={14} /></button>
                </div>
              </div>
              {embProviders.map((provider) => (
                <div className={`provider-card ${embForm.id === provider.id ? "active" : ""}`} key={provider.id}>
                  <div className="provider-card-main" onClick={() => handleEditEmb(provider)} style={{ cursor: "pointer" }}>
                    <span className="provider-logo">{provider.name.slice(0, 1).toUpperCase()}</span>
                    <div>
                      <strong>{provider.name}</strong>
                      <small>{EMB_KINDS.find((k) => k.id === provider.kind)?.label || provider.kind} · {provider.models.length} models · {provider.apiKey ? "key configured" : "no key"}</small>
                    </div>
                  </div>
                  <div className="provider-card-actions">
                    <button onClick={() => handleEditEmb(provider)} title="Edit"><Settings2 size={13} /></button>
                    <button className="danger" onClick={() => void handleDeleteEmb(provider.id)} title="Delete"><Trash2 size={13} /></button>
                  </div>
                </div>
              ))}
              {!embProviders.length && (
                <div className="empty-provider">
                  <BookOpen size={18} />
                  <p>No custom embedding providers. Add one below — e.g. a local TEI/vLLM/LM Studio server.</p>
                </div>
              )}

              <div className="form-title" style={{ marginTop: 12 }}>
                <span>{isEditingEmb ? `Edit ${embForm.name || "provider"}` : "Add embedding provider"}</span>
                <small>{isEditingEmb ? "Editing endpoint" : "Own base URL, key and models"}</small>
              </div>
              <label>
                Display name
                <input value={embForm.name} onChange={(e) => setEmbForm((prev) => ({ ...prev, name: e.target.value }))} placeholder="My embedding server" />
              </label>
              <label>
                Endpoint type
                <select value={embForm.kind} onChange={(e) => setEmbForm((prev) => ({ ...prev, kind: e.target.value as EmbeddingEndpointKind }))}>
                  {EMB_KINDS.map((k) => (
                    <option key={k.id} value={k.id}>{k.label}</option>
                  ))}
                </select>
              </label>
              {embKindMeta.showBase && (
                <label>
                  Base URL {embForm.kind === "openai" ? <small>blank = api.openai.com</small> : null}
                  <input value={embForm.baseUrl} onChange={(e) => setEmbForm((prev) => ({ ...prev, baseUrl: e.target.value }))} placeholder={embKindMeta.basePlaceholder} />
                </label>
              )}
              <label>
                API key
                <input
                  type="password"
                  value={embForm.apiKey}
                  onChange={(e) => setEmbForm((prev) => ({ ...prev, apiKey: e.target.value }))}
                  placeholder={embKindMeta.keyHint}
                />
              </label>
              <label style={{ marginBottom: "4px" }}>
                Models ({embForm.models.length}) <small>each embedding model separately</small>
              </label>
              <div className="model-list-editor">
                {embForm.models.map((model, idx) => (
                  <div className="model-row-item" key={idx}>
                    <input
                      value={model}
                      onChange={(e) => setEmbForm((prev) => {
                        const next = [...prev.models];
                        next[idx] = e.target.value;
                        return { ...prev, models: next };
                      })}
                      placeholder={embKindMeta.modelPlaceholder}
                    />
                    <button type="button" onClick={() => setEmbForm((prev) => ({ ...prev, models: prev.models.filter((_, i) => i !== idx) }))} title="Remove model">
                      <X size={13} />
                    </button>
                  </div>
                ))}
                {!embForm.models.length && (
                  <div style={{ color: "#6e7c8e", fontSize: "10.5px", padding: "4px 0" }}>
                    No models yet — add one below.
                  </div>
                )}
              </div>
              <div className="model-add-bar">
                <input
                  value={newEmbModel}
                  onChange={(e) => setNewEmbModel(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      const raw = newEmbModel.trim();
                      if (raw) setEmbForm((prev) => ({ ...prev, models: Array.from(new Set([...prev.models, ...raw.split(/[,\n]+/).map((s) => s.trim()).filter(Boolean)])) }));
                      setNewEmbModel("");
                    }
                  }}
                  placeholder={embKindMeta.modelPlaceholder}
                />
                <button
                  type="button"
                  className="secondary"
                  disabled={!newEmbModel.trim()}
                  onClick={() => {
                    const raw = newEmbModel.trim();
                    if (raw) setEmbForm((prev) => ({ ...prev, models: Array.from(new Set([...prev.models, ...raw.split(/[,\n]+/).map((s) => s.trim()).filter(Boolean)])) }));
                    setNewEmbModel("");
                  }}
                >
                  <Plus size={13} /> Add
                </button>
              </div>
              <div className="provider-fetch">
                <button
                  className="secondary"
                  disabled={testingEmb || !newEmbModel.trim() && !embForm.models[0]}
                  onClick={() => void testEndpoint(embForm.id, embForm.kind, embForm.baseUrl, embForm.apiKey, newEmbModel.trim() || embForm.models[0] || "")}
                >
                  {testingEmb ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />} Test connection
                </button>
              </div>
              {embTestNote && <div style={{ margin: "6px 0", color: "var(--green)", fontSize: "11px" }}>{embTestNote}</div>}
              {embTestError && <div style={{ margin: "6px 0", color: "var(--red)", fontSize: "11px" }}>{embTestError}</div>}
              <div className="modal-actions" style={{ marginTop: "16px" }}>
                {isEditingEmb && <button className="secondary" onClick={resetEmbForm}>Cancel edit</button>}
                <button className="primary full" disabled={!embForm.name.trim()} onClick={() => void handleSaveEmb()}>
                  <Check size={14} /> {isEditingEmb ? "Save changes" : "Add embedding provider"}
                </button>
              </div>
            </div>

            <div className="setting-card" style={{ marginTop: 12 }}>
              <div className="setting-row">
                <div className="setting-text">
                  <strong>Pipeline</strong>
                  <small>semantic (vector) + lexical (BM25) + graph (entity expansion) → RRF fusion → rerank → grounded answer with citations → LLM self-evaluation with one retry.</small>
                </div>
              </div>
            </div>
            </>
          )}

          {section === "mcp" && (
            <McpManager />
          )}

          {section === "skills" && (
            <SkillsManager hasProject={hasProject} enabled={skillsEnabled} onToggle={onToggleSkills} />
          )}

          {section === "services" && (
            <div className="setting-card">
              <button className="setting-nav-row" onClick={onManageServices}>
                <span className="setting-icon"><Terminal size={14} /></span>
                <span className="setting-text">
                  <strong>Background services</strong>
                  <small>Dev servers and daemons need their live logs view — open it</small>
                </span>
                <ChevronRight size={14} />
              </button>
            </div>
          )}

          {section === "updates" && (
            <div className="setting-card">
              <div className="setting-row">
                <span className="setting-icon"><Download size={14} /></span>
                <div className="setting-text">
                  <strong>App updates</strong>
                  <small>Checked automatically on launch. Installs on restart.</small>
                </div>
              </div>
              <div style={{ marginTop: "10px" }}>
                <MemoryRow label="Installed version" value={appVersion ? `v${appVersion}` : "…"} />
                {updater.status === "checking" && (
                  <MemoryRow label="Status" value="Checking for updates…" />
                )}
                {(updater.status === "idle" || updater.status === "up-to-date") && (
                  <MemoryRow
                    label="Status"
                    value={updater.status === "up-to-date" ? "You're on the latest version" : "Not checked yet"}
                  />
                )}
                {updater.status === "available" && (
                  <MemoryRow label="Status" value={`v${updater.version} found — downloading…`} />
                )}
                {updater.status === "downloading" && (
                  <MemoryRow label="Status" value={`Downloading v${updater.version}… ${updater.percent}%`} />
                )}
                {updater.status === "downloaded" && (
                  <MemoryRow label="Status" value={`v${updater.version} ready to install`} />
                )}
                {updater.status === "error" && (
                  <MemoryRow label="Status" value={`Check failed: ${updater.message}`} />
                )}
              </div>
              <div className="modal-actions" style={{ marginTop: "12px" }}>
                {updater.status === "downloaded" ? (
                  <button className="primary full" onClick={onQuitAndInstall}>
                    <Check size={14} /> Restart to install v{updater.version}
                  </button>
                ) : (
                  <button
                    className="secondary full"
                    disabled={updater.status === "checking" || updater.status === "downloading"}
                    onClick={onCheckUpdates}
                  >
                    {updater.status === "checking" || updater.status === "downloading" ? (
                      <Loader2 size={13} className="spin" />
                    ) : (
                      <RefreshCw size={13} />
                    )}
                    {updater.status === "checking" || updater.status === "downloading" ? "Working…" : "Check for updates"}
                  </button>
                )}
              </div>
              <div className="settings-note" style={{ marginTop: "10px" }}>
                <Download size={12} />
                <span>Auto-update covers the installed app. Portable builds must be re-downloaded manually.</span>
              </div>
            </div>
          )}

          {section === "workspace" && area === "home" && (
            <div className="setting-card">
              <button className="setting-nav-row" onClick={() => void api.openHomeFolder()}>
                <span className="setting-icon"><FolderOpen size={14} /></span>
                <span className="setting-text">
                  <strong>Nexus folder</strong>
                  <small>Where Home documents land — open it in your file manager</small>
                </span>
                <ChevronRight size={14} />
              </button>
            </div>
          )}
        </section>
      </div>
    </Modal>
  );
}
