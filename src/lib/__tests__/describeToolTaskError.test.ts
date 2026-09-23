import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { describeToolTaskError } from '../describeToolTaskError';

const FOLLOW_UP_ISSUE = 'https://github.com/mqlens/mqlens-mongodb/issues/432';

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

  // The message points at the follow-up issue for browser login in the
  // Database Tools, in every shipped language.
  it.each(['en', 'de', 'zh-Hans'])('%s links the Database Tools OIDC follow-up issue', (lng) => {
    const catalog = JSON.parse(readFileSync(`src/locales/${lng}/shell.json`, 'utf-8'));
    expect(catalog.tools.errors.oidcUnsupportedByDatabaseTools).toContain(FOLLOW_UP_ISSUE);
  });
});
