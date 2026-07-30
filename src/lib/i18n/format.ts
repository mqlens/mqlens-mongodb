import { DEFAULT_LOCALE, type Locale } from './locales';

/** BCP 47 tags for Intl. Locale codes are short; Intl wants the region for
 *  correct grouping and date order. */
const INTL_TAG: Record<Locale, string> = {
  en: 'en-US',
  de: 'de-DE',
};

const tag = (locale: Locale): string => INTL_TAG[locale] ?? INTL_TAG[DEFAULT_LOCALE];

// Intl formatter construction is comparatively expensive; cache per locale+kind.
const numberCache = new Map<string, Intl.NumberFormat>();
const numberFormatter = (locale: Locale, options?: Intl.NumberFormatOptions) => {
  const key = `${locale}:${JSON.stringify(options ?? {})}`;
  let f = numberCache.get(key);
  if (!f) {
    f = new Intl.NumberFormat(tag(locale), options);
    numberCache.set(key, f);
  }
  return f;
};

export function formatNumber(value: number, locale: Locale): string {
  if (!Number.isFinite(value)) return '';
  return numberFormatter(locale).format(value);
}

export function formatDate(value: Date | string | number, locale: Locale): string {
  const d = value instanceof Date ? value : new Date(value);
  // An unparseable value must not surface as "Invalid Date" in the UI.
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(tag(locale), {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(d);
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

export function formatBytes(bytes: number, locale: Locale): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // Whole values read better without a trailing .0; keep one decimal otherwise.
  const formatted = numberFormatter(locale, {
    maximumFractionDigits: Number.isInteger(value) ? 0 : 1,
  }).format(value);
  return `${formatted} ${BYTE_UNITS[unit]}`;
}
