// Sort order for the table view's column sort. Values are what EJSON.parse
// gives back: JS numbers and strings, Date, and bson instances (ObjectId,
// Decimal128, Long, ...). Types rank as in MongoDB's BSON comparison order,
// with missing treated as null so both come first ascending.

const NUMBER_TYPES = new Set(['Int32', 'Double', 'Long', 'Decimal128']);

const rank = (v: any): number => {
  if (v === undefined || v === null) return 0;
  if (typeof v === 'number' || NUMBER_TYPES.has(v?._bsontype)) return 1;
  if (typeof v === 'string' || v?._bsontype === 'BSONSymbol') return 2;
  if (Array.isArray(v)) return 4;
  if (v?._bsontype === 'Binary') return 5;
  if (v?._bsontype === 'ObjectId') return 6;
  if (typeof v === 'boolean') return 7;
  if (v instanceof Date) return 8;
  if (v?._bsontype) return 9;
  return 3; // embedded document
};

// ponytail: Decimal128 and large Longs compare as doubles, so values that
// differ past ~15 significant digits can tie.
const asNumber = (v: any): number => (typeof v === 'number' ? v : Number(v.toString()));

export function compareBsonValues(a: unknown, b: unknown): number {
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  const x = a as any;
  const y = b as any;
  switch (ra) {
    case 0:
      return 0;
    case 1:
      return asNumber(x) - asNumber(y);
    case 2:
      return String(x).localeCompare(String(y));
    case 6:
      return x.toHexString().localeCompare(y.toHexString());
    case 7:
      return Number(x) - Number(y);
    case 8:
      return x.getTime() - y.getTime();
    default:
      return JSON.stringify(x).localeCompare(JSON.stringify(y));
  }
}
