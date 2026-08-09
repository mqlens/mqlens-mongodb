import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DialogModal } from '../DialogModal';

describe('DialogModal', () => {
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
});
