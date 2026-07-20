// Pure JSON <-> visual-builder-row mapping for the #91 data-generation
// template DSL (see `docs/superpowers/specs/2026-07-19-data-generation-design.md`
// for the DSL table — this module's `GenKind` set and (de)serialization
// mirror `src-tauri/src/db/generate.rs::parse_spec` exactly so the builder
// never claims to represent a shape the backend would reject, and never
// silently drops a construct it can't show).
//
// `templateToRows` is intentionally conservative: it returns `null` (never a
// lossy/partial `GenRow[]`) the moment it meets anything the builder can't
// faithfully round-trip — an unknown `$generator`, a `$pick` with non-scalar
// choices, an ambiguous multi-`$key` object, etc. That `null` is the signal
// GenerateView uses to fall back to "Custom template — editing as raw JSON"
// and lock the builder toggle, per the plan's "never silently destroy
// constructs" rule.
//
// `rowsToTemplate` is total (every `GenRow[]` this module can produce maps
// back to a template value) — it is only ever fed rows this module itself
// built (via `templateToRows` or the builder's add-field/add-array/add-object
// actions), so there is no "unrepresentable row" case to handle there.

/** Every DSL generator, plus the two structural container kinds ('object'
 * for plain JSON nesting, 'array' for `$array`) and 'literal' for verbatim
 * passthrough values — exactly the DSL table's spec column. */
export type GenKind =
  | 'name'
  | 'firstName'
  | 'lastName'
  | 'email'
  | 'objectId'
  | 'uuid'
  | 'bool'
  | 'int'
  | 'float'
  | 'date'
  | 'lorem'
  | 'pick'
  | 'array'
  | 'literal'
  | 'object';

/** All `GenKind`s the generator `<Select>` should list — every DSL leaf
 * generator (bare-string and options-object forms alike) plus 'literal';
 * 'object' and 'array' are reached via the builder's "add nested object" /
 * "add array" actions rather than the per-row dropdown, but switching an
 * existing row to either through the dropdown is also supported (both kinds
 * are valid `GenKind`s), so they're included here too. */
export const GEN_KINDS: GenKind[] = [
  'name',
  'firstName',
  'lastName',
  'email',
  'objectId',
  'uuid',
  'bool',
  'int',
  'float',
  'date',
  'lorem',
  'pick',
  'array',
  'literal',
  'object',
];

/** One row in the visual builder. `options` shape depends on `kind`:
 *  - int:     { min?: number; max?: number }
 *  - float:   { min?: number; max?: number; decimals?: number }
 *  - date:    { mode: 'past_days'; pastDays?: number } | { mode: 'range'; from?: string; to?: string }
 *  - lorem:   { words?: number }
 *  - pick:    { values: (string | number | boolean | null)[] }
 *  - array:   { min?: number; max?: number } (the element spec is `children[0]`)
 *  - literal: { value: unknown }
 *  - name/firstName/lastName/email/objectId/uuid/bool/object: {} (unused)
 */
export interface GenRow {
  id: string;
  name: string;
  kind: GenKind;
  options: Record<string, unknown>;
  children?: GenRow[];
}

let idSeq = 0;
/** Stable-enough-for-React-keys row id; uniqueness (not the exact value) is
 * all that matters — nothing round-trips through this string. */
export function newRowId(): string {
  idSeq += 1;
  return `genrow-${Date.now().toString(36)}-${idSeq}`;
}

// ---------------------------------------------------------------------------
// template -> rows
// ---------------------------------------------------------------------------

