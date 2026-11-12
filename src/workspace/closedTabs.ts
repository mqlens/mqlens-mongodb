// Per-window history behind "Reopen Closed Tab". In memory only: a tab closed
// in a previous session is not coming back, same as a browser without restore.

export const CLOSED_TAB_HISTORY_LIMIT = 20;

// Quick Start is a singleton that reappears on its own; export/import tabs hold
// a one-off task form that is never persisted either (see toPersistedTab).
const NOT_REOPENABLE = new Set(['quickstart', 'export', 'import']);

type TabLike = { id: string; type: string };

export interface ClosedTab<T extends TabLike, B = unknown> {
  tab: T;
  builderState?: B;
}

export function rememberClosedTab<T extends TabLike, B>(
  history: ClosedTab<T, B>[],
  entry: ClosedTab<T, B>,
): ClosedTab<T, B>[] {
  if (NOT_REOPENABLE.has(entry.tab.type)) return history;
  const rest = history.filter((e) => e.tab.id !== entry.tab.id);
  return [...rest, entry].slice(-CLOSED_TAB_HISTORY_LIMIT);
}

/** Pops the newest entry `canReopen` accepts; anything newer that it rejects
 *  (its connection is gone) is dropped rather than retried forever. */
export function takeClosedTab<T extends TabLike, B>(
  history: ClosedTab<T, B>[],
  canReopen: (tab: T) => boolean,
): { entry: ClosedTab<T, B> | null; history: ClosedTab<T, B>[] } {
  for (let i = history.length - 1; i >= 0; i--) {
    if (canReopen(history[i].tab)) return { entry: history[i], history: history.slice(0, i) };
  }
  return { entry: null, history: [] };
}
