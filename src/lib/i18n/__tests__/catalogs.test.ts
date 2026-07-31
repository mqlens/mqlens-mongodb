import { describe, it, expect } from 'vitest';
import { SUPPORTED_LOCALES } from '../locales';
import { NAMESPACES, resources } from '../index';
import i18nextExtractConfig from '../../../../i18next.config';

// Flatten a catalog to dotted key paths so nesting differences surface too.
const keysOf = (obj: Record<string, unknown>, prefix = ''): string[] =>
  Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? keysOf(v as Record<string, unknown>, `${prefix}${k}.`)
      : [`${prefix}${k}`],
  );

const load = async (locale: string, ns: string) =>
  (await import(`../../../locales/${locale}/${ns}.json`)).default as Record<string, unknown>;

const valueAt = (cat: Record<string, unknown>, key: string) =>
  key.split('.').reduce<any>((o, part) => o?.[part], cat);

const OTHER_LOCALES = SUPPORTED_LOCALES.filter((l) => l.code !== 'en');

// German values that are legitimately identical to their English source:
// loanwords, proper nouns, product names, and protocol/format identifiers
// that a German-speaking developer would recognise unchanged. Anything not
// on this list that matches English is presumed untranslated — translate
// it, don't add it here without checking it really is a loanword.
//
// Keyed by `namespace:key.path` (not by bare value!) so an exemption only
// covers the exact key that earned it. A value being a loanword at one key
// says nothing about a *different* key that happens to share the same
// English text — e.g. "Export" is a fine German loanword for a button label,
// but a future namespace could ship an untranslated "Export" that should
// fail this check. Add one entry per key, even if several keys share a
// value.
const ALLOWED_IDENTICAL_VALUES = new Set([
  // Product / brand names
  'common:appName', // MQLens
  'settings:tools.dbToolsTitle', // MongoDB Database Tools
  // Established German loanwords (identical spelling in both languages)
  'settings:appearance.system', // System
  'settings:language.system', // System
  'sidebar:tree.systemLabel', // System
  'settings:appearance.themeFallback', // Theme
  'sidebar:footer.themeLabel', // Theme
  'settings:mcp.port', // Port
  'settings:tools.tabLabel', // Tools
  'settings:updates.tabLabel', // Updates
  'connections:connectionMode.normal.label', // Normal
  'connections:filePicker.textFilter', // Text
  'connections:profile.status', // Status:
  'connections:tabs.proxy', // Proxy
  'connections:tabs.server', // Server
  'sidebar:tree.offlineSuffix', // ' · offline'
  // Acronyms / format & protocol identifiers, never translated
  'settings:mcp.tabLabel', // MCP
  'connections:filePicker.jsonFilter', // JSON
  'documents:dataGrid.viewModes.json', // JSON
  'connections:form.uriBadge', // URI
  'connections:tabs.tls', // TLS / SSL
  'connections:auth.methodScram1', // SCRAM-SHA-1
  'connections:auth.methodAws', // MONGODB-AWS (IAM)
  'connections:auth.methodKerberos', // GSSAPI (Kerberos)
  'connections:auth.methodLdap', // LDAP (PLAIN)
  'connections:advanced.compressionSnappy', // Snappy
  'connections:advanced.compressionZlib', // Zlib
  // Kerberos-protocol-specific term (RFC 4120), kept untranslated like "Realm"
  'connections:auth.userLabelKerberos', // Principal
  // Feature/tab names shared with the (currently English-only, out-of-scope)
  // Dump/Restore views — see settings:tools.dbToolsDescription
  'sidebar:ctx.dump', // Dump (mongodump)…
  'sidebar:ctx.restore', // Restore (mongorestore)…
  // Literal default value for the GridFS bucket prefix, not UI copy
  'sidebar:dialogs.gridfsBucket.bucketDefault', // fs
  // Literal default value for the initial-collection prompt, not UI copy —
  // it is written straight to create_collection, so it must never be a
  // translated word.
  'sidebar:dialogs.initialCollection.defaultValue', // collection
  // documents namespace (Task 1): more established German loanwords/cognates
  // and technical identifiers, identical spelling in both languages.
  'documents:documentViewer.actions.export', // Export
  'documents:documentViewer.actions.import', // Import
  'documents:documentViewer.tabs.aggregation', // Aggregation
  // Query-option labels mirroring the MongoDB find() option names — kept as
  // the established loanword/keyword, distinct from the explain-plan stage
  // name of the same concept (dataGrid:explain.stage.limit/skip), which is
  // translated prose and NOT exempted here.
  'documents:findQueryBar.labels.limit', // Limit
  'documents:findQueryBar.labels.skip', // Skip
  'documents:chartView.actions.exportPng', // PNG
  'documents:schemaView.labels.schemaPrefix', // Schema:
  'documents:dataGrid.actions.schema', // Schema
  // Literal mongosh-style method-name prefix + raw interpolated query JSON
  // (documentViewer:history.findSummary) — "find" mirrors db.collection.find()
  // and the rest is the user's own filter re-serialized, nothing to translate.
  'documents:documentViewer.history.findSummary', // find · {{filter}}
  // dataGrid:explain.labels.indexNode — "Index" is the established capitalized
  // loanword and the rest is pure interpolation, nothing left to translate.
  'documents:dataGrid.explain.labels.indexNode', // Index: {{indexName}}
  // transfer namespace (Task 2): loanwords, established query-option terms and
  // MongoDB/Extended-JSON technical mode names, identical spelling in both languages.
  'transfer:exportView.title', // Export
  'transfer:exportView.labels.format', // Format
  'transfer:exportView.labels.relaxed', // Extended JSON mode name ("Relaxed Mode")
  'transfer:exportView.labels.canonical', // Extended JSON mode name ("Canonical Mode")
  'transfer:exportView.labels.tab', // Tab
  'transfer:exportView.labels.lf', // LF (\n) — line-ending acronym
  'transfer:exportView.labels.crlf', // CRLF (\r\n) — line-ending acronym
  'transfer:exportView.labels.skip', // Established loanword, matches documents:findQueryBar.labels.skip
  'transfer:exportView.labels.limit', // Established loanword, matches documents:findQueryBar.labels.limit
  'transfer:exportView.filtered.pipeline', // Pipeline
  'transfer:generateView.kindLabels.objectId', // ObjectId — BSON type name, established loanword
  'transfer:generateView.kindLabels.uuid', // UUID — acronym
  'transfer:generateView.labels.seedOptional', // Seed (optional) — both words used unchanged in German tech writing
  'transfer:generateView.tooltips.maximum', // Maximum — identical spelling in German
  'transfer:generateView.tooltips.minimum', // Minimum — identical spelling in German
  'transfer:importView.title', // Import — established loanword, matches documents:documentViewer.actions.import
  'transfer:importView.actions.import', // Import — established loanword, matches documents:documentViewer.actions.import
  'transfer:importView.labels.format', // Format — matches transfer:exportView.labels.format
  'transfer:importView.csv.tab', // Tab — matches transfer:exportView.labels.tab
  'transfer:dumpView.title', // Dump — established MongoDB technical term ("Datenbank-Dump"), not translated
  'transfer:copyToDialog.labels.filter', // Filter (EJSON, optional) — every word is an unchanged German loanword/acronym
  // Kept as the English loanword on purpose: "Editor" would collide with the
  // Raw tab, which is the pane that actually hosts the code editor.
  'transfer:generateView.tabs.builder', // Builder
]);

