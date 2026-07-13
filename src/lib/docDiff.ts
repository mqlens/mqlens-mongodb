import { ObjectId, Long, Decimal128, Int32, Double, Binary, Timestamp } from 'bson';

// A value is a "container" (recurse into it) only when it is a plain object or
// array. BSON wrappers (ObjectId, Date, Long, …) are leaf scalars: we diff them
// by value, never by walking their internal fields.
export type ValueKind = 'object' | 'array' | 'scalar';

export function isBsonScalar(val: unknown): boolean {
  return (
    val instanceof ObjectId ||
    val instanceof Date ||
    val instanceof Long ||
    val instanceof Decimal128 ||
    val instanceof Int32 ||
    val instanceof Double ||
    val instanceof Binary ||
    val instanceof Timestamp
  );
}

export function valueKind(val: unknown): ValueKind {
  if (Array.isArray(val)) return 'array';
  if (val !== null && typeof val === 'object' && !isBsonScalar(val)) return 'object';
  return 'scalar';
}

// Unwrap a BSON numeric wrapper (or plain number) to a JS number, else NaN.
function asNumber(val: unknown): number {
  if (typeof val === 'number') return val;
  if (val instanceof Int32 || val instanceof Double) return val.valueOf();
  if (val instanceof Long) return val.toNumber();
  if (val instanceof Decimal128) return Number(val.toString());
  return NaN;
}

// Deep value equality for scalars and BSON wrappers. Containers are compared
// recursively by the caller (diffDocuments), so this only needs to handle leaves.
export function bsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;

  // Numeric equivalence across plain numbers and BSON numeric wrappers.
  const an = asNumber(a);
  const bn = asNumber(b);
  if (!Number.isNaN(an) && !Number.isNaN(bn)) return an === bn;

  if (a instanceof ObjectId && b instanceof ObjectId) return a.equals(b);
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof Decimal128 && b instanceof Decimal128) return a.toString() === b.toString();
  if (a instanceof Binary && b instanceof Binary) {
    return a.sub_type === b.sub_type && a.toString('base64') === b.toString('base64');
  }
  if (a instanceof Timestamp && b instanceof Timestamp) return a.toString() === b.toString();

  // Anything else (mismatched kinds, distinct primitives) is unequal.
  return false;
}
