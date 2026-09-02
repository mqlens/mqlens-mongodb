import { describe, it, expect } from 'vitest';
import { isNamespaceBusy, type SavingTab } from '../namespaceBusy';

// #326 review: the dialog is non-modal, so the rename controls stay reachable
// while a document save is in flight. The request is bound to the namespace it
// was sent with — if the rename reaches MongoDB first, the insert can recreate
// the old collection and write into it while the tab reports success against
// the new name.
describe('isNamespaceBusy', () => {
  const tab = (over: Partial<SavingTab> = {}): SavingTab => ({
    connectionId: 'conn-1',
    db: 'sales_db',
    collection: 'customers',
    documentEdit: { saving: true },
    ...over,
  });

  it('reports the collection a save is running against', () => {
    expect(isNamespaceBusy([tab()], 'conn-1', 'sales_db', 'customers')).toBe(true);
  });

  it('reports its database too, since a database rename moves every collection', () => {
    expect(isNamespaceBusy([tab()], 'conn-1', 'sales_db')).toBe(true);
  });

  it('leaves a different collection, database or connection alone', () => {
    expect(isNamespaceBusy([tab()], 'conn-1', 'sales_db', 'orders')).toBe(false);
    expect(isNamespaceBusy([tab()], 'conn-1', 'other_db')).toBe(false);
    expect(isNamespaceBusy([tab()], 'conn-2', 'sales_db', 'customers')).toBe(false);
  });

  it('is about a save, not an open editor', () => {
    // An edit sitting there unsaved binds nothing: the user can rename around it.
    expect(isNamespaceBusy([tab({ documentEdit: { saving: false } })], 'conn-1', 'sales_db')).toBe(false);
    expect(isNamespaceBusy([tab({ documentEdit: undefined })], 'conn-1', 'sales_db')).toBe(false);
  });

  it('finds the save on whichever tab is running it', () => {
    // Two tabs can be open on one collection, and it is the collection being
    // renamed — so the answer cannot depend on which tab is active.
    const idle = tab({ documentEdit: undefined });
    const saving = tab();
    expect(isNamespaceBusy([idle, saving], 'conn-1', 'sales_db', 'customers')).toBe(true);
  });

  it('is false for no tabs at all', () => {
    expect(isNamespaceBusy([], 'conn-1', 'sales_db', 'customers')).toBe(false);
  });
});
