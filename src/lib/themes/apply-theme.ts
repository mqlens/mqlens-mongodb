import { TOKEN_NAMES, type ThemeConfig, type TokenName } from "./schema";
import { getPresetById } from "./presets";
import { computeEffectiveUiScale } from "./ui-scale";

let lastAppliedKey: string | null = null;

/** @internal test helper */
export function resetAppliedThemeCache(): void {
  lastAppliedKey = null;
}

function themeConfigKey(config: ThemeConfig): string {
  return JSON.stringify({
    presetId: config.presetId,
    mode: config.mode,
    overrides: config.overrides,
    fonts: config.fonts,
    fontSize: config.fontSize,
    spacingDensity: config.spacingDensity,
    uiZoom: config.uiZoom,
  });
}

function applyTypographyScale(fontSizePx: number, userZoom = 1): void {
  const uiScale = computeEffectiveUiScale(userZoom);
  const effective = fontSizePx * uiScale;

  const root = document.documentElement;
  root.style.setProperty("--font-size-base", `${fontSizePx}px`);
  root.style.setProperty("--ui-scale", String(uiScale));
  root.style.setProperty("--font-size-effective", `${effective}px`);
  root.style.setProperty("--font-size-2xs", `${effective * 0.77}px`);
  root.style.setProperty("--font-size-xs", `${effective * 0.846}px`);
  root.style.setProperty("--font-size-sm", `${effective * 0.923}px`);
  root.style.setProperty("--font-size-md", `${effective}px`);
  root.style.setProperty("--font-size-lg", `${effective * 1.077}px`);
  root.style.setProperty("--font-size-xl", `${effective * 1.231}px`);
}

export function resolveThemeMode(
  config: ThemeConfig
): "dark" | "light" {
  if (config.mode === "system") {
    return window.matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark";
  }
  const preset = getPresetById(config.presetId);
  if (config.mode === "light") return "light";
  if (config.mode === "dark") return "dark";
  return preset?.mode ?? "dark";
}

export function getEffectiveTokens(
  config: ThemeConfig
): Record<TokenName, string> {
  const preset = getPresetById(config.presetId);
  const base = preset?.tokens ?? getPresetById("mqlens-dark")!.tokens;
  return { ...base, ...config.overrides };
}

export function applyTheme(config: ThemeConfig): "dark" | "light" {
  const key = themeConfigKey(config);
  const resolvedMode = resolveThemeMode(config);
  if (key === lastAppliedKey) {
    return resolvedMode;
  }
  lastAppliedKey = key;

  const root = document.documentElement;
  const tokens = getEffectiveTokens(config);

  root.classList.remove("dark", "light");
  root.classList.add(resolvedMode);
  root.setAttribute("data-theme", config.presetId);
  root.setAttribute("data-spacing", config.spacingDensity);

  for (const name of TOKEN_NAMES) {
    root.style.setProperty(`--${name}`, tokens[name]);
  }

  root.style.setProperty(
    "--font-family-sans",
    `"${config.fonts.sans}", ui-sans-serif, system-ui, sans-serif`
  );
  root.style.setProperty(
    "--font-family-mono",
    `"${config.fonts.mono}", ui-monospace, monospace`
  );
  applyTypographyScale(config.fontSize, config.uiZoom);

  return resolvedMode;
}

/** Window resize / DPI change — skip full token rewrite. */
export function applyResponsiveScale(fontSizePx: number, userZoom = 1): void {
  const nextScale = computeEffectiveUiScale(userZoom);
  const root = document.documentElement;
  const prevScale = parseFloat(root.style.getPropertyValue("--ui-scale") || "1");
  if (Math.abs(nextScale - prevScale) < 0.001) return;

  applyTypographyScale(fontSizePx, userZoom);
}

export function exportThemeJson(config: ThemeConfig): string {
  return JSON.stringify(config, null, 2);
}

export function importThemeJson(json: string): ThemeConfig {
  const parsed = JSON.parse(json) as ThemeConfig;
  if (!parsed.presetId || !parsed.mode) {
    throw new Error("Invalid theme configuration");
  }
  return {
    presetId: parsed.presetId,
    mode: parsed.mode,
    overrides: parsed.overrides || {},
    fonts: parsed.fonts || { sans: "Inter", mono: "JetBrains Mono" },
    fontSize: parsed.fontSize || 13,
    spacingDensity: parsed.spacingDensity || "cozy",
    uiZoom: parsed.uiZoom ?? 1,
  };
}

export function getTokenValue(name: TokenName): string {
  return getComputedStyle(document.documentElement)
    .getPropertyValue(`--${name}`)
    .trim();
}

export function getChartColors(): string[] {
  return ["chart-1", "chart-2", "chart-3", "chart-4", "chart-5"].map(
    (name) => `hsl(${getTokenValue(name as TokenName)})`
  );
}
