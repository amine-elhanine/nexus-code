import React, { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, TriangleAlert } from "lucide-react";
import { Modal } from "../common/Modal.js";

/**
 * Sandboxed host for a plugin UI file.
 *
 * The HTML comes from the main process (exact manifest `ui[].entry` match,
 * containment + type + size checked there) and is mounted via `srcDoc` in
 * an iframe with `sandbox="allow-scripts"` only: no same-origin, no
 * top-navigation, no forms, no plugins. Scripts run with an opaque origin.
 *
 * The only capability exposed to the frame is `window.nexusPlugin`:
 * `{ callTool(tool, args), close(), log(message) }` over postMessage.
 * Messages are accepted solely from this frame's contentWindow and only
 * with `data.source === "nexus-plugin"`.
 */
const BRIDGE_SHIM = `<script>
window.nexusPlugin = (function () {
  var seq = 0;
  var pending = {};
  window.addEventListener("message", function (event) {
    var m = event.data;
    if (!m || m.source !== "nexus-host" || m.type !== "tool-result") return;
    var resolve = pending[m.id];
    if (resolve) {
      delete pending[m.id];
      resolve({ ok: m.ok, result: m.result, error: m.error, code: m.code });
    }
  });
  return {
    callTool: function (tool, args) {
      return new Promise(function (resolve) {
        var id = ++seq;
        pending[id] = resolve;
        window.parent.postMessage(
          { source: "nexus-plugin", type: "call-tool", id: id, tool: String(tool || ""), args: args || {} },
          "*"
        );
        setTimeout(function () {
          if (pending[id]) {
            delete pending[id];
            resolve({ ok: false, error: "Bridge timeout waiting for host.", code: "timeout" });
          }
        }, 30000);
      });
    },
    close: function () {
      window.parent.postMessage({ source: "nexus-plugin", type: "close" }, "*");
    },
    log: function (message) {
      window.parent.postMessage({ source: "nexus-plugin", type: "log", message: String(message).slice(0, 2000) }, "*");
    },
  };
})();
</script>`;

export function PluginUiModal({
  pluginId,
  entry,
  title,
  mode,
  onClose,
}: {
  pluginId: string;
  entry: string;
  title: string;
  /** Agent-area mode reported to tools (affects mode-gated tools). */
  mode: string;
  onClose: () => void;
}) {
  const api = window.nexus;
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [slot, setSlot] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    setError(null);
    api
      .readPluginUi({ pluginId, entry })
      .then((doc) => {
        if (!cancelled) {
          setSlot(doc.slot);
          setHtml(doc.html);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load plugin UI.");
      });
    return () => {
      cancelled = true;
    };
  }, [api, pluginId, entry]);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const frame = frameRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      const data = event.data as { source?: unknown; type?: unknown; id?: unknown; tool?: unknown; args?: unknown; message?: unknown } | null;
      if (!data || data.source !== "nexus-plugin") return;
      if (data.type === "close") {
        onClose();
        return;
      }
      if (data.type === "log") {
        console.info(`[plugin:${pluginId}]`, String(data.message || ""));
        return;
      }
      if (data.type === "call-tool") {
        const id = typeof data.id === "number" ? data.id : 0;
        const tool = typeof data.tool === "string" ? data.tool : "";
        const args = data.args && typeof data.args === "object" && !Array.isArray(data.args)
          ? (data.args as Record<string, unknown>)
          : {};
        void api
          .callPluginTool({ pluginId, tool, args, mode })
          .then((result) => {
            frame.contentWindow?.postMessage(
              { source: "nexus-host", type: "tool-result", id, ok: result.ok, result: result.result, error: result.error, code: result.code },
              "*"
            );
          })
          .catch((err: unknown) => {
            frame.contentWindow?.postMessage(
              { source: "nexus-host", type: "tool-result", id, ok: false, error: err instanceof Error ? err.message : "Tool call failed." },
              "*"
            );
          });
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [api, pluginId, mode, onClose]);

  const srcDoc = useMemo(() => (html === null ? undefined : `${BRIDGE_SHIM}${html}`), [html]);

  return (
    <Modal title={title} subtitle={`Plugin UI · ${pluginId}${slot ? ` · ${slot}` : ""}`} onClose={onClose} wide>
      {error && (
        <div className="market-notice-banner error" style={{ margin: 12 }}>
          <TriangleAlert size={15} style={{ flex: "none" }} />
          <div style={{ flex: 1 }}>{error}</div>
        </div>
      )}
      {!error && html === null && (
        <div className="empty-pane" style={{ display: "flex", gap: 8, alignItems: "center", padding: 24 }}>
          <Loader2 size={14} className="spin" /> Loading plugin UI…
        </div>
      )}
      {!error && srcDoc !== undefined && (
        <iframe
          ref={frameRef}
          title={title}
          sandbox="allow-scripts"
          srcDoc={srcDoc}
          style={{ width: "100%", height: "min(62vh, 560px)", border: "0", borderRadius: "0 0 8px 8px", background: "#0b0f16" }}
        />
      )}
    </Modal>
  );
}
