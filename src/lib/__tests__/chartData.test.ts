import { describe, it, expect } from 'vitest';
import { Int32, Double, Long, Decimal128 } from 'bson';
import { toNumber, inferFields } from '../chartData';
import { aggregate, CATEGORY_CAP } from '../chartData';
import { rawSeries, buildChartData, POINT_CAP } from '../chartData';

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

describe('aggregate', () => {
  const docs = [
    { region: 'NA', spend: 100 },
    { region: 'NA', spend: 50 },
    { region: 'EU', spend: 200 },
    { region: 'EU', spend: undefined },
    { spend: 10 }, // missing region
  ];
  it('counts documents per group, sorted desc', () => {
    const { points, total } = aggregate(docs, 'region', 'count');
    expect(total).toBe(5);
    expect(points[0]).toEqual({ x: 'NA', y: 2 });
    expect(points.find((p) => p.x === '(missing)')).toEqual({ x: '(missing)', y: 1 });
  });
  it('sums a numeric field per group, ignoring non-numeric values', () => {
    const { points } = aggregate(docs, 'region', 'sum', 'spend');
    expect(points.find((p) => p.x === 'NA')!.y).toBe(150);
    expect(points.find((p) => p.x === 'EU')!.y).toBe(200); // undefined ignored
  });
  it('computes avg, min, max', () => {
    expect(aggregate(docs, 'region', 'avg', 'spend').points.find((p) => p.x === 'NA')!.y).toBe(75);
    expect(aggregate(docs, 'region', 'min', 'spend').points.find((p) => p.x === 'NA')!.y).toBe(50);
    expect(aggregate(docs, 'region', 'max', 'spend').points.find((p) => p.x === 'NA')!.y).toBe(100);
  });
  it('caps categories and reports the truncated count', () => {
    const many = Array.from({ length: CATEGORY_CAP + 5 }, (_, i) => ({ k: `g${i}` }));
    const { points, truncated } = aggregate(many, 'k', 'count');
    expect(points.length).toBe(CATEGORY_CAP);
    expect(truncated).toBe(5);
  });
});

describe('rawSeries', () => {
  const docs = [
    { seats: 3, spend: 100 },
    { seats: 4, spend: 'oops' }, // y NaN -> dropped
    { seats: 5, spend: 200 },
  ];
  it('maps numeric x/y and drops NaN-y rows', () => {
    const { points } = rawSeries(docs, 'seats', 'spend');
    expect(points).toEqual([{ x: 3, y: 100 }, { x: 5, y: 200 }]);
  });
  it('keeps categorical x as a label', () => {
    const { points } = rawSeries([{ region: 'NA', spend: 100 }], 'region', 'spend');
    expect(points[0]).toEqual({ x: 'NA', y: 100 });
  });
  it('caps points and reports truncation', () => {
    const many = Array.from({ length: POINT_CAP + 3 }, (_, i) => ({ x: i, y: i }));
    const { points, truncated } = rawSeries(many, 'x', 'y');
    expect(points.length).toBe(POINT_CAP);
    expect(truncated).toBe(3);
  });
});

describe('buildChartData', () => {
  const docs = [{ region: 'NA', spend: 10 }, { region: 'NA', spend: 20 }];
  it('dispatches to aggregate', () => {
    const d = buildChartData(docs, { mode: 'aggregate', xField: 'region', measure: 'count' });
    expect(d.points[0]).toEqual({ x: 'NA', y: 2 });
  });
  it('dispatches to raw and returns empty when no y field', () => {
    expect(buildChartData(docs, { mode: 'raw', xField: 'region', measure: 'count' }).points).toEqual([]);
    const d = buildChartData(docs, { mode: 'raw', xField: 'spend', measure: 'count', rawYField: 'spend' });
    expect(d.points.length).toBe(2);
  });
});
