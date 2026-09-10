import { describe, it, expect } from 'vitest';
import { restorableLayout, SIDE_PANEL_MIN, SIDE_PANEL_MAX } from '../restorableLayout';

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

  it('discards a layout that would restore the document area as a sliver', () => {
    // The side panel clears its own minimum here, so a min-only guard would let
    // this through — but document-main at 2% is unusable (#379 review). It is
    // also above the side max, another reason to reject.
    const mainSliver = { 'document-main': 2, 'ai-helper': 98 };
    expect(restorableLayout(mainSliver, aiHelper)).toBeUndefined();
  });

  it('discards a side panel restored above its maximum', () => {
    const tooWide = { 'document-main': 45, 'ai-helper': 55 };
    expect(restorableLayout(tooWide, aiHelper)).toBeUndefined();
  });

  it('keeps a side panel exactly at the floor', () => {
    const atFloor = { 'document-main': 100 - SIDE_PANEL_MIN, 'ai-helper': SIDE_PANEL_MIN };
    expect(restorableLayout(atFloor, aiHelper)).toBe(atFloor);
  });

  it('discards a layout whose entries do not total 100%', () => {
    // Each value is individually in-bounds, but they sum to 118%. The library
    // normalizes proportions, scaling the side panel back under its floor —
    // the sliver this guard exists to prevent (#380 review).
    const overSum = { 'document-main': 100, 'ai-helper': 18 };
    expect(restorableLayout(overSum, aiHelper)).toBeUndefined();
    // And an under-sum layout is just as wrong.
    const underSum = { 'document-main': 60, 'ai-helper': 30 };
    expect(restorableLayout(underSum, aiHelper)).toBeUndefined();
  });

  it('tolerates the sub-percent float drift a drag can leave', () => {
    const drifted = { 'document-main': 69.7, 'ai-helper': 30.3 };
    expect(restorableLayout(drifted, aiHelper)).toBe(drifted);
  });

  it('keeps a side panel exactly at the maximum', () => {
    const atMax = { 'document-main': 100 - SIDE_PANEL_MAX, 'ai-helper': SIDE_PANEL_MAX };
    expect(restorableLayout(atMax, aiHelper)).toBe(atMax);
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
