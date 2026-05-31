import React, { useEffect, useRef, useState } from 'react';

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
  const inputRef = useRef<HTMLInputElement>(null);
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

  const onBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) cancel();
  };

  const cancelLabel = (request as any).cancelLabel ?? 'Cancel';

  return (
    <div
      className="dialog-overlay"
      data-testid="dialog-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={request.title}
      onClick={onBackdropClick}
      onKeyDown={onKeyDown}
    >
      <div className="dialog-box" onClick={(e) => e.stopPropagation()}>
        <h3 className="dialog-title" data-testid="dialog-title">
          {request.title}
        </h3>
        {request.message && <p className="dialog-message">{request.message}</p>}

        {request.type === 'prompt' && (
          <>
            <input
              ref={inputRef}
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
            {error && (
              <div className="dialog-error" data-testid="dialog-error">
                {error}
              </div>
            )}
          </>
        )}

        {request.type === 'choose' && (
          <div className="dialog-choices">
            {request.choices.map((c) => (
              <button
                key={c.value}
                type="button"
                className={`dialog-btn ${c.destructive ? 'dialog-btn--destructive' : 'dialog-btn--primary'}`}
                data-testid={`dialog-choice-${c.value}`}
                onClick={() => onResolve(c.value)}
              >
                {c.label}
              </button>
            ))}
          </div>
        )}

        <div className="dialog-actions">
          <button
            type="button"
            className="dialog-btn dialog-btn--ghost"
            data-testid="dialog-cancel"
            onClick={cancel}
          >
            {cancelLabel}
          </button>
          {request.type !== 'choose' && (
            <button
              ref={confirmRef}
              type="button"
              className={`dialog-btn ${
                request.type === 'confirm' && request.destructive
                  ? 'dialog-btn--destructive'
                  : 'dialog-btn--primary'
              }`}
              data-testid="dialog-confirm"
              onClick={() => (request.type === 'prompt' ? submitPrompt() : onResolve(true))}
            >
              {request.confirmLabel ?? (request.type === 'prompt' ? 'OK' : 'Confirm')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
