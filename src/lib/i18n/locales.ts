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

/**
 * What the user picked, which is not the same thing as the locale we run in:
 * `system` means "follow the device". Mirrors ThemeMode's `system` option — the
 * split matters because "chose English" and "never chose" must stay
 * distinguishable, or a German device would be overridden forever by a default.
 */
export const SYSTEM_LOCALE: 'system' = 'system';
export type LocaleSetting = typeof SYSTEM_LOCALE | Locale;

/** The default is `system`, so a German user gets German without hunting for a setting. */
export const DEFAULT_LOCALE_SETTING: LocaleSetting = SYSTEM_LOCALE;

export function isLocaleSetting(value: unknown): value is LocaleSetting {
  return value === SYSTEM_LOCALE || isSupportedLocale(value);
}

/**
 * Resolve the setting to the locale to actually run in.
 *
 * An explicit choice always wins. For `system` (and for anything unrecognised,
 * so a stale config degrades to auto rather than to nothing) we walk the
 * device's languages in preference order and match on the PRIMARY SUBTAG, so
 * `de-AT` and `de-CH` are German speakers rather than English fallbacks.
 * Falls back to English when nothing preferred is shipped.
 *
 * Pure — takes the language list rather than reading `navigator`, so it is
 * testable and callable from anywhere.
 */
export function resolveLocale(
  setting: LocaleSetting,
  languages: readonly string[] | undefined
): Locale {
  if (isSupportedLocale(setting)) return setting;
  for (const tag of languages ?? []) {
    const primary = String(tag).split('-')[0]?.toLowerCase();
    const hit = SUPPORTED_LOCALES.find((l) => l.code === primary);
    if (hit) return hit.code;
  }
  return DEFAULT_LOCALE;
}

/** The device's preferred languages, most-preferred first. */
export function deviceLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  return navigator.languages?.length ? navigator.languages : [navigator.language].filter(Boolean);
}
