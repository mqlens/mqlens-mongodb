// Sort order for the table view's column sort. Values are what EJSON.parse
// gives back: JS numbers and strings, Date, and bson instances (ObjectId,
// Decimal128, Long, ...). Types rank as in MongoDB's BSON comparison order,
// with missing treated as null so both come first ascending.
//
// BSON types are recognised with instanceof, never by a `_bsontype` field: a
// stored sub-document can have a field of that name.
import { Binary, BSONRegExp, BSONSymbol, Decimal128, Double, Int32, Long, MaxKey, MinKey, ObjectId, Timestamp } from 'bson';

const isNumber = (v: unknown) =>
  typeof v === 'number' || v instanceof Int32 || v instanceof Double || v instanceof Long || v instanceof Decimal128;

const isDocument = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;

const rank = (v: unknown): number => {
  if (v instanceof MinKey) return -1;
  if (v instanceof MaxKey) return 11;
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
  return 10; // RegExp, ...
};

const asNumber = (v: any): number => (typeof v === 'number' ? v : Number(v.toString()));

// A decimal string as digits and a power of ten: "-1.5E+3" is [-15n, 2].
// Null for NaN and Infinity, which the double comparison already orders.
const decimalParts = (s: string): [bigint, number] | null => {
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:E([+-]?\d+))?$/i.exec(s);
  if (!m) return null;
  const fraction = m[3] ?? '';
  return [BigInt(`${m[1] === '-' ? '-' : ''}${m[2] + fraction || '0'}`), Number(m[4] ?? 0) - fraction.length];
};

// A double's exact value in the same form: its mantissa times a power of
// two, which is the mantissa times 5^n over 10^n. Its printed text is only
// the shortest text that reads back as it ("0.1" for 0.1000000000000000055…).
const doubleParts = (x: number): [bigint, number] | null => {
  if (!Number.isFinite(x)) return null;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const hi = view.getUint32(0);
  const biased = (hi >>> 20) & 0x7ff;
  let mantissa = (BigInt(hi & 0xfffff) << 32n) | BigInt(view.getUint32(4));
  if (biased !== 0) mantissa |= 1n << 52n;
  const exp = (biased || 1) - 1075;
  const signed = hi >>> 31 ? -mantissa : mantissa;
  return exp >= 0 ? [signed << BigInt(exp), 0] : [signed * 5n ** BigInt(-exp), exp];
};

const exactParts = (v: unknown): [bigint, number] | null =>
  typeof v === 'number' ? doubleParts(v) : v instanceof Double ? doubleParts(v.value) : decimalParts(String(v));

// Exact order of two numbers that compare equal as doubles, when one is a
// Decimal128: it holds 34 digits and exponents a double cannot reach.
// ponytail: Longs past 2^53 are already rounded by the grid's relaxed EJSON
// parse, so they can still tie.
const compareExact = (x: unknown, y: unknown): number => {
  const a = exactParts(x);
  const b = exactParts(y);
  if (!a || !b) return 0;
  const e = Math.min(a[1], b[1]);
  const va = a[0] * 10n ** BigInt(a[1] - e);
  const vb = b[0] * 10n ** BigInt(b[1] - e);
  return va < vb ? -1 : va > vb ? 1 : 0;
};

// MongoDB's default string order: by UTF-8 bytes, which is code point order,
// whatever the locale. UTF-16 units follow it except where a surrogate (half
// of a character past U+FFFF) meets a character from U+E000 up.
const compareStrings = (a: string, b: string): number => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x === y) continue;
    const sx = x >= 0xd800 && x <= 0xdfff;
    const sy = y >= 0xd800 && y <= 0xdfff;
    return sx === sy ? x - y : sx ? 1 : -1;
  }
  return a.length - b.length;
};

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
      return nx - ny || (x instanceof Decimal128 || y instanceof Decimal128 ? compareExact(x, y) : 0);
    }
    case 2:
      return compareStrings(String(x), String(y));
    case 3: {
      // Field by field, as MongoDB: the value's type, then the name, then the value.
      const ex = Object.entries(x);
      const ey = Object.entries(y);
      for (let i = 0; i < Math.min(ex.length, ey.length); i++) {
        const c =
          rank(ex[i][1]) - rank(ey[i][1]) ||
          compareStrings(ex[i][0], ey[i][0]) ||
          compareBsonValues(ex[i][1], ey[i][1]);
        if (c !== 0) return c;
      }
      return ex.length - ey.length;
    }
    case 4:
      return compareLists(x, y);
    case 5: {
      // As MongoDB: length, then subtype, then the bytes.
      const bx: Uint8Array = x.value();
      const by: Uint8Array = y.value();
      if (bx.length !== by.length) return bx.length - by.length;
      if (x.sub_type !== y.sub_type) return x.sub_type - y.sub_type;
      for (let i = 0; i < bx.length; i++) if (bx[i] !== by[i]) return bx[i] - by[i];
      return 0;
    }
    case 6:
      return compareStrings(x.toHexString(), y.toHexString());
    case 7:
      return Number(x) - Number(y);
    case 8:
      return x.getTime() - y.getTime();
    case 9:
      return x.compare(y);
    case 10:
      // As MongoDB: the pattern, then the options. A BSONRegExp has no
      // string form of its own, a RegExp keeps them as source and flags.
      if ((x instanceof RegExp || x instanceof BSONRegExp) && (y instanceof RegExp || y instanceof BSONRegExp)) {
        const parts = (r: RegExp | BSONRegExp) => (r instanceof RegExp ? [r.source, r.flags] : [r.pattern, r.options]);
        const [px, ox] = parts(x);
        const [py, oy] = parts(y);
        return compareStrings(px, py) || compareStrings(ox, oy);
      }
      return compareStrings(String(x), String(y));
    default:
      return compareStrings(String(x), String(y));
  }
}
