// In-memory stand-in for the MongoDB operations the backend runs (#396).
//
// It covers the query and aggregation features the app's UI can produce. An
// operator or stage it doesn't implement is rejected with a clear message
// rather than ignored, so a test can't pass on a silently wrong result.
import { addNumeric, averageNumbers, compareNumbers, numericValue, readNumeric, sumNumbers } from './numeric';
import type { Doc } from './seed';

const EJSON_WRAPPERS = new Set([
  '$oid', '$date', '$numberInt', '$numberLong', '$numberDouble', '$numberDecimal',
  '$binary', '$uuid', '$regularExpression', '$timestamp', '$minKey', '$maxKey', '$symbol', '$code',
  '$dbPointer', '$undefined',
]);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const isEjsonWrapper = (value: unknown): boolean =>
  isPlainObject(value) && Object.keys(value).some((key) => EJSON_WRAPPERS.has(key));

const unsupported = (what: string): never => {
  throw `Unsupported ${what} in the e2e fake backend`;
};

/** A value with its Extended JSON wrapper removed, so it compares like the BSON value. */
export function comparable(value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  if ('$oid' in value) return String(value.$oid);
  if ('$symbol' in value) return String(value.$symbol);
  if ('$date' in value) {
    const date = value.$date;
    if (typeof date === 'string') return Date.parse(date);
    if (typeof date === 'number') return date;
    if (isPlainObject(date) && '$numberLong' in date) return Number(date.$numberLong);
  }
  for (const key of ['$numberInt', '$numberLong', '$numberDouble', '$numberDecimal']) {
    if (key in value) return Number(value[key]);
  }
  return value;
}

const NUMBER_WRAPPERS = ['$numberInt', '$numberLong', '$numberDouble', '$numberDecimal'];

/**
 * BSON's cross-type order: MinKey, null, numbers, strings, objects, arrays,
 * binary data, ObjectIds, booleans, dates, timestamps, regular expressions,
 * MaxKey. It reads the Extended JSON value before its wrapper is removed, so an
 * ObjectId and the same hex string are different types, as are a date and its
 * milliseconds, and neither equals the other.
 */
function typeRank(value: unknown): number {
  if (value === null || value === undefined) return 1;
  if (typeof value === 'number') return 2;
  if (typeof value === 'string') return 3;
  if (Array.isArray(value)) return 5;
  if (typeof value === 'boolean') return 8;
  if (isPlainObject(value)) {
    if ('$minKey' in value) return 0;
    if (NUMBER_WRAPPERS.some((key) => key in value)) return 2;
    if ('$symbol' in value) return 3;
    if ('$binary' in value || '$uuid' in value) return 6;
    if ('$oid' in value) return 7;
    if ('$date' in value) return 9;
    if ('$timestamp' in value) return 10;
    if ('$regularExpression' in value) return 11;
    if ('$maxKey' in value) return 12;
    return 4;
  }
  return 13;
}

/**
 * Two field lists in BSON order: each pair compares by type, then by name, then
 * by value, and the list that runs out first sorts first. Embedded documents
 * compare by their fields in order, and arrays by their elements.
 */
function compareFields(a: Array<[string, unknown]>, b: Array<[string, unknown]>): number {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const [nameA, valueA] = a[i];
    const [nameB, valueB] = b[i];
    const rank = typeRank(valueA) - typeRank(valueB);
    if (rank !== 0) return Math.sign(rank);
    if (nameA !== nameB) return nameA < nameB ? -1 : 1;
    const order = compareValues(valueA, valueB);
    if (order !== 0) return order;
  }
  return Math.sign(a.length - b.length);
}

/** Binary data's bytes, as a string of byte values, and its subtype. */
function binaryOf(value: Record<string, unknown>): [string, number] {
  if ('$uuid' in value) {
    const hex = String(value.$uuid).replace(/-/g, '');
    return [(hex.match(/../g) ?? []).map((pair) => String.fromCharCode(parseInt(pair, 16))).join(''), 4];
  }
  const body = value.$binary as { base64?: unknown; subType?: unknown };
  return [atob(String(body.base64 ?? '')), parseInt(String(body.subType ?? '0'), 16)];
}

