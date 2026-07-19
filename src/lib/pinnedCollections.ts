export type PinnedItemKind = 'connection' | 'database' | 'collection';

/** @deprecated Use PinnedItem */
export interface PinnedCollection {
  connectionName: string;
  db: string;
  collection: string;
}

export interface PinnedItem {
  kind: PinnedItemKind;
  connectionName: string;
  db?: string;
  collection?: string;
}

const STORAGE_KEY = 'mqlens_pinned_collections';
/** Exported so cross-window `storage` listeners (Sidebar.tsx) can filter events by key. */
export const PINNED_STORAGE_KEY = STORAGE_KEY;
export const PINNED_CHANGED_EVENT = 'mqlens-pinned-changed';

function normalizeItem(raw: unknown): PinnedItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const connectionName = typeof o.connectionName === 'string' ? o.connectionName : '';
  if (!connectionName) return null;

  if (o.kind === 'connection') {
    return { kind: 'connection', connectionName };
  }
  if (o.kind === 'database' && typeof o.db === 'string' && o.db) {
    return { kind: 'database', connectionName, db: o.db };
  }
  if (o.kind === 'collection' && typeof o.db === 'string' && typeof o.collection === 'string') {
    return { kind: 'collection', connectionName, db: o.db, collection: o.collection };
  }
  // Legacy format: { connectionName, db, collection } without kind
  if (typeof o.db === 'string' && typeof o.collection === 'string') {
    return { kind: 'collection', connectionName, db: o.db, collection: o.collection };
  }
  return null;
}

export function pinnedItemKey(item: PinnedItem): string {
  switch (item.kind) {
    case 'connection':
      return `conn::${item.connectionName}`;
    case 'database':
      return `db::${item.connectionName}::${item.db}`;
    case 'collection':
      return `coll::${item.connectionName}::${item.db}::${item.collection}`;
  }
}

export function loadPinnedCollections(): PinnedItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown[];
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeItem).filter((x): x is PinnedItem => x !== null);
  } catch {
    return [];
  }
}

function savePinnedCollections(items: PinnedItem[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    queueMicrotask(() => window.dispatchEvent(new Event(PINNED_CHANGED_EVENT)));
  } catch (err) {
    console.error('Failed to save pinned items', err);
    throw err;
  }
}

export function isItemPinned(items: PinnedItem[], entry: PinnedItem): boolean {
  const key = pinnedItemKey(entry);
  return items.some((p) => pinnedItemKey(p) === key);
}

/** @deprecated Use isItemPinned */
export function isCollectionPinned(
  items: PinnedItem[],
  connectionName: string,
  db: string,
  collection: string,
): boolean {
  return isItemPinned(items, {
    kind: 'collection',
    connectionName,
    db,
    collection,
  });
}

export function pinItem(items: PinnedItem[], entry: PinnedItem): PinnedItem[] {
  if (isItemPinned(items, entry)) return items;
  const next = [entry, ...items];
  savePinnedCollections(next);
  return next;
}

/** @deprecated Use pinItem */
export function pinCollection(items: PinnedItem[], entry: PinnedCollection): PinnedItem[] {
  return pinItem(items, {
    kind: 'collection',
    connectionName: entry.connectionName,
    db: entry.db,
    collection: entry.collection,
  });
}

export function unpinItem(items: PinnedItem[], entry: PinnedItem): PinnedItem[] {
  const key = pinnedItemKey(entry);
  const next = items.filter((p) => pinnedItemKey(p) !== key);
  savePinnedCollections(next);
  return next;
}

/** @deprecated Use unpinItem */
export function unpinCollection(
  items: PinnedItem[],
  connectionName: string,
  db: string,
  collection: string,
): PinnedItem[] {
  return unpinItem(items, { kind: 'collection', connectionName, db, collection });
}

export function togglePinItem(items: PinnedItem[], entry: PinnedItem): PinnedItem[] {
  if (isItemPinned(items, entry)) return unpinItem(items, entry);
  return pinItem(items, entry);
}

/** @deprecated Use togglePinItem */
export function togglePinCollection(items: PinnedItem[], entry: PinnedCollection): PinnedItem[] {
  return togglePinItem(items, {
    kind: 'collection',
    connectionName: entry.connectionName,
    db: entry.db,
    collection: entry.collection,
  });
}

export function pinnedItemLabel(item: PinnedItem): string {
  switch (item.kind) {
    case 'connection':
      return item.connectionName;
    case 'database':
      return item.db ?? '';
    case 'collection':
      return item.collection ?? '';
  }
}

export function pinnedItemSubtitle(item: PinnedItem): string | undefined {
  switch (item.kind) {
    case 'connection':
      return 'connection';
    case 'database':
      return item.connectionName;
    case 'collection':
      return item.db;
  }
}
