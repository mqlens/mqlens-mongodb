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
});
