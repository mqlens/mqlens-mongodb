import { useMemo } from "react";
import { useThemeOptional } from "@/hooks/use-theme";
import {
  getMqlensMonacoThemeId,
  type MqlensMonacoThemeId,
} from "./monacoAppTheme";

function resolveThemeId(resolvedMode?: "dark" | "light"): MqlensMonacoThemeId {
  if (resolvedMode === "light") return "mqlens-light";
  if (resolvedMode === "dark") return "mqlens-dark";
  return getMqlensMonacoThemeId();
}

/** Monaco theme id — driven by ThemeProvider, no DOM observers. */
export function useMonacoTheme(): MqlensMonacoThemeId {
  const themeCtx = useThemeOptional();
  return useMemo(
    () => resolveThemeId(themeCtx?.resolvedMode),
    [themeCtx?.resolvedMode]
  );
}
