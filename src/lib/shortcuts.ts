import type { TFunction } from 'i18next';

export type ShortcutGroup =
  | 'navigation'
  | 'tabs'
  | 'query-editor'
  | 'sidebar'
  | 'zoom'
  | 'command-palette';

// Keys into shell:keyboardShortcuts.groups — resolved at the call site
// (KeyboardShortcutsSettings.tsx, and filterKeyboardShortcuts's haystack)
// because this is a module-level constant and cannot call the useTranslation
// hook. Matches the TOOL_LABEL_KEYS pattern in ToolSetupDialog.tsx.
//
// Namespace-qualified on purpose. This module has no `useTranslation('shell')`
// context, so once `filterKeyboardShortcuts` started resolving these keys the
// extractor statically read the map and filed all five under the DEFAULT
// namespace (`common`), where they do not exist. An explicit `shell:` prefix
// resolves identically at the existing call site and pins the extraction.
export const SHORTCUT_GROUP_LABEL_KEYS: Record<ShortcutGroup, string> = {
  navigation: 'shell:keyboardShortcuts.groups.navigation',
  tabs: 'shell:keyboardShortcuts.groups.tabs',
  'query-editor': 'shell:keyboardShortcuts.groups.query-editor',
  sidebar: 'shell:keyboardShortcuts.groups.sidebar',
  zoom: 'shell:keyboardShortcuts.groups.zoom',
  'command-palette': 'shell:keyboardShortcuts.groups.command-palette',
};

export const SHORTCUT_GROUP_ORDER: ShortcutGroup[] = [
  'navigation',
  'tabs',
  'query-editor',
  'sidebar',
  'zoom',
  'command-palette',
];

export interface ShortcutChord {
  mod?: boolean;
  /** The Control key itself, on macOS too (Ctrl+Tab), unlike `mod`. */
  ctrl?: boolean;
  key: string;
  shift?: boolean;
  /** Only listed on that platform. */
  platform?: 'mac' | 'other';
}

export interface KeyboardShortcut {
  id: string;
  group: ShortcutGroup;
  /** Key into shell:keyboardShortcuts.items — translated at the call site
   *  (this is a module-level constant and cannot call the useTranslation
   *  hook), same pattern as SHORTCUT_GROUP_LABEL_KEYS above. */
  labelKey: string;
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
  if (chord.ctrl) parts.push(isMacPlatform(platform) ? '⌃' : 'Ctrl');
  if (chord.mod) parts.push(mod);
  if (chord.shift) parts.push('Shift');
  parts.push(displayKey(chord.key));
  return parts.join(' ');
}

export function formatShortcut(shortcut: KeyboardShortcut, platform = navigator.platform): string {
  const onPlatform = isMacPlatform(platform) ? 'mac' : 'other';
  return shortcut.chords
    .filter((chord) => !chord.platform || chord.platform === onPlatform)
    .map((chord) => formatShortcutChord(chord, platform))
    .join(' / ');
}