export function compareValues(a: unknown, b: unknown): number {
  const rank = typeRank(a) - typeRank(b);
  if (rank !== 0) return rank;
  switch (typeRank(a)) {
    // Numbers compare exactly, whatever their representation.
    case 2:
      return compareNumbers(a, b);
    // Embedded documents by their fields and arrays by their elements, never by their JSON text.
    case 4:
      return compareFields(Object.entries(a as Doc), Object.entries(b as Doc));
    case 5:
      return compareFields(
        (a as unknown[]).map((value, i): [string, unknown] => [String(i), value]),
        (b as unknown[]).map((value, i): [string, unknown] => [String(i), value]),
      );
    // Binary data by length, then subtype, then bytes.
    case 6: {
      const [x, xType] = binaryOf(a as Record<string, unknown>);
      const [y, yType] = binaryOf(b as Record<string, unknown>);
      if (x.length !== y.length) return Math.sign(x.length - y.length);
      if (xType !== yType) return Math.sign(xType - yType);
      return x < y ? -1 : x > y ? 1 : 0;
    }
    // Timestamps by their seconds, then their increment.
    case 10: {
      const x = (a as { $timestamp: { t: unknown; i: unknown } }).$timestamp;
      const y = (b as { $timestamp: { t: unknown; i: unknown } }).$timestamp;
      return Math.sign(Number(x.t) - Number(y.t)) || Math.sign(Number(x.i) - Number(y.i));
    }
    // Regular expressions by pattern, then options.
    case 11: {
      const x = (a as { $regularExpression: { pattern: string; options: string } }).$regularExpression;
      const y = (b as { $regularExpression: { pattern: string; options: string } }).$regularExpression;
      if (x.pattern !== y.pattern) return x.pattern < y.pattern ? -1 : 1;
      return x.options < y.options ? -1 : x.options > y.options ? 1 : 0;
    }
  }
  const x = comparable(a);
  const y = comparable(b);
  if (typeof x === 'number' && typeof y === 'number') return x - y;
  if (typeof x === 'boolean' && typeof y === 'boolean') return Number(x) - Number(y);
  const left = typeof x === 'string' ? x : JSON.stringify(x);
  const right = typeof y === 'string' ? y : JSON.stringify(y);
  return left < right ? -1 : left > right ? 1 : 0;
}

const sameType = (a: unknown, b: unknown) => typeRank(a) === typeRank(b);

/**
 * BSON equality: the same type, numbers by value whatever their representation,
 * embedded documents field by field in order, and arrays element by element.
 * A query's equality and a unique index's keys both compare this way.
 */
export function bsonEqual(a: unknown, b: unknown): boolean {
  if (!sameType(a, b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, i) => bsonEqual(value, b[i]));
  if (isPlainObject(a) && isPlainObject(b) && !isEjsonWrapper(a) && !isEjsonWrapper(b)) {
    const keys = Object.keys(a);
    const others = Object.keys(b);
    return keys.length === others.length && keys.every((key, i) => key === others[i] && bsonEqual(a[key], b[key]));
  }
  return compareValues(a, b) === 0;
}

const valuesEqual = bsonEqual;

/** Equality of two JSON values, with objects equal whatever order their keys are in. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, i) => jsonEqual(value, b[i]));
  }
  if (isPlainObject(a) || isPlainObject(b)) {
    if (!isPlainObject(a) || !isPlainObject(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => key in b && jsonEqual(a[key], b[key]));
  }
  return a === b;
}

/** Every value at a dotted path. Arrays on the way are searched element-wise, as MongoDB does. */
export function valuesAt(doc: unknown, path: string): unknown[] {
  let current: unknown[] = [doc];
  for (const part of path.split('.')) {
    const next: unknown[] = [];
    for (const value of current) {
      if (Array.isArray(value)) {
        const index = Number(part);
        if (Number.isInteger(index) && String(index) === part) {
          if (index < value.length) next.push(value[index]);
        } else {
          for (const element of value) if (isPlainObject(element) && part in element) next.push(element[part]);
        }
      } else if (isPlainObject(value) && !isEjsonWrapper(value) && part in value) {
        next.push(value[part]);
      }
    }
    current = next;
  }
  return current;
}

const equalsOrContains = (value: unknown, target: unknown): boolean =>
  Array.isArray(value) && !Array.isArray(target)
    ? value.some((element) => valuesEqual(element, target))
    : valuesEqual(value, target);

const compareAny = (value: unknown, target: unknown, accept: (order: number) => boolean): boolean =>
  (Array.isArray(value) ? value : [value]).some((element) => sameType(element, target) && accept(compareValues(element, target)));

function regexFrom(pattern: unknown, options: unknown): RegExp {
  if (isPlainObject(pattern) && isPlainObject(pattern.$regularExpression)) {
    const re = pattern.$regularExpression;
    return new RegExp(String(re.pattern), String(re.options ?? ''));
  }
  return new RegExp(String(pattern), String(options ?? ''));
}

/** Whether a string value, or any string element of an array value, matches, as a query's regular expression does. */
const regexMatches = (value: unknown, re: RegExp) =>
  (Array.isArray(value) ? value : [value]).some((element) => typeof element === 'string' && re.test(element));

