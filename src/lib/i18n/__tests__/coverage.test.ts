import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * i18n coverage gate.
 *
 * The plan that drove Tasks 1-5 (see docs/superpowers/plans/2026-07-31-i18n-complete-de.md)
 * was scoped using a JSX-text-only regex (`/>[A-Z][a-z][^<>{}]{2,60}</`). That
 * heuristic undercounted every task — 91/108/92/54 estimated strings became
 * 239/282/296/196 actually-translated keys — and, most tellingly, missed the
 * *entire* workspace tab context menu ("Duplicate Tab", "Detach to New
 * Window", `Move to ${target}`) across all five conversion tasks, because
 * those strings are template literals and object-literal prop values, which
 * a JSX-text-only regex cannot see.
 *
 * This gate is deliberately broader. In addition to JSX text nodes, it scans:
 *   - label-ish JSX attributes with a string-literal value — `placeholder=`,
 *     `aria-label=`, `alt=`, `description=`, `message=`, `tooltip=` and
 *     anything ending in `label`/`title`/`text`, so `confirmLabel=` counts —
 *     including values behind a ternary/`??` expression
 *     (`aria-label={show ? 'Hide password' : 'Show password'}`)
 *   - template literals that contain prose (not just `${}` interpolation of
 *     an identifier)
 *   - string literals assigned to label-ish object properties, same name set
 *     as the attributes above (`label:`, `confirmLabel:`, `emptyText:`, …)
 *   - JSX text nodes that mix prose with a `{}` interpolation
 *     (`<p>Not connected to {profileName}.</p>`), not just plain text runs
 *   - `identifier ?? 'Fallback prose'` nullish-coalescing default values
 *   - `window.confirm(...)`, `window.alert(...)`, `window.prompt(...)` arguments
 *   - the first argument of this project's own copy-bearing helpers —
 *     `toast(...)`, `notify(...)`, `setError(...)`, `setHint(...)`
 *   - bare `return 'prose'` / `throw new Error('prose')` string literals, the
 *     shape user-facing validation messages take in plain `.ts` modules
 *     (`validateMongoUri()`)
 *
 * KEEP THIS LIST HONEST. An earlier revision described five detectors that had
 * never been implemented — every regex was unchanged — so the gate read green
 * while asserting far less than its own documentation claimed. If you add a
 * bullet here, add the regex; if you change a regex, change the bullet.
 *
 * The plan-era gate also only walked `.tsx`, leaving every plain `.ts` module
 * (`src/lib/**`, `src/workspace/*.ts`, …) structurally invisible to it — a
 * whole untranslated `validateMongoUri()` error string and an untranslated
 * `?? 'Saved query'` fallback label lived there, undetected, until this
 * revision. It now walks `.ts` too (see `isScannableFile` below).
 *
 * It is still a heuristic, not an AST parser. Comments are blanked before
 * scanning (see `blankComments`), but it can still be fooled by regex literals
 * containing backticks, by a loose `>…<` run straddling a generic, and by
 * Tailwind class strings assigned to an unluckily-named property
 * (`label: 'text-primary'`). Every hit below was
 * manually triaged; each exemption below carries the reason it survived
 * triage instead of being translated. See
 * .superpowers/sdd/task-6-report.md for the full triage log.
 */

// Scans the whole `src` tree (not just `src/components`) — the gate used to
// stop at `src/components`, which left `src/App.tsx` and `src/workspace/*.tsx`
// (the tab context menu that motivated this whole task lives in App.tsx)
// structurally invisible to it. `__tests__` and `test/` hold test code, not
// UI copy, so they're walked past.
const SCAN_DIR = 'src';
const EXCLUDED_DIR_NAMES = new Set(['__tests__', 'test']);

// The gate used to walk `.tsx` only, which left every plain `.ts` module —
// `src/lib/**` in particular — structurally invisible to it: a whole
// untranslated `validateMongoUri()` error string and an untranslated
// `?? 'Saved query'` fallback label lived there undetected (see the
// coverage-gate triage log in .superpowers/sdd/task-6-report.md). `.d.ts`
// files are type-only (no runtime string literals, nothing to translate).
const SCANNED_EXTENSIONS = ['.tsx', '.ts'];
const isScannableFile = (name: string) =>
  SCANNED_EXTENSIONS.some((ext) => name.endsWith(ext)) && !name.endsWith('.d.ts');

/** Files that render no user-facing prose at all (pure UI primitives that
 *  only pass through `children`/`className` props, or wrappers with zero
 *  string literals of their own). Kept intentionally tiny — prefer a
 *  per-string exemption in EXEMPT_HITS below over adding a file here. */
const EXEMPT_FILES = new Set<string>([
  // A driver-code generator, end to end: every string it holds is source code
  // emitted into the user's OWN program (`const client = new MongoClient(…)`,
  // `from pymongo import MongoClient`) for the Query Code tab. Translating any
  // of it would produce a program that does not compile. Exempt as a file
  // rather than string-by-string because there is no UI prose in it at all —
  // the language names above are the API surface of each driver.
  'src/lib/queryCodeGen.ts',
]);

/**
 * Per-file exemptions, keyed by the exact matched text so a genuinely new
 * untranslated string in an already-exempt file still fails the gate. Every
 * entry is commented with why it survived triage: Global Constraints 1 and 2
 * (never translate a value that crosses the Tauri boundary; never translate
 * an example value, product name, or non-prose literal), or a detector false
 * positive (the regex matched something that isn't prose at all).
 */
const EXEMPT_HITS: Record<string, string[]> = {
  // Connection form example values (Global Constraint 2) — the exact
  // hostnames/paths/ports a user would type, not translatable prose.
  'src/components/ConnectionManager.tsx': [
    // <Trans> fallback children for auth.externalNote — never rendered.
    '> Authenticates against the <',
    'placeholder="mongodb://localhost:27017"',
    'placeholder="rs0"',
    'placeholder="admin"',
    'placeholder="••••••••"',
    'placeholder="mongodb"',
    'placeholder="/path/to/ca.pem"',
    'placeholder="ssh.server.com"',
    'placeholder="22"',
    'placeholder="deploy"',
    'placeholder="~/.ssh/id_ed25519"',
    'placeholder="proxy.internal"',
    'placeholder="1080"',
    'placeholder="username"',
    'placeholder="test"',
    // Stored profile default value, not UI copy (see the source comment at
    // its definition) — it is written straight into connection state and
    // must never be a translated word (Global Constraint 1's "sammlung" bug).
    "name: 'New Connection'",
  ],
  'src/components/CreateViewView.tsx': [
    // Example view name shown as a placeholder, not an instructional hint —
    // a plausible value the user might type, like ConnectionManager's examples.
    'placeholder="active_premium_customers"',
    // Example aggregation-pipeline JSON syntax.
    'placeholder=\'[{ "',
  ],
  'src/components/DataGrid.tsx': [
    // <Trans> fallback children for dataGrid.empty.explainHint — never
    // rendered; the catalog value is used in both locales.
    '> To generate one, open the <',
    '> dropdown split menu in the query editor toolbar and select <',
    // EJSON/BSON type constructor names rendered as mongosh-style syntax
    // (e.g. `ObjectId("...")`), matching real mongosh/EJSON output — MongoDB
    // type identifiers, not prose (Global Constraint 2).
    '>ObjectId<',
    '>NumberLong<',
    '>NumberDecimal<',
    '>NumberInt<',
    '>Double<',
    '>BinData<',
    '>Timestamp<',
    // <Trans i18nKey="dataGrid.empty.explainHint"> fallback children — never
    // rendered at runtime (the catalog value is used instead); see
    // en/documents.json dataGrid.empty.explainHint for the real, translated copy.
    '>Run Explain<',
    // Aggregation-pipeline stage key literal ($cursor), not a display label.
    "name: '$cursor'",
  ],
  'src/components/DocumentDiffModal.tsx': [
    // Same EJSON/BSON type constructor names as DataGrid.tsx above.
    '>ObjectId<',
    '>Timestamp<',
    '>NumberLong<',
    '>NumberDecimal<',
    '>NumberInt<',
    '>Double<',
    '>BinData<',
  ],
  'src/components/DocumentViewer.tsx': [
    // Comparison-operator symbols in the filter-builder dropdown — not
    // language, so nothing to translate (the word operators sharing this
    // array — in / not in / regex / exists — DO route through
    // documentViewer.builder.operators.* via labelKey; see OPERATORS above).
    "label: '='",
    "label: '!='",
    "label: '>'",
    "label: '>='",
    "label: '<'",
    "label: '<='",
  ],
  'src/components/ExportView.tsx': [
    // File-format names (Global Constraint 2), matching the "JSON"/"CSV"/
    // "BSON" precedent already on the catalogs.test.ts allowlist.
    "label: 'JSON'",
    "label: 'NDJSON'",
    "label: 'BSON'",
    "label: 'CSV'",
    "label: 'Excel'",
  ],
  'src/components/FindQueryBar.tsx': [
    // Example numeric value for the limit field, not prose.
    'placeholder="50"',
  ],
  'src/components/GenerateView.tsx': [
    // `$name` is the GEN_KIND_TOKENS DSL placeholder token (see the source
    // comment at its definition) — interpolated verbatim into translated
    // labels elsewhere, must never be translated itself (Global Constraint 1).
    "name: '$name'",
  ],
  'src/components/ImportView.tsx': [
    // File-format names, matching ExportView.tsx above.
    "label: 'JSON array'",
    "label: 'NDJSON'",
    "label: 'CSV'",
    "label: 'BSON'",
  ],
  'src/components/IndexModal.tsx': [
    // Example index-keys JSON syntax, matching CreateViewView's pipeline example.
    'placeholder=\'{ "',
  ],
  'src/components/MongoShell.tsx': [
    // <Trans> fallback children for destructiveDialog.body — never rendered.
    '> This script runs <',
    '>, which can permanently delete data. Review it before running. <',
    // Reproduces mongosh's own startup banner verbatim (see the source
    // comment at buildStartupLines) — real mongosh output is English-only
    // regardless of the host OS locale, so translating it would misrepresent
    // what the actual CLI tool prints. Matches the findSyntax/aggregateSyntax/
    // etc. mongosh-syntax exemptions already on the catalogs.test.ts allowlist.
    'Current Mongosh Log ID: ${logId}',
    'Connecting to: ${target}',
    'Using MongoDB: ${mongodbVersion}    Using Mongosh: ${mongoshVersion}',
  ],
  'src/components/SettingsModal.tsx': [
    // Product names, never translated (Global Constraint 2 / project glossary).
    '>Claude Code<',
    '>Cursor<',
    '>Anthropic<',
    '>OpenAI<',
    '>Google Gemini<',
    // Example paths, API-key formats and model names — copy-paste examples,
    // not prose.
    'placeholder="mongosh or /usr/local/bin/mongosh"',
    'placeholder="/usr/local/bin"',
    'placeholder="sk-ant-..."',
    'placeholder="claude-opus-4-8"',
    'placeholder="sk-..."',
    'placeholder="gpt-4o"',
    'placeholder="AIza..."',
    'placeholder="gemini-1.5-flash"',
    // Literal CLI command the user copies verbatim into their terminal.
    'claude mcp add --transport http mqlens http://127.0.0.1:${port}/mcp --header "Authorization: Bearer ${token}"',
  ],
  'src/components/dialogs/ToastStack.tsx': [
    // KIND_STYLES' `label` property holds a Tailwind text-color className,
    // not a display label — an unlucky property-name collision with the
    // detector's `label:` heuristic, not translatable prose.
    "label: 'text-emerald-700 dark:text-emerald-300'",
    "label: 'text-destructive'",
    "label: 'text-primary'",
  ],
  // ── <Trans> fallback children ────────────────────────────────────────────
  // The English text inside a <Trans i18nKey="…"> is a FALLBACK that react-i18next
  // never renders once the key resolves — the catalog value wins, in both
  // locales. These surfaced only after the JSX detector was widened to span
  // lines; each one's key is present and translated in de. (Same rationale as
  // the pre-existing DataGrid '>Run Explain<' entry below.)
  'src/components/AIChatPanel.tsx': [
    '> Ask for a query in plain language — e.g. <',
    '>. I’ll explain what I’m doing and you can insert the result. <',
  ],
  'src/components/UpdatePrompt.tsx': ['> is available. <'],

  // ── Developer-contract errors ────────────────────────────────────────────
  // `useX must be used within its Provider` fires only when a developer wires
  // a component up wrong; it can never reach an end user in a shipped build,
  // and translating it would make bug reports harder to search. Same class as
  // the `console.*` exclusion the template detector already applies.
  'src/components/dialogs/DialogProvider.tsx': [
    "throw new Error('useDialogs must be used within a <DialogProvider>'",
    // Detector false positive: `new Promise<…>` — the loose `>…<` text match
    // straddles a generic. "new" is a stopword and "Promise" is Title-Case, so
    // it clears the prose bar despite being pure code.
    '> new Promise<',
  ],
  'src/components/i18n/I18nProvider.tsx': [
    "throw new Error('useLocale must be used inside I18nProvider'",
  ],
  'src/components/theme/ThemeProvider.tsx': [
    'throw new Error("useTheme must be used within ThemeProvider"',
  ],
  'src/lib/themes/apply-theme.ts': [
    // Thrown when a hand-edited/corrupt theme config fails its schema check.
    // The `message` never reaches a user: AppearanceSettings.handleImport
    // catches it and renders its OWN translated string
    // (settings:appearance.importFailed) rather than the thrown text. Until
    // the final review this comment claimed the call site caught it, which was
    // simply untrue — handleImport had no try/catch at all, so a malformed
    // theme file threw into an async onchange and the user got no feedback.
    'throw new Error("Invalid theme configuration"',
  ],
  'src/workspace/workspaceStore.ts': [
    "throw new Error('hydrate is frontend-only and must never be mirrored to workspace_apply'",
  ],

  // ── Detector false positives ─────────────────────────────────────────────
  'src/lib/clusterHealth.ts': [
    // A backtick-quoted `new URL` inside a JSDoc comment, read as a template
    // literal — the comment blindness this file's header warns about.
    'new URL',
  ],
  'src/lib/generateTemplate.ts': [
    // The GEN_KIND_TOKENS DSL's own field token, matching the `$name`
    // exemption already recorded for GenerateView.tsx.
    "name: 'name'",
  ],
  'src/lib/mongoCompletions.ts': [
    // Monaco completion `insertText` payloads: the literal characters typed
    // into the editor (sort/projection values, an object opener), matched
    // only because the property detector now covers `…Text:` names.
    "insertText: '1'",
    "insertText: '0'",
    "insertText: '-1'",
    'insertText: \'{"',
    // Query/projection/sort syntax tokens offered by the editor's completion
    // list — MongoDB syntax, not prose (Global Constraint 2).
    "label: '_id'",
    "label: '1'",
    "label: '0'",
    "label: '-1'",
    "label: '$meta'",
  ],

  // ── Names that are the same in every language ────────────────────────────
  'src/lib/i18n/locales.ts': [
    // Endonyms: a language is always listed in its OWN language, so the German
    // build must still show "English", never "Englisch" — otherwise a user who
    // cannot read the current UI language cannot find their own.
    "label: 'English'",
    "label: 'Deutsch'",
  ],
  'src/lib/connectionFolders.ts': [
    // Default folder NAME, persisted to localStorage under a stable id and
    // editable by the user. Translating it would rewrite stored user data on a
    // language switch — the same hazard as ConnectionManager's 'New Connection'.
    "name: 'Local resources'",
  ],
  'src/lib/themes/presets.ts': [
    // Proper names kept verbatim, like the product names exempted in
    // SettingsModal.tsx. MQLens Dark/Light were briefly given a `nameKey` and
    // translated ("MQLens Dunkel"/"MQLens Hell"), which made the German picker
    // read half-translated — those two render beside five siblings whose names
    // are untranslated proper nouns. Only `High Contrast` keeps a `nameKey`,
    // because it is a description rather than a name.
    'name: "MQLens Dark"',
    'name: "MQLens Light"',
    'name: "Nord"',
    'name: "Solarized Dark"',
    'name: "Solarized Light"',
    'name: "GitHub Dark"',
    'name: "GitHub Light"',
  ],
  'src/components/ui/sonner.tsx': [
    // Sonner's `toastOptions.classNames.description` is a Tailwind className
    // slot, not translatable prose — same property-name collision as
    // ToastStack.tsx above.
    'description: "group-[.toast]:text-muted-foreground"',
  ],
};

const STOPWORDS = new Set([
  'the', 'and', 'or', 'to', 'of', 'in', 'is', 'are', 'not', 'this', 'that', 'with', 'for', 'from',
  'your', 'please', 'cannot', 'could', 'failed', 'error', 'no', 'yes', 'a', 'an', 'you', 'it',
  'will', 'can', 'must', 'has', 'have', 'was', 'were', 'be', 'been', 'if', 'when', 'on', 'at',
  'all', 'none', 'select', 'enter', 'choose', 'click', 'confirm', 'delete', 'remove', 'create',
  'new', 'open', 'close', 'save', 'cancel', 'continue', 'loading', 'load', 'success', 'warning',
]);

const isTitleCaseWord = (w: string) => /^[A-Z][a-z]{1,}$/.test(w);

/** The shared prose bar: text "contains prose" if it has at least two
 *  adjacent word-like tokens and at least one of them is a Title-Case word or
 *  a common English function word. This deliberately excludes Tailwind
 *  utility-class strings (`flex items-center gap-2 dark:bg-neutral-800`):
 *  every token in those is lowercase and none of them are English stopwords.
 *  It also excludes anything without a space — i18n key paths
 *  (`documents.emptyTitle`), URLs, file paths and CSS class names all fail the
 *  two-adjacent-tokens test, so no separate rejection list is needed. */
function hasProse(text: string): boolean {
  if (!/[A-Za-z]{2,}\s+[A-Za-z]{2,}/.test(text)) return false;
  const words = text.split(/\s+/).filter(Boolean);
  for (const w of words) {
    const clean = w.replace(/[^A-Za-z]/g, '');
    if (!clean) continue;
    if (isTitleCaseWord(clean)) return true;
    if (STOPWORDS.has(clean.toLowerCase())) return true;
  }
  return false;
}

/** A template literal is judged on its text with `${}` interpolations removed,
 *  so `` `Move to ${target}` `` is prose but `` `${a}${b}` `` is not. */
const templateHasProse = (raw: string) => hasProse(raw.replace(/\$\{[^}]*\}/g, ' '));

