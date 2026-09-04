import { createContext, useCallback, useContext, useEffect, useState } from 'react';

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

interface OpenProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/**
 * The `open`/`onOpenChange` pair for a transient overlay — a menu, a select
 * list, a popover — rendered by a component inside a tab.
 *
 * Such content renders through a portal under `document.body`, so the wrapper
 * that hides a kept-alive tab cannot hide it: switch tabs with a menu open and
 * the old tab's menu stays up over the new tab, still catching focus and still
 * able to run the hidden tab's actions. This closes it when the tab is hidden.
 * Closing, not merely hiding: a menu that is gone from under the pointer has
 * no state worth restoring, unlike a dialog.
 *
 * Owners may leave `open` undefined as usual. What Radix receives is always
 * controlled, so nothing flips between controlled and uncontrolled (which
 * Radix warns about) when the tab's visibility changes.
 */
export function useTabScopedOpen({ open, defaultOpen, onOpenChange }: OpenProps): {
  open: boolean;
  onOpenChange: (open: boolean) => void;
} {
  const tabVisible = useTabVisible();
  const [inner, setInner] = useState(defaultOpen ?? false);
  const controlled = open !== undefined;
  const actual = controlled ? open : inner;
  const change = useCallback(
    (next: boolean) => {
      if (!controlled) setInner(next);
      onOpenChange?.(next);
    },
    [controlled, onOpenChange]
  );
  useEffect(() => {
    if (!tabVisible && actual) change(false);
  }, [tabVisible, actual, change]);
  return { open: tabVisible && actual, onOpenChange: change };
}
