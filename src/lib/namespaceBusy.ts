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

/**
 * One document write that has been sent and not yet answered.
 *
 * Recorded per request rather than read off the edit that started it. An edit
 * can be replaced while its save is still running — the non-modal dialog
 * exists so a second one can be started on the same tab — and asking the
 * current edit whether it is saving then answers about the wrong request, or
 * about none at all (#326 review). A request outlives the edit; this is the
 * record that outlives it too.
 */
export interface PendingSave {
  connectionId: string;
  db: string;
  collection: string;
}

/**
 * True when a document write is outstanding against this namespace.
 *
 * Omit `collection` to ask about a whole database, which is what a database
 * rename or drop needs: every collection under it moves or goes.
 *
 * This is the fast answer, for a control that can refuse before it starts. It
 * only knows about this window; the authoritative check is the backend's, which
 * sees every window's requests — see `namespace_guard.rs`.
 */
export function isNamespaceBusy(
  saves: readonly PendingSave[],
  connectionId: string,
  db: string,
  collection?: string
): boolean {
  return saves.some(
    (save) =>
      save.connectionId === connectionId &&
      save.db === db &&
      (collection === undefined || save.collection === collection)
  );
}