/** Plain JSX text nodes. The original `>[A-Z][a-z]…<` required a Title-Case
 *  word IMMEDIATELY after the `>`, which the final review showed missed most
 *  of what a developer actually writes: lowercase openings ("no documents
 *  matched"), acronyms ("URI is not valid"), one-letter words ("A newer
 *  version"), and — most commonly — any node prettier wrapped onto its own
 *  line. Now it accepts any run without `<>{}`, across newlines, and leans on
 *  `hasProse` to decide. `[^<>{}]` still excludes interpolations; JSX_MIXED_RE
 *  below handles those. */
const JSX_TEXT_RE = />([^<>{}]{4,200})</g;
/** JSX text nodes that MIX prose with a `{}` interpolation
 *  (`<p>Not connected to {profileName}.</p>`). JSX_TEXT_RE above excludes
 *  `{}` outright, so those nodes were invisible to it. Judged on the text with
 *  the interpolations stripped, exactly like a template literal.
 *
 *  The two guards keep this loose `>…<` shape from matching ordinary code once
 *  the gate started walking `.ts`: the lookbehind drops arrow functions and
 *  comparisons (`=>`, `>=`, `->`), and excluding newlines from the text run
 *  stops a generic's closing `>` from pairing with the NEXT line's `Record<`
 *  and swallowing the code in between. A real JSX text node is one line. */
