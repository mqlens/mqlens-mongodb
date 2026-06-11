export type Surface = 'filter' | 'projection' | 'sort' | 'aggStage' | 'shell';
export type CompletionKind = 'field' | 'operator' | 'stage' | 'method' | 'enum' | 'ejson';

export interface FieldSchema { type?: string; enumValues?: string[]; }

export interface CompletionCtx {
  surface: Surface;
  textBeforeCursor: string;
  token: string;
  fields: string[];
  schema?: Map<string, FieldSchema>;
  collections?: string[];   // collection names, for `db.<coll>` in the shell
}

export interface CompletionItem {
  label: string;
  kind: CompletionKind;
  insertText: string;
  detail?: string;
  // Monaco snippet syntax: `${1:placeholder}` tab stops, literal `$` escaped as `\$`.
  isSnippet?: boolean;
}

export const QUERY_OPERATORS = [
  '$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin',
  '$exists', '$regex', '$type', '$elemMatch', '$size', '$all', '$mod',
];
export const LOGICAL_OPERATORS = ['$and', '$or', '$nor', '$not'];
export const AGG_STAGES = [
  '$match', '$group', '$project', '$sort', '$limit', '$skip', '$unwind',
  '$lookup', '$addFields', '$set', '$unset', '$count', '$facet', '$sortByCount', '$replaceRoot',
];
export const GROUP_ACCUMULATORS = ['$sum', '$avg', '$min', '$max', '$first', '$last', '$push', '$addToSet', '$count'];
// Anything valid after a `.` in the shell: collection operations + cursor chain
// methods (forEach, toArray, sort, …).
export const CURSOR_METHODS = [
  // collection ops
  'find', 'findOne', 'aggregate', 'countDocuments', 'estimatedDocumentCount', 'count', 'distinct',
  'insertOne', 'insertMany', 'updateOne', 'updateMany', 'replaceOne', 'deleteOne', 'deleteMany',
  'findOneAndUpdate', 'findOneAndReplace', 'findOneAndDelete', 'bulkWrite',
  'createIndex', 'createIndexes', 'getIndexes', 'dropIndex', 'dropIndexes',
  'drop', 'renameCollection', 'stats', 'watch', 'mapReduce', 'dataSize', 'totalIndexSize',
  // cursor chain methods
  'forEach', 'toArray', 'map', 'filter', 'hasNext', 'next', 'pretty', 'sort', 'limit', 'skip',
  'size', 'itcount', 'explain', 'hint', 'batchSize', 'projection', 'allowDiskUse', 'collation', 'close',
];
// db-level methods available on `db.<here>`
export const DB_METHODS = [
  'getCollectionNames', 'getCollectionInfos', 'getCollection', 'createCollection',
  'getName', 'stats', 'runCommand', 'aggregate', 'dropDatabase', 'getMongo', 'hostInfo', 'serverStatus',
  'getSiblingDB', 'createView', 'currentOp', 'killOp', 'version',
];
// Top-level mongosh globals / helpers (when not after a dot).
export const SHELL_GLOBALS = [
  'db', 'print', 'printjson', 'ObjectId', 'ISODate', 'UUID', 'Date',
  'NumberLong', 'NumberInt', 'NumberDecimal', 'BinData', 'sleep', 'load', 'quit', 'version', 'use',
];

