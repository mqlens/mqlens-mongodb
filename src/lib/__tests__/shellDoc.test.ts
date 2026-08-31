import { describe, it, expect } from 'vitest';
import { ObjectId, Long, Decimal128, Int32 } from 'bson';
import { docToShell, shellToEjson, parseShellJson, parseQueryObject, preserveBigIntegers, shellDocErrorKey, shellDocErrorParams, type ShellDocNotices } from '../shellDoc';

describe('docToShell', () => {
  it('renders EJSON-shaped values as shell constructors', () => {
    const out = docToShell({
      _id: { $oid: '507f1f77bcf86cd799439011' },
      seats: 3,
      createdAt: { $date: '2025-01-04T00:00:00.000Z' },
      big: { $numberLong: '9007199254740993' },
      price: { $numberDecimal: '12.50' },
      n: { $numberInt: '7' },
      name: 'Acme',
    });
    expect(out).toContain('"_id" : ObjectId("507f1f77bcf86cd799439011")');
    expect(out).toContain('"createdAt" : ISODate("2025-01-04T00:00:00.000Z")');
    expect(out).toContain('"big" : NumberLong("9007199254740993")');
    expect(out).toContain('"price" : NumberDecimal("12.50")');
    expect(out).toContain('"n" : NumberInt(7)');
    expect(out).toContain('"name" : "Acme"');
  });

  it('renders canonical $date ($numberLong) as ISODate', () => {
    expect(docToShell({ d: { $date: { $numberLong: '1735948800000' } } })).toContain('ISODate("2025-01-04T00:00:00.000Z")');
  });

  it('renders BSON instances', () => {
    expect(docToShell(new ObjectId('507f1f77bcf86cd799439011'))).toBe('ObjectId("507f1f77bcf86cd799439011")');
    expect(docToShell(Long.fromString('42'))).toBe('NumberLong("42")');
    expect(docToShell(Decimal128.fromString('1.5'))).toBe('NumberDecimal("1.5")');
    expect(docToShell(new Int32(9))).toBe('NumberInt(9)');
  });
});

describe('shellToEjson', () => {
  it('converts shell constructors back to Extended JSON', () => {
    const shell = '{\n  "_id": ObjectId("507f1f77bcf86cd799439011"),\n  "createdAt": ISODate("2025-01-04T00:00:00.000Z"),\n  "big": NumberLong("42"),\n  "price": NumberDecimal("12.50"),\n  "n": NumberInt(7)\n}';
    const parsed = JSON.parse(shellToEjson(shell));
    expect(parsed._id).toEqual({ $oid: '507f1f77bcf86cd799439011' });
    expect(parsed.createdAt).toEqual({ $date: '2025-01-04T00:00:00.000Z' });
    expect(parsed.big).toEqual({ $numberLong: '42' });
    expect(parsed.price).toEqual({ $numberDecimal: '12.50' });
    expect(parsed.n).toEqual({ $numberInt: '7' });
  });

  it('leaves plain JSON untouched', () => {
    expect(shellToEjson('{"name":"Ada"}')).toBe('{"name":"Ada"}');
  });

  it('does not mangle constructor-like text inside string values', () => {
    const parsed = JSON.parse(shellToEjson('{ "note": "run ISODate(now) please" }'));
    expect(parsed.note).toBe('run ISODate(now) please');
  });

  it('round-trips docToShell -> shellToEjson', () => {
    const doc = { _id: { $oid: '507f1f77bcf86cd799439011' }, when: { $date: '2025-01-04T00:00:00.000Z' }, tags: ['a', 'b'] };
    expect(JSON.parse(shellToEjson(docToShell(doc)))).toEqual(doc);
  });
});

