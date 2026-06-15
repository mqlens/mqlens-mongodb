import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  applyTheme,
  applyResponsiveScale,
  exportThemeJson,
  importThemeJson,
} from "@/lib/themes/apply-theme";
import {
  appearanceToThemeConfig,
  readInitialThemeConfig,
  themeConfigToAppearance,
  writeAppearanceCache,
  type ThemeConfig,
} from "@/lib/themes/schema";
import {
  stepUiZoom,
  UI_ZOOM_DEFAULT,
} from "@/lib/themes/ui-scale";
import { THEME_PRESETS } from "@/lib/themes/presets";
import { VAULT_UNLOCKED_EVENT } from "@/lib/vault";
import { ThemeContext, type ThemeContextValue } from "./theme-context";

export type { ThemeContextValue };

interface AppSettingsWithAppearance {
  appearance?: {
    preset_id: string;
    mode: string;
    overrides: Record<string, string>;
    font_sans: string;
    font_mono: string;
    font_size: number;
    spacing_density: string;
    ui_zoom?: number;
  };
}

async function loadAppearanceFromSettings(): Promise<ThemeConfig | null> {
  const settings = await invoke<AppSettingsWithAppearance>("load_app_settings");
  if (!settings.appearance?.preset_id) return null;
  return appearanceToThemeConfig(settings.appearance);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [config, setConfig] = useState<ThemeConfig>(readInitialThemeConfig);
  const [resolvedMode, setResolvedMode] = useState<"dark" | "light">("dark");
  const skipAutoSaveRef = useRef(true);
  const hydrationDoneRef = useRef(false);

  const applyLoadedConfig = useCallback((next: ThemeConfig) => {
    skipAutoSaveRef.current = true;
    setConfig(next);
    writeAppearanceCache(next);
  }, []);

  const reloadFromEncryptedSettings = useCallback(async () => {
    try {
      const next = await loadAppearanceFromSettings();
      if (next) applyLoadedConfig(next);
    } catch {
      /* vault still locked or settings unavailable */
    } finally {
      hydrationDoneRef.current = true;
    }
  }, [applyLoadedConfig]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const next = await loadAppearanceFromSettings();
        if (cancelled) return;
        if (next) {
          applyLoadedConfig(next);
        }
      } catch {
        /* use cached / legacy config already in state */
      } finally {
        if (!cancelled) hydrationDoneRef.current = true;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applyLoadedConfig]);

  useEffect(() => {
    const onVaultUnlocked = () => {
      reloadFromEncryptedSettings();
    };
    window.addEventListener(VAULT_UNLOCKED_EVENT, onVaultUnlocked);
    return () => window.removeEventListener(VAULT_UNLOCKED_EVENT, onVaultUnlocked);
  }, [reloadFromEncryptedSettings]);

  useEffect(() => {
    const mode = applyTheme(config);
    setResolvedMode(mode);
  }, [config]);

  const updateConfig = useCallback((partial: Partial<ThemeConfig>) => {
    setConfig((prev) => ({ ...prev, ...partial }));
  }, []);

  const zoomIn = useCallback(() => {
    setConfig((prev) => ({ ...prev, uiZoom: stepUiZoom(prev.uiZoom, 1) }));
  }, []);

  const zoomOut = useCallback(() => {
    setConfig((prev) => ({ ...prev, uiZoom: stepUiZoom(prev.uiZoom, -1) }));
  }, []);

  const resetZoom = useCallback(() => {
    updateConfig({ uiZoom: UI_ZOOM_DEFAULT });
  }, [updateConfig]);

  // Cmd/Ctrl + / - / 0 — UI zoom (DPI scale)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;

      const key = e.key;
      const isZoomIn = key === "=" || key === "+";
      const isZoomOut = key === "-" || key === "_";
      const isReset = key === "0";
      if (!isZoomIn && !isZoomOut && !isReset) return;

      e.preventDefault();
      if (isZoomIn) zoomIn();
      else if (isZoomOut) zoomOut();
      else resetZoom();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomIn, zoomOut, resetZoom]);

  const saveAppearance = useCallback(async () => {
    writeAppearanceCache(config);
    try {
      const settings = await invoke<AppSettingsWithAppearance & Record<string, unknown>>(
        "load_app_settings"
      );
      await invoke("save_app_settings", {
        settings: {
          ...settings,
          appearance: themeConfigToAppearance(config),
        },
      });
      localStorage.removeItem("mqlens-theme");
      localStorage.removeItem("mqlens-density");
    } catch {
      /* offline / vault locked — local cache still holds the theme */
    }
  }, [config]);

  // Persist appearance when theme settings change (sidebar picker, settings tab, etc.)
  useEffect(() => {
    if (!hydrationDoneRef.current) return;
    if (skipAutoSaveRef.current) {
      skipAutoSaveRef.current = false;
      return;
    }
    writeAppearanceCache(config);
    const timer = window.setTimeout(() => {
      saveAppearance().catch(() => {
        /* offline / test environments */
      });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [config, saveAppearance]);

  useEffect(() => {
    if (config.mode !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const handler = () => {
      const mode = applyTheme(config);
      setResolvedMode(mode);
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [config]);

  // Recompute DPI / resolution UI scale on window resize (debounced, no full theme rewrite)
  useEffect(() => {
    let raf = 0;
    const onResize = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        applyResponsiveScale(config.fontSize, config.uiZoom);
      });
    };
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
    };
  }, [config.fontSize, config.uiZoom]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      config,
      resolvedMode,
      presets: THEME_PRESETS,
      setPreset: (presetId) => {
        const preset = THEME_PRESETS.find((p) => p.id === presetId);
        updateConfig({
          presetId,
          ...(preset ? { mode: preset.mode } : {}),
        });
      },
      setMode: (mode) => updateConfig({ mode }),
      setFontSize: (fontSize) => updateConfig({ fontSize }),
      setUiZoom: (uiZoom) => updateConfig({ uiZoom }),
      zoomIn,
      zoomOut,
      resetZoom,
      setSpacingDensity: (spacingDensity) => updateConfig({ spacingDensity }),
      setFontSans: (sans) =>
        setConfig((prev) => ({ ...prev, fonts: { ...prev.fonts, sans } })),
      setFontMono: (mono) =>
        setConfig((prev) => ({ ...prev, fonts: { ...prev.fonts, mono } })),
      setOverride: (token, value) =>
        setConfig((prev) => ({
          ...prev,
          overrides: { ...prev.overrides, [token]: value },
        })),
      clearOverrides: () => updateConfig({ overrides: {} }),
      updateConfig,
      exportTheme: () => exportThemeJson(config),
      importTheme: (json) => setConfig(importThemeJson(json)),
      saveAppearance,
    }),
    [config, resolvedMode, updateConfig, saveAppearance, zoomIn, zoomOut, resetZoom]
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}

export function useThemeOptional(): ThemeContextValue | null {
  return useContext(ThemeContext);
}