// Extended JSON (EJSON v2) type wrappers. `value` is the full wrapper object as
// a Monaco snippet; `key` is offered when the user has already opened the
// wrapper object themselves ({"_id": {"$oi…). The relaxed `$date` (ISO string)
// form is used because the backend's serde_json→bson path accepts it.
export interface EjsonType { key: string; detail: string; value: string; }
export const EJSON_TYPES: EjsonType[] = [
  { key: '$oid', detail: 'EJSON ObjectId', value: '{"\\$oid": "${1:objectId}"}' },
  { key: '$date', detail: 'EJSON Date (ISO-8601)', value: '{"\\$date": "${1:2024-01-01T00:00:00Z}"}' },
  { key: '$numberInt', detail: 'EJSON Int32', value: '{"\\$numberInt": "${1:0}"}' },
  { key: '$numberLong', detail: 'EJSON Int64', value: '{"\\$numberLong": "${1:0}"}' },
  { key: '$numberDouble', detail: 'EJSON Double', value: '{"\\$numberDouble": "${1:0.0}"}' },
  { key: '$numberDecimal', detail: 'EJSON Decimal128', value: '{"\\$numberDecimal": "${1:0}"}' },
  { key: '$regularExpression', detail: 'EJSON Regex', value: '{"\\$regularExpression": {"pattern": "${1:pattern}", "options": "${2:i}"}}' },
  { key: '$timestamp', detail: 'EJSON Timestamp', value: '{"\\$timestamp": {"t": ${1:0}, "i": ${2:1}}}' },
  { key: '$binary', detail: 'EJSON Binary', value: '{"\\$binary": {"base64": "${1:base64}", "subType": "${2:00}"}}' },
  { key: '$uuid', detail: 'EJSON UUID', value: '{"\\$uuid": "${1:00000000-0000-0000-0000-000000000000}"}' },
  { key: '$code', detail: 'EJSON JavaScript code', value: '{"\\$code": "${1:code}"}' },
  { key: '$symbol', detail: 'EJSON Symbol', value: '{"\\$symbol": "${1:symbol}"}' },
  { key: '$undefined', detail: 'EJSON Undefined', value: '{"\\$undefined": true}' },
  { key: '$minKey', detail: 'EJSON MinKey', value: '{"\\$minKey": 1}' },
  { key: '$maxKey', detail: 'EJSON MaxKey', value: '{"\\$maxKey": 1}' },
  { key: '$dbPointer', detail: 'EJSON DBPointer', value: '{"\\$dbPointer": {"\\$ref": "${1:collection}", "\\$id": {"\\$oid": "${2:objectId}"}}}' },
];

// Projection-only operators ({field: {$slice: …}}).
export const PROJECTION_OPERATORS: EjsonType[] = [
  { key: '$slice', detail: 'array slice', value: '{"\\$slice": ${1:5}}' },
  { key: '$elemMatch', detail: 'first matching element', value: '{"\\$elemMatch": {$1}}' },
  { key: '$meta', detail: 'text score', value: '{"\\$meta": "${1:textScore}"}' },
];

// mongosh does NOT parse EJSON wrappers as types, so the shell surface offers
// constructor calls at value positions instead.
export const SHELL_VALUE_CTORS: EjsonType[] = [
  { key: 'ObjectId', detail: 'ObjectId', value: 'ObjectId("${1:objectId}")' },
  { key: 'ISODate', detail: 'Date', value: 'ISODate("${1:2024-01-01T00:00:00Z}")' },
  { key: 'NumberInt', detail: 'Int32', value: 'NumberInt(${1:0})' },
  { key: 'NumberLong', detail: 'Int64', value: 'NumberLong("${1:0}")' },
  { key: 'NumberDecimal', detail: 'Decimal128', value: 'NumberDecimal("${1:0}")' },
  { key: 'UUID', detail: 'UUID', value: 'UUID("${1:00000000-0000-0000-0000-000000000000}")' },
  { key: 'BinData', detail: 'Binary', value: 'BinData(${1:0}, "${2:base64}")' },
  { key: 'Timestamp', detail: 'Timestamp', value: 'Timestamp(${1:0}, ${2:1})' },
];

function byPrefix<T extends { label: string }>(items: T[], token: string): T[] {
  if (!token) return items;
  const t = token.toLowerCase();
  return items.filter((i) => i.label.toLowerCase().startsWith(t));
}

// True when the caret sits just after an opening double-quote (user is already
// typing a quoted key), so we must NOT add quotes again.
function inQuote(text: string): boolean {
  return /"[\w$.]*$/.test(text);
}

// Object keys (field names and $operators/$stages) must be quoted in the JSON
// surfaces (filter/projection/sort/aggStage); the mongosh surface is JS, where
// bare keys/identifiers are fine.
function keyInsert(ctx: CompletionCtx, s: string): string {
  return ctx.surface !== 'shell' && !inQuote(ctx.textBeforeCursor) ? `"${s}"` : s;
}

function opItems(ctx: CompletionCtx, ops: string[], detail: string): CompletionItem[] {
  return ops.map((op) => ({ label: op, kind: 'operator' as const, insertText: keyInsert(ctx, op), detail }));
}

function fieldItems(ctx: CompletionCtx): CompletionItem[] {
  return ctx.fields.map((name) => {
    const fs = ctx.schema?.get(name);
    return { label: name, kind: 'field' as const, insertText: keyInsert(ctx, name), detail: fs?.type };
  });
}

