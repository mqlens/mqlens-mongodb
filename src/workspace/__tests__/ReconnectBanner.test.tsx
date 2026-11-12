import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ReconnectBanner } from '../ReconnectBanner';

describe('ReconnectBanner', () => {
  // Regression test for Critical 1 (final review, task-6-report.md): the
  // branch added `useTranslation` here and translated exactly the word
  // "Disconnected" — the body copy and the primary button stayed hardcoded
  // English ("... was restored from your last session. Reconnect to {name}
  // to load it." / "Reconnect {name}"). Asserts the whole component renders
  // in German, with the connection/collection names interpolated rather than
  // concatenated.
  it('renders the body and reconnect button in German, with names interpolated', async () => {
    const { i18next } = await import('@/lib/i18n');
    await i18next.changeLanguage('de');
    try {
      render(
        <ReconnectBanner
          profileName="Prod"
          namespace="mydb.orders"
          onReconnect={() => {}}
          busy={false}
        />,
      );

      expect(
        screen.getByText('mydb.orders wurde aus deiner letzten Sitzung wiederhergestellt. Verbinde dich erneut mit Prod, um es zu laden.'),
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Erneut mit Prod verbinden' })).toBeInTheDocument();

      // No leftover English fragments anywhere in the banner.
      expect(screen.queryByText(/was restored/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/^Reconnect/)).not.toBeInTheDocument();
    } finally {
      await i18next.changeLanguage('en');
    }
  });

  // Same check for the no-namespace ("This tab was...") fallback body.
  it('renders the generic (no-namespace) body in German too', async () => {
    const { i18next } = await import('@/lib/i18n');
    await i18next.changeLanguage('de');
    try {
      render(
        <ReconnectBanner
          profileName="Prod"
          namespace=""
          onReconnect={() => {}}
          busy={false}
        />,
      );

      expect(
        screen.getByText('Dieser Tab wurde aus deiner letzten Sitzung wiederhergestellt. Verbinde dich erneut mit Prod, um ihn zu laden.'),
      ).toBeInTheDocument();
    } finally {
      await i18next.changeLanguage('en');
    }
  });

  it('offers a sign-in when the reconnect failed and one is possible', () => {
    let asked = 0;
    const { rerender } = render(
      <ReconnectBanner profileName="Orders" namespace="" onReconnect={() => {}} busy={false} onSignIn={() => asked++} />,
    );
    expect(screen.queryByRole('button', { name: 'Sign in…' })).not.toBeInTheDocument();

    rerender(
      <ReconnectBanner profileName="Orders" namespace="" onReconnect={() => {}} busy={false} error="Sign in first" onSignIn={() => asked++} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Sign in…' }));
    expect(asked).toBe(1);
  });
});
