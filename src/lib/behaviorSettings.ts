// Settings → Behavior: how the app acts by default, as opposed to how it looks.
// Stored in localStorage and read synchronously, so non-React code (opening a
// tab, expanding a tree node) can consult it at the moment it acts.
import { useSyncExternalStore } from 'react';

export const BEHAVIOR_SETTINGS_KEY = 'mqlens.behavior';
const BEHAVIOR_CHANGED_EVENT = 'mqlens:behavior-changed';

/** Page sizes offered by the results pager and by the default-page-size setting. */
export const PAGE_SIZE_OPTIONS = [25, 50, 100, 200] as const;

/** Result views that can be the default. Chart is left out: it needs a
 *  configuration of its own before it shows anything. */
export const DEFAULT_VIEW_MODE_OPTIONS = ['table', 'tree', 'json'] as const;
export type DefaultViewMode = (typeof DEFAULT_VIEW_MODE_OPTIONS)[number];

export interface BehaviorSettings {
  /** The results view a collection opens in, until the tab picks its own. */
  defaultViewMode: DefaultViewMode;
  /** Documents loaded per page when a collection is opened. */
  pageSize: number;
  /** Opening a database in the tree also opens its Collections folder. */
  expandCollectionsOnDbOpen: boolean;
  /** A 24-hex string compared against an ObjectId-typed field is sent as an ObjectId. */
  autoConvertObjectId: boolean;
  /** A bare ObjectId typed into the query field runs as `{ _id: ObjectId(…) }`. */
  defaultIdSearch: boolean;
}

export const DEFAULT_BEHAVIOR_SETTINGS: BehaviorSettings = {
  defaultViewMode: 'json',
  pageSize: 50,
  expandCollectionsOnDbOpen: false,
  autoConvertObjectId: true,
  defaultIdSearch: true,
};

function normalize(raw: unknown): BehaviorSettings {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const bool = (key: 'expandCollectionsOnDbOpen' | 'autoConvertObjectId' | 'defaultIdSearch'): boolean =>
    typeof src[key] === 'boolean' ? (src[key] as boolean) : DEFAULT_BEHAVIOR_SETTINGS[key];
  return {
    defaultViewMode: (DEFAULT_VIEW_MODE_OPTIONS as readonly unknown[]).includes(src.defaultViewMode)
      ? (src.defaultViewMode as DefaultViewMode)
      : DEFAULT_BEHAVIOR_SETTINGS.defaultViewMode,
    pageSize: (PAGE_SIZE_OPTIONS as readonly number[]).includes(src.pageSize as number)
      ? (src.pageSize as number)
      : DEFAULT_BEHAVIOR_SETTINGS.pageSize,
    expandCollectionsOnDbOpen: bool('expandCollectionsOnDbOpen'),
    autoConvertObjectId: bool('autoConvertObjectId'),
    defaultIdSearch: bool('defaultIdSearch'),
  };
}

// useSyncExternalStore needs a stable snapshot, so the parsed value is cached
// against the raw string it came from.
let cachedRaw: string | null | undefined;
let cached: BehaviorSettings = DEFAULT_BEHAVIOR_SETTINGS;

export function getBehaviorSettings(): BehaviorSettings {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(BEHAVIOR_SETTINGS_KEY);
  } catch {
    /* localStorage unavailable — defaults apply */
  }
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    try {
      cached = normalize(raw ? JSON.parse(raw) : null);
    } catch {
      cached = DEFAULT_BEHAVIOR_SETTINGS;
    }
  }
  return cached;
}

export function updateBehaviorSettings(partial: Partial<BehaviorSettings>): void {
  const next = normalize({ ...getBehaviorSettings(), ...partial });
  try {
    localStorage.setItem(BEHAVIOR_SETTINGS_KEY, JSON.stringify(next));
  } catch {
    /* localStorage unavailable — best-effort persistence only */
  }
  window.dispatchEvent(new Event(BEHAVIOR_CHANGED_EVENT));
}

function subscribe(onChange: () => void): () => void {
  // `storage` covers the other windows (detached tabs); the custom event covers
  // this one, where `storage` does not fire.
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === BEHAVIOR_SETTINGS_KEY) onChange();
  };
  window.addEventListener(BEHAVIOR_CHANGED_EVENT, onChange);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(BEHAVIOR_CHANGED_EVENT, onChange);
    window.removeEventListener('storage', onStorage);
  };
}

export function useBehaviorSettings(): BehaviorSettings {
  return useSyncExternalStore(subscribe, getBehaviorSettings, getBehaviorSettings);
}
