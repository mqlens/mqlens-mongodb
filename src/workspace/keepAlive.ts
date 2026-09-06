/**
 * Which tabs stay mounted when they are not the one on screen.
 *
 * A pane used to render only its active tab, so switching tabs unmounted the
 * whole subtree and destroyed everything the tab held (#240). Four separate
 * caches exist purely to rebuild state that unmount threw away — builder state,
 * chat transcripts, in-flight AI requests, the results view mode — and the
 * results grid has been patched three times for the same reason.
 *
 * Keeping tabs mounted removes the cause. It cannot be unbounded, though, so
 * the least recently active tabs are dropped, and a dropped tab behaves exactly
 * as every tab does today: it unmounts, and comes back rebuilt from whatever
 * survives outside the tree.
 *
 * ## Why shells are capped separately
 *
 * A mongosh tab is not a slightly heavier collection tab. Measured against the
 * local replica set, an idle `mongosh --quiet` session is **~272 MB** of
 * resident memory (265 MB in the process, 7.7 MB in a child), consistently
 * across sessions — mongosh is a full Node application with the driver and REPL
 * loaded, not the ~37 MB a bare node process costs.
 *
 * A collection tab is two orders of magnitude cheaper. One number cannot serve
 * both: a cap of six that is comfortable for collection tabs is ~1.6 GB if they
 * happen to be shells. So each kind gets its own budget, and a shell keeps its
 * place only against other shells.
 *
 * Note that the session itself already outlives an unmounted shell tab — that
 * is #240 Phase 1, and deliberate. This cap is about the React subtree and the
 * editor it holds, not about the process, which ends when the tab closes.
 */

/** The part of a tab this needs: what it is, so it can be budgeted. */
export interface KeepAliveTab {
  id: string;
  /** `QueryTab['type']` — only `shell` is budgeted separately today. */
  kind: string;
}

export interface KeepAliveLimits {
  /** Shell tabs kept mounted, the active one included. */
  shell: number;
  /** Every other kind, the active one included. */
  other: number;
}

/**
 * Deliberately small. At ~272 MB a session, three mounted shells cost more than
 * the rest of the app put together, and a shell tab loses very little by
 * unmounting: its process and scrollback are held outside the tree already, so
 * coming back rebuilds a view over state that never went away.
 *
 * Six for everything else is a guess bounded by the reasoning rather than by a
 * measurement — per-tab retention for a collection tab could not be measured
 * from process memory, because working set does not track JS retention closely
 * enough to see it (closing five tabs moved the total the wrong way by 85 MB).
 * It wants a heap snapshot to refine. Six is chosen to comfortably cover the
 * "switch between a few tabs while working" case that motivates this at all.
 */
export const DEFAULT_KEEP_ALIVE_LIMITS: KeepAliveLimits = { shell: 2, other: 6 };

const limitFor = (kind: string, limits: KeepAliveLimits) =>
  kind === 'shell' ? limits.shell : limits.other;

/**
 * The tabs to keep mounted, given how recently each was active.
 *
 * `recency` is most-recently-active first and may name tabs that have since
 * closed or moved to another pane; only ids present in `tabs` are considered.
 * A tab missing from `recency` has never been active in this pane and is not
 * mounted until it is.
 *
 * Each kind is filled independently, so a run of shells cannot crowd out the
 * collection tabs the user is actually switching between, and vice versa.
 */
export function keepAliveTabs(
  recency: readonly string[],
  tabs: readonly KeepAliveTab[],
  limits: KeepAliveLimits = DEFAULT_KEEP_ALIVE_LIMITS
): string[] {
  const byId = new Map(tabs.map((t) => [t.id, t]));
  const used = new Map<string, number>();
  const kept: string[] = [];

  for (const id of recency) {
    const tab = byId.get(id);
    if (!tab) continue;
    // One budget per kind, so shells are counted against shells only.
    const bucket = tab.kind === 'shell' ? 'shell' : 'other';
    const taken = used.get(bucket) ?? 0;
    if (taken >= limitFor(tab.kind, limits)) continue;
    used.set(bucket, taken + 1);
    kept.push(id);
  }
  return kept;
}

/**
 * `recency` with `activeId` moved to the front, and ids for tabs that no longer
 * exist dropped.
 *
 * Returns the array unchanged when nothing moved, so a caller holding this in
 * state does not re-render on every pass.
 */
export function withActiveFirst(
  recency: readonly string[],
  activeId: string | null,
  liveIds: ReadonlySet<string>
): string[] {
  const pruned = recency.filter((id) => liveIds.has(id));
  if (activeId === null || !liveIds.has(activeId)) {
    return sameOrder(recency, pruned) ? (recency as string[]) : pruned;
  }
  const next = [activeId, ...pruned.filter((id) => id !== activeId)];
  return sameOrder(recency, next) ? (recency as string[]) : next;
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}
