// An index is its document, as listIndexes gives it: what the modal edits,
// createIndexes takes back and a rebuild restores.
import type { IndexInfo } from '@/components/Sidebar';
import type { CurrentOp, OpId } from './monitoringApi';

export type IndexKeyType = 1 | -1 | 'text' | '2dsphere' | '2d' | 'hashed';
export type IndexDocument = Record<string, unknown> & { key: Record<string, unknown>; name: string };
export type IndexKind = 'regular' | 'compound' | 'text' | '2dsphere' | '2d' | 'hashed' | 'wildcard';

/** What is wrong with an index, as a key under `indexModal.errors`. */
export interface IndexProblem {
  key: string;
  params?: Record<string, string>;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const parseObject = (json: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(json);
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

/** The whole document, or as much of it as the fields hold where a server
 *  before API version 5 sent none. */
export const specOf = (info: IndexInfo): IndexDocument => {
  const listed = parseObject(info.spec ?? '');
  if (isObject(listed.key)) return listed as IndexDocument;
  return {
    key: parseObject(info.keys),
    name: info.name,
    ...(info.unique && { unique: true }),
    ...(info.sparse && { sparse: true }),
    ...(info.expireAfterSeconds !== undefined && { expireAfterSeconds: info.expireAfterSeconds }),
    ...(info.hidden && { hidden: true }),
    ...(info.partialFilterExpression !== undefined && {
      partialFilterExpression: parseObject(info.partialFilterExpression),
    }),
  };
};

/** Whether a rebuild can keep the index. Without its document, only plain
 *  keys say all there is to know: a special index may hold options nothing
 *  listed, and could not be put back if the rebuild failed. */
export const isEditable = (info: IndexInfo): boolean =>
  info.spec !== undefined || ['regular', 'compound'].includes(indexKind(parseObject(info.keys)));

/** The keys as they were written: MongoDB lists a text index as `_fts` and
 *  `_ftsx`, with its fields in `weights`. */
export const displayKeys = (spec: IndexDocument): Record<string, unknown> => {
  if (!('_fts' in spec.key) || !isObject(spec.weights)) return spec.key;
  const fields = Object.keys(spec.weights);
  return Object.fromEntries(
    Object.entries(spec.key).flatMap(([field, value]): [string, unknown][] => {
      if (field === '_fts') return fields.map((name) => [name, 'text']);
      return field === '_ftsx' ? [] : [[field, value]];
    })
  );
};

export const indexKind = (keys: Record<string, unknown>): IndexKind => {
  const fields = Object.keys(keys);
  const values = Object.values(keys);
  if (values.includes('text')) return 'text';
  if (values.includes('2dsphere')) return '2dsphere';
  if (values.includes('2d')) return '2d';
  if (values.includes('hashed')) return 'hashed';
  if (fields.some((f) => f === '$**' || f.endsWith('.$**'))) return 'wildcard';
  return fields.length > 1 ? 'compound' : 'regular';
};

const PARTIAL_OPERATORS = new Set(['$eq', '$exists', '$gt', '$gte', '$lt', '$lte', '$type', '$in']);
// Extended JSON type wrappers: a value, not an operator.
const EJSON_TYPES = new Set([
  '$binary', '$date', '$maxKey', '$minKey', '$numberDecimal', '$numberDouble', '$numberInt',
  '$numberLong', '$oid', '$regularExpression', '$timestamp', '$uuid',
]);

const partialProblem = (filter: Record<string, unknown>): IndexProblem | null => {
  for (const [field, value] of Object.entries(filter)) {
    if (field === '$and' || field === '$or') {
      const clauses = Array.isArray(value) ? value.filter(isObject) : [];
      const problem = clauses.map(partialProblem).find(Boolean);
      if (problem) return problem;
    } else if (field.startsWith('$')) {
      return { key: 'partialOperator', params: { operator: field } };
    } else if (isObject(value)) {
      for (const [operator, operand] of Object.entries(value)) {
        if (!operator.startsWith('$') || EJSON_TYPES.has(operator)) continue;
        if (!PARTIAL_OPERATORS.has(operator)) return { key: 'partialOperator', params: { operator } };
        if (operator === '$exists' && !operand) return { key: 'partialExistsFalse' };
      }
    }
  }
  return null;
};

/** MongoDB's rules, for what is worth stopping before a rebuild drops anything
 *  or where its own message would mislead. The server has the last word. */
export const validateIndex = (spec: IndexDocument): IndexProblem | null => {
  const values = Object.values(spec.key);
  const wildcard = indexKind(spec.key) === 'wildcard';
  if (isObject(spec.partialFilterExpression)) {
    if (spec.sparse) return { key: 'partialWithSparse' };
    const problem = partialProblem(spec.partialFilterExpression);
    if (problem) return problem;
  }
  if (values.filter((v) => v === 'hashed').length > 1) return { key: 'hashedOneField' };
  if (values.includes('hashed') && spec.unique) return { key: 'hashedUnique' };
  if (wildcard && spec.unique) return { key: 'wildcardUnique' };
  if (wildcard && spec.sparse) return { key: 'wildcardSparse' };
  if (wildcard && spec.expireAfterSeconds !== undefined) return { key: 'wildcardTtl' };
  if (spec.wildcardProjection !== undefined && !('$**' in spec.key)) {
    return { key: 'wildcardProjectionNeedsAllFields' };
  }
  if (wildcard && '$**' in spec.key && values.length > 1 && spec.wildcardProjection === undefined) {
    return { key: 'compoundWildcardNeedsProjection' };
  }
  if (spec.collation !== undefined && (values.includes('text') || values.includes('2d'))) {
    return { key: 'collationNotSupported' };
  }
  return null;
};

/** The options the modal has a text field for. */
export type OptionField =
  | 'partialFilterExpression' | 'collation' | 'storageEngine' | 'weights' | 'defaultLanguage'
  | 'languageOverride' | 'textIndexVersion' | 'sphereIndexVersion' | 'bits' | 'min' | 'max'
  | 'wildcardProjection';

export interface IndexForm extends Record<OptionField, string> {
  name: string;
  keys: Record<string, unknown>;
  unique: boolean;
  sparse: boolean;
  hidden: boolean;
  ttlSeconds: number | null;
}

interface OptionDefinition {
  option: string;
  field: OptionField;
  parse: 'json' | 'text' | 'number' | 'integer';
  /** Only with a key of this type. */
  needs?: IndexKeyType | 'wildcard';
}

export const INDEX_OPTIONS: OptionDefinition[] = [
  { option: 'partialFilterExpression', field: 'partialFilterExpression', parse: 'json' },
  { option: 'collation', field: 'collation', parse: 'json' },
  { option: 'storageEngine', field: 'storageEngine', parse: 'json' },
  { option: 'weights', field: 'weights', parse: 'json', needs: 'text' },
  { option: 'default_language', field: 'defaultLanguage', parse: 'text', needs: 'text' },
  { option: 'language_override', field: 'languageOverride', parse: 'text', needs: 'text' },
  { option: 'textIndexVersion', field: 'textIndexVersion', parse: 'integer', needs: 'text' },
  { option: '2dsphereIndexVersion', field: 'sphereIndexVersion', parse: 'integer', needs: '2dsphere' },
  { option: 'bits', field: 'bits', parse: 'integer', needs: '2d' },
  { option: 'min', field: 'min', parse: 'number', needs: '2d' },
  { option: 'max', field: 'max', parse: 'number', needs: '2d' },
  { option: 'wildcardProjection', field: 'wildcardProjection', parse: 'json', needs: 'wildcard' },
];

export const emptyIndexForm = (): IndexForm => ({
  name: '', keys: {}, unique: false, sparse: false, hidden: false, ttlSeconds: null,
  partialFilterExpression: '', collation: '', storageEngine: '', weights: '', defaultLanguage: '',
  languageOverride: '', textIndexVersion: '', sphereIndexVersion: '', bits: '', min: '', max: '',
  wildcardProjection: '',
});

export const formFromSpec = (spec: IndexDocument): IndexForm => {
  const form: IndexForm = {
    ...emptyIndexForm(),
    name: spec.name,
    keys: displayKeys(spec),
    unique: Boolean(spec.unique),
    sparse: Boolean(spec.sparse),
    hidden: Boolean(spec.hidden),
    ttlSeconds: typeof spec.expireAfterSeconds === 'number' ? spec.expireAfterSeconds : null,
  };
  for (const { option, field, parse } of INDEX_OPTIONS) {
    const value = spec[option];
    if (value !== undefined) form[field] = parse === 'json' ? JSON.stringify(value, null, 2) : String(value);
  }
  return form;
};

export const appliesTo = (needs: OptionDefinition['needs'], keys: Record<string, unknown>): boolean =>
  needs === undefined ||
  (needs === 'wildcard' ? indexKind(keys) === 'wildcard' : Object.values(keys).includes(needs));

const parseOption = (parse: OptionDefinition['parse'], text: string): unknown => {
  if (parse === 'text') return text;
  if (parse === 'json') {
    try {
      const value = JSON.parse(text);
      return isObject(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }
  const value = Number(text);
  return Number.isFinite(value) && (parse === 'number' || Number.isInteger(value)) ? value : undefined;
};

/** The document without what the server sets for itself and sets again. */
export const withoutServerFields = (spec: IndexDocument): IndexDocument => {
  const { v: _v, ns: _ns, ...rest } = spec;
  return rest as IndexDocument;
};

/** The document the form describes. It starts from `base`, the index being
 *  edited, so an option the form has no field for survives. */
export const specFromForm = (
  form: IndexForm,
  base?: IndexDocument
): { spec: IndexDocument; problem?: undefined } | { spec?: undefined; problem: IndexProblem } => {
  const spec: IndexDocument = { ...(base && withoutServerFields(base)), key: form.keys, name: form.name };
  for (const field of ['unique', 'sparse', 'hidden', 'expireAfterSeconds', ...INDEX_OPTIONS.map((o) => o.option)]) {
    delete spec[field];
  }
  if (form.unique) spec.unique = true;
  if (form.sparse) spec.sparse = true;
  if (form.hidden) spec.hidden = true;
  if (form.ttlSeconds !== null) spec.expireAfterSeconds = form.ttlSeconds;
  for (const { option, field, parse, needs } of INDEX_OPTIONS) {
    const text = form[field].trim();
    if (!text || !appliesTo(needs, form.keys)) continue;
    const value = parseOption(parse, text);
    if (value === undefined) {
      return { problem: { key: parse === 'json' ? 'optionNotJson' : 'optionNotNumber', params: { option } } };
    }
    spec[option] = value;
  }
  const problem = validateIndex(spec);
  return problem ? { problem } : { spec };
};

export type IndexEdit =
  | { command: 'set_index_expiry'; args: { expireAfterSeconds: number } }
  | { command: 'set_index_option'; args: { option: 'hidden'; value: boolean } };

// Compared as MongoDB would see them: what it sets itself, or leaves false, is no change.
const comparable = (spec: IndexDocument): Record<string, unknown> => ({
  ...Object.fromEntries(Object.entries(spec).filter(([field, value]) => field !== 'v' && field !== 'ns' && value !== false)),
  key: displayKeys(spec),
});

/** The `collMod`s that take an index from `before` to `after`, or null when
 *  only a rebuild can. */
export const inPlaceEdits = (before: IndexDocument, after: IndexDocument): IndexEdit[] | null => {
  const a = comparable(before);
  const b = comparable(after);
  for (const field of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (field === 'hidden' || field === 'expireAfterSeconds') continue;
    if (JSON.stringify(a[field]) !== JSON.stringify(b[field])) return null;
  }
  const edits: IndexEdit[] = [];
  if (a.expireAfterSeconds !== b.expireAfterSeconds) {
    if (typeof a.expireAfterSeconds !== 'number' || typeof b.expireAfterSeconds !== 'number') return null;
    edits.push({ command: 'set_index_expiry', args: { expireAfterSeconds: b.expireAfterSeconds } });
  }
  if (Boolean(a.hidden) !== Boolean(b.hidden)) {
    edits.push({ command: 'set_index_option', args: { option: 'hidden', value: Boolean(b.hidden) } });
  }
  return edits;
};

/** What a server before API version 5 can create. */
export const isPlainIndex = (spec: IndexDocument): boolean =>
  Object.keys(spec).every((field) => ['key', 'name', 'unique', 'sparse'].includes(field));

export interface IndexBuild {
  opid: OpId;
  names: string[];
  secsRunning: number;
  /** Null where the operation has no progress, as on a server connection. */
  percent: number | null;
}

/** The index builds running on `ns`. MongoDB runs each on a coordinator
 *  operation, beside the client's own `createIndexes` waiting on it. */
export const indexBuilds = (ops: CurrentOp[], ns: string): IndexBuild[] =>
  ops
    .filter((op) => op.ns === ns && op.desc.startsWith('IndexBuildsCoordinator'))
    .map((op) => ({
      opid: op.opid,
      // ponytail: read from the command's text, the only form a server connection
      // has, so a partial filter on a string field called "name" shows up as a name.
      names: [...op.command.matchAll(/"name"\s*:\s*"([^"]+)"/g)].map((match) => match[1]),
      secsRunning: op.secsRunning,
      percent: op.progress && op.progress.total > 0 ? Math.round((op.progress.done / op.progress.total) * 100) : null,
    }));
