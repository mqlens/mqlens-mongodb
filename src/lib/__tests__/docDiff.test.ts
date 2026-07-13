import { describe, it, expect } from 'vitest';
import { ObjectId, Int32, Double, Long, Decimal128 } from 'bson';
import { bsonEqual, valueKind } from '../docDiff';

describe('valueKind', () => {
  it('classifies containers vs scalars', () => {
    expect(valueKind({ a: 1 })).toBe('object');
    expect(valueKind([1, 2])).toBe('array');
    expect(valueKind('s')).toBe('scalar');
    expect(valueKind(3)).toBe('scalar');
    expect(valueKind(null)).toBe('scalar');
    // BSON wrappers are leaf scalars, not objects to recurse into.
    expect(valueKind(new ObjectId('507f1f77bcf86cd799439011'))).toBe('scalar');
    expect(valueKind(new Date('2025-01-01'))).toBe('scalar');
  });
});

describe('bsonEqual', () => {
  it('treats equal primitives as equal', () => {
    expect(bsonEqual(1, 1)).toBe(true);
    expect(bsonEqual('a', 'a')).toBe(true);
    expect(bsonEqual(null, null)).toBe(true);
    expect(bsonEqual(1, 2)).toBe(false);
    expect(bsonEqual('a', 'b')).toBe(false);
  });
  it('compares BSON wrappers by value', () => {
    expect(bsonEqual(new ObjectId('507f1f77bcf86cd799439011'), new ObjectId('507f1f77bcf86cd799439011'))).toBe(true);
    expect(bsonEqual(new ObjectId('507f1f77bcf86cd799439011'), new ObjectId('507f1f77bcf86cd799439012'))).toBe(false);
    expect(bsonEqual(new Date('2025-01-01'), new Date('2025-01-01'))).toBe(true);
    expect(bsonEqual(new Int32(7), new Int32(7))).toBe(true);
    expect(bsonEqual(new Double(2.5), new Double(2.5))).toBe(true);
    expect(bsonEqual(new Long(42), new Long(42))).toBe(true);
    expect(bsonEqual(Decimal128.fromString('3.14'), Decimal128.fromString('3.14'))).toBe(true);
  });
  it('numeric BSON wrappers equal their plain-number counterpart', () => {
    expect(bsonEqual(new Int32(7), 7)).toBe(true);
    expect(bsonEqual(new Double(2.5), 2.5)).toBe(true);
  });
  it('different kinds are not equal', () => {
    expect(bsonEqual(1, '1')).toBe(false);
    expect(bsonEqual(new ObjectId('507f1f77bcf86cd799439011'), '507f1f77bcf86cd799439011')).toBe(false);
  });
});