// Value scaffolds per schema type, keyed by the labels the backend schema
// analyzer emits (src-tauri/src/db/schema.rs bson_type_label). `json` is for
// the EJSON surfaces, `shell` for mongosh. Every label must have an entry.
export const TYPE_VALUE_SCAFFOLDS: Record<string, { json: string; shell: string }> = {
  objectId: { json: '{"\\$oid": "${1:objectId}"}', shell: 'ObjectId("${1:objectId}")' },
  date: { json: '{"\\$date": "${1:2024-01-01T00:00:00Z}"}', shell: 'ISODate("${1:2024-01-01T00:00:00Z}")' },
  string: { json: '"${1:value}"', shell: '"${1:value}"' },
  int: { json: '${1:0}', shell: '${1:0}' },
  long: { json: '{"\\$numberLong": "${1:0}"}', shell: 'NumberLong("${1:0}")' },
  double: { json: '${1:0.0}', shell: '${1:0.0}' },
  decimal: { json: '{"\\$numberDecimal": "${1:0}"}', shell: 'NumberDecimal("${1:0}")' },
  bool: { json: '${1:true}', shell: '${1:true}' },
  null: { json: 'null', shell: 'null' },
  array: { json: '[$1]', shell: '[$1]' },
  object: { json: '{$1}', shell: '{$1}' },
  regex: { json: '{"\\$regularExpression": {"pattern": "${1:pattern}", "options": "${2:i}"}}', shell: '/${1:pattern}/${2:i}' },
  timestamp: { json: '{"\\$timestamp": {"t": ${1:0}, "i": ${2:1}}}', shell: 'Timestamp(${1:0}, ${2:1})' },
  binary: { json: '{"\\$binary": {"base64": "${1:base64}", "subType": "${2:00}"}}', shell: 'BinData(${1:0}, "${2:base64}")' },
  javascript: { json: '{"\\$code": "${1:code}"}', shell: 'Code("${1:code}")' },
  symbol: { json: '{"\\$symbol": "${1:symbol}"}', shell: '"${1:symbol}"' },
  minKey: { json: '{"\\$minKey": 1}', shell: 'MinKey()' },
  maxKey: { json: '{"\\$maxKey": 1}', shell: 'MaxKey()' },
  undefined: { json: '{"\\$undefined": true}', shell: 'undefined' },
  dbPointer: { json: '{"\\$dbPointer": {"\\$ref": "${1:collection}", "\\$id": {"\\$oid": "${2:objectId}"}}}', shell: 'DBPointer("${1:collection}", ObjectId("${2:objectId}"))' },
};

// Field completions for filter-like key positions: a schema-typed field
// inserts the whole `"field": <typed value scaffold>` (shell: `field: …`) so
// the user lands directly in the value placeholder. Untyped fields insert the
// plain key, leaving operator choice open.
function typedFieldItems(ctx: CompletionCtx): CompletionItem[] {
  return ctx.fields.map((name) => {
    const fs = ctx.schema?.get(name);
    const shell = ctx.surface === 'shell';
    const scaffold = fs?.type ? TYPE_VALUE_SCAFFOLDS[fs.type] : undefined;
    if (!scaffold) {
      return { label: name, kind: 'field' as const, insertText: keyInsert(ctx, name), detail: fs?.type };
    }
    // keyInsert semantics inline: shell keys are bare; in JSON we open a quote
    // unless the user already typed one, and always close it before the colon.
    const key = shell ? name : inQuote(ctx.textBeforeCursor) ? `${name}"` : `"${name}"`;
    return { label: name, kind: 'field' as const, insertText: `${key}: ${shell ? scaffold.shell : scaffold.json}`, detail: fs?.type, isSnippet: true };
  });
}

function quoteForType(value: string, type?: string): string {
  // string/objectId/date → quoted; numeric/bool → raw.
  if (type === 'int' || type === 'long' || type === 'double' || type === 'decimal' || type === 'bool') return value;
  return JSON.stringify(value);
}

