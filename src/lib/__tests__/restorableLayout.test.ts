import { describe, it, expect } from 'vitest';
import { restorableLayout, SIDE_PANEL_MIN } from '../restorableLayout';

describe('restorableLayout (#379)', () => {
  const aiHelper = ['document-main', 'ai-helper'];

  it('keeps a well-formed layout that matches the current panel set', () => {
    const saved = { 'document-main': 70, 'ai-helper': 30 };
    expect(restorableLayout(saved, aiHelper)).toBe(saved);
  });

  it('returns undefined when nothing is saved', () => {
    expect(restorableLayout(undefined, aiHelper)).toBeUndefined();
  });

  it('discards a layout whose entry count differs from the panel set', () => {
    // A three-entry layout against a two-panel group is exactly what makes
    // react-resizable-panels throw during render.
    const stale = { 'document-main': 50, 'ai-helper': 30, 'query-builder': 20 };
    expect(restorableLayout(stale, aiHelper)).toBeUndefined();
  });

  it('discards a layout missing one of the current panels', () => {
    const wrongKeys = { 'document-main': 70, 'query-builder': 30 };
    expect(restorableLayout(wrongKeys, aiHelper)).toBeUndefined();
  });

  it('discards a side panel restored below its sliver floor', () => {
    const sliver = { 'document-main': 98, 'ai-helper': 2 };
    expect(restorableLayout(sliver, aiHelper)).toBeUndefined();
  });

  it('keeps a side panel exactly at the floor', () => {
    const atFloor = { 'document-main': 100 - SIDE_PANEL_MIN, 'ai-helper': SIDE_PANEL_MIN };
    expect(restorableLayout(atFloor, aiHelper)).toBe(atFloor);
  });

  it('discards a layout with a non-numeric entry', () => {
    const bad = { 'document-main': 70, 'ai-helper': '30' } as unknown as Record<string, number>;
    expect(restorableLayout(bad, aiHelper)).toBeUndefined();
  });

  it('leaves a single-panel (document-only) layout alone', () => {
    const only = { 'document-main': 100 };
    expect(restorableLayout(only, ['document-main'])).toBe(only);
  });
});
