// Render a document in mongosh "shell" style (ISODate(...), ObjectId(...),
// NumberLong(...), …) for the document editor, and convert that shell text back
// to Extended JSON for the backend on save. The display accepts both BSON
// instances and EJSON-shaped plain objects; the save path is string-tokenized so
// constructor-looking text inside string values is left untouched.
import { ObjectId, Long, Decimal128, Int32, Double } from 'bson';

const isPlainObject = (v: any): boolean => v !== null && typeof v === 'object' && !Array.isArray(v);

// value -> shell-style source text.
export function docToShell(v: any, indent = 0): string {
  const pad = '  '.repeat(indent);
  const padIn = '  '.repeat(indent + 1);

  if (v === null || v === undefined) return 'null';
  const t = typeof v;
  if (t === 'string') return JSON.stringify(v);
  if (t === 'number') return String(v);
  if (t === 'boolean') return v ? 'true' : 'false';

  if (v instanceof ObjectId) return `ObjectId("${v.toString()}")`;
  if (v instanceof Date) return `ISODate("${v.toISOString()}")`;
  if (v instanceof Long) return `NumberLong("${v.toString()}")`;
  if (v instanceof Decimal128) return `NumberDecimal("${v.toString()}")`;
  if (v instanceof Int32) return `NumberInt(${v.toString()})`;
  if (v instanceof Double) return String(v.valueOf());

  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    return `[\n${v.map((x) => padIn + docToShell(x, indent + 1)).join(',\n')}\n${pad}]`;
  }

  if (isPlainObject(v)) {
    const ks = Object.keys(v);
    if (ks.length === 1) {
      if (ks[0] === '$oid') return `ObjectId("${v.$oid}")`;
      if (ks[0] === '$date') {
        const d = v.$date;
        const iso =
          typeof d === 'string'
            ? d
            : d && typeof d === 'object' && '$numberLong' in d
              ? new Date(Number(d.$numberLong)).toISOString()
              : '';
        return `ISODate("${iso}")`;
      }
      if (ks[0] === '$numberLong') return `NumberLong("${v.$numberLong}")`;
      if (ks[0] === '$numberDecimal') return `NumberDecimal("${v.$numberDecimal}")`;
      if (ks[0] === '$numberInt') return `NumberInt(${v.$numberInt})`;
      if (ks[0] === '$numberDouble') return String(Number(v.$numberDouble));
    }
    if (ks.length === 0) return '{}';
    return `{\n${ks
      .map((k) => `${padIn}${JSON.stringify(k)}: ${docToShell(v[k], indent + 1)}`)
      .join(',\n')}\n${pad}}`;
  }

  return JSON.stringify(v);
}

const CTOR_NAMES = ['ObjectId', 'ISODate', 'Date', 'NumberLong', 'Long', 'NumberInt', 'NumberDecimal', 'NumberDouble'];

function ctorToEjson(name: string, arg: string): string {
  const trimmed = arg.trim();
  const m = trimmed.match(/^(['"])([\s\S]*)\1$/);
  const inner = m ? m[2] : trimmed;
  switch (name) {
    case 'ObjectId': return JSON.stringify({ $oid: inner });
    case 'ISODate':
    case 'Date': return JSON.stringify({ $date: inner });
    case 'NumberLong':
    case 'Long': return JSON.stringify({ $numberLong: String(inner) });
    case 'NumberInt': return JSON.stringify({ $numberInt: String(inner) });
    case 'NumberDecimal': return JSON.stringify({ $numberDecimal: String(inner) });
    case 'NumberDouble': return String(Number(inner));
    default: return `${name}(${arg})`;
  }
}

// shell-style source text -> Extended JSON string. String literals are copied
// verbatim so e.g. a value "call ISODate()" is not mangled.
export function shellToEjson(text: string): string {
  let out = '';
  let i = 0;
  const n = text.length;

  while (i < n) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const q = c;
      out += c;
      i++;
      while (i < n) {
        if (text[i] === '\\') { out += text[i] + (text[i + 1] ?? ''); i += 2; continue; }
        out += text[i];
        if (text[i] === q) { i++; break; }
        i++;
      }
      continue;
    }

    let matched = false;
    for (const name of CTOR_NAMES) {
      if (!text.startsWith(name, i)) continue;
      const before = i === 0 ? '' : text[i - 1];
      if (/[A-Za-z0-9_$]/.test(before)) continue; // not a word boundary
      let j = i + name.length;
      while (j < n && /\s/.test(text[j])) j++;
      if (text[j] !== '(') continue;
      // capture balanced parens
      let depth = 0;
      let k = j;
      let arg = '';
      for (; k < n; k++) {
        const ch = text[k];
        if (ch === '(') { depth++; if (depth === 1) continue; }
        else if (ch === ')') { depth--; if (depth === 0) { k++; break; } }
        arg += ch;
      }
      out += ctorToEjson(name, arg);
      i = k;
      matched = true;
      break;
    }
    if (matched) continue;

    out += c;
    i++;
  }

  return out;
}
