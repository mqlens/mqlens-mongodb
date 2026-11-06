import { parseItemKey } from './treeSelection';

// Never part of a bulk drop. A single-item drop still offers them.
const PROTECTED_DBS = new Set(['admin', 'local', 'config']);

export interface CollectionGroup {
  db: string;
  names: string[];
}

/** What a bulk drop removes, worked out once from the selection and then fixed. */
export interface BulkDropPlan {
  databases: string[];
  /** Collections dropped one by one: none of them sit in a database above. */
  collections: CollectionGroup[];
  /** Selected collections that go with their database, so get no drop of their own. */
  covered: CollectionGroup[];
  /** Selected system namespaces left alone, as `db` or `db.collection`. */
  excluded: string[];
}

export type BulkDropStatus = 'pending' | 'running' | 'ok' | 'failed';

export interface BulkDropStep {
  db: string;
  coll?: string;
  status: BulkDropStatus;
  error?: string;
}

const byName = (a: string, b: string) => a.localeCompare(b);

const grouped = (pairs: [string, string][]): CollectionGroup[] => {
  const map = new Map<string, string[]>();
  for (const [db, name] of pairs) map.set(db, [...(map.get(db) ?? []), name]);
  return [...map.keys()].sort(byName).map((db) => ({ db, names: map.get(db)!.sort(byName) }));
};

export const planBulkDrop = (keys: Iterable<string>): BulkDropPlan => {
  const items = [...keys].map(parseItemKey);
  const excluded: string[] = [];
  const databases = new Set<string>();
  for (const { db, coll } of items) {
    if (coll !== undefined) continue;
    if (PROTECTED_DBS.has(db)) excluded.push(db);
    else databases.add(db);
  }
  const own: [string, string][] = [];
  const covered: [string, string][] = [];
  for (const { db, coll } of items) {
    if (coll === undefined) continue;
    if (databases.has(db)) covered.push([db, coll]);
    else if (PROTECTED_DBS.has(db) || coll.startsWith('system.')) excluded.push(`${db}.${coll}`);
    else own.push([db, coll]);
  }
  return {
    databases: [...databases].sort(byName),
    collections: grouped(own),
    covered: grouped(covered),
    excluded: excluded.sort(byName),
  };
};

export const planOperationCount = (plan: BulkDropPlan) =>
  plan.databases.length + plan.collections.reduce((n, g) => n + g.names.length, 0);

/** Every drop the plan makes, in run order: databases first, all pending. */
export const planSteps = (plan: BulkDropPlan): BulkDropStep[] => [
  ...plan.databases.map((db): BulkDropStep => ({ db, status: 'pending' })),
  ...plan.collections.flatMap((g) => g.names.map((coll): BulkDropStep => ({ db: g.db, coll, status: 'pending' }))),
];

/**
 * Run the plan one drop at a time, databases first. A failure is recorded
 * against its step and the rest still run; `onUpdate` sees every change.
 */
export const runBulkDrop = async (
  plan: BulkDropPlan,
  ops: {
    dropDatabase: (db: string) => Promise<void>;
    dropCollection: (db: string, coll: string) => Promise<void>;
  },
  onUpdate: (steps: BulkDropStep[]) => void,
): Promise<BulkDropStep[]> => {
  let steps = planSteps(plan);
  const set = (i: number, step: BulkDropStep) => {
    steps = steps.map((s, j) => (j === i ? step : s));
    onUpdate(steps);
  };
  for (let i = 0; i < steps.length; i++) {
    set(i, { ...steps[i], status: 'running' });
    try {
      const { db, coll } = steps[i];
      await (coll === undefined ? ops.dropDatabase(db) : ops.dropCollection(db, coll));
      set(i, { ...steps[i], status: 'ok' });
    } catch (err) {
      set(i, { ...steps[i], status: 'failed', error: `${err}` });
    }
  }
  return steps;
};