describe('parseShellJson', () => {
  it('parses plain JSON', () => {
    expect(parseShellJson('{"a": 1}')).toEqual({ a: 1 });
  });
  it('parses shell constructors into EJSON shapes', () => {
    expect(parseShellJson('{"_id": ObjectId("507f1f77bcf86cd799439011")}'))
      .toEqual({ _id: { $oid: '507f1f77bcf86cd799439011' } });
    // EJSON.serialize normalizes the date string (same instant); .000 is dropped.
    expect(parseShellJson('{"when": {"$gte": ISODate("2025-01-04T00:00:00.000Z")}}'))
      .toEqual({ when: { $gte: { $date: '2025-01-04T00:00:00Z' } } });
  });
  it('leaves EJSON wrappers untouched', () => {
    expect(parseShellJson('{"_id": {"$oid": "507f1f77bcf86cd799439011"}}'))
      .toEqual({ _id: { $oid: '507f1f77bcf86cd799439011' } });
  });
  it('does not convert constructor-like text inside strings', () => {
    expect(parseShellJson('{"note": "ObjectId(fake)"}')).toEqual({ note: 'ObjectId(fake)' });
  });
  it('throws on invalid input', () => {
    expect(() => parseShellJson('{nope')).toThrow();
  });
});

describe('parseShellJson — relaxed shell-style input (#216)', () => {
  it('accepts unquoted keys', () => {
    expect(parseShellJson('{ createdAt: 1 }')).toEqual({ createdAt: 1 });
  });
  it('accepts single-quoted keys and string values', () => {
    expect(parseShellJson("{ 'name': 'Ada' }")).toEqual({ name: 'Ada' });
  });
  it('accepts a trailing comma', () => {
    expect(parseShellJson('{ status: "active", }')).toEqual({ status: 'active' });
  });
  it('accepts unquoted operator keys', () => {
    expect(parseShellJson('{ age: { $gte: 18 } }')).toEqual({ age: { $gte: 18 } });
  });
  it('combines unquoted keys with shell constructors', () => {
    expect(parseShellJson('{ _id: ObjectId("507f1f77bcf86cd799439011") }'))
      .toEqual({ _id: { $oid: '507f1f77bcf86cd799439011' } });
  });
  it('still supports quoted keys for dotted paths', () => {
    expect(parseShellJson('{ "user.age": { $gt: 21 } }')).toEqual({ 'user.age': { $gt: 21 } });
  });
  it('still throws on genuinely malformed input', () => {
    expect(() => parseShellJson('{ oops ')).toThrow();
  });
  it('accepts braceless field:value input (auto-wrapped)', () => {
    expect(parseShellJson('datacenterId: "METROPOLITAN_DC"')).toEqual({ datacenterId: 'METROPOLITAN_DC' });
  });
  it('accepts a braceless multi-field filter', () => {
    expect(parseShellJson('a: 1, b: 2')).toEqual({ a: 1, b: 2 });
  });
  it('evaluates safe arithmetic expressions (Compass loose mode)', () => {
    expect(parseShellJson('{ limit: 2 * 3 }')).toEqual({ limit: 6 });
  });
  it('throws on an incomplete query (parser returns its empty-string sentinel)', () => {
    // mongodb-query-parser returns '' for unparseable input instead of throwing;
    // parseShellJson must surface that as an error so validation/Run reject it.
    expect(() => parseShellJson('{ _id }')).toThrow();
    expect(() => parseShellJson('type: "DEV", _id')).toThrow();
    expect(() => parseShellJson('{ a: 1, b }')).toThrow();
  });
});

describe('parseQueryObject — reject non-object queries (#222 review)', () => {
  it('accepts a plain object and empty', () => {
    expect(parseQueryObject('{ a: 1 }')).toEqual({ a: 1 });
    expect(parseQueryObject('')).toEqual({});
  });
  it('rejects bare values, numbers, strings, arrays, expressions', () => {
    expect(() => parseQueryObject('5')).toThrow();
    expect(() => parseQueryObject('"active"')).toThrow();
    expect(() => parseQueryObject('[1,2,3]')).toThrow();
    expect(() => parseQueryObject('2*3')).toThrow();
  });
});

describe('parseShellJson — NumberLong precision (#222 review)', () => {
  it('preserves a 64-bit NumberLong beyond 2^53 (canonical when a Long is present)', () => {
    expect(parseShellJson('{ n: NumberLong("9223372036854775807") }'))
      .toEqual({ n: { $numberLong: '9223372036854775807' } });
  });
  it('keeps small numbers in clean relaxed form', () => {
    expect(parseShellJson('{ a: 1 }')).toEqual({ a: 1 });
  });
});

