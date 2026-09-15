// A find projection's shape, and the field-level update an edit of a row it
// returned makes (#396), as `ProjectionShape` and `build_field_update` work them
// out in src-tauri/src/db/documents.rs.
//
// The editor shows what the query returned, so a projection makes that a
// partial view. Only what changed is written, and an edit that would lose or
// overwrite what the projection hid is refused with the backend's message.
import { isEjsonWrapper, jsonEqual } from './mongo';
import type { Doc } from './seed';

/** Which fields a projection returned. */
type Scope = 'all' | 'included' | 'excluded' | 'unknown';

/** What a projection entry says about its path. */
type Leaf = 'include' | 'exclude' | 'slice' | 'elemMatch' | 'computed' | 'meta';

export interface ProjectionShape {
  /** Every path the projection names, dotted. */
  paths: string[];
  /** Paths whose value the projection computed, with no stored field behind them. */
  computed: string[];
  /** Embedded documents a `$slice` or `$elemMatch` inside them may have left incomplete. */
  locallyHidden: string[];
  scope: Scope;
}

/** The update to send, or a whole-document replacement; null when nothing changed. */
export type FieldUpdatePlan = { update: Doc } | { replace: true };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** An embedded document, as opposed to a scalar, an array or an Extended JSON value such as `{ $oid }`. */
const isDocument = (value: unknown): value is Doc => isObject(value) && !isEjsonWrapper(value);

const has = (doc: Doc, key: string) => Object.prototype.hasOwnProperty.call(doc, key);

/** Set a key without reaching Object.prototype, whatever the key is. */
const put = (target: Doc, key: string, value: unknown) =>
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });

const parentOf = (path: string) => {
  const at = path.lastIndexOf('.');
  return at < 0 ? null : path.slice(0, at);
};

function flatten(prefix: string, map: Record<string, unknown>, out: Array<[string, Leaf]>): void {
  for (const [key, value] of Object.entries(map)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (typeof value === 'boolean') {
      out.push([path, value ? 'include' : 'exclude']);
    } else if (typeof value === 'number') {
      out.push([path, value === 0 ? 'exclude' : 'include']);
    } else if (isObject(value)) {
      const keys = Object.keys(value);
      if (keys.length === 0) out.push([path, 'include']);
      // `{ roles: { $slice: 2 } }` truncates the stored array without restricting the field list.
      else if (keys.every((k) => k === '$slice')) out.push([`${path}.$slice`, 'slice']);
      // `$elemMatch` returns only the matching element, and only the named field.
      else if (keys.every((k) => k === '$elemMatch')) out.push([`${path}.$elemMatch`, 'elemMatch']);
      // `$meta` adds a field from result metadata without hiding any.
      else if (keys.every((k) => k === '$meta')) out.push([path, 'meta']);
      // Any other operator is an aggregation expression.
      else if (keys.some((k) => k.startsWith('$'))) out.push([path, 'computed']);
      // `{ address: { city: 1 } }` is the nested spelling of `{ "address.city": 1 }`.
      else flatten(path, value, out);
    } else {
      // A string aliases a field or is a literal; an array or null is computed too.
      out.push([path, 'computed']);
    }
  }
}

/**
 * A find projection's shape (`ProjectionShape::parse_optional`). A null
 * projection, which rows from a reshaping pipeline arrive with, and one that
 * doesn't parse are both unknowable, so nothing is taken as complete or absent.
 */
export function parseProjection(projection: unknown): ProjectionShape {
  const unknown: ProjectionShape = { paths: [], computed: [], locallyHidden: [], scope: 'unknown' };
  if (projection === null || projection === undefined) return unknown;
  const text = String(projection).trim();
  if (text === '' || text === '{}') return { paths: [], computed: [], locallyHidden: [], scope: 'all' };
  let map: unknown;
  try {
    map = JSON.parse(text);
  } catch {
    return unknown;
  }
  if (!isObject(map)) return unknown;
  const entries: Array<[string, Leaf]> = [];
  flatten('', map, entries);
  let includes = false;
  let excludes = false;
  for (const [path, leaf] of entries) {
    // `_id: 0` beside an inclusion doesn't make it an exclusion projection.
    if (path === '_id' && leaf === 'exclude') continue;
    if (leaf === 'include' || leaf === 'computed' || leaf === 'elemMatch') includes = true;
    else if (leaf === 'exclude') excludes = true;
  }
  return {
    paths: entries.map(([path]) => path),
    computed: entries.filter(([, leaf]) => leaf === 'computed' || leaf === 'meta').map(([path]) => path),
    // The entry path is `<field>.<$op>`, so the embedded document is the field's parent.
    locallyHidden: entries
      .filter(([, leaf]) => leaf === 'slice' || leaf === 'elemMatch')
      .flatMap(([path]) => {
        const field = parentOf(path);
        const container = field === null ? null : parentOf(field);
        return container === null ? [] : [container];
      }),
    scope: includes && excludes ? 'unknown' : includes ? 'included' : excludes ? 'excluded' : 'all',
  };
}

