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
      // `" : "` (not `": "`) to match how the results grid renders documents —
      // the same document must not look different in the grid and the editor.
      // See DataGrid's `jsonPunct(' : ')`.
      .map((k) => `${padIn}${JSON.stringify(k)} : ${docToShell(v[k], indent + 1)}`)
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

// Regex options MongoDB understands, passed through untouched.
const BSON_REGEX_FLAGS = 'imxlsu';

// JS-only flags that cannot change which documents match, so dropping them is
// safe. `g` ("keep scanning after the first hit") and `d` (capture-index
// metadata) both describe how a JS engine walks a string, not what the pattern
// accepts — the set of strings the regex matches is identical without them.
//
// Every other JS-only flag is NOT safe to drop, and is rejected below instead.
// `y` (sticky) anchors the match at lastIndex, so a fresh `/foo/y` matches only
// at position 0 while the reconstructed `/foo/` matches anywhere — silently
// running a BROADER query than the user wrote. `v` (unicodeSets) changes how
// character classes parse, so removing it can reinterpret the pattern outright.
// Quietly widening a filter is the failure mode this whole path exists to
// avoid, so where the semantics cannot be preserved we refuse rather than
// guess. Rejecting is no worse than before: these already failed, just with a
// BSON error nobody could act on.
//
// Of these only `y` is reachable today — the parser's own regex lexer rejects
// `d` and `v` as invalid flags before we ever see them. They are listed anyway
// so that a parser upgrade cannot silently turn `d` into a rejection or `v`
// into a semantics change.
const DROPPABLE_REGEX_FLAGS = 'gd';

// Real BSON instances, by their `_bsontype` tag. Checked against this set
// rather than for any truthy `_bsontype`, because a user's own document may
// legitimately contain a field called `_bsontype` — `{meta: {_bsontype: "x",
// name: /a/g}}` would otherwise be mistaken for a BSON scalar and skipped,
// leaving the nested regex unnormalised for EJSON to reject. (UUID reports as
// Binary, which it subclasses.)
const BSON_TYPE_NAMES = new Set([
  'Binary', 'BSONRegExp', 'BSONSymbol', 'Code', 'DBRef', 'Decimal128',
  'Double', 'Int32', 'Long', 'MaxKey', 'MinKey', 'ObjectId', 'Timestamp',
]);

/**
 * Drop regex flags BSON cannot carry, reporting which ones went.
 *
 * `{name: /test/g}` is the query a user brings over from mongosh or Compass,
 * and it used to fail the whole find with "The regular expression option [g]
 * is not supported" — thrown by EJSON, the only strict validator in the stack.
 *
 * Compass runs that query by handing the native RegExp straight to the driver,
 * whose serializer rewrites `g` to `s` (dotAll). So it runs, but matches by
 * different rules than it reads — `.` starts crossing newlines — and Compass
 * then fails to save it to history for exactly the reason we failed here,
 * swallowing that error into a debug log.
 *
 * Neither behaviour is worth copying. `g` means "keep scanning after the first
 * hit", which is meaningless when the server is selecting documents, so the
 * flag is dropped rather than translated: the pattern keeps the semantics the
 * user wrote. The caller gets the dropped flags so the query bar can say so,
 * instead of the query quietly meaning something else.
 *
 * Only plain containers are rebuilt. BSON instances (ObjectId, Long, Binary,
 * …) and Dates pass through by reference, and an untouched subtree keeps its
 * original identity, so `containsLong` still walks the same graph.
 */
