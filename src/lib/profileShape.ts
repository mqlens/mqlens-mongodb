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

  const value = (keepLiteral = false, key = ''): string => {
    const tok = peek();
    if (!tok) return '?';
    if (isPunct('{')) return doc(false);
    // Every stage of a pipeline counts, repeats included.
    if (isPunct('[')) return list(key !== 'pipeline');
    pos++;
    if (tok.kind === 'string' && (keepLiteral || tok.text.startsWith('$'))) return JSON.stringify(tok.text);
    return '?';
  };

  const doc = (top: boolean): string => {
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
      const shape = value(top && fields.length === 0, key);
      if (!(top && NOISE.has(key))) fields.push(`${key}: ${shape}`);
    }
    pos++; // }
    return `{${fields.join(', ')}}`;
  };

  const list = (collapse: boolean): string => {
    pos++; // [
    const items: string[] = [];
    while (peek() && !isPunct(']')) {
      if (isPunct(',')) {
        pos++;
        continue;
      }
      const shape = value();
      // Repeats collapse: [1, 2, 3] and [4] are both [?].
      if (!collapse || !items.includes(shape)) items.push(shape);
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
