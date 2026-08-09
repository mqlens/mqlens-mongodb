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
  'common:ok', // OK — universal loanword, never translated in German software UI
  'settings:appearance.system', // System
  'settings:language.system', // System
  'sidebar:tree.systemLabel', // System
  'settings:appearance.themeFallback', // Theme
  'sidebar:footer.themeLabel', // Theme
  'settings:mcp.port', // Port
  'settings:updates.resultValues.offline', // Offline — established loanword, matches shell:updatePrompt.toast.offline's "offline" usage
  'settings:tools.tabLabel', // Tools
  'shell:watch.status.running', // live — the loanword German uses for a running stream too
  'shell:watch.columns.collection', // Collection — MongoDB's own term, left untranslated in the German UI
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
  // Connection colour-tag names whose German spelling IS the English one. The
  // other six in the same set are genuinely translated (Rot, Bernstein, Grün,
  // Blau, Violett, Schiefer), so this is a property of these two words, not a
  // skipped namespace.
  'connections:colorTags.orange', // Orange
  'connections:colorTags.pink', // Pink
  // Kerberos-protocol-specific term (RFC 4120), kept untranslated like "Realm"
  'connections:auth.userLabelKerberos', // Principal
  // Feature/tab name shared with the (currently English-only, out-of-scope)
  // Dump view — see settings:tools.dbToolsDescription. `sidebar:ctx.restore`
  // used to share this exemption too, but the Restore view (transfer:
  // restoreView.title / common:tabs.restore) is translated on this branch —
  // its German value ("Wiederherstellung (mongorestore)…") is genuinely
  // translated now, so it no longer needs (or qualifies for) this allowlist.
  'sidebar:ctx.dump', // Dump (mongodump)…
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
  // admin namespace (Task 3): loanwords, product names, technical unit
  // abbreviations and pure-interpolation fragments, identical spelling in
  // both languages.
  'admin:monitoringView.title', // Monitoring — established German loanword for ops/infra monitoring
  'admin:monitoringView.tabs.opsCount_one', // " ({{count}})" — punctuation + interpolation only
  'admin:monitoringView.tabs.opsCount_other', // " ({{count}})" — punctuation + interpolation only
  'admin:monitoringView.tabs.profiler', // Profiler — established loanword
  'admin:monitoringView.labels.opid', // opid — literal MongoDB currentOp field name, never translated
  'admin:monitoringView.labels.ns', // ns — literal MongoDB currentOp field name, never translated
  'admin:monitoringView.tabs.cluster', // Cluster — explicitly a kept loanword per the terminology brief
  'admin:monitoringView.status.hostVersion', // "{{host}} · MongoDB {{version}}" — product name + interpolation only
  'admin:monitoringView.status.replSetClause', // " · {{replSet}}" — pure interpolation, matches sidebar:tree.offlineSuffix pattern
  'admin:monitoringView.refreshOptions.5s', // time-unit abbreviation, identical in German
  'admin:monitoringView.refreshOptions.10s', // time-unit abbreviation, identical in German
  'admin:monitoringView.refreshOptions.30s', // time-unit abbreviation, identical in German
  'admin:monitoringView.refreshOptions.1m', // time-unit abbreviation, identical in German
  'admin:monitoringView.metrics.cache', // Cache — established loanword
  'admin:monitoringView.metrics.networkPerSecond', // "{{value}}/s" — unit suffix + interpolation only
  'admin:monitoringView.filters.msSuffix', // ms — SI unit abbreviation, identical in German
  'admin:monitoringView.cluster.summaryVersionClause', // " · MongoDB {{version}}" — product name + interpolation only
  'admin:monitoringView.cluster.table.ping', // Ping — established loanword
  'admin:indexViewer.badges.index', // Index — established capitalized loanword (see #234's "indizes" bug)
  'admin:indexViewer.cards.definition', // Definition — identical spelling in German
  'admin:indexModal.constraintLabels.sparse', // Sparse — kept MongoDB technical term, same rationale as Cluster/Bucket
  'admin:statsCards.indexStats.index', // Index: — established loanword + colon, matches connections:profile.status
  'admin:clusterHealthCard.memberStatus.onlinePrimary', // "— Online [PRIMARY]" — Online loanword + raw replica-set state identifier
  'admin:clusterHealthCard.memberStatus.onlinePrefix', // "— Online [{{state}}] · " — Online loanword + raw interpolation, nothing to translate
  // "Capped collection" is established MongoDB terminology (like Cluster,
  // Bucket, Shell, mongosh, GridFS) — kept as the loanword rather than
  // translated to a native German word.
  'admin:statsCards.collStats.labels.capped', // Capped
  // shell namespace (Task 4): loanwords, product names, literal mongosh
  // command syntax and pure-interpolation fragments, identical in both languages.
  // These are the actual mongosh method-call syntax lines in the shell's
  // "help" console output — code the user types verbatim, not prose.
  'shell:mongoShell.help.findSyntax', // db.<coll>.find(<query>).sort(<sort>).skip(n).limit(n)
  'shell:mongoShell.help.findOneSyntax', // db.<coll>.findOne(<query>)
  'shell:mongoShell.help.aggregateSyntax', // db.<coll>.aggregate([...])
  'shell:mongoShell.help.countDocumentsSyntax', // db.<coll>.countDocuments(<query>)
  'shell:mongoShell.help.getIndexesSyntax', // db.<coll>.getIndexes()
  'shell:mongoShell.gate.foundMongoshVersion', // "mongosh {{version}}" — loanword + interpolation only
  'shell:statusBar.cpu', // "CPU {{value}}" — acronym + interpolation only
  'shell:statusBar.ram', // "RAM {{value}}" — acronym + interpolation only
  'shell:statusBar.mongodb', // "MongoDB {{value}}" — product name + interpolation only
  'shell:statusBar.appVersion', // "MQLens {{version}}" — product name + interpolation only
  'shell:toolSetupDialog.toolLabels.databaseTools', // Database Tools (mongodump, mongorestore) — product name + literal binary names
  'shell:toolSetupDialog.toolLabels.mongosh', // mongosh — established loanword
  'shell:toolSetupDialog.pathSuffix', // " — {{path}}" — punctuation + interpolation only
  'shell:connectionCard.badge.srv', // SRV — DNS record type acronym
  'shell:connectionCard.badge.ssh', // SSH — protocol acronym
  // Task 6 (final review fixes): shell:keyboardShortcuts.groups.* — identical
  // German cognate/loanwords ("Navigation" and "Zoom" are spelled identically).
  // `groups.sidebar` used to sit here as a claimed loanword, but it was the
  // heading directly above rows that say "Seitenleiste" — the exemption was
  // preserving the last inconsistency in a sweep that had translated everything
  // around it. It is "Seitenleiste" now and no longer qualifies.
  'shell:keyboardShortcuts.groups.navigation', // Navigation
  'shell:keyboardShortcuts.groups.zoom', // Zoom
  // Task 5: workspace tab labels that are pure interpolation of an
  // identifier (collection/db name) with no surrounding prose to translate.
  'common:tabs.export', // "Export: {{collection}}" — matches transfer:exportView.title's Export loanword
  'common:tabs.import', // "Import: {{collection}}" — matches transfer:importView.title's Import loanword
  'common:tabs.schema', // "Schema: {{collection}}" — pure interpolation, label prefix is a raw MongoDB term
  'common:tabs.gridfs', // "GridFS: {{collection}}" — GridFS is a MongoDB product name, never translated
  'common:tabs.dump', // "Dump: {{name}}" — established MongoDB technical term, matches transfer:dumpView.title
  // Command palette action keywords (Task 5 additional scope): "tab" is the
  // established German loanword for a UI tab, matches transfer:exportView.labels.tab.
  'shell:commandPalette.paletteActions.closeTab.keywords', // tab
  // Task 6 (coverage gate triage): "in" is the established short
  // set-membership operator keyword in the filter-builder's operator
  // dropdown (mirrors SQL's untranslated "IN"), identical spelling in German.
  'documents:documentViewer.builder.operators.in', // in
  // Final whole-branch review: terms an independent German reviewer flagged as
  // wrongly translated. Each was German and is now deliberately English.
  //
  // Index/sort direction keywords. The German build shipped invented
  // abbreviations ("AUFST." / "ABST.") that no German DBA would recognise;
  // ASC/DESC are language-neutral. The spelled-out forms elsewhere
  // (indexModal.options.ascending = "Aufsteigend (1)") stay German — it is the
  // abbreviated keyword form that must not be localised.
  'admin:indexViewer.direction.asc', // ASC (1)
  'admin:indexViewer.direction.desc', // DESC (-1)
  // Not labels: a syntax demonstration of dot notation, rendered in a
  // font-mono input. "Feldpfad" removed the only hint that nested paths work.
  'documents:documentViewer.builder.fieldPathPlaceholder', // field.path
  'admin:indexModal.placeholders.fieldPath', // field.path
  // Literal $currentOp / system.profile document keys, shown beside the raw
  // values MongoDB returns. `ns` and `opid` were already left alone; these
  // three were translated, which broke the mapping to the server's own output.
  'admin:monitoringView.labels.op', // op
  'admin:monitoringView.labels.desc', // desc
  'admin:monitoringView.labels.running', // running
  // Log-level token in a fixed-width mono log row, next to "ok".
  'settings:mcp.err', // ERR
  // Update-channel identifiers, as used by the update feed itself. "Dev" was
  // already English; "Stabil" made the pair inconsistent.
  'settings:updates.stable', // Stable
  // MongoDB command name, sitting next to the "Aggregation" tab which is
  // likewise untranslated. "Suche" also collided with the sidebar/palette
  // search vocabulary.
  'documents:documentViewer.tabs.find', // Find
  // Topology term the user picks in the connection editor
  // (connections:form.topologyStandalone = "Standalone / Direkt"); reporting it
  // back as "Eigenständig" meant the label never matched the choice.
  'shell:connectionCard.topology.standalone', // Standalone
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

  it('addresses the German user informally (du), never formally (Sie)', async () => {
    // The German catalog settled on informal address across every surface —
    // destructive confirms, the vault gate, Quick Start, Settings. Nothing
    // enforced that, so it drifted: the final whole-branch review found two
    // formal-Sie strings ("Geben Sie eine … URI ein", "das Paket Ihrer
    // Distribution") sitting alone among ~25 du-form ones. Mixing the two
    // registers in one product reads as sloppy translation, and it is
    // invisible to every other guard here — both values are non-empty, differ
    // from English, and keep their placeholders.
    //
    // Heuristic, deliberately narrow: capitalised `Sie`/`Ihr…`/`Ihnen` are the
    // formal forms. Lowercase `sie` ("they"/"she") and sentence-initial `Sie`
    // are NOT matched, since a sentence can legitimately open with "Sie" in the
    // "they" sense. Add an entry below if a false positive ever appears.
    const ALLOWED_FORMAL = new Set<string>([]);
    // Capitalised Sie/Ihr…/Ihnen anywhere in the value. An earlier version
    // excluded value-initial and post-punctuation positions to avoid mistaking
    // a sentence-opening "Sie" ("they") for the formal address — but those are
    // exactly where formal address appears in toast and confirm copy
    // ("Sie können diese Aktion nicht rückgängig machen.", "Achtung! Ihre
    // Daten gehen verloren."), so the guard missed its own target shapes.
    // Lowercase `sie`/`ihre` ("they"/"her") are still correctly ignored; a
    // genuine "Sie"-as-they false positive goes on ALLOWED_FORMAL above.
    const FORMAL = /\b(?:Sie|Ihre?[nmrs]?|Ihnen)\b/;
    const offenders: string[] = [];
    for (const ns of NAMESPACES) {
      const de = await load('de', ns);
      for (const key of keysOf(de)) {
        const val = valueAt(de, key);
        if (typeof val !== 'string') continue;
        if (FORMAL.test(val) && !ALLOWED_FORMAL.has(`${ns}:${key}`)) {
          offenders.push(`${ns}:${key} — "${val}"`);
        }
      }
    }
    expect(
      offenders,
      `de uses formal address (Sie/Ihr) where the rest of the catalog uses du:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('registers every SUPPORTED_LOCALES code as an i18next resource, and nothing else', () => {
    const resourceCodes = Object.keys(resources).sort();
    const supportedCodes = SUPPORTED_LOCALES.map((l) => l.code).sort();
    // Without this, adding a locale to the picker (SUPPORTED_LOCALES) without
    // wiring its catalogs into `resources` renders 100% English with every
    // other check here still green.
    expect(resourceCodes).toEqual(supportedCodes);
  });

  it('wires each locale to its OWN catalogs, not another locale’s', async () => {
    // The check above compares only the KEY NAMES of `resources`, which made it
    // near-vacuous: pointing `resources.de.admin` at the English admin catalog
    // — every Monitoring, Index Viewer and Cluster Health string silently
    // English in the German build — passed all of these tests and tsc, because
    // every other check here reads the JSON off disk and never looks at what
    // i18next was actually handed. Compare the registered object to the file it
    // is supposed to be.
    for (const { code } of SUPPORTED_LOCALES) {
      for (const ns of NAMESPACES) {
        const registered = (resources as Record<string, Record<string, unknown>>)[code][ns];
        expect(
          registered,
          `resources.${code}.${ns} is not wired to src/locales/${code}/${ns}.json`,
        ).toEqual(await load(code, ns));
      }
    }
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
