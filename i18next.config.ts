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
 *
 * The `settings:<section>.tabLabel`/`tabDescription` keys are read through
 * `SETTINGS_TABS` in SettingsModal.tsx via `t(labelKey)`/`t(descriptionKey)`
 * — a variable, not a string literal — so the extractor's static analysis
 * can never see the reference. They're preserved here for the same reason.
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
      'common:cancel',
      'common:save',
      'common:close',
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
    ],
  },
});
