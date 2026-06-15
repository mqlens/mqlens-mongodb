import { createContext } from "react";
import type { ThemeConfig, ThemeMode, SpacingDensity } from "@/lib/themes/schema";
import type { THEME_PRESETS } from "@/lib/themes/presets";

export interface ThemeContextValue {
  config: ThemeConfig;
  resolvedMode: "dark" | "light";
  presets: typeof THEME_PRESETS;
  setPreset: (presetId: string) => void;
  setMode: (mode: ThemeMode) => void;
  setFontSize: (size: number) => void;
  setUiZoom: (zoom: number) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
  setSpacingDensity: (density: SpacingDensity) => void;
  setFontSans: (font: string) => void;
  setFontMono: (font: string) => void;
  setOverride: (token: string, value: string) => void;
  clearOverrides: () => void;
  updateConfig: (partial: Partial<ThemeConfig>) => void;
  exportTheme: () => string;
  importTheme: (json: string) => void;
  saveAppearance: () => Promise<void>;
}

export const ThemeContext = createContext<ThemeContextValue | null>(null);
