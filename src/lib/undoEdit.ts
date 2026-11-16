import { isEjsonWrapper } from './bsonDisplay';

type Doc = Record<string, unknown>;

// A stored sub-document, as opposed to a typed value (`{ $date: … }`) or an array.
const isDocument = (v: unknown): v is Doc =>
  v !== null && typeof v === 'object' && !Array.isArray(v) && !isEjsonWrapper(v as Doc);
// One with fields: an empty document is a value to restore, not a parent.
const isParent = (v: unknown): v is Doc => isDocument(v) && Object.keys(v).length > 0;

/**
 * The `original` side of an undo's write: the document as saved, plus an empty
 * parent for each sub-document the save removed.
 *
 * Under a projection that showed only part of a sub-document (`"address.city": 1`),
 * removing it unset just the shown fields. Undoing that by writing the whole
 * sub-document back would be refused, since it could overwrite fields the
 * projection hid. With the parents present on both sides, the write becomes one
 * addition per shown field instead, the same as the removal it reverses.
 */
export function undoBaseline(saved: Doc, before: Doc): Doc {
  const out: Doc = { ...saved };
  for (const [key, value] of Object.entries(before)) {
    if (!isParent(value)) continue;
    if (!(key in saved)) out[key] = undoBaseline({}, value);
    else if (isDocument(saved[key])) out[key] = undoBaseline(saved[key] as Doc, value);
  }
  return out;
}

/**
 * The filter an undo adds to `_id`: every value the save wrote must still be
 * there, so an undo after anything else changed them (another window, another
 * client, a delete or a drop) matches nothing instead of writing old values
 * over the newer ones. Sub-documents are compared by path, so fields a
 * projection hid are not; typed values and arrays are compared whole. Both
 * sides must come through the same EJSON conversion, so unchanged values
 * read the same.
 */
export function undoCondition(saved: Doc, before: Doc, prefix = ''): Doc {
  const out: Doc = {};
  for (const key of new Set([...Object.keys(saved), ...Object.keys(before)])) {
    // `_id` is the filter already; a dotted or `$` name cannot be addressed.
    if ((!prefix && key === '_id') || key.includes('.') || key.startsWith('$')) continue;
    const path = prefix + key;
    if (!(key in saved)) {
      // A removed sub-document is checked field by field: under a projection
      // that showed part of it, only those fields were removed.
      if (isParent(before[key])) Object.assign(out, undoCondition({}, before[key] as Doc, `${path}.`));
      else out[path] = { $exists: false };
    } else if (key in before && isDocument(saved[key]) && isDocument(before[key])) {
      Object.assign(out, undoCondition(saved[key] as Doc, before[key] as Doc, `${path}.`));
    } else if (!(key in before) || JSON.stringify(saved[key]) !== JSON.stringify(before[key])) {
      out[path] = saved[key];
    }
  }
  return out;
}