const isComputed = (shape: ProjectionShape, path: string) =>
  shape.computed.some((p) => p === path || path.startsWith(`${p}.`));

/** Nothing was projected away, so the document is whole. */
const isWholeDocument = (shape: ProjectionShape) => shape.scope === 'all' && shape.paths.length === 0;

/** The value at `path` may hold parts that weren't loaded. */
const isPartialAt = (shape: ProjectionShape, path: string) =>
  shape.scope === 'unknown' || shape.paths.some((p) => p.startsWith(`${path}.`));

const namesSelfOrAncestor = (shape: ProjectionShape, path: string) =>
  shape.paths.some((p) => p === path || path.startsWith(`${p}.`));

/** The stored document could hold a value at `path` that was never returned. */
function mayHide(shape: ProjectionShape, path: string): boolean {
  if (shape.locallyHidden.some((container) => path.startsWith(`${container}.`))) return true;
  if (shape.scope === 'all') return false;
  if (shape.scope === 'unknown') return true;
  return shape.scope === 'included' ? !namesSelfOrAncestor(shape, path) : namesSelfOrAncestor(shape, path);
}

/** A field name an update operator reads as a path or an operator. */
const unaddressable = (key: string) => key.includes('.') || key.startsWith('$');

interface Sink {
  set: Doc;
  unset: Doc;
  blocked: string[];
  partialWrites: string[];
  ambiguousRemovals: string[];
  hiddenAdditions: string[];
  computedWrites: string[];
}

function diffDocuments(prefix: string, original: Doc, edited: Doc, shape: ProjectionShape, sink: Sink): void {
  const pathOf = (key: string) => (prefix === '' ? key : `${prefix}.${key}`);
  const isImmutableId = (key: string) => prefix === '' && key === '_id';

  for (const [key, value] of Object.entries(edited)) {
    if (isImmutableId(key)) continue;
    const path = pathOf(key);
    const loaded = has(original, key);
    const old = loaded ? original[key] : undefined;
    const changed = !loaded || !jsonEqual(old, value);
    if (changed && isComputed(shape, path)) {
      sink.computedWrites.push(path);
      continue;
    }
    if (changed && unaddressable(key)) {
      sink.blocked.push(path);
      continue;
    }
    // A value loaded only partly can't be written back whole: a sliced array
    // would lose its unseen elements, and an object the siblings it hid.
    const oldMayHideMore = loaded && (isDocument(old) || Array.isArray(old));
    const writesWholeValue = !(loaded && isDocument(old) && isDocument(value));
    if (changed && oldMayHideMore && writesWholeValue && isPartialAt(shape, path)) {
      sink.partialWrites.push(path);
      continue;
    }
    if (!loaded) {
      // Absent from the row isn't absent from the document when the projection may have hidden it.
      if (mayHide(shape, path)) sink.hiddenAdditions.push(path);
      else put(sink.set, path, value);
    } else if (!changed) {
      continue;
    } else if (isDocument(old) && isDocument(value)) {
      diffDocuments(path, old, value, shape, sink);
    } else {
      put(sink.set, path, value);
    }
  }

  for (const [key, value] of Object.entries(original)) {
    if (isImmutableId(key) || has(edited, key)) continue;
    if (unaddressable(key)) {
      sink.blocked.push(pathOf(key));
      continue;
    }
    planRemoval(pathOf(key), value, shape, sink);
  }
}

const sinkSize = (sink: Sink) =>
  [Object.keys(sink.unset).length, sink.blocked.length, sink.partialWrites.length, sink.ambiguousRemovals.length].join();

