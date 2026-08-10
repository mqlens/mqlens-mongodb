import { describe, it, expect } from 'vitest';
import { ObjectId, Long, Decimal128, Int32 } from 'bson';
import { docToShell, shellToEjson, parseShellJson, parseQueryObject } from '../shellDoc';

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
    expect(out).toContain('"_id": ObjectId("507f1f77bcf86cd799439011")');
    expect(out).toContain('"createdAt": ISODate("2025-01-04T00:00:00.000Z")');
    expect(out).toContain('"big": NumberLong("9007199254740993")');
    expect(out).toContain('"price": NumberDecimal("12.50")');
    expect(out).toContain('"n": NumberInt(7)');
    expect(out).toContain('"name": "Acme"');
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
