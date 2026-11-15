import { describe, it, expect } from 'vitest';
import { Decimal128, Long, ObjectId } from 'bson';
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
