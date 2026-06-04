import { describe, it, expect } from 'vitest';
import { ObjectId } from 'bson';
import { relaxEjson, formatDocForEditor } from '../ejsonView';

describe('relaxEjson', () => {
  it('relaxes a canonical $date to an ISO string', () => {
    expect(relaxEjson({ $date: { $numberLong: '1749427200000' } })).toEqual({ $date: '2025-06-09T00:00:00.000Z' });
  });
  it('relaxes $numberLong / $numberInt to numbers', () => {
    expect(relaxEjson({ $numberLong: '2275' })).toBe(2275);
    expect(relaxEjson({ $numberInt: '8' })).toBe(8);
  });
  it('keeps $oid and $numberDecimal as-is', () => {
    expect(relaxEjson({ $oid: 'abc' })).toEqual({ $oid: 'abc' });
    expect(relaxEjson({ $numberDecimal: '1.50' })).toEqual({ $numberDecimal: '1.50' });
  });
  it('recurses into arrays and nested objects', () => {
    expect(relaxEjson({ a: [{ $numberInt: '1' }], b: { c: { $date: { $numberLong: '0' } } } })).toEqual({
      a: [1],
      b: { c: { $date: '1970-01-01T00:00:00.000Z' } },
    });
  });
});

describe('formatDocForEditor', () => {
  it('produces clean relaxed Extended JSON', () => {
    const out = formatDocForEditor({
      seats: { $numberInt: '8' },
      createdAt: { $date: { $numberLong: '1749427200000' } },
      _id: { $oid: '507f1f77bcf86cd799439011' },
    });
    expect(out).toContain('"seats": 8');
    expect(out).toContain('"$date": "2025-06-09T00:00:00.000Z"');
    expect(out).toContain('"$oid": "507f1f77bcf86cd799439011"');
    expect(out).not.toContain('$numberLong');
  });

  it('does NOT throw on documents with $-prefixed user keys', () => {
    // A field whose value literally contains an operator-like key would make
    // EJSON.parse throw; relaxEjson must handle it gracefully.
    const out = formatDocForEditor({ filterSnapshot: { $gt: 5 }, name: 'x' });
    expect(out).toContain('"$gt": 5');
    expect(out).toContain('"name": "x"');
  });

  it('handles BSON instances', () => {
    const out = formatDocForEditor({ _id: new ObjectId('507f1f77bcf86cd799439011') });
    expect(out).toContain('"$oid": "507f1f77bcf86cd799439011"');
  });
});
