import { describe, it, expect } from 'vitest';
import { formatBytes, formatDate, formatNumber } from '../format';

describe('formatNumber', () => {
  it('uses locale grouping and decimal separators', () => {
    expect(formatNumber(1234.56, 'en')).toBe('1,234.56');
    expect(formatNumber(1234.56, 'de')).toBe('1.234,56');
  });
  it('formats integers without decimals', () => {
    expect(formatNumber(1000, 'en')).toBe('1,000');
    expect(formatNumber(1000, 'de')).toBe('1.000');
  });
});

describe('formatDate', () => {
  const when = new Date('2026-07-30T14:05:00Z');
  it('orders date parts per locale', () => {
    // en-US puts the month first, de-DE the day; both include all three parts.
    expect(formatDate(when, 'en')).toMatch(/7\/30\/2026|Jul 30, 2026/);
    expect(formatDate(when, 'de')).toMatch(/30\.7\.2026|30\. Juli 2026|30\.07\.2026/);
  });
  it('accepts an ISO string or epoch millis', () => {
    expect(formatDate('2026-07-30T14:05:00Z', 'en')).toBe(formatDate(when, 'en'));
    expect(formatDate(when.getTime(), 'en')).toBe(formatDate(when, 'en'));
  });
  it('returns an empty string for an unparseable value rather than "Invalid Date"', () => {
    expect(formatDate('not-a-date', 'en')).toBe('');
  });
});

describe('formatBytes', () => {
  it('scales units and localizes the number', () => {
    expect(formatBytes(0, 'en')).toBe('0 B');
    expect(formatBytes(1024, 'en')).toBe('1 KB');
    expect(formatBytes(1536, 'en')).toBe('1.5 KB');
    expect(formatBytes(1536, 'de')).toBe('1,5 KB');
    expect(formatBytes(1024 * 1024 * 5, 'en')).toBe('5 MB');
  });
});
