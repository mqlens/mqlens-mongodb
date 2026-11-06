import { isMacPlatform } from './shortcuts';

// Multi-selected databases and collections in the explorer tree, scoped to one
// connection. Keys keep a database and a collection apart even when names hold
// dots (`a.b` the collection vs `a` + `b`).
export interface TreeSelection {
  connectionId: string | null;
  keys: Set<string>;
  /** Where a shift-click range starts: the last plain- or toggle-clicked row. */
  anchor: string | null;
}

export interface TreeItem {
  db: string;
  coll?: string;
}

export const itemKey = (db: string, coll?: string) => JSON.stringify(coll === undefined ? [db] : [db, coll]);

export const parseItemKey = (key: string): TreeItem => {
  const [db, coll] = JSON.parse(key) as [string, string?];
  return coll === undefined ? { db } : { db, coll };
};

export const emptySelection = (): TreeSelection => ({ connectionId: null, keys: new Set(), anchor: null });

/** A plain click: nothing stays selected, but the row anchors the next shift-click. */
export const clearToAnchor = (connectionId: string, key: string): TreeSelection => ({
  connectionId,
  keys: new Set(),
  anchor: key,
});

/** Toggle membership; another connection's selection is dropped first. */
export const toggleItem = (sel: TreeSelection, connectionId: string, key: string): TreeSelection => {
  const keys = new Set(sel.connectionId === connectionId ? sel.keys : []);
  if (keys.has(key)) keys.delete(key);
  else keys.add(key);
  return { connectionId, keys, anchor: key };
};

const isCollectionKey = (key: string) => parseItemKey(key).coll !== undefined;

/**
 * Replace the selection with the rows from the anchor to `target`, in the
 * order the tree shows them (`visibleKeys`). The anchor stays where it was.
 *
 * Only rows of the anchor's kind are taken, plus `target` itself: a range of
 * collections that crosses a database row must not pick that database up, or
 * a delete would drop all of it.
 */
export const selectRange = (
  sel: TreeSelection,
  connectionId: string,
  visibleKeys: string[],
  target: string,
): TreeSelection => {
  const anchor = sel.connectionId === connectionId ? sel.anchor : null;
  const from = anchor === null ? -1 : visibleKeys.indexOf(anchor);
  const to = visibleKeys.indexOf(target);
  if (from < 0 || to < 0) return { connectionId, keys: new Set([target]), anchor: target };
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  const kind = isCollectionKey(anchor!);
  const range = visibleKeys.slice(lo, hi + 1).filter((k) => k === target || isCollectionKey(k) === kind);
  return { connectionId, keys: new Set(range), anchor };
};

export const selectedCollectionsIn = (sel: TreeSelection, connectionId: string, db: string): string[] =>
  sel.connectionId !== connectionId
    ? []
    : [...sel.keys].map(parseItemKey).filter((i) => i.db === db && i.coll !== undefined).map((i) => i.coll!);

/** Cmd+click on macOS, Ctrl+click elsewhere. Ctrl+click on a Mac opens the context menu. */
export const isMultiSelectToggle = (
  e: { metaKey: boolean; ctrlKey: boolean },
  platform = navigator.platform,
): boolean => (isMacPlatform(platform) ? e.metaKey : e.ctrlKey);
