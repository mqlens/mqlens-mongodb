import { describe, it, expect } from 'vitest';
import { collectionTabsMatching } from '../collectionTabs';

const tab = (id: string, over: Partial<{ type: string; connectionId: string; db: string; collection: string }> = {}) => ({
  id, type: 'collection', connectionId: 'c1', db: 'app', collection: 'orders', ...over,
});

describe('collectionTabsMatching', () => {
  const target = { connectionId: 'c1', db: 'app', collection: 'orders' };

  it('returns every collection tab matching connection/db/collection', () => {
    const tabs = [tab('c1.app.orders'), tab('c1.app.orders::2'), tab('c1.app.users', { collection: 'users' })];
    const result = collectionTabsMatching(tabs, target);
    expect(result.map((t) => t.id)).toEqual(['c1.app.orders', 'c1.app.orders::2']);
  });

  it('ignores non-collection tabs even if fields match', () => {
    const tabs = [tab('c1.app.orders'), tab('c1.app.orders.idx', { type: 'index' })];
    expect(collectionTabsMatching(tabs, target).map((t) => t.id)).toEqual(['c1.app.orders']);
  });

  it('does not match a different connection or db', () => {
    const tabs = [tab('c2.app.orders', { connectionId: 'c2' }), tab('c1.other.orders', { db: 'other' })];
    expect(collectionTabsMatching(tabs, target)).toEqual([]);
  });
});
