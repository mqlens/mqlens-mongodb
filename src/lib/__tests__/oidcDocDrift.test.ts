import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Drift lock for `docs/oidc.md`: every `auth.oidc.errors.*` message in the
 * English locale catalog must appear verbatim in the OIDC docs page's
 * troubleshooting section, in the exact wording a user sees in the app.
 * Mirrors the Rust-side drift lock for docs/mcp-tools.md
 * (`mcp::tests::mcp_tools_doc_lists_every_tool_from_the_golden_fixture`).
 *
 * The key list is read from the locale catalog, not hard-coded, so this test
 * cannot itself drift from the source of truth it's guarding.
 */
describe('docs/oidc.md troubleshooting coverage', () => {
  it('documents every auth.oidc.errors.* message from the English locale catalog', () => {
    const catalog = JSON.parse(readFileSync('src/locales/en/connections.json', 'utf-8'));
    const errors = catalog?.auth?.oidc?.errors;
    expect(errors && typeof errors === 'object').toBe(true);

    const keys = Object.keys(errors);
    expect(keys.length).toBeGreaterThan(0);

    const doc = readFileSync('docs/oidc.md', 'utf-8');

    for (const key of keys) {
      const message = errors[key];
      expect(
        doc.includes(message),
        `docs/oidc.md is missing the troubleshooting entry for auth.oidc.errors.${key} ("${message}")`,
      ).toBe(true);
    }
  });

  it('links the Database Tools follow-up issue from the export and import section', () => {
    const doc = readFileSync('docs/oidc.md', 'utf-8');
    const section = doc.split('## Export and import')[1]?.split('\n## ')[0] ?? '';
    expect(section).toContain('https://github.com/mqlens/mqlens-mongodb/issues/432');
  });
});
