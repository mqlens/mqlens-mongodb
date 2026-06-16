export type UpdateCheckResultKind = 'uptodate' | 'available' | 'offline' | 'check-failed';

export interface UpdateCheckSnapshot {
  checkedAt: string;
  result: UpdateCheckResultKind;
  detail?: string;
}

export const UPDATE_CHECK_STATE_EVENT = 'mqlens:update-check-state-changed';

const STORAGE_KEY = 'mqlens.update-check.snapshot';

export function readUpdateCheckSnapshot(): UpdateCheckSnapshot | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as UpdateCheckSnapshot;
    if (!parsed?.checkedAt || !parsed?.result) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeUpdateCheckSnapshot(snapshot: UpdateCheckSnapshot): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    /* ignore quota / private mode */
  }
  notifyUpdateCheckState();
}

export function notifyUpdateCheckState(): void {
  window.dispatchEvent(new Event(UPDATE_CHECK_STATE_EVENT));
}

export function classifyUpdateCheckError(err: unknown): 'offline' | 'check-failed' {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return 'offline';
  }
  const msg = String((err as { message?: string })?.message || err).toLowerCase();
  const offlineHints = [
    'network',
    'failed to fetch',
    'fetch failed',
    'connection refused',
    'offline',
    'dns',
    'timeout',
    'timed out',
    'enotfound',
    'econnrefused',
    'unreachable',
    'no route to host',
  ];
  return offlineHints.some((hint) => msg.includes(hint)) ? 'offline' : 'check-failed';
}

export function updateCheckResultLabel(result: UpdateCheckResultKind): string {
  switch (result) {
    case 'uptodate':
      return 'Up to date';
    case 'available':
      return 'Update available';
    case 'offline':
      return 'Offline';
    case 'check-failed':
      return 'Server error';
  }
}

export function formatLastChecked(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

/** Exponential backoff for automatic retries when offline (30s → 5m cap). */
export function updateCheckBackoffMs(attempt: number): number {
  const base = 30_000;
  const max = 300_000;
  return Math.min(base * 2 ** attempt, max);
}