function enumItemsForLastField(ctx: CompletionCtx): CompletionItem[] {
  const field = lastFieldKey(ctx.textBeforeCursor);
  if (!field) return [];
  const fs = ctx.schema?.get(field);
  if (!fs?.enumValues?.length) return [];
  return fs.enumValues.map((v) => ({
    label: v, kind: 'enum' as const, insertText: quoteForType(v, fs.type), detail: 'enum',
  }));
}

// The nearest `"field":` (or `field:`) key to the left of the cursor.
function lastFieldKey(text: string): string | null {
  const m = text.match(/["']?([A-Za-z_][\w.]*)["']?\s*:\s*[^,{}\[\]]*$/);
  return m ? m[1] : null;
}

// True when the caret is at an object-key position (after `{` or `,`, not past a `:`).
function atKeyPosition(text: string): boolean {
  const tail = text.slice(text.lastIndexOf('{') + 1);
  const afterComma = text.slice(text.lastIndexOf(',') + 1);
  const seg = tail.length < afterComma.length ? tail : afterComma;
  return !seg.includes(':');
}

// True when the caret is at a value position (just after `field:`).
function atValuePosition(text: string): boolean {
  return /:\s*["']?[\w.$]*$/.test(text) && !atKeyPosition(text);
}

// Index of the innermost still-open `{`, skipping braces inside string literals.
function lastOpenBraceIndex(text: string): number {
  const stack: number[] = [];
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '{') stack.push(i);
    else if (c === '}') stack.pop();
  }
  return stack.length ? stack[stack.length - 1] : -1;
}

// The key whose value the innermost open object is, e.g. `_id` for
// `{"_id": {` — null when the open object is the top level or an array element.
function parentKeyOfOpenObject(text: string): string | null {
  const idx = lastOpenBraceIndex(text);
  if (idx <= 0) return null;
  const m = text.slice(0, idx).match(/["']?([\w$.]+)["']?\s*:\s*$/);
  return m ? m[1] : null;
}

function snippetItems(list: EjsonType[], kind: CompletionKind): CompletionItem[] {
  return list.map((t) => ({ label: t.key, kind, insertText: t.value, detail: t.detail, isSnippet: true }));
}

// EJSON wrapper snippets for a value position; the wrapper matching the
// field's schema type (objectId/date) ranks first.
function ejsonValueItems(ctx: CompletionCtx): CompletionItem[] {
  const items = snippetItems(EJSON_TYPES, 'ejson');
  const field = lastFieldKey(ctx.textBeforeCursor);
  const type = field ? ctx.schema?.get(field)?.type : undefined;
  const first = type === 'objectId' ? '$oid' : type === 'date' ? '$date' : null;
  if (!first) return items;
  return [...items.filter((i) => i.label === first), ...items.filter((i) => i.label !== first)];
}

// Bare `$key` completions for when the user already opened the wrapper object.
function keyItems(ctx: CompletionCtx, list: EjsonType[]): CompletionItem[] {
  return list.map((t) => ({ label: t.key, kind: 'ejson' as const, insertText: keyInsert(ctx, t.key), detail: t.detail }));
}

export function getCompletions(ctx: CompletionCtx): CompletionItem[] {
  const { surface, textBeforeCursor, token } = ctx;

  if (surface === 'projection') {
    if (atValuePosition(textBeforeCursor)) {
      return byPrefix([
        { label: '1', kind: 'operator' as const, insertText: '1', detail: 'include' },
        { label: '0', kind: 'operator' as const, insertText: '0', detail: 'exclude' },
        ...snippetItems(PROJECTION_OPERATORS, 'operator'),
        ...ejsonValueItems(ctx),
      ], token);
    }
    const parent = atKeyPosition(textBeforeCursor) ? parentKeyOfOpenObject(textBeforeCursor) : null;
    if (parent === '$elemMatch') {
      return byPrefix([...typedFieldItems(ctx), ...opItems(ctx, QUERY_OPERATORS, 'query operator')], token);
    }
    if (parent) {
      return byPrefix([...keyItems(ctx, PROJECTION_OPERATORS), ...opItems(ctx, QUERY_OPERATORS, 'query operator'), ...keyItems(ctx, EJSON_TYPES)], token);
    }
    return byPrefix([...fieldItems(ctx),
      { label: '1', kind: 'operator', insertText: '1', detail: 'include' },
      { label: '0', kind: 'operator', insertText: '0', detail: 'exclude' }], token);
  }
  if (surface === 'sort') {
    if (atValuePosition(textBeforeCursor)) {
      return byPrefix([
        { label: '1', kind: 'operator' as const, insertText: '1', detail: 'ascending' },
        { label: '-1', kind: 'operator' as const, insertText: '-1', detail: 'descending' },
        { label: '$meta', kind: 'operator' as const, insertText: '{"\\$meta": "${1:textScore}"}', detail: 'sort by text score', isSnippet: true },
      ], token);
    }
    return byPrefix([...fieldItems(ctx),
      { label: '1', kind: 'operator', insertText: '1', detail: 'ascending' },
      { label: '-1', kind: 'operator', insertText: '-1', detail: 'descending' }], token);
  }
  if (surface === 'shell') {
    // db.<partial> (collection slot — exactly one dot after db) → collection names + db methods
    if (/\bdb\.\w*$/.test(textBeforeCursor)) {
      const colls = (ctx.collections ?? []).map((c) => ({ label: c, kind: 'field' as const, insertText: c, detail: 'collection' }));
      const dbm = DB_METHODS.map((m) => ({ label: m, kind: 'method' as const, insertText: m }));
      return byPrefix([...colls, ...dbm], token);
    }
    // any other `.<partial>` (after a collection, a ) or a ] ) → methods (find, forEach, sort, …)
    if (/[)\]\w]\s*\.\w*$/.test(textBeforeCursor)) {
      return byPrefix(CURSOR_METHODS.map((m) => ({ label: m, kind: 'method' as const, insertText: m })), token);
    }
    // top level (not after a dot, not inside an open ( or { ) → mongosh globals
    const openParen = textBeforeCursor.lastIndexOf('(') > textBeforeCursor.lastIndexOf(')');
    const openBrace = textBeforeCursor.lastIndexOf('{') > textBeforeCursor.lastIndexOf('}');
    if (!openParen && !openBrace) {
      return byPrefix(SHELL_GLOBALS.map((g) => ({ label: g, kind: 'method' as const, insertText: g })), token);
    }
    // otherwise (inside find({...}), aggregate([...])) → behave like a filter (fall through)
  }

  const aggStageStart = surface === 'aggStage' && atKeyPosition(textBeforeCursor)
    && parentKeyOfOpenObject(textBeforeCursor) === null
    && !/\$group/.test(textBeforeCursor.slice(textBeforeCursor.indexOf('{')));

  if (aggStageStart) {
    return byPrefix(AGG_STAGES.map((s) => ({ label: s, kind: 'stage' as const, insertText: keyInsert(ctx, s) })), token);
  }
  if (surface === 'aggStage' && /\$group/.test(textBeforeCursor) && atKeyPosition(textBeforeCursor)) {
    return byPrefix([...opItems(ctx, GROUP_ACCUMULATORS, 'accumulator'), ...fieldItems(ctx)], token);
  }

  // filter (and shell-inside-find, and agg $match body) — value position:
  // enum values, EJSON type wrappers (shell constructors in the JS shell), operators.
  if (atValuePosition(textBeforeCursor)) {
    const typed = surface === 'shell' ? snippetItems(SHELL_VALUE_CTORS, 'method') : ejsonValueItems(ctx);
    return byPrefix([...enumItemsForLastField(ctx), ...typed, ...opItems(ctx, QUERY_OPERATORS, 'query operator')], token);
  }
  // key position inside an open value object ({"_id": { …): the keys are
  // operators or EJSON wrappers, not field names — except filter-document
  // bodies ($elemMatch, $match, …) where fields apply again.
  const parent = atKeyPosition(textBeforeCursor) ? parentKeyOfOpenObject(textBeforeCursor) : null;
  if (parent) {
    if (parent === '$not') {
      return byPrefix([...opItems(ctx, QUERY_OPERATORS, 'query operator'), ...keyItems(ctx, EJSON_TYPES)], token);
    }
    if (parent.startsWith('$')) {
      return byPrefix([...typedFieldItems(ctx), ...opItems(ctx, QUERY_OPERATORS, 'query operator')], token);
    }
    return byPrefix([...opItems(ctx, QUERY_OPERATORS, 'query operator'), ...keyItems(ctx, EJSON_TYPES)], token);
  }
  // top-level key position
  return byPrefix([...typedFieldItems(ctx), ...opItems(ctx, LOGICAL_OPERATORS, 'logical')], token);
}
