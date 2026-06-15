import { describe, it, expect } from 'vitest';
import {
  clampUiZoom,
  computeEffectiveUiScale,
  stepUiZoom,
  UI_ZOOM_DEFAULT,
  UI_ZOOM_MAX,
  UI_ZOOM_MIN,
} from '@/lib/themes/ui-scale';

describe('ui zoom', () => {
  it('clamps zoom to allowed range', () => {
    expect(clampUiZoom(0.5)).toBe(UI_ZOOM_MIN);
    expect(clampUiZoom(2)).toBe(UI_ZOOM_MAX);
    expect(clampUiZoom(1)).toBe(1);
  });

  it('steps zoom in and out', () => {
    expect(stepUiZoom(1, 1)).toBe(1.05);
    expect(stepUiZoom(1, -1)).toBe(0.95);
    expect(stepUiZoom(UI_ZOOM_MAX, 1)).toBe(UI_ZOOM_MAX);
    expect(stepUiZoom(UI_ZOOM_MIN, -1)).toBe(UI_ZOOM_MIN);
  });

  it('combines user zoom with auto DPI scale', () => {
    const base = computeEffectiveUiScale(UI_ZOOM_DEFAULT);
    const zoomed = computeEffectiveUiScale(1.1);
    expect(zoomed).toBeGreaterThan(base);
  });
});
