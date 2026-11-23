// Field-level edits from the results tree: rename, add and remove one field.
// Each returns an edited copy of the document as loaded (Extended JSON), which
// goes through the same field-level update_document as an in-place value edit,
// so only the changed paths are written ($set / $unset).
import { parseShellJson } from './shellDoc';

type Doc = Record<string, any>;

const parentOf = (doc: Doc, path: string[]): Doc => path.reduce((v, k) => v[k], doc);

export function renameField(doc: Doc, path: string[], newName: string): Doc {
  const out = structuredClone(doc);
  const parent = parentOf(out, path.slice(0, -1));
  const old = path[path.length - 1];
  parent[newName] = parent[old];
  delete parent[old];
  return out;
}

export function removeField(doc: Doc, path: string[]): Doc {
  const out = structuredClone(doc);
  delete parentOf(out, path.slice(0, -1))[path[path.length - 1]];
  return out;
}

export function addField(doc: Doc, parentPath: string[], name: string, value: unknown): Doc {
  const out = structuredClone(doc);
  parentOf(out, parentPath)[name] = value;
  return out;
}

export type FieldNameError = 'empty' | 'dot' | 'dollar' | 'exists';

/** Why a field name can't be used next to `siblings`, or null when it can. */
export function fieldNameError(name: string, siblings: Doc): FieldNameError | null {
  if (!name) return 'empty';
  if (name.includes('.')) return 'dot';
  if (name.startsWith('$')) return 'dollar';
  if (Object.prototype.hasOwnProperty.call(siblings, name)) return 'exists';
  return null;
}

export const FIELD_TYPES = ['string', 'number', 'long', 'decimal', 'boolean', 'date', 'objectId', 'null', 'object', 'array'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** Types whose value is fixed, so nothing is asked for. */
export const VALUELESS_TYPES: readonly FieldType[] = ['null', 'object', 'array'];

/** A sample value for the value prompt's placeholder. */
export const FIELD_VALUE_EXAMPLES: Partial<Record<FieldType, string>> = {
  number: '42',
  long: '9007199254740993',
  decimal: '19.99',
  boolean: 'true',
  date: '2024-01-01T00:00:00Z',
  objectId: '603d779f4f102e3a105c3120',
};

const NUMBER = /^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

/** The value typed for a new field, read as `type`. Throws when it isn't one. */
export function fieldValue(type: FieldType, text: string): unknown {
  const s = text.trim();
  const bad = () => { throw new Error(`not a ${type}`); };
  switch (type) {
    case 'string': return text;
    case 'number': return NUMBER.test(s) ? Number(s) : bad();
    case 'long': return /^-?\d+$/.test(s) ? parseShellJson(`NumberLong("${s}")`) : bad();
    case 'decimal': return NUMBER.test(s) ? parseShellJson(`NumberDecimal("${s}")`) : bad();
    case 'boolean': return /^(true|false)$/i.test(s) ? s.toLowerCase() === 'true' : bad();
    case 'date': return s && !Number.isNaN(Date.parse(s)) ? parseShellJson(`ISODate("${s}")`) : bad();
    case 'objectId': return /^[0-9a-f]{24}$/i.test(s) ? { $oid: s.toLowerCase() } : bad();
    case 'null': return null;
    case 'object': return {};
    case 'array': return [];
  }
}
