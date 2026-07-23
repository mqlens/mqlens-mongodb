/**
 * Mint a unique collection-tab id. Returns `baseId` when it isn't already open,
 * otherwise `${baseId}::<n>` with the smallest free n ≥ 2. `baseId` is always the
 * leading portion, so `connectionId` (the first segment of `baseId`) stays the id
 * prefix that `rebindConnection` relies on. Suffix is `::<n>`; `::` does not occur
 * in the derived `${connectionId}.${db}.${collection}` base.
 */
export function uniqueCollectionTabId(baseId: string, existingIds: string[]): string {
  const taken = new Set(existingIds);
  if (!taken.has(baseId)) return baseId;
  let n = 2;
  while (taken.has(`${baseId}::${n}`)) n += 1;
  return `${baseId}::${n}`;
}
