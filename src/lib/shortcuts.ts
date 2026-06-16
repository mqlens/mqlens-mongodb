export type ShortcutGroup =
  | 'navigation'
  | 'query-editor'
  | 'sidebar'
  | 'zoom'
  | 'command-palette';

export const SHORTCUT_GROUP_LABELS: Record<ShortcutGroup, string> = {
  navigation: 'Navigation',
  'query-editor': 'Query editor',
  sidebar: 'Sidebar',
  zoom: 'Zoom',
  'command-palette': 'Command palette',
};

export const SHORTCUT_GROUP_ORDER: ShortcutGroup[] = [
  'navigation',
  'query-editor',
  'sidebar',
  'zoom',
  'command-palette',
];

export interface ShortcutChord {
  mod?: boolean;
  key: string;
  shift?: boolean;
}

export interface KeyboardShortcut {
  id: string;
  group: ShortcutGroup;
  label: string;
  keywords?: string;
  chords: ShortcutChord[];
}

export function isMacPlatform(platform = navigator.platform): boolean {
  return /Mac|iPhone|iPad|iPod/i.test(platform);
}

export function primaryShortcutModifier(platform = navigator.platform): '⌘' | 'Ctrl' {
  return isMacPlatform(platform) ? '⌘' : 'Ctrl';
}

const DISPLAY_KEYS: Record<string, string> = {
  Enter: '↵',
  Escape: 'esc',
};

function displayKey(key: string): string {
  return DISPLAY_KEYS[key] ?? key;
}

export function formatShortcutChord(chord: ShortcutChord, platform = navigator.platform): string {
  const mod = primaryShortcutModifier(platform);
  const parts: string[] = [];
  if (chord.mod) parts.push(mod);
  if (chord.shift) parts.push('Shift');
  parts.push(displayKey(chord.key));
  return parts.join(' ');
}

export function formatShortcut(shortcut: KeyboardShortcut, platform = navigator.platform): string {
  return shortcut.chords.map((chord) => formatShortcutChord(chord, platform)).join(' / ');
}

export const KEYBOARD_SHORTCUTS: KeyboardShortcut[] = [
  {
    id: 'close-dialog',
    group: 'navigation',
    label: 'Close the topmost dialog or modal',
    chords: [{ key: 'Escape' }],
    keywords: 'dismiss cancel overlay',
  },
  {
    id: 'run-query',
    group: 'query-editor',
    label: 'Run the current query',
    chords: [{ mod: true, key: 'Enter' }],
    keywords: 'execute mongosh shell builder',
  },
  {
    id: 'submit-dialog',
    group: 'query-editor',
    label: 'Submit a multi-line dialog (import URI, prompts)',
    chords: [{ mod: true, key: 'Enter' }],
    keywords: 'connection import prompt',
  },
  {
    id: 'sidebar-search',
    group: 'sidebar',
    label: 'Focus sidebar tree search',
    chords: [{ mod: true, key: 'F' }],
    keywords: 'filter find tree',
  },
  {
    id: 'zoom-in',
    group: 'zoom',
    label: 'Zoom interface in',
    chords: [{ mod: true, key: '+' }],
    keywords: 'magnify dpi scale',
  },
  {
    id: 'zoom-out',
    group: 'zoom',
    label: 'Zoom interface out',
    chords: [{ mod: true, key: '−' }],
    keywords: 'shrink dpi scale',
  },
  {
    id: 'zoom-reset',
    group: 'zoom',
    label: 'Reset interface zoom to 100%',
    chords: [{ mod: true, key: '0' }],
    keywords: 'default dpi scale status bar',
  },
  {
    id: 'palette-open',
    group: 'command-palette',
    label: 'Open or close command palette',
    chords: [{ mod: true, key: 'K' }],
    keywords: 'search commands collections queries',
  },
  {
    id: 'palette-navigate',
    group: 'command-palette',
    label: 'Navigate palette results',
    chords: [{ key: '↑' }, { key: '↓' }],
    keywords: 'arrow up down move',
  },
  {
    id: 'palette-run',
    group: 'command-palette',
    label: 'Run the selected palette action',
    chords: [{ key: 'Enter' }],
    keywords: 'select execute',
  },
  {
    id: 'palette-close',
    group: 'command-palette',
    label: 'Close command palette',
    chords: [{ key: 'Escape' }],
    keywords: 'dismiss cancel',
  },
];

export const QUICK_START_SHORTCUT_IDS = [
  'run-query',
  'sidebar-search',
  'palette-open',
  'zoom-in',
  'zoom-out',
] as const;

export function quickStartShortcutRows(platform = navigator.platform) {
  const zoomIn = KEYBOARD_SHORTCUTS.find((s) => s.id === 'zoom-in')!;
  const zoomOut = KEYBOARD_SHORTCUTS.find((s) => s.id === 'zoom-out')!;
  const rows = QUICK_START_SHORTCUT_IDS.filter((id) => id !== 'zoom-out').map((id) => {
    const shortcut = KEYBOARD_SHORTCUTS.find((s) => s.id === id)!;
    if (id === 'zoom-in') {
      return {
        id,
        keys: `${formatShortcutChord(zoomIn.chords[0], platform)} / ${formatShortcutChord(zoomOut.chords[0], platform)}`,
        label: 'Zoom interface in or out',
      };
    }
    return {
      id,
      keys: formatShortcut(shortcut, platform),
      label: shortcut.label,
    };
  });
  return rows;
}

export function formatZoomShortcutHint(platform = navigator.platform): string {
  const zoomIn = shortcutById('zoom-in')!;
  const zoomOut = shortcutById('zoom-out')!;
  const zoomReset = shortcutById('zoom-reset')!;
  return `${formatShortcutChord(zoomIn.chords[0], platform)} / ${formatShortcutChord(zoomOut.chords[0], platform)} / ${formatShortcutChord(zoomReset.chords[0], platform)} to reset`;
}

export function shortcutById(id: string): KeyboardShortcut | undefined {
  return KEYBOARD_SHORTCUTS.find((s) => s.id === id);
}

export function filterKeyboardShortcuts(
  query: string,
  shortcuts: KeyboardShortcut[] = KEYBOARD_SHORTCUTS,
  platform = navigator.platform,
): KeyboardShortcut[] {
  const q = query.trim().toLowerCase();
  if (!q) return shortcuts;
  return shortcuts.filter((shortcut) => {
    const haystack = [
      shortcut.label,
      shortcut.keywords ?? '',
      SHORTCUT_GROUP_LABELS[shortcut.group],
      formatShortcut(shortcut, platform),
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(q);
  });
}

export function groupKeyboardShortcuts(
  shortcuts: KeyboardShortcut[],
): Record<ShortcutGroup, KeyboardShortcut[]> {
  const grouped = Object.fromEntries(
    SHORTCUT_GROUP_ORDER.map((group) => [group, [] as KeyboardShortcut[]]),
  ) as Record<ShortcutGroup, KeyboardShortcut[]>;
  for (const shortcut of shortcuts) {
    grouped[shortcut.group].push(shortcut);
  }
  return grouped;
}
