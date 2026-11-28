import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DialogModal } from '../DialogModal';

describe('DialogModal', () => {
  // The provider keeps one modal mounted when a dialog opens in the same render
  // that closes the one before it, as a browser click does: Add field's name
  // prompt, then its type, then its value. The value prompt opened holding the
  // name typed into the first.
  it('starts a new prompt from its own value, not the one typed into the request before', () => {
    const { rerender } = render(<DialogModal request={{ type: 'prompt', title: 'First' }} onResolve={vi.fn()} />);
    fireEvent.change(screen.getByTestId('dialog-input'), { target: { value: 'typed first' } });

    rerender(<DialogModal request={{ type: 'prompt', title: 'Second', defaultValue: 'own' }} onResolve={vi.fn()} />);

    expect(screen.getByTestId('dialog-input')).toHaveValue('own');
  });

  // Regression test for Critical 2 (final review, task-6-report.md):
  // DialogModal had no `useTranslation` at all, so `cancelLabel ?? 'Cancel'`
  // and `confirmLabel ?? 'Confirm'` rendered hardcoded English regardless of
  // locale — and no call site anywhere passes `cancelLabel`, so this hit
  // every one of the app's `confirm()`/`prompt()`/`choose()` dialogs.
  it('renders the default Cancel/Confirm/OK button labels in German', async () => {
    const { i18next } = await import('@/lib/i18n');
    await i18next.changeLanguage('de');
    try {
      const { unmount } = render(
        <DialogModal
          request={{ type: 'confirm', title: 'Titel' }}
          onResolve={vi.fn()}
        />,
      );
      expect(screen.getByTestId('dialog-cancel')).toHaveTextContent('Abbrechen');
      expect(screen.getByTestId('dialog-confirm')).toHaveTextContent('Bestätigen');
      unmount();

      render(
        <DialogModal
          request={{ type: 'prompt', title: 'Titel' }}
          onResolve={vi.fn()}
        />,
      );
      expect(screen.getByTestId('dialog-cancel')).toHaveTextContent('Abbrechen');
      expect(screen.getByTestId('dialog-confirm')).toHaveTextContent('OK');
    } finally {
      await i18next.changeLanguage('en');
    }
  });

  it('still lets an explicit confirmLabel/cancelLabel override the default', async () => {
    render(
      <DialogModal
        request={{ type: 'confirm', title: 'Titel', confirmLabel: 'Löschen', cancelLabel: 'Zurück' }}
        onResolve={vi.fn()}
      />,
    );
    expect(screen.getByTestId('dialog-cancel')).toHaveTextContent('Zurück');
    expect(screen.getByTestId('dialog-confirm')).toHaveTextContent('Löschen');
  });
it('submits a password prompt as typed, spaces included', () => {
    const onResolve = vi.fn();
    render(<DialogModal request={{ type: 'prompt', title: 'Password', password: true }} onResolve={onResolve} />);
    fireEvent.change(screen.getByTestId('dialog-input'), { target: { value: ' pass word ' } });
    fireEvent.click(screen.getByTestId('dialog-confirm'));
    expect(onResolve).toHaveBeenCalledWith(' pass word ');
  });

  it('still trims a plain text prompt', () => {
    const onResolve = vi.fn();
    render(<DialogModal request={{ type: 'prompt', title: 'Name' }} onResolve={onResolve} />);
    fireEvent.change(screen.getByTestId('dialog-input'), { target: { value: '  Prod  ' } });
    fireEvent.click(screen.getByTestId('dialog-confirm'));
    expect(onResolve).toHaveBeenCalledWith('Prod');
  });
});
