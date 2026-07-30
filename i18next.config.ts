import { defineConfig } from 'i18next-cli';

/**
 * Extracts t() keys from source into src/locales/en/*.json.
 *
 * German (src/locales/de/) is translated by hand: restricting `locales` to
 * just `en` means `primaryLanguage` is 'en' and `secondaryLanguages` defaults
 * to the empty set, so extraction and the CI check never touch src/locales/de/.
 *
 * `common.appName`/`cancel`/`save`/`close` are keys seeded by the i18n
 * bootstrap that aren't referenced by any `t()` call yet — the UI surfaces
 * that will use them land in follow-up work. `preservePatterns` keeps
 * extraction from pruning them as "unused" in the meantime; remove the
 * entries here once each key is actually wired up to a `t()` call.
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
    preservePatterns: ['common:appName', 'common:cancel', 'common:save', 'common:close'],
  },
});
