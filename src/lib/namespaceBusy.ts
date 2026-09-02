/**
 * Whether a namespace has a document write in flight against it.
 *
 * A save is bound to the namespace it was sent with. Renaming or dropping that
 * namespace while the request is out is a race the client cannot win: if the
 * rename reaches MongoDB first, the insert can recreate the old collection and
 * write into it, and the tab reports success against the new name (#326
 * review). The dialog is non-modal, so those controls stay reachable for the
 * whole request — this is what lets them refuse for its duration.
 *
 * Deliberately about the namespace rather than the tab: two tabs can be open on
 * the same collection, and it is the collection being renamed.
 */

/** The parts of a tab this needs — a structural subset of App's `QueryTab`. */
export interface SavingTab {
  connectionId: string;
  db: string;
  collection: string;
  documentEdit?: { saving: boolean } | undefined;
}

/**
 * True when any tab has a document save running against this namespace.
 *
 * Omit `collection` to ask about a whole database, which is what a database
 * rename needs: every collection under it moves.
 */
export function isNamespaceBusy(
  tabs: readonly SavingTab[],
  connectionId: string,
  db: string,
  collection?: string
): boolean {
  return tabs.some(
    (tab) =>
      tab.documentEdit?.saving === true &&
      tab.connectionId === connectionId &&
      tab.db === db &&
      (collection === undefined || tab.collection === collection)
  );
}
