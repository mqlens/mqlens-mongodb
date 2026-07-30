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
  This also covers literal *default values* that get written straight into
  the database — e.g. `sidebar:dialogs.initialCollection.defaultValue` seeds
  a `create_collection` call, so it must stay `"collection"` in every locale,
  never a translated word.
- **Keep placeholders intact.** `{{count}}` and `{{detail}}` must survive
  translation, spelled exactly the same. `npm test` checks this automatically
  (`src/lib/i18n/__tests__/catalogs.test.ts`).
- **Keep leading/trailing whitespace intact.** A few keys are sentence
  fragments meant to be concatenated with a sibling key and rely on a
  significant leading or trailing space (e.g.
  `connections:ssh.hostKeyNoteSuffix`, `sidebar:tree.offlineSuffix`). Don't
  let an editor or formatter trim it.
- **A locale that ships is a locale that's fully translated.** Two tests
  enforce this together, so there's no middle ground: the catalog parity test
  requires every registered locale to carry every key (a missing key means
  untranslated copy), and the identical-value test rejects a value that's
  still byte-identical to English once the key exists (so you can't stub it
  with the English copy either, the way earlier revisions of this doc
  suggested). In practice: when you add a new key, translate it into every
  locale in the same change. If you can't yet translate into a locale you
  don't speak, don't add that locale — ship English-only (the app falls back
  to English for any locale that isn't registered in `SUPPORTED_LOCALES` /
  `resources` at all) and leave a follow-up PR for the translation.
  - The identical-value check has a small `ALLOWED_IDENTICAL_VALUES`
    allowlist in `catalogs.test.ts` for values that are legitimately the same
    in both languages — loanwords (`Theme`), protocol/format identifiers
    (`JSON`, `SCRAM-SHA-1`), product names, and literal default values like
    the `collection` case above. Only add to it after confirming the match
    isn't just untranslated copy.

## Verify

    npm run i18n:check     # catalogs match the code
    npm test               # includes catalog parity across locales
    npm run build
