// Render a document in mongosh "shell" style (ISODate(...), ObjectId(...),
// NumberLong(...), …) for the document editor, and convert that shell text back
// to Extended JSON for the backend on save. The display accepts both BSON
// instances and EJSON-shaped plain objects; the save path is string-tokenized so
// constructor-looking text inside string values is left untouched.
import { ObjectId, Long, Decimal128, Int32, Double, EJSON } from 'bson';
import { parseFilter } from 'mongodb-query-parser';

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

// Parse query-bar text the way MongoDB Compass does — via mongodb-query-parser
// (backed by @mongodb-js/shell-bson-parser in Loose mode). That accepts the full
// mongosh query style: unquoted keys, single quotes, trailing commas, BSON
// constructors (ObjectId(…), ISODate(…), NumberLong(…), UUID(…), …) and safe
// expressions (e.g. `2 * 3`, `Math.max(…)`), with AST-validated, sandboxed
// evaluation (no arbitrary code execution). A braceless field list like
// `foo: 1` is wrapped into an object first, so double quotes and braces are
// both optional. Malformed input throws, same as before.
//
// The parser returns real BSON values; we re-serialize to an EJSON-shaped plain
// object so every caller can keep JSON.stringify-ing the result to the backend
// — the output contract is unchanged.
//
// Relaxed EJSON keeps the output clean, but it collapses a 64-bit Long to a JS
// double, silently corrupting values beyond 2^53 (e.g. a big id/counter). So we
// serialize canonically ONLY when a Long is actually present, keeping the clean
// relaxed form for the common case.
function containsLong(v: any): boolean {
  if (v == null || typeof v !== 'object') return false;
  if ((v as { _bsontype?: string })._bsontype === 'Long') return true;
  if (Array.isArray(v)) return v.some(containsLong);
  return Object.values(v).some(containsLong);
}
function serializeQuery(v: any): any {
  return EJSON.serialize(v, { relaxed: !containsLong(v) });
}
/**
 * The two parse failures this module raises ITSELF, as stable codes.
 *
 * Callers interpolate `err.message` into a translated wrapper
 * (documents:documentViewer.errors.invalidJsonSyntax), so a hard-coded English
 * message reached German users as "Ungültige JSON-Syntax: Query must be an
 * object". The message stays English for logs and stack traces; the UI maps
 * `code` to a translated string instead (see `shellDocErrorKey`). Errors that
 * come from the underlying parser carry no code and still fall back to their
 * own message, which no amount of work here can localise.
 */
export type ShellDocErrorCode = 'invalidQuery' | 'queryMustBeObject';

export class ShellDocError extends SyntaxError {
  readonly code: ShellDocErrorCode;
  constructor(code: ShellDocErrorCode, message: string) {
    super(message);
    this.name = 'ShellDocError';
    this.code = code;
  }
}

/** Catalog key for a ShellDocError, or null for anything else. */
export function shellDocErrorKey(err: unknown): string | null {
  const code = (err as ShellDocError | undefined)?.code;
  if (code === 'invalidQuery') return 'documentViewer.errors.invalidQuery';
  if (code === 'queryMustBeObject') return 'documentViewer.errors.queryMustBeObject';
  return null;
}

/**
 * Invisible characters that ride along with pasted text.
 *
 * Deliberately NOT the whole `U+200B–U+200D` run. ZWNJ and ZWJ are valid
 * ECMAScript identifier characters, so `a<ZWNJ>b` is a field name genuinely
 * distinct from `ab` — dropping them would send the query to a different field
 * without saying so. Only the zero-width SPACE, which a web page injects and
 * no identifier may contain, and the byte-order mark.
 */
const ZERO_WIDTH = /[\u200B\uFEFF]/;
/** Spaces that are not the space character: NBSP and the typographic run. */
const UNICODE_SPACE = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/;
const CURLY_PAIRS: Record<string, string> = { '\u201C': '\u201D', '\u2018': '\u2019' };

