import React, { useEffect } from 'react';
import { X, CheckCircle, AlertCircle, Info } from 'lucide-react';

export type ToastKind = 'success' | 'error' | 'info';

export interface Toast {
  id: number;
  message: string;
  kind: ToastKind;
}

// Errors linger longer so they aren't missed; successes/info clear quickly.
const DURATION: Record<ToastKind, number> = {
  success: 4000,
  info: 4000,
  error: 8000,
};

const ICON: Record<ToastKind, React.ComponentType<{ size?: number }>> = {
  success: CheckCircle,
  error: AlertCircle,
  info: Info,
};

const ToastItem: React.FC<{ toast: Toast; onDismiss: (id: number) => void }> = ({
  toast,
  onDismiss,
}) => {
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(toast.id), DURATION[toast.kind]);
    return () => clearTimeout(timer);
  }, [toast.id, toast.kind, onDismiss]);

  const Icon = ICON[toast.kind];
  return (
    <div className={`dialog-toast dialog-toast--${toast.kind}`} data-testid="dialog-toast" role="status">
      <Icon size={14} />
      <span className="dialog-toast-msg">{toast.message}</span>
      <button
        type="button"
        className="dialog-toast-close"
        data-testid="dialog-toast-close"
        aria-label="Dismiss notification"
        onClick={() => onDismiss(toast.id)}
      >
        <X size={12} />
      </button>
    </div>
  );
};

export const ToastStack: React.FC<{ toasts: Toast[]; onDismiss: (id: number) => void }> = ({
  toasts,
  onDismiss,
}) => {
  if (toasts.length === 0) return null;
  return (
    <div className="dialog-toast-stack" data-testid="dialog-toast-stack">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
};
