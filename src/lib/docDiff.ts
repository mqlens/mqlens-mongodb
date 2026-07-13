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
  const lArr = Array.isArray(lv);
  const rArr = Array.isArray(rv);
  const isIndex = lArr || rArr;

  // Build the aligned key list for this level.
  let keys: string[];
  if (isIndex) {
    const len = Math.max(lArr ? (lv as unknown[]).length : 0, rArr ? (rv as unknown[]).length : 0);
    keys = Array.from({ length: len }, (_, i) => String(i));
  } else {
    const lObj = (valueKind(lv) === 'object' ? (lv as Record<string, unknown>) : {});
    const rObj = (valueKind(rv) === 'object' ? (rv as Record<string, unknown>) : {});
    keys = [];
    const seen = new Set<string>();
    for (const k of Object.keys(lObj)) { keys.push(k); seen.add(k); }
    for (const k of Object.keys(rObj)) { if (!seen.has(k)) keys.push(k); }
  }

  const getL = (key: string) => (valueKind(lv) === 'object' || lArr ? (lv as any)[key] : undefined);
  const getR = (key: string) => (valueKind(rv) === 'object' || rArr ? (rv as any)[key] : undefined);
  const hasL = (key: string) =>
    lArr ? Number(key) < (lv as unknown[]).length
         : valueKind(lv) === 'object' && Object.prototype.hasOwnProperty.call(lv, key);
  const hasR = (key: string) =>
    rArr ? Number(key) < (rv as unknown[]).length
         : valueKind(rv) === 'object' && Object.prototype.hasOwnProperty.call(rv, key);

  for (const key of keys) {
    const inL = hasL(key);
    const inR = hasR(key);
    const path = joinPath(parentPath, key, isIndex);
    const a = getL(key);
    const b = getR(key);

    if (inL && !inR) {
      emitRemoved(path, key, depth, a, left, right, counts);
      continue;
    }
    if (!inL && inR) {
      emitAdded(path, key, depth, b, left, right, counts);
      continue;
    }

    const aKind = valueKind(a);
    const bKind = valueKind(b);

    // Both are the same container kind -> emit an open line on both sides and recurse.
    if (aKind === bKind && (aKind === 'object' || aKind === 'array')) {
      const bracket = aKind === 'array' ? '[' : '{';
      const closeBracket = aKind === 'array' ? ']' : '}';
      const aChildren = aKind === 'array' ? (a as unknown[]).length : Object.keys(a as object).length;
      const bChildren = bKind === 'array' ? (b as unknown[]).length : Object.keys(b as object).length;
      const openL = left.length;
      const openR = right.length;
      left.push({ path, keyLabel: key, depth, status: 'unchanged', kind: aKind, bracket, childCount: aChildren });
      right.push({ path, keyLabel: key, depth, status: 'unchanged', kind: bKind, bracket, childCount: bChildren });

      const beforeChanged = counts.changed, beforeAdded = counts.added, beforeRemoved = counts.removed;
      walkLevel(a, b, path, depth + 1, left, right, counts);

      // Close lines.
      left.push({ path, keyLabel: '', depth, status: 'unchanged', kind: aKind, bracket: closeBracket });
      right.push({ path, keyLabel: '', depth, status: 'unchanged', kind: bKind, bracket: closeBracket });

      // Mark the container "changed" (visually) if any descendant changed.
      const touched =
        counts.changed !== beforeChanged ||
        counts.added !== beforeAdded ||
        counts.removed !== beforeRemoved;
      // Re-tag the open lines (captured by index before the push) as
      // 'changed' when descendants differ — O(1) instead of re-scanning.
      if (touched) {
        left[openL] = { ...left[openL], status: 'changed' };
        right[openR] = { ...right[openR], status: 'changed' };
      }
      continue;
    }

    // Scalar-vs-scalar, or kind mismatch (scalar<->container): single line, no recurse.
    const equal = aKind === 'scalar' && bKind === 'scalar' && bsonEqual(a, b);
    if (!equal) counts.changed++;
    const status: DiffStatus = equal ? 'unchanged' : 'changed';
    left.push({ path, keyLabel: key, depth, status, kind: 'scalar', value: a });
    right.push({ path, keyLabel: key, depth, status, kind: 'scalar', value: b });
  }
}

function emitRemoved(
  path: string, key: string, depth: number, a: unknown,
  left: DiffLine[], right: DiffLine[], counts: Counts,
): void {
  counts.removed++;
  const kind = valueKind(a);
  if (kind === 'object' || kind === 'array') {
    // Flatten the removed container as scalar-ish lines on the left only.
    left.push({ path, keyLabel: key, depth, status: 'removed', kind, bracket: kind === 'array' ? '[' : '{', childCount: kind === 'array' ? (a as unknown[]).length : Object.keys(a as object).length });
    right.push(gap(depth));
    flattenOneSide(a, path, depth + 1, 'removed', left, right);
    left.push({ path, keyLabel: '', depth, status: 'removed', kind, bracket: kind === 'array' ? ']' : '}' });
    right.push(gap(depth));
    return;
  }
  left.push({ path, keyLabel: key, depth, status: 'removed', kind: 'scalar', value: a });
  right.push(gap(depth));
}

function emitAdded(
  path: string, key: string, depth: number, b: unknown,
  left: DiffLine[], right: DiffLine[], counts: Counts,
): void {
  counts.added++;
  const kind = valueKind(b);
  if (kind === 'object' || kind === 'array') {
    right.push({ path, keyLabel: key, depth, status: 'added', kind, bracket: kind === 'array' ? '[' : '{', childCount: kind === 'array' ? (b as unknown[]).length : Object.keys(b as object).length });
    left.push(gap(depth));
    flattenOneSide(b, path, depth + 1, 'added', right, left);
    right.push({ path, keyLabel: '', depth, status: 'added', kind, bracket: kind === 'array' ? ']' : '}' });
    left.push(gap(depth));
    return;
  }
  right.push({ path, keyLabel: key, depth, status: 'added', kind: 'scalar', value: b });
  left.push(gap(depth));
}

// Emit every leaf of a one-sided (added or removed) container into `side`, with a
// matching gap pushed into `other` so the two columns stay aligned.
function flattenOneSide(
  val: unknown, parentPath: string, depth: number, status: DiffStatus,
  side: DiffLine[], other: DiffLine[],
): void {
  const isArr = Array.isArray(val);
  const entries: [string, unknown][] = isArr
    ? (val as unknown[]).map((v, i) => [String(i), v])
    : Object.entries(val as Record<string, unknown>);
  for (const [key, v] of entries) {
    const path = joinPath(parentPath, key, isArr);
    const kind = valueKind(v);
    if (kind === 'object' || kind === 'array') {
      side.push({ path, keyLabel: key, depth, status, kind, bracket: kind === 'array' ? '[' : '{', childCount: kind === 'array' ? (v as unknown[]).length : Object.keys(v as object).length });
      other.push(gap(depth));
      flattenOneSide(v, path, depth + 1, status, side, other);
      side.push({ path, keyLabel: '', depth, status, kind, bracket: kind === 'array' ? ']' : '}' });
      other.push(gap(depth));
    } else {
      side.push({ path, keyLabel: key, depth, status, kind: 'scalar', value: v });
      other.push(gap(depth));
    }
  }
}
