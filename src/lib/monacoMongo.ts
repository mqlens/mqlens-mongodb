import type { Monaco } from '@monaco-editor/react';
import { getCompletions, type Surface, type CompletionKind } from './mongoCompletions';
import type { SchemaMap } from './useCollectionSchema';

interface ModelMeta { surface: Surface; getFields: () => string[]; getSchema: () => SchemaMap | undefined; }
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
    default: return k.Text;
  }
}

export function registerMongoCompletionProvider(monaco: Monaco) {
  if (registered) return;
  registered = true;
  const provider = {
    triggerCharacters: ['$', '"', '.', ' ', '{'],
    provideCompletionItems(model: any, position: any) {
      const meta = modelMeta.get(model.uri.toString());
      if (!meta) return { suggestions: [] };
      const textBeforeCursor: string = model.getValueInRange({
        startLineNumber: position.lineNumber, startColumn: 1,
        endLineNumber: position.lineNumber, endColumn: position.column,
      });
      const word = model.getWordUntilPosition(position);
      const token = textBeforeCursor.slice(word.startColumn - 1).match(/[\w$.]*$/)?.[0] ?? word.word;
      const items = getCompletions({
        surface: meta.surface, textBeforeCursor, token,
        fields: meta.getFields(), schema: meta.getSchema(),
      });
      const range = {
        startLineNumber: position.lineNumber, endLineNumber: position.lineNumber,
        startColumn: position.column - token.length, endColumn: position.column,
      };
      return {
        suggestions: items.map((it) => ({
          label: it.label, kind: kindToMonaco(monaco, it.kind),
          insertText: it.insertText, detail: it.detail, range,
        })),
      };
    },
  };
  monaco.languages.registerCompletionItemProvider('json', provider);
  monaco.languages.registerCompletionItemProvider('javascript', provider);
}
