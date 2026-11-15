// Sort order for the table view's column sort. Values are what EJSON.parse
// gives back: JS numbers and strings, Date, and bson instances (ObjectId,
// Decimal128, Long, ...). Types rank as in MongoDB's BSON comparison order,
// with missing treated as null so both come first ascending.
//
// BSON types are recognised with instanceof, never by a `_bsontype` field: a
// stored sub-document can have a field of that name.
import { Binary, BSONSymbol, Decimal128, Double, Int32, Long, ObjectId, Timestamp } from 'bson';

const isNumber = (v: unknown) =>
  typeof v === 'number' || v instanceof Int32 || v instanceof Double || v instanceof Long || v instanceof Decimal128;

const isDocument = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;

const rank = (v: unknown): number => {
  if (v === undefined || v === null) return 0;
  // Before the number check: Timestamp extends Long.
  if (v instanceof Timestamp) return 9;
  if (isNumber(v)) return 1;
  if (typeof v === 'string' || v instanceof BSONSymbol) return 2;
  if (isDocument(v)) return 3;
  if (Array.isArray(v)) return 4;
  if (v instanceof Binary) return 5;
  if (v instanceof ObjectId) return 6;
  if (typeof v === 'boolean') return 7;
  if (v instanceof Date) return 8;
  return 10; // RegExp, MinKey/MaxKey, ...
};

// ponytail: Decimal128 and large Longs compare as doubles, so values that
// differ past ~15 significant digits can tie.
const asNumber = (v: any): number => (typeof v === 'number' ? v : Number(v.toString()));

// Element by element, then the shorter first.
const compareLists = (a: unknown[], b: unknown[]): number => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const c = compareBsonValues(a[i], b[i]);
    if (c !== 0) return c;
  }
  return a.length - b.length;
};

export function compareBsonValues(a: unknown, b: unknown): number {
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  const x = a as any;
  const y = b as any;
  switch (ra) {
    case 0:
      return 0;
    case 1: {
      const nx = asNumber(x);
      const ny = asNumber(y);
      // NaN sorts before every other number, as in MongoDB.
      if (Number.isNaN(nx) || Number.isNaN(ny)) return Number(!Number.isNaN(nx)) - Number(!Number.isNaN(ny));
      return nx - ny;
    }
    case 2:
      return String(x).localeCompare(String(y));
    case 3: {
      // Field by field: the name first, then the value.
      const ex = Object.entries(x);
      const ey = Object.entries(y);
      for (let i = 0; i < Math.min(ex.length, ey.length); i++) {
        const c = ex[i][0].localeCompare(ey[i][0]) || compareBsonValues(ex[i][1], ey[i][1]);
        if (c !== 0) return c;
      }
      return ex.length - ey.length;
    }
    case 4:
      return compareLists(x, y);
    case 6:
      return x.toHexString().localeCompare(y.toHexString());
    case 7:
      return Number(x) - Number(y);
    case 8:
      return x.getTime() - y.getTime();
    case 9:
      return x.compare(y);
    default:
      return String(x).localeCompare(String(y));
  }
}
