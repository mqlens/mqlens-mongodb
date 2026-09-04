import { createContext, useContext } from 'react';

/**
 * Whether the tab a component sits in is the one on screen.
 *
 * Kept-alive tabs (#240) stay mounted while hidden, so an effect that polls on
 * an interval keeps polling for a tab nobody can see — Monitoring every ten
 * seconds, Watch every 700 ms — for as many hidden tabs as the budget keeps.
 * `document.hidden` cannot tell: the document is visible, the tab is not.
 * This is what tells.
 *
 * Defaults to `true`, so a component rendered outside a pane — a dialog, a
 * test — behaves exactly as it always has.
 */
export const TabVisibleContext = createContext(true);

export const useTabVisible = (): boolean => useContext(TabVisibleContext);
