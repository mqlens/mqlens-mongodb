import { describe, it, expect, beforeEach } from 'vitest';
import {
  DOC_LANGUAGE_ID,
  DOC_SYNTAX_TOKENS,
  DOC_TOKEN_POSTFIX,
  registerDocLanguage,
  resetDocLanguageForTests,
} from '../monacoDocLanguage';
import { syntaxRules } from '../monacoAppTheme';

type Action = string | { token: string; next?: string };
type Rule = [RegExp, Action];

/** Capture what the module registers, without pulling in real Monaco. */
type Pair = { open: string; close: string; notIn?: string[] };
type Config = {
  brackets?: [string, string][];
  autoClosingPairs?: Pair[];
  surroundingPairs?: Pair[];
  indentationRules?: { increaseIndentPattern: RegExp; decreaseIndentPattern: RegExp };
  wordPattern?: RegExp;
  comments?: unknown;
};

function fakeMonaco() {
  const registered: string[] = [];
  let tokenizer: Record<string, Rule[]> | undefined;
  let postfix: string | undefined;
  let config: Config | undefined;
  return {
    monaco: {
      languages: {
        register: ({ id }: { id: string }) => registered.push(id),
        setMonarchTokensProvider: (
          _id: string,
          provider: { tokenizer: Record<string, Rule[]>; tokenPostfix?: string },
        ) => {
          tokenizer = provider.tokenizer;
          postfix = provider.tokenPostfix;
        },
        setLanguageConfiguration: (_id: string, c: Config) => {
          config = c;
        },
      },
    } as never,
    registered,
    rules: () => tokenizer ?? { root: [] },
    postfix: () => postfix,
    config: () => config,
  };
}

/**
 * Classify `text` the way Monarch would: walk left to right, taking the first
 * rule that matches at the current offset.
 */
function tokenize(
  tokenizer: Record<string, Rule[]>,
  text: string,
): { text: string; token: string }[] {
  const out: { text: string; token: string }[] = [];
  const stack: string[] = [];
  let state = 'root';
  let rest = text;
  while (rest.length > 0) {
    let matched = false;
    for (const [pattern, action] of tokenizer[state] ?? []) {
      const anchored = new RegExp(`^(?:${pattern.source})`, pattern.flags.replace('g', ''));
      const m = anchored.exec(rest);
      if (m && m[0].length > 0) {
        const token = typeof action === 'string' ? action : action.token;
        const next = typeof action === 'string' ? undefined : action.next;
        out.push({ text: m[0], token });
        rest = rest.slice(m[0].length);
        if (next === '@pop') state = stack.pop() ?? 'root';
        else if (next) {
          stack.push(state);
          state = next.replace('@', '');
        }
        matched = true;
        break;
      }
    }
    if (!matched) rest = rest.slice(1);
  }
  return out;
}

