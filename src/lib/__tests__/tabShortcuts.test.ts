import { describe, it, expect } from 'vitest';
import { tabCommandForKey, tabCommandFromMenu, targetTabId } from '../tabShortcuts';

const key = (init: Partial<KeyboardEvent> & { key: string }) => ({
  code: '',
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  defaultPrevented: false,
  ...init,
});

describe('tabCommandForKey on Windows/Linux', () => {
  it('maps the Ctrl chords', () => {
    expect(tabCommandForKey(key({ key: 'w', ctrlKey: true }), false)).toEqual({ type: 'close-tab' });
    expect(tabCommandForKey(key({ key: 'W', ctrlKey: true, shiftKey: true }), false)).toBeNull();
    expect(tabCommandForKey(key({ key: 't', ctrlKey: true }), false)).toEqual({ type: 'new-tab' });
    expect(tabCommandForKey(key({ key: 'T', ctrlKey: true, shiftKey: true }), false)).toEqual({ type: 'reopen-closed-tab' });
    expect(tabCommandForKey(key({ key: 'Tab', ctrlKey: true }), false)).toEqual({ type: 'next-tab' });
    expect(tabCommandForKey(key({ key: 'Tab', ctrlKey: true, shiftKey: true }), false)).toEqual({ type: 'prev-tab' });
    expect(tabCommandForKey(key({ key: 'PageDown', ctrlKey: true }), false)).toEqual({ type: 'next-tab' });
    expect(tabCommandForKey(key({ key: 'PageUp', ctrlKey: true }), false)).toEqual({ type: 'prev-tab' });
    expect(tabCommandForKey(key({ key: '3', code: 'Digit3', ctrlKey: true }), false)).toEqual({ type: 'select-tab', index: 2 });
    expect(tabCommandForKey(key({ key: '9', code: 'Digit9', ctrlKey: true }), false)).toEqual({ type: 'select-last-tab' });
  });

  it('ignores Meta, Alt, already-handled events and unrelated keys', () => {
    expect(tabCommandForKey(key({ key: 'w', metaKey: true }), false)).toBeNull();
    expect(tabCommandForKey(key({ key: 'w', ctrlKey: true, altKey: true }), false)).toBeNull();
    expect(tabCommandForKey(key({ key: 'w', ctrlKey: true, defaultPrevented: true }), false)).toBeNull();
    expect(tabCommandForKey(key({ key: 'k', ctrlKey: true }), false)).toBeNull();
    expect(tabCommandForKey(key({ key: '0', code: 'Digit0', ctrlKey: true }), false)).toBeNull();
    expect(tabCommandForKey(key({ key: 'w' }), false)).toBeNull();
  });

  it('matches digits by physical key, so AZERTY Ctrl+& is tab 1', () => {
    expect(tabCommandForKey(key({ key: '&', code: 'Digit1', ctrlKey: true }), false)).toEqual({ type: 'select-tab', index: 0 });
  });
});

describe('tabCommandForKey on macOS', () => {
  it('leaves the chords the native menu owns to the menu', () => {
    expect(tabCommandForKey(key({ key: 'w', metaKey: true }), true)).toBeNull();
    expect(tabCommandForKey(key({ key: 't', metaKey: true }), true)).toBeNull();
    expect(tabCommandForKey(key({ key: 'T', metaKey: true, shiftKey: true }), true)).toBeNull();
  });

  it('binds nothing to Cmd+Shift+W', () => {
    expect(tabCommandForKey(key({ key: 'W', code: 'KeyW', metaKey: true, shiftKey: true }), true)).toBeNull();
  });

  it('handles the chords the menu does not list', () => {
    expect(tabCommandForKey(key({ key: '}', code: 'BracketRight', metaKey: true, shiftKey: true }), true)).toEqual({ type: 'next-tab' });
    expect(tabCommandForKey(key({ key: '{', code: 'BracketLeft', metaKey: true, shiftKey: true }), true)).toEqual({ type: 'prev-tab' });
    expect(tabCommandForKey(key({ key: 'Tab', ctrlKey: true }), true)).toEqual({ type: 'next-tab' });
    expect(tabCommandForKey(key({ key: '2', code: 'Digit2', metaKey: true }), true)).toEqual({ type: 'select-tab', index: 1 });
  });

  it('does not treat Ctrl as the primary modifier', () => {
    expect(tabCommandForKey(key({ key: '2', code: 'Digit2', ctrlKey: true }), true)).toBeNull();
  });
});

describe('open settings', () => {
  it('maps Ctrl+, off macOS and leaves Cmd+, to the menu on macOS', () => {
    expect(tabCommandForKey(key({ key: ',', code: 'Comma', ctrlKey: true }), false)).toEqual({ type: 'open-settings' });
    expect(tabCommandForKey(key({ key: ',', code: 'Comma', metaKey: true }), true)).toBeNull();
    expect(tabCommandFromMenu('open-settings')).toEqual({ type: 'open-settings' });
  });
});

describe('tabCommandFromMenu', () => {
  it('accepts only the menu ids', () => {
    expect(tabCommandFromMenu('close-tab')).toEqual({ type: 'close-tab' });
    expect(tabCommandFromMenu('reopen-closed-tab')).toEqual({ type: 'reopen-closed-tab' });
    expect(tabCommandFromMenu('select-tab')).toBeNull();
    expect(tabCommandFromMenu(undefined)).toBeNull();
  });
});

describe('targetTabId', () => {
  const ids = ['a', 'b', 'c'];

  it('cycles with wrap-around', () => {
    expect(targetTabId(ids, 'c', { type: 'next-tab' })).toBe('a');
    expect(targetTabId(ids, 'a', { type: 'prev-tab' })).toBe('c');
    expect(targetTabId(['a'], 'a', { type: 'next-tab' })).toBeNull();
  });

  it('jumps by position, and 9 means last', () => {
    expect(targetTabId(ids, 'a', { type: 'select-tab', index: 1 })).toBe('b');
    expect(targetTabId(ids, 'a', { type: 'select-tab', index: 5 })).toBeNull();
    expect(targetTabId(ids, 'a', { type: 'select-last-tab' })).toBe('c');
    expect(targetTabId([], null, { type: 'select-last-tab' })).toBeNull();
  });
});