export const KEYBOARD_SHORTCUTS: KeyboardShortcut[] = [
  {
    id: 'close-dialog',
    group: 'navigation',
    labelKey: 'keyboardShortcuts.items.close-dialog',
    chords: [{ key: 'Escape' }],
    keywords: 'dismiss cancel overlay',
  },
  {
    id: 'open-settings',
    group: 'navigation',
    labelKey: 'keyboardShortcuts.items.open-settings',
    chords: [{ mod: true, key: ',' }],
    keywords: 'settings preferences options',
  },
  {
    id: 'tab-close',
    group: 'tabs',
    labelKey: 'keyboardShortcuts.items.tab-close',
    chords: [{ mod: true, key: 'W' }],
    keywords: 'close tab',
  },
  {
    id: 'tab-new',
    group: 'tabs',
    labelKey: 'keyboardShortcuts.items.tab-new',
    chords: [{ mod: true, key: 'T' }],
    keywords: 'new tab open',
  },
  {
    id: 'tab-reopen',
    group: 'tabs',
    labelKey: 'keyboardShortcuts.items.tab-reopen',
    chords: [{ mod: true, shift: true, key: 'T' }],
    keywords: 'reopen restore undo closed tab',
  },
  {
    id: 'tab-next',
    group: 'tabs',
    labelKey: 'keyboardShortcuts.items.tab-next',
    chords: [
      { ctrl: true, key: 'Tab' },
      { mod: true, shift: true, key: ']', platform: 'mac' },
      { ctrl: true, key: 'PageDown', platform: 'other' },
    ],
    keywords: 'next tab switch cycle',
  },
  {
    id: 'tab-prev',
    group: 'tabs',
    labelKey: 'keyboardShortcuts.items.tab-prev',
    chords: [
      { ctrl: true, shift: true, key: 'Tab' },
      { mod: true, shift: true, key: '[', platform: 'mac' },
      { ctrl: true, key: 'PageUp', platform: 'other' },
    ],
    keywords: 'previous tab switch cycle',
  },
  {
    id: 'tab-select',
    group: 'tabs',
    labelKey: 'keyboardShortcuts.items.tab-select',
    chords: [{ mod: true, key: '1–8' }],
    keywords: 'jump go to tab number',
  },
  {
    id: 'tab-last',
    group: 'tabs',
    labelKey: 'keyboardShortcuts.items.tab-last',
    chords: [{ mod: true, key: '9' }],
    keywords: 'jump go to last tab',
  },
  {
    id: 'window-close',
    group: 'tabs',
    labelKey: 'keyboardShortcuts.items.window-close',
    chords: [{ mod: true, shift: true, key: 'W' }],
    keywords: 'close window',
  },
  {
    id: 'run-query',
    group: 'query-editor',
    labelKey: 'keyboardShortcuts.items.run-query',
    chords: [{ mod: true, key: 'Enter' }],
    keywords: 'execute mongosh shell builder',
  },
  {
    id: 'submit-dialog',
    group: 'query-editor',
    labelKey: 'keyboardShortcuts.items.submit-dialog',
    chords: [{ mod: true, key: 'Enter' }],
    keywords: 'connection import prompt',
  },
  {
    id: 'sidebar-search',
    group: 'sidebar',
    labelKey: 'keyboardShortcuts.items.sidebar-search',
    chords: [{ mod: true, key: 'F' }],
    keywords: 'filter find tree',
  },
  {
    id: 'zoom-in',
    group: 'zoom',
    labelKey: 'keyboardShortcuts.items.zoom-in',
    chords: [{ mod: true, key: '+' }],
    keywords: 'magnify dpi scale',
  },
  {
    id: 'zoom-out',
    group: 'zoom',
    labelKey: 'keyboardShortcuts.items.zoom-out',
    chords: [{ mod: true, key: '−' }],
    keywords: 'shrink dpi scale',
  },
  {
    id: 'zoom-reset',
    group: 'zoom',
    labelKey: 'keyboardShortcuts.items.zoom-reset',
    chords: [{ mod: true, key: '0' }],
    keywords: 'default dpi scale status bar',
  },
  {
    id: 'palette-open',
    group: 'command-palette',
    labelKey: 'keyboardShortcuts.items.palette-open',
    chords: [{ mod: true, key: 'K' }],
    keywords: 'search commands collections queries',
  },
  {
    id: 'palette-navigate',
    group: 'command-palette',
    labelKey: 'keyboardShortcuts.items.palette-navigate',
    chords: [{ key: '↑' }, { key: '↓' }],
    keywords: 'arrow up down move',
  },
  {
    id: 'palette-run',
    group: 'command-palette',
    labelKey: 'keyboardShortcuts.items.palette-run',
    chords: [{ key: 'Enter' }],
    keywords: 'select execute',
  },
  {
    id: 'palette-close',
    group: 'command-palette',
    labelKey: 'keyboardShortcuts.items.palette-close',
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

/** Each row's `labelKey` is a key into shell:keyboardShortcuts.items —
 *  translated at the call site (QuickStart.tsx), since this is a plain
 *  function and cannot call the useTranslation hook. */
export function quickStartShortcutRows(platform = navigator.platform) {
  const zoomIn = KEYBOARD_SHORTCUTS.find((s) => s.id === 'zoom-in')!;
  const zoomOut = KEYBOARD_SHORTCUTS.find((s) => s.id === 'zoom-out')!;
  const rows = QUICK_START_SHORTCUT_IDS.filter((id) => id !== 'zoom-out').map((id) => {
    const shortcut = KEYBOARD_SHORTCUTS.find((s) => s.id === id)!;
    if (id === 'zoom-in') {
      return {
        id,
        keys: `${formatShortcutChord(zoomIn.chords[0], platform)} / ${formatShortcutChord(zoomOut.chords[0], platform)}`,
        labelKey: 'keyboardShortcuts.items.zoom-in-out',
      };
    }
    return {
      id,
      keys: formatShortcut(shortcut, platform),
      labelKey: shortcut.labelKey,
    };
  });
  return rows;
}

/** The three zoom chords, joined. The trailing "to reset" that used to live
 *  here was English baked into a value interpolated INTO a translated string
 *  (`settings:appearance.zoomShortcutHint`), so a German user read
 *  "Tastenkürzel: ⌘+ / ⌘- / ⌘0 to reset". The wording now lives in the catalog
 *  entry and this function returns chords only. */
export function formatZoomShortcutHint(platform = navigator.platform): string {
  const zoomIn = shortcutById('zoom-in')!;
  const zoomOut = shortcutById('zoom-out')!;
  const zoomReset = shortcutById('zoom-reset')!;
  return `${formatShortcutChord(zoomIn.chords[0], platform)} / ${formatShortcutChord(zoomOut.chords[0], platform)} / ${formatShortcutChord(zoomReset.chords[0], platform)}`;
}

export function shortcutById(id: string): KeyboardShortcut | undefined {
  return KEYBOARD_SHORTCUTS.find((s) => s.id === id);
}

export function filterKeyboardShortcuts(
  query: string,
  shortcuts: KeyboardShortcut[] = KEYBOARD_SHORTCUTS,
  platform = navigator.platform,
  t?: TFunction,
): KeyboardShortcut[] {
  const q = query.trim().toLowerCase();
  if (!q) return shortcuts;
  return shortcuts.filter((shortcut) => {
    // Search the RESOLVED labels, not the catalog key paths. Matching on
    // `labelKey` made every visible word unsearchable ("interface", "focus",
    // "modal" returned nothing) while making key fragments match everything
    // ("keyboard" hit all 11 rows, since every key contains
    // `keyboardShortcuts.items.`). `t` is optional so the function stays
    // callable from a plain module; without it we fall back to the key text,
    // which is at least stable. `keywords` stays in the haystack so English
    // technical terms keep working in a German UI.
    const haystack = [
      t ? t(shortcut.labelKey) : shortcut.labelKey,
      shortcut.keywords ?? '',
      t
        ? t(SHORTCUT_GROUP_LABEL_KEYS[shortcut.group])
        : SHORTCUT_GROUP_LABEL_KEYS[shortcut.group],
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