/**
 * Undo what copying a query out of a browser, a chat window or a document does
 * to it.
 *
 * A query pasted from anywhere that applies smart quotes arrives with `“ ”`
 * instead of `" "`, and text copied out of a web page routinely carries a
 * zero-width space. Both read as perfectly ordinary queries on screen — the
 * zero-width one is literally invisible — and both made the parser fail with
 * nothing to go on but "Invalid JSON".
 *
 * Conservative on purpose:
 *
 * - Straight-quoted strings are copied out verbatim, so a value that contains
 *   a curly quote or an exotic space keeps it.
 * - Regex literals are copied out verbatim. `/“ACME”/` is a pattern that
 *   really does contain smart quotes, and rewriting them would leave a filter
 *   that still runs and quietly matches different documents.
 * - A curly quote is only rewritten when its matching partner appears later.
 *   A lone `’` is an apostrophe, and inventing a string around it would
 *   corrupt a query that works today.
 * - Trailing semicolons go, because a filter copied off the end of a
 *   JavaScript statement brings one.
 */
export function normalizePastedQuery(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    // Verbatim: whatever is inside a straight-quoted string is the user's data.
    if (c === '"' || c === "'") {
      out += c;
      i++;
      while (i < text.length) {
        if (text[i] === '\\') {
          out += text[i] + (text[i + 1] ?? '');
          i += 2;
          continue;
        }
        out += text[i];
        if (text[i] === c) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    // Verbatim: a regex literal's contents are a pattern, not syntax.
    if (c === '/' && startsRegex(out)) {
      const end = endOfRegex(text, i);
      if (end !== -1) {
        out += text.slice(i, end);
        i = end;
        continue;
      }
    }
    const closer = CURLY_PAIRS[c];
    if (closer) {
      const end = closingSmartQuote(text, i + 1, closer);
      if (end !== -1) {
        out += asStraightString(text.slice(i + 1, end));
        i = end + 1;
        continue;
      }
      // No partner: an apostrophe, not a delimiter. Leave it exactly as it is.
    }
    if (ZERO_WIDTH.test(c)) {
      i++;
      continue;
    }
    out += UNICODE_SPACE.test(c) ? ' ' : c;
    i++;
  }
  return stripTrailingSemicolons(out);
}

/**
 * Where a smart-quoted run actually ends.
 *
 * Not simply the next `’`: in `‘O’Reilly’` that one is an apostrophe, and
 * taking it would turn a common pasted value into `"O"Reilly’`. Nor the last
 * one, which would swallow `‘x’, b: ‘y’` whole. A closing delimiter is
 * followed by something structural — a comma, a closing bracket, a colon when
 * the run was a key, or nothing at all — where an apostrophe inside a word is
 * followed by more word.
 *
 * The lookahead reads the ORIGINAL text, so it has to skip what the rest of
 * this normalizer is about to remove: a paste carries its damage in
 * combination, and `“x”;` or `“x”<zero-width>}` would otherwise keep its curly
 * quotes because the closer was followed by something not yet cleaned up.
 *
 * -1 when no candidate qualifies, which leaves the text exactly as the user
 * typed it: a parse error they can see beats a silent change of meaning.
 */
function closingSmartQuote(text: string, from: number, closer: string): number {
  for (let i = text.indexOf(closer, from); i !== -1; i = text.indexOf(closer, i + 1)) {
    let j = i + 1;
    // `\s` already covers the non-breaking and typographic spaces, but not the
    // zero-width run, which this normalizer drops outright.
    while (j < text.length && (/\s/.test(text[j]) || ZERO_WIDTH.test(text[j]))) j++;
    if (j >= text.length || ',}])'.includes(text[j]) || text[j] === ':' || text[j] === ';') {
      return i;
    }
  }
  return -1;
}

/**
 * Re-quote a smart-quoted run as a straight-quoted one, changing NOTHING else.
 *
 * Only the delimiters were wrong, so only the delimiters are replaced.
 * Re-encoding the body — `JSON.stringify`, say — escapes its backslashes a
 * second time, and `“a\nb”` stops meaning a newline and starts meaning the
 * two characters, which is the same silent change of meaning this whole
 * function exists to avoid. Escape pairs pass through untouched; only a
 * straight quote that would end the string early gets escaped.
 */
function asStraightString(body: string): string {
  let out = '"';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\') {
      // A trailing lone backslash would escape the quote this adds.
      out += c + (body[i + 1] ?? '\\');
      i++;
      continue;
    }
    out += c === '"' ? '\\"' : c;
  }
  return `${out}"`;
}