/** The BSON type name MongoDB gives a value in relaxed Extended JSON. */
export function bsonType(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'string') return 'string';
  // A JSON integer becomes an int32 when it fits and an int64 when it doesn't, as `Bson::try_from` reads it.
  if (typeof value === 'number') return Number.isInteger(value) ? (value >= -0x8000_0000 && value <= 0x7fff_ffff ? 'int' : 'long') : 'double';
  // Extended JSON wrappers, recognised by their key in `Bson::try_from`'s order, named as `$type` names them.
  if (isPlainObject(value)) {
    if ('$oid' in value) return 'objectId';
    if ('$symbol' in value) return 'symbol';
    if ('$regularExpression' in value) return 'regex';
    if ('$numberInt' in value) return 'int';
    if ('$numberLong' in value) return 'long';
    if ('$numberDouble' in value) return 'double';
    if ('$numberDecimal' in value) return 'decimal';
    if ('$binary' in value || '$uuid' in value) return 'binData';
    if ('$code' in value) return '$scope' in value ? 'javascriptWithScope' : 'javascript';
    if ('$timestamp' in value) return 'timestamp';
    if ('$date' in value) return 'date';
    if ('$minKey' in value) return 'minKey';
    if ('$maxKey' in value) return 'maxKey';
    if ('$dbPointer' in value) return 'dbPointer';
    if ('$undefined' in value) return 'undefined';
    return 'object';
  }
  return typeof value;
}

const NUMBER_TYPE_NAMES = ['int', 'long', 'double', 'decimal'];

/** The BSON type codes `$type` accepts, by the alias it also accepts. */
const TYPE_CODES: Record<number, string> = {
  1: 'double', 2: 'string', 3: 'object', 4: 'array', 5: 'binData', 6: 'undefined', 7: 'objectId', 8: 'bool', 9: 'date',
  10: 'null', 11: 'regex', 12: 'dbPointer', 13: 'javascript', 14: 'symbol', 15: 'javascriptWithScope', 16: 'int',
  17: 'timestamp', 18: 'long', 19: 'decimal', [-1]: 'minKey', 127: 'maxKey',
};
const TYPE_ALIASES = new Set([...Object.values(TYPE_CODES), 'number']);

/** A `$type` argument as its alias, refused the way MongoDB refuses one it doesn't know. */
function typeAlias(arg: unknown): string {
  if (typeof arg === 'number') {
    if (!(arg in TYPE_CODES)) throw `Invalid numerical type code: ${arg}`;
    return TYPE_CODES[arg];
  }
  if (typeof arg !== 'string' || !TYPE_ALIASES.has(arg)) throw `Unknown type name alias: ${String(arg)}`;
  return arg;
}

const isOperatorObject = (value: unknown): value is Record<string, unknown> =>
  isPlainObject(value) &&
  Object.keys(value).length > 0 &&
  !isEjsonWrapper(value) &&
  Object.keys(value).every((key) => key.startsWith('$'));

function fieldMatches(values: unknown[], condition: unknown): boolean {
  if (isPlainObject(condition) && '$regularExpression' in condition) {
    const re = regexFrom(condition, undefined);
    return values.some((value) => regexMatches(value, re));
  }
  if (!isOperatorObject(condition)) {
    return values.some((value) => equalsOrContains(value, condition)) || (values.length === 0 && condition === null);
  }
  return Object.entries(condition).every(([op, arg]) => {
    switch (op) {
      case '$eq':
        return fieldMatches(values, arg);
      case '$ne':
        return !fieldMatches(values, arg);
      case '$gt':
        return values.some((value) => compareAny(value, arg, (order) => order > 0));
      case '$gte':
        return values.some((value) => compareAny(value, arg, (order) => order >= 0));
      case '$lt':
        return values.some((value) => compareAny(value, arg, (order) => order < 0));
      case '$lte':
        return values.some((value) => compareAny(value, arg, (order) => order <= 0));
      case '$in':
        return (arg as unknown[]).some((target) => fieldMatches(values, target));
      case '$nin':
        return !(arg as unknown[]).some((target) => fieldMatches(values, target));
      case '$exists':
        return values.length > 0 === Boolean(arg);
      case '$regex': {
        const re = regexFrom(arg, condition.$options);
        return values.some((value) => regexMatches(value, re));
      }
      case '$options':
        return true;
      case '$size':
        return values.some((value) => Array.isArray(value) && value.length === arg);
      case '$all':
        return (arg as unknown[]).every((target) => values.some((value) => equalsOrContains(value, target)));
      case '$elemMatch':
        return values.some(
          (value) =>
            Array.isArray(value) &&
            value.some((element) => (isPlainObject(element) && !isOperatorObject(arg) ? matches(element, arg as Doc) : fieldMatches([element], arg))),
        );
      case '$not':
        return !fieldMatches(values, arg);
      case '$type': {
        const wanted = (Array.isArray(arg) ? arg : [arg]).map(typeAlias);
        const isWanted = (value: unknown) =>
          wanted.includes(bsonType(value)) || (wanted.includes('number') && NUMBER_TYPE_NAMES.includes(bsonType(value)));
        // An array matches by its own type, or by the type of any of its elements.
        return values.some((value) => isWanted(value) || (Array.isArray(value) && value.some(isWanted)));
      }
      default:
        return unsupported(`query operator ${op}`);
    }
  });
}

