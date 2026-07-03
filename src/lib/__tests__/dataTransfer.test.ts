import { describe, it, expect } from 'vitest';
import { toJson, toCsv, toNdjson } from '../dataTransfer';

describe('toJson', () => {
  it('pretty-prints an array of documents', () => {
    const out = toJson([{ a: 1 }, { b: 2 }]);
    expect(out).toBe('[\n  {\n    "a": 1\n  },\n  {\n    "b": 2\n  }\n]');
  });
});

describe('toNdjson', () => {
  it('writes one compact JSON document per line, no array brackets', () => {
    const out = toNdjson([{ a: 1 }, { b: 2 }]);
    expect(out).toBe('{"a":1}\n{"b":2}');
  });

  it('preserves Extended JSON wrappers verbatim (relaxed EJSON round-trips)', () => {
    const out = toNdjson([{ _id: { $oid: 'abc' } }]);
    expect(out).toBe('{"_id":{"$oid":"abc"}}');
  });

  it('returns an empty string for no documents', () => {
    expect(toNdjson([])).toBe('');
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
