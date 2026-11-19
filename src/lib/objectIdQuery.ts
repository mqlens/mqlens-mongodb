// ObjectId conveniences for the find query bar (Settings → Behavior):
//
// - a bare ObjectId typed as the whole query becomes a search by `_id`;
// - a 24-hex string compared against a field the sampled schema says holds
//   ObjectIds is sent as an ObjectId, since as a string it can match nothing.
//
// Both are applied when the query runs, and the query text is rewritten to
// what actually ran so Save / Explain / Copy keep describing the same query.
import { parseQueryObject } from './shellDoc';
import type { SchemaMap } from './useCollectionSchema';

const HEX24 = /^[0-9a-fA-F]{24}$/;
const BARE_OBJECT_ID =
  /^(?:ObjectId\(\s*(["'])([0-9a-fA-F]{24})\1\s*\)|(["'])([0-9a-fA-F]{24})\3|([0-9a-fA-F]{24}))$/;

/** If `text` is nothing but an ObjectId (bare hex, quoted hex or `ObjectId("…")`),
 *  the filter text that looks it up by `_id`; otherwise null. */
export function bareObjectIdFilter(text: string): string | null {
  const m = BARE_OBJECT_ID.exec(text.trim());
  if (!m) return null;
  return `{ _id: ObjectId("${m[2] ?? m[4] ?? m[5]}") }`;
}

const COMPARISON_OPS = new Set(['$eq', '$ne', '$gt', '$gte', '$lt', '$lte']);
const LIST_OPS = new Set(['$in', '$nin']);
const LOGICAL_OPS = new Set(['$and', '$or', '$nor']);

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Replace 24-hex strings compared against ObjectId-typed fields with
 * `{ $oid }`. `filter` is a parsed (EJSON-shaped) find filter and is not
 * mutated. Returns the hex strings that were converted, in order.
 */
export function convertObjectIdStrings(
  filter: Record<string, unknown>,
  schema: SchemaMap,
): { filter: Record<string, unknown>; converted: string[] } {
  const converted: string[] = [];
  const isOidField = (path: string) => path !== '' && schema.get(path)?.type === 'objectId';
  const convert = (value: unknown, path: string): unknown => {
    if (typeof value === 'string' && HEX24.test(value) && isOidField(path)) {
      converted.push(value);
      return { $oid: value };
    }
    return value;
  };

  const walk = (node: Record<string, unknown>, path: string): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (LOGICAL_OPS.has(key)) {
        out[key] = Array.isArray(value)
          ? value.map((sub) => (isPlainObject(sub) ? walk(sub, path) : sub))
          : value;
      } else if (COMPARISON_OPS.has(key)) {
        out[key] = convert(value, path);
      } else if (LIST_OPS.has(key)) {
        out[key] = Array.isArray(value) ? value.map((v) => convert(v, path)) : value;
      } else if (key === '$not' || key === '$elemMatch') {
        out[key] = isPlainObject(value) ? walk(value, path) : value;
      } else if (key.startsWith('$')) {
        // Any other operator — and every EJSON wrapper ({ $oid }, { $date }) —
        // carries a value that is not ours to reinterpret.
        out[key] = value;
      } else {
        const fieldPath = path ? `${path}.${key}` : key;
        out[key] = isPlainObject(value) ? walk(value, fieldPath) : convert(value, fieldPath);
      }
    }
    return out;
  };

  return { filter: walk(filter, ''), converted };
}

/** Wrap the quoted `hexes` in `text` in `ObjectId(…)`, keeping the rest of the
 *  user's formatting. Falls back to plain EJSON when a textual swap would not
 *  describe exactly `filter` (the same hex also sits under a non-ObjectId field). */
function rewriteFilterText(text: string, filter: Record<string, unknown>, hexes: string[]): string {
  // One pass over the text, whatever the number of ids: a long `$in` list
  // would otherwise be scanned and copied once per id.
  const wanted = new Set(hexes);
  const out = text.replace(/(["'])([0-9a-fA-F]{24})\1/g, (match, _q, hex: string, offset: number, whole: string) =>
    !wanted.has(hex) || /ObjectId\(\s*$/.test(whole.slice(Math.max(0, offset - 32), offset))
      ? match
      : `ObjectId("${hex}")`,
  );
  try {
    if (JSON.stringify(parseQueryObject(out)) === JSON.stringify(filter)) return out;
  } catch {
    /* fall through */
  }
  return JSON.stringify(filter);
}

export interface ResolvedFilter {
  /** The filter to execute (EJSON-shaped). */
  filter: Record<string, unknown>;
  /** The query text describing `filter`; differs from the input when a
   *  convenience rewrote it. */
  text: string;
}

/**
 * Parse the query-bar filter text, applying the enabled ObjectId conveniences.
 * Throws what `parseQueryObject` throws when the text is not a valid filter.
 */
export function resolveFindFilter(
  text: string,
  schema: SchemaMap,
  options: { autoConvertObjectId: boolean; defaultIdSearch: boolean },
): ResolvedFilter {
  let current = text;
  if (options.defaultIdSearch) current = bareObjectIdFilter(current) ?? current;
  let filter: Record<string, unknown> = current.trim() ? parseQueryObject(current) : {};
  if (options.autoConvertObjectId) {
    const result = convertObjectIdStrings(filter, schema);
    if (result.converted.length > 0) {
      filter = result.filter;
      current = rewriteFilterText(current, filter, result.converted);
    }
  }
  return { filter, text: current };
}