export function matches(doc: Doc, filter: Doc): boolean {
  return Object.entries(filter).every(([key, condition]) => {
    if (key === '$and') return (condition as Doc[]).every((clause) => matches(doc, clause));
    if (key === '$or') return (condition as Doc[]).some((clause) => matches(doc, clause));
    if (key === '$nor') return !(condition as Doc[]).some((clause) => matches(doc, clause));
    if (key.startsWith('$')) return unsupported(`query operator ${key}`);
    return fieldMatches(valuesAt(doc, key), condition);
  });
}

/**
 * The value a document sorts by at `path`. An array, or several values reached
 * through one, sorts by its lowest element ascending and its highest
 * descending, as MongoDB sorts a multikey field; a missing field sorts as null.
 */
function sortKey(doc: Doc, path: string, descending: boolean): unknown {
  const values = valuesAt(doc, path).flatMap((value) => (Array.isArray(value) ? value : [value]));
  if (values.length === 0) return null;
  return values.reduce((best, value) => {
    const order = compareValues(value, best);
    return (descending ? order > 0 : order < 0) ? value : best;
  });
}

export function sortDocs(docs: Doc[], spec: Record<string, unknown>): Doc[] {
  const keys = Object.entries(spec);
  if (keys.length === 0) return docs;
  return [...docs].sort((a, b) => {
    for (const [path, direction] of keys) {
      const descending = Number(direction) < 0;
      const order = compareValues(sortKey(a, path, descending), sortKey(b, path, descending));
      if (order !== 0) return descending ? -order : order;
    }
    return 0;
  });
}

/**
 * The error for a field name that would reach Object.prototype through an
 * assignment or a delete. MongoDB allows these names; the fake refuses them
 * rather than let a test's data pollute prototypes.
 */
const unsafeKey = (part: string) => `e2e fake backend refuses the field name ${part}`;

function setPath(target: Doc, path: string, value: unknown): void {
  const parts = path.split('.');
  for (const part of parts) {
    if (part === '__proto__' || part === 'constructor' || part === 'prototype') throw unsafeKey(part);
  }
  let node: Record<string, unknown> = target;
  for (const part of parts.slice(0, -1)) {
    if (!isPlainObject(node[part])) node[part] = {};
    node = node[part] as Record<string, unknown>;
  }
  node[parts[parts.length - 1]] = value;
}

/**
 * Assign a dotted path the way a `$set` or `$addFields` stage, or a computed
 * projection field, does: an array on the way keeps its shape and has the rest
 * of the path assigned in each of its elements, and anything else that isn't
 * an embedded document is replaced by one.
 */
function addFieldPath(target: Record<string, unknown>, parts: string[], value: unknown): void {
  const [head, ...rest] = parts;
  if (head === '__proto__' || head === 'constructor' || head === 'prototype') throw unsafeKey(head);
  target[head] = rest.length === 0 ? structuredClone(value) : assignWithin(target[head], rest, value);
}

function assignWithin(current: unknown, parts: string[], value: unknown): unknown {
  if (Array.isArray(current)) return current.map((element) => assignWithin(element, parts, value));
  const doc = isPlainObject(current) && !isEjsonWrapper(current) ? current : {};
  addFieldPath(doc, parts, value);
  return doc;
}

/**
 * Set a dotted path the way an update operator does. A numeric part indexes
 * into an array, padding it with nulls; a missing part becomes an embedded
 * document; and a part under anything else is refused, as MongoDB refuses it.
 */
function updatePath(target: Doc, path: string, value: unknown): void {
  const parts = path.split('.');
  let node: Record<string, unknown> | unknown[] = target;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (part === '__proto__' || part === 'constructor' || part === 'prototype') throw unsafeKey(part);
    let key: string | number = part;
    if (Array.isArray(node)) {
      if (!/^\d+$/.test(part)) throw `Cannot create field '${part}' in element {${parts[i - 1]}: ${JSON.stringify(node)}}`;
      key = Number(part);
      while (node.length < key) node.push(null);
    }
    const holder = node as Record<string | number, unknown>;
    if (i === parts.length - 1) {
      holder[key] = value;
      return;
    }
    const next = holder[key];
    if (next === undefined) holder[key] = {};
    else if ((!isPlainObject(next) && !Array.isArray(next)) || isEjsonWrapper(next)) {
      throw `Cannot create field '${parts[i + 1]}' in element {${part}: ${JSON.stringify(next)}}`;
    }
    node = holder[key] as Record<string, unknown> | unknown[];
  }
}

