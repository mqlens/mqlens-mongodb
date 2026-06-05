import { describe, it, expect } from 'vitest';
import { ObjectId, Long, Decimal128, Int32 } from 'bson';
import { docToShell, shellToEjson } from '../shellDoc';

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
