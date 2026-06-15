/** User-adjustable zoom (Cmd+/Cmd-), multiplied with auto DPI scale. */
export const UI_ZOOM_MIN = 0.75;
export const UI_ZOOM_MAX = 1.5;
export const UI_ZOOM_STEP = 0.05;
export const UI_ZOOM_DEFAULT = 1;

/** Auto UI scale from display DPI / resolution (clamped for readability). */
export function computeAutoDpiScale(): number {
  if (typeof window === "undefined") return 1;

  const dpr = window.devicePixelRatio || 1;
  const w = window.innerWidth;
  const h = window.innerHeight;
  const minDim = Math.min(w, h);

  let scale = 1;
  if (dpr >= 3) scale = 1.12;
  else if (dpr >= 2) scale = 1.06;
  else if (dpr >= 1.5) scale = 1.03;

  if (minDim >= 1440) scale *= 1.04;
  if (minDim >= 2160) scale *= 1.06;

  return Math.min(Math.max(scale, 1), 1.25);
}

/** @deprecated use computeAutoDpiScale */
export const computeUiScale = computeAutoDpiScale;

export function clampUiZoom(zoom: number): number {
  const clamped = Math.min(Math.max(zoom, UI_ZOOM_MIN), UI_ZOOM_MAX);
  return Math.round(clamped * 100) / 100;
}

export function stepUiZoom(current: number, direction: 1 | -1): number {
  return clampUiZoom(current + direction * UI_ZOOM_STEP);
}

export function computeEffectiveUiScale(userZoom = UI_ZOOM_DEFAULT): number {
  const zoom = clampUiZoom(userZoom);
  const auto = computeAutoDpiScale();
  return Math.round(auto * zoom * 1000) / 1000;
}

export function applyUiScale(userZoom = UI_ZOOM_DEFAULT): number {
  const scale = computeEffectiveUiScale(userZoom);
  document.documentElement.style.setProperty("--ui-scale", String(scale));
  return scale;
}

/** Read effective root font size in px (user setting × DPI scale). */
export function getEffectiveFontSizePx(): number {
  if (typeof window === "undefined") return 13;
  const root = getComputedStyle(document.documentElement);
  const base = parseFloat(root.getPropertyValue("--font-size-base")) || 13;
  const uiScale = parseFloat(root.getPropertyValue("--ui-scale")) || 1;
  return base * uiScale;
}

/** Row height for virtualized lists, scaled with font size + density. */
export function getScaledRowHeight(
  baseAt13px: number,
  _density: "compact" | "cozy" | "roomy" = "cozy"
): number {
  if (typeof window === "undefined") return baseAt13px;
  const root = getComputedStyle(document.documentElement);
  const basePx = parseFloat(root.getPropertyValue("--font-size-base")) || 13;
  const uiScale = parseFloat(root.getPropertyValue("--ui-scale")) || 1;
  const densityScale =
    parseFloat(root.getPropertyValue("--spacing-density-scale")) || 1;
  return Math.round(
    baseAt13px * (basePx / 13) * uiScale * densityScale
  );
}
