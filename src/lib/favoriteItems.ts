export type FavoriteItemKind = 'connection' | 'database' | 'collection' | 'query';

export interface FavoriteItem {
  kind: FavoriteItemKind;
  connectionName: string;
  db?: string;
  collection?: string;
  queryId?: string;
  /** Display label for query favorites */
  label?: string;
}

const STORAGE_KEY = 'mqlens_favorites';
export const FAVORITES_CHANGED_EVENT = 'mqlens-favorites-changed';

export function favoriteItemKey(item: FavoriteItem): string {
  switch (item.kind) {
    case 'connection':
      return `conn::${item.connectionName}`;
    case 'database':
      return `db::${item.connectionName}::${item.db}`;
    case 'collection':
      return `coll::${item.connectionName}::${item.db}::${item.collection}`;
    case 'query':
      return `q::${item.connectionName}::${item.db}::${item.collection}::${item.queryId}`;
  }
}

export function loadFavoriteItems(): FavoriteItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as FavoriteItem[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveFavoriteItems(items: FavoriteItem[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    queueMicrotask(() => window.dispatchEvent(new Event(FAVORITES_CHANGED_EVENT)));
  } catch (err) {
    console.error('Failed to save favorite items', err);
    throw err;
  }
}

export function isItemFavorited(items: FavoriteItem[], entry: FavoriteItem): boolean {
  const key = favoriteItemKey(entry);
  return items.some((f) => favoriteItemKey(f) === key);
}

export function addFavoriteItem(items: FavoriteItem[], entry: FavoriteItem): FavoriteItem[] {
  if (isItemFavorited(items, entry)) return items;
  const next = [entry, ...items];
  saveFavoriteItems(next);
  return next;
}

export function removeFavoriteItem(items: FavoriteItem[], entry: FavoriteItem): FavoriteItem[] {
  const key = favoriteItemKey(entry);
  const next = items.filter((f) => favoriteItemKey(f) !== key);
  saveFavoriteItems(next);
  return next;
}

export function toggleFavoriteItem(items: FavoriteItem[], entry: FavoriteItem): FavoriteItem[] {
  if (isItemFavorited(items, entry)) return removeFavoriteItem(items, entry);
  return addFavoriteItem(items, entry);
}

export function favoriteItemLabel(item: FavoriteItem): string {
  switch (item.kind) {
    case 'connection':
      return item.connectionName;
    case 'database':
      return item.db ?? '';
    case 'collection':
      return item.collection ?? '';
    case 'query':
      return item.label ?? 'Saved query';
  }
}

export function favoriteItemSubtitle(item: FavoriteItem): string | undefined {
  switch (item.kind) {
    case 'connection':
      return 'connection';
    case 'database':
      return item.connectionName;
    case 'collection':
      return item.db;
    case 'query':
      return item.collection ? `${item.db}.${item.collection}` : item.db;
  }
}
