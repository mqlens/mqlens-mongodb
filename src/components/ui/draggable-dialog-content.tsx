import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useDraggableDialog } from '@/lib/useDraggableDialog';
import { DialogOverlay, DialogPortal } from '@/components/ui/dialog';

function mergeRefs<T>(...refs: Array<React.Ref<T> | undefined>) {
  return (value: T | null) => {
    for (const ref of refs) {
      if (!ref) continue;
      if (typeof ref === 'function') ref(value);
      else (ref as React.MutableRefObject<T | null>).current = value;
    }
  };
}

export interface DraggableDialogContentProps
  extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  defaultWidth?: number;
  defaultHeight?: number;
  minWidth?: number;
  minHeight?: number;
  hideClose?: boolean;
  overlayClassName?: string;
  /** When false, only renders content (use inside an existing portal). */
  portal?: boolean;
  /** Recenters/resets size when this value changes (pass dialog `open` or `isOpen`). */
  resetKey?: unknown;
}

export const DraggableDialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  DraggableDialogContentProps
>(
  (
    {
      className,
      children,
      defaultWidth = 720,
      defaultHeight = 560,
      minWidth = 400,
      minHeight = 280,
      hideClose = false,
      overlayClassName,
      portal = true,
      resetKey,
      style,
      onPointerDown,
      ...props
    },
    ref,
  ) => {
    const { startDrag, startResize, positionedStyle, contentRef } = useDraggableDialog({
      defaultWidth,
      defaultHeight,
      minWidth,
      minHeight,
      resetKey,
    });

    const content = (
      <DialogPrimitive.Content
        ref={mergeRefs(ref, contentRef)}
        className={cn(
          'fixed z-50 flex flex-col overflow-hidden border border-border bg-background shadow-2xl sm:rounded-xl',
          'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
          'data-[dialog-dragging=true]:!transition-none',
          className,
        )}
        style={{ ...positionedStyle, ...style }}
        onPointerDown={(e) => {
          startDrag(e);
          onPointerDown?.(e);
        }}
        {...props}
      >
        {children}
        <div
          data-testid="dialog-resize-handle"
          aria-label="Resize dialog"
          title="Drag to resize"
          className="absolute bottom-0 right-0 z-20 flex h-5 w-5 cursor-se-resize items-end justify-end p-0.5 text-muted-foreground/70 hover:text-foreground"
          onPointerDown={startResize}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden className="pointer-events-none">
            <path d="M12 12H6V10H10V6H12V12Z" fill="currentColor" />
            <path d="M12 8H8V12H6V6H12V8Z" fill="currentColor" opacity="0.55" />
          </svg>
        </div>
        {!hideClose && (
          <DialogPrimitive.Close className="absolute right-3 top-3 z-20 rounded-sm p-1 opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2">
            <X className="h-4 w-4" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    );

    if (!portal) return content;

    return (
      <DialogPortal>
        <DialogOverlay className={overlayClassName} />
        {content}
      </DialogPortal>
    );
  },
);
DraggableDialogContent.displayName = 'DraggableDialogContent';
