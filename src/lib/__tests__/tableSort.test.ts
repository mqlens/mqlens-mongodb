import { describe, it, expect } from 'vitest';
import { Binary, BSONRegExp, Decimal128, Double as BsonDouble, Long, MaxKey, MinKey, ObjectId, Timestamp } from 'bson';
const Double = (n: number) => new BsonDouble(n);
import { compareBsonValues } from '../tableSort';

// Boxed, because Array.prototype.sort moves bare `undefined` to the end without
// asking the comparator; the grid sorts row indices, so it never sees that.
const sorted = (values: unknown[]) =>
  values.map((v) => ({ v })).sort((a, b) => compareBsonValues(a.v, b.v)).map((o) => o.v);

describe('compareBsonValues', () => {
  it('orders numbers by value, whatever BSON number type holds them', () => {
    expect(sorted([10, Decimal128.fromString('2.5'), Long.fromNumber(3), 1])).toEqual([
      1,
      Decimal128.fromString('2.5'),
      Long.fromNumber(3),
      10,
    ]);
  });

  it('puts missing and null first, as MongoDB does', () => {
    expect(sorted(['b', undefined, 2, null])).toEqual([undefined, null, 2, 'b']);
  });

  it('follows the BSON type order across types', () => {
    const id = new ObjectId('64b000000000000000000001');
    const date = new Date('2024-01-01T00:00:00Z');
    expect(sorted([date, true, id, [1], { a: 1 }, 'x', 5])).toEqual([5, 'x', { a: 1 }, [1], id, true, date]);
  });

  it('orders dates by time and ObjectIds by their hex', () => {
    const early = new Date('2020-01-01T00:00:00Z');
    const late = new Date('2024-01-01T00:00:00Z');
    expect(sorted([late, early])).toEqual([early, late]);
    const a = new ObjectId('64b000000000000000000001');
    const b = new ObjectId('64b000000000000000000002');
    expect(sorted([b, a])).toEqual([a, b]);
  });
});

describe('compareBsonValues — review fixes', () => {
  it('does not trust a stored _bsontype field', () => {
    const spoof = { _bsontype: 'ObjectId', value: 1 };
    expect(() => sorted([spoof, { _bsontype: 'ObjectId', value: 2 }])).not.toThrow();
    // A plain document, so it ranks with documents, before a real ObjectId.
    const id = new ObjectId('64b000000000000000000001');
    expect(sorted([id, spoof])).toEqual([spoof, id]);
  });

  it('puts NaN before every other number and keeps the rest in order', () => {
    expect(sorted([3, Double(NaN), 1, 2])).toEqual([Double(NaN), 1, 2, 3]);
    expect(sorted([3, NaN, 1, 2])).toEqual([NaN, 1, 2, 3]);
  });

  it('compares documents and arrays by value, not by their JSON text', () => {
    expect(sorted([{ n: 10 }, { n: 2 }])).toEqual([{ n: 2 }, { n: 10 }]);
    expect(sorted([[10], [2]])).toEqual([[2], [10]]);
    expect(sorted([[1, 2], [1]])).toEqual([[1], [1, 2]]);
    expect(sorted([{ b: 1 }, { a: 5 }])).toEqual([{ a: 5 }, { b: 1 }]);
  });
});

describe('compareBsonValues — timestamps', () => {
  it('orders timestamps by time, then increment, after dates', () => {
    const a = new Timestamp({ t: 1, i: 1 });
    const b = new Timestamp({ t: 1, i: 2 });
    const c = new Timestamp({ t: 2, i: 1 });
    const date = new Date('2024-01-01T00:00:00Z');
    expect(sorted([c, b, date, a])).toEqual([date, a, b, c]);
  });
});

describe('compareBsonValues — binary', () => {
  it('orders binary by length, then subtype, then bytes, as MongoDB does', () => {
    const ff = new Binary(Uint8Array.from([0xff]));
    const fe = new Binary(Uint8Array.from([0xfe]));
    const feSub4 = new Binary(Uint8Array.from([0xfe]), 4);
    const short = new Binary(new Uint8Array(0));
    const long = new Binary(Uint8Array.from([0x00, 0x00]));
    expect(sorted([long, feSub4, ff, fe, short])).toEqual([short, fe, ff, feSub4, long]);
  });
});

describe('compareBsonValues — decimal precision', () => {
  it('orders Decimal128 values a double cannot tell apart', () => {
    const one = Decimal128.fromString('1.0000000000000000');
    const more = Decimal128.fromString('1.0000000000000001');
    const big = Decimal128.fromString('1E+6000');
    const bigger = Decimal128.fromString('2E+6000');
    expect(sorted([bigger, more, big, one])).toEqual([one, more, big, bigger]);
    expect(compareBsonValues(Decimal128.fromString('-0.00012'), Decimal128.fromString('-0.00011'))).toBeLessThan(0);
  });
});

describe('compareBsonValues — MinKey and MaxKey', () => {
  it('puts MinKey before null and MaxKey after everything, regexes just before it', () => {
    const min = new MinKey();
    const max = new MaxKey();
    const re = new BSONRegExp('a', 'i');
    const date = new Date('2024-01-01T00:00:00Z');
    expect(sorted([max, 1, re, null, date, min])).toEqual([min, null, 1, date, re, max]);
  });
});

describe('compareBsonValues — doubles against decimals', () => {
  it('orders a double against a Decimal128 by the exact value of the double, not its text', () => {
    // The double 0.1 is 0.1000000000000000055511151231257827…
    const d = Decimal128.fromString('0.100000000000000001');
    expect(sorted([0.1, d])).toEqual([d, 0.1]);
    expect(compareBsonValues(0.1, Decimal128.fromString('0.1000000000000000055511151231257828'))).toBeLessThan(0);
    expect(compareBsonValues(Decimal128.fromString('0.5'), 0.5)).toBe(0);
  });
});

describe('compareBsonValues — MongoDB string and document rules', () => {
  it('orders strings by their bytes, not by the locale', () => {
    expect(sorted(['a', 'B', 'é', 'e'])).toEqual(['B', 'a', 'e', 'é']);
    // A character past U+FFFF is two UTF-16 units but still sorts last by code point.
    expect(sorted(['😀', '～'])).toEqual(['～', '😀']);
  });

  it('compares a field by the type of its value before its name', () => {
    expect(sorted([{ a: 'text' }, { z: 1 }])).toEqual([{ z: 1 }, { a: 'text' }]);
    expect(sorted([{ b: 1 }, { a: 2 }])).toEqual([{ a: 2 }, { b: 1 }]);
  });
});

describe('compareBsonValues — regular expressions', () => {
  it('orders regexes by pattern, then by options', () => {
    const z = new BSONRegExp('z', '');
    const ai = new BSONRegExp('a', 'i');
    const a = new BSONRegExp('a', '');
    expect(sorted([z, ai, a])).toEqual([a, ai, z]);
    expect(sorted([/z/, /a/i, /a/])).toEqual([/a/, /a/i, /z/]);
  });
});