describe('locale catalogs', () => {
  it('every locale has every namespace with identical key sets', async () => {
    for (const ns of NAMESPACES) {
      const en = keysOf(await load('en', ns)).sort();
      for (const { code } of OTHER_LOCALES) {
        const other = keysOf(await load(code, ns)).sort();
        // Both directions: a missing key means untranslated copy; an extra key
        // means a stale entry left behind by a rename.
        expect(other, `${code}/${ns}.json is missing keys present in en`).toEqual(en);
      }
    }
  });

  it('has no empty translations', async () => {
    for (const ns of NAMESPACES) {
      for (const { code } of SUPPORTED_LOCALES) {
        const cat = await load(code, ns);
        const empty = keysOf(cat).filter((k) =>
          k.split('.').reduce<any>((o, part) => o?.[part], cat) === '',
        );
        expect(empty, `${code}/${ns}.json has empty values`).toEqual([]);
      }
    }
  });

  it('has no non-English value byte-identical to English outside the allowlist', async () => {
    for (const ns of NAMESPACES) {
      const en = await load('en', ns);
      for (const { code } of OTHER_LOCALES) {
        const other = await load(code, ns);
        const suspicious = keysOf(en).filter((k) => {
          const enVal = valueAt(en, k);
          const otherVal = valueAt(other, k);
          return (
            typeof enVal === 'string' &&
            enVal === otherVal &&
            !ALLOWED_IDENTICAL_VALUES.has(`${ns}:${k}`)
          );
        });
        expect(
          suspicious,
          `${code}/${ns}.json has values identical to en that aren't on the allowlist ` +
            `(likely untranslated): ${suspicious.join(', ')}`,
        ).toEqual([]);
      }
    }
  });

  it('registers every SUPPORTED_LOCALES code as an i18next resource, and nothing else', () => {
    const resourceCodes = Object.keys(resources).sort();
    const supportedCodes = SUPPORTED_LOCALES.map((l) => l.code).sort();
    // Without this, adding a locale to the picker (SUPPORTED_LOCALES) without
    // wiring its catalogs into `resources` renders 100% English with every
    // other check here still green.
    expect(resourceCodes).toEqual(supportedCodes);
  });

  it('keeps {{placeholder}} tokens identical between en and every other locale', async () => {
    const tokensOf = (s: string) =>
      Array.from(s.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g))
        .map((m) => m[1])
        .sort();
    for (const ns of NAMESPACES) {
      const en = await load('en', ns);
      for (const { code } of OTHER_LOCALES) {
        const other = await load(code, ns);
        for (const key of keysOf(en)) {
          const enVal = valueAt(en, key);
          const otherVal = valueAt(other, key);
          if (typeof enVal !== 'string' || typeof otherVal !== 'string') continue;
          expect(
            tokensOf(otherVal),
            `${code}/${ns}.json:${key} interpolation placeholders don't match en ("${enVal}" vs "${otherVal}")`,
          ).toEqual(tokensOf(enVal));
        }
      }
    }
  });

  it('keeps a snapshot of which values carry significant leading/trailing whitespace, per locale', async () => {
    // Some values are sentence fragments meant to be concatenated with a
    // sibling key at render time (e.g. connections:ssh.hostKeyNoteSuffix,
    // sidebar:tree.offlineSuffix) and depend on a leading/trailing space a
    // formatter would silently eat. This isn't compared across locales — word
    // order means a language can legitimately need the space where English
    // doesn't (German's hostKeyNoteSuffix opens with a space before the
    // verb "stehen"; English's opens directly on the period, no space
    // needed). Each locale's own set of whitespace-significant keys is
    // snapshotted instead, so an accidental trim shows up as a snapshot diff
    // no matter which locale it happens in.
    for (const { code } of SUPPORTED_LOCALES) {
      for (const ns of NAMESPACES) {
        const cat = await load(code, ns);
        const flagged = keysOf(cat)
          .filter((k) => {
            const v = valueAt(cat, k);
            return typeof v === 'string' && (/^\s/.test(v) || /\s$/.test(v));
          })
          .sort();
        expect(flagged, `${code}/${ns}.json`).toMatchSnapshot();
      }
    }
  });

  it('resolves every key referenced only through a variable (labelKey/descriptionKey/nameKey/summaryKey/hintKey/notify()) against en', async () => {
    // These are the same string literals the i18next-cli static extractor
    // cannot see (the reference at the call site is a variable holding a key
    // name, not a string literal passed directly to the translate function),
    // so they are hand-listed in i18next.config.ts's preservePatterns to
    // survive extraction instead of being pruned as "unused". If one of them
    // is a typo, nothing else in this suite or in extraction catches it — it
    // would render a raw "namespace:key" string in production instead of copy.
    const patterns = i18nextExtractConfig.extract?.preservePatterns ?? [];
    expect(patterns.length).toBeGreaterThan(0);

    const catalogs = new Map<string, Record<string, unknown>>();
    for (const ns of NAMESPACES) catalogs.set(ns, await load('en', ns));

    for (const pattern of patterns) {
      const sep = pattern.indexOf(':');
      const ns = sep === -1 ? 'common' : pattern.slice(0, sep);
      const key = sep === -1 ? pattern : pattern.slice(sep + 1);
      const cat = catalogs.get(ns);
      expect(cat, `preservePatterns entry "${pattern}" references unknown namespace "${ns}"`).toBeTruthy();
      const val = valueAt(cat!, key);
      expect(typeof val, `preservePatterns entry "${pattern}" does not resolve to a string in en catalogs`).toBe(
        'string',
      );
    }
  });
});