/**
 * Remove a dotted path the way `$unset` does. A numeric part indexes into an
 * array, and unsetting an array element leaves null in its place, since MongoDB
 * keeps the array's length. A path that isn't there changes nothing.
 */
function deletePath(target: Doc, path: string): void {
  const parts = path.split('.');
  let node: unknown = target;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (part === '__proto__' || part === 'constructor' || part === 'prototype') throw unsafeKey(part);
    const last = i === parts.length - 1;
    if (Array.isArray(node)) {
      if (!/^\d+$/.test(part) || Number(part) >= node.length) return;
      if (last) {
        node[Number(part)] = null;
        return;
      }
      node = node[Number(part)];
    } else if (isPlainObject(node) && !isEjsonWrapper(node) && Object.prototype.hasOwnProperty.call(node, part)) {
      if (last) {
        delete node[part];
        return;
      }
      node = node[part];
    } else {
      return;
    }
  }
}

const PUSH_MODIFIERS = new Set(['$each', '$position', '$slice', '$sort']);

/**
 * The array a `$push` leaves. A plain value is appended. With `$each` its values
 * go in at `$position` (counted from the end when negative), then the whole
 * array is sorted by `$sort` and cut to `$slice` (the last ones when negative),
 * in that order, as MongoDB applies the modifiers.
 */
function pushed(current: unknown[], value: unknown): unknown[] {
  if (!isPlainObject(value) || !('$each' in value)) {
    if (isOperatorObject(value)) unsupported(`$push of ${JSON.stringify(value)} without $each`);
    return [...current, value];
  }
  for (const key of Object.keys(value)) {
    if (!PUSH_MODIFIERS.has(key)) throw `Unrecognized clause in $push: ${key}`;
  }
  const each = value.$each;
  if (!Array.isArray(each)) throw `The argument to $each in $push must be an array but it was of type: ${bsonType(each)}`;
  const isInteger = (raw: unknown) =>
    ['int', 'long', 'double'].includes(bsonType(raw)) && Number.isInteger(Number(comparable(raw)));

  let out = [...current];
  let at = out.length;
  if (value.$position !== undefined) {
    if (!isInteger(value.$position)) throw `The value for $position must be an integer value, not of type: ${bsonType(value.$position)}`;
    const position = Number(comparable(value.$position));
    at = position < 0 ? Math.max(0, out.length + position) : Math.min(position, out.length);
  }
  out.splice(at, 0, ...structuredClone(each));
  if (value.$sort !== undefined) {
    const sort = value.$sort;
    if (sort === 1 || sort === -1) {
      const direction = Number(sort);
      out.sort((a, b) => direction * compareValues(a, b));
    } else if (isPlainObject(sort) && Object.keys(sort).length > 0 && Object.values(sort).every((d) => d === 1 || d === -1)) {
      out = sortDocs(out as Doc[], sort);
    } else {
      throw 'The $sort is invalid: use 1/-1 to sort the whole element, or {field:1/-1} to sort embedded fields';
    }
  }
  if (value.$slice !== undefined) {
    if (!isInteger(value.$slice)) throw `The value for $slice must be an integer value but was given type: ${bsonType(value.$slice)}`;
    const slice = Number(comparable(value.$slice));
    out = slice < 0 ? out.slice(Math.max(0, out.length + slice)) : out.slice(0, slice);
  }
  return out;
}

/**
 * Copy what a dotted path selects from `source` into `out`, the way an
 * inclusion projection does. An array on the way stays an array: each embedded
 * document in it keeps what the rest of the path selects, and other elements
 * drop out.
 */
export function includePath(out: Record<string, unknown>, source: unknown, path: string): void {
  const [head, ...rest] = path.split('.');
  if (head === '__proto__' || head === 'constructor' || head === 'prototype') throw unsafeKey(head);
  if (!isPlainObject(source) || isEjsonWrapper(source) || !Object.prototype.hasOwnProperty.call(source, head)) return;
  const value = source[head];
  if (rest.length === 0) {
    out[head] = structuredClone(value);
  } else if (Array.isArray(value)) {
    const elements = value.filter((element) => isPlainObject(element) && !isEjsonWrapper(element));
    const previous = Array.isArray(out[head]) ? (out[head] as unknown[]) : [];
    out[head] = elements.map((element, i) => {
      const target = isPlainObject(previous[i]) ? previous[i] : {};
      includePath(target, element, rest.join('.'));
      return target;
    });
  } else if (isPlainObject(value) && !isEjsonWrapper(value)) {
    const target = isPlainObject(out[head]) ? out[head] : {};
    includePath(target, value, rest.join('.'));
    out[head] = target;
  }
}