function normalizeRegexFlags(v: any, dropped: Set<string>): any {
  if (v === null || typeof v !== 'object') return v;
  // Tag-based, not `instanceof`: the query parser evaluates in a sandbox, so a
  // value coming back out of it need not share this realm's prototypes.
  const tag = Object.prototype.toString.call(v);
  if (tag === '[object RegExp]') {
    const flags: unknown = (v as RegExp).flags;
    // No flag string to reason about — leave it exactly as it is.
    if (typeof flags !== 'string') return v;
    const unsafe = [...flags].find(
      (f) => !BSON_REGEX_FLAGS.includes(f) && !DROPPABLE_REGEX_FLAGS.includes(f)
    );
    if (unsafe) {
      throw new ShellDocError(
        'unsupportedRegexFlag',
        `MongoDB does not support the regular expression flag [${unsafe}]`,
        { flag: unsafe }
      );
    }
    const kept = [...flags].filter((f) => BSON_REGEX_FLAGS.includes(f)).join('');
    if (kept === flags) return v;
    for (const f of flags) if (!kept.includes(f)) dropped.add(f);
    // `kept` is a subset of flags JS already accepted, so this cannot throw.
    return new RegExp((v as RegExp).source, kept);
  }
  const bsontype: unknown = (v as { _bsontype?: unknown })._bsontype;
  if (tag === '[object Date]' || (typeof bsontype === 'string' && BSON_TYPE_NAMES.has(bsontype))) {
    return v;
  }
  if (Array.isArray(v)) {
    let changed = false;
    const out = v.map((item) => {
      const next = normalizeRegexFlags(item, dropped);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? out : v;
  }
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) {
    const next = normalizeRegexFlags(val, dropped);
    if (next !== val) changed = true;
    out[k] = next;
  }
  return changed ? out : v;
}

/**
 * What the parser had to change to make a query expressible as BSON.
 *
 * Not errors — the query still runs — but the user is told rather than left
 * with a filter that means something slightly different from what they typed.
 */
export interface ShellDocNotices {
  /** Regex flags dropped because BSON has no equivalent, e.g. `['g']`. */
  droppedRegexFlags: string[];
}

function serializeQuery(v: any, dropped: Set<string>): any {
  const normalized = normalizeRegexFlags(v, dropped);
  return EJSON.serialize(normalized, { relaxed: !containsLong(normalized) });
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
export type ShellDocErrorCode =
  | 'invalidQuery'
  | 'queryMustBeObject'
  | 'unsupportedRegexFlag';

export class ShellDocError extends SyntaxError {
  readonly code: ShellDocErrorCode;
  /** Interpolation values for the translated message, e.g. `{ flag: 'y' }`. */
  readonly params?: Record<string, string>;
  constructor(code: ShellDocErrorCode, message: string, params?: Record<string, string>) {
    super(message);
    this.name = 'ShellDocError';
    this.code = code;
    this.params = params;
  }
}

/** Catalog key for a ShellDocError, or null for anything else. */
export function shellDocErrorKey(err: unknown): string | null {
  const code = (err as ShellDocError | undefined)?.code;
  if (code === 'invalidQuery') return 'documentViewer.errors.invalidQuery';
  if (code === 'queryMustBeObject') return 'documentViewer.errors.queryMustBeObject';
  if (code === 'unsupportedRegexFlag') return 'documentViewer.errors.unsupportedRegexFlag';
  return null;
}

/** Interpolation values to pass alongside `shellDocErrorKey`, if any. */
export function shellDocErrorParams(err: unknown): Record<string, string> | undefined {
  return (err as ShellDocError | undefined)?.params;
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

/** The range a BSON 64-bit long can hold. Outside it, there is nothing to preserve into. */
const I64_MAX = 9223372036854775807n;
const I64_MIN = -9223372036854775808n;

/**
 * Rewrite integer literals a JS number cannot hold into `NumberLong("…")`.
 *
 * The query parser evaluates a bare literal as a JS `number`, so anything past
 * 2^53 is rounded before we ever see it: `{counter: 9007199254740993}` reached
 * the server as `…992` and matched a different document, with no error and
 * nothing on screen to say so (#317). The loss happens during parsing, so the
 * only place to fix it is before parsing — hence a text pass.
 *
 * `NumberLong` is the right target rather than a workaround: the backend
 * already produces a BSON Int64 for such a literal (serde_json reads it
 * exactly, then bson maps it to Int64), so this restores the type the query
 * always should have had. shellDoc then serializes canonically, because
 * `containsLong` sees a Long, and the value survives to the server intact.
 *
 * Deliberately narrow — it only touches literals that are BOTH unrepresentable
 * as a double AND expressible as a long:
 *
 * - Values inside strings and regex literals are the user's data, so those are
 *   copied verbatim, exactly as `normalizePastedQuery` treats them.
 * - Anything with a `.`, an exponent, or a `0x`/`0b`/`0o`/`n` suffix is left
 *   alone. Those spell a double (or a form the parser handles itself) on
 *   purpose, and rewriting them would change the user's chosen type.
 * - Safe integers are left alone, so ordinary numbers keep serializing as they
 *   always have — no `{a: 42}` suddenly becoming a long.
 * - Object keys (`{123: 1}`) are skipped: a key is not a value, and
 *   `NumberLong("…")` is not valid there.
 * - Values beyond the i64 range are left alone. They cannot be a BSON long, so
 *   there is no lossless form to rewrite them into; they stay as they are
 *   rather than being silently truncated into a different wrong number.
 */
/**
 * Characters after which a fresh value may begin: `{a: N}`, `[N]`, `[1, N]`.
 *
 * Note what is NOT here. `(` is excluded so `NumberLong(9007199254740993)`
 * keeps its own argument instead of becoming `NumberLong(NumberLong("…"))`,
 * and arithmetic operators are excluded so an operand is left alone.
 */
const VALUE_STARTS_AFTER = ':,[';

/**
 * Characters that can follow a complete value: `{a: N}`, `[N]`, `[N, 1]`.
 *
 * The mirror of VALUE_STARTS_AFTER, and needed for the same reason from the
 * other side. Checking only what precedes a literal caught `{a: 1 + N}` but
 * not `{a: N + 1}`, where the literal is the LEFT operand — that became
 * `NumberLong("…") + 1`, and JS concatenated the long's toString into the
 * string "90071992547409931", turning a numeric query into a string one
 * without a word (#318 review).
 *
 * It also subsumes the property-key case: `:` is not here, so `{123: 1}` is
 * left alone by the same rule rather than a second special case.
 */
const VALUE_ENDS_BEFORE = ',}])';

/**
 * Where does the literal we are about to read sit, and may we rewrite it?
 *
 * Rewriting anywhere a big integer appears is wrong, because the text around
 * it decides what it means. Three ways that bit (#318 review):
 *
 * - `{a: 1 - 9007199254740992}` — a spaced binary minus read as a sign, which
 *   ate the operator and left `{a: 1 NumberLong("-…")}`, so a valid query
 *   stopped parsing entirely.
 * - `{a: 1 + 9007199254740992}` — an operand rewritten into a Long, leaving
 *   the parser to do arithmetic on an object.
 * - `{a: NumberLong(9007199254740993)}` — an argument rewritten inside the
 *   very constructor that was already asking for a long.
 *
 * So this only says yes in value position, where a literal can stand alone.
 * Anywhere else the pre-existing behaviour is kept: an arithmetic operand
 * still rounds, which is worse than exact but far better than not parsing.
 */
function classifyNumberPlacement(
  last: string,
  prev: string,
  out: string
): 'plain' | 'signed' | 'skip' {
  const startsValue = (ch: string) => ch === '' || VALUE_STARTS_AFTER.includes(ch);
  if (last === '-') {
    // A minus is a sign only when nothing that could end an operand precedes
    // it; otherwise this is subtraction and the minus is not ours to take.
    //
    // It also has to still be at the end of the emitted text, since folding it
    // into the literal means deleting it from there. A comment sitting between
    // the two (`-/* note */5`) would make that deletion miss, so those are left
    // alone rather than mangled — an exotic spelling of a rare case.
    return startsValue(prev) && /-\s*$/.test(out) ? 'signed' : 'skip';
  }
  return startsValue(last) ? 'plain' : 'skip';
}

/** End of the comment starting at `i`, or -1 when none starts there. */
function endOfComment(text: string, i: number): number {
  if (text[i] !== '/') return -1;
  if (text[i + 1] === '/') {
    const nl = text.indexOf('\n', i);
    return nl === -1 ? text.length : nl;
  }
  if (text[i + 1] === '*') {
    const end = text.indexOf('*/', i + 2);
    return end === -1 ? text.length : end + 2;
  }
  return -1;
}

/**
 * First index at or after `from` holding something syntactically meaningful —
 * whitespace and comments are both skipped.
 *
 * Looking only past whitespace is what let `{a: 1, 9007199254740992 /* n *\/: 1}`
 * be mistaken for a value and rewritten into `NumberLong("…"): 1`, which is not
 * a property key and stopped the query parsing (#318 review).
 */
function skipTrivia(text: string, from: number): number {
  let k = from;
  for (;;) {
    while (k < text.length && /\s/.test(text[k])) k++;
    const end = endOfComment(text, k);
    if (end === -1) return k;
    k = end;
  }
}

export function preserveBigIntegers(text: string): string {
  let out = '';
  let i = 0;
  // The last two *syntactically meaningful* characters emitted — whitespace and
  // comments do not count. Placement has to be judged on these rather than on
  // the tail of `out`, because scanning `out` back would trip over the very
  // things this pass copies verbatim (a `//` inside a URL string, a comment
  // between the delimiter and the value).
  let lastMeaningful = '';
  let prevMeaningful = '';
  const remember = (ch: string) => {
    prevMeaningful = lastMeaningful;
    lastMeaningful = ch;
  };
  while (i < text.length) {
    const c = text[i];
    // Verbatim: a string's contents are data, not syntax.
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
      remember('"');
      continue;
    }
    // Comments are copied through but leave no syntactic trace, so they must
    // be recognised BEFORE the regex branch — `/*` otherwise reads as a regex
    // opener, and the closing `/` then looks like the token before the value,
    // which left `{counter: /* note */ 9007199254740993}` unrewritten and
    // still rounding (#318 review).
    const commentEnd = endOfComment(text, i);
    if (commentEnd !== -1) {
      out += text.slice(i, commentEnd);
      i = commentEnd;
      continue;
    }
    // Verbatim: digits inside a pattern are part of the pattern.
    if (c === '/' && startsRegex(lastMeaningful)) {
      const end = endOfRegex(text, i);
      if (end !== -1) {
        out += text.slice(i, end);
        i = end;
        remember('/');
        continue;
      }
    }
    if (c >= '0' && c <= '9') {
      const prev = out[out.length - 1] ?? '';
      // A digit run only starts a literal at a token boundary — `a1` and
      // `1.5`'s tail are continuations, not new numbers.
      if (!/[A-Za-z0-9_$.]/.test(prev)) {
        let j = i;
        while (j < text.length && text[j] >= '0' && text[j] <= '9') j++;
        const digits = text.slice(i, j);
        const after = text[j] ?? '';
        const isPlainInteger = !/[.eExXbBoOn_]/.test(after);
        // Whatever follows must be able to end a value. One rule covers both a
        // property key (`{123: 1}` — `:` cannot end a value) and a literal used
        // as the left operand of an expression (`{a: N + 1}` — nor can `+`).
        const next = text[skipTrivia(text, j)] ?? '';
        const endsValue = next === '' || VALUE_ENDS_BEFORE.includes(next);
        if (isPlainInteger && endsValue && !Number.isSafeInteger(Number(digits))) {
          const placement = classifyNumberPlacement(lastMeaningful, prevMeaningful, out);
          if (placement !== 'skip') {
            // A unary minus comes along inside the long, so the parser is
            // never asked to negate a Long object.
            const literal = (placement === 'signed' ? '-' : '') + digits;
            const value = BigInt(literal);
            if (value >= I64_MIN && value <= I64_MAX) {
              if (placement === 'signed') out = out.replace(/-\s*$/, '');
              out += `NumberLong("${literal}")`;
              i = j;
              remember('0');
              continue;
            }
          }
        }
      }
    }
    out += c;
    if (!/\s/.test(c)) remember(c);
    i++;
  }
  return out;
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

export function parseShellJson(text: string, notices?: ShellDocNotices): any {
  const trimmed = preserveBigIntegers(normalizePastedQuery(text)).trim();
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
  // Collected per attempt: the braceless retry below re-parses from scratch, so
  // notices from an attempt that then failed must not leak into the result.
  const dropped = new Set<string>();
  const commit = () => {
    if (notices) notices.droppedRegexFlags = [...dropped];
  };
  try {
    const out = serializeQuery(attempt(trimmed), dropped);
    commit();
    return out;
  } catch (err) {
    // A braceless field list like `foo: 1` isn't a valid standalone expression;
    // wrap it into an object and retry. Bare values (a `$count` stage body of
    // `"n"`, a number, an array) parse on the first try, so they never reach
    // here. Anything still unparseable re-throws the original error.
    if (!/^[{[]/.test(trimmed)) {
      dropped.clear();
      try {
        const out = serializeQuery(attempt(`{${trimmed}}`), dropped);
        commit();
        return out;
      } catch (retryErr) {
        // The wrapped retry got further than the original attempt: it parsed,
        // and failed only because the value cannot be represented in BSON.
        // That is the diagnosis worth showing — re-throwing the original
        // "not a valid expression" error would hide the real reason.
        if (
          retryErr instanceof ShellDocError &&
          retryErr.code === 'unsupportedRegexFlag'
        ) {
          throw retryErr;
        }
        /* otherwise fall through to re-throw the original error */
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
export function parseQueryObject(text: string, notices?: ShellDocNotices): any {
  const parsed = parseShellJson(text, notices);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    // The query is rejected, so anything we noticed about it is moot — leaving
    // it set would caption a filter that never ran.
    if (notices) notices.droppedRegexFlags = [];
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
