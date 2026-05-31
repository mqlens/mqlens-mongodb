// Build mongosh-runnable command strings from a generated query.

export interface GeneratedQuery {
  queryType: 'find' | 'aggregate' | 'script';
  filter?: unknown;
  sort?: unknown;
  projection?: unknown;
  pipeline?: unknown[];
  limit?: number;
  skip?: number;
  script?: string;
}

// A collection reference safe for a mongosh `db.<ref>` expression.
// Identifier-safe names use dot access; anything else uses getCollection("…").
export function collectionRef(name: string): string {
  if (/^[A-Za-z_$][\w$]*$/.test(name)) return name;
  return `getCollection("${name.replace(/"/g, '\\"')}")`;
}

const isEmptyObject = (val: unknown): boolean =>
  val == null ||
  (typeof val === 'object' && !Array.isArray(val) && Object.keys(val as object).length === 0);

// Full mongosh command for a generated query, e.g.
//   db.users.aggregate([ ... ])
//   db.users.find({...}, {...}).sort({...})
export function buildRunnableCommand(query: GeneratedQuery, collectionName: string): string {
  if (query.queryType === 'script') {
    return query.script ?? '';
  }

  const dbRef = `db.${collectionRef(collectionName)}`;

  if (query.queryType === 'aggregate') {
    const pipeline =
      query.pipeline && query.pipeline.length > 0 ? query.pipeline : [{ $match: {} }];
    return `${dbRef}.aggregate(${JSON.stringify(pipeline, null, 2)})`;
  }

  const filter = query.filter ?? {};
  const args = isEmptyObject(query.projection)
    ? JSON.stringify(filter)
    : `${JSON.stringify(filter)}, ${JSON.stringify(query.projection)}`;
  let cmd = `${dbRef}.find(${args})`;
  if (!isEmptyObject(query.sort)) cmd += `.sort(${JSON.stringify(query.sort)})`;
  if (query.skip && query.skip > 0) cmd += `.skip(${query.skip})`;
  if (query.limit && query.limit > 0) cmd += `.limit(${query.limit})`;
  return cmd;
}

/**
 * mongosh operations that can irreversibly destroy data. Widen the guard by
 * adding an op name to this array — nothing else needs to change.
 */
const DESTRUCTIVE_OPS = [
  'deleteOne',
  'deleteMany',
  'remove',
  'drop',
  'dropDatabase',
  'dropIndex',
  'dropIndexes',
];

/**
 * Returns the name of the first destructive operation invoked in `script`
 * (matched as a method call like `.deleteMany(`), or null if none are present.
 * Each op is matched as an exact call — `.drop(` does not match `.dropDatabase(`
 * because the pattern requires `(` immediately after the op name (optionally
 * after whitespace). Errs toward caution: a destructive call inside a string
 * literal or comment still flags.
 */
export function detectDestructiveOp(script: string): string | null {
  for (const op of DESTRUCTIVE_OPS) {
    const pattern = new RegExp(`\\.${op}\\s*\\(`);
    if (pattern.test(script)) return op;
  }
  return null;
}

/**
 * Decides whether an AI-generated query should run immediately or needs
 * confirmation first. Only `script` queries are gated; find/aggregate always
 * run. A script containing a destructive op (see DESTRUCTIVE_OPS) returns
 * `confirm` with the offending op name.
 */
export function guardScriptRun(
  query: GeneratedQuery,
  command: string
): { action: 'run' } | { action: 'confirm'; operation: string } {
  if (query.queryType === 'script') {
    const operation = detectDestructiveOp(command);
    if (operation) return { action: 'confirm', operation };
  }
  return { action: 'run' };
}