/** `"$field"` → that field's value; anything else is a literal. */
function evaluate(doc: Doc, expression: unknown): unknown {
  if (typeof expression === 'string' && expression.startsWith('$')) return valuesAt(doc, expression.slice(1))[0] ?? null;
  if (isOperatorObject(expression)) return unsupported(`expression operator ${Object.keys(expression)[0]}`);
  return expression;
}

/**
 * Remove what a dotted path selects, the way an exclusion projection does. An
 * array on the way has the rest of the path removed from each embedded
 * document in it.
 */
function excludePath(target: unknown, path: string): void {
  if (Array.isArray(target)) {
    for (const element of target) excludePath(element, path);
    return;
  }
  const [head, ...rest] = path.split('.');
  if (head === '__proto__' || head === 'constructor' || head === 'prototype') throw unsafeKey(head);
  if (!isPlainObject(target) || isEjsonWrapper(target) || !Object.prototype.hasOwnProperty.call(target, head)) return;
  if (rest.length === 0) delete target[head];
  else excludePath(target[head], rest.join('.'));
}

export function project(doc: Doc, spec: Record<string, unknown>): Doc {
  const entries = Object.entries(spec);
  if (entries.length === 0) return doc;
  const isInclude = (value: unknown) => value === 1 || value === true;
  const isExclude = (value: unknown) => value === 0 || value === false;
  const shaping = entries.filter(([key, value]) => key !== '_id' && !isExclude(value));
  // Only _id may be excluded from a projection that includes or computes fields.
  const excluded = entries.find(([key, value]) => key !== '_id' && isExclude(value));
  if (shaping.length > 0 && excluded) throw `Cannot do exclusion on field ${excluded[0]} in inclusion projection`;
  if (shaping.length > 0) {
    const out: Doc = {};
    if (!isExclude(spec._id) && '_id' in doc) out._id = doc._id;
    for (const [path, value] of shaping) {
      if (isInclude(value)) includePath(out, doc, path);
      else addFieldPath(out, path.split('.'), evaluate(doc, value));
    }
    return out;
  }
  const out = structuredClone(doc);
  for (const [path, value] of entries) if (isExclude(value)) excludePath(out, path);
  return out;
}

export interface FindOptions {
  filter?: Doc;
  sort?: Record<string, unknown>;
  projection?: Record<string, unknown>;
  skip?: number;
  limit?: number;
}

export function find(docs: Doc[], { filter = {}, sort = {}, projection = {}, skip = 0, limit = 0 }: FindOptions): Doc[] {
  let out = sortDocs(docs.filter((doc) => matches(doc, filter)), sort);
  if (skip > 0) out = out.slice(skip);
  if (limit > 0) out = out.slice(0, limit);
  return out.map((doc) => project(doc, projection));
}

/**
 * The sample server's filter (`execute_mock_query` in src-tauri/src/mock_db.rs):
 * each top-level field must equal the filter's value exactly, so an operator
 * such as `{ $gt: 1 }` matches nothing.
 */
export function mockMatches(doc: Doc, filter: Doc): boolean {
  return Object.entries(filter).every(([key, value]) => key in doc && jsonEqual(doc[key], value));
}

/**
 * A query on the sample server, as `execute_mock_query` runs it: exact
 * top-level matching, a sort on each key in turn (numbers by value, anything
 * else by its JSON text), no projection, and a limit of 100 when none is given
 * and never more than 1000.
 */
export function mockFind(docs: Doc[], { filter = {}, sort = {}, skip = 0, limit = 0 }: FindOptions): Doc[] {
  let out = docs.filter((doc) => mockMatches(doc, filter));
  for (const [key, direction] of Object.entries(sort)) {
    const descending = Number(direction) === -1;
    out = [...out].sort((a, b) => {
      let order: number;
      if (!(key in a) || !(key in b)) order = Number(key in a) - Number(key in b);
      else if (typeof a[key] === 'number' && typeof b[key] === 'number') order = (a[key] as number) - (b[key] as number);
      else {
        const [left, right] = [JSON.stringify(a[key]), JSON.stringify(b[key])];
        order = left < right ? -1 : left > right ? 1 : 0;
      }
      return descending ? -order : order;
    });
  }
  const start = Math.min(Math.max(skip, 0), out.length);
  const size = limit <= 0 ? 100 : Math.min(limit, 1000);
  return out.slice(start, start + size);
}

