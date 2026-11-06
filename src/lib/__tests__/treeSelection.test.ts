import { describe, it, expect } from 'vitest';
import {
  emptySelection,
  itemKey,
  parseItemKey,
  toggleItem,
  selectRange,
  clearToAnchor,
  selectedCollectionsIn,
  isMultiSelectToggle,
} from '../treeSelection';

const db = (name: string) => itemKey(name);
const coll = (d: string, c: string) => itemKey(d, c);

describe('tree selection', () => {
  it('round-trips database and collection keys, dots and all', () => {
    expect(parseItemKey(db('shop'))).toEqual({ db: 'shop' });
    expect(parseItemKey(coll('shop', 'a.b'))).toEqual({ db: 'shop', coll: 'a.b' });
  });

  it('toggles databases and collections across databases of one connection', () => {
    let s = toggleItem(emptySelection(), 'c1', db('shop'));
    s = toggleItem(s, 'c1', coll('crm', 'leads'));
    expect([...s.keys]).toEqual([db('shop'), coll('crm', 'leads')]);
    s = toggleItem(s, 'c1', db('shop'));
    expect([...s.keys]).toEqual([coll('crm', 'leads')]);
  });

  it('starts over when toggling on another connection', () => {
    let s = toggleItem(emptySelection(), 'c1', db('shop'));
    s = toggleItem(s, 'c2', db('logs'));
    expect(s.connectionId).toBe('c2');
    expect([...s.keys]).toEqual([db('logs')]);
  });

  it('selects the visible range between the anchor and the target, either direction', () => {
    const order = [coll('a', 'w'), coll('a', 'x'), coll('a', 'y'), coll('a', 'z')];
    let s = toggleItem(emptySelection(), 'c1', coll('a', 'x'));
    s = selectRange(s, 'c1', order, coll('a', 'z'));
    expect([...s.keys]).toEqual([coll('a', 'x'), coll('a', 'y'), coll('a', 'z')]);
    // The anchor stays put, so a second shift-click re-ranges from it.
    s = selectRange(s, 'c1', order, coll('a', 'w'));
    expect([...s.keys]).toEqual([coll('a', 'w'), coll('a', 'x')]);
  });

  it('a range from a collection takes only collections, so no database between is swept in', () => {
    const order = [db('a'), coll('a', 'x'), coll('a', 'y'), db('b'), db('c'), coll('c', 'z')];
    let s = toggleItem(emptySelection(), 'c1', coll('a', 'x'));
    s = selectRange(s, 'c1', order, coll('c', 'z'));
    expect([...s.keys]).toEqual([coll('a', 'x'), coll('a', 'y'), coll('c', 'z')]);
  });

  it('a range from a database takes only databases, plus the row clicked', () => {
    const order = [db('a'), coll('a', 'x'), db('b'), db('c'), coll('c', 'z')];
    let s = toggleItem(emptySelection(), 'c1', db('a'));
    s = selectRange(s, 'c1', order, db('c'));
    expect([...s.keys]).toEqual([db('a'), db('b'), db('c')]);
    s = selectRange(s, 'c1', order, coll('c', 'z'));
    expect([...s.keys]).toEqual([db('a'), db('b'), db('c'), coll('c', 'z')]);
  });

  it('a shift-click with no anchor on this connection selects just the target', () => {
    const s = selectRange(emptySelection(), 'c1', [db('a'), db('b')], db('b'));
    expect([...s.keys]).toEqual([db('b')]);
  });

  it('a plain click clears the selection but becomes the range anchor', () => {
    // clearToAnchor drops whatever was selected before; it takes no selection in.
    let s = clearToAnchor('c1', db('b'));
    expect(s.keys.size).toBe(0);
    s = selectRange(s, 'c1', [db('a'), db('b'), db('c')], db('c'));
    expect([...s.keys]).toEqual([db('b'), db('c')]);
  });

  it('lists the selected collections of one database', () => {
    let s = toggleItem(emptySelection(), 'c1', coll('a', 'x'));
    s = toggleItem(s, 'c1', coll('b', 'y'));
    s = toggleItem(s, 'c1', db('a'));
    expect(selectedCollectionsIn(s, 'c1', 'a')).toEqual(['x']);
    expect(selectedCollectionsIn(s, 'c2', 'a')).toEqual([]);
  });

  describe('multi-select toggle modifier', () => {
    it.each(['Win32', 'Linux x86_64'])('is Ctrl on %s, not Meta', (platform) => {
      expect(isMultiSelectToggle({ ctrlKey: true, metaKey: false }, platform)).toBe(true);
      expect(isMultiSelectToggle({ ctrlKey: false, metaKey: true }, platform)).toBe(false);
    });

    it('is Cmd (Meta) on macOS, not Ctrl', () => {
      expect(isMultiSelectToggle({ ctrlKey: false, metaKey: true }, 'MacIntel')).toBe(true);
      // Ctrl+click on a Mac is a secondary click, never a toggle.
      expect(isMultiSelectToggle({ ctrlKey: true, metaKey: false }, 'MacIntel')).toBe(false);
    });
  });
});
