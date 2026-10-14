import { Binary, BSONRegExp, Code, DBRef, Decimal128, Double, Int32, Long, MaxKey, MinKey, ObjectId, Timestamp, BSONSymbol } from 'bson';

/**
 * Lossy display/export only; never prepare edits with this representation.
 * IDs/dates become strings; int64/decimal/timestamps stay strings to avoid
 * precision loss. Binary is base64, regex is /pattern/options, code loses its
 * scope, symbols and min/max keys become strings, and DBRefs become objects.
 * Non-finite numbers become strings and invalid dates become null.
 */
export function toPlainJson(value: unknown): unknown {
  if (value instanceof ObjectId) return value.toHexString();
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (value instanceof Timestamp || value instanceof Long || value instanceof Decimal128) return value.toString();
  if (value instanceof Int32 || value instanceof Double) return toPlainJson(value.valueOf());
  if (value instanceof Binary) return value.toString('base64');
  if (value instanceof BSONRegExp) return `/${value.pattern}/${value.options}`;
  if (value instanceof Code) return value.code;
  if (value instanceof BSONSymbol) return value.value;
  if (value instanceof MinKey) return 'MinKey';
  if (value instanceof MaxKey) return 'MaxKey';
  if (value instanceof DBRef) return toPlainJson({ $ref: value.collection, $id: value.oid, ...value.fields, ...(value.db ? { $db: value.db } : {}) });
  if (Array.isArray(value)) return value.map(toPlainJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, toPlainJson(child)]));
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  return value ?? null;
}