function group(docs: Doc[], spec: Record<string, unknown>): Doc[] {
  const groups: Array<{ id: unknown; docs: Doc[] }> = [];
  for (const doc of docs) {
    const id = isPlainObject(spec._id) && !isEjsonWrapper(spec._id)
      ? Object.fromEntries(Object.entries(spec._id).map(([key, expr]) => [key, evaluate(doc, expr)]))
      : evaluate(doc, spec._id ?? null);
    // Group keys compare as BSON values, so 1 and { $numberLong: "1" } share a group, keyed by the first.
    let bucket = groups.find((candidate) => bsonEqual(candidate.id, id));
    if (!bucket) {
      bucket = { id, docs: [] };
      groups.push(bucket);
    }
    bucket.docs.push(doc);
  }
  return groups.map(({ id, docs: members }) => {
    const out: Doc = { _id: id };
    for (const [field, accumulator] of Object.entries(spec)) {
      if (field === '_id') continue;
      const [op, expr] = Object.entries(accumulator as Doc)[0] ?? [];
      const values = members.map((member) => evaluate(member, expr));
      switch (op) {
        // $sum and $avg take only numeric values, ignore every other type, and keep BSON's numeric types and precision.
        case '$sum': out[field] = sumNumbers(values); break;
        case '$avg': out[field] = averageNumbers(values); break;
        case '$min': out[field] = [...values].sort(compareValues)[0] ?? null; break;
        case '$max': out[field] = [...values].sort(compareValues).at(-1) ?? null; break;
        case '$first': out[field] = values[0] ?? null; break;
        case '$last': out[field] = values.at(-1) ?? null; break;
        case '$push': out[field] = values; break;
        case '$addToSet': out[field] = values.filter((value, i) => values.findIndex((other) => valuesEqual(other, value)) === i); break;
        case '$count': out[field] = members.length; break;
        default: unsupported(`group accumulator ${op}`);
      }
    }
    return out;
  });
}

function unwind(docs: Doc[], spec: unknown): Doc[] {
  const path = String(isPlainObject(spec) ? spec.path : spec).replace(/^\$/, '');
  const keepEmpty = isPlainObject(spec) && spec.preserveNullAndEmptyArrays === true;
  return docs.flatMap((doc) => {
    const value = valuesAt(doc, path)[0];
    // A missing, null or empty value drops the document unless it's asked to be
    // kept; any other value that isn't an array unwinds as itself.
    if (value === undefined || value === null || (Array.isArray(value) && value.length === 0)) return keepEmpty ? [doc] : [];
    if (!Array.isArray(value)) return [doc];
    return value.map((element) => {
      const copy = structuredClone(doc);
      setPath(copy, path, element);
      return copy;
    });
  });
}

export function aggregate(docs: Doc[], pipeline: Doc[]): Doc[] {
  let out = docs.map((doc) => structuredClone(doc));
  for (const stage of pipeline) {
    const [name, arg] = Object.entries(stage)[0] ?? [];
    switch (name) {
      case '$match': out = out.filter((doc) => matches(doc, arg as Doc)); break;
      case '$sort': out = sortDocs(out, arg as Doc); break;
      case '$skip': {
        const count = Number(arg);
        if (!Number.isInteger(count) || count < 0) throw 'invalid argument to $skip stage: Expected a non-negative number';
        out = out.slice(count);
        break;
      }
      case '$limit': {
        const count = Number(arg);
        if (!Number.isInteger(count) || count <= 0) throw 'the limit must be positive';
        out = out.slice(0, count);
        break;
      }
      case '$project': out = out.map((doc) => project(doc, arg as Doc)); break;
      // With no documents coming in, $count emits none rather than a zero.
      case '$count': out = out.length === 0 ? [] : [{ [String(arg)]: out.length }]; break;
      case '$group': out = group(out, arg as Doc); break;
      case '$unwind': out = unwind(out, arg); break;
      case '$addFields':
      case '$set':
        out = out.map((doc) => {
          const copy = structuredClone(doc);
          for (const [path, expr] of Object.entries(arg as Doc)) addFieldPath(copy, path.split('.'), evaluate(doc, expr));
          return copy;
        });
        break;
      default:
        unsupported(`pipeline stage ${name}`);
    }
  }
  return out;
}

