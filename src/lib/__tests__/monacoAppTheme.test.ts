import { describe, it, expect, beforeEach } from "vitest";
import {
  hslComponentsToHex,
  tokenResolverFor,
  attachMonaco,
  setMonacoAppTheme,
  resetMonacoAppThemeForTests,
} from "../monacoAppTheme";

describe("hslComponentsToHex", () => {
  it("converts space-separated HSL components to hex for Monaco", () => {
    expect(hslComponentsToHex("215 14% 17%")).toMatch(/^#[0-9a-f]{6}$/i);
    expect(hslComponentsToHex("0 0% 100%")).toBe("#ffffff");
    expect(hslComponentsToHex("0 0% 0%")).toBe("#000000");
  });

  it("passes through hex values", () => {
    expect(hslComponentsToHex("#1e1e1e")).toBe("#1e1e1e");
  });
});

// #282: the editor was themed a render behind the app. Colours were read from
// computed styles inside a child effect, and React runs those before the
// parent's — so ThemeProvider had not written the new variables yet. Measured
// with a provider setting a variable and a child reading it:
//
//     reads seen by the child: ["", "DARK"]   // switching to the light theme
//
// Empty on first mount, the previous theme afterwards. That is why nord,
// solarized and high-contrast never reached the editor, and why changing the
// hardcoded default made the symptom swap ends instead of going away.
describe('monaco theme colours come from the config, not the DOM (#282)', () => {
  const defined = new Map<string, { colors: Record<string, string> }>();
  const monaco = {
    editor: {
      defineTheme: (id: string, theme: { colors: Record<string, string> }) =>
        defined.set(id, theme),
      setTheme: () => {},
    },
  } as unknown as Parameters<typeof attachMonaco>[0];

  /** Define the themes from `tokens`, the way ThemeProvider does. */
  const applyTokens = (tokens: Record<string, string>, themeId: 'mqlens-dark' | 'mqlens-light') => {
    resetMonacoAppThemeForTests();
    attachMonaco(monaco);
    setMonacoAppTheme(tokenResolverFor(tokens), themeId);
  };

  beforeEach(() => defined.clear());

  it('uses the token map it is given, ignoring the document entirely', () => {
    // A light preset's own input token, while the DOM still says otherwise.
    document.documentElement.style.setProperty('--input', '222 20% 8%');
    applyTokens({ input: '220 20% 93%', foreground: '222 20% 8%' }, 'mqlens-light');
    expect(defined.get('mqlens-light')!.colors['editor.background']).toBe(
      hslComponentsToHex('220 20% 93%')
    );
  });

  it('does not fall back to the built-in palette when a preset defines the token', () => {
    // The old failure mode: an empty DOM read left every colour on Monaco's
    // hardcoded default, so a preset's palette never arrived.
    applyTokens({ input: '193 100% 12%' }, 'mqlens-dark');
    const background = defined.get('mqlens-dark')!.colors['editor.background'];
    expect(background).toBe(hslComponentsToHex('193 100% 12%'));
    expect(background).not.toBe('#1e1e1e');
  });

  it('still falls back for a token the preset does not define', () => {
    applyTokens({}, 'mqlens-dark');
    expect(defined.get('mqlens-dark')!.colors['editor.background']).toBe('#1e1e1e');
  });

  it('defines the same colours every time it is applied', () => {
    // The definition path used to exist twice, hand-written, which is how one
    // copy gets corrected and the other left stale.
    const tokens = { input: '193 100% 12%', foreground: '0 0% 90%' };
    applyTokens(tokens, 'mqlens-dark');
    const first = { ...defined.get('mqlens-dark')!.colors };
    defined.clear();
    applyTokens(tokens, 'mqlens-dark');
    expect(defined.get('mqlens-dark')!.colors).toEqual(first);
  });
});

// #324 review: defineTheme is GLOBAL, so whichever editor called it last won
// for every editor on screen. Each of QueryEditor, DocumentEditModal and
// MongoShell refreshed on its own schedule, so one resolving from stale CSS
// variables silently overwrote the others — and for a preset change within the
// same mode nothing re-renders afterwards to repair it.
describe('one owner of the global Monaco themes (#324 review)', () => {
  const defined: { colors: Record<string, string> }[] = [];
  const monaco = {
    editor: {
      defineTheme: (id: string, theme: { colors: Record<string, string> }) => {
        if (id === 'mqlens-dark') defined.push(theme);
      },
      setTheme: () => {},
    },
  } as unknown as Parameters<typeof attachMonaco>[0];

  beforeEach(() => {
    defined.length = 0;
    resetMonacoAppThemeForTests();
  });

  it('themes an editor that attaches after the theme was set', () => {
    setMonacoAppTheme(tokenResolverFor({ input: '193 100% 12%' }), 'mqlens-dark');
    attachMonaco(monaco);
    expect(defined.at(-1)!.colors['editor.background']).toBe(
      hslComponentsToHex('193 100% 12%')
    );
  });

  it('re-themes an already-attached editor when the config changes', () => {
    attachMonaco(monaco);
    setMonacoAppTheme(tokenResolverFor({ input: '0 0% 20%' }), 'mqlens-dark');
    expect(defined.at(-1)!.colors['editor.background']).toBe(hslComponentsToHex('0 0% 20%'));
  });

  it('a second editor attaching cannot undo the current theme', () => {
    // The race: another editor mounting used to redefine the themes from the
    // DOM, discarding what the config-derived pass had just written.
    setMonacoAppTheme(tokenResolverFor({ input: '193 100% 12%' }), 'mqlens-dark');
    attachMonaco(monaco);
    attachMonaco(monaco);
    expect(defined.at(-1)!.colors['editor.background']).toBe(
      hslComponentsToHex('193 100% 12%')
    );
  });
});
