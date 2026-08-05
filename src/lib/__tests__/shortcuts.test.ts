import { describe, it, expect } from 'vitest';
import {
  filterKeyboardShortcuts,
  formatShortcut,
  formatShortcutChord,
  groupKeyboardShortcuts,
  primaryShortcutModifier,
  quickStartShortcutRows,
  shortcutById,
} from '../shortcuts';

describe('shortcuts', () => {
  it('uses platform-aware modifier labels', () => {
    expect(primaryShortcutModifier('MacIntel')).toBe('⌘');
    expect(primaryShortcutModifier('Win32')).toBe('Ctrl');
    expect(formatShortcutChord({ mod: true, key: 'K' }, 'MacIntel')).toBe('⌘ K');
    expect(formatShortcutChord({ mod: true, key: 'K' }, 'Win32')).toBe('Ctrl K');
  });

  it('formats known shortcuts for settings display', () => {
    const run = shortcutById('run-query')!;
    expect(formatShortcut(run, 'Win32')).toBe('Ctrl ↵');
    expect(formatShortcut(shortcutById('palette-navigate')!, 'MacIntel')).toBe('↑ / ↓');
  });

  it('filters shortcuts by label, group, and keys', () => {
    expect(filterKeyboardShortcuts('sidebar', undefined, 'Win32').map((s) => s.id)).toEqual([
      'sidebar-search',
    ]);
    expect(filterKeyboardShortcuts('zoom', undefined, 'Win32').length).toBeGreaterThan(0);
    expect(filterKeyboardShortcuts('nope', undefined, 'Win32')).toEqual([]);
  });

  it('searches the RESOLVED labels, not the catalog key paths', async () => {
    // Regression: the haystack was switched from `shortcut.label` to
    // `shortcut.labelKey`, so every word the user could actually SEE became
    // unsearchable ("interface", "focus", "modal" returned nothing) while key
    // fragments matched everything ("keyboard" hit all 11 rows, because every
    // key contains `keyboardShortcuts.items.`). The old assertions above kept
    // passing because 'sidebar'/'zoom' happen to appear in both the key and
    // the label.
    const { i18next } = await import('@/lib/i18n');
    const t = i18next.getFixedT('en', 'shell');

    expect(filterKeyboardShortcuts('interface', undefined, 'Win32', t).map((s) => s.id)).toEqual([
      'zoom-in',
      'zoom-out',
      'zoom-reset',
    ]);
    expect(filterKeyboardShortcuts('topmost', undefined, 'Win32', t).map((s) => s.id)).toEqual([
      'close-dialog',
    ]);
    // A key-path fragment must NOT match every row any more.
    expect(filterKeyboardShortcuts('items', undefined, 'Win32', t)).toEqual([]);
  });

  it('searches German labels under a German locale', async () => {
    const { i18next } = await import('@/lib/i18n');
    const t = i18next.getFixedT('de', 'shell');
    // "Oberfläche" is the German for the zoom shortcuts' label text; no German
    // word could ever match while the haystack held key paths.
    expect(filterKeyboardShortcuts('oberfläche', undefined, 'Win32', t).length).toBeGreaterThan(0);
    // English technical terms still work in a German UI via `keywords`.
    expect(filterKeyboardShortcuts('zoom', undefined, 'Win32', t).length).toBeGreaterThan(0);
  });

  it('groups shortcuts in stable section order', () => {
    const grouped = groupKeyboardShortcuts(filterKeyboardShortcuts(''));
    expect(grouped.navigation[0]?.id).toBe('close-dialog');
    expect(grouped['command-palette'].some((s) => s.id === 'palette-open')).toBe(true);
  });

  it('builds quick start rows with combined zoom keys', () => {
    const rows = quickStartShortcutRows('Win32');
    expect(rows.find((r) => r.id === 'sidebar-search')?.keys).toBe('Ctrl F');
    expect(rows.find((r) => r.id === 'zoom-in')?.keys).toBe('Ctrl + / Ctrl −');
  });
});