/** Apply an update document (`$set`, `$unset`, `$inc`, `$push`) or a whole replacement. */
export function applyUpdate(doc: Doc, update: Doc): Doc {
  const operators = Object.keys(update).filter((key) => key.startsWith('$'));
  if (operators.length === 0) return { _id: doc._id, ...update };
  const out = structuredClone(doc);
  for (const [op, fields] of Object.entries(update)) {
    for (const [path, value] of Object.entries(fields as Doc)) {
      switch (op) {
        case '$set': updatePath(out, path, value); break;
        case '$unset': deletePath(out, path); break;
        case '$inc': {
          // MongoDB increments only a number by a number, or sets a missing field to the increment.
          const numeric = (candidate: unknown) => ['int', 'long', 'double', 'decimal'].includes(bsonType(candidate));
          if (!numeric(value)) throw `Cannot increment with non-numeric argument: {${path}: ${JSON.stringify(value)}}`;
          const current = valuesAt(out, path)[0];
          if (current !== undefined && !numeric(current)) {
            throw `Cannot apply $inc to a value of non-numeric type. {_id: ${JSON.stringify(doc._id)}} has the field '${path}' of non-numeric type ${bsonType(current)}`;
          }
          if (current === undefined) {
            updatePath(out, path, structuredClone(value));
            break;
          }
          const had = readNumeric(current);
          const by = readNumeric(value);
          if (!had || !by) return unsupported(`$inc of ${JSON.stringify(current)} by ${JSON.stringify(value)}`);
          // The sum keeps BSON's numeric types and precision: an int widens to a long, and a long that overflows fails.
          const sum = addNumeric(had, by);
          if (!sum) {
            throw `Failed to apply $inc operations to current value ((NumberLong)${String(had.value)}) for document {_id: ${JSON.stringify(doc._id)}}`;
          }
          updatePath(out, path, numericValue(sum));
          break;
        }
        case '$push': {
          const current = valuesAt(out, path)[0];
          // MongoDB refuses to push onto a field that holds anything but an array.
          if (current !== undefined && !Array.isArray(current)) {
            throw `The field '${path}' must be an array but is of type ${bsonType(current)} in document {_id: ${JSON.stringify(doc._id)}}`;
          }
          updatePath(out, path, pushed(Array.isArray(current) ? current : [], value));
          break;
        }
        default: unsupported(`update operator ${op}`);
      }
    }
  }
  return out;
}

const MAX_ENUM_VALUES = 25;

/** Where the schema report's type names (`bson_type_label` in src-tauri/src/db/schema.rs) differ from `$type`'s. */
const SCHEMA_TYPE_NAMES: Record<string, string> = { binData: 'binary', javascriptWithScope: 'javascript' };

/**
 * A value's text for enum detection, as `enum_scalar` gives it: strings,
 * numbers and booleans have one. Null has none (`null`) and leaves the field's
 * enum alone; anything else, such as an object, array, ObjectId or date, rules
 * the field out (`false`).
 */
function enumText(value: unknown): string | null | false {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (isPlainObject(value)) {
    for (const key of ['$numberInt', '$numberLong', '$numberDouble']) if (key in value) return String(Number(value[key]));
  }
  return false;
}

/**
 * The report `analyze_schema` returns, shaped like src-tauri/src/db/schema.rs:
 * each dotted field path with the BSON types seen at it, how many sampled
 * documents contain it (`presence`), and that as a fraction (`coverage`). A
 * field whose values are all strings, numbers or booleans, with no more than 25
 * distinct ones, also lists them as sorted text (`enumValues`).
 */
export function inferSchema(docs: Doc[], sampleSize: number) {
  const sample = docs.slice(0, sampleSize > 0 ? sampleSize : docs.length);
  const stats = new Map<string, Map<string, number>>();
  const presence = new Map<string, number>();
  const enumTexts = new Map<string, Set<string>>();
  const notEnum = new Set<string>();
  const ruleOut = (path: string) => {
    notEnum.add(path);
    enumTexts.delete(path);
  };
  for (const doc of sample) {
    const seen = new Set<string>();
    const visit = (value: unknown, path: string) => {
      const type = SCHEMA_TYPE_NAMES[bsonType(value)] ?? bsonType(value);
      const types = stats.get(path) ?? new Map<string, number>();
      types.set(type, (types.get(type) ?? 0) + 1);
      stats.set(path, types);
      seen.add(path);
      if (!notEnum.has(path)) {
        const text = enumText(value);
        if (text === false) ruleOut(path);
        else if (text !== null) {
          const texts = enumTexts.get(path) ?? new Set<string>();
          texts.add(text);
          if (texts.size > MAX_ENUM_VALUES) ruleOut(path);
          else enumTexts.set(path, texts);
        }
      }
      if (type === 'object') for (const [key, child] of Object.entries(value as Doc)) visit(child, `${path}.${key}`);
    };
    for (const [key, value] of Object.entries(doc)) visit(value, key);
    for (const path of seen) presence.set(path, (presence.get(path) ?? 0) + 1);
  }
  return {
    sampled: sample.length,
    fields: [...stats.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, types]) => {
        const present = presence.get(path) ?? 0;
        const texts = enumTexts.get(path);
        return {
          path,
          types: [...types.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count),
          presence: present,
          coverage: sample.length === 0 ? 0 : present / sample.length,
          ...(texts && texts.size > 0 ? { enumValues: [...texts].sort() } : {}),
        };
      }),
  };
}

let objectIdCounter = 0;
/** A fresh, valid ObjectId hex string. */
export function newObjectId(): string {
  objectIdCounter += 1;
  const time = Math.floor(Date.now() / 1000).toString(16).padStart(8, '0');
  return `${time}e2e0${objectIdCounter.toString(16).padStart(12, '0')}`.slice(0, 24);
}
