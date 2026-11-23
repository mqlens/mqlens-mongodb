import { describe, it, expect } from 'vitest';
import { undoBaseline, undoCondition } from '../undoEdit';

describe('undoBaseline', () => {
  it('gives a removed sub-document back as an empty parent, so undo adds its fields one by one', () => {
    const before = { _id: 1, name: 'A', address: { city: 'X', geo: { lat: 1 } } };
    const saved = { _id: 1, name: 'A' };
    expect(undoBaseline(saved, before)).toEqual({ _id: 1, name: 'A', address: { geo: {} } });
  });

  it('fills parents inside a sub-document the save kept', () => {
    const before = { _id: 1, address: { city: 'X', geo: { lat: 1 } } };
    const saved = { _id: 1, address: { city: 'X' } };
    expect(undoBaseline(saved, before)).toEqual({ _id: 1, address: { city: 'X', geo: {} } });
  });

  it('leaves typed values and empty documents alone: they are values, not parents', () => {
    const before = { _id: 1, at: { $date: '2024-01-01T00:00:00Z' }, empty: {}, tags: [{ a: 1 }] };
    const saved = { _id: 1 };
    expect(undoBaseline(saved, before)).toEqual({ _id: 1 });
  });

  it('changes nothing when the save removed no sub-document', () => {
    const before = { _id: 1, name: 'A', address: { city: 'X' } };
    const saved = { _id: 1, name: 'B', address: { city: 'Y' }, vip: true };
    expect(undoBaseline(saved, before)).toEqual(saved);
  });
});

describe('undoBaseline — emptied sub-documents', () => {
  it('fills parents inside a sub-document the save emptied but kept', () => {
    const before = { _id: 1, address: { geo: { lat: 1 } } };
    const saved = { _id: 1, address: {} };
    expect(undoBaseline(saved, before)).toEqual({ _id: 1, address: { geo: {} } });
  });
});

// Exact matches: a value is not an array holding it, null is not missing,
// and an array is not one nested in another.
const is = (value: unknown) => ({ $eq: value, $not: { $type: 'array' } });
const isNull = { $type: 'null', $not: { $type: 'array' } };
const gone = { $exists: false };
// A parent the filter reaches into by path is still a sub-document, not an
// array (whose elements a numeric path would reach), or for a removed one,
// missing or a sub-document.
const subDoc = { $type: 'object', $not: { $type: 'array' } };
const notArray = { $not: { $type: 'array' } };

describe('undoCondition', () => {
  it('requires each value the save wrote to still be there exactly, field by field', () => {
    const before = { _id: 1, name: 'A', email: 'a@x', tier: 'Gold' };
    const saved = { _id: 1, name: 'A', email: 'b@x', vip: true };
    expect(undoCondition(saved, before)).toEqual({ email: is('b@x'), vip: is(true), tier: gone });
  });

  it('reaches into sub-documents by path, so fields a projection hid are not compared', () => {
    const before = { _id: 1, address: { city: 'X', zip: '1' } };
    const saved = { _id: 1, address: { city: 'Y' } };
    expect(undoCondition(saved, before)).toEqual({ address: subDoc, 'address.city': is('Y'), 'address.zip': gone });
  });

  it('requires a parent reached by path to still be a sub-document, not an array put there since', () => {
    const before = { _id: 1, profile: { '0': 'A' } };
    const saved = { _id: 1, profile: { '0': 'B' } };
    expect(undoCondition(saved, before)).toEqual({ profile: subDoc, 'profile.0': is('B') });
  });

  it('compares typed values whole, and arrays whole and by length', () => {
    const before = { _id: 1, at: { $date: '2024-01-01T00:00:00Z' }, tags: ['a'] };
    const saved = { _id: 1, at: { $date: '2025-01-01T00:00:00Z' }, tags: ['a', 'b'] };
    expect(undoCondition(saved, before)).toEqual({
      at: is({ $date: '2025-01-01T00:00:00Z' }),
      tags: { $eq: ['a', 'b'], $size: 2 },
    });
  });

  it('requires a saved null to be there, not missing', () => {
    expect(undoCondition({ _id: 1, x: null }, { _id: 1, x: 1 })).toEqual({ x: isNull });
  });
});

describe('undoCondition — what a filter cannot guard', () => {
  it('gives null for a changed name a filter cannot address', () => {
    expect(undoCondition({ _id: 1, 'a.b': 2 }, { _id: 1, 'a.b': 1 })).toBeNull();
    expect(undoCondition({ _id: 1, $weird: 2 }, { _id: 1, $weird: 1 })).toBeNull();
  });

  it('gives null for a saved value holding a $ name, which a filter would read as an operator', () => {
    expect(undoCondition({ _id: 1, meta: { $custom: 1 } }, { _id: 1 })).toBeNull();
    expect(undoCondition({ _id: 1, list: [{ $custom: 1 }] }, { _id: 1 })).toBeNull();
  });

  it('ignores such names where nothing changed', () => {
    expect(undoCondition({ _id: 1, 'a.b': 1, x: 2 }, { _id: 1, 'a.b': 1, x: 1 })).toEqual({ x: is(2) });
  });
});

describe('undoCondition — removed sub-documents', () => {
  it('checks each field of a removed sub-document, as fields a projection hid may remain', () => {
    const before = { _id: 1, address: { city: 'X', geo: { lat: 1 } } };
    const saved = { _id: 1 };
    expect(undoCondition(saved, before)).toEqual({ address: notArray, 'address.city': gone, 'address.geo': notArray, 'address.geo.lat': gone });
  });
});

// Field names that are also Object.prototype members are fields like any
// other. The documents come from JSON.parse, which makes them own properties.
describe('field names shared with Object.prototype', () => {
  it('guards the removal of a field named like an inherited member', () => {
    const before = JSON.parse('{"_id":1,"constructor":"A","toString":"B"}');
    const saved = { _id: 1 };
    expect(undoCondition(saved, before)).toEqual({ constructor: gone, toString: gone });
  });

  it('keeps the guard on a changed __proto__ field, as an own field of the filter', () => {
    const before = JSON.parse('{"_id":1,"__proto__":"A"}');
    const saved = JSON.parse('{"_id":1,"__proto__":"B"}');
    expect(JSON.stringify(undoCondition(saved, before))).toBe('{"__proto__":{"$eq":"B","$not":{"$type":"array"}}}');
  });

  it('gives a removed __proto__ or constructor sub-document back as an empty parent', () => {
    const before = JSON.parse('{"_id":1,"__proto__":{"a":1},"constructor":{"b":1}}');
    const saved = { _id: 1 };
    expect(JSON.stringify(undoBaseline(saved, before))).toBe('{"_id":1,"__proto__":{},"constructor":{}}');
  });
});
