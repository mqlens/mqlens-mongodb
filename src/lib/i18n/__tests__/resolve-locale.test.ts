import { describe, it, expect } from 'vitest';
import { isLocaleSetting, resolveLocale } from '../locales';

describe('resolveLocale', () => {
  it('honours an explicit choice regardless of the device language', () => {
    // The whole point of an explicit setting: a German device must stay English
    // if the user asked for English.
    expect(resolveLocale('en', ['de-DE', 'de'])).toBe('en');
    expect(resolveLocale('de', ['en-US'])).toBe('de');
  });

  it('follows the device language when set to system', () => {
    expect(resolveLocale('system', ['de-DE', 'en-US'])).toBe('de');
    expect(resolveLocale('system', ['en-GB'])).toBe('en');
  });

  it('matches on the primary subtag, so regional variants still work', () => {
    // de-AT / de-CH are German speakers; they must not fall back to English.
    expect(resolveLocale('system', ['de-AT'])).toBe('de');
    expect(resolveLocale('system', ['de-CH'])).toBe('de');
    expect(resolveLocale('system', ['DE'])).toBe('de');
  });

  it('takes the first supported language in preference order', () => {
    // The user prefers French, but we do not ship it — German is next and
    // shipped, so it wins over the English fallback.
    expect(resolveLocale('system', ['fr-FR', 'de-DE', 'en-US'])).toBe('de');
  });

  it('falls back to English when no preferred language is supported', () => {
    expect(resolveLocale('system', ['fr-FR', 'ja-JP'])).toBe('en');
  });

  it('falls back to English for a missing or empty language list', () => {
    expect(resolveLocale('system', [])).toBe('en');
    expect(resolveLocale('system', undefined)).toBe('en');
  });

  it('treats an unknown stored setting as system rather than rendering nothing', () => {
    // A hand-edited or stale config must not break the app.
    expect(resolveLocale('klingon' as never, ['de-DE'])).toBe('de');
  });
});

describe('isLocaleSetting', () => {
  it('accepts system and every shipped locale', () => {
    expect(isLocaleSetting('system')).toBe(true);
    expect(isLocaleSetting('en')).toBe(true);
    expect(isLocaleSetting('de')).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isLocaleSetting('fr')).toBe(false);
    expect(isLocaleSetting('')).toBe(false);
    expect(isLocaleSetting(undefined)).toBe(false);
    expect(isLocaleSetting(null)).toBe(false);
    expect(isLocaleSetting(42)).toBe(false);
  });
});
