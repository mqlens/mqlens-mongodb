import { describe, it, expect } from 'vitest';
import { formatBytes, formatDuration } from '../format';

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

describe('formatDuration', () => {
  it('names the largest unit that divides the seconds exactly', () => {
    expect(formatDuration(86400, 'en')).toBe('1 day');
    expect(formatDuration(7200, 'en')).toBe('2 hours');
    expect(formatDuration(5400, 'en')).toBe('90 minutes');
    expect(formatDuration(90, 'en')).toBe('90 seconds');
    expect(formatDuration(0, 'en')).toBe('0 seconds');
  });

  it('speaks the given language', () => {
    expect(formatDuration(86400, 'de')).toBe('1 Tag');
  });
});
