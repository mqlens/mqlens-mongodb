import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { I18nextProvider } from 'react-i18next';
import { changeLocale, i18next, initI18n } from '@/lib/i18n';
import {
  DEFAULT_LOCALE_SETTING,
  deviceLanguages,
  isLocaleSetting,
  resolveLocale,
  type Locale,
  type LocaleSetting,
} from '@/lib/i18n/locales';
import { VAULT_UNLOCKED_EVENT } from '@/lib/vault';

interface LocaleContextValue {
  /** The locale actually in use — `system` already resolved to a real one. */
  locale: Locale;
  /** What the user picked, including `system`. This is what the picker binds to. */
  localeSetting: LocaleSetting;
  setLocale: (setting: LocaleSetting) => void;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function useLocale(): LocaleContextValue {
  const ctx = useContext(LocaleContext);
  if (!ctx) throw new Error('useLocale must be used inside I18nProvider');
  return ctx;
}

/**
 * Owns i18next and the active locale. Mounted outermost, above ThemeProvider
 * *and* above VaultGate: strings are needed everywhere, including on the
 * unlock screen itself.
 *
 * The persisted locale lives in encrypted app settings, which cannot be read
 * until the vault is unlocked — and VaultGate, the component that prompts for
 * unlock, is a descendant of this provider. So the tree is never gated on the
 * settings read: i18next initialises to English synchronously-ish and
 * children render immediately, letting VaultGate mount and the user unlock.
 * The persisted locale (if any) is then reconciled in the background, once
 * after the initial read and again on VAULT_UNLOCKED_EVENT — mirroring how
 * ThemeProvider re-reads appearance settings after unlock.
 */
export const I18nProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [localeSetting, setLocaleSettingState] = useState<LocaleSetting>(DEFAULT_LOCALE_SETTING);
  const [locale, setLocaleState] = useState<Locale>(() =>
    resolveLocale(DEFAULT_LOCALE_SETTING, deviceLanguages())
  );
  const [ready, setReady] = useState(false);

  const reconcilePersistedLocale = useCallback(async () => {
    try {
      const settings = await invoke<{ locale?: unknown }>('load_app_settings');
      // A persisted setting can be stale or hand-edited — validate, don't trust.
      if (!isLocaleSetting(settings?.locale)) return;
      setLocaleSettingState(settings.locale);
      const next = resolveLocale(settings.locale, deviceLanguages());
      setLocaleState((current) => {
        if (next !== current) {
          void changeLocale(next);
          return next;
        }
        return current;
      });
    } catch {
      // Vault still locked or settings unavailable — keep the current locale.
    }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      await initI18n(resolveLocale(DEFAULT_LOCALE_SETTING, deviceLanguages()));
      if (!alive) return;
      setReady(true);
      // Best-effort: on a cold start the vault is typically still locked, so
      // this read commonly fails here and succeeds later, on unlock.
      void reconcilePersistedLocale();
    })();
    return () => {
      alive = false;
    };
  }, [reconcilePersistedLocale]);

  useEffect(() => {
    const onVaultUnlocked = () => {
      void reconcilePersistedLocale();
    };
    window.addEventListener(VAULT_UNLOCKED_EVENT, onVaultUnlocked);
    return () => window.removeEventListener(VAULT_UNLOCKED_EVENT, onVaultUnlocked);
  }, [reconcilePersistedLocale]);

  const setLocale = (setting: LocaleSetting) => {
    // Persist the SETTING (which may be `system`); apply the RESOLVED locale.
    const next = resolveLocale(setting, deviceLanguages());
    setLocaleSettingState(setting);
    setLocaleState(next);
    void changeLocale(next);
    void (async () => {
      try {
        const current = await invoke<Record<string, unknown>>('load_app_settings');
        await invoke('save_app_settings', { settings: { ...current, locale: setting } });
      } catch {
        // A failed write leaves the session translated but unpersisted; not fatal.
      }
    })();
  };

  if (!ready) return null;

  return (
    <LocaleContext.Provider value={{ locale, localeSetting, setLocale }}>
      <I18nextProvider i18n={i18next}>{children}</I18nextProvider>
    </LocaleContext.Provider>
  );
};
