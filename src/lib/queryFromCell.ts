// Turning a results-grid cell into a piece of the find query: the grid's
// context menu adds the cell's field (and value) to the filter, projection or
// sort text in the query bar.
//
// Each function takes the current query-bar text and returns the new text. The
// existing text is parsed and re-serialized rather than patched as a string, so
// hand-written conditions (`$elemMatch`, `$or`, …) survive and only their
// formatting changes. They throw what `parseQueryObject` throws when the
// existing text is not a valid query document.
import { EJSON } from 'bson';
import { docToShell, parseQueryObject } from './shellDoc';
import { isBsonInstance, isEjsonWrapper } from './bsonDisplay';

type QueryDoc = Record<string, any>;

const isPlainObject = (v: unknown): v is QueryDoc =>
  v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);

/** `{ $gt: 5 }`, not `{ $oid: "…" }` and not an embedded document. */
const isOperatorObject = (v: unknown): v is QueryDoc =>
  isPlainObject(v)
  && !isBsonInstance(v)
  && Object.keys(v).length > 0
  && Object.keys(v).every((k) => k.startsWith('$'))
  // `$regex`/`$options`/`$type` are also legacy typed-value keys, but in a
  // filter they are operators.
  && (!isEjsonWrapper(v) || '$regex' in v || '$type' in v);

/** Whether a cell value can be matched by equality from the context menu:
 *  any single value, but not a missing field, an array or a sub-document. */
export function isFilterableValue(value: unknown): boolean {
  if (value === undefined) return false;
  // The Tree and JSON views show a relaxed parse, where a 64-bit integer past
  // 2^53 has already been rounded: the number in hand is not the stored one.
  if (typeof value === 'number') return !Number.isInteger(value) || Number.isSafeInteger(value);
  if (value === null || typeof value !== 'object') return true;
  if (Array.isArray(value)) return false;
  // `field: /abc/` is a pattern match against strings, not equality with a
  // stored regular expression.
  if (isRegexValue(value)) return false;
  if (value instanceof Date || isBsonInstance(value)) return true;
  return isEjsonWrapper(value as Record<string, unknown>);
}

const isRegexValue = (value: object): boolean =>
  value instanceof RegExp
  || (value as { _bsontype?: unknown })._bsontype === 'BSONRegExp'
  || '$regularExpression' in value
  || '$regex' in value;

/** The Extended JSON shape of a cell value. The grid hands over raw Extended
 *  JSON from the Table view and BSON instances from the Tree and JSON views. */
function toEjsonValue(value: unknown): unknown {
  if (value instanceof Date || isBsonInstance(value)) {
    return (EJSON.serialize({ v: value }, { relaxed: false }) as QueryDoc).v;
  }
  return value;
}

const parse = (text: string): QueryDoc => (text.trim() ? parseQueryObject(text) : {});

/** `{ $regularExpression: { pattern, options } }`, how a parsed `/…/` arrives. */
const regexParts = (v: unknown): { pattern: string; options: string } | null => {
  if (!isPlainObject(v) || Object.keys(v).length !== 1) return null;
  const rx = v.$regularExpression;
  if (!isPlainObject(rx) || typeof rx.pattern !== 'string') return null;
  return { pattern: rx.pattern, options: typeof rx.options === 'string' ? rx.options : '' };
};

/** A regex as the `/pattern/flags` it was typed as, or null when that literal
 *  would not read back as the same regex (flags JavaScript has no letter for,
 *  an empty or multi-line pattern, a pattern JavaScript cannot parse). */
function regexLiteral(pattern: string, options: string): string | null {
  if (!pattern || /[\n\r]/.test(pattern) || /[^imsu]/.test(options)) return null;
  // MongoDB's regex dialect accepts patterns JavaScript rejects, inline flags
  // such as `(?i)foo` among them. Those stay in their Extended JSON form.
  try {
    new RegExp(pattern, options);
  } catch {
    return null;
  }
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') out += c + (pattern[++i] ?? '');
    else out += c === '/' ? '\\/' : c;
  }
  return `/${out}/${options}`;
}

const SHELL_TYPED_KEYS = new Set(['$oid', '$date', '$numberLong', '$numberDecimal', '$numberInt', '$numberDouble']);

