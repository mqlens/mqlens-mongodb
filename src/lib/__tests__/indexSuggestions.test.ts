import { describe, it, expect } from 'vitest';
import { suggestESRIndex } from '../indexSuggestions';

describe('suggestESRIndex (ESR rule)', () => {
  it('returns null when the plan already uses an index (IXSCAN)', () => {
    const ix = JSON.stringify({ queryPlanner: { namespace: 'db.c', winningPlan: { stage: 'FETCH', inputStage: { stage: 'IXSCAN', indexName: 'a_1' } } } });
    expect(suggestESRIndex(ix)).toBeNull();
  });
  it('suggests an ESR-ordered key for a COLLSCAN with equality + sort + range', () => {
    const collscan = JSON.stringify({ queryPlanner: {
      namespace: 'shop.orders',
      parsedQuery: { status: { $eq: 'open' }, total: { $gt: 100 } },
      winningPlan: { stage: 'SORT', sortPattern: { createdAt: 1 }, inputStage: { stage: 'COLLSCAN' } },
    } });
    const s = suggestESRIndex(collscan)!;
    expect(Object.keys(s.keys)).toEqual(['status', 'createdAt', 'total']);
    expect(s.keys.createdAt).toBe(1);
    expect(s.namespace).toBe('shop.orders');
  });
  it('handles aggregate explain ($cursor COLLSCAN)', () => {
    const agg = JSON.stringify({ stages: [{ $cursor: { queryPlanner: { namespace: 'db.c', parsedQuery: { x: { $eq: 1 } }, winningPlan: { stage: 'COLLSCAN' } } } }] });
    expect(suggestESRIndex(agg)?.keys).toEqual({ x: 1 });
  });
  it('suggests ESR keys from a real-server normalized $and parsedQuery', () => {
    const collscan = JSON.stringify({ queryPlanner: {
      namespace: 'shop.orders',
      parsedQuery: { $and: [ { status: { $eq: 'open' } }, { total: { $gt: 100 } } ] },
      winningPlan: { stage: 'SORT', sortPattern: { createdAt: 1 }, inputStage: { stage: 'COLLSCAN' } },
    } });
    const s = suggestESRIndex(collscan)!;
    expect(Object.keys(s.keys)).toEqual(['status', 'createdAt', 'total']);
  });
  it('excludes $not and $regex predicates from the equality lead, keeping other fields', () => {
    const collscan = JSON.stringify({ queryPlanner: {
      namespace: 'shop.orders',
      parsedQuery: { name: { $regex: 'x' }, status: { $eq: 'open' } },
      winningPlan: { stage: 'COLLSCAN' },
    } });
    const s = suggestESRIndex(collscan)!;
    expect(s.keys).toEqual({ status: 1 });
  });

  it('returns null for an IDHACK plan (index-served find-by-_id, no COLLSCAN)', () => {
    const idhack = JSON.stringify({ queryPlanner: {
      namespace: 'db.c',
      parsedQuery: { _id: { $eq: 1 } },
      winningPlan: { stage: 'IDHACK' },
    } });
    expect(suggestESRIndex(idhack)).toBeNull();
  });

  it('returns null for a COUNT_SCAN plan (index-served, no COLLSCAN)', () => {
    const countScan = JSON.stringify({ queryPlanner: {
      namespace: 'db.c',
      parsedQuery: { status: { $eq: 'open' } },
      winningPlan: { stage: 'COUNT_SCAN' },
    } });
    expect(suggestESRIndex(countScan)).toBeNull();
  });

  it('returns null for a DISTINCT_SCAN plan (index-served, no COLLSCAN)', () => {
    const distinctScan = JSON.stringify({ queryPlanner: {
      namespace: 'db.c',
      parsedQuery: { status: { $eq: 'open' } },
      winningPlan: { stage: 'DISTINCT_SCAN' },
    } });
    expect(suggestESRIndex(distinctScan)).toBeNull();
  });

  it('returns null for a CLUSTERED_IXSCAN plan (index-served, no COLLSCAN)', () => {
    const clusteredIxscan = JSON.stringify({ queryPlanner: {
      namespace: 'db.c',
      parsedQuery: { status: { $eq: 'open' } },
      winningPlan: { stage: 'CLUSTERED_IXSCAN' },
    } });
    expect(suggestESRIndex(clusteredIxscan)).toBeNull();
  });

  it('returns null when winningPlan has neither COLLSCAN nor a recognized index-served stage', () => {
    const eof = JSON.stringify({ queryPlanner: {
      namespace: 'db.c',
      parsedQuery: { status: { $eq: 'open' } },
      winningPlan: { stage: 'EOF' },
    } });
    expect(suggestESRIndex(eof)).toBeNull();
  });

  it('still suggests an index for a plain COLLSCAN plan', () => {
    const collscan = JSON.stringify({ queryPlanner: {
      namespace: 'db.c',
      parsedQuery: { status: { $eq: 'open' } },
      winningPlan: { stage: 'COLLSCAN' },
    } });
    expect(suggestESRIndex(collscan)?.keys).toEqual({ status: 1 });
  });

  it('skips unknown/non-indexable operators (e.g. $geoWithin) instead of treating them as equality', () => {
    const collscan = JSON.stringify({ queryPlanner: {
      namespace: 'shop.orders',
      parsedQuery: { loc: { $geoWithin: { $box: [[0, 0], [1, 1]] } }, status: { $eq: 'x' } },
      winningPlan: { stage: 'COLLSCAN' },
    } });
    const s = suggestESRIndex(collscan)!;
    expect(s.keys).toEqual({ status: 1 });
  });

  it('returns null when the only predicate uses an unknown/non-indexable operator', () => {
    const collscan = JSON.stringify({ queryPlanner: {
      namespace: 'shop.orders',
      parsedQuery: { loc: { $geoWithin: { $box: [[0, 0], [1, 1]] } } },
      winningPlan: { stage: 'COLLSCAN' },
    } });
    expect(suggestESRIndex(collscan)).toBeNull();
  });
});