const JSX_MIXED_RE = /(?<![=\-!<>])>([^<>\n]{2,160})</g;
/** Label-ish JSX attributes. The name pattern mirrors PROP_RE's: a camelCase
 *  prefix is allowed, so `confirmLabel=` / `emptyTitle=` match, not just
 *  `label=`. The old five-name list also let `description=`, `message=`,
 *  `heading=`, `tooltip=` and `emptyText=` through untouched. */
const ATTR_NAMES = String.raw`(?:[A-Za-z]*(?:[lL]abel|[tT]itle|[tT]ext)|aria-label|placeholder|alt|description|message|heading|tooltip|hint|subtitle)`;
const ATTR_RE = new RegExp(String.raw`\b${ATTR_NAMES}=\{?["']([^"']{2,160})["']\}?`, 'g');
/** The project's own toast/notify helpers take their user-facing copy as the
 *  FIRST positional argument, which no attribute or property detector can see:
 *  `toast('Failed to connect to the profile.', 'error')`. */
const CALL_ARG_RE =
  /\b(?:toast|notify|setError|setHint|setStatus)\(\s*(['"])([^'"]{4,200})\1/g;
/** Label-ish attributes whose value is an expression rather than a bare
 *  literal — a ternary or `??` chain
 *  (`aria-label={show ? 'Hide password' : 'Show password'}`). Every quoted
 *  literal inside the braces is then judged individually. */
const ATTR_EXPR_RE = new RegExp(String.raw`\b${ATTR_NAMES}=\{([^{}]{2,200})\}`, 'g');
/** `label:`/`title:` and their camelCase-prefixed variants (`confirmLabel:`,
 *  `cancelLabel:`, `ariaLabel:`) plus the other label-ish property names. The
 *  old `\b(?:label|title|…)` could not match `confirmLabel:` at all: there is
 *  no word boundary in the middle of `confirmLabel`, so every dialog's
 *  confirm/cancel button copy escaped the gate. */
const PROP_RE =
  /\b(?:[A-Za-z]*(?:[lL]abel|[tT]itle|[tT]ext)|name|description|hint|subtitle|placeholder|message|tooltip|body|heading):\s*['"]([^'"]{1,160})['"]/g;
const TEMPLATE_RE = /`([^`]*)`/g;
const WINDOW_DIALOG_RE = /window\.(?:confirm|alert|prompt)\(\s*(`[^`]*`|"[^"]*"|'[^']*')/g;
/** `identifier ?? 'Fallback prose'` default values (`item.label ?? 'Saved
 *  query'`) — a display string that only appears when the data is missing,
 *  which is exactly when nobody notices it is still English. */
const NULLISH_FALLBACK_RE = /\?\?\s*(['"])([^'"]{2,160})\1/g;
/** Bare `return 'prose'` / `throw new Error('prose')` literals. This is the
 *  shape a user-facing validation message takes in a plain `.ts` module —
 *  `validateMongoUri()` returns its error string directly — where none of the
 *  JSX/prop detectors above can see it. */
const RETURN_THROW_RE =
  /(?:return|throw new (?:Error|TypeError|RangeError)\()\s*(['"])([^'"]{2,200})\1/g;
/** Extracts the individual quoted literals out of an attribute expression. */
const QUOTED_RE = /(['"])([^'"]{2,200})\1/g;

/**
 * Replace every comment body with spaces, preserving length and newlines so
 * all downstream match indices still line up with the original source.
 *
 * The file header used to warn that the gate "can be fooled by comments", and
 * it was: a backtick-quoted `new URL` in a JSDoc block earned a permanent
 * exemption, and once JSX text nodes were allowed to span lines, ordinary
 * prose inside `{/* … *\/}` blocks started reporting too.
 *
 * String-aware on purpose. A naive strip would treat the `//` inside
 * `placeholder="mongodb://localhost:27017"` as a comment and eat the rest of
 * the line, silently breaking the triaged exemptions keyed on that exact text.
 */
function blankComments(src: string): string {
  const out = src.split('');
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (quote) {
      if (c === '\\') i += 2;
      else if (c === quote) (quote = null), i++;
      else i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') (quote = c), i++;
    else if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') (out[i] = ' '), i++;
    } else if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      for (; i < stop; i++) if (src[i] !== '\n') out[i] = ' ';
    } else i++;
  }
  return out.join('');
}

/** Code punctuation that effectively never appears in a UI text node but is
 *  everywhere in the generics and call expressions a loose `>…<` match would
 *  otherwise straddle (`useState<Foo>(null);`, `Promise<T> = [];`). */
const looksLikeCode = (s: string) => /[;=(){}[\]`]/.test(s);

function findHits(file: string, rawSrc: string): string[] {
  const src = blankComments(rawSrc);
  const hits: string[] = [];

  for (const m of src.matchAll(JSX_TEXT_RE)) {
    if (!looksLikeCode(m[1]) && hasProse(m[1])) hits.push(m[0].replace(/\s+/g, ' '));
  }
  for (const m of src.matchAll(ATTR_RE)) hits.push(m[0]);
  for (const m of src.matchAll(CALL_ARG_RE)) if (hasProse(m[2])) hits.push(m[0]);
  for (const m of src.matchAll(PROP_RE)) hits.push(m[0]);
  for (const m of src.matchAll(WINDOW_DIALOG_RE)) hits.push(m[0]);
  for (const m of src.matchAll(NULLISH_FALLBACK_RE)) if (hasProse(m[2])) hits.push(m[0]);
  for (const m of src.matchAll(RETURN_THROW_RE)) if (hasProse(m[2])) hits.push(m[0]);

  for (const m of src.matchAll(JSX_MIXED_RE)) {
    const inner = m[1];
    // Plain text runs are JSX_TEXT_RE's job; this detector exists only for
    // the mixed prose-plus-interpolation case. Requiring a `{}` also keeps
    // the loose `>…<` pattern from matching comparison operators and
    // generic-type brackets in plain `.ts` modules.
    if (!inner.includes('{')) continue;
    if (hasProse(inner.replace(/\{[^{}]*\}/g, ' '))) hits.push(m[0]);
  }

  for (const m of src.matchAll(ATTR_EXPR_RE)) {
    // Strip translation calls and judge whatever literals REMAIN. Skipping the
    // whole expression on sight of a translation call — the previous
    // behaviour — made the commonest half-migrated shape invisible: a ternary
    // with one branch translated and the other still English literal prose.
    // Removing just the calls keeps their key arguments (and any default-value
    // argument, which is translated by definition) out of the scan while
    // leaving the untranslated branch exposed. (Written without a literal
    // example call: i18next-cli extracts one even from inside a comment, which
    // would add a phantom key to en/common.json on every `npm run i18n:check`.)
    const withoutCalls = m[1].replace(/\bt\([^()]*\)/g, ' ');
    for (const q of withoutCalls.matchAll(QUOTED_RE)) if (hasProse(q[2])) hits.push(q[0]);
  }

  // Neutralize a lone backtick quoted as `'`'`/`"`"` (e.g. a shell
  // tokenizer's `ch === '`'`), which would otherwise be mistaken for a
  // template delimiter and swallow real code into a bogus "template
  // literal". Deliberately narrow — general quoted-string stripping would
  // misfire on ordinary prose apostrophes ("backend's", "doesn't") in
  // comments, consuming everything up to an unrelated later quote.
  const cleaned = src.replace(/'`'|"`"/g, '   ');
  for (const m of cleaned.matchAll(TEMPLATE_RE)) {
    const inner = src.slice(m.index! + 1, m.index! + m[0].length - 1);
    // A real UI-facing template literal is a short, single-expression
    // string. A multi-line, semicolon-heavy span this long means an odd
    // backtick elsewhere (e.g. inside a regex literal like `` `[^`]+` ``)
    // mispaired delimiters and swallowed real code — discard rather than
    // misreport it as a translatable string.
    const looksLikeCodeSpillover = inner.length > 200 || (inner.match(/\n/g) ?? []).length > 2;
    // console.*(...) arguments are developer-facing diagnostics, never
    // rendered in the UI — excluded categorically rather than per-string.
    const precedingContext = src.slice(Math.max(0, m.index! - 60), m.index!).trimEnd();
    const isConsoleCall = /console\.(?:log|warn|error|debug|info)\(\s*$/.test(precedingContext);
    if (!looksLikeCodeSpillover && !isConsoleCall && templateHasProse(inner)) hits.push(inner);
  }

  const exempt = new Set(EXEMPT_HITS[file] ?? []);
  return [...new Set(hits)].filter((h) => !exempt.has(h));
}

describe('i18n coverage', () => {
  it('has no untranslated user-facing strings in components', () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) {
          if (!EXCLUDED_DIR_NAMES.has(e.name)) walk(p);
        } else if (isScannableFile(e.name)) {
          // EXEMPT_FILES/EXEMPT_HITS are keyed with `/` (as written in this
          // file); `join()` yields `\` on Windows, which would silently stop
          // matching those lookups and fail the gate for every Windows
          // contributor on every already-triaged exemption. Normalize once,
          // here, rather than at each lookup site.
          files.push(p.split('\\').join('/'));
        }
      }
    };
    walk(SCAN_DIR);

    const offenders: string[] = [];
    for (const file of files) {
      if (EXEMPT_FILES.has(file)) continue;
      const src = readFileSync(file, 'utf8');
      const hits = findHits(file, src);
      if (hits.length) offenders.push(`${file}:\n  ${hits.join('\n  ')}`);
    }

    expect(offenders, `Untranslated user-facing strings found:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('never passes a pre-formatted (string) count to a t() call', () => {
    // i18next skips plural resolution entirely when `count` is not a number
    // (`needsPluralHandling = count !== undefined && !isString(count)`). A key
    // that exists only as `_one`/`_other` then misses the bare lookup and
    // i18next returns THE KEY PATH, which renders to the user as literal text.
    //
    // That shipped: MonitoringView passed
    // `count: status.connections.available.toLocaleString()`, so the
    // Connections tile read "monitoringView.metrics.connectionsAvail" in every
    // locale. Pass the number as `count` and send the formatted text in its
    // own placeholder.
    const STRINGY_COUNT = /\bcount:\s*([^,}\n]+)/g;
    const looksStringy = (expr: string) =>
      /\.toLocaleString\(|\.toString\(|\bString\(|^['"`]/.test(expr.trim());

    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) {
          if (!EXCLUDED_DIR_NAMES.has(e.name)) walk(p);
        } else if (isScannableFile(e.name)) {
          files.push(p.split('\\').join('/'));
        }
      }
    };
    walk(SCAN_DIR);

    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(STRINGY_COUNT)) {
        if (!looksStringy(m[1])) continue;
        // Only care when it is an argument to a translation call.
        const before = src.slice(Math.max(0, m.index! - 200), m.index!);
        if (!/\bt\(|<Trans\b/.test(before)) continue;
        offenders.push(`${file}: ${m[0].trim()}`);
      }
    }

    expect(
      offenders,
      `t() called with a non-numeric count — plural lookup will miss and render the raw key:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
