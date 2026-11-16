// Query shapes for the profiler's grouped view: a profiled command with its
// values taken out, so runs of the same query with different values group
// together.
//
// The backend sends the command as text (bson's Display form, or JSON),
// cut at 2000 characters, and no queryHash. So the shape is read from that
// text: keys, operators, the command's collection and `$field` paths stay;
// every other value becomes `?`.
import type { ProfileEntry } from './monitoringApi';

// Fields a driver or session adds to every command. They differ run to run
// and say nothing about the query. Dropped from the command only: inside a
// filter, `comment` is the application's own field.
const NOISE = new Set([
  '$audit', '$client', '$clusterTime', '$db', '$queryOptions', '$readPreference',
  'apiDeprecationErrors', 'apiStrict', 'apiVersion', 'autocommit', 'batchSize',
  'bypassDocumentValidation', 'comment', 'cursor', 'databaseVersion', 'lsid',
  'maxTimeMS', 'mayBypassWriteBlocking', 'ordered', 'readConcern', 'shardVersion',
  'singleBatch', 'startTransaction', 'txnNumber', 'writeConcern',
]);

// Values that are part of the shape, not query data: sort directions,
// projection flags and index hints change the plan. As options of the
// command itself or of one statement of a write, or as the $sort and
// $project stages and operators; a field of the same name inside a filter
// is data.
const COMMAND_STRUCTURAL = new Set(['sort', 'projection', 'hint']);
// The lists of statements in an update or delete, each with its own options.
const WRITE_STATEMENTS = new Set(['updates', 'deletes']);
// Options whose value is a query. In a query, an array is a value to compare
// with, whatever operator holds it, so every list there collapses; under
// $expr, operators take expressions again.
const QUERY_OPTIONS = new Set(['filter', 'q', 'query', 'arrayFilters']);
const OPERATOR_STRUCTURAL = new Set(['$sort', '$project']);
// Lists whose elements are a set, the values an update adds ($each), or a
// literal ($literal, $const), so how many there are is data. The arguments
// of any other operator are positional: [$a, $a] is not [$a].
const VALUE_SETS = new Set(['$in', '$nin', '$all', '$or', '$and', '$nor', '$each', '$literal', '$const']);
// Operators inside a sort, projection or hint whose value is structural too:
// a scan direction, or the metadata asked for.
const STRUCTURAL_OPERATORS = new Set(['$natural', '$meta']);
// What a $lookup joins on, by name.
const LOOKUPS = new Set(['$lookup', '$graphLookup']);
const JOIN_FIELDS = new Set(['from', 'localField', 'foreignField', 'as', 'connectFromField', 'connectToField']);
// A pipeline stage: a document whose one field is a $ operator.
const STAGE = /^\{\$[^:]+: /;

type Token = { kind: 'punct' | 'string' | 'other'; text: string };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
    } else if ('{}[]:,'.includes(c)) {
      tokens.push({ kind: 'punct', text: c });
      i++;
    } else if (c === '"') {
      let j = i + 1;
      let text = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') j++;
        text += src[j] ?? '';
        j++;
      }
      tokens.push({ kind: 'string', text });
      i = j + 1;
    } else {
      // A bare value: a number, true/false/null, or a constructor such as
      // ObjectId("…") or Timestamp(1, 2), whose parentheses can hold commas.
      let j = i;
      let depth = 0;
      while (j < src.length) {
        const d = src[j];
        if (d === '(') depth++;
        else if (d === ')') depth--;
        else if (depth <= 0 && ('{}[]:,'.includes(d) || /\s/.test(d))) break;
        else if (d === '"' && depth > 0) {
          j++;
          while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
        }
        j++;
      }
      tokens.push({ kind: 'other', text: src.slice(i, j) });
      i = j;
    }
  }
  return tokens;
}

