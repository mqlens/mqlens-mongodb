import { describe, it, expect } from 'vitest';
import {
  colorInputValue,
  isPresetConnectionColor,
  normalizeHexColor,
} from '../connectionColors';

describe('connectionColors', () => {
  it('normalizes 6-digit and 3-digit hex colors', () => {
    expect(normalizeHexColor('#A1B2C3')).toBe('#a1b2c3');
    expect(normalizeHexColor('#f00')).toBe('#ff0000');
    expect(normalizeHexColor('not-a-color')).toBeNull();
  });

  it('detects preset vs custom colors', () => {
    expect(isPresetConnectionColor('#3b82f6')).toBe(true);
    expect(isPresetConnectionColor('#a1b2c3')).toBe(false);
  });

  it('provides a valid color-input value', () => {
    expect(colorInputValue()).toBe('#3b82f6');
    expect(colorInputValue('#a1b2c3')).toBe('#a1b2c3');
    expect(colorInputValue('#f00')).toBe('#ff0000');
  });
});
