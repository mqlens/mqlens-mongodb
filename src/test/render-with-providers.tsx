import React, { useEffect, useMemo, useState } from "react";
import { render, type RenderOptions } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { applyTheme } from "@/lib/themes/apply-theme";
import { DEFAULT_THEME_CONFIG, type ThemeConfig } from "@/lib/themes/schema";
import { THEME_PRESETS } from "@/lib/themes/presets";
import type { ThemeContextValue } from "@/components/theme/theme-context";
import { ThemeContext } from "@/components/theme/theme-context";

function TestThemeProvider({
  children,
  config = DEFAULT_THEME_CONFIG,
}: {
  children: React.ReactNode;
  config?: ThemeConfig;
}) {
  const [themeConfig, setThemeConfig] = useState(config);
  const [resolvedMode, setResolvedMode] = useState<"dark" | "light">("dark");

  useEffect(() => {
    setResolvedMode(applyTheme(themeConfig));
  }, [themeConfig]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      config: themeConfig,
      resolvedMode,
      presets: THEME_PRESETS,
      setPreset: (presetId) =>
        setThemeConfig((prev) => ({ ...prev, presetId })),
      setMode: (mode) => setThemeConfig((prev) => ({ ...prev, mode })),
      setFontSize: (fontSize) =>
        setThemeConfig((prev) => ({ ...prev, fontSize })),
      setUiZoom: (uiZoom) =>
        setThemeConfig((prev) => ({ ...prev, uiZoom })),
      zoomIn: () => {},
      zoomOut: () => {},
      resetZoom: () => {},
      setSpacingDensity: (spacingDensity) =>
        setThemeConfig((prev) => ({ ...prev, spacingDensity })),
      setFontSans: (sans) =>
        setThemeConfig((prev) => ({ ...prev, fonts: { ...prev.fonts, sans } })),
      setFontMono: (mono) =>
        setThemeConfig((prev) => ({ ...prev, fonts: { ...prev.fonts, mono } })),
      setOverride: (token, value) =>
        setThemeConfig((prev) => ({
          ...prev,
          overrides: { ...prev.overrides, [token]: value },
        })),
      clearOverrides: () =>
        setThemeConfig((prev) => ({ ...prev, overrides: {} })),
      updateConfig: (partial) =>
        setThemeConfig((prev) => ({ ...prev, ...partial })),
      exportTheme: () => JSON.stringify(themeConfig),
      importTheme: (json) => setThemeConfig(JSON.parse(json)),
      saveAppearance: async () => {},
    }),
    [themeConfig, resolvedMode]
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

function AllProviders({ children }: { children: React.ReactNode }) {
  return (
    <TestThemeProvider>
      <TooltipProvider>{children}</TooltipProvider>
    </TestThemeProvider>
  );
}

export function renderWithProviders(
  ui: React.ReactElement,
  options?: Omit<RenderOptions, "wrapper">
) {
  return render(ui, { wrapper: AllProviders, ...options });
}
