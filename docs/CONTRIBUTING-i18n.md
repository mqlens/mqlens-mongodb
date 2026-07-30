# Adding a language to MQLens

MQLens ships English (`en`, the source) and German (`de`). Adding a language
means adding one folder and one list entry.

## 1. Copy the English catalogs

    cp -r src/locales/en src/locales/<code>

Use a lowercase ISO 639-1 code (`fr`, `es`, `pt`, `ja`). Translate the *values*
in each JSON file; never change the keys.

## 2. Register it

Add an entry to `SUPPORTED_LOCALES` in `src/lib/i18n/locales.ts`:

    { code: 'fr', label: 'Français' },

Use the language's own name for the label ("Français", not "French") — that is
what a speaker looks for in the picker.

## 3. Add the resources

Import your JSON files in `src/lib/i18n/index.ts` and add them to `resources`,
following the existing `de` entries.

## Plurals

Keys ending `_one` / `_other` are plural forms. Some languages need more forms
(`_few`, `_many`, `_zero`); add whichever your language's CLDR rules require —
i18next selects the right one via `Intl.PluralRules`.

## Rules

- **Never translate:** MongoDB operator names (`$match`), BSON type labels
  (`ObjectId`), auth mechanism identifiers (`SCRAM-SHA-256`), URI schemes,
  `mongosh`, or database / collection / field names (those are user data).
- **Keep placeholders intact.** `{{count}}` and `{{detail}}` must survive
  translation, spelled exactly the same.
- **Untranslated keys fall back to English**, so a partial translation is
  perfectly acceptable — ship what you have.

## Verify

    npm run i18n:check     # catalogs match the code
    npm test               # includes catalog parity across locales
    npm run build

The parity test requires every locale to carry every key. If you are mid-way,
copy the English value across so the key exists, then translate it later.
