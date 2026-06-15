import React, { useEffect, useRef, useState } from 'react';
import {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export interface ConfirmRequest {
  type: 'confirm';
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

export interface PromptRequest {
  type: 'prompt';
  title: string;
  message?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  validate?: (value: string) => string | null;
  /** Render a multi-line textarea instead of a single-line input. */
  multiline?: boolean;
}

export interface ChooseRequest {
  type: 'choose';
  title: string;
  message?: string;
  cancelLabel?: string;
  choices: { value: string; label: string; destructive?: boolean }[];
}

export type ModalRequest = ConfirmRequest | PromptRequest | ChooseRequest;

interface DialogModalProps {
  request: ModalRequest;
  onResolve: (value: boolean | string | null) => void;
}

export const DialogModal: React.FC<DialogModalProps> = ({ request, onResolve }) => {
  const [value, setValue] = useState(request.type === 'prompt' ? request.defaultValue ?? '' : '');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  // Cancelling means: confirm → false, prompt/choose → null.
  const cancelValue = request.type === 'confirm' ? false : null;
  const cancel = () => onResolve(cancelValue);

  // Move focus into the modal on open.
  useEffect(() => {
    if (request.type === 'prompt') inputRef.current?.focus();
    else confirmRef.current?.focus();
  }, [request]);

  const submitPrompt = () => {
    const r = request as PromptRequest;
    const trimmed = value.trim();
    const err = r.validate ? r.validate(trimmed) : null;
    if (err) {
      setError(err);
      return;
    }
    onResolve(trimmed);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      cancel();
    }
  };

  const cancelLabel = (request as ConfirmRequest | PromptRequest | ChooseRequest).cancelLabel ?? 'Cancel';

  return (
    // No backdrop-click cancel: dismiss only via the buttons or Escape.
    <Dialog open onOpenChange={() => {}}>
      <DialogPortal>
        <DialogOverlay className="z-[200]" data-testid="dialog-overlay" onKeyDown={onKeyDown} />
        <DialogContent
          className="z-[200] sm:max-w-md [&>button.absolute]:hidden"
          aria-label={request.title}
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => {
            e.preventDefault();
            cancel();
          }}
        >
          <DialogHeader>
            <DialogTitle data-testid="dialog-title">{request.title}</DialogTitle>
            {request.message && <DialogDescription>{request.message}</DialogDescription>}
          </DialogHeader>

          {request.type === 'prompt' && (
            <>
              {request.multiline ? (
                <textarea
                  ref={inputRef as React.RefObject<HTMLTextAreaElement>}
                  className={cn(
                    'flex min-h-[120px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
                    'dialog-input dialog-input--multiline',
                  )}
                  data-testid="dialog-input"
                  value={value}
                  rows={5}
                  placeholder={request.placeholder}
                  onChange={(e) => {
                    setValue(e.target.value);
                    if (error) setError(null);
                  }}
                  onKeyDown={(e) => {
                    // Cmd/Ctrl+Enter submits; plain Enter inserts a newline.
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      submitPrompt();
                    }
                  }}
                />
              ) : (
                <Input
                  ref={inputRef as React.RefObject<HTMLInputElement>}
                  className="dialog-input"
                  data-testid="dialog-input"
                  value={value}
                  placeholder={request.placeholder}
                  onChange={(e) => {
                    setValue(e.target.value);
                    if (error) setError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      submitPrompt();
                    }
                  }}
                />
              )}
              {error && (
                <div className="text-sm text-destructive" data-testid="dialog-error">
                  {error}
                </div>
              )}
            </>
          )}

          {request.type === 'choose' && (
            <div className="flex flex-col gap-2">
              {request.choices.map((c) => (
                <Button
                  key={c.value}
                  type="button"
                  variant={c.destructive ? 'destructive' : 'default'}
                  className={cn(
                    c.destructive ? 'dialog-btn--destructive' : 'dialog-btn--primary',
                    'dialog-btn',
                  )}
                  data-testid={`dialog-choice-${c.value}`}
                  onClick={() => onResolve(c.value)}
                >
                  {c.label}
                </Button>
              ))}
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              className="dialog-btn dialog-btn--ghost"
              data-testid="dialog-cancel"
              onClick={cancel}
            >
              {cancelLabel}
            </Button>
            {request.type !== 'choose' && (
              <Button
                ref={confirmRef}
                type="button"
                variant={
                  request.type === 'confirm' && request.destructive ? 'destructive' : 'default'
                }
                className={cn(
                  'dialog-btn',
                  request.type === 'confirm' && request.destructive
                    ? 'dialog-btn--destructive'
                    : 'dialog-btn--primary',
                )}
                data-testid="dialog-confirm"
                onClick={() => (request.type === 'prompt' ? submitPrompt() : onResolve(true))}
              >
                {request.confirmLabel ?? (request.type === 'prompt' ? 'OK' : 'Confirm')}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
};
