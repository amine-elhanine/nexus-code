export type AppTheme = {
  id: string;
  name: string;
  description: string;
  /** 3-4 swatches shown in the picker (bg, panel, accent, accent2) */
  swatches: string[];
  /** accent used for active dots / preview glow */
  accent: string;
};

export const APP_THEMES: AppTheme[] = [
  {
    id: "nexus",
    name: "Nexus Emerald",
    description: "Default dark theme with emerald accents.",
    swatches: ["#080a0f", "#0d1219", "#34d399", "#3ee695"],
    accent: "#34d399",
  },
  {
    id: "midnight",
    name: "Midnight Ocean",
    description: "Deep navy blues with a bright sky accent.",
    swatches: ["#060b16", "#0c1526", "#60a5fa", "#38bdf8"],
    accent: "#60a5fa",
  },
  {
    id: "grape",
    name: "Grape Nebula",
    description: "Dark violet base with purple / magenta glow.",
    swatches: ["#0d0a16", "#151125", "#a78bfa", "#e879f9"],
    accent: "#a78bfa",
  },
  {
    id: "ember",
    name: "Ember Sunset",
    description: "Warm charcoal with orange / amber highlights.",
    swatches: ["#100a07", "#1a120c", "#fb923c", "#fbbf24"],
    accent: "#fb923c",
  },
  {
    id: "crimson",
    name: "Crimson Rose",
    description: "Near-black red tint with rose / pink energy.",
    swatches: ["#11090d", "#1c1118", "#fb7185", "#f43f5e"],
    accent: "#fb7185",
  },
  {
    id: "lagoon",
    name: "Lagoon Teal",
    description: "Dark teal waters with mint / cyan freshness.",
    swatches: ["#061110", "#0b1b1a", "#2dd4bf", "#5eead4"],
    accent: "#2dd4bf",
  },
  {
    id: "moss",
    name: "Moss Citrus",
    description: "Olive-tinted dark with lime / chartreuse pop.",
    swatches: ["#0a0f06", "#131a0c", "#a3e635", "#4ade80"],
    accent: "#a3e635",
  },
  {
    id: "alabaster",
    name: "Warm Alabaster",
    description: "Soothing warm parchment & antique paper with terracotta accents.",
    swatches: ["#ede5d8", "#e2d7c5", "#d9530f", "#ea580c"],
    accent: "#d9530f",
  },
  {
    id: "daylight",
    name: "Daylight Paper",
    description: "Calm unbleached reading paper with deep forest emerald accents.",
    swatches: ["#e9e4d8", "#ddd8cb", "#047857", "#059669"],
    accent: "#047857",
  },
];

export const DEFAULT_THEME_ID = "nexus";
export const THEME_STORAGE_KEY = "nexus-theme";

export function isValidThemeId(id: unknown): id is string {
  return typeof id === "string" && APP_THEMES.some((t) => t.id === id);
}

export function getStoredThemeId(): string {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (isValidThemeId(raw)) return raw;
  } catch {
    /* ignore */
  }
  return DEFAULT_THEME_ID;
}

/** Apply a theme immediately by setting data-theme on <html>. Persists to localStorage. */
export function applyTheme(themeId: string): string {
  const id = isValidThemeId(themeId) ? themeId : DEFAULT_THEME_ID;
  document.documentElement.dataset.theme = id;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, id);
  } catch {
    /* ignore */
  }
  return id;
}
