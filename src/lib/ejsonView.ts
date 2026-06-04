import { EJSON } from 'bson';

// Recursively relax canonical Extended JSON number/date forms to their readable
// equivalents:
//   { "$date": { "$numberLong": "ms" } } -> { "$date": "ISO" }
//   { "$numberLong" | "$numberInt": "n" } -> n   (when safely representable)
//   { "$numberDouble": "n" }              -> n
// Everything else ($oid, $numberDecimal, $binary, regular fields, …) is left as
// is. Pure string/AST work — NO EJSON.parse — so it never throws, even on
// documents that legitimately contain `$`-prefixed user keys (e.g. `{ "$gt": 1 }`).
export function relaxEjson(v: any): any {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(relaxEjson);

  const keys = Object.keys(v);
  if (keys.length === 1) {
    const k = keys[0];
    if (k === '$date') {
      const d = v.$date;
      if (d && typeof d === 'object' && '$numberLong' in d) {
        const ms = Number(d.$numberLong);
        if (Number.isFinite(ms)) return { $date: new Date(ms).toISOString() };
      }
      return v;
    }
    if (k === '$numberLong' || k === '$numberInt') {
      const n = Number(v[k]);
      if (Number.isSafeInteger(n)) return n;
      return v;
    }
    if (k === '$numberDouble') {
      const n = Number(v.$numberDouble);
      if (Number.isFinite(n)) return n;
      return v;
    }
  }

  const out: Record<string, any> = {};
  for (const k of keys) out[k] = relaxEjson(v[k]);
  return out;
}

// Render a document for the JSON editor as clean, relaxed Extended JSON (v2).
// First normalize any BSON instances to plain Extended-JSON objects via
// EJSON.stringify (which does not throw), then relax canonical forms.
export function formatDocForEditor(doc: Record<string, any>): string {
  let plain: any = doc;
  try {
    plain = JSON.parse(EJSON.stringify(doc, undefined, 0, { relaxed: true }));
  } catch {
    plain = doc;
  }
  return JSON.stringify(relaxEjson(plain), null, 2);
}