describe('parseShellJson — queries pasted from somewhere else', () => {
  // A query copied out of a browser, a chat window or a document arrives with
  // characters that look exactly like the ones the user meant. The parser
  // rejected them with nothing to go on but "Invalid JSON", on a query that
  // reads as perfectly correct on screen.
  it('accepts smart double quotes', () => {
    expect(parseShellJson('domain: “account.test.com”')).toEqual({
      domain: 'account.test.com',
    });
  });

  it('accepts smart single quotes', () => {
    expect(parseShellJson('domain: ‘account.test.com’')).toEqual({
      domain: 'account.test.com',
    });
  });

  it('accepts a zero-width space, which nobody can see', () => {
    expect(parseShellJson('domain:​ "account.test.com"')).toEqual({
      domain: 'account.test.com',
    });
  });

  it('accepts a non-breaking space', () => {
    expect(parseShellJson('domain: "account.test.com"')).toEqual({
      domain: 'account.test.com',
    });
  });

  it('accepts a trailing semicolon, as copied off a JavaScript line', () => {
    expect(parseShellJson('{ domain: "account.test.com" };')).toEqual({
      domain: 'account.test.com',
    });
  });

  it('leaves a smart quote inside a string alone', () => {
    // The user is searching for that character. Rewriting it would change what
    // the query means.
    expect(parseShellJson('note: "he said “hi”"')).toEqual({
      note: 'he said “hi”',
    });
  });

  it('leaves a lone curly apostrophe alone', () => {
    // No closing partner, so it is an apostrophe rather than a delimiter —
    // in a regex here, where inventing a string would corrupt a query that
    // works today.
    const parsed = parseShellJson('name: /don’t/');
    expect(parsed.name.$regularExpression.pattern).toBe('don’t');
  });

  it('keeps an apostrophe inside a smart-quoted value', () => {
    // The `’` after O is part of the name, not the end of the string. Taking
    // it produced `"O"Reilly’` and rejected a perfectly ordinary value.
    expect(parseShellJson('name: ‘O’Reilly’')).toEqual({ name: 'O’Reilly' });
  });

  it('does not run one smart-quoted value into the next', () => {
    expect(parseShellJson('{a: ‘x’, b: ‘y’}')).toEqual({ a: 'x', b: 'y' });
  });

  it('handles a smart-quoted key', () => {
    expect(parseShellJson('{“domain”: “a.com”}')).toEqual({ domain: 'a.com' });
  });

  it('keeps escape sequences meaning what they meant', () => {
    // Only the delimiters were wrong. Re-encoding the body escapes its
    // backslashes a second time, so `\n` stops being a newline and starts
    // being two characters — a filter that quietly matches something else.
    // Source text here is: q: “a\nb”
    expect(parseShellJson('q: \u201Ca\\nb\u201D')).toEqual({ q: 'a\nb' });
    // Source text: path: “C:\\temp”, which a shell string reads as one slash.
    expect(parseShellJson('path: \u201CC:\\\\temp\u201D')).toEqual({ path: 'C:\\temp' });
  });

  it('keeps a joiner that belongs to a field name', () => {
    // ZWNJ and ZWJ are valid identifier characters, so `a<ZWNJ>b` is a field
    // genuinely distinct from `ab`. Dropping them sent the query to a
    // different field and said nothing about it.
    const zwnj = '‌';
    const parsed = parseShellJson(`{ a${zwnj}b: 1 }`);
    expect(Object.keys(parsed)).toEqual([`a${zwnj}b`]);
  });

  it('still drops a zero-width space, which no identifier may contain', () => {
    expect(parseShellJson('domain:​ "a.com"')).toEqual({ domain: 'a.com' });
  });

  it('copes with several paste artifacts at once', () => {
    // A paste brings its damage in combination. The lookahead that finds the
    // closing quote reads the original text, so it has to skip what the rest
    // of the normalizer is about to remove.
    expect(parseShellJson('domain: “x”;')).toEqual({ domain: 'x' });
    expect(parseShellJson('{domain: “x”​}')).toEqual({ domain: 'x' });
    expect(parseShellJson('{“domain”​: “x”}')).toEqual({ domain: 'x' });
  });

  it('leaves a regex literal alone, smart quotes and all', () => {
    // `/“ACME”/` is a pattern that really does contain those characters.
    // Rewriting them leaves a filter that still runs and quietly matches
    // different documents, which is worse than refusing to parse.
    const parsed = parseShellJson('name: /“ACME”/');
    expect(parsed.name.$regularExpression.pattern).toBe('“ACME”');
  });

  it('leaves a regex alone inside an array of values', () => {
    const parsed = parseShellJson('tags: {$in: [/“a”/, "b"]}');
    expect(parsed.tags.$in[0].$regularExpression.pattern).toBe('“a”');
    expect(parsed.tags.$in[1]).toBe('b');
  });

  it('keeps regex flags and escaped slashes', () => {
    const parsed = parseShellJson('path: /a\\/b/i');
    expect(parsed.path.$regularExpression.pattern).toBe('a\\/b');
    expect(parsed.path.$regularExpression.options).toBe('i');
  });

  it('still fixes smart quotes that are not in a regex', () => {
    // The regex carve-out must not swallow the rest of the query.
    expect(parseShellJson('{ name: /x/, domain: “a.com” }')).toMatchObject({
      domain: 'a.com',
    });
  });

  it('keeps a semicolon that belongs to a value', () => {
    expect(parseShellJson('sql: "a;"')).toEqual({ sql: 'a;' });
  });

  it('keeps a straight quote found inside a smart-quoted run', () => {
    expect(parseShellJson('q: “say "hi"”')).toEqual({ q: 'say "hi"' });
  });
});

