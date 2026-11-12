import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Monaco } from '@monaco-editor/react';
import { createFakeMonaco } from '../../test/fakeMonaco';

// The provider registers once per module, so each test gets a fresh copy.
async function freshRegister() {
  vi.resetModules();
  const { registerMongoCompletionProvider } = await import('../monacoMongo');
  return registerMongoCompletionProvider;
}

describe('registerMongoCompletionProvider', () => {
  let monaco: ReturnType<typeof createFakeMonaco>;
  beforeEach(() => {
    monaco = createFakeMonaco();
  });

  it('drops the DOM library from the script language service, keeping its other options', async () => {
    const register = await freshRegister();
    register(monaco as unknown as Monaco);

    expect(monaco.typescript.javascriptDefaults.setCompilerOptions).toHaveBeenCalledWith({
      target: 99,
      allowJs: true,
      lib: ['es2020'],
      allowNonTsExtensions: true,
    });
  });

  it("turns off the JSON language's own completions, keeping its other features", async () => {
    const register = await freshRegister();
    register(monaco as unknown as Monaco);

    expect(monaco.json.jsonDefaults.setModeConfiguration).toHaveBeenCalledWith({
      completionItems: false,
      hovers: true,
      documentSymbols: true,
      tokens: true,
      colors: true,
      foldingRanges: true,
      diagnostics: true,
      selectionRanges: true,
    });
  });

  it("replaces the single quote Monaco closed for a key along with the key", async () => {
    vi.resetModules();
    const mod = await import('../monacoMongo');
    mod.registerMongoCompletionProvider(monaco as unknown as Monaco);
    const calls = monaco.languages.registerCompletionItemProvider.mock.calls as unknown as unknown[][];
    const provider = calls[0][1] as {
      provideCompletionItems: (model: unknown, position: unknown) => {
        suggestions: Array<{ label: string; insertText: string; range: { endColumn: number } }>;
      };
    };
    // The cursor sits before the closing quote Monaco typed: db.customers.find({ 'ti|'
    const line = "db.customers.find({ 'ti'";
    const uri = 'inmemory://single-quote';
    const model = {
      uri: { toString: () => uri },
      getValueInRange: (r: { startColumn: number; endColumn: number }) => line.slice(r.startColumn - 1, r.endColumn - 1),
      getLineMaxColumn: () => line.length + 1,
    };
    mod.setModelMeta(uri, { surface: 'shell', getFields: () => ['tier'], getSchema: () => new Map([['tier', { type: 'string' }]]) });

    const { suggestions } = provider.provideCompletionItems(model, { lineNumber: 1, column: line.length });
    const tier = suggestions.find((s) => s.label === 'tier')!;
    expect(tier.insertText).toBe(`tier': "\${1:value}"`);
    expect(tier.range.endColumn).toBe(line.length + 1);
  });

  it('reads a shell query that spans lines as one, replacing only the word on the cursor line', async () => {
    vi.resetModules();
    const mod = await import('../monacoMongo');
    mod.registerMongoCompletionProvider(monaco as unknown as Monaco);
    const calls = monaco.languages.registerCompletionItemProvider.mock.calls as unknown as unknown[][];
    const provider = calls[0][1] as {
      provideCompletionItems: (model: unknown, position: unknown) => {
        suggestions: Array<{ label: string; range: { startLineNumber: number; startColumn: number; endColumn: number } }>;
      };
    };
    const lines = ['db.customers.find({', '  ti'];
    type Range = { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };
    const offset = (line: number, column: number) =>
      lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0) + column - 1;
    const uri = 'inmemory://multi-line';
    const model = {
      uri: { toString: () => uri },
      getValueInRange: (r: Range) =>
        lines.join('\n').slice(offset(r.startLineNumber, r.startColumn), offset(r.endLineNumber, r.endColumn)),
      getLineMaxColumn: (line: number) => lines[line - 1].length + 1,
    };
    mod.setModelMeta(uri, { surface: 'shell', getFields: () => ['tier'], getSchema: () => new Map([['tier', { type: 'string' }]]) });

    const { suggestions } = provider.provideCompletionItems(model, { lineNumber: 2, column: 5 });
    const tier = suggestions.find((s) => s.label === 'tier');
    expect(tier?.range).toMatchObject({ startLineNumber: 2, startColumn: 3, endColumn: 5 });
  });
});
