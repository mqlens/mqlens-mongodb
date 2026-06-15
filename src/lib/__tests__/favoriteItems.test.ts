import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadFavoriteItems,
  addFavoriteItem,
  removeFavoriteItem,
  isItemFavorited,
  toggleFavoriteItem,
} from '../favoriteItems';

describe('favoriteItems', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('adds, toggles, and removes favorites', () => {
    let items = loadFavoriteItems();
    const entry = { kind: 'database' as const, connectionName: 'Local', db: 'sales' };
    items = addFavoriteItem(items, entry);
    expect(isItemFavorited(items, entry)).toBe(true);
    expect(loadFavoriteItems()).toHaveLength(1);
    items = toggleFavoriteItem(items, entry);
    expect(items).toEqual([]);
    items = toggleFavoriteItem(items, entry);
    items = removeFavoriteItem(items, entry);
    expect(items).toEqual([]);
  });
});