// #312: `{"name": /test/g}` failed the whole find with "The regular expression
// option [g] is not supported", which the query bar showed as "Invalid JSON" —
// so the reporter concluded MQLens had no regex support at all.
describe('parseShellJson — regex flags BSON cannot carry (#312)', () => {
  const flagsOf = (text: string, notices?: ShellDocNotices) =>
    parseShellJson(text, notices).name.$regularExpression.options;

  it('runs a /g query instead of rejecting it, and drops the flag', () => {
    const notices: ShellDocNotices = { droppedRegexFlags: [] };
    expect(flagsOf('{"name": /test/g}', notices)).toBe('');
    expect(notices.droppedRegexFlags).toEqual(['g']);
  });

  it('drops only the unsupported flag, keeping the rest of the pattern intact', () => {
    const notices: ShellDocNotices = { droppedRegexFlags: [] };
    const parsed = parseShellJson('{"name": /^a.c$/gi}', notices);
    expect(parsed.name.$regularExpression).toEqual({ pattern: '^a.c$', options: 'i' });
    expect(notices.droppedRegexFlags).toEqual(['g']);
  });

  it('drops `g` rather than translating it to `s` the way the driver does', () => {
    // The Node driver (and so mongosh and Compass) serializes a native RegExp
    // by mapping `global` onto `s` — dotAll — which silently makes `.` match
    // newlines. Copying that would change which documents the filter matches.
    expect(flagsOf('{"name": /test/g}')).not.toContain('s');
  });

  it('rejects sticky rather than silently widening the query (#315 review)', () => {
    // `/foo/y` only matches at position 0, so reconstructing `/foo/` would run
    // a BROADER query than the user wrote. Quietly widening a filter is the
    // failure this path exists to avoid, so it refuses instead of guessing.
    expect(() => parseShellJson('{"name": /test/y}')).toThrow(/\[y\]/);
    expect(() => parseShellJson('{"name": /test/gy}')).toThrow(/\[y\]/);
  });

  it('surfaces the flag it rejected as a translatable code, not a raw message', () => {
    try {
      parseShellJson('{"name": /test/y}');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(shellDocErrorKey(err)).toBe('documentViewer.errors.unsupportedRegexFlag');
      expect(shellDocErrorParams(err)).toEqual({ flag: 'y' });
    }
  });

  it('keeps the flag diagnosis through the braceless-retry path', () => {
    // `name: /a/y` only parses on the wrapped retry, so the original "not an
    // expression" error would otherwise mask the real reason.
    expect(() => parseShellJson('name: /a/y')).toThrow(/\[y\]/);
  });

  it('rejects `d` and `v` at the parser, before flag handling is reached', () => {
    // Documents why DROPPABLE_REGEX_FLAGS lists `d` even though nothing can
    // exercise it: the parser's regex lexer refuses both flags outright. If a
    // parser upgrade ever makes these reachable, this test fails and the flag
    // policy above gets a deliberate second look rather than silently applying.
    expect(() => parseShellJson('{"name": /test/d}')).toThrow(/Invalid regular expression flag/);
    expect(() => parseShellJson('{"name": /test/v}')).toThrow(/Invalid regular expression flag/);
  });

  it('does not mistake a user field named _bsontype for a BSON value (#315 review)', () => {
    // A document may legally contain a field called `_bsontype`, and treating
    // any truthy value there as a BSON scalar made the walker skip the subtree.
    // Narrowing the check to real BSON type tags is the correct reading either
    // way — but note the reviewer's predicted symptom does NOT reproduce:
    // EJSON refuses any plain object carrying a `_bsontype` field at all, with
    // a version error, whether or not a regex is nested under it. So such a
    // query fails identically before and after this change; the walker's early
    // return was never what broke it. That EJSON limitation is pre-existing and
    // separate from regex flags.
    expect(() => parseShellJson('{meta: {_bsontype: "custom", name: /test/g}}')).toThrow(
      /BSON version|bson types must be/
    );
    // What the narrowed check does buy: the walker no longer treats it as an
    // opaque leaf, so a genuine BSON value beside it is still handled normally.
    const parsed = parseShellJson('{_id: ObjectId("603d1f77bcf86cd799439011"), r: /a/g}');
    expect(parsed._id.$oid).toBe('603d1f77bcf86cd799439011');
    expect(parsed.r.$regularExpression.options).toBe('');
  });

  it('leaves flags MongoDB does support alone, and reports nothing', () => {
    for (const f of ['i', 'm', 'u', '']) {
      const notices: ShellDocNotices = { droppedRegexFlags: [] };
      expect(flagsOf(`{"name": /test/${f}}`, notices)).toBe(f);
      expect(notices.droppedRegexFlags).toEqual([]);
    }
  });

  it('reaches a regex nested in an operator and in an array', () => {
    const notices: ShellDocNotices = { droppedRegexFlags: [] };
    const parsed = parseShellJson('{tags: {$in: [/a/g, "b"]}}', notices);
    expect(parsed.tags.$in[0].$regularExpression.options).toBe('');
    expect(parsed.tags.$in[1]).toBe('b');
    expect(notices.droppedRegexFlags).toEqual(['g']);
  });

  it('normalises through the braceless-retry path too', () => {
    // `name: /test/g` is not a valid standalone expression, so it only parses
    // on the wrapped retry — which re-parses from scratch and must still report.
    const notices: ShellDocNotices = { droppedRegexFlags: [] };
    expect(flagsOf('name: /test/g', notices)).toBe('');
    expect(notices.droppedRegexFlags).toEqual(['g']);
  });

  it('leaves other BSON types untouched while normalising', () => {
    // The walker rebuilds plain containers; ObjectId/Date/Long must pass through
    // by reference, and a Long must still force canonical serialization.
    const parsed = parseShellJson(
      '{_id: ObjectId("603d1f77bcf86cd799439011"), n: NumberLong("9007199254740993"), r: /x/g}'
    );
    expect(parsed._id.$oid).toBe('603d1f77bcf86cd799439011');
    expect(parsed.n.$numberLong).toBe('9007199254740993');
    expect(parsed.r.$regularExpression.options).toBe('');
  });

  it('reports nothing for a query that was rejected', () => {
    const notices: ShellDocNotices = { droppedRegexFlags: [] };
    expect(() => parseQueryObject('[/a/g]', notices)).toThrow();
    expect(notices.droppedRegexFlags).toEqual([]);
  });
});

