import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { DEFAULT_LOCALE, type Locale } from './locales';

import enCommon from '../../locales/en/common.json';
import deCommon from '../../locales/de/common.json';
import enSettings from '../../locales/en/settings.json';
import deSettings from '../../locales/de/settings.json';
import enConnections from '../../locales/en/connections.json';
import deConnections from '../../locales/de/connections.json';
import enErrors from '../../locales/en/errors.json';
import deErrors from '../../locales/de/errors.json';
import enSidebar from '../../locales/en/sidebar.json';
import deSidebar from '../../locales/de/sidebar.json';

/** Namespaces mirror the UI surfaces so a translator can take one file at a
 *  time. Every namespace must exist for every locale (enforced by the catalog
 *  parity test) — English is the fallback for any missing key. */
// Exported (only) so the catalog test suite can assert this object's locale
// keys stay in lockstep with SUPPORTED_LOCALES — nothing else should import it.
export const resources = {
  en: { common: enCommon, settings: enSettings, connections: enConnections, errors: enErrors, sidebar: enSidebar },
  de: { common: deCommon, settings: deSettings, connections: deConnections, errors: deErrors, sidebar: deSidebar },
} as const;

export const NAMESPACES = ['common', 'settings', 'connections', 'errors', 'sidebar'] as const;

export async function initI18n(locale: Locale = DEFAULT_LOCALE): Promise<void> {
  if (i18next.isInitialized) {
    await i18next.changeLanguage(locale);
    return;
  }
  await i18next.use(initReactI18next).init({
    resources,
    lng: locale,
    fallbackLng: DEFAULT_LOCALE,
    ns: NAMESPACES as unknown as string[],
    defaultNS: 'common',
    interpolation: { escapeValue: false }, // React already escapes
    returnNull: false,
  });
}

export async function changeLocale(locale: Locale): Promise<void> {
  await i18next.changeLanguage(locale);
}

export { i18next };
