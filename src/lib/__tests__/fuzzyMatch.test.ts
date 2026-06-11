import { describe, it, expect } from 'vitest';
import { fuzzyMatch, fuzzyScore } from '../fuzzyMatch';

describe('fuzzyMatch', () => {
  it('matches plain substrings', () => {
    expect(fuzzyMatch('bill', 'Billing')).toBe(true);
    expect(fuzzyMatch('quota', 'Billing_QuotaOverUsage')).toBe(true);
  });
  it('is case-insensitive', () => {
    expect(fuzzyMatch('BILLING', 'billing')).toBe(true);
    expect(fuzzyMatch('billing', 'BILLING')).toBe(true);
  });
  it('matches in-order subsequences across word boundaries', () => {
    expect(fuzzyMatch('cwsmap', 'cnips_UserWorkspaceMap')).toBe(true);
    expect(fuzzyMatch('bqou', 'Billing_QuotaOverUsage')).toBe(true);
    expect(fuzzyMatch('depinst', 'Deployment_Instance')).toBe(true);
  });
  it('rejects out-of-order characters', () => {
    expect(fuzzyMatch('gnillib', 'Billing')).toBe(false);
  });
  it('rejects characters that are not present', () => {
    expect(fuzzyMatch('billingz', 'Billing')).toBe(false);
  });
  it('matches everything on an empty query', () => {
    expect(fuzzyMatch('', 'anything')).toBe(true);
    expect(fuzzyMatch('   ', 'anything')).toBe(true);
  });
  it('does not match an empty target with a non-empty query', () => {
    expect(fuzzyMatch('a', '')).toBe(false);
  });
});

describe('fuzzyScore', () => {
  it('returns null when there is no match', () => {
    expect(fuzzyScore('xyz', 'Billing')).toBeNull();
  });
  it('returns 0 for an empty query (no preference)', () => {
    expect(fuzzyScore('', 'anything')).toBe(0);
  });
  it('ranks exact > prefix > substring > subsequence', () => {
    const exact = fuzzyScore('billing', 'Billing')!;
    const prefix = fuzzyScore('bill', 'Billing')!;
    const substring = fuzzyScore('illing', 'Billing')!;
    const subsequence = fuzzyScore('blng', 'Billing')!;
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(substring);
    expect(substring).toBeGreaterThan(subsequence);
  });
  it('prefers shorter targets for the same prefix', () => {
    expect(fuzzyScore('bill', 'Billing')!).toBeGreaterThan(fuzzyScore('bill', 'Billing_QuotaOverUsage')!);
  });
  it('penalizes scattered subsequences against tight ones', () => {
    expect(fuzzyScore('bil', 'Billing')!).toBeGreaterThan(fuzzyScore('bqu', 'Billing_QuotaOverUsage')!);
  });
});
