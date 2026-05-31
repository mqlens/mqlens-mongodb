import { describe, it, expect } from 'vitest';
import { toJson, toCsv, parseJson, parseCsv } from '../dataTransfer';

describe('toJson', () => {
  it('pretty-prints an array of documents', () => {
    const out = toJson([{ a: 1 }, { b: 2 }]);
    expect(out).toBe('[\n  {\n    "a": 1\n  },\n  {\n    "b": 2\n  }\n]');
  });
});

describe('toCsv', () => {
  it('uses the union of top-level keys in first-seen order', () => {
    const out = toCsv([{ a: 1, b: 2 }, { a: 3, c: 4 }]);
    expect(out.split('\n')[0]).toBe('a,b,c');
  });

  it('serializes nested objects/arrays as JSON strings and quotes them', () => {
    const out = toCsv([{ _id: 1, addr: { city: 'NY' } }]);
    const lines = out.split('\n');
    expect(lines[0]).toBe('_id,addr');
    // The nested object becomes a JSON string; embedded quotes are doubled.
    expect(lines[1]).toBe('1,"{""city"":""NY""}"');
  });

  it('quotes values containing commas, quotes, or newlines', () => {
    const out = toCsv([{ a: 'x,y', b: 'he said "hi"', c: 'line1\nline2' }]);
    const line = out.split('\n').slice(1).join('\n');
    expect(line).toBe('"x,y","he said ""hi""","line1\nline2"');
  });

  it('renders null/missing as empty cells', () => {
    const out = toCsv([{ a: 1, b: null }, { a: 2 }]);
    expect(out).toBe('a,b\n1,\n2,');
  });
});

describe('parseJson', () => {
  it('parses a JSON array of documents', () => {
    expect(parseJson('[{"a":1},{"b":2}]')).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('throws on a non-array', () => {
    expect(() => parseJson('{"a":1}')).toThrow(/array/i);
  });

  it('throws on invalid JSON', () => {
    expect(() => parseJson('{bad')).toThrow();
  });
});

describe('parseCsv', () => {
  it('maps the header row to fields and coerces cell types', () => {
    const rows = parseCsv('a,b,c\n1,true,hi');
    expect(rows).toEqual([{ a: 1, b: true, c: 'hi' }]);
  });

  it('parses JSON-object cells back into objects', () => {
    const rows = parseCsv('_id,addr\n1,"{""city"":""NY""}"');
    expect(rows).toEqual([{ _id: 1, addr: { city: 'NY' } }]);
  });

  it('throws when a row has the wrong column count', () => {
    expect(() => parseCsv('a,b\n1,2,3')).toThrow(/column/i);
  });

  it('round-trips flat docs through toCsv', () => {
    const docs = [{ a: 1, b: 'x,y' }, { a: 2, b: 'z' }];
    expect(parseCsv(toCsv(docs))).toEqual(docs);
  });

  it('parses quoted cells containing newlines', () => {
    const docs = [{ a: 'line1\nline2', b: 'ok' }];
    expect(parseCsv(toCsv(docs))).toEqual(docs);
  });
});
