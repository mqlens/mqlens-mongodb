/**
 * Local search over the results already on screen (#279).
 *
 * A query filter asks the server a question and replaces the result set; this
 * only looks at what is already loaded. The three text-bearing views render
 * differently — a virtualized line list, a key/value/type tree, a column table —
 * so each one flattens itself into [`FindCell`]s and the matching happens here,
 * once, against text rather than DOM.
 *
 * Searching the underlying values rather than the rendered DOM matters because
 * every view is virtualized: a match may sit outside the rendered window or
 * inside a collapsed fold, and neither exists as an element to scan.
 */
/** One searchable piece of a view, in that view's own row order. */
export interface FindCell {
  /** Row index in the view's index space, used to scroll the match into view. */
  rowIndex: number;
  /** Column key, for the table view. Absent in the line and tree views. */
  columnKey?: string;
  /** The text to search, as the user sees it. */
  text: string;
  /** Folds that must be opened before this row is reachable. */
  ancestors?: number[];
}

/** A cell containing the query, in view order. */
export interface FindMatch {
  rowIndex: number;
  columnKey?: string;
  /** Folds to open before scrolling to it. Empty when nothing is collapsed. */
  ancestors: number[];
}

/**
 * Cells containing `query`, in view order. Case-insensitive.
 *
 * One match per cell: the cell is the unit the user navigates between and the
 * unit that gets highlighted, so counting repeated occurrences inside a single
 * cell would report matches that cannot be stepped to individually.
 */
export function findMatches(cells: readonly FindCell[], query: string): FindMatch[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [];

  const matches: FindMatch[] = [];
  for (const cell of cells) {
    if (cell.text.toLowerCase().includes(needle)) {
      matches.push({
        rowIndex: cell.rowIndex,
        columnKey: cell.columnKey,
        ancestors: cell.ancestors ?? [],
      });
    }
  }
  return matches;
}

/**
 * Next active index when stepping by `delta`, wrapping at both ends.
 *
 * Returns -1 when there is nothing to step through, so callers can treat "no
 * matches" and "no selection" the same way.
 */
export function stepMatch(count: number, active: number, delta: number): number {
  if (count <= 0) return -1;
  if (active < 0) return delta >= 0 ? 0 : count - 1;
  return (((active + delta) % count) + count) % count;
}

/** True when `match` points at the cell identified by `rowIndex`/`columnKey`. */
export function isMatchAt(
  match: FindMatch | undefined,
  rowIndex: number,
  columnKey?: string,
): boolean {
  if (!match) return false;
  return match.rowIndex === rowIndex && match.columnKey === columnKey;
}
