// Unique index checks for the fake backend's writes (#396): the duplicate key
// errors MongoDB gives an insert, an update, an import or an index build.
import { jsonEqual, valuesAt } from './mongo';
import type { Doc, IndexSeed } from './seed';
import type { Collection } from './state';

/** MongoDB's duplicate key error text, for an index and the key it found twice. */
const duplicateKeyError = (ns: string, index: string, fields: string[], key: unknown[]) =>
  `E11000 duplicate key error collection: ${ns} index: ${index} dup key: { ${fields
    .map((field, i) => `${field}: ${JSON.stringify(key[i])}`)
    .join(', ')} }`;

/**
 * Every key a document puts in an index, as MongoDB builds a multikey index:
 * an array on a field's path adds one entry per element, an empty array
 * indexes as undefined, and a missing field as null.
 */
function indexKeys(doc: Doc, fields: string[]): unknown[][] {
  let keys: unknown[][] = [[]];
  for (const field of fields) {
    const found = valuesAt(doc, field);
    const values =
      found.length === 0
        ? [null]
        : found.flatMap((value) => (!Array.isArray(value) ? [value] : value.length === 0 ? [{ $undefined: true }] : value));
    keys = keys.flatMap((key) => values.map((value) => [...key, value]));
  }
  return keys;
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
      const clash = wanted.find((key) => taken.some((other) => jsonEqual(other, key)));
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
    const clash = own.find((key) => seen.some((other) => jsonEqual(other, key)));
    if (clash) return duplicateKeyError(ns, name, fields, clash);
    seen.push(...own);
  }
  return null;
}