const STRING_GENERATOR_KINDS: Record<string, GenKind> = {
  $name: 'name',
  $firstName: 'firstName',
  $lastName: 'lastName',
  $email: 'email',
  $objectId: 'objectId',
  $uuid: 'uuid',
  $bool: 'bool',
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isScalar(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/** Parse `template` (the raw JSON a `preview_generated_documents`/
 * `start_generate_task` call would receive) into builder rows, or `null`
 * when it contains anything the builder can't represent — the caller's
 * signal to fall back to raw-JSON-only editing. */
export function templateToRows(template: unknown): GenRow[] | null {
  if (!isPlainObject(template)) return null;
  // A root object with any `$`-prefixed key is never a valid document shape
  // (`parse_template` itself rejects it — "template root must be a JSON
  // object" — because `parse_spec` at the root only returns `Spec::Object`
  // when there are zero `$` keys); nothing here can build a UI for it.
  if (Object.keys(template).some((k) => k.startsWith('$'))) return null;

  const rows: GenRow[] = [];
  for (const [name, value] of Object.entries(template)) {
    const row = valueToRow(name, value);
    if (!row) return null;
    rows.push(row);
  }
  return rows;
}

function valueToRow(name: string, value: unknown): GenRow | null {
  if (typeof value === 'string') {
    const kind = STRING_GENERATOR_KINDS[value];
    if (kind) return { id: newRowId(), name, kind, options: {} };
    // A bare "$foo" that isn't a known generator is a parse error backend
    // side (typo protection) — not something the builder can render as a
    // row either way, so it forces raw-JSON editing same as any other
    // unrepresentable construct.
    if (value.startsWith('$')) return null;
    return { id: newRowId(), name, kind: 'literal', options: { value } };
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean' || Array.isArray(value)) {
    // Bare arrays are literal passthrough in the DSL (only `{"$array": …}`
    // is the generator form) — represented as a literal row, editable as
    // raw JSON in that row's value field.
    return { id: newRowId(), name, kind: 'literal', options: { value } };
  }
  if (isPlainObject(value)) {
    const dollarKeys = Object.keys(value).filter((k) => k.startsWith('$'));
    if (dollarKeys.length === 0) {
      const children: GenRow[] = [];
      for (const [childName, childValue] of Object.entries(value)) {
        const child = valueToRow(childName, childValue);
        if (!child) return null;
        children.push(child);
      }
      return { id: newRowId(), name, kind: 'object', options: {}, children };
    }
    if (dollarKeys.length > 1) return null; // ambiguous — parse_template errors on this too
    const key = dollarKeys[0];
    const inner = value[key];
    switch (key) {
      case '$int':
        return intRow(name, inner);
      case '$float':
        return floatRow(name, inner);
      case '$date':
        return dateRow(name, inner);
      case '$lorem':
        return loremRow(name, inner);
      case '$pick':
        return pickRow(name, inner);
      case '$array':
        return arrayRow(name, inner);
      case '$literal':
        return { id: newRowId(), name, kind: 'literal', options: { value: inner } };
      default:
        return null; // unknown generator wrapper
    }
  }
  return null;
}

function intRow(name: string, inner: unknown): GenRow | null {
  if (!isPlainObject(inner)) return null;
  const min = 'min' in inner ? inner.min : 0;
  const max = 'max' in inner ? inner.max : 1000;
  if (typeof min !== 'number' || typeof max !== 'number') return null;
  return { id: newRowId(), name, kind: 'int', options: { min, max } };
}

function floatRow(name: string, inner: unknown): GenRow | null {
  if (!isPlainObject(inner)) return null;
  const { min, max } = inner;
  if (typeof min !== 'number' || typeof max !== 'number') return null;
  const decimals = 'decimals' in inner ? inner.decimals : 2;
  if (typeof decimals !== 'number') return null;
  return { id: newRowId(), name, kind: 'float', options: { min, max, decimals } };
}

function dateRow(name: string, inner: unknown): GenRow | null {
  if (!isPlainObject(inner)) return null;
  if ('past_days' in inner) {
    const pastDays = inner.past_days;
    if (typeof pastDays !== 'number') return null;
    return { id: newRowId(), name, kind: 'date', options: { mode: 'past_days', pastDays } };
  }
  if ('from' in inner && 'to' in inner) {
    const { from, to } = inner;
    if (typeof from !== 'string' || typeof to !== 'string') return null;
    return { id: newRowId(), name, kind: 'date', options: { mode: 'range', from, to } };
  }
  return null;
}

function loremRow(name: string, inner: unknown): GenRow | null {
  if (!isPlainObject(inner)) return null;
  const words = inner.words;
  if (typeof words !== 'number') return null;
  return { id: newRowId(), name, kind: 'lorem', options: { words } };
}

function pickRow(name: string, inner: unknown): GenRow | null {
  if (!Array.isArray(inner)) return null;
  if (!inner.every(isScalar)) return null;
  return { id: newRowId(), name, kind: 'pick', options: { values: [...inner] } };
}

function arrayRow(name: string, inner: unknown): GenRow | null {
  if (!isPlainObject(inner)) return null;
  if (!('of' in inner) || typeof inner.min !== 'number' || typeof inner.max !== 'number') return null;
  const ofRow = valueToRow('', inner.of);
  if (!ofRow) return null;
  return {
    id: newRowId(),
    name,
    kind: 'array',
    options: { min: inner.min, max: inner.max },
    children: [ofRow],
  };
}

// ---------------------------------------------------------------------------
// rows -> template
// ---------------------------------------------------------------------------

/** Whether `value`, placed directly at a template leaf position, would be
 * re-interpreted as a generator control structure instead of passed through
 * verbatim — a `"$…"` string, or a plain object with any `$`-prefixed key.
 * Those need the explicit `{"$literal": …}` escape; everything else can be
 * emitted as-is (still parses identically — a plain nested object with no
 * `$` keys is `Spec::Object`, which generates every field literally anyway). */
function needsLiteralWrap(value: unknown): boolean {
  if (typeof value === 'string') return value.startsWith('$');
  if (isPlainObject(value)) return Object.keys(value).some((k) => k.startsWith('$'));
  return false;
}

function rowToValue(row: GenRow): unknown {
  switch (row.kind) {
    case 'name':
      return '$name';
    case 'firstName':
      return '$firstName';
    case 'lastName':
      return '$lastName';
    case 'email':
      return '$email';
    case 'objectId':
      return '$objectId';
    case 'uuid':
      return '$uuid';
    case 'bool':
      return '$bool';
    case 'int':
      return { $int: { min: row.options.min ?? 0, max: row.options.max ?? 1000 } };
    case 'float':
      return {
        $float: { min: row.options.min ?? 0, max: row.options.max ?? 1000, decimals: row.options.decimals ?? 2 },
      };
    case 'date':
      if (row.options.mode === 'range') {
        return { $date: { from: row.options.from ?? '', to: row.options.to ?? '' } };
      }
      return { $date: { past_days: row.options.pastDays ?? 365 } };
    case 'lorem':
      return { $lorem: { words: row.options.words ?? 2 } };
    case 'pick':
      return { $pick: Array.isArray(row.options.values) ? row.options.values : [] };
    case 'array': {
      const child = row.children?.[0];
      const of = child ? rowToValue(child) : '$bool';
      return { $array: { of, min: row.options.min ?? 1, max: row.options.max ?? 3 } };
    }
    case 'literal': {
      const value = row.options.value ?? null;
      return needsLiteralWrap(value) ? { $literal: value } : value;
    }
    case 'object': {
      const obj: Record<string, unknown> = {};
      for (const child of row.children ?? []) obj[child.name] = rowToValue(child);
      return obj;
    }
    default:
      return null;
  }
}

/** Build a template JSON value from builder rows — the inverse of
 * `templateToRows`, total over any `GenRow[]` this module produced. */
export function rowsToTemplate(rows: GenRow[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const row of rows) {
    result[row.name] = rowToValue(row);
  }
  return result;
}

/** First row (searched depth-first, including `$array`/object children) whose
 * `$pick` has no values — `parse_pick` hard-rejects `{"$pick": []}`
 * backend-side, so a builder-produced template with one of these is invalid
 * even though every row individually looked fine. Used to gate Generate and
 * to show an inline per-row message, rather than only surfacing this as a
 * backend preview error after the confirm chain has already started. */
export function findEmptyPickRow(rows: GenRow[]): GenRow | null {
  for (const row of rows) {
    if (row.kind === 'pick' && (!Array.isArray(row.options.values) || row.options.values.length === 0)) {
      return row;
    }
    if (row.children) {
      const found = findEmptyPickRow(row.children);
      if (found) return found;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// builder row factories (used by GenerateView's add-field/add-array/
// add-object actions so every newly-added row is already representable)
// ---------------------------------------------------------------------------

export function newFieldRow(name: string): GenRow {
  return { id: newRowId(), name, kind: 'lorem', options: { words: 2 } };
}

export function newObjectRow(name: string): GenRow {
  return { id: newRowId(), name, kind: 'object', options: {}, children: [] };
}

export function newArrayRow(name: string): GenRow {
  return {
    id: newRowId(),
    name,
    kind: 'array',
    options: { min: 1, max: 3 },
    children: [{ id: newRowId(), name: '', kind: 'lorem', options: { words: 2 } }],
  };
}

/** Default `options` for a row whose `kind` was just switched via the
 * generator `<Select>` — keeps every kind's option inputs pre-filled with
 * sane values instead of `undefined`. */
export function defaultOptionsFor(kind: GenKind): Record<string, unknown> {
  switch (kind) {
    case 'int':
      return { min: 0, max: 1000 };
    case 'float':
      return { min: 0, max: 1000, decimals: 2 };
    case 'date':
      return { mode: 'past_days', pastDays: 365 };
    case 'lorem':
      return { words: 2 };
    case 'pick':
      // `$pick` hard-rejects an empty array backend-side (`parse_pick`) — a
      // freshly-switched row must seed at least one value so it's a valid
      // template immediately, per this module's "never claims to represent
      // a shape the backend would reject" invariant.
      return { values: ['value'] };
    case 'array':
      return { min: 1, max: 3 };
    case 'literal':
      return { value: '' };
    default:
      return {};
  }
}
