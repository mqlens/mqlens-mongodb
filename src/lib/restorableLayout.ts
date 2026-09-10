import type { Layout } from 'react-resizable-panels';

/** Side panels (AI helper / query builder) declare an 18% floor in the UI. */
export const SIDE_PANEL_MIN = 18;

/**
 * A persisted resizable layout, but only when it is safe to restore.
 *
 * `react-resizable-panels` throws *during render* if a `defaultLayout`'s entry
 * count differs from the number of panels currently rendered, and its restore
 * path validates that stored values are numbers but does not re-clamp them to
 * each panel's declared minimum. So a layout persisted under a different panel
 * set, hand-tampered, or holding a side panel below its floor is unsafe: it
 * either crashes the group (blanking the tab — #379) or renders the side panel
 * as an invisible sliver.
 *
 * Returns the layout when every check passes, otherwise `undefined` so the
 * caller falls back to its fixed default. The worst case is a forgotten drag
 * width, never a crash or a sliver.
 */
export function restorableLayout(
  saved: Layout | undefined,
  panelIds: string[],
  sidePanelMin: number = SIDE_PANEL_MIN,
): Layout | undefined {
  if (!saved) return undefined;
  // Exactly the panels rendered now — same set, same count.
  if (Object.keys(saved).length !== panelIds.length) return undefined;
  if (!panelIds.every((id) => typeof saved[id] === 'number')) return undefined;
  // No side panel restored below the floor that would make it a sliver.
  const side = panelIds.find((id) => id !== 'document-main');
  if (side && saved[side] < sidePanelMin) return undefined;
  return saved;
}
