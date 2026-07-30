import React, { createContext, useContext, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { I18nextProvider } from 'react-i18next';
import { changeLocale, i18next, initI18n } from '@/lib/i18n';
import { DEFAULT_LOCALE, isSupportedLocale, type Locale } from '@/lib/i18n/locales';

interface LocaleContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function useLocale(): LocaleContextValue {
  const ctx = useContext(LocaleContext);
  if (!ctx) throw new Error('useLocale must be used inside I18nProvider');
  return ctx;
}

/**
 * Owns i18next and the active locale. Mounted outermost, above ThemeProvider:
 * strings are needed everywhere and i18n has no reason to depend on theming.
 * Children render only once i18next is ready, so nothing ever paints a raw key.
 */
export const I18nProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      let next: Locale = DEFAULT_LOCALE;
      try {
        const settings = await invoke<{ locale?: unknown }>('load_app_settings');
        // A persisted locale can be stale or hand-edited — validate, don't trust.
        if (isSupportedLocale(settings?.locale)) next = settings.locale;
      } catch {
        // Never block startup on settings: fall back to English.
      }
      await initI18n(next);
      if (!alive) return;
      setLocaleState(next);
      setReady(true);
    })();
    return () => {
      alive = false;
    };
  }, []);

  const setLocale = (next: Locale) => {
    setLocaleState(next);
    void changeLocale(next);
    void (async () => {
      try {
        const current = await invoke<Record<string, unknown>>('load_app_settings');
        await invoke('save_app_settings', { settings: { ...current, locale: next } });
      } catch {
        // A failed write leaves the session translated but unpersisted; not fatal.
      }
    })();
  };

  if (!ready) return null;

  return (
    <LocaleContext.Provider value={{ locale, setLocale }}>
      <I18nextProvider i18n={i18next}>{children}</I18nextProvider>
    </LocaleContext.Provider>
  );
};
