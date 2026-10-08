/** Prompt components that can be omitted in controlled agent evaluations. */
export const AGENT_PROMPT_ASSETS = ["skills", "rules", "agents", "commands"] as const;
export type AgentPromptAsset = (typeof AGENT_PROMPT_ASSETS)[number];

export function parseDisabledPromptAssets(value: unknown): AgentPromptAsset[] {
  if (value === undefined || value === null || value === "") return [];
  const parts = Array.isArray(value) ? value : String(value).split(",");
  const selected = new Set<AgentPromptAsset>();
  for (const part of parts) {
    const name = String(part).trim().toLowerCase();
    if (!name) continue;
    if (!(AGENT_PROMPT_ASSETS as readonly string[]).includes(name)) {
      throw new Error(`Unknown prompt asset "${name}". Choose from: ${AGENT_PROMPT_ASSETS.join(", ")}.`);
    }
    selected.add(name as AgentPromptAsset);
  }
  return [...selected];
}
