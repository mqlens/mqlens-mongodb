import { describe, it, expect } from 'vitest';
import { isNamespaceBusy, type PendingSave } from '../namespaceBusy';

// #326 review: the dialog is non-modal, so the rename and drop controls stay
// reachable while a document save is in flight. The request is bound to the
// namespace it was sent with — if the rename or drop reaches MongoDB first, the
// server can recreate that namespace for the write, undoing the drop or
// splitting the write across two collections.
describe('isNamespaceBusy', () => {
  const save = (over: Partial<PendingSave> = {}): PendingSave => ({
    connectionId: 'conn-1',
    db: 'sales_db',
    collection: 'customers',
    ...over,
  });

  it('reports the collection a save is running against', () => {
    expect(isNamespaceBusy([save()], 'conn-1', 'sales_db', 'customers')).toBe(true);
  });

  it('reports its database too, since a database rename or drop takes every collection', () => {
    expect(isNamespaceBusy([save()], 'conn-1', 'sales_db')).toBe(true);
  });

  it('leaves a different collection, database or connection alone', () => {
    expect(isNamespaceBusy([save()], 'conn-1', 'sales_db', 'orders')).toBe(false);
    expect(isNamespaceBusy([save()], 'conn-1', 'other_db')).toBe(false);
    expect(isNamespaceBusy([save()], 'conn-2', 'sales_db', 'customers')).toBe(false);
  });

  it('answers about requests, so an edit merely sitting open binds nothing', () => {
    // The registry holds sent requests only. An unsaved editor is not one, and
    // the user can rename around it.
    expect(isNamespaceBusy([], 'conn-1', 'sales_db', 'customers')).toBe(false);
  });

  it('still reports a save whose namespace differs from the others outstanding', () => {
    const elsewhere = save({ db: 'other_db', collection: 'things' });
    expect(isNamespaceBusy([elsewhere, save()], 'conn-1', 'sales_db', 'customers')).toBe(true);
    expect(isNamespaceBusy([elsewhere, save()], 'conn-1', 'other_db', 'things')).toBe(true);
  });
});
