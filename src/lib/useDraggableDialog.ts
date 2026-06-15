import { useCallback, useLayoutEffect, useRef, useState } from 'react';

export interface DialogRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface UseDraggableDialogOptions {
  defaultWidth: number;
  defaultHeight: number;
  minWidth?: number;
  minHeight?: number;
  enabled?: boolean;
  /** When this changes, the dialog recenters at its default size (e.g. dialog open). */
  resetKey?: unknown;
}

export function centeredDialogRect(width: number, height: number): DialogRect {
  const w = Math.min(width, window.innerWidth - 32);
  const h = Math.min(height, window.innerHeight - 32);
  return {
    x: Math.max(16, (window.innerWidth - w) / 2),
    y: Math.max(16, (window.innerHeight - h) / 2),
    width: w,
    height: h,
  };
}

export function clampDialogRect(
  rect: DialogRect,
  minWidth: number,
  minHeight: number,
): DialogRect {
  const margin = 8;
  const maxWidth = Math.max(minWidth, window.innerWidth - margin * 2);
  const maxHeight = Math.max(minHeight, window.innerHeight - margin * 2);
  const width = Math.min(Math.max(rect.width, minWidth), maxWidth);
  const height = Math.min(Math.max(rect.height, minHeight), maxHeight);
  const x = Math.min(Math.max(rect.x, margin), window.innerWidth - width - margin);
  const y = Math.min(Math.max(rect.y, margin), window.innerHeight - height - margin);
  return { x, y, width, height };
}

function applyRectToElement(el: HTMLElement, rect: DialogRect) {
  el.style.left = `${rect.x}px`;
  el.style.top = `${rect.y}px`;
  el.style.width = `${rect.width}px`;
  el.style.height = `${rect.height}px`;
  el.style.transform = 'none';
}

function setDragging(el: HTMLElement, dragging: boolean) {
  if (dragging) {
    el.dataset.dialogDragging = 'true';
    el.style.transition = 'none';
    document.body.style.userSelect = 'none';
  } else {
    delete el.dataset.dialogDragging;
    el.style.transition = '';
    document.body.style.userSelect = '';
  }
}

export function useDraggableDialog({
  defaultWidth,
  defaultHeight,
  minWidth = 360,
  minHeight = 240,
  enabled = true,
  resetKey,
}: UseDraggableDialogOptions) {
  const elementRef = useRef<HTMLElement | null>(null);
  const [rect, setRect] = useState<DialogRect>(() =>
    centeredDialogRect(defaultWidth, defaultHeight),
  );
  const rectRef = useRef(rect);
  rectRef.current = rect;

  const applyRect = useCallback((next: DialogRect) => {
    rectRef.current = next;
    if (elementRef.current) applyRectToElement(elementRef.current, next);
  }, []);

  useLayoutEffect(() => {
    if (!enabled) return;
    const next = centeredDialogRect(defaultWidth, defaultHeight);
    setRect(next);
    applyRect(next);
  }, [defaultWidth, defaultHeight, enabled, resetKey, applyRect]);

  const contentRef = useCallback(
    (node: HTMLElement | null) => {
      elementRef.current = node;
      if (node) applyRectToElement(node, rectRef.current);
    },
    [applyRect],
  );

  const commitRect = useCallback((next: DialogRect) => {
    applyRect(next);
    setRect(next);
  }, [applyRect]);

  const startDrag = useCallback(
    (e: React.PointerEvent) => {
      if (!enabled) return;
      const el = elementRef.current;
      if (!el) return;
      const target = e.target as HTMLElement;
      if (!target.closest('[data-dialog-drag-handle]')) return;
      if (target.closest('button, input, textarea, select, a, [data-dialog-no-drag]')) return;

      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      const origin = rectRef.current;
      let pending = origin;

      setDragging(el, true);

      const onMove = (ev: PointerEvent) => {
        pending = clampDialogRect(
          {
            ...origin,
            x: origin.x + (ev.clientX - startX),
            y: origin.y + (ev.clientY - startY),
          },
          minWidth,
          minHeight,
        );
        const dx = pending.x - origin.x;
        const dy = pending.y - origin.y;
        // GPU-friendly move — no React re-render, no child layout during drag.
        el.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
      };

      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        setDragging(el, false);
        commitRect(pending);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [enabled, minWidth, minHeight, commitRect],
  );

  const startResize = useCallback(
    (e: React.PointerEvent) => {
      if (!enabled) return;
      const el = elementRef.current;
      if (!el) return;

      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startY = e.clientY;
      const origin = rectRef.current;
      let pending = origin;

      setDragging(el, true);

      const onMove = (ev: PointerEvent) => {
        pending = clampDialogRect(
          {
            ...origin,
            width: origin.width + (ev.clientX - startX),
            height: origin.height + (ev.clientY - startY),
          },
          minWidth,
          minHeight,
        );
        // Direct DOM resize — avoids re-rendering modal children each frame.
        el.style.width = `${pending.width}px`;
        el.style.height = `${pending.height}px`;
        el.style.left = `${pending.x}px`;
        el.style.top = `${pending.y}px`;
      };

      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        setDragging(el, false);
        commitRect(pending);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [enabled, minWidth, minHeight, commitRect],
  );

  const positionedStyle: React.CSSProperties | undefined = enabled
    ? {
        position: 'fixed',
        left: rect.x,
        top: rect.y,
        width: rect.width,
        height: rect.height,
        transform: 'none',
        margin: 0,
        maxWidth: 'none',
        maxHeight: 'none',
        willChange: 'transform',
      }
    : undefined;

  return { rect, startDrag, startResize, positionedStyle, contentRef };
}