// #317: a bare integer past 2^53 was evaluated as a JS number during parsing,
// so it reached the server rounded — `{counter: 9007199254740993}` became
// ...992 and matched a different document, with no error and nothing on screen.
describe('parseShellJson — 64-bit integer literals (#317)', () => {
  const longAt = (text: string, key = 'counter') =>
    parseShellJson(text)[key].$numberLong;

  it('keeps an integer past 2^53 exact, in strict JSON and in shell syntax', () => {
    expect(longAt('{"counter": 9007199254740993}')).toBe('9007199254740993');
    expect(longAt('{counter: 9007199254740993}')).toBe('9007199254740993');
  });

  it('keeps a negative one exact, sign and all', () => {
    expect(longAt('{counter: -9007199254740993}')).toBe('-9007199254740993');
  });

  it('reaches values nested in arrays and operators', () => {
    expect(parseShellJson('{a: {$gt: 9007199254740993}}').a.$gt.$numberLong).toBe(
      '9007199254740993'
    );
    expect(parseShellJson('{a: [9007199254740993]}').a[0].$numberLong).toBe(
      '9007199254740993'
    );
  });

  it('works alongside other shell syntax in the same query', () => {
    // The mixed case is the one a strict-JSON fast path cannot reach, which is
    // why this is fixed in the parser's input rather than at a call site.
    const parsed = parseShellJson('{a: 9007199254740993, name: /x/i}');
    expect(parsed.a.$numberLong).toBe('9007199254740993');
    expect(parsed.name.$regularExpression.pattern).toBe('x');
  });

  it('handles the extremes of the 64-bit range', () => {
    expect(longAt('{counter: 9223372036854775807}')).toBe('9223372036854775807');
    expect(longAt('{counter: -9223372036854775808}')).toBe('-9223372036854775808');
  });

  it('leaves ordinary numbers exactly as they were', () => {
    // The rewrite must be invisible to every query that does not need it —
    // no `{a: 42}` quietly becoming a long.
    expect(parseShellJson('{a: 42}')).toEqual({ a: 42 });
    expect(parseShellJson('{a: 0}')).toEqual({ a: 0 });
    expect(parseShellJson('{a: 1.5}')).toEqual({ a: 1.5 });
    expect(parseShellJson('{a: 9007199254740991}')).toEqual({ a: 9007199254740991 });
  });

  it('leaves values that deliberately spell a double alone', () => {
    // A fraction or an exponent is the user choosing a double; rewriting it
    // would change the type they asked for.
    expect(parseShellJson('{a: 1e30}').a).toBe(1e30);
    expect(typeof parseShellJson('{a: 9007199254740993.5}').a).toBe('number');
  });

  it('does not touch digits inside strings or regexes', () => {
    expect(parseShellJson('{note: "9007199254740993"}')).toEqual({
      note: '9007199254740993',
    });
    expect(parseShellJson('{p: /9007199254740993/}').p.$regularExpression.pattern).toBe(
      '9007199254740993'
    );
  });

  it('leaves a value too large for a 64-bit long alone', () => {
    // There is no lossless form to rewrite into, so it stays as it is rather
    // than being truncated into a different wrong number.
    expect(typeof parseShellJson('{a: 99999999999999999999999999}').a).toBe('number');
  });

  it('rewrites the value, not a numeric key', () => {
    // `NumberLong("…")` is not valid in key position. A field name that long
    // is written quoted in practice, and that path is exact.
    expect(Object.keys(parseShellJson('{"9007199254740993": 1}'))).toEqual([
      '9007199254740993',
    ]);
  });
});

