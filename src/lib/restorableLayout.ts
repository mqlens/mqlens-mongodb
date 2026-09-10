import type { Layout } from 'react-resizable-panels';

/**
 * Panel size bounds, mirroring what DocumentViewer declares on each
 * `ResizablePanel`: the document area floors at 30%, and each side panel (AI
 * helper / query builder) is constrained to 18–50%.
 */
export const DOCUMENT_MAIN_MIN = 30;
export const SIDE_PANEL_MIN = 18;
export const SIDE_PANEL_MAX = 50;

/**
 * A persisted resizable layout, but only when it is safe to restore.
 *
 * `react-resizable-panels` throws *during render* if a `defaultLayout`'s entry
 * count differs from the number of panels currently rendered, and its restore
 * path validates that stored values are numbers but does not re-clamp them to
 * each panel's declared bounds. So a layout persisted under a different panel
 * set, hand-tampered, or holding any panel outside its bounds is unsafe: it
 * either crashes the group (blanking the tab — #379) or restores a panel as an
 * unusable sliver — the document area included, not just the side panel
 * (#379 review).
 *
 * Every constraint the panels declare is checked, not just the side-panel
 * minimum. Returns the layout when all pass, otherwise `undefined` so the
 * caller falls back to its fixed default. The worst case is a forgotten drag
 * width, never a crash or a sliver.
 */
export function restorableLayout(
  saved: Layout | undefined,
  panelIds: string[],
): Layout | undefined {
  if (!saved) return undefined;
  // Exactly the panels rendered now — same set, same count.
  if (Object.keys(saved).length !== panelIds.length) return undefined;
  if (!panelIds.every((id) => typeof saved[id] === 'number')) return undefined;
  // Panel sizes are proportions of one group, so the per-panel bounds below are
  // only meaningful if the entries actually total 100%. A layout that sums to,
  // say, 118% passes each individual check but the library normalizes it back
  // down — pushing the side panel under its floor again (#380 review). A small
  // epsilon tolerates the float drift a drag can leave behind.
  const total = panelIds.reduce((sum, id) => sum + saved[id], 0);
  if (Math.abs(total - 100) > 0.5) return undefined;
  // The document area must not restore below its floor…
  if ('document-main' in saved && saved['document-main'] < DOCUMENT_MAIN_MIN) {
    return undefined;
  }
  // …and no side panel outside its declared 18–50% range.
  for (const id of panelIds) {
    if (id === 'document-main') continue;
    const pct = saved[id];
    if (pct < SIDE_PANEL_MIN || pct > SIDE_PANEL_MAX) return undefined;
  }
  return saved;
}