// On one line, as the query bar shows it. `docToShell` prints the values; the
// containers are joined here so nothing has to be collapsed afterwards.
function print(doc: QueryDoc): string {
  const show = (v: unknown): string => {
    if (Array.isArray(v)) return v.length ? `[ ${v.map(show).join(', ')} ]` : '[]';
    if (isPlainObject(v) && !isBsonInstance(v)) {
      const rx = regexParts(v);
      const literal = rx && regexLiteral(rx.pattern, rx.options);
      if (literal) return literal;
      const keys = Object.keys(v);
      // One typed value docToShell has a constructor for.
      if (keys.length === 1 && SHELL_TYPED_KEYS.has(keys[0])) return docToShell(v);
      return keys.length ? `{ ${keys.map((k) => `${JSON.stringify(k)} : ${show(v[k])}`).join(', ')} }` : '{}';
    }
    return docToShell(v);
  };
  return Object.keys(doc).length ? show(doc) : '';
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Add `field = value` (`mode: 'eq'`) or `field ≠ value` (`mode: 'ne'`) to a
 * filter. Other fields' conditions are kept, so repeated use narrows the
 * results. On the same field, an equality replaces what was there; an
 * exclusion joins the field's other operators, a second excluded value turns
 * `$ne` into `$nin`, and an equality with another value is kept as `$eq`.
 */
export function addFilterCondition(
  text: string,
  field: string,
  value: unknown,
  mode: 'eq' | 'ne',
): string {
  const filter = parse(text);
  const v = toEjsonValue(value);
  if (mode === 'eq') {
    filter[field] = v;
    return print(filter);
  }
  // A regex typed as `/…/` is a condition of its own; spell it as `$regex` so
  // the exclusion can sit beside it instead of replacing it.
  const rx = regexParts(filter[field]);
  if (rx) filter[field] = { $regex: rx.pattern, ...(rx.options && { $options: rx.options }) };
  const existing = filter[field];
  if (existing !== undefined && !isOperatorObject(existing)) {
    // An equality on the field. With this very value it is the opposite of
    // what is asked, so it gives way. With another value it stays, spelled as
    // `$eq` beside the exclusion: replacing it would widen the results, and
    // dropping the exclusion would be wrong for an array field, where
    // matching one element does not rule out another.
    filter[field] = same(existing, v) ? { $ne: v } : { $eq: existing, $ne: v };
  } else if (existing === undefined) {
    filter[field] = { $ne: v };
  } else if (Array.isArray(existing.$nin)) {
    if (!existing.$nin.some((x: unknown) => same(x, v))) existing.$nin = [...existing.$nin, v];
  } else if ('$ne' in existing) {
    if (!same(existing.$ne, v)) {
      const { $ne, ...rest } = existing;
      filter[field] = { ...rest, $nin: [$ne, v] };
    }
  } else {
    filter[field] = { ...existing, $ne: v };
  }
  return print(filter);
}

const isExcluded = (v: unknown): boolean => v === 0 || v === false;
/** `a.b` is under `a`. */
const isUnder = (path: string, parent: string): boolean => path.startsWith(`${parent}.`);

/**
 * Make sure `field` is returned. An including projection gains `field: 1`. A
 * projection that works by hiding fields cannot also include one (MongoDB
 * rejects the mix), so there the field is un-hidden instead.
 *
 * A projection may not name both a path and one under it, so the entries on
 * the same branch are reconciled: a field already covered by an included
 * parent needs nothing, and an included field replaces entries for its parts.
 * Un-hiding drops the exclusion of the field, of its parts, and of a parent
 * that hides it (which also brings back that parent's other fields).
 */
export function addProjectionField(text: string, field: string): string {
  const projection = parse(text);
  const keys = Object.keys(projection);
  const excluding = keys.some((k) => k !== '_id' && isExcluded(projection[k]));
  const sameBranch = keys.filter((k) => k === field || isUnder(k, field) || isUnder(field, k));
  if (excluding) {
    for (const k of sameBranch) if (isExcluded(projection[k])) delete projection[k];
  } else if (!keys.some((k) => isUnder(field, k) && !isExcluded(projection[k]))) {
    for (const k of sameBranch) if (k !== field && isUnder(k, field)) delete projection[k];
    projection[field] = 1;
  }
  return print(projection);
}

/** A sort by `field` alone, replacing any existing sort. */
export function sortByField(field: string, direction: 1 | -1): string {
  return print({ [field]: direction });
}
