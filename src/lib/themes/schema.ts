export type ThemeMode = "dark" | "light" | "system";
export type SpacingDensity = "compact" | "cozy" | "roomy";

export const TOKEN_NAMES = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "destructive-foreground",
  "border",
  "input",
  "ring",
  "success",
  "warning",
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
  "sidebar-background",
  "sidebar-foreground",
  "sidebar-primary",
  "sidebar-primary-foreground",
  "sidebar-accent",
  "sidebar-accent-foreground",
  "sidebar-border",
  "sidebar-ring",
  "syntax-key",
  "syntax-string",
  "syntax-number",
  "syntax-boolean",
  "syntax-null",
] as const;

export type TokenName = (typeof TOKEN_NAMES)[number];

export interface ThemeConfig {
  presetId: string;
  mode: ThemeMode;
  overrides: Partial<Record<TokenName, string>>;
  fonts: {
    sans: string;
    mono: string;
  };
  fontSize: number;
  spacingDensity: SpacingDensity;
  /** User zoom multiplier (Cmd+/Cmd-), applied on top of auto DPI scale. */
  uiZoom: number;
}

export interface ThemePreset {
  id: string;
  name: string;
  description: string;
  mode: "dark" | "light";
  tokens: Record<TokenName, string>;
}

export const DEFAULT_THEME_CONFIG: ThemeConfig = {
  presetId: "mqlens-dark",
  mode: "dark",
  overrides: {},
  fonts: {
    sans: "Inter",
    mono: "JetBrains Mono",
  },
  fontSize: 13,
  spacingDensity: "cozy",
  uiZoom: 1,
};

export interface AppearanceSettings {
  preset_id: string;
  mode: string;
  overrides: Record<string, string>;
  font_sans: string;
  font_mono: string;
  font_size: number;
  spacing_density: string;
  ui_zoom?: number;
}

export function themeConfigToAppearance(config: ThemeConfig): AppearanceSettings {
  return {
    preset_id: config.presetId,
    mode: config.mode,
    overrides: config.overrides as Record<string, string>,
    font_sans: config.fonts.sans,
    font_mono: config.fonts.mono,
    font_size: config.fontSize,
    spacing_density: config.spacingDensity,
    ui_zoom: config.uiZoom,
  };
}

export function appearanceToThemeConfig(
  appearance: AppearanceSettings | undefined | null
): ThemeConfig {
  if (!appearance || !appearance.preset_id) {
    return DEFAULT_THEME_CONFIG;
  }
  return {
    presetId: appearance.preset_id,
    mode: (appearance.mode as ThemeMode) || "dark",
    overrides: appearance.overrides || {},
    fonts: {
      sans: appearance.font_sans || "Inter",
      mono: appearance.font_mono || "JetBrains Mono",
    },
    fontSize: appearance.font_size || 13,
    spacingDensity: (appearance.spacing_density as SpacingDensity) || "cozy",
    uiZoom:
      typeof appearance.ui_zoom === "number" && !Number.isNaN(appearance.ui_zoom)
        ? appearance.ui_zoom
        : 1,
  };
}

export const APPEARANCE_CACHE_KEY = "mqlens-appearance";

export function readAppearanceCache(): ThemeConfig | null {
  try {
    const raw = localStorage.getItem(APPEARANCE_CACHE_KEY);
    if (!raw) return null;
    const appearance = JSON.parse(raw) as AppearanceSettings;
    if (!appearance?.preset_id) return null;
    return appearanceToThemeConfig(appearance);
  } catch {
    return null;
  }
}

export function writeAppearanceCache(config: ThemeConfig): void {
  try {
    localStorage.setItem(
      APPEARANCE_CACHE_KEY,
      JSON.stringify(themeConfigToAppearance(config))
    );
  } catch {
    /* private mode / quota */
  }
}

export function migrateLegacyTheme(): ThemeConfig {
  const legacyTheme = localStorage.getItem("mqlens-theme");
  const legacyDensity = localStorage.getItem("mqlens-density") as SpacingDensity | null;
  return {
    ...DEFAULT_THEME_CONFIG,
    presetId: legacyTheme === "light" ? "mqlens-light" : "mqlens-dark",
    mode: legacyTheme === "light" ? "light" : "dark",
    spacingDensity: legacyDensity || "cozy",
  };
}

/** Best available theme before encrypted settings can be read (vault locked). */
export function readInitialThemeConfig(): ThemeConfig {
  return readAppearanceCache() ?? migrateLegacyTheme();
}
