import type { Monaco } from "@monaco-editor/react";

import { DOC_SYNTAX_TOKENS, DOC_TOKEN_POSTFIX } from "./monacoDocLanguage";

export type MqlensMonacoThemeId = "mqlens-light" | "mqlens-dark";


/** CSS vars store HSL components as `215 14% 17%`; Monaco requires `#rrggbb`. */
export function hslComponentsToHex(components: string): string {
  const trimmed = components.trim();
  if (trimmed.startsWith("#")) return trimmed;

  const match = trimmed.match(
    /^(-?\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%$/
  );
  if (!match) return trimmed;

  const h = parseFloat(match[1]) / 360;
  const s = parseFloat(match[2]) / 100;
  const l = parseFloat(match[3]) / 100;

  const hue2rgb = (p: number, q: number, t: number) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };

  let r: number;
  let g: number;
  let b: number;

  if (s === 0) {
    r = g = b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }

  const toHex = (channel: number) =>
    Math.round(channel * 255)
      .toString(16)
      .padStart(2, "0");

  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * How a token name becomes a hex colour for Monaco.
 *
 * Injectable because reading the DOM is not safe at the moment these themes are
 * built. React runs child effects before parent ones, so an editor asking the
 * computed styles for `--input` gets the value from BEFORE ThemeProvider
 * applied the new theme — empty on first mount, and the previous theme's colour
 * on every switch after. Measured, with a provider setting the variable and a
 * child reading it:
 *
 *     reads seen by the child: ["", "DARK"]   // switching to the light theme
 *
 * That is the whole of #282: an editor themed one step behind the app, falling
 * back to a hardcoded default when it had nothing to read at all — which is why
 * presets like nord, solarized and high-contrast never reached it, and why
 * changing the default made the symptom swap ends rather than go away.
 *
 * Callers that hold the theme config pass `tokenResolverFor` instead, which
 * answers from the config itself and cannot be out of step with it.
 */
export type MonacoTokenResolver = (name: string, fallback: string) => string;

/** Last-resort resolver: reads the DOM. Correct only once styles have settled. */
export const cssTokenResolver: MonacoTokenResolver = (name, fallback) => {
  if (typeof document === "undefined") return fallback;
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(`--${name}`)
    .trim();
  if (!raw) return fallback;
  return hslComponentsToHex(raw);
};

/** Resolver over a token map — the theme config's own values, no DOM involved. */
export function tokenResolverFor(
  tokens: Record<string, string>
): MonacoTokenResolver {
  return (name, fallback) => {
    const raw = tokens[name];
    return raw ? hslComponentsToHex(raw) : fallback;
  };
}

export function getMqlensMonacoThemeId(): MqlensMonacoThemeId {
  if (typeof document === "undefined") return "mqlens-dark";
  return document.documentElement.classList.contains("light")
    ? "mqlens-light"
    : "mqlens-dark";
}

/**
 * Token colours for both themes, read from the same design tokens the results
 * grid uses.
 *
 * These were previously `rules: []`, so Monaco fell back to VS Code's built-in
 * colours and the same document looked different in the grid and the editor.
 *
 * Every selector is scoped with `DOC_TOKEN_POSTFIX`: Monaco matches theme rules
 * by token name across all languages, so a bare `string` rule would also repaint
 * the JavaScript query and shell editors, which are meant to keep the inherited
 * VS/VS Dark palette. Monaco wants hex without the leading `#`.
 */
export function syntaxRules(
  resolve: MonacoTokenResolver = cssTokenResolver
): { token: string; foreground: string }[] {
  return DOC_SYNTAX_TOKENS.map(({ token, cssToken, fallback }) => ({
    token: `${token}${DOC_TOKEN_POSTFIX}`,
    foreground: resolve(cssToken, fallback).replace("#", ""),
  }));
}

/**
 * Both theme definitions, from one place.
 *
 * They used to be spelled out twice — once to register and once to refresh —
 * which is how a colour can be corrected in one and left stale in the other.
 */
function defineThemes(monaco: Monaco, resolve: MonacoTokenResolver): void {
  const rules = syntaxRules(resolve);

  monaco.editor.defineTheme("mqlens-light", {
    base: "vs",
    inherit: true,
    rules,
    colors: {
      "editor.background": resolve("input", "#ffffff"),
      "editor.foreground": resolve("foreground", "#1a1a1a"),
      "editorLineNumber.foreground": resolve("muted-foreground", "#6b7280"),
      "editor.selectionBackground": resolve("accent", "#e5e7eb"),
      "editor.inactiveSelectionBackground": resolve("muted", "#f3f4f6"),
      "editorCursor.foreground": resolve("primary", "#2563eb"),
      "editorWidget.background": resolve("popover", "#ffffff"),
      "editorWidget.border": resolve("border", "#d1d5db"),
    },
  });

  monaco.editor.defineTheme("mqlens-dark", {
    base: "vs-dark",
    inherit: true,
    rules,
    colors: {
      "editor.background": resolve("input", "#1e1e1e"),
      "editor.foreground": resolve("foreground", "#d4d4d4"),
      "editorLineNumber.foreground": resolve("muted-foreground", "#858585"),
      "editor.selectionBackground": resolve("accent", "#264f78"),
      "editor.inactiveSelectionBackground": resolve("muted", "#2a2d2e"),
      "editorCursor.foreground": resolve("primary", "#569cd6"),
      "editorWidget.background": resolve("popover", "#252526"),
      "editorWidget.border": resolve("border", "#454545"),
    },
  });
}

/**
 * Single ownership of the global Monaco themes.
 *
 * `defineTheme` is global: whichever editor calls it last wins for every editor
 * on screen. With each of QueryEditor, DocumentEditModal and MongoShell
 * refreshing on its own schedule, one of them resolving colours from stale CSS
 * variables silently overwrote the others' correct definitions — and for a
 * preset change within the same mode nothing re-renders afterwards to repair it
 * (#324 review). DocumentEditModal's own comment already noted the two "can
 * fight".
 *
 * So editors no longer define themes at all. They announce their Monaco
 * instance, and ThemeProvider — which already owns applying the theme, and
 * whose effect runs after its children's — is the only writer.
 */
let activeMonaco: Monaco | null = null;
let currentResolve: MonacoTokenResolver = cssTokenResolver;
let currentThemeId: MqlensMonacoThemeId = "mqlens-dark";

/** An editor announcing itself; it is themed immediately from current state. */
export function attachMonaco(monaco: Monaco): void {
  activeMonaco = monaco;
  defineThemes(monaco, currentResolve);
  monaco.editor.setTheme(currentThemeId);
}

/** The only writer: called by ThemeProvider once per applied config. */
export function setMonacoAppTheme(
  resolve: MonacoTokenResolver,
  themeId: MqlensMonacoThemeId
): void {
  currentResolve = resolve;
  currentThemeId = themeId;
  if (!activeMonaco) return;
  defineThemes(activeMonaco, resolve);
  activeMonaco.editor.setTheme(themeId);
}

/** Test seam: forget the attached editor and fall back to reading the DOM. */
export function resetMonacoAppThemeForTests(): void {
  activeMonaco = null;
  currentResolve = cssTokenResolver;
  currentThemeId = "mqlens-dark";
}
