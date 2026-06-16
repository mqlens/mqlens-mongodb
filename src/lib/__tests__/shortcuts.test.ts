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
