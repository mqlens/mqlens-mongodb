import React, { useRef } from 'react';
import Editor, { type Monaco } from '@monaco-editor/react';
import { registerMongoCompletionProvider, setModelMeta, clearModelMeta } from '../lib/monacoMongo';
import type { Surface } from '../lib/mongoCompletions';
import type { SchemaMap } from '../lib/useCollectionSchema';
import { useMonacoTheme } from '../lib/useMonacoTheme';

// A single body-level node where Monaco renders overflow widgets (the suggest
// dropdown). Without this, the widget is trapped inside the query-row's stacking
// context and gets covered by the toolbar / results panel.
let overflowNode: HTMLElement | null = null;
function getOverflowNode(): HTMLElement | undefined {
  if (typeof document === 'undefined') return undefined;
  if (!overflowNode) {
    overflowNode = document.createElement('div');
    overflowNode.className = 'monaco-editor'; // so suggest-widget CSS applies
    overflowNode.style.position = 'absolute';
    overflowNode.style.top = '0';
    overflowNode.style.left = '0';
    overflowNode.style.zIndex = '100000';
    document.body.appendChild(overflowNode);
  }
  return overflowNode;
}

interface QueryEditorProps {
  surface: Surface;
  value: string;
  onChange: (v: string) => void;
  fields: string[];
  schema?: SchemaMap;
  height?: number | string;
  singleLine?: boolean;
  className?: string;
  onRun?: () => void;
  // For aggStage editors that hold a single stage's body: drives
  // operator-specific completions ($group → accumulators, $lookup → keys, …).
  stageOperator?: string;
  'data-testid'?: string;
}

export const QueryEditor: React.FC<QueryEditorProps> = ({
  surface,
  value,
  onChange,
  fields,
  schema,
  height,
  singleLine = false,
  className,
  onRun,
  stageOperator,
  'data-testid': testid,
}) => {
  const fieldsRef = useRef(fields); fieldsRef.current = fields;
  const schemaRef = useRef(schema); schemaRef.current = schema;
  const onRunRef = useRef(onRun); onRunRef.current = onRun;
  const stageOperatorRef = useRef(stageOperator); stageOperatorRef.current = stageOperator;
  const uriRef = useRef<string | null>(null);
  const theme = useMonacoTheme();

  const editorHeight = height ?? (singleLine ? 22 : 120);

  const overflowWidgetsDomNode = getOverflowNode();

  // JSON keys live inside string literals, where Monaco suppresses
  // quick suggestions by default — enable them so field/operator
  // completions keep filtering while the user types a quoted key.
  const quickSuggestions = { other: true, comments: false, strings: true };

  const multiLineOptions = {
    minimap: { enabled: false }, lineNumbers: 'off' as const, folding: false,
    scrollBeyondLastLine: false, wordWrap: 'on' as const, fontSize: 12,
    scrollbar: { vertical: 'auto' as const, horizontal: 'auto' as const }, overviewRulerLanes: 0,
    renderLineHighlight: 'none' as const, tabSize: 2,
    fixedOverflowWidgets: true, overflowWidgetsDomNode,
    quickSuggestions,
    // Enter accepts an open suggestion; otherwise inserts a newline.
    acceptSuggestionOnEnter: 'on' as const,
  };

  const singleLineOptions = {
    minimap: { enabled: false },
    lineNumbers: 'off' as const,
    folding: false,
    glyphMargin: false,
    lineDecorationsWidth: 0,
    lineNumbersMinChars: 0,
    wordWrap: 'off' as const,
    scrollbar: {
      vertical: 'hidden' as const,
      horizontal: 'hidden' as const,
      handleMouseWheel: false,
      verticalScrollbarSize: 0,
      horizontalScrollbarSize: 0,
    },
    overviewRulerLanes: 0,
    renderLineHighlight: 'none' as const,
    scrollBeyondLastLine: false,
    fontSize: 11.5,
    padding: { top: 4, bottom: 0 },
    contextmenu: false,
    automaticLayout: true,
    fixedOverflowWidgets: true,
    overflowWidgetsDomNode,
    tabSize: 2,
    quickSuggestions,
  };

  const editor = (
    <Editor
      height={editorHeight}
      defaultLanguage="json"
      theme={theme}
      value={value}
      onChange={(v) => onChange(v ?? '')}
      wrapperProps={testid ? { 'data-testid': testid } : undefined}
      onMount={(ed, monaco: Monaco) => {
        registerMongoCompletionProvider(monaco);
        // Ctrl/Cmd+Enter runs the query. Scoped to this editor via onKeyDown
        // (NOT addCommand, which registers keybindings globally across editors).
        ed.onKeyDown((e) => {
          if ((e.ctrlKey || e.metaKey) && e.keyCode === monaco.KeyCode.Enter) {
            e.preventDefault();
            e.stopPropagation();
            onRunRef.current?.();
          }
        });
        if (singleLine) {
          // Keep single-line inputs to one line by stripping any newline. We do
          // NOT use editor.addCommand(Enter, …) here — Monaco registers those
          // keybindings GLOBALLY across editors, which would break Enter in the
          // multi-line mongosh/aggregation editors. This listener is scoped to
          // this editor instance only.
          ed.onDidChangeModelContent(() => {
            const v = ed.getValue();
            if (v.includes('\n')) {
              const flat = v.replace(/\n/g, '');
              const pos = ed.getPosition();
              ed.setValue(flat);
              if (pos) ed.setPosition({ lineNumber: 1, column: Math.min(pos.column, flat.length + 1) });
            }
          });
        }
        const model = ed.getModel();
        if (model) {
          uriRef.current = model.uri.toString();
          setModelMeta(uriRef.current, {
            surface,
            getFields: () => fieldsRef.current,
            getSchema: () => schemaRef.current,
            getStageOperator: () => stageOperatorRef.current,
          });
          ed.onDidDispose(() => { if (uriRef.current) clearModelMeta(uriRef.current); });
        }
      }}
      options={singleLine ? singleLineOptions : multiLineOptions}
    />
  );

  if (singleLine) {
    return (
      <div className={className} style={{ flex: 1, minWidth: 0 }}>
        {editor}
      </div>
    );
  }

  return editor;
};
