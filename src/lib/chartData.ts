import { Int32, Double, Long, Decimal128 } from 'bson';

export type FieldKind = 'numeric' | 'date' | 'categorical';
export type ChartMode = 'aggregate' | 'raw';
export type Measure = 'count' | 'sum' | 'avg' | 'min' | 'max';
export type ChartType = 'bar' | 'line' | 'area' | 'pie' | 'scatter';

export interface FieldInfo { name: string; kind: FieldKind; }
export interface ChartPoint { x: string | number; y: number; }
export interface ChartData { points: ChartPoint[]; truncated: number; total: number; }
export interface ChartConfig {
  mode: ChartMode;
  xField: string;
  measure: Measure;
  measureField?: string;
  rawYField?: string;
}

const SAMPLE = 200;
export const CATEGORY_CAP = 30;
export const POINT_CAP = 2000;

export function toNumber(v: any): number {
  if (v == null) return NaN;
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Int32 || v instanceof Double) return v.valueOf();
  if (v instanceof Long) return v.toNumber();
  if (v instanceof Decimal128) return Number(v.toString());
  return NaN;
}

function isDateValue(v: any): boolean {
  return v instanceof Date || (v != null && typeof v === 'object' && typeof (v as any).getTime === 'function');
}

export function inferFields(docs: Array<Record<string, any>>, columns: string[]): FieldInfo[] {
  return columns.map((name) => {
    let numeric = 0, date = 0, other = 0, seen = 0;
    for (let i = 0; i < docs.length && seen < SAMPLE; i++) {
      const v = docs[i]?.[name];
      if (v == null) continue;
      seen++;
      if (!Number.isNaN(toNumber(v))) numeric++;
      else if (isDateValue(v)) date++;
      else other++;
    }
    let kind: FieldKind = 'categorical';
    if (seen > 0) {
      if (numeric > 0 && numeric >= date && numeric >= other) kind = 'numeric';
      else if (date > 0 && date >= other) kind = 'date';
    }
    return { name, kind };
  });
}

export function labelOf(v: any): string {
  if (v == null) return '(missing)';
  if (isDateValue(v)) return new Date(v as any).toISOString().slice(0, 10);
  return String(v);
}

export function aggregate(
  docs: Array<Record<string, any>>,
  xField: string,
  measure: Measure,
  measureField?: string,
  cap = CATEGORY_CAP,
): ChartData {
  const size = new Map<string, number>();
  const vals = new Map<string, number[]>();
  for (const doc of docs) {
    const key = labelOf(doc?.[xField]);
    size.set(key, (size.get(key) ?? 0) + 1);
    if (measure !== 'count' && measureField) {
      const n = toNumber(doc?.[measureField]);
      if (!Number.isNaN(n)) {
        const arr = vals.get(key);
        if (arr) arr.push(n); else vals.set(key, [n]);
      }
    }
  }
  let points: ChartPoint[] = [];
  for (const key of size.keys()) {
    let y = 0;
    if (measure === 'count') {
      y = size.get(key)!;
    } else {
      const arr = vals.get(key) ?? [];
      if (arr.length > 0) {
        if (measure === 'sum') y = arr.reduce((a, b) => a + b, 0);
        else if (measure === 'avg') y = arr.reduce((a, b) => a + b, 0) / arr.length;
        else if (measure === 'min') y = Math.min(...arr);
        else if (measure === 'max') y = Math.max(...arr);
      }
    }
    points.push({ x: key, y });
  }
  points.sort((a, b) => b.y - a.y);
  const truncated = Math.max(0, points.length - cap);
  if (truncated > 0) points = points.slice(0, cap);
  return { points, truncated, total: docs.length };
}

export function rawSeries(
  docs: Array<Record<string, any>>,
  xField: string,
  yField: string,
  cap = POINT_CAP,
): ChartData {
  let points: ChartPoint[] = [];
  for (const doc of docs) {
    const y = toNumber(doc?.[yField]);
    if (Number.isNaN(y)) continue;
    const xv = doc?.[xField];
    const xn = toNumber(xv);
    points.push({ x: Number.isNaN(xn) ? labelOf(xv) : xn, y });
  }
  const truncated = Math.max(0, points.length - cap);
  if (truncated > 0) points = points.slice(0, cap);
  return { points, truncated, total: docs.length };
}

export function buildChartData(docs: Array<Record<string, any>>, config: ChartConfig): ChartData {
  if (config.mode === 'raw') {
    if (!config.rawYField) return { points: [], truncated: 0, total: docs.length };
    return rawSeries(docs, config.xField, config.rawYField);
  }
  return aggregate(docs, config.xField, config.measure, config.measureField);
}
