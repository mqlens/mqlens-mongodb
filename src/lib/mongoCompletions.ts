export type Surface = 'filter' | 'projection' | 'sort' | 'aggStage' | 'shell';
export type CompletionKind = 'field' | 'operator' | 'stage' | 'method' | 'enum';

export interface FieldSchema { type?: string; enumValues?: string[]; }

export interface CompletionCtx {
  surface: Surface;
  textBeforeCursor: string;
  token: string;
  fields: string[];
  schema?: Map<string, FieldSchema>;
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
  'find', 'aggregate', 'countDocuments', 'estimatedDocumentCount', 'distinct',
  'insertOne', 'insertMany', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany',
  'findOne', 'replaceOne', 'createIndex', 'getIndexes', 'drop',
];

function byPrefix<T extends { label: string }>(items: T[], token: string): T[] {
  if (!token) return items;
  const t = token.toLowerCase();
  return items.filter((i) => i.label.toLowerCase().startsWith(t));
}

function opItems(ops: string[], detail: string): CompletionItem[] {
  return ops.map((op) => ({ label: op, kind: 'operator' as const, insertText: op, detail }));
}

function fieldItems(ctx: CompletionCtx): CompletionItem[] {
  return ctx.fields.map((name) => {
    const fs = ctx.schema?.get(name);
    return { label: name, kind: 'field' as const, insertText: name, detail: fs?.type };
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
    if (/\.\s*$/.test(textBeforeCursor) || /\.[A-Za-z]*$/.test(textBeforeCursor)) {
      return byPrefix(CURSOR_METHODS.map((m) => ({ label: m, kind: 'method' as const, insertText: m })), token);
    }
    // inside find({...}) → behave like a filter (fall through)
  }

  const aggStageStart = surface === 'aggStage' && atKeyPosition(textBeforeCursor)
    && !/\$group/.test(textBeforeCursor.slice(textBeforeCursor.indexOf('{')));

  if (aggStageStart) {
    return byPrefix(AGG_STAGES.map((s) => ({ label: s, kind: 'stage' as const, insertText: s })), token);
  }
  if (surface === 'aggStage' && /\$group/.test(textBeforeCursor) && atKeyPosition(textBeforeCursor)) {
    return byPrefix([...opItems(GROUP_ACCUMULATORS, 'accumulator'), ...fieldItems(ctx)], token);
  }

  // filter (and shell-inside-find, and agg $match body)
  if (atValuePosition(textBeforeCursor)) {
    return byPrefix([...enumItemsForLastField(ctx), ...opItems(QUERY_OPERATORS, 'query operator')], token);
  }
  // key position
  return byPrefix([...fieldItems(ctx), ...opItems(LOGICAL_OPERATORS, 'logical')], token);
}
