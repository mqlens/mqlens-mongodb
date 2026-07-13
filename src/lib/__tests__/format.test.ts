import { describe, it, expect } from 'vitest';
import { formatBytes } from '../format';

describe('formatBytes', () => {
  it('formats zero / invalid as 0 B', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(-5)).toBe('0 B');
    expect(formatBytes(NaN)).toBe('0 B');
  });

  it('formats bytes, KB, MB, GB', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(150 * 1024 * 1024)).toBe('150 MB');
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe('2 GB');
  });

  it('scales past TB into PB', () => {
    expect(formatBytes(2 * 1024 ** 5)).toBe('2 PB');
  });
});
