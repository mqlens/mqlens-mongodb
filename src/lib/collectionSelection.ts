// Tracks multi-selected collections scoped to a single connection+db.
export interface CollectionSelection {
  scope: string | null; // `${connectionId}::${db}` or null when empty
  names: Set<string>;
}

export const emptySelection = (): CollectionSelection => ({ scope: null, names: new Set() });

export const selectionScope = (connectionId: string, db: string) => `${connectionId}::${db}`;

/** Toggle membership; switching scope clears the previous selection. */
export const toggleCollection = (
  sel: CollectionSelection,
  connectionId: string,
  db: string,
  name: string,
): CollectionSelection => {
  const scope = selectionScope(connectionId, db);
  if (sel.scope !== scope) {
    return { scope, names: new Set([name]) };
  }
  const names = new Set(sel.names);
  if (names.has(name)) names.delete(name);
  else names.add(name);
  return { scope: names.size ? scope : null, names };
};
