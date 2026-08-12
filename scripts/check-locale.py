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
        #
        # Each form is measured against the SAME form in English where English
        # has it, and against a sibling only where it does not. Mapping every
        # form onto one English value compares e.g. a `_one` string that names
        # no count against English's `_other`, which does — and reports a
        # placeholder mismatch that is not there.
        expected = {}
        for k, v in en.items():
            m = PLURAL.match(k)
            if not m:
                expected[k] = v
                continue
            base = m.group(1)
            for c in cats:
                exact = en.get(f'{base}_{c}')
                sibling = next((en[f'{base}_{s}'] for s in ('other', 'one', 'many', 'few', 'two', 'zero')
                                if f'{base}_{s}' in en), v)
                expected[f'{base}_{c}'] = exact if exact is not None else sibling
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
    palette_report(LOCALE)
    print('OK' if ok else 'PROBLEMS')
    return 0 if ok else 1


# Words too generic to be worth searching for, or that survive translation
# anyway.
PALETTE_STOPWORDS = {'the', 'and', 'for', 'all', 'new', 'open', 'from', 'with',
                     'into', 'this', 'that', 'tab', 'to', 'in', 'a'}


def palette_report(locale):
    """English search terms a command-palette entry stops answering to.

    The palette scores a query against the title and the keywords, nothing
    else. Translating a title therefore removes every English word in it from
    the search index unless the keywords pick it up — so `export` stops finding
    the export command, in a tool whose users type English command names all
    day. Informational, not a failure: German predates the convention and does
    not satisfy it, and retrofitting it is its own change.
    """
    en = json.load(open('src/locales/en/shell.json', encoding='utf-8'))['commandPalette']
    try:
        loc = json.load(open(f'src/locales/{locale}/shell.json', encoding='utf-8'))['commandPalette']
    except FileNotFoundError:
        return

    def terms(text):
        text = re.sub(r'\{\{[^}]+\}\}', ' ', text)
        return [w for w in re.findall(r'[a-z0-9]+', text.lower()) if len(w) >= 3]

    lost = {}
    for key, entry in en['paletteActions'].items():
        translated = loc['paletteActions'].get(key)
        if not translated:
            continue
        wanted = set(terms(entry['title'])) | set(terms(entry.get('keywords', '')))
        haystack = (translated['title'] + ' ' + translated.get('keywords', '')).lower()
        missing = sorted(w for w in wanted if w not in haystack and w not in PALETTE_STOPWORDS)
        if missing:
            lost[key] = missing
    print()
    if lost:
        print(f'command palette: {len(lost)} action(s) no longer answer to their English terms')
        for key, missing in list(lost.items())[:8]:
            print(f'    {key}: {missing}')
    else:
        print('command palette: every English search term still reaches its action')


if __name__ == '__main__':
    sys.exit(main())
