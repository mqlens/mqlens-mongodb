import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadPinnedCollections,
  pinItem,
  unpinItem,
  isItemPinned,
  isCollectionPinned,
  pinCollection,
  unpinCollection,
} from '../pinnedCollections';

describe('pinnedCollections', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('pins and unpins a collection', () => {
    let items = loadPinnedCollections();
    expect(items).toEqual([]);
    items = pinCollection(items, {
      connectionName: 'Local',
      db: 'sales',
      collection: 'orders',
    });
    expect(isCollectionPinned(items, 'Local', 'sales', 'orders')).toBe(true);
    expect(loadPinnedCollections()).toHaveLength(1);
    items = unpinCollection(items, 'Local', 'sales', 'orders');
    expect(items).toEqual([]);
  });

  it('pins connections and databases', () => {
    let items = loadPinnedCollections();
    items = pinItem(items, { kind: 'connection', connectionName: 'Local' });
    items = pinItem(items, { kind: 'database', connectionName: 'Local', db: 'sales' });
    expect(isItemPinned(items, { kind: 'connection', connectionName: 'Local' })).toBe(true);
    expect(isItemPinned(items, { kind: 'database', connectionName: 'Local', db: 'sales' })).toBe(true);
    items = unpinItem(items, { kind: 'connection', connectionName: 'Local' });
    expect(items).toHaveLength(1);
  });

  it('migrates legacy collection-only storage format', () => {
    localStorage.setItem(
      'mqlens_pinned_collections',
      JSON.stringify([{ connectionName: 'Local', db: 'sales', collection: 'orders' }]),
    );
    const items = loadPinnedCollections();
    expect(items).toEqual([
      { kind: 'collection', connectionName: 'Local', db: 'sales', collection: 'orders' },
    ]);
  });
});
