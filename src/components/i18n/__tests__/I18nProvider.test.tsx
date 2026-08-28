import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { useTranslation } from 'react-i18next';

const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: any[]) => mockInvoke(...a) }));

import { I18nProvider, useLocale } from '../I18nProvider';
import { VAULT_UNLOCKED_EVENT } from '@/lib/vault';

function Probe() {
  const { t } = useTranslation('common');
  const { locale, setLocale } = useLocale();
  return (
    <div>
      <span data-testid="cancel">{t('cancel')}</span>
      <span data-testid="locale">{locale}</span>
      <button onClick={() => setLocale('de')}>to-de</button>
    </div>
  );
}

describe('I18nProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockResolvedValue({ locale: 'en' });
  });

  it('renders the persisted locale', async () => {
    mockInvoke.mockResolvedValue({ locale: 'de' });
    render(<I18nProvider><Probe /></I18nProvider>);
    expect(await screen.findByTestId('cancel')).toHaveTextContent('Abbrechen');
    expect(screen.getByTestId('locale')).toHaveTextContent('de');
  });

  it('falls back to English for an unknown persisted locale', async () => {
    mockInvoke.mockResolvedValue({ locale: 'klingon' });
    render(<I18nProvider><Probe /></I18nProvider>);
    expect(await screen.findByTestId('cancel')).toHaveTextContent('Cancel');
  });

  it('still starts when settings cannot be read', async () => {
    mockInvoke.mockRejectedValue(new Error('vault locked'));
    render(<I18nProvider><Probe /></I18nProvider>);
    // The app must never fail to boot because a locale could not be read.
    expect(await screen.findByTestId('cancel')).toHaveTextContent('Cancel');
  });

  it('switches locale and persists it', async () => {
    render(<I18nProvider><Probe /></I18nProvider>);
    await screen.findByTestId('cancel');
    fireEvent.click(screen.getByText('to-de'));
    await waitFor(() => expect(screen.getByTestId('cancel')).toHaveTextContent('Abbrechen'));
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith('patch_app_settings', {
        patch: { locale: 'de' },
      }),
    );
  });

  it('applies the persisted locale once the vault unlocks, after a locked cold start', async () => {
    // Models real boot order: I18nProvider reads settings before VaultGate
    // has had a chance to unlock the vault, so the first read fails.
    mockInvoke.mockRejectedValueOnce(new Error('vault is locked'));
    mockInvoke.mockResolvedValue({ locale: 'de' });

    render(<I18nProvider><Probe /></I18nProvider>);

    // The app must still boot (in English) instead of hanging on the failed read.
    expect(await screen.findByTestId('cancel')).toHaveTextContent('Cancel');
    expect(screen.getByTestId('locale')).toHaveTextContent('en');

    // Simulate VaultGate unlocking the vault.
    fireEvent(window, new Event(VAULT_UNLOCKED_EVENT));

    // The previously-unreadable persisted locale should now be honoured.
    await waitFor(() => expect(screen.getByTestId('cancel')).toHaveTextContent('Abbrechen'));
    expect(screen.getByTestId('locale')).toHaveTextContent('de');
  });

  it('follows the device language when nothing is persisted (#123 auto-detect)', async () => {
    // No stored preference: a German device should get German without the user
    // ever opening Settings.
    mockInvoke.mockResolvedValue({});
    const spy = vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['de-AT', 'en-US']);
    try {
      render(<I18nProvider><Probe /></I18nProvider>);
      expect(await screen.findByTestId('cancel')).toHaveTextContent('Abbrechen');
    } finally {
      spy.mockRestore();
    }
  });

  it('lets an explicit choice override the device language', async () => {
    // A German device with English explicitly chosen must stay English.
    mockInvoke.mockResolvedValue({ locale: 'en' });
    const spy = vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['de-DE']);
    try {
      render(<I18nProvider><Probe /></I18nProvider>);
      expect(await screen.findByTestId('cancel')).toHaveTextContent('Cancel');
    } finally {
      spy.mockRestore();
    }
  });
});