function planRemoval(path: string, value: unknown, shape: ProjectionShape, sink: Sink): void {
  // The value on screen was computed, so there's no stored field of that name to remove.
  if (isComputed(shape, path)) {
    sink.computedWrites.push(path);
    return;
  }
  if (isDocument(value)) {
    // Loaded whole, so the field itself goes.
    if (!isPartialAt(shape, path)) {
      put(sink.unset, path, '');
      return;
    }
    // Loaded partly: only what was shown may go, or the hidden siblings go with it.
    const before = sinkSize(sink);
    for (const [key, child] of Object.entries(value)) {
      if (unaddressable(key)) {
        sink.blocked.push(`${path}.${key}`);
        continue;
      }
      planRemoval(`${path}.${key}`, child, shape, sink);
    }
    // What was shown is empty, which an empty stored object can't be told apart from.
    if (sinkSize(sink) === before) sink.ambiguousRemovals.push(path);
    return;
  }
  // A `$slice` or `$elemMatch` returned only part of the array.
  if (Array.isArray(value) && isPartialAt(shape, path)) {
    sink.partialWrites.push(path);
    return;
  }
  put(sink.unset, path, '');
}

const listed = (paths: string[]) => [...new Set(paths)].sort().join(', ');

/**
 * The update that turns a row as loaded into the row as edited
 * (`build_field_update`): embedded documents are compared field by field and
 * written as dotted paths, a field the edit dropped is unset, and an edit the
 * projection makes unsafe is refused with the backend's message. A changed
 * field name an update can't address is saved by replacing the document, but
 * only when the whole document was loaded.
 */
export function buildFieldUpdate(original: Doc, edited: Doc, shape: ProjectionShape): FieldUpdatePlan | null {
  if (isComputed(shape, '_id')) {
    throw 'cannot save: the query replaced _id with a computed value, so MQLens cannot tell which stored document this row came from. Re-run the query without projecting _id to edit documents.';
  }
  if (shape.scope === 'unknown') {
    throw 'cannot save: these rows did not come from a plain query, so MQLens cannot tell which stored document each one came from. Re-run as a find query to edit documents.';
  }
  if (has(original, '_id')) {
    if (!has(edited, '_id')) throw "cannot remove _id: a document's _id is immutable. Restore it and save again.";
    if (!jsonEqual(original._id, edited._id)) throw "cannot change _id: a document's _id is immutable. Insert a new document instead.";
  }

  const sink: Sink = { set: {}, unset: {}, blocked: [], partialWrites: [], ambiguousRemovals: [], hiddenAdditions: [], computedWrites: [] };
  diffDocuments('', original, edited, shape, sink);

  if (sink.blocked.length > 0) {
    if (isWholeDocument(shape)) return { replace: true };
    throw `cannot update field name(s) ${listed(sink.blocked)} in place: MongoDB reads "." as a path separator and a leading "$" as an operator. Re-run the query without a projection so the whole document can be saved.`;
  }
  if (sink.computedWrites.length > 0) {
    throw `cannot save field(s) ${listed(sink.computedWrites)}: the projection computed them, so there is no stored field to write back to. Re-run the query without the projection to edit this document.`;
  }
  if (sink.hiddenAdditions.length > 0) {
    throw `cannot add field(s) ${listed(sink.hiddenAdditions)}: the projection did not return them, so a field that is genuinely new cannot be told apart from one that already exists and would be overwritten. Re-run the query without the projection to add these.`;
  }
  if (sink.ambiguousRemovals.length > 0) {
    throw `cannot remove field(s) ${listed(sink.ambiguousRemovals)}: the projection returned them empty, so an empty stored object cannot be told apart from one whose fields it hid. Re-run the query without the projection to remove these.`;
  }
  if (sink.partialWrites.length > 0) {
    throw `cannot save field(s) ${listed(sink.partialWrites)}: the projection returned only part of their contents, so writing them back would discard the rest. Re-run the query without the projection to edit these.`;
  }

  const update: Doc = {};
  if (Object.keys(sink.set).length > 0) update.$set = sink.set;
  if (Object.keys(sink.unset).length > 0) update.$unset = sink.unset;
  return Object.keys(update).length === 0 ? null : { update };
}