describe('document editor language', () => {
  beforeEach(() => resetDocLanguageForTests());

  it('registers under its own id rather than reusing javascript', () => {
    const f = fakeMonaco();
    registerDocLanguage(f.monaco);
    expect(f.registered).toEqual([DOC_LANGUAGE_ID]);
  });

  it('is idempotent, so every editor may call it', () => {
    const f = fakeMonaco();
    registerDocLanguage(f.monaco);
    registerDocLanguage(f.monaco);
    expect(f.registered).toHaveLength(1);
  });

  it('separates a key from a string value, which javascript mode cannot', () => {
    const f = fakeMonaco();
    registerDocLanguage(f.monaco);
    const tokens = tokenize(f.rules(), '"name" : "Ada"');
    expect(tokens.find((t) => t.text === '"name"')?.token).toBe('key');
    expect(tokens.find((t) => t.text === '"Ada"')?.token).toBe('string');
  });

  it('reads a bare mongosh key as a key', () => {
    const f = fakeMonaco();
    registerDocLanguage(f.monaco);
    const tokens = tokenize(f.rules(), 'name : "Ada"');
    expect(tokens[0]).toEqual({ text: 'name', token: 'key' });
  });

  it('colours BSON constructors and their arguments separately', () => {
    const f = fakeMonaco();
    registerDocLanguage(f.monaco);
    const tokens = tokenize(f.rules(), 'ObjectId("507f1f77bcf86cd799439011")');
    expect(tokens[0]).toEqual({ text: 'ObjectId', token: 'constructor' });
    expect(tokens.find((t) => t.token === 'string')?.text).toBe('"507f1f77bcf86cd799439011"');
  });

  it('does not mistake a key named like a constructor for a call', () => {
    const f = fakeMonaco();
    registerDocLanguage(f.monaco);
    // Quoted: the constructor pattern cannot match at the opening quote.
    expect(tokenize(f.rules(), '"ObjectId" : 1')[0]).toEqual({
      text: '"ObjectId"',
      token: 'key',
    });
    // Bare: only the following parenthesis separates a call from a field name,
    // and the constructor rule is matched first.
    expect(tokenize(f.rules(), 'ObjectId : "legacy"')[0]).toEqual({
      text: 'ObjectId',
      token: 'key',
    });
    expect(tokenize(f.rules(), 'ISODate: 1')[0]).toEqual({
      text: 'ISODate',
      token: 'key',
    });
  });

  it('still reads a constructor call as a call, including with a space', () => {
    const f = fakeMonaco();
    registerDocLanguage(f.monaco);
    expect(tokenize(f.rules(), 'ObjectId("abc")')[0]).toEqual({
      text: 'ObjectId',
      token: 'constructor',
    });
    expect(tokenize(f.rules(), 'ISODate ("2025-01-01")')[0]).toEqual({
      text: 'ISODate',
      token: 'constructor',
    });
  });

  it('classifies literals and punctuation', () => {
    const f = fakeMonaco();
    registerDocLanguage(f.monaco);
    const kinds = (src: string) => tokenize(f.rules(), src).map((t) => t.token);
    expect(kinds('true')).toContain('boolean');
    expect(kinds('false')).toContain('boolean');
    expect(kinds('null')).toContain('null');
    expect(kinds('-12.5e3')).toContain('number');
    expect(kinds('{},:')).toEqual(['delimiter', 'delimiter', 'delimiter', 'delimiter']);
  });

  it('keeps a half-typed string coloured', () => {
    const f = fakeMonaco();
    registerDocLanguage(f.monaco);
    const tokens = tokenize(f.rules(), '"unfinis');
    expect(tokens[0]?.token).toBe('string');
  });

  it('maps every token to a design token the grid also uses', () => {
    // The mapping is the single definition shared with the theme; a token
    // without one would silently fall back to VS Code's colours.
    const tokens = new Set(DOC_SYNTAX_TOKENS.map((t) => t.token));
    for (const expected of ['key', 'string', 'number', 'boolean', 'null', 'constructor', 'delimiter']) {
      expect(tokens.has(expected)).toBe(true);
    }
    for (const { cssToken, fallback } of DOC_SYNTAX_TOKENS) {
      expect(cssToken).toMatch(/^(syntax-|muted-foreground)/);
      expect(fallback).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('keeps the editing behaviour the javascript language provided', () => {
    // Switching language also drops its configuration, so auto-closing, bracket
    // matching, folding and word selection have to be supplied here.
    const f = fakeMonaco();
    registerDocLanguage(f.monaco);
    const config = f.config();
    expect(config).toBeDefined();

    expect(config?.brackets).toEqual([
      ['{', '}'],
      ['[', ']'],
      ['(', ')'],
    ]);

    // All three JavaScript quotings auto-close, as they did under javascript.
    const closing = (config?.autoClosingPairs ?? []).map((p) => p.open);
    expect(closing).toEqual(expect.arrayContaining(['{', '[', '(', '"', "'", '`']));

    // A quote must not auto-close inside a string.
    for (const quote of ['"', "'", '`']) {
      const pair = config?.autoClosingPairs?.find((p) => p.open === quote);
      expect(pair?.notIn).toContain('string');
    }

    // Selecting text and typing a quote should wrap it.
    const surrounding = (config?.surroundingPairs ?? []).map((p) => p.open);
    expect(surrounding).toEqual(expect.arrayContaining(['{', '[', '(', '"', "'", '`']));

    expect(config?.indentationRules?.increaseIndentPattern.test('  "a": {')).toBe(true);
    expect(config?.indentationRules?.decreaseIndentPattern.test('  },')).toBe(true);
    expect(config?.wordPattern).toBeInstanceOf(RegExp);
  });

  it('does not offer comment toggling for a document literal', () => {
    const f = fakeMonaco();
    registerDocLanguage(f.monaco);
    expect(f.config()?.comments).toBeUndefined();
  });

  it('scopes its tokens so theme rules cannot repaint other editors', () => {
    // Monaco matches theme rules by token name across every language, so an
    // unscoped `string` rule would also repaint the JavaScript query and shell
    // editors. Monarch appends this suffix to each token.
    const f = fakeMonaco();
    registerDocLanguage(f.monaco);
    expect(f.postfix()).toBe(DOC_TOKEN_POSTFIX);
    expect(DOC_TOKEN_POSTFIX).toBe(`.${DOC_LANGUAGE_ID}`);
  });

  it('emits theme rules only for this language', () => {
    const rules = syntaxRules();
    expect(rules.length).toBe(DOC_SYNTAX_TOKENS.length);
    for (const rule of rules) {
      expect(rule.token.endsWith(DOC_TOKEN_POSTFIX)).toBe(true);
      // Hex without a leading '#', which is what Monaco expects.
      expect(rule.foreground).toMatch(/^[0-9a-f]{6}$/i);
    }
  });

  it('colours a quoted NumberLong argument as a number, matching the grid', () => {
    // `docToShell` quotes it because a 64-bit value cannot survive as a JS
    // number, but the grid renders it with `text-syntax-number`.
    const f = fakeMonaco();
    registerDocLanguage(f.monaco);
    const tokens = tokenize(f.rules(), 'NumberLong("9007199254740993")');
    expect(tokens[0]).toEqual({ text: 'NumberLong', token: 'constructor' });
    expect(tokens.find((t) => t.text.includes('9007199254740993'))?.token).toBe('number');
  });

  it('leaves an unquoted NumberInt argument as a number too', () => {
    // No special case needed: it is emitted unquoted and the grid agrees.
    const f = fakeMonaco();
    registerDocLanguage(f.monaco);
    const tokens = tokenize(f.rules(), 'NumberInt(7)');
    expect(tokens[0]).toEqual({ text: 'NumberInt', token: 'constructor' });
    expect(tokens.find((t) => t.text === '7')?.token).toBe('number');
  });

  it('keeps string-valued constructors as strings, as the grid does', () => {
    const f = fakeMonaco();
    registerDocLanguage(f.monaco);
    for (const src of [
      'ObjectId("507f1f77bcf86cd799439011")',
      'ISODate("2025-01-04T00:00:00.000Z")',
      'NumberDecimal("12.50")',
    ]) {
      const tokens = tokenize(f.rules(), src);
      expect(tokens[0]?.token).toBe('constructor');
      expect(tokens.find((t) => t.token === 'string')).toBeDefined();
      expect(tokens.find((t) => t.token === 'number')).toBeUndefined();
    }
  });

  it('leaves the numeric-argument state on a half-typed call', () => {
    // Otherwise an unterminated call would swallow the rest of the document
    // while it is being written.
    const f = fakeMonaco();
    registerDocLanguage(f.monaco);
    const tokens = tokenize(f.rules(), 'NumberLong(  , "later" : 1');
    // The stray comma pops back to root, so the following text tokenizes normally.
    expect(tokens.find((t) => t.text === '"later"')?.token).toBe('key');
  });
});