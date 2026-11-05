/**
 * Tab and window shortcuts: the browser / VS Code set, scoped to the focused
 * window's focused pane.
 *
 * On macOS the native app menu (`src-tauri/src/app_menu.rs`) owns the chords it
 * lists and delivers them as a `tab-command` event, because a menu key
 * equivalent wins over the page. The keydown path leaves those alone there, or
 * a press could run twice; everywhere else it handles the whole set.
 */

export type TabCommand =
  | { type: 'close-tab' }
  | { type: 'new-tab' }
  | { type: 'reopen-closed-tab' }
  | { type: 'next-tab' }
  | { type: 'prev-tab' }
  | { type: 'select-tab'; index: number }
  | { type: 'select-last-tab' }
  | { type: 'open-settings' };

export const TAB_COMMAND_EVENT = 'tab-command';

const MENU_COMMANDS = ['close-tab', 'new-tab', 'reopen-closed-tab', 'open-settings'] as const;

/** The payload of a native menu `tab-command` event, or null for anything else. */
export function tabCommandFromMenu(payload: unknown): TabCommand | null {
  return (MENU_COMMANDS as readonly unknown[]).includes(payload)
    ? ({ type: payload } as TabCommand)
    : null;
}

type KeyLike = Pick<
  KeyboardEvent,
  'key' | 'code' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'defaultPrevented'
>;

export function tabCommandForKey(event: KeyLike, mac: boolean): TabCommand | null {
  if (event.defaultPrevented || event.altKey) return null;
  const command = matchKey(event, mac);
  if (command && mac && (MENU_COMMANDS as readonly string[]).includes(command.type)) return null;
  return command;
}

function matchKey(event: KeyLike, mac: boolean): TabCommand | null {
  const { key, code, shiftKey } = event;
  // Literal Control, the same on every platform: Ctrl+Tab, Ctrl+PageDown.
  if (event.ctrlKey && !event.metaKey) {
    if (key === 'Tab') return { type: shiftKey ? 'prev-tab' : 'next-tab' };
    if (!shiftKey && key === 'PageDown') return { type: 'next-tab' };
    if (!shiftKey && key === 'PageUp') return { type: 'prev-tab' };
  }

  const primary = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!primary) return null;

  if (mac && shiftKey && code === 'BracketRight') return { type: 'next-tab' };
  if (mac && shiftKey && code === 'BracketLeft') return { type: 'prev-tab' };

  const letter = key.toLowerCase();
  if (letter === 'w') return shiftKey ? null : { type: 'close-tab' };
  if (letter === 't') return { type: shiftKey ? 'reopen-closed-tab' : 'new-tab' };
  if (!shiftKey && (key === ',' || code === 'Comma')) return { type: 'open-settings' };

  if (shiftKey) return null;
  // `code` so a layout that types digits with Shift (AZERTY) still matches.
  const digit = /^Digit([1-9])$/.exec(code)?.[1] ?? (/^[1-9]$/.test(key) ? key : undefined);
  if (!digit) return null;
  return digit === '9' ? { type: 'select-last-tab' } : { type: 'select-tab', index: Number(digit) - 1 };
}

/** The tab a cycle/jump command lands on, or null when it has nowhere to go. */
export function targetTabId(
  tabIds: string[],
  activeTabId: string | null,
  command: TabCommand,
): string | null {
  if (tabIds.length === 0) return null;
  switch (command.type) {
    case 'next-tab':
    case 'prev-tab': {
      if (tabIds.length < 2) return null;
      const i = Math.max(0, tabIds.indexOf(activeTabId ?? ''));
      const step = command.type === 'next-tab' ? 1 : -1;
      return tabIds[(i + step + tabIds.length) % tabIds.length];
    }
    case 'select-tab':
      return tabIds[command.index] ?? null;
    case 'select-last-tab':
      return tabIds[tabIds.length - 1];
    default:
      return null;
  }
}