// #318 review: the rewrite originally fired wherever a big integer appeared,
// but the text around a literal decides what it means. Rewriting outside value
// position ate operators and wrapped constructor arguments in themselves.
describe('preserveBigIntegers — only rewrites in value position (#318 review)', () => {
  it('leaves a spaced binary minus intact', () => {
    // Was rewritten to `{a: 1 NumberLong("-9007199254740992")}`, which stopped
    // parsing altogether — a valid query broken by a precision fix.
    expect(preserveBigIntegers('{a: 1 - 9007199254740992}')).toBe(
      '{a: 1 - 9007199254740992}'
    );
    expect(() => parseShellJson('{a: 1 - 9007199254740992}')).not.toThrow();
  });

  it('leaves other arithmetic operands alone', () => {
    // Rewriting these would leave the parser doing arithmetic on a Long.
    expect(preserveBigIntegers('{a: 1 + 9007199254740992}')).toBe(
      '{a: 1 + 9007199254740992}'
    );
  });

  it('does not wrap a constructor argument in another constructor', () => {
    // `NumberLong(NumberLong("…"))` is not a thing. The quoted spelling is the
    // exact one, and it is untouched because it is inside a string.
    expect(preserveBigIntegers('{a: NumberLong(9007199254740993)}')).toBe(
      '{a: NumberLong(9007199254740993)}'
    );
    expect(parseShellJson('{a: NumberLong("9007199254740993")}').a.$numberLong).toBe(
      '9007199254740993'
    );
  });

  it('leaves a parenthesised expression alone', () => {
    expect(preserveBigIntegers('{a: (9007199254740993)}')).toBe(
      '{a: (9007199254740993)}'
    );
  });

  it('still treats a genuine leading minus as a sign', () => {
    // The distinction is whether anything that could end an operand precedes
    // the minus — here it is the `:`, so the minus belongs to the number.
    expect(preserveBigIntegers('{a: -9007199254740993}')).toBe(
      '{a: NumberLong("-9007199254740993")}'
    );
  });

  it('rewrites after the punctuation that starts a value', () => {
    expect(preserveBigIntegers('{a: [1, 9007199254740993]}')).toBe(
      '{a: [1, NumberLong("9007199254740993")]}'
    );
    expect(preserveBigIntegers('counter: 9007199254740993')).toBe(
      'counter: NumberLong("9007199254740993")'
    );
  });
});

