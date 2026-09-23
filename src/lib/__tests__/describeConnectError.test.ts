import { describe, it, expect } from 'vitest';
import { describeConnectError } from '../describeConnectError';

describe('describeConnectError', () => {
  it('translates a bare OIDC error key through the connections namespace', () => {
    const t = (key: string) => (key === 'connections:auth.oidc.errors.cancelled' ? 'The login was cancelled.' : key);
    expect(describeConnectError('auth.oidc.errors.cancelled', t)).toBe('The login was cancelled.');
  });

  it('passes through a raw driver error unchanged', () => {
    const t = (key: string) => key;
    expect(describeConnectError('server selection timeout', t)).toBe('server selection timeout');
  });

  it('reads the message off an Error-like object before checking the prefix', () => {
    const t = (key: string) => (key === 'connections:auth.oidc.errors.timedOut' ? 'The browser login expired.' : key);
    expect(describeConnectError(new Error('auth.oidc.errors.timedOut'), t)).toBe('The browser login expired.');
  });

  it('stringifies a non-string, non-Error value unchanged', () => {
    const t = (key: string) => key;
    expect(describeConnectError(42, t)).toBe('42');
  });
});
