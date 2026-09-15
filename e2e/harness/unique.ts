// Unique index checks for the fake backend's writes (#396): the duplicate key
// errors MongoDB gives an insert, an update, an import or an index build.
import { bsonEqual, valuesAt } from './mongo';
import type { Doc, IndexSeed } from './seed';
import type { Collection } from './state';

/** MongoDB's duplicate key error text, for an index and the key it found twice. */
const duplicateKeyError = (ns: string, index: string, fields: string[], key: unknown[]) =>
  `E11000 duplicate key error collection: ${ns} index: ${index} dup key: { ${fields
    .map((field, i) => `${field}: ${JSON.stringify(key[i])}`)
    .join(', ')} }`;

const UNDEFINED = { $undefined: true };

/** An embedded document, as opposed to a scalar, an array or an Extended JSON value such as `{ $oid }`. */
const isDocument = (value: unknown): value is Doc =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && !Object.keys(value).some((key) => key.startsWith('$'));

/** An index field still being followed: its position in the key, and the path left to walk. */
interface Pending {
  at: number;
  rest: string[];
}

/**
 * The combinations of values that `pending` fields take under `node`, one map
 * of field position to value per combination. Fields that walk through the
 * same array go through each element together, so their values stay paired
 * as MongoDB pairs them; fields under different keys combine freely.
 */
function expand(node: unknown, pending: Pending[]): Array<Map<number, unknown>> {
  const continuing = pending.filter((field) => field.rest.length > 0);
  if (continuing.length > 0 && Array.isArray(node)) {
    if (node.length === 0) return [new Map(pending.map((field) => [field.at, field.rest.length === 0 ? UNDEFINED : null]))];
    return node.flatMap((element) => expand(element, pending));
  }
  const ending = pending.filter((field) => field.rest.length === 0);
  let combos: Array<Map<number, unknown>> = [new Map()];
  if (ending.length > 0) {
    // A field that ends on an array indexes each element, and on an empty one, undefined.
    const values = node === undefined ? [null] : !Array.isArray(node) ? [node] : node.length === 0 ? [UNDEFINED] : node;
    combos = values.map((value) => new Map(ending.map((field) => [field.at, value])));
  }
  const byKey = new Map<string, Pending[]>();
  for (const field of continuing) {
    byKey.set(field.rest[0], [...(byKey.get(field.rest[0]) ?? []), { at: field.at, rest: field.rest.slice(1) }]);
  }
  for (const [key, fields] of byKey) {
    const child = isDocument(node) ? node[key] : undefined;
    const below = child === undefined ? [new Map(fields.map((field) => [field.at, null]))] : expand(child, fields);
    combos = combos.flatMap((combo) => below.map((more) => new Map([...combo, ...more])));
  }
  return combos;
}

/**
 * Every key a document puts in an index, as MongoDB builds a multikey index:
 * an array on a field's path adds one entry per element, compound fields under
 * the same array element stay together, an empty array indexes as undefined,
 * and a missing field as null.
 */
function indexKeys(doc: Doc, fields: string[]): unknown[][] {
  return expand(doc, fields.map((field, at) => ({ at, rest: field.split('.') }))).map((combo) =>
    fields.map((_, at) => (combo.has(at) ? combo.get(at) : null)),
  );
}

/** Whether a sparse index leaves a document out: it has none of the indexed fields. */
const leftOut = (sparse: boolean | undefined, doc: Doc, fields: string[]) =>
  Boolean(sparse) && fields.every((field) => valuesAt(doc, field).length === 0);

/**
 * MongoDB's duplicate key error for writing `doc` into `target`, when its `_id`
 * or any key it gives a unique index already belongs to another document.
 * `replacing` is the stored document an update replaces, which doesn't count.
 */
export function duplicateKey(ns: string, target: Collection, doc: Doc, replacing?: Doc): string | null {
  const unique: IndexSeed[] = [{ name: '_id_', keys: { _id: 1 } }, ...target.indexes.filter((index) => index.unique)];
  for (const index of unique) {
    const fields = Object.keys(index.keys);
    if (leftOut(index.sparse, doc, fields)) continue;
    const wanted = indexKeys(doc, fields);
    for (const existing of target.docs) {
      if (existing === replacing || leftOut(index.sparse, existing, fields)) continue;
      const taken = indexKeys(existing, fields);
      // Keys compare as BSON values, so a stored 1 and an incoming { $numberLong: "1" } clash.
      const clash = wanted.find((key) => taken.some((other) => bsonEqual(other, key)));
      if (clash) return duplicateKeyError(ns, index.name, fields, clash);
    }
  }
  return null;
}

/**
 * MongoDB's error for building a unique index over documents that already
 * share a key. A document repeating a key inside its own array is fine; only
 * another document's copy clashes, and a sparse index skips documents without
 * the indexed fields.
 */
export function duplicateIndexKey(ns: string, name: string, keys: Doc, docs: Doc[], sparse = false): string | null {
  const fields = Object.keys(keys);
  const seen: unknown[][] = [];
  for (const doc of docs) {
    if (leftOut(sparse, doc, fields)) continue;
    const own = indexKeys(doc, fields);
    const clash = own.find((key) => seen.some((other) => bsonEqual(other, key)));
    if (clash) return duplicateKeyError(ns, name, fields, clash);
    seen.push(...own);
  }
  return null;
}

/**
 * The arrays a document meets along an index field's path, by the dotted path
 * each one sits at. An array held directly in another array isn't followed, as
 * MongoDB doesn't expand one.
 */
function arraysOn(node: unknown, parts: string[], at: string, found: string[]): void {
  if (Array.isArray(node)) {
    if (!found.includes(at)) found.push(at);
    for (const element of node) if (!Array.isArray(element)) arraysOn(element, parts, at, found);
    return;
  }
  if (parts.length === 0 || !isDocument(node)) return;
  const [head, ...rest] = parts;
  if (!Object.prototype.hasOwnProperty.call(node, head)) return;
  arraysOn(node[head], rest, at === '' ? head : `${at}.${head}`, found);
}

const leafName = (path: string) => path.slice(path.lastIndexOf('.') + 1);

/**
 * MongoDB's error for a document a compound index can't key: two of its fields
 * reach different arrays that aren't nested one inside the other, so their
 * elements can't be paired (`cannot index parallel arrays [b] [a]`).
 */
function parallelArraysError(keys: Doc, doc: Doc): string | null {
  const fields = Object.keys(keys);
  if (fields.length < 2) return null;
  const seen: string[] = [];
  for (const field of fields) {
    const arrays: string[] = [];
    arraysOn(doc, field.split('.'), '', arrays);
    for (const array of arrays) {
      const other = seen.find((earlier) => earlier !== array && !array.startsWith(`${earlier}.`) && !earlier.startsWith(`${array}.`));
      if (other !== undefined) return `cannot index parallel arrays [${leafName(array)}] [${leafName(other)}]`;
    }
    for (const array of arrays) if (!seen.includes(array)) seen.push(array);
  }
  return null;
}

/** The parallel-array error writing `doc` into `target` gets from any of its indexes. */
export function parallelArrays(target: Collection, doc: Doc): string | null {
  for (const index of target.indexes) {
    const error = parallelArraysError(index.keys, doc);
    if (error) return error;
  }
  return null;
}

/** The parallel-array error building an index on `keys` over `docs` gets. */
export function parallelArraysOver(keys: Doc, docs: Doc[]): string | null {
  for (const doc of docs) {
    const error = parallelArraysError(keys, doc);
    if (error) return error;
  }
  return null;
}
