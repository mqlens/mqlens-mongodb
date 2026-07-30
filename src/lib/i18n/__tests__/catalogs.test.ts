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

const valueAt = (cat: Record<string, unknown>, key: string) =>
  key.split('.').reduce<any>((o, part) => o?.[part], cat);

// German values that are legitimately identical to their English source:
// loanwords, proper nouns, product names, and protocol/format identifiers
// that a German-speaking developer would recognise unchanged. Anything not
// on this list that matches English is presumed untranslated — translate
// it, don't add it here without checking it really is a loanword.
const ALLOWED_IDENTICAL_VALUES = new Set([
  // Product / brand names
  'MQLens',
  'MongoDB Database Tools',
  // Established German loanwords (identical spelling in both languages)
  'System',
  'Theme',
  'Port',
  'Tools',
  'Updates',
  'Normal',
  'Text',
  'Status:',
  'Proxy',
  'Server',
  ' · offline',
  // Acronyms / format & protocol identifiers, never translated
  'MCP',
  'JSON',
  'URI',
  'TLS / SSL',
  'SCRAM-SHA-1',
  'MONGODB-AWS (IAM)',
  'GSSAPI (Kerberos)',
  'LDAP (PLAIN)',
  'Snappy',
  'Zlib',
  // Kerberos-protocol-specific term (RFC 4120), kept untranslated like "Realm"
  'Principal',
  // Feature/tab names shared with the (currently English-only, out-of-scope)
  // Dump/Restore views — see settings:tools.dbToolsDescription
  'Dump (mongodump)…',
  'Restore (mongorestore)…',
  // Literal default value for the GridFS bucket prefix, not UI copy
  'fs',
]);

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

  it('has no German value byte-identical to English outside the allowlist', async () => {
    for (const ns of NAMESPACES) {
      const en = await load('en', ns);
      const de = await load('de', ns);
      const suspicious = keysOf(en).filter((k) => {
        const enVal = valueAt(en, k);
        const deVal = valueAt(de, k);
        return (
          typeof enVal === 'string' &&
          enVal === deVal &&
          !ALLOWED_IDENTICAL_VALUES.has(enVal)
        );
      });
      expect(
        suspicious,
        `de/${ns}.json has values identical to en that aren't on the allowlist ` +
          `(likely untranslated): ${suspicious.join(', ')}`,
      ).toEqual([]);
    }
  });
});