export function queryShape(command: string): string {
  const text = command.trim();
  if (!text.startsWith('{')) return text;
  const tokens = tokenize(text);
  let pos = 0;
  const peek = () => tokens[pos];
  const isPunct = (p: string) => peek()?.kind === 'punct' && peek()?.text === p;

  // keepAll: inside a sort, projection or hint, whose values are the shape.
  // statements: a document here, or in the list here, is one statement of a
  // write, whose own sort or hint is an option.
  // query: inside a filter or $match, outside $expr.
  const value = (keepLiteral = false, keepAll = false, key = '', statements = false, query = false): string => {
    const tok = peek();
    if (!tok) return '?';
    if (isPunct('{')) return doc(false, keepAll, key, statements, query);
    if (isPunct('[')) return list(keepAll, key, statements, query);
    pos++;
    if (keepAll) return tok.kind === 'string' ? JSON.stringify(tok.text) : tok.text;
    if (tok.kind === 'string' && (keepLiteral || tok.text.startsWith('$'))) return JSON.stringify(tok.text);
    return '?';
  };

  const doc = (top: boolean, keepAll = false, parent = '', options = top, query = false): string => {
    pos++; // {
    const fields: string[] = [];
    while (peek() && !isPunct('}')) {
      if (isPunct(',')) {
        pos++;
        continue;
      }
      const key = tokens[pos++].text;
      if (isPunct(':')) pos++;
      // The first field names the command, and its value is the collection.
      const keepLiteral = (top && fields.length === 0) || (LOOKUPS.has(parent) && JOIN_FIELDS.has(key));
      // Inside a sort or projection, an operator such as $ifNull computes a
      // value, and its constants are data again; $natural and $meta don't.
      const keepValues =
        (options && COMMAND_STRUCTURAL.has(key)) || OPERATOR_STRUCTURAL.has(key) || (keepAll && (!key.startsWith('$') || STRUCTURAL_OPERATORS.has(key)));
      const inQuery = key !== '$expr' && (query || key === '$match' || (options && QUERY_OPTIONS.has(key)));
      const shape = value(keepLiteral, keepValues, key, top && WRITE_STATEMENTS.has(key), inQuery);
      if (!(top && NOISE.has(key))) fields.push(`${key}: ${shape}`);
    }
    pos++; // }
    return `{${fields.join(', ')}}`;
  };

  const list = (keepAll: boolean, key: string, statements = false, query = false): string => {
    pos++; // [
    const items: string[] = [];
    // Repeats collapse in data, value sets and queries: [1, 2, 3] and [4] are
    // both [?]. Not in an operator's arguments, and not pipeline stages: a
    // stage run twice is a different pipeline.
    const collapse = !keepAll && (query || !key.startsWith('$') || VALUE_SETS.has(key));
    while (peek() && !isPunct(']')) {
      if (isPunct(',')) {
        pos++;
        continue;
      }
      const shape = value(false, keepAll, '', statements, query);
      if (!collapse || (!query && STAGE.test(shape)) || !items.includes(shape)) items.push(shape);
    }
    pos++; // ]
    return `[${items.join(', ')}]`;
  };

  return doc(true);
}

export interface ProfileGroup {
  key: string;
  op: string;
  ns: string;
  shape: string;
  count: number;
  totalMs: number;
  avgMs: number;
  maxMs: number;
  minMs: number;
  /** The group's slowest run, shown when the group is opened. */
  slowest: ProfileEntry;
}

/** Entries grouped by operation, namespace and query shape, most total time first. */
export function groupProfileByShape(entries: ProfileEntry[]): ProfileGroup[] {
  const groups = new Map<string, ProfileGroup>();
  for (const e of entries) {
    const shape = queryShape(e.command);
    const key = `${e.op}\u0000${e.ns}\u0000${shape}`;
    const g = groups.get(key);
    if (!g) {
      groups.set(key, { key, op: e.op, ns: e.ns, shape, count: 1, totalMs: e.millis, avgMs: e.millis, maxMs: e.millis, minMs: e.millis, slowest: e });
      continue;
    }
    g.count++;
    g.totalMs += e.millis;
    g.avgMs = Math.round(g.totalMs / g.count);
    g.minMs = Math.min(g.minMs, e.millis);
    if (e.millis > g.maxMs) {
      g.maxMs = e.millis;
      g.slowest = e;
    }
  }
  return [...groups.values()].sort((a, b) => b.totalMs - a.totalMs);
}
