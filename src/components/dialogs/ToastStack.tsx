import React, { useEffect } from 'react';
import { X, CheckCircle2, AlertCircle, Info } from 'lucide-react';
import { cn } from '@/lib/utils';

export type ToastKind = 'success' | 'error' | 'info';

export interface Toast {
  id: number;
  message: string;
  kind: ToastKind;
  title?: string;
}

export interface ToastOptions {
  title?: string;
}

// Errors linger longer so they aren't missed; successes/info clear quickly.
const DURATION: Record<ToastKind, number> = {
  success: 4500,
  info: 4500,
  error: 9000,
};

const DEFAULT_TITLE: Record<ToastKind, string> = {
  success: 'Success',
  error: 'Error',
  info: 'Notice',
};

const ICON: Record<ToastKind, React.ComponentType<{ className?: string }>> = {
  success: CheckCircle2,
  error: AlertCircle,
  info: Info,
};

const KIND_STYLES: Record<
  ToastKind,
  { shell: string; icon: string; progress: string; label: string }
> = {
  success: {
    shell: 'border-emerald-500/35 bg-emerald-500/10 shadow-emerald-500/10',
    icon: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
    progress: 'bg-emerald-500/70',
    label: 'text-emerald-700 dark:text-emerald-300',
  },
  error: {
    shell: 'border-destructive/40 bg-destructive/10 shadow-destructive/10',
    icon: 'bg-destructive/15 text-destructive',
    progress: 'bg-destructive/70',
    label: 'text-destructive',
  },
  info: {
    shell: 'border-primary/30 bg-primary/10 shadow-primary/10',
    icon: 'bg-primary/15 text-primary',
    progress: 'bg-primary/70',
    label: 'text-primary',
  },
};

const ToastItem: React.FC<{ toast: Toast; onDismiss: (id: number) => void }> = ({
  toast,
  onDismiss,
}) => {
  const duration = DURATION[toast.kind];
  const styles = KIND_STYLES[toast.kind];
  const Icon = ICON[toast.kind];
  const title = toast.title ?? DEFAULT_TITLE[toast.kind];

  useEffect(() => {
    const timer = setTimeout(() => onDismiss(toast.id), duration);
    return () => clearTimeout(timer);
  }, [toast.id, duration, onDismiss]);

  return (
    <div
      className={cn(
        'dialog-toast relative w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-lg border shadow-lg backdrop-blur-sm',
        `dialog-toast--${toast.kind}`,
        styles.shell,
        'animate-in slide-in-from-right-4 fade-in duration-300',
      )}
      data-testid="dialog-toast"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-start gap-3 px-3.5 py-3 pr-2">
        <span
          className={cn(
            'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
            styles.icon,
          )}
        >
          <Icon className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1 pt-0.5">
          <p className={cn('text-xs font-semibold uppercase tracking-wide', styles.label)}>{title}</p>
          <p className="dialog-toast-msg mt-0.5 text-sm leading-snug text-foreground">{toast.message}</p>
        </div>
        <button
          type="button"
          className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-background/60 hover:text-foreground"
          data-testid="dialog-toast-close"
          aria-label="Dismiss notification"
          onClick={() => onDismiss(toast.id)}
        >
          <X className="size-3.5" />
        </button>
      </div>
      <div className="h-0.5 w-full bg-background/30">
        <div
          className={cn('animate-toast-progress h-full origin-left', styles.progress)}
          style={{ animationDuration: `${duration}ms` }}
        />
      </div>
    </div>
  );
};

export const ToastStack: React.FC<{ toasts: Toast[]; onDismiss: (id: number) => void }> = ({
  toasts,
  onDismiss,
}) => {
  if (toasts.length === 0) return null;
  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-[300] flex max-w-full flex-col gap-2.5"
      data-testid="dialog-toast-stack"
    >
      {toasts.map((t) => (
        <div key={t.id} className="pointer-events-auto">
          <ToastItem toast={t} onDismiss={onDismiss} />
        </div>
      ))}
    </div>
  );
};
