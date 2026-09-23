import { describe, it, expect } from 'vitest';
import { describeToolTaskError } from '../describeToolTaskError';

describe('describeToolTaskError', () => {
  it('translates the Database Tools OIDC error key through the shell namespace', () => {
    const t = (key: string) =>
      key === 'shell:tools.errors.oidcUnsupportedByDatabaseTools'
        ? 'The bundled Database Tools cannot authenticate with OIDC browser login.'
        : key;
    expect(describeToolTaskError('tools.errors.oidcUnsupportedByDatabaseTools', t)).toBe(
      'The bundled Database Tools cannot authenticate with OIDC browser login.'
    );
  });

  it('passes through raw stderr unchanged', () => {
    const t = (key: string) => key;
    expect(describeToolTaskError('Failed: no reachable servers', t)).toBe(
      'Failed: no reachable servers'
    );
  });

  it('passes through null and undefined unchanged', () => {
    const t = (key: string) => key;
    expect(describeToolTaskError(null, t)).toBe(null);
    expect(describeToolTaskError(undefined, t)).toBe(undefined);
  });
});
