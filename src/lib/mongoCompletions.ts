export type Surface = 'filter' | 'projection' | 'sort' | 'aggStage' | 'shell';
export type CompletionKind = 'field' | 'operator' | 'stage' | 'method' | 'enum';

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
export const CURSOR_METHODS = [
  'find', 'findOne', 'aggregate', 'countDocuments', 'estimatedDocumentCount', 'count', 'distinct',
  'insertOne', 'insertMany', 'updateOne', 'updateMany', 'replaceOne', 'deleteOne', 'deleteMany',
  'findOneAndUpdate', 'findOneAndReplace', 'findOneAndDelete', 'bulkWrite',
  'createIndex', 'createIndexes', 'getIndexes', 'dropIndex', 'dropIndexes',
  'drop', 'renameCollection', 'stats', 'watch', 'mapReduce',
];
// db-level methods available on `db.<here>`
export const DB_METHODS = [
  'getCollectionNames', 'getCollectionInfos', 'getCollection', 'createCollection',
  'getName', 'stats', 'runCommand', 'aggregate', 'dropDatabase', 'getMongo', 'hostInfo', 'serverStatus',
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

export function getCompletions(ctx: CompletionCtx): CompletionItem[] {
  const { surface, textBeforeCursor, token } = ctx;

  if (surface === 'projection') {
    return byPrefix([...fieldItems(ctx),
      { label: '1', kind: 'operator', insertText: '1', detail: 'include' },
      { label: '0', kind: 'operator', insertText: '0', detail: 'exclude' }], token);
  }
  if (surface === 'sort') {
    return byPrefix([...fieldItems(ctx),
      { label: '1', kind: 'operator', insertText: '1', detail: 'ascending' },
      { label: '-1', kind: 'operator', insertText: '-1', detail: 'descending' }], token);
  }
  if (surface === 'shell') {
    // db.<collection>.<partial> → collection/cursor methods
    if (/\bdb\.\w+\.\w*$/.test(textBeforeCursor)) {
      return byPrefix(CURSOR_METHODS.map((m) => ({ label: m, kind: 'method' as const, insertText: m })), token);
    }
    // db.<partial> → collection names + db-level methods
    if (/\bdb\.\w*$/.test(textBeforeCursor)) {
      const colls = (ctx.collections ?? []).map((c) => ({ label: c, kind: 'field' as const, insertText: c, detail: 'collection' }));
      const dbm = DB_METHODS.map((m) => ({ label: m, kind: 'method' as const, insertText: m }));
      return byPrefix([...colls, ...dbm], token);
    }
    // otherwise (inside find({...}), aggregate([...])) → behave like a filter (fall through)
  }

  const aggStageStart = surface === 'aggStage' && atKeyPosition(textBeforeCursor)
    && !/\$group/.test(textBeforeCursor.slice(textBeforeCursor.indexOf('{')));

  if (aggStageStart) {
    return byPrefix(AGG_STAGES.map((s) => ({ label: s, kind: 'stage' as const, insertText: keyInsert(ctx, s) })), token);
  }
  if (surface === 'aggStage' && /\$group/.test(textBeforeCursor) && atKeyPosition(textBeforeCursor)) {
    return byPrefix([...opItems(ctx, GROUP_ACCUMULATORS, 'accumulator'), ...fieldItems(ctx)], token);
  }

  // filter (and shell-inside-find, and agg $match body)
  if (atValuePosition(textBeforeCursor)) {
    return byPrefix([...enumItemsForLastField(ctx), ...opItems(ctx, QUERY_OPERATORS, 'query operator')], token);
  }
  // key position
  return byPrefix([...fieldItems(ctx), ...opItems(ctx, LOGICAL_OPERATORS, 'logical')], token);
}
