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
