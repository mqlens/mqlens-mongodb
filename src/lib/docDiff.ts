import { ObjectId, Long, Decimal128, Int32, Double, Binary, Timestamp } from 'bson';

// A value is a "container" (recurse into it) only when it is a plain object or
// array. BSON wrappers (ObjectId, Date, Long, …) are leaf scalars: we diff them
// by value, never by walking their internal fields.
export type ValueKind = 'object' | 'array' | 'scalar';

export function isBsonScalar(val: unknown): boolean {
  return (
    val instanceof ObjectId ||
    val instanceof Date ||
    val instanceof Long ||
    val instanceof Decimal128 ||
    val instanceof Int32 ||
    val instanceof Double ||
    val instanceof Binary ||
    val instanceof Timestamp
  );
}

export function valueKind(val: unknown): ValueKind {
  if (Array.isArray(val)) return 'array';
  if (val !== null && typeof val === 'object' && !isBsonScalar(val)) return 'object';
  return 'scalar';
}

// Unwrap a BSON numeric wrapper (or plain number) to a JS number, else NaN.
function asNumber(val: unknown): number {
  if (typeof val === 'number') return val;
  if (val instanceof Int32 || val instanceof Double) return val.valueOf();
  if (val instanceof Long) return val.toNumber();
  if (val instanceof Decimal128) return Number(val.toString());
  return NaN;
}

// Deep value equality for scalars and BSON wrappers. Containers are compared
// recursively by the caller (diffDocuments), so this only needs to handle leaves.
export function bsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;

  // Numeric equivalence across plain numbers and BSON numeric wrappers.
  const an = asNumber(a);
  const bn = asNumber(b);
  if (!Number.isNaN(an) && !Number.isNaN(bn)) return an === bn;

  if (a instanceof ObjectId && b instanceof ObjectId) return a.equals(b);
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof Decimal128 && b instanceof Decimal128) return a.toString() === b.toString();
  if (a instanceof Binary && b instanceof Binary) {
    return a.sub_type === b.sub_type && a.toString('base64') === b.toString('base64');
  }
  if (a instanceof Timestamp && b instanceof Timestamp) return a.toString() === b.toString();

  // Anything else (mismatched kinds, distinct primitives) is unequal.
  return false;
}

export type DiffStatus = 'unchanged' | 'changed' | 'added' | 'removed' | 'gap';

// One rendered line in a column. `gap` lines carry no value — they are blank
// filler that keeps the left/right columns vertically aligned.
export interface DiffLine {
  path: string;          // dotted/bracketed path, e.g. "address.city" or "tags[0]"
  keyLabel: string;      // the key or index shown at this depth (e.g. "city" or "0")
  depth: number;         // indentation level
  status: DiffStatus;
  kind: ValueKind | 'gap';
  value?: unknown;       // scalar value (when kind === 'scalar')
  bracket?: string;      // '{' '[' '}' ']' for container open/close lines
  childCount?: number;   // for container open lines
}

export interface DocDiff {
  left: DiffLine[];
  right: DiffLine[];
  addedCount: number;
  removedCount: number;
  changedCount: number;
}

const gap = (depth: number): DiffLine => ({ path: '', keyLabel: '', depth, status: 'gap', kind: 'gap' });

function joinPath(parent: string, key: string, isIndex: boolean): string {
  if (!parent) return isIndex ? `[${key}]` : key;
  return isIndex ? `${parent}[${key}]` : `${parent}.${key}`;
}

interface Counts { added: number; removed: number; changed: number; }

// Walk both objects in parallel for a single (object) level, emitting aligned
// left/right scalar lines. Nested containers are handled in Task 3.
export function diffDocuments(leftDoc: unknown, rightDoc: unknown): DocDiff {
  const left: DiffLine[] = [];
  const right: DiffLine[] = [];
  const counts = { added: 0, removed: 0, changed: 0 };

  walkLevel(leftDoc, rightDoc, '', 0, left, right, counts);

  return {
    left,
    right,
    addedCount: counts.added,
    removedCount: counts.removed,
    changedCount: counts.changed,
  };
}

function walkLevel(
  lv: unknown,
  rv: unknown,
  parentPath: string,
  depth: number,
  left: DiffLine[],
  right: DiffLine[],
  counts: Counts,
): void {
  const lKind = valueKind(lv);
  const rKind = valueKind(rv);

  // For Task 2 both sides are plain objects; the union of keys preserves left
  // order first, then right-only keys, so columns read naturally.
  const lObj = (lKind === 'object' ? (lv as Record<string, unknown>) : {});
  const rObj = (rKind === 'object' ? (rv as Record<string, unknown>) : {});
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const k of Object.keys(lObj)) { keys.push(k); seen.add(k); }
  for (const k of Object.keys(rObj)) { if (!seen.has(k)) keys.push(k); }

  for (const key of keys) {
    const inL = Object.prototype.hasOwnProperty.call(lObj, key);
    const inR = Object.prototype.hasOwnProperty.call(rObj, key);
    const path = joinPath(parentPath, key, false);
    const a = lObj[key];
    const b = rObj[key];

    if (inL && !inR) {
      counts.removed++;
      left.push({ path, keyLabel: key, depth, status: 'removed', kind: 'scalar', value: a });
      right.push(gap(depth));
      continue;
    }
    if (!inL && inR) {
      counts.added++;
      left.push(gap(depth));
      right.push({ path, keyLabel: key, depth, status: 'added', kind: 'scalar', value: b });
      continue;
    }

    // Present on both sides (Task 2: scalars only).
    const equal = bsonEqual(a, b);
    if (!equal) counts.changed++;
    const status: DiffStatus = equal ? 'unchanged' : 'changed';
    left.push({ path, keyLabel: key, depth, status, kind: 'scalar', value: a });
    right.push({ path, keyLabel: key, depth, status, kind: 'scalar', value: b });
  }
}
