import { vi } from 'vitest';

/**
 * The parts of the Monaco namespace the app configures, shaped like
 * monaco-editor 0.56 and later: the TypeScript and JSON language services live
 * at the top level (`monaco.typescript`, `monaco.json`). The
 * `monaco.languages.typescript` / `monaco.languages.json` aliases that 0.55
 * still carried are gone, so code that reaches for them finds nothing.
 */
export function createFakeMonaco() {
  let jsCompilerOptions: Record<string, unknown> = { target: 99, allowJs: true };
  const javascriptDefaults = {
    getCompilerOptions: vi.fn(() => jsCompilerOptions),
    setCompilerOptions: vi.fn((options: Record<string, unknown>) => {
      jsCompilerOptions = options;
    }),
    setDiagnosticsOptions: vi.fn(),
  };
  const jsonDefaults = {
    modeConfiguration: {
      completionItems: true,
      hovers: true,
      documentSymbols: true,
      tokens: true,
      colors: true,
      foldingRanges: true,
      diagnostics: true,
      selectionRanges: true,
    },
    setModeConfiguration: vi.fn(),
    setDiagnosticsOptions: vi.fn(),
  };
  return {
    KeyCode: { Enter: 3 },
    editor: {
      defineTheme: vi.fn(),
      setTheme: vi.fn(),
      EditorOption: { readOnly: 104 },
    },
    languages: {
      registerCompletionItemProvider: vi.fn(() => ({ dispose: vi.fn() })),
      CompletionItemKind: { Method: 0, Field: 3, Struct: 6, Operator: 11, EnumMember: 16, Keyword: 17, Text: 18 },
      CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
    },
    typescript: { javascriptDefaults },
    json: { jsonDefaults },
  };
}

export type FakeMonaco = ReturnType<typeof createFakeMonaco>;
