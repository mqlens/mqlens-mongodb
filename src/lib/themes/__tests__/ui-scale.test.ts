import { describe, it, expect } from 'vitest';
import {
  clampUiZoom,
  growQueryBarHeight,
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

describe('growQueryBarHeight — showing the whole query (#260)', () => {
  // A 29px row with an 18px line: 11px of padding centres one line in the box.
  const MIN = 29;
  const LINE = 18;

  it('leaves a query that fits at the configured height', () => {
    // The setting still sets the floor — a one-line query must not shrink the
    // bar below what the user asked for.
    expect(growQueryBarHeight(LINE, LINE, MIN)).toBe(MIN);
    expect(growQueryBarHeight(4, LINE, MIN)).toBe(MIN);
  });

  it('grows a row per wrapped line, keeping the padding', () => {
    // Two wrapped lines need two line-heights plus the padding the single-line
    // box already carried, or the second line sits against the edge.
    expect(growQueryBarHeight(LINE * 2, LINE, MIN)).toBe(2 * LINE + (MIN - LINE));
    expect(growQueryBarHeight(LINE * 3, LINE, MIN)).toBe(3 * LINE + (MIN - LINE));
  });

  it('does not count Monaco editor padding as another wrapped row', () => {
    const monacoPadding = 6;
    expect(growQueryBarHeight(LINE + monacoPadding, LINE, MIN, monacoPadding)).toBe(MIN);
    expect(growQueryBarHeight(LINE * 2 + monacoPadding, LINE, MIN, monacoPadding)).toBe(
      2 * LINE + (MIN - LINE)
    );
  });

  it('stops growing at the cap, so the bar cannot take over the window', () => {
    const capped = growQueryBarHeight(LINE * 40, LINE, MIN, 0, 6);
    expect(capped).toBe(6 * LINE + (MIN - LINE));
    // Past the cap it is the same height whatever else arrives — the editor
    // scrolls from there.
    expect(growQueryBarHeight(LINE * 400, LINE, MIN, 0, 6)).toBe(capped);
  });

  it('falls back to the configured height on nonsense input', () => {
    // `getContentHeight()` before layout, a zero line-height mid-resize.
    expect(growQueryBarHeight(Number.NaN, LINE, MIN)).toBe(MIN);
    expect(growQueryBarHeight(LINE * 3, 0, MIN)).toBe(MIN);
  });
});
