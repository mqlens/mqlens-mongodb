import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';

export interface ContextMenuItem {
  label: string;
  onClick: () => void;
  icon?: React.ReactNode;
  danger?: boolean;
  separatorBefore?: boolean;
  disabled?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

// Portal-rendered menu positioned at the cursor. Closes on outside-click, Esc,
// scroll, resize, or window blur; clamps to the viewport. Reused by every result
// view so the right-click experience is identical across Table / Tree / JSON.
export const ContextMenu: React.FC<ContextMenuProps> = ({ x, y, items, onClose }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // Keep the menu fully on screen.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { offsetWidth: w, offsetHeight: h } = el;
    const left = Math.min(x, window.innerWidth - w - 8);
    const top = Math.min(y, window.innerHeight - h - 8);
    setPos({ left: Math.max(8, left), top: Math.max(8, top) });
  }, [x, y]);

  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      className={cn(
        'fixed z-50 min-w-[8rem] overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md',
      )}
      style={{ left: pos.left, top: pos.top }}
      role="menu"
      data-testid="context-menu"
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) => (
        <React.Fragment key={`${it.label}-${i}`}>
          {it.separatorBefore && <div className="-mx-1 my-1 h-px bg-border" />}
          <button
            type="button"
            role="menuitem"
            className={cn(
              'relative flex w-full cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50',
              it.danger && 'is-danger text-destructive hover:text-destructive',
            )}
            disabled={it.disabled}
            onClick={() => {
              it.onClick();
              onClose();
            }}
          >
            {it.icon && (
              <span className="mr-2 inline-flex shrink-0 text-muted-foreground [&_svg]:size-4">
                {it.icon}
              </span>
            )}
            <span>{it.label}</span>
          </button>
        </React.Fragment>
      ))}
    </div>,
    document.body,
  );
};
