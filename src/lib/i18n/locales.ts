/** Every locale that ships. Adding one means adding a folder under src/locales
 *  and an entry here — nothing else. */
export const SUPPORTED_LOCALES = [
  { code: 'en', label: 'English' },
  { code: 'de', label: 'Deutsch' },
] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number]['code'];

export const DEFAULT_LOCALE: Locale = 'en';

/** Guard for a persisted value, which may be stale or hand-edited. */
export function isSupportedLocale(value: unknown): value is Locale {
  return typeof value === 'string' && SUPPORTED_LOCALES.some((l) => l.code === value);
}
