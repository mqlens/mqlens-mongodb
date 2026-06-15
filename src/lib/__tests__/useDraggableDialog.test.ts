import { describe, it, expect } from 'vitest';
import { centeredDialogRect, clampDialogRect } from '../useDraggableDialog';

describe('useDraggableDialog', () => {
  it('centers a dialog rect in the viewport', () => {
    const rect = centeredDialogRect(800, 600);
    expect(rect.width).toBeLessThanOrEqual(800);
    expect(rect.height).toBeLessThanOrEqual(600);
    expect(rect.x).toBeGreaterThanOrEqual(16);
    expect(rect.y).toBeGreaterThanOrEqual(16);
  });

  it('clamps drag and resize within the viewport', () => {
    const clamped = clampDialogRect(
      { x: -100, y: -50, width: 50, height: 50 },
      400,
      300,
    );
    expect(clamped.x).toBeGreaterThanOrEqual(8);
    expect(clamped.y).toBeGreaterThanOrEqual(8);
    expect(clamped.width).toBeGreaterThanOrEqual(400);
    expect(clamped.height).toBeGreaterThanOrEqual(300);
  });
});
