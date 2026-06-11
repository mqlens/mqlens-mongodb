import type { Monaco } from '@monaco-editor/react';
import { getCompletions, type Surface, type CompletionKind } from './mongoCompletions';
import type { SchemaMap } from './useCollectionSchema';

interface ModelMeta { surface: Surface; getFields: () => string[]; getSchema: () => SchemaMap | undefined; getCollections?: () => string[]; getStageOperator?: () => string | undefined; }
const modelMeta = new Map<string, ModelMeta>();
let registered = false;

export function setModelMeta(uri: string, meta: ModelMeta) { modelMeta.set(uri, meta); }
export function clearModelMeta(uri: string) { modelMeta.delete(uri); }

function kindToMonaco(monaco: Monaco, kind: CompletionKind) {
  const k = monaco.languages.CompletionItemKind;
  switch (kind) {
    case 'field': return k.Field;
    case 'operator': return k.Operator;
    case 'stage': return k.Keyword;
    case 'method': return k.Method;
    case 'enum': return k.EnumMember;
    case 'ejson': return k.Struct;
    default: return k.Text;
  }
}

export function registerMongoCompletionProvider(monaco: Monaco) {
  if (registered) return;
  registered = true;

  // Drop the DOM library from the JS language service so the mongosh editor
  // doesn't suggest browser types (Headers, HTMLElement, …). Keep core
  // JavaScript (ES) + our Mongo completions only.
  const ts = (monaco.languages as unknown as { typescript?: any }).typescript;
  if (ts?.javascriptDefaults) {
    const d = ts.javascriptDefaults;
    d.setCompilerOptions({ ...d.getCompilerOptions(), lib: ['es2020'], allowNonTsExtensions: true });
  }

  // Disable the built-in JSON language completions ($schema, etc.) so only our
  // Mongo provider contributes in the filter/projection/sort/aggregation editors.
  // Keep diagnostics/validation on.
  const json = (monaco.languages as unknown as { json?: any }).json;
  if (json?.jsonDefaults) {
    const jd = json.jsonDefaults;
    jd.setModeConfiguration({ ...jd.modeConfiguration, completionItems: false });
  }

  const provider = {
    // Word-starting characters: '.' (db.<coll>, field paths), '$' (operators),
    // and '"' — in the JSON surfaces every key starts with a quote, so without
    // it the dropdown never opens for field names (Monaco's quickSuggestions
    // are disabled inside strings by default).
    triggerCharacters: ['.', '$', '"'],
    provideCompletionItems(model: any, position: any) {
      const meta = modelMeta.get(model.uri.toString());
      if (!meta) return { suggestions: [] };
      const textBeforeCursor: string = model.getValueInRange({
        startLineNumber: position.lineNumber, startColumn: 1,
        endLineNumber: position.lineNumber, endColumn: position.column,
      });
      const token = textBeforeCursor.match(/[\w$]*$/)?.[0] ?? '';
      const items = getCompletions({
        surface: meta.surface, textBeforeCursor, token,
        fields: meta.getFields(), schema: meta.getSchema(), collections: meta.getCollections?.(),
        stageOperator: meta.getStageOperator?.(),
      });
      const range = {
        startLineNumber: position.lineNumber, endLineNumber: position.lineNumber,
        startColumn: position.column - token.length, endColumn: position.column,
      };
      return {
        // sortText preserves getCompletions' intentional order (e.g. the
        // schema-matched EJSON wrapper first) against Monaco's default sort.
        suggestions: items.map((it, idx) => ({
          label: it.label, kind: kindToMonaco(monaco, it.kind),
          insertText: it.insertText, detail: it.detail, range,
          sortText: String(idx).padStart(4, '0'),
          insertTextRules: it.isSnippet
            ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
            : undefined,
        })),
      };
    },
  };
  monaco.languages.registerCompletionItemProvider('json', provider);
  monaco.languages.registerCompletionItemProvider('javascript', provider);
}
