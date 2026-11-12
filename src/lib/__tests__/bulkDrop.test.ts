import { describe, it, expect, vi } from 'vitest';
import { planBulkDrop, planOperationCount, runBulkDrop, type BulkDropStep } from '../bulkDrop';
import { itemKey } from '../treeSelection';

const db = (name: string) => itemKey(name);
const coll = (d: string, c: string) => itemKey(d, c);

describe('planBulkDrop', () => {
  it('groups collections by database, both sorted', () => {
    const plan = planBulkDrop([coll('shop', 'orders'), coll('crm', 'leads'), coll('shop', 'carts')]);
    expect(plan.databases).toEqual([]);
    expect(plan.collections).toEqual([
      { db: 'crm', names: ['leads'] },
      { db: 'shop', names: ['carts', 'orders'] },
    ]);
    expect(planOperationCount(plan)).toBe(3);
  });

  it('drops a database once and folds its selected collections into it', () => {
    const plan = planBulkDrop([coll('shop', 'orders'), db('shop'), coll('crm', 'leads'), db('logs')]);
    expect(plan.databases).toEqual(['logs', 'shop']);
    expect(plan.collections).toEqual([{ db: 'crm', names: ['leads'] }]);
    expect(plan.covered).toEqual([{ db: 'shop', names: ['orders'] }]);
    expect(planOperationCount(plan)).toBe(3);
  });

  it('never bulk-drops admin, local, config or system.* collections', () => {
    const plan = planBulkDrop([
      db('admin'),
      coll('config', 'chunks'),
      coll('shop', 'system.profile'),
      db('local'),
      db('logs'),
      coll('crm', 'leads'),
    ]);
    expect(plan.databases).toEqual(['logs']);
    expect(plan.collections).toEqual([{ db: 'crm', names: ['leads'] }]);
    expect(plan.excluded).toEqual(['admin', 'config.chunks', 'local', 'shop.system.profile']);
    expect(plan.covered).toEqual([]);
  });

  it('counts a system.* collection as going with its dropped database, not as skipped', () => {
    const plan = planBulkDrop([db('shop'), coll('shop', 'system.profile')]);
    expect(plan.excluded).toEqual([]);
    expect(plan.covered).toEqual([{ db: 'shop', names: ['system.profile'] }]);
  });
});

describe('runBulkDrop', () => {
  it('drops databases then collections one at a time, reporting each step', async () => {
    const order: string[] = [];
    const ops = {
      dropDatabase: vi.fn(async (d: string) => void order.push(`db:${d}`)),
      dropCollection: vi.fn(async (d: string, c: string) => void order.push(`coll:${d}.${c}`)),
    };
    const updates: BulkDropStep[][] = [];
    const steps = await runBulkDrop(
      planBulkDrop([coll('crm', 'leads'), db('logs')]),
      ops,
      (s) => updates.push(s),
    );
    expect(order).toEqual(['db:logs', 'coll:crm.leads']);
    expect(steps.map((s) => s.status)).toEqual(['ok', 'ok']);
    // The first update shows the first step running and the rest pending.
    expect(updates[0].map((s) => s.status)).toEqual(['running', 'pending']);
  });

  it('keeps going past a failure and records its error', async () => {
    const ops = {
      dropDatabase: vi.fn(async () => {}),
      dropCollection: vi.fn(async (_d: string, c: string) => {
        if (c === 'a') throw new Error('not authorized on crm to execute command');
      }),
    };
    const steps = await runBulkDrop(planBulkDrop([coll('crm', 'a'), coll('crm', 'b')]), ops, () => {});
    expect(steps).toEqual([
      { db: 'crm', coll: 'a', status: 'failed', error: 'Error: not authorized on crm to execute command' },
      { db: 'crm', coll: 'b', status: 'ok' },
    ]);
  });
});
