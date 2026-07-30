import { describe, it, expect } from 'vitest';
import { SUPPORTED_LOCALES } from '../locales';
import { NAMESPACES } from '../index';

// Flatten a catalog to dotted key paths so nesting differences surface too.
const keysOf = (obj: Record<string, unknown>, prefix = ''): string[] =>
  Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? keysOf(v as Record<string, unknown>, `${prefix}${k}.`)
      : [`${prefix}${k}`],
  );

const load = async (locale: string, ns: string) =>
  (await import(`../../../locales/${locale}/${ns}.json`)).default as Record<string, unknown>;

describe('locale catalogs', () => {
  it('every locale has every namespace with identical key sets', async () => {
    for (const ns of NAMESPACES) {
      const en = keysOf(await load('en', ns)).sort();
      for (const { code } of SUPPORTED_LOCALES) {
        if (code === 'en') continue;
        const other = keysOf(await load(code, ns)).sort();
        // Both directions: a missing key means untranslated copy; an extra key
        // means a stale entry left behind by a rename.
        expect(other, `${code}/${ns}.json is missing keys present in en`).toEqual(en);
      }
    }
  });

  it('has no empty translations', async () => {
    for (const ns of NAMESPACES) {
      for (const { code } of SUPPORTED_LOCALES) {
        const cat = await load(code, ns);
        const empty = keysOf(cat).filter((k) =>
          k.split('.').reduce<any>((o, part) => o?.[part], cat) === '',
        );
        expect(empty, `${code}/${ns}.json has empty values`).toEqual([]);
      }
    }
  });
});