// #318 review, round 2: a comment between the delimiter and the value left the
// literal unrewritten, so a commented query kept rounding silently.
describe('preserveBigIntegers — comments (#318 review)', () => {
  const longOf = (text: string, key = 'counter') => parseShellJson(text)[key].$numberLong;

  it('sees past a block comment before the value', () => {
    expect(longOf('{counter: /* copied from shell */ 9007199254740993}')).toBe(
      '9007199254740993'
    );
  });

  it('sees past a line comment before the value', () => {
    expect(longOf('{counter: // note\n 9007199254740993}')).toBe('9007199254740993');
  });

  it('still reads a sign correctly across a comment', () => {
    expect(parseShellJson('{a: /* c */ -9007199254740993}').a.$numberLong).toBe(
      '-9007199254740993'
    );
  });

  it('does not mistake a comment for an operand when judging a binary minus', () => {
    expect(preserveBigIntegers('{a: 1 /* c */ - 9007199254740992}')).toBe(
      '{a: 1 /* c */ - 9007199254740992}'
    );
  });

  it('does not mistake // inside a string for a comment', () => {
    // The reason placement is judged on tracked tokens rather than by scanning
    // the emitted text backwards: a URL would otherwise look like a comment and
    // suppress a rewrite that should happen.
    const parsed = parseShellJson('{url: "http://x.com", counter: 9007199254740993}');
    expect(parsed.url).toBe('http://x.com');
    expect(parsed.counter.$numberLong).toBe('9007199254740993');
  });

  it('still recognises a regex that follows a comment', () => {
    const parsed = parseShellJson('{a: /* c */ /x/i, b: 9007199254740993}');
    expect(parsed.a.$regularExpression.pattern).toBe('x');
    expect(parsed.b.$numberLong).toBe('9007199254740993');
  });
});

