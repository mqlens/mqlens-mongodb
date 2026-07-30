import { defineConfig } from 'i18next-cli';

/**
 * Extracts t() keys from source into src/locales/en/*.json.
 *
 * German (src/locales/de/) is translated by hand: restricting `locales` to
 * just `en` means `primaryLanguage` is 'en' and `secondaryLanguages` defaults
 * to the empty set, so extraction and the CI check never touch src/locales/de/.
 *
 * `common.appName` is a key seeded by the i18n bootstrap that isn't
 * referenced by any `t()` call yet — the UI surface that will use it lands in
 * follow-up work. `preservePatterns` keeps extraction from pruning it as
 * "unused" in the meantime; remove the entry once it's wired up to a `t()`
 * call. `common.cancel`/`save`/`close` were the same story but are now read
 * from ConnectionManager.tsx, so they've been dropped from this list.
 *
 * The `settings:<section>.tabLabel`/`tabDescription` keys are read through
 * `SETTINGS_TABS` in SettingsModal.tsx via `t(labelKey)`/`t(descriptionKey)`
 * — a variable, not a string literal — so the extractor's static analysis
 * can never see the reference. They're preserved here for the same reason,
 * as are the ConnectionManager.tsx equivalents: `TABS`/`CONNECTION_MODE_OPTIONS`
 * read via `t(tab.labelKey)`/`t(opt.labelKey)`/`t(opt.descriptionKey)`, the
 * test-step checklist read via `t(step.nameKey)`, and the
 * `summarizeConnectionError` result keys read via `t(info.summaryKey)`/
 * `t(info.hintKey)`.
 */
export default defineConfig({
  locales: ['en'],
  extract: {
    input: ['src/**/*.{ts,tsx}', '!src/**/__tests__/**'],
    output: 'src/locales/{{language}}/{{namespace}}.json',
    defaultNS: 'common',
    keySeparator: '.',
    nsSeparator: ':',
    sort: true,
    // Fail loudly rather than inventing English copy from a key name.
    defaultValue: '',
    preservePatterns: [
      'common:appName',
      'settings:appearance.tabLabel',
      'settings:appearance.tabDescription',
      'settings:ai.tabLabel',
      'settings:ai.tabDescription',
      'settings:mcp.tabLabel',
      'settings:mcp.tabDescription',
      'settings:tools.tabLabel',
      'settings:tools.tabDescription',
      'settings:updates.tabLabel',
      'settings:updates.tabDescription',
      'settings:shortcuts.tabLabel',
      'settings:shortcuts.tabDescription',
      'settings:security.tabLabel',
      'settings:security.tabDescription',
      'settings:language.tabLabel',
      'settings:language.tabDescription',
      'connections:tabs.server',
      'connections:tabs.auth',
      'connections:tabs.tls',
      'connections:tabs.ssh',
      'connections:tabs.proxy',
      'connections:tabs.advanced',
      'connections:connectionMode.normal.label',
      'connections:connectionMode.normal.description',
      'connections:connectionMode.readOnly.label',
      'connections:connectionMode.readOnly.description',
      'connections:connectionMode.confirmDestructive.label',
      'connections:connectionMode.confirmDestructive.description',
      'connections:test.stageParse',
      'connections:test.stageResolve',
      'connections:test.stageConnect',
      'connections:test.stagePing',
      'errors:conn.tlsNotTrusted',
      'errors:conn.tlsNotTrustedHint',
      'errors:conn.authFailed',
      'errors:conn.authFailedHint',
      'errors:conn.refused',
      'errors:conn.refusedHint',
      'errors:conn.dnsFailed',
      'errors:conn.dnsFailedHint',
      'errors:conn.handshakeClosed',
      'errors:conn.handshakeClosedHint',
      'errors:conn.selectionTimeout',
      'errors:conn.selectionTimeoutHint',
      'errors:conn.timedOut',
    ],
  },
});
