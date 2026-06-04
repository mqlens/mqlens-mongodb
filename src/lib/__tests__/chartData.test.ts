import { describe, it, expect } from 'vitest';
import { Int32, Double, Long, Decimal128 } from 'bson';
import { toNumber, inferFields } from '../chartData';

describe('toNumber', () => {
  it('unwraps plain numbers and BSON numeric types', () => {
    expect(toNumber(5)).toBe(5);
    expect(toNumber(new Int32(7))).toBe(7);
    expect(toNumber(new Double(2.5))).toBe(2.5);
    expect(toNumber(new Long(42))).toBe(42);
    expect(toNumber(Decimal128.fromString('3.14'))).toBeCloseTo(3.14);
  });
  it('returns NaN for non-numeric values', () => {
    expect(Number.isNaN(toNumber('abc'))).toBe(true);
    expect(Number.isNaN(toNumber(null))).toBe(true);
    expect(Number.isNaN(toNumber({}))).toBe(true);
  });
});

describe('inferFields', () => {
  const docs = [
    { region: 'NA', seats: new Int32(3), createdAt: new Date('2025-01-01'), name: 'Acme' },
    { region: 'EU', seats: new Int32(4), createdAt: new Date('2025-02-01'), name: 'Beta' },
  ];
  it('classifies numeric, date, and categorical fields', () => {
    const fields = inferFields(docs, ['region', 'seats', 'createdAt', 'name']);
    const kind = (n: string) => fields.find((f) => f.name === n)!.kind;
    expect(kind('seats')).toBe('numeric');
    expect(kind('createdAt')).toBe('date');
    expect(kind('region')).toBe('categorical');
    expect(kind('name')).toBe('categorical');
  });
  it('treats an all-missing field as categorical', () => {
    const fields = inferFields([{ a: 1 }, { a: 2 }], ['a', 'ghost']);
    expect(fields.find((f) => f.name === 'ghost')!.kind).toBe('categorical');
  });
});
