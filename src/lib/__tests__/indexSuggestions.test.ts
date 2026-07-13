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
});
