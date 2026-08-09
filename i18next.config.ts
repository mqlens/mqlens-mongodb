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
 *
 * The `toast.*` keys below are read through DocumentViewer.tsx's `notify()`
 * helper (`notify(key, kind, options)` → `t(key, options)`), whose `key`
 * argument is itself a variable at every call site (a plain identifier, or a
 * ternary choosing between two key names for `handleClearField`) — never a
 * string literal the extractor's static analysis can see.
 *
 * The `transfer:restoreView.options.flags.*` keys are read through
 * RestoreView.tsx's `FLAG_FIELDS` via `t(f.labelKey)` — a variable, not a
 * literal. The `transfer:generateView.kindLabels.*` keys are read through
 * GenerateView.tsx's `RowEditor` via `` tg(`generateView.kindLabels.${k}`) ``
 * — a template literal keyed off the field's `GenKind`. The
 * `transfer:importView.columnTypes.*` keys (excluding `.json`, which renders
 * its literal value directly and never calls `t()`) are read through
 * ImportView.tsx via `` t(`importView.columnTypes.${colType}`) ``. None of
 * these are string literals the extractor's static analysis can see.
 *
 * The `admin:monitoringView.refreshOptions.*` keys are read through
 * MonitoringView.tsx's `REFRESH_OPTIONS` via `` t(`monitoringView.refreshOptions.${o.labelKey}`) ``
 * — a template literal keyed off each option's `labelKey`, not a string
 * literal the extractor's static analysis can see.
 *
 * The `shell:keyboardShortcuts.groups.*` and `shell:keyboardShortcuts.items.*`
 * keys are read through shortcuts.ts's `SHORTCUT_GROUP_LABEL_KEYS`/
 * `KEYBOARD_SHORTCUTS`/`quickStartShortcutRows` via `t(shortcut.labelKey)` /
 * `t(SHORTCUT_GROUP_LABEL_KEYS[group])` in KeyboardShortcutsSettings.tsx and
 * QuickStart.tsx — a variable, not a string literal the extractor's static
 * analysis can see. `items.zoom-in-out` has no corresponding entry in
 * `KEYBOARD_SHORTCUTS` (it's `quickStartShortcutRows`'s synthetic combined
 * zoom-in/zoom-out row, QuickStart.tsx only).
 *
 * The `common:typedNameConfirm.messageCollection`/`messageDatabase` keys are
 * read through typedNameConfirm.ts's `confirmByTypedName` via
 * `t(defaultMessageKey)`, where `defaultMessageKey` is chosen by a ternary on
 * `opts.kind` — a variable, not a string literal the extractor's static
 * analysis can see. `common:typedNameConfirm.validationError` is read via a
 * literal `t('common:typedNameConfirm.validationError')` call in the same
 * file and needs no entry here.
 *
 * The `settings:updates.resultValues.*` keys are read through
 * updateCheckState.ts's `updateCheckResultLabel()` via
 * `t(updateCheckResultLabel(updateCheck.result))` in SettingsModal.tsx — the
 * key comes from a function's return value, not a string literal the
 * extractor's static analysis can see.
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
      'common:toast.querySaved',
      'common:toast.querySavedAndFavorited',
      'common:toast.couldNotSaveQuery',
      'common:toast.savedQueryDeleted',
      'common:toast.couldNotDeleteQuery',
      'common:toast.defaultQuerySet',
      'common:toast.couldNotSetDefault',
      'common:toast.defaultQueryCleared',
      'common:toast.couldNotClearDefault',
      'common:toast.filterCleared',
      'common:toast.projectionCleared',
      'common:toast.sortCleared',
      'common:toast.openedInMongosh',
      'common:toast.copiedMongoshCommand',
      'transfer:restoreView.options.flags.drop',
      'transfer:restoreView.options.flags.keepIndexVersion',
      'transfer:restoreView.options.flags.noIndexRestore',
      'transfer:restoreView.options.flags.noOptionsRestore',
      'transfer:restoreView.options.flags.maintainInsertionOrder',
      'transfer:restoreView.options.flags.stopOnError',
      'transfer:restoreView.options.flags.bypassDocumentValidation',
      'transfer:restoreView.options.flags.restoreDbUsersAndRoles',
      'transfer:generateView.kindLabels.array',
      'transfer:generateView.kindLabels.bool',
      'transfer:generateView.kindLabels.date',
      'transfer:generateView.kindLabels.email',
      'transfer:generateView.kindLabels.firstName',
      'transfer:generateView.kindLabels.float',
      'transfer:generateView.kindLabels.int',
      'transfer:generateView.kindLabels.lastName',
      'transfer:generateView.kindLabels.literal',
      'transfer:generateView.kindLabels.lorem',
      'transfer:generateView.kindLabels.name',
      'transfer:generateView.kindLabels.object',
      'transfer:generateView.kindLabels.objectId',
      'transfer:generateView.kindLabels.pick',
      'transfer:generateView.kindLabels.uuid',
      'transfer:importView.columnTypes.auto',
      'transfer:importView.columnTypes.string',
      'transfer:importView.columnTypes.number',
      'transfer:importView.columnTypes.boolean',
      'transfer:importView.columnTypes.date',
      'admin:monitoringView.refreshOptions.5s',
      'admin:monitoringView.refreshOptions.10s',
      'admin:monitoringView.refreshOptions.30s',
      'admin:monitoringView.refreshOptions.1m',
      'admin:monitoringView.refreshOptions.off',
      'shell:keyboardShortcuts.groups.navigation',
      'shell:keyboardShortcuts.groups.query-editor',
      'shell:keyboardShortcuts.groups.sidebar',
      'shell:keyboardShortcuts.groups.zoom',
      'shell:keyboardShortcuts.groups.command-palette',
      'shell:keyboardShortcuts.items.close-dialog',
      'shell:keyboardShortcuts.items.run-query',
      'shell:keyboardShortcuts.items.submit-dialog',
      'shell:keyboardShortcuts.items.sidebar-search',
      'shell:keyboardShortcuts.items.zoom-in',
      'shell:keyboardShortcuts.items.zoom-out',
      'shell:keyboardShortcuts.items.zoom-reset',
      'shell:keyboardShortcuts.items.zoom-in-out',
      'shell:keyboardShortcuts.items.palette-open',
      'shell:keyboardShortcuts.items.palette-navigate',
      'shell:keyboardShortcuts.items.palette-run',
      'shell:keyboardShortcuts.items.palette-close',
      'common:typedNameConfirm.messageCollection',
      'common:typedNameConfirm.messageDatabase',
      'settings:updates.resultValues.uptodate',
      'settings:updates.resultValues.available',
      'settings:updates.resultValues.offline',
      'settings:updates.resultValues.checkFailed',
      // `shell:commandPalette.buckets.*.label` are read through CommandPalette.tsx's
      // `BUCKET_META` via `t(BUCKET_META[bucket].labelKey)` — a variable, not a
      // string literal the extractor's static analysis can see.
      'shell:commandPalette.buckets.commands.label',
      'shell:commandPalette.buckets.collections.label',
      'shell:commandPalette.buckets.queries.label',
      // `shell:toolSetupDialog.toolLabels.*` are read through ToolSetupDialog.tsx's
      // `toolLabel()` via `t(TOOL_LABEL_KEYS[name])` — a variable, not a string
      // literal the extractor's static analysis can see.
      'shell:toolSetupDialog.toolLabels.databaseTools',
      'shell:toolSetupDialog.toolLabels.mongosh',
      // `documents:documentViewer.builder.operators.*` and
      // `documents:documentViewer.pipeline.stageGroups.*` are read through
      // DocumentViewer.tsx's `OPERATORS`/`STAGE_OPERATORS` via `t(entry.labelKey)`
      // — a variable, not a string literal the extractor's static analysis can see.
      'documents:documentViewer.builder.operators.in',
      'documents:documentViewer.builder.operators.notIn',
      'documents:documentViewer.builder.operators.regex',
      'documents:documentViewer.builder.operators.exists',
      'documents:documentViewer.pipeline.stageGroups.filtering',
      'documents:documentViewer.pipeline.stageGroups.grouping',
      'documents:documentViewer.pipeline.stageGroups.ordering',
      'documents:documentViewer.pipeline.stageGroups.arraysJoins',
      'documents:documentViewer.pipeline.stageGroups.windows',
      'documents:documentViewer.pipeline.stageGroups.geospatial',
      'documents:documentViewer.pipeline.stageGroups.sourcesOutput',
      // `connections:colorTags.*` are read through connectionColors.ts's
      // `CONNECTION_COLOR_PALETTE` via `t(swatch.labelKey)` in
      // ConnectionManager.tsx — a variable, not a string literal the
      // extractor's static analysis can see.
      'connections:colorTags.red',
      'connections:colorTags.orange',
      'connections:colorTags.amber',
      'connections:colorTags.green',
      'connections:colorTags.blue',
      'connections:colorTags.violet',
      'connections:colorTags.pink',
      'connections:colorTags.slate',
      // `settings:appearance.presets.*` are read through themes/presets.ts's
      // `THEME_PRESETS` via `presetName(preset, t)` and
      // `t(preset.descriptionKey)` in AppearanceSettings.tsx and
      // ThemePicker.tsx — again a variable, never a literal. Only the three
      // DESCRIPTIVE presets have a `.name` key; the other five carry a
      // verbatim proper name (Nord, Solarized…) and no key at all.
      'settings:appearance.presets.mqlensDark.description',
      'settings:appearance.presets.mqlensLight.description',
      'settings:appearance.presets.highContrast.name',
      'settings:appearance.presets.highContrast.description',
      'settings:appearance.presets.nord.description',
      'settings:appearance.presets.solarizedDark.description',
      'settings:appearance.presets.solarizedLight.description',
      'settings:appearance.presets.githubDark.description',
      'settings:appearance.presets.githubLight.description',
      // `documents:documentViewer.errors.invalidQuery`/`queryMustBeObject` are
      // reached through shellDoc.ts's `shellDocErrorKey(err)`, which maps a
      // thrown error's `code` to a key — a function return value, not a string
      // literal the extractor's static analysis can see. The codes exist so the
      // thrown English message never reaches the user: it used to be
      // interpolated verbatim into the translated "Ungültige JSON-Syntax: …"
      // wrapper.
      'documents:documentViewer.errors.invalidQuery',
      'documents:documentViewer.errors.queryMustBeObject',
    ],
  },
});
