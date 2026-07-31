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
 *   - `title=`, `placeholder=`, `aria-label=`, `alt=`, `label=` JSX attributes
 *     with a string-literal value
 *   - template literals that contain prose (not just `${}` interpolation of
 *     an identifier)
 *   - string literals assigned to label-ish object properties (`label:`,
 *     `title:`, `name:`, `description:`, `hint:`, `subtitle:`, `placeholder:`)
 *   - `window.confirm(...)`, `window.alert(...)`, `window.prompt(...)` arguments
 *
 * It is still a heuristic, not an AST parser — it can be fooled by comments,
 * regex literals containing backticks, and Tailwind class strings assigned to
 * an unluckily-named property (`label: 'text-primary'`). Every hit below was
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

/** Files that render no user-facing prose at all (pure UI primitives that
 *  only pass through `children`/`className` props, or wrappers with zero
 *  string literals of their own). Kept intentionally tiny — prefer a
 *  per-string exemption in EXEMPT_HITS below over adding a file here. */
const EXEMPT_FILES = new Set<string>([]);

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

/** A template literal "contains prose" if, after stripping `${}`
 *  interpolations, it has at least two adjacent word-like tokens and at
 *  least one of them is a Title-Case word or a common English function word.
 *  This deliberately excludes Tailwind utility-class template literals
 *  (`` `flex items-center gap-2 dark:bg-neutral-800` ``): every token in
 *  those is lowercase and none of them are English stopwords. */
function templateHasProse(raw: string): boolean {
  const stripped = raw.replace(/\$\{[^}]*\}/g, ' ');
  if (!/[A-Za-z]{2,}\s+[A-Za-z]{2,}/.test(stripped)) return false;
  const words = stripped.split(/\s+/).filter(Boolean);
  for (const w of words) {
    const clean = w.replace(/[^A-Za-z]/g, '');
    if (!clean) continue;
    if (isTitleCaseWord(clean)) return true;
    if (STOPWORDS.has(clean.toLowerCase())) return true;
  }
  return false;
}

const JSX_TEXT_RE = />[A-Z][a-z][^<>{}]{2,60}</g;
const ATTR_RE = /\b(?:title|placeholder|aria-label|alt|label)=\{?["']([^"']{2,120})["']\}?/g;
const PROP_RE = /\b(?:label|title|name|description|hint|subtitle|placeholder):\s*['"]([^'"]{1,120})['"]/g;
const TEMPLATE_RE = /`([^`]*)`/g;
const WINDOW_DIALOG_RE = /window\.(?:confirm|alert|prompt)\(\s*(`[^`]*`|"[^"]*"|'[^']*')/g;

function findHits(file: string, src: string): string[] {
  const hits: string[] = [];

  for (const m of src.matchAll(JSX_TEXT_RE)) hits.push(m[0]);
  for (const m of src.matchAll(ATTR_RE)) hits.push(m[0]);
  for (const m of src.matchAll(PROP_RE)) hits.push(m[0]);
  for (const m of src.matchAll(WINDOW_DIALOG_RE)) hits.push(m[0]);

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
        } else if (e.name.endsWith('.tsx')) {
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
});
