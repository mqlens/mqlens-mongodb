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
  if (value === null || typeof value !== 'object') return true;
  if (Array.isArray(value)) return false;
  if (value instanceof Date || isBsonInstance(value)) return true;
  return isEjsonWrapper(value as Record<string, unknown>);
}

/** The Extended JSON shape of a cell value. The grid hands over raw Extended
 *  JSON from the Table view and BSON instances from the Tree and JSON views. */
function toEjsonValue(value: unknown): unknown {
  if (value instanceof Date || isBsonInstance(value)) {
    return (EJSON.serialize({ v: value }, { relaxed: false }) as QueryDoc).v;
  }
  return value;
}

const parse = (text: string): QueryDoc => (text.trim() ? parseQueryObject(text) : {});
// On one line, as the query bar shows it. Safe to collapse: `docToShell` escapes
// newlines inside strings, so every raw newline is layout.
const print = (doc: QueryDoc): string =>
  Object.keys(doc).length ? docToShell(doc).replace(/\n\s*/g, ' ') : '';
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Add `field = value` (`mode: 'eq'`) or `field ≠ value` (`mode: 'ne'`) to a
 * filter. Other fields' conditions are kept, so repeated use narrows the
 * results. On the same field, an equality replaces what was there; an
 * exclusion joins the field's other operators, and a second excluded value
 * turns `$ne` into `$nin`.
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
  const existing = filter[field];
  if (!isOperatorObject(existing)) {
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

/**
 * Make sure `field` is returned. An including projection gains `field: 1`. A
 * projection that works by hiding fields cannot also include one (MongoDB
 * rejects the mix), so there the field is un-hidden instead.
 */
export function addProjectionField(text: string, field: string): string {
  const projection = parse(text);
  const excluding = Object.entries(projection).some(([k, v]) => k !== '_id' && isExcluded(v));
  if (excluding) {
    delete projection[field];
  } else {
    projection[field] = 1;
  }
  return print(projection);
}

/** A sort by `field` alone, replacing any existing sort. */
export function sortByField(field: string, direction: 1 | -1): string {
  return print({ [field]: direction });
}
