#!/usr/bin/env python3
"""Structural check of a locale catalog against English.

The test suite covers all of this too, but a translator working through 1,800
strings wants the answer in a second, not after a full vitest run — and wants
it per namespace while the catalog is still half-written.

    python3 scripts/check-locale.py zh-Hans
"""
import json, re, sys, glob, os

LOCALE = sys.argv[1] if len(sys.argv) > 1 else 'de'
PLURAL = re.compile(r'(.*)_(zero|one|two|few|many|other)$')
CATEGORIES = {'zh-Hans': ['other'], 'zh-Hant': ['other'], 'ja': ['other'],
              'fr': ['one', 'many', 'other'], 'de': ['one', 'other']}


def flat(o, p=''):
    for k, v in o.items():
        if isinstance(v, dict):
            yield from flat(v, p + k + '.')
        else:
            yield p + k, v


def placeholders(s):
    return sorted(re.findall(r'\{\{[^}]+\}\}', str(s)))


def main():
    cats = CATEGORIES.get(LOCALE, ['one', 'other'])
    ok = True
    for path in sorted(glob.glob('src/locales/en/*.json')):
        ns = os.path.basename(path)[:-5]
        target = f'src/locales/{LOCALE}/{ns}.json'
        if not os.path.exists(target):
            print(f'{ns:<12} MISSING FILE')
            ok = False
            continue
        en = dict(flat(json.load(open(path, encoding='utf-8'))))
        loc = dict(flat(json.load(open(target, encoding='utf-8'))))
        # What this locale should carry: its own plural forms, nothing else.
        expected = {}
        for k, v in en.items():
            m = PLURAL.match(k)
            if m:
                for c in cats:
                    expected[f'{m.group(1)}_{c}'] = v
            else:
                expected[k] = v
        missing = sorted(set(expected) - set(loc))
        extra = sorted(set(loc) - set(expected))
        bad_ph = sorted(k for k in loc if k in expected and placeholders(loc[k]) != placeholders(expected[k]))
        identical = sorted(k for k in loc if k in expected and loc[k] == expected[k])
        empty = sorted(k for k, v in loc.items() if not str(v).strip())
        space = sorted(k for k in loc if k in expected
                       and (str(expected[k])[:1].isspace() != str(loc[k])[:1].isspace()
                            or str(expected[k])[-1:].isspace() != str(loc[k])[-1:].isspace()))
        # Whitespace is NOT compared across locales: a language can need a
        # space where English does not, and vice versa — a full-width colon
        # carries its own gap. The suite snapshots each locale's own set; this
        # only points at the keys worth a second look.
        if missing or extra or bad_ph or empty:
            ok = False
        print(f'{ns:<12} {len(loc):>4} keys  missing={len(missing)} extra={len(extra)} '
              f'placeholders={len(bad_ph)} empty={len(empty)} space={len(space)} identical={len(identical)}')
        for label, items in (('missing', missing), ('extra', extra), ('placeholders', bad_ph),
                             ('empty', empty), ('whitespace differs from en (check, not an error)', space)):
            if items:
                print(f'    {label}: {items[:8]}')
        if identical:
            print(f'    identical to en (allowlist or translate): {identical[:8]}')
    print('OK' if ok else 'PROBLEMS')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
