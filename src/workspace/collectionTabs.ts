/** Every `type: 'collection'` tab whose connection/db/collection matches `target`.
 *  With duplicate collection tabs, callers that used to `.find()` a single tab must
 *  act on all matches (e.g. refreshing results after an import/generate write). */
export function collectionTabsMatching<
  T extends { type: string; connectionId: string; db: string; collection: string },
>(tabs: T[], target: { connectionId: string; db: string; collection: string }): T[] {
  return tabs.filter(
    (t) =>
      t.type === 'collection' &&
      t.connectionId === target.connectionId &&
      t.db === target.db &&
      t.collection === target.collection,
  );
}
