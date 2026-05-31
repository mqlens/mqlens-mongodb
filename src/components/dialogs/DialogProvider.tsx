import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import { ToastStack, Toast, ToastKind } from './ToastStack';
import { DialogModal, ModalRequest } from './DialogModal';

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

export interface PromptOptions {
  title: string;
  message?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Return an error string to block submit, or null to allow it. */
  validate?: (value: string) => string | null;
}

export interface ChooseOptions {
  title: string;
  message?: string;
  cancelLabel?: string;
  choices: { value: string; label: string; destructive?: boolean }[];
}

export interface DialogApi {
  toast: (message: string, kind?: ToastKind) => void;
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  prompt: (opts: PromptOptions) => Promise<string | null>;
  choose: (opts: ChooseOptions) => Promise<string | null>;
}

const DialogContext = createContext<DialogApi | null>(null);

/** Access the in-app dialog API. Must be used inside a <DialogProvider>. */
export function useDialogs(): DialogApi {
  const ctx = useContext(DialogContext);
  if (!ctx) {
    throw new Error('useDialogs must be used within a <DialogProvider>');
  }
  return ctx;
}

interface ActiveModal {
  request: ModalRequest;
  resolve: (value: boolean | string | null) => void;
}

export const DialogProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [modal, setModal] = useState<ActiveModal | null>(null);
  const nextId = useRef(0);

  const removeToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback((message: string, kind: ToastKind = 'info') => {
    const id = nextId.current++;
    setToasts((prev) => [...prev, { id, message, kind }]);
  }, []);

  const openModal = useCallback(
    (request: ModalRequest) =>
      new Promise<boolean | string | null>((resolve) => {
        setModal({ request, resolve });
      }),
    []
  );

  const resolveModal = useCallback(
    (resolve: ActiveModal['resolve'], value: boolean | string | null) => {
      resolve(value);
      setModal(null);
    },
    []
  );

  const confirm = useCallback(
    (opts: ConfirmOptions) => openModal({ type: 'confirm', ...opts }) as Promise<boolean>,
    [openModal]
  );
  const prompt = useCallback(
    (opts: PromptOptions) => openModal({ type: 'prompt', ...opts }) as Promise<string | null>,
    [openModal]
  );
  const choose = useCallback(
    (opts: ChooseOptions) => openModal({ type: 'choose', ...opts }) as Promise<string | null>,
    [openModal]
  );

  const api: DialogApi = { toast, confirm, prompt, choose };

  return (
    <DialogContext.Provider value={api}>
      {children}
      <ToastStack toasts={toasts} onDismiss={removeToast} />
      {modal && (
        <DialogModal
          request={modal.request}
          onResolve={(value) => resolveModal(modal.resolve, value)}
        />
      )}
    </DialogContext.Provider>
  );
};