/**
 * Whether a `/` here opens a regex literal rather than divides.
 *
 * In a query a regex is always a value, so it follows a key's colon, a comma,
 * an opening bracket, or nothing at all. Division does not appear in filter
 * syntax — arithmetic goes through `$divide` — so this cannot mistake one for
 * the other.
 */
function startsRegex(before: string): boolean {
  const prev = before.replace(/\s+$/, '').slice(-1);
  return prev === '' || prev === ':' || prev === ',' || prev === '[' || prev === '(' || prev === '{';
}

/**
 * The index just past a regex literal's closing `/` and flags, or -1 if it
 * never closes — in which case the `/` was something else and is left alone.
 */
function endOfRegex(text: string, start: number): number {
  let i = start + 1;
  let inClass = false;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '\n') return -1;
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) {
      i++;
      while (i < text.length && /[a-z]/i.test(text[i])) i++;
      return i;
    }
    i++;
  }
  return -1;
}

/** Drop `;` off the end, but only when it is not inside a string. */
function stripTrailingSemicolons(text: string): string {
  let cut = text.length;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'") {
      i++;
      while (i < text.length) {
        if (text[i] === '\\') {
          i += 2;
          continue;
        }
        if (text[i] === c) {
          i++;
          break;
        }
        i++;
      }
      cut = text.length;
      continue;
    }
    if (c === ';' || /\s/.test(c)) {
      if (c === ';' && cut === text.length) cut = i;
    } else {
      cut = text.length;
    }
    i++;
  }
  return cut === text.length ? text : text.slice(0, cut);
}

export function parseShellJson(text: string): any {
  const trimmed = normalizePastedQuery(text).trim();
  if (!trimmed) return {};
  // parseFilter signals "unparseable / not a valid query" by returning an empty
  // string rather than throwing (e.g. `{ _id }`, a half-typed field). Surface
  // that as an error so callers (live validation + Run) reject it instead of
  // shipping `""` to the backend. A user who literally typed `""`/`''` (a rare
  // empty-string stage body) is left alone.
  const attempt = (s: string) => {
    const result = parseFilter(s);
    if (result === '' && !/^(['"])\1$/.test(s.trim())) {
      throw new ShellDocError('invalidQuery', 'Invalid query');
    }
    return result;
  };
  try {
    return serializeQuery(attempt(trimmed));
  } catch (err) {
    // A braceless field list like `foo: 1` isn't a valid standalone expression;
    // wrap it into an object and retry. Bare values (a `$count` stage body of
    // `"n"`, a number, an array) parse on the first try, so they never reach
    // here. Anything still unparseable re-throws the original error.
    if (!/^[{[]/.test(trimmed)) {
      try {
        return serializeQuery(attempt(`{${trimmed}}`));
      } catch {
        /* fall through to re-throw the original error */
      }
    }
    throw err;
  }
}

// A find filter / sort / projection MUST be a document (plain object). The
// parser otherwise happily accepts a bare value, number, string, array, or
// expression (e.g. `5`, `"active"`, `[1,2,3]`, `2*3`), which then reaches the
// backend and fails with a cryptic "got String instead" BSON error. Throwing
// here lets the live validation flag the field and Run stay disabled. Empty
// input is a valid empty query ({}). Not for aggregation stage bodies, which
// can legitimately be non-objects (e.g. a `$count` body of "n").
export function parseQueryObject(text: string): any {
  const parsed = parseShellJson(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ShellDocError('queryMustBeObject', 'Query must be an object');
  }
  return parsed;
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
