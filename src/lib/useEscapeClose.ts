import { useEffect } from 'react';
import { useTabVisible } from '@/workspace/tabVisibility';

// Close an open modal on Escape — standard dialog affordance.
//
// Only while the tab it belongs to is on screen. A kept-alive tab (#240) stays
// mounted while hidden, and its dialog stays open in its owner's state so it
// can come back with the tab; an Escape pressed in the tab the user switched
// to must not reach it — that would close every hidden dialog at once, and
// with it discard, say, an unsaved user form that was meant to be there on
// return.
export function useEscapeClose(active: boolean, onClose: () => void) {
  const tabVisible = useTabVisible();
  useEffect(() => {
    if (!active || !tabVisible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, tabVisible, onClose]);
}
