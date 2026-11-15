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
