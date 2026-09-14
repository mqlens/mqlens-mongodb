// In-memory stand-in for the MongoDB operations the backend runs (#396).
//
// It covers the query and aggregation features the app's UI can produce. An
// operator or stage it doesn't implement is rejected with a clear message
// rather than ignored, so a test can't pass on a silently wrong result.
import type { Doc } from './seed';

const EJSON_WRAPPERS = new Set([
  '$oid', '$date', '$numberInt', '$numberLong', '$numberDouble', '$numberDecimal',
  '$binary', '$uuid', '$regularExpression', '$timestamp', '$minKey', '$maxKey', '$symbol', '$code',
]);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isEjsonWrapper = (value: unknown): boolean =>
  isPlainObject(value) && Object.keys(value).some((key) => EJSON_WRAPPERS.has(key));

const unsupported = (what: string): never => {
  throw `Unsupported ${what} in the e2e fake backend`;
};

/** A value with its Extended JSON wrapper removed, so it compares like the BSON value. */
export function comparable(value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  if ('$oid' in value) return String(value.$oid);
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

/** BSON's cross-type sort order, reduced to the types the app's data uses. */
function typeRank(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return 1;
  if (typeof value === 'string') return 2;
  if (Array.isArray(value)) return 4;
  if (typeof value === 'object') return 3;
  if (typeof value === 'boolean') return 5;
  return 6;
}

export function compareValues(a: unknown, b: unknown): number {
  const x = comparable(a);
  const y = comparable(b);
  const rank = typeRank(x) - typeRank(y);
  if (rank !== 0) return rank;
  if (typeof x === 'number' && typeof y === 'number') return x - y;
  if (typeof x === 'boolean' && typeof y === 'boolean') return Number(x) - Number(y);
  const left = typeof x === 'string' ? x : JSON.stringify(x);
  const right = typeof y === 'string' ? y : JSON.stringify(y);
  return left < right ? -1 : left > right ? 1 : 0;
}

const sameType = (a: unknown, b: unknown) => typeRank(comparable(a)) === typeRank(comparable(b));
const valuesEqual = (a: unknown, b: unknown) => sameType(a, b) && compareValues(a, b) === 0;

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

function bsonType(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'double';
  if (isPlainObject(value)) {
    if ('$oid' in value) return 'objectId';
    if ('$date' in value) return 'date';
    if ('$numberLong' in value) return 'long';
    if ('$numberDecimal' in value) return 'decimal';
    if ('$numberDouble' in value) return 'double';
    if ('$numberInt' in value) return 'int';
    return 'object';
  }
  return typeof value;
}

const isOperatorObject = (value: unknown): value is Record<string, unknown> =>
  isPlainObject(value) &&
  Object.keys(value).length > 0 &&
  !isEjsonWrapper(value) &&
  Object.keys(value).every((key) => key.startsWith('$'));

function fieldMatches(values: unknown[], condition: unknown): boolean {
  if (isPlainObject(condition) && '$regularExpression' in condition) {
    const re = regexFrom(condition, undefined);
    return values.some((value) => typeof value === 'string' && re.test(value));
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
        return values.some((value) => typeof value === 'string' && re.test(value));
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
      case '$type':
        return values.some((value) => (Array.isArray(arg) ? arg : [arg]).includes(bsonType(value)));
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

export function sortDocs(docs: Doc[], spec: Record<string, unknown>): Doc[] {
  const keys = Object.entries(spec);
  if (keys.length === 0) return docs;
  return [...docs].sort((a, b) => {
    for (const [path, direction] of keys) {
      const order = compareValues(valuesAt(a, path)[0] ?? null, valuesAt(b, path)[0] ?? null);
      if (order !== 0) return Number(direction) < 0 ? -order : order;
    }
    return 0;
  });
}

function setPath(target: Doc, path: string, value: unknown): void {
  const parts = path.split('.');
  let node: Record<string, unknown> = target;
  for (const part of parts.slice(0, -1)) {
    if (!isPlainObject(node[part])) node[part] = {};
    node = node[part] as Record<string, unknown>;
  }
  node[parts[parts.length - 1]] = value;
}

function deletePath(target: Doc, path: string): void {
  const parts = path.split('.');
  let node: unknown = target;
  for (const part of parts.slice(0, -1)) {
    if (!isPlainObject(node)) return;
    node = node[part];
  }
  if (isPlainObject(node)) delete node[parts[parts.length - 1]];
}

/** `"$field"` → that field's value; anything else is a literal. */
function evaluate(doc: Doc, expression: unknown): unknown {
  if (typeof expression === 'string' && expression.startsWith('$')) return valuesAt(doc, expression.slice(1))[0] ?? null;
  if (isOperatorObject(expression)) return unsupported(`expression operator ${Object.keys(expression)[0]}`);
  return expression;
}

export function project(doc: Doc, spec: Record<string, unknown>): Doc {
  const entries = Object.entries(spec);
  if (entries.length === 0) return doc;
  const isInclude = (value: unknown) => value === 1 || value === true;
  const isExclude = (value: unknown) => value === 0 || value === false;
  const shaping = entries.filter(([key, value]) => key !== '_id' && !isExclude(value));
  if (shaping.length > 0) {
    const out: Doc = {};
    if (!isExclude(spec._id) && '_id' in doc) out._id = doc._id;
    for (const [path, value] of shaping) {
      if (isInclude(value)) {
        const found = valuesAt(doc, path);
        if (found.length > 0) setPath(out, path, found[0]);
      } else {
        setPath(out, path, evaluate(doc, value));
      }
    }
    return out;
  }
  const out = structuredClone(doc);
  for (const [path, value] of entries) if (isExclude(value)) deletePath(out, path);
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

function group(docs: Doc[], spec: Record<string, unknown>): Doc[] {
  const groups = new Map<string, { id: unknown; docs: Doc[] }>();
  for (const doc of docs) {
    const id = isPlainObject(spec._id) && !isEjsonWrapper(spec._id)
      ? Object.fromEntries(Object.entries(spec._id).map(([key, expr]) => [key, evaluate(doc, expr)]))
      : evaluate(doc, spec._id ?? null);
    const key = JSON.stringify(id);
    const bucket = groups.get(key) ?? { id, docs: [] };
    bucket.docs.push(doc);
    groups.set(key, bucket);
  }
  return [...groups.values()].map(({ id, docs: members }) => {
    const out: Doc = { _id: id };
    for (const [field, accumulator] of Object.entries(spec)) {
      if (field === '_id') continue;
      const [op, expr] = Object.entries(accumulator as Doc)[0] ?? [];
      const values = members.map((member) => evaluate(member, expr));
      const numbers = values.map((value) => Number(comparable(value))).filter((n) => !Number.isNaN(n));
      switch (op) {
        case '$sum': out[field] = typeof expr === 'number' ? expr * members.length : numbers.reduce((a, b) => a + b, 0); break;
        case '$avg': out[field] = numbers.length ? numbers.reduce((a, b) => a + b, 0) / numbers.length : null; break;
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
    if (!Array.isArray(value) || value.length === 0) return keepEmpty || (value !== undefined && !Array.isArray(value)) ? [doc] : [];
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
      case '$skip': out = out.slice(Number(arg)); break;
      case '$limit': out = out.slice(0, Number(arg)); break;
      case '$project': out = out.map((doc) => project(doc, arg as Doc)); break;
      case '$count': out = [{ [String(arg)]: out.length }]; break;
      case '$group': out = group(out, arg as Doc); break;
      case '$unwind': out = unwind(out, arg); break;
      case '$addFields':
      case '$set':
        out = out.map((doc) => {
          const copy = structuredClone(doc);
          for (const [path, expr] of Object.entries(arg as Doc)) setPath(copy, path, evaluate(doc, expr));
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
        case '$set': setPath(out, path, value); break;
        case '$unset': deletePath(out, path); break;
        case '$inc': setPath(out, path, Number(comparable(valuesAt(out, path)[0] ?? 0)) + Number(comparable(value))); break;
        case '$push': {
          const current = valuesAt(out, path)[0];
          setPath(out, path, [...(Array.isArray(current) ? current : []), value]);
          break;
        }
        default: unsupported(`update operator ${op}`);
      }
    }
  }
  return out;
}

/**
 * The report `analyze_schema` returns, shaped like src-tauri/src/db/schema.rs:
 * each dotted field path with the BSON types seen at it, how many sampled
 * documents contain it (`presence`), and that as a fraction (`coverage`).
 */
export function inferSchema(docs: Doc[], sampleSize: number) {
  const sample = docs.slice(0, sampleSize > 0 ? sampleSize : docs.length);
  const stats = new Map<string, Map<string, number>>();
  const presence = new Map<string, number>();
  for (const doc of sample) {
    const seen = new Set<string>();
    const visit = (value: unknown, path: string) => {
      const type = bsonType(value);
      const types = stats.get(path) ?? new Map<string, number>();
      types.set(type, (types.get(type) ?? 0) + 1);
      stats.set(path, types);
      seen.add(path);
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
        return {
          path,
          types: [...types.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count),
          presence: present,
          coverage: sample.length === 0 ? 0 : present / sample.length,
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