// #318 review, round 3: the key check only skipped whitespace, so a comment
// before the colon hid the fact that the digits were a property name.
describe('preserveBigIntegers — numeric keys with comments (#318 review)', () => {
  it('leaves a numeric key alone when a comment precedes its colon', () => {
    // Rewrote to `NumberLong("…"): 1`, which is not a property key, so a valid
    // query stopped parsing. The value-position guard hid this at the start of
    // an object; after a comma there is nothing else to catch it.
    const text = '{a: 1, 9007199254740992 /* note */: 1}';
    expect(preserveBigIntegers(text)).toBe(text);
    expect(parseShellJson(text)).toEqual({ a: 1, '9007199254740992': 1 });
  });

  it('does the same for a line comment before the colon', () => {
    const text = '{a: 1, 9007199254740992 // n\n: 1}';
    expect(preserveBigIntegers(text)).toBe(text);
    expect(parseShellJson(text)).toEqual({ a: 1, '9007199254740992': 1 });
  });

  it('still rewrites a value that follows a comma and a comment', () => {
    // The key fix must not swallow the value case that shares the position.
    expect(
      parseShellJson('{a: 1, counter: /* c */ 9007199254740993}').counter.$numberLong
    ).toBe('9007199254740993');
  });
});

// #318 review, round 4: the mirror of the binary-minus case. Checking only what
// PRECEDES a literal caught `{a: 1 + N}` but not `{a: N + 1}`.
describe('preserveBigIntegers — literal as a left-hand operand (#318 review)', () => {
  it('leaves a literal that an operator follows alone', () => {
    // Rewriting made this `NumberLong("…") + 1`, and JS concatenated the long's
    // toString — the query silently became the STRING "90071992547409931".
    expect(preserveBigIntegers('{limit: 9007199254740993 + 1}')).toBe(
      '{limit: 9007199254740993 + 1}'
    );
    expect(typeof parseShellJson('{limit: 9007199254740993 + 1}').limit).toBe('number');
  });

  it('does the same when a comment sits before the operator', () => {
    expect(preserveBigIntegers('{a: 9007199254740993 /* c */ + 1}')).toBe(
      '{a: 9007199254740993 /* c */ + 1}'
    );
  });

  it('still rewrites where a value legitimately ends', () => {
    // `}`, `]`, `,` and end-of-input all end a value; a trailing comment is
    // skipped to find them.
    expect(parseShellJson('{a: 9007199254740993}').a.$numberLong).toBe('9007199254740993');
    expect(parseShellJson('{a: [9007199254740993, 1]}').a[0].$numberLong).toBe(
      '9007199254740993'
    );
    expect(parseShellJson('{a: 9007199254740993, b: 1}').a.$numberLong).toBe(
      '9007199254740993'
    );
    expect(parseShellJson('counter: 9007199254740993').counter.$numberLong).toBe(
      '9007199254740993'
    );
    expect(parseShellJson('{a: 9007199254740993 /* trailing */}').a.$numberLong).toBe(
      '9007199254740993'
    );
  });
});

// #318 review, round 5. Two findings assumed these were supported shell syntax.
// They are not — the parser rejects both outright, with or without a big
// integer — so neither query can run and the rewrite cannot be observed.
//
// Pinned rather than guarded, the same way the `d`/`v` regex flags are: adding
// handling for syntax nothing accepts would be dead code that implies support
// we do not have. If a parser upgrade ever makes these reachable, these tests
// fail and the decision gets made deliberately instead of by accident.
describe('parseShellJson — syntax this parser does not accept (#318 review)', () => {
  it('rejects template literals, integer or not', () => {
    expect(() => parseShellJson('{note: `hello`}')).toThrow();
    expect(() => parseShellJson('{note: `[9007199254740993]`}')).toThrow();
  });

  it('rejects index expressions, integer or not', () => {
    expect(() => parseShellJson('{a: [1][0]}')).toThrow();
    expect(() => parseShellJson('{a: [9007199254740993][0] + 1}')).toThrow();
  });

  it('but does accept the arithmetic the operand rules are built around', () => {
    // The contrast that makes the two above worth pinning: arithmetic really is
    // supported, which is why the left/right operand cases were real bugs.
    expect(parseShellJson('{a: 1 + 2}')).toEqual({ a: 3 });
    expect(parseShellJson('{a: [1, 2]}')).toEqual({ a: [1, 2] });
  });
});
