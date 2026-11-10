import type { Monaco } from '@monaco-editor/react';
import { getCompletions, inQuote, openQuote, type Surface, type CompletionKind } from './mongoCompletions';
import type { SchemaMap } from './useCollectionSchema';

// The getters get the editor's text up to the cursor, and may answer later.
type Lookup<T> = (textBeforeCursor: string) => T;
interface ModelMeta { surface: Surface; getFields: Lookup<string[]>; getSchema: Lookup<SchemaMap | undefined>; getCollections?: () => string[]; getStageOperator?: () => string | undefined; getShellSyntax?: () => boolean | undefined; /** True while a lookup is still loading, so Monaco asks again as the user types. */ isIncomplete?: () => boolean; }
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
  //
  // The language services are top-level namespaces (`monaco.typescript`,
  // `monaco.json`). Monaco 0.55 also aliased them under `monaco.languages`;
  // 0.56 dropped the alias, and reading it then quietly configured nothing.
  const d = monaco.typescript.javascriptDefaults;
  d.setCompilerOptions({ ...d.getCompilerOptions(), lib: ['es2020'], allowNonTsExtensions: true });

  // Belt-and-braces: also disable the built-in JSON language completions
  // ($schema, etc.) in case any editor still uses JSON mode. The query editors
  // themselves now run in JavaScript mode with diagnostics turned off (see
  // QueryEditor), since query text is mongosh-style, not strict JSON.
  const jd = monaco.json.jsonDefaults;
  jd.setModeConfiguration({ ...jd.modeConfiguration, completionItems: false });

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
      const textAfterCursor: string = model.getValueInRange({
        startLineNumber: position.lineNumber, startColumn: position.column,
        endLineNumber: position.lineNumber, endColumn: model.getLineMaxColumn(position.lineNumber),
      });
      // In the query surfaces a dotted field path (usage.total) is ONE token, so
      // a half-typed nested key like "usage.to" matches and replaces the whole
      // path. The shell surface keeps db.coll.method segmented (dot-free token),
      // except inside a quoted key, where the dot is part of the path.
      const segmented = meta.surface === 'shell' && !inQuote(textBeforeCursor);
      const token = textBeforeCursor.match(segmented ? /[\w$]*$/ : /[\w$.]*$/)?.[0] ?? '';
      const textUpToCursor: string = model.getValueInRange({
        startLineNumber: 1, startColumn: 1, endLineNumber: position.lineNumber, endColumn: position.column,
      });
      const fields = meta.getFields(textUpToCursor);
      const schema = meta.getSchema(textUpToCursor);
      // A shell query often spans lines (`find({` above, `ti` here), so the
      // shell's context comes from all the text before the cursor; the token
      // and its range stay on this line.
      const items = getCompletions({
        surface: meta.surface, textAfterCursor, token,
        textBeforeCursor: meta.surface === 'shell' ? textUpToCursor : textBeforeCursor,
        fields, schema, collections: meta.getCollections?.(),
        stageOperator: meta.getStageOperator?.(), shellSyntax: meta.getShellSyntax?.(),
      });
      const range = {
        startLineNumber: position.lineNumber, endLineNumber: position.lineNumber,
        startColumn: position.column - token.length, endColumn: position.column,
      };
      // Typing `"` makes Monaco auto-insert the closing one after the cursor. An
      // item that closes the quote itself (`city": "value"`) replaces that one
      // too, or the text ends up with `""`.
      const quote = openQuote(textBeforeCursor);
      const autoClosed = quote !== null && textAfterCursor.startsWith(quote);
      const rangeFor = (insertText: string) =>
        autoClosed && insertText.includes(quote) ? { ...range, endColumn: range.endColumn + 1 } : range;
      return {
        incomplete: meta.isIncomplete?.() ?? false,
        // sortText preserves getCompletions' intentional order (e.g. the
        // schema-matched EJSON wrapper first) against Monaco's default sort.
        suggestions: items.map((it, idx) => ({
          label: it.label, kind: kindToMonaco(monaco, it.kind),
          insertText: it.insertText, detail: it.detail, range: rangeFor(it.insertText),
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
