// Neural image generation for Home mode (Phase 3.2): `generate_image` calls
// the user's configured OpenAI (gpt-image-1 / dall-e-3) or Google Gemini
// (imagen) endpoint and saves the PNG/JPEG into the Home workspace, where the
// artifact contract, fresh-file detection and the deliverable pipeline pick
// it up — and where create_deliverable markdown image lines can embed it
// into decks/reports by path (convert to a data URI) or the chat can embed it
// directly as a markdown image.
import { promises as fsPromises } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { tool, type AgentTool } from "./agentcore/tools.js";
import type { ProviderConfig } from "./store.js";

export type ImageGenBackend = "openai" | "google";

const OPENAI_MODELS = ["gpt-image-1", "dall-e-3"];
const GOOGLE_MODELS = ["imagen-3.0-generate-002"];

/** Resolves the image-generation backend from the run's provider config. */
export function resolveImageGenBackend(provider: ProviderConfig): { backend: ImageGenBackend; base: string; apiKey: string } | null {
  const key = provider.apiKey || process.env[provider.provider === "openai" ? "OPENAI_API_KEY" : "GOOGLE_API_KEY"] || "";
  if (provider.provider === "openai") {
    const base = (provider.baseUrl || "https://api.openai.com/v1").trim().replace(/\/+$/, "");
    return key ? { backend: "openai", base, apiKey: key } : null;
  }
  if (provider.provider === "google") {
    return key ? { backend: "google", base: "https://generativelanguage.googleapis.com/v1beta", apiKey: key } : null;
  }
  return null;
}

function sanitizeImageFileName(raw: string): string {
  let name = String(raw || "").replace(/\\/g, "/").split("/").pop() || "";
  name = name.replace(/[<>:"|?*\0]/g, "").replace(/\s+/g, "-").trim().slice(0, 100);
  if (!name) name = `image-${Date.now()}`;
  if (!/\.(png|jpe?g)$/i.test(name)) name = `${name}.png`;
  return name;
}

/** Calls the image API and returns the image bytes. */
export async function generateImageBytes(
  backend: ImageGenBackend,
  opts: { base: string; apiKey: string; model?: string; prompt: string; size?: string }
): Promise<{ bytes: Buffer; mimeType: string }> {
  if (backend === "openai") {
    const model = opts.model && OPENAI_MODELS.includes(opts.model) ? opts.model : "gpt-image-1";
    const body: Record<string, unknown> = { model, prompt: opts.prompt.slice(0, 4000), n: 1 };
    // dall-e-3 rejects gpt-image-1 sizes; gpt-image-1 rejects dall-e-3's. Keep
    // to the safe common set; omit entirely when the caller passed nothing.
    if (opts.size && /^\d{3,4}x\d{3,4}$/.test(opts.size)) body.size = opts.size;
    const response = await fetch(`${opts.base}/images/generations`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`image API HTTP ${response.status}: ${detail.slice(0, 200)}`);
    }
    const payload = (await response.json()) as { data?: Array<{ b64_json?: string; url?: string }> };
    const entry = payload.data?.[0];
    if (entry?.b64_json) return { bytes: Buffer.from(entry.b64_json, "base64"), mimeType: "image/png" };
    if (entry?.url) {
      const imageRes = await fetch(entry.url, { signal: AbortSignal.timeout(60_000) });
      if (!imageRes.ok) throw new Error(`image download failed: HTTP ${imageRes.status}`);
      const bytes = Buffer.from(await imageRes.arrayBuffer());
      const type = (imageRes.headers.get("content-type") || "image/png").split(";")[0];
      return { bytes, mimeType: type };
    }
    throw new Error("image API returned no image data");
  }
  // Google Imagen: predict on models/<model>:predict.
  const model = opts.model && GOOGLE_MODELS.includes(opts.model) ? opts.model : GOOGLE_MODELS[0];
  const response = await fetch(`${opts.base}/models/${model}:predict`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": opts.apiKey },
    body: JSON.stringify({ instances: [{ prompt: opts.prompt.slice(0, 4000) }], parameters: { sampleCount: 1 } }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`imagen HTTP ${response.status}: ${detail.slice(0, 200)}`);
  }
  const payload = (await response.json()) as { predictions?: Array<{ bytesBase64Encoded?: string; mimeType?: string }> };
  const prediction = payload.predictions?.[0];
  if (!prediction?.bytesBase64Encoded) throw new Error("imagen returned no image data");
  return { bytes: Buffer.from(prediction.bytesBase64Encoded, "base64"), mimeType: prediction.mimeType || "image/png" };
}

export function createImageGenTool(options: {
  projectRoot: string;
  provider: ProviderConfig;
  beforeEdit?: (info: { tool: string; files: string[] }) => Promise<string | null>;
}): AgentTool | null {
  const backend = resolveImageGenBackend(options.provider);
  if (!backend) return null;

  return tool(
    async ({ file_name, prompt, size }: { file_name: string; prompt: string; size?: string }) => {
      if (options.beforeEdit) {
        const denial = await options.beforeEdit({ tool: "generate_image", files: [file_name] });
        if (denial) return denial;
      }
      const fileName = sanitizeImageFileName(file_name);
      const { bytes, mimeType } = await generateImageBytes(backend.backend, {
        ...backend,
        prompt,
        size,
      });
      const abs = path.join(options.projectRoot, fileName);
      await fsPromises.writeFile(abs, bytes);
      const ext = mimeType.includes("jpeg") ? ".jpg" : ".png";
      const finalPath = ext === ".jpg" && !/\.jpe?g$/i.test(fileName) ? fileName.replace(/\.(png)?$/i, ".jpg") : fileName;
      if (finalPath !== fileName) {
        await fsPromises.rename(abs, path.join(options.projectRoot, finalPath)).catch(() => undefined);
      }
      return `Image generated and saved: ${finalPath} (${(bytes.length / 1024).toFixed(0)} KB, ${mimeType}). Embed it in chat with ![image](${finalPath}) or reference the path in deliverable content — create_deliverable pptx/pdf content can inline it via ![alt](${finalPath}) when the renderer supports local files, otherwise mention the path.`;
    },
    {
      name: "generate_image",
      description: "Generate a custom illustration/diagram image from a text prompt using the configured image model (OpenAI gpt-image-1 or Google Imagen) and save it into the workspace as a PNG. Use for visuals that genuinely need to be CREATED (custom diagrams, illustrations matching the request) — prefer web_image_search for photographs of real-world subjects. The saved path can be embedded directly in chat responses as a markdown image.",
      schema: z.object({
        file_name: z.string().min(1).max(120).describe("Output file name, e.g. 'system-architecture.png'."),
        prompt: z.string().min(1).max(4000).describe("Detailed image description: subject, style, composition, colors. Be specific."),
        size: z.string().optional().describe('Image size as WIDTHxHEIGHT (e.g. "1024x1024", "1536x1024"). Optional.'),
      }),
    }
  );
}
