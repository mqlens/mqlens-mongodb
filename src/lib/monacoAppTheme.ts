import type { Monaco } from "@monaco-editor/react";

export type MqlensMonacoThemeId = "mqlens-light" | "mqlens-dark";

let registered = false;

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

function readToken(name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(`--${name}`)
    .trim();
  if (!raw) return fallback;
  return hslComponentsToHex(raw);
}

export function getMqlensMonacoThemeId(): MqlensMonacoThemeId {
  if (typeof document === "undefined") return "mqlens-dark";
  return document.documentElement.classList.contains("light")
    ? "mqlens-light"
    : "mqlens-dark";
}

export function registerMqlensMonacoThemes(monaco: Monaco): void {
  if (registered) return;

  const lightTheme: MqlensMonacoThemeId = "mqlens-light";
  const darkTheme: MqlensMonacoThemeId = "mqlens-dark";

  monaco.editor.defineTheme(lightTheme, {
    base: "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": readToken("input", "#ffffff"),
      "editor.foreground": readToken("foreground", "#1a1a1a"),
      "editorLineNumber.foreground": readToken("muted-foreground", "#6b7280"),
      "editor.selectionBackground": readToken("accent", "#e5e7eb"),
      "editor.inactiveSelectionBackground": readToken("muted", "#f3f4f6"),
      "editorCursor.foreground": readToken("primary", "#2563eb"),
      "editorWidget.background": readToken("popover", "#ffffff"),
      "editorWidget.border": readToken("border", "#d1d5db"),
    },
  });

  monaco.editor.defineTheme(darkTheme, {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": readToken("input", "#1e1e1e"),
      "editor.foreground": readToken("foreground", "#d4d4d4"),
      "editorLineNumber.foreground": readToken("muted-foreground", "#858585"),
      "editor.selectionBackground": readToken("accent", "#264f78"),
      "editor.inactiveSelectionBackground": readToken("muted", "#2a2d2e"),
      "editorCursor.foreground": readToken("primary", "#569cd6"),
      "editorWidget.background": readToken("popover", "#252526"),
      "editorWidget.border": readToken("border", "#454545"),
    },
  });

  registered = true;
  monaco.editor.setTheme(getMqlensMonacoThemeId());
}

export function refreshMqlensMonacoTheme(monaco: Monaco): void {
  const lightTheme: MqlensMonacoThemeId = "mqlens-light";
  const darkTheme: MqlensMonacoThemeId = "mqlens-dark";

  monaco.editor.defineTheme(lightTheme, {
    base: "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": readToken("input", "#ffffff"),
      "editor.foreground": readToken("foreground", "#1a1a1a"),
      "editorLineNumber.foreground": readToken("muted-foreground", "#6b7280"),
      "editor.selectionBackground": readToken("accent", "#e5e7eb"),
      "editor.inactiveSelectionBackground": readToken("muted", "#f3f4f6"),
      "editorCursor.foreground": readToken("primary", "#2563eb"),
      "editorWidget.background": readToken("popover", "#ffffff"),
      "editorWidget.border": readToken("border", "#d1d5db"),
    },
  });

  monaco.editor.defineTheme(darkTheme, {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": readToken("input", "#1e1e1e"),
      "editor.foreground": readToken("foreground", "#d4d4d4"),
      "editorLineNumber.foreground": readToken("muted-foreground", "#858585"),
      "editor.selectionBackground": readToken("accent", "#264f78"),
      "editor.inactiveSelectionBackground": readToken("muted", "#2a2d2e"),
      "editorCursor.foreground": readToken("primary", "#569cd6"),
      "editorWidget.background": readToken("popover", "#252526"),
      "editorWidget.border": readToken("border", "#454545"),
    },
  });

  monaco.editor.setTheme(getMqlensMonacoThemeId());
}
