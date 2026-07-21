/**
 * Detects whether an aggregation pipeline carries a `$out`/`$merge` stage —
 * the two stages that WRITE the pipeline's output into a collection instead
 * of just reading (#188 security review Fix 1). Mirrors the backend's
 * `write_guard::stage_is_disallowed` (a stage counts only when its sole
 * top-level key is `$out` or `$merge` — the backend is the real gate
 * either way, this is only used to decide what confirmation UI to show).
 *
 * Also best-effort extracts the write TARGET collection name so the
 * confirm-by-typed-name dialog (`confirmByTypedName`) can ask the user to
 * type it, same as drop_collection/rename_collection do. `$out` and
 * `$merge` both support a bare string form and an object form
 * (`{db, coll}` for `$out`; `{into: string | {db, coll}}` for `$merge`);
 * anything else (e.g. the target computed dynamically, which isn't
 * possible in MQL but kept as a defensive fallback) yields `target: null`
 * so the caller can fall back to a plain "type CONFIRM" prompt instead of
 * silently under- or over-matching a name.
 */
export interface AggregateWriteStage {
  /** True iff some top-level stage's sole key is `$out` or `$merge`. */
  hasWriteStage: boolean;
  /** The write target collection name if it could be extracted cleanly; null if a write stage exists but the target couldn't be determined. */
  target: string | null;
}

function nonEmptyString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

export function detectAggregateWriteStage(pipeline: Record<string, unknown>[] | null | undefined): AggregateWriteStage {
  for (const stage of pipeline ?? []) {
    if (!stage || typeof stage !== 'object' || Array.isArray(stage)) continue;
    const keys = Object.keys(stage);
    if (keys.length !== 1) continue;
    const key = keys[0];
    if (key !== '$out' && key !== '$merge') continue;

    const value = (stage as Record<string, unknown>)[key];

    if (key === '$out') {
      const direct = nonEmptyString(value);
      if (direct) return { hasWriteStage: true, target: direct };
      if (value && typeof value === 'object') {
        const coll = nonEmptyString((value as Record<string, unknown>).coll);
        if (coll) return { hasWriteStage: true, target: coll };
      }
      return { hasWriteStage: true, target: null };
    }

    // $merge
    const direct = nonEmptyString(value);
    if (direct) return { hasWriteStage: true, target: direct };
    if (value && typeof value === 'object') {
      const into = (value as Record<string, unknown>).into;
      const intoStr = nonEmptyString(into);
      if (intoStr) return { hasWriteStage: true, target: intoStr };
      if (into && typeof into === 'object') {
        const coll = nonEmptyString((into as Record<string, unknown>).coll);
        if (coll) return { hasWriteStage: true, target: coll };
      }
    }
    return { hasWriteStage: true, target: null };
  }
  return { hasWriteStage: false, target: null };
}
