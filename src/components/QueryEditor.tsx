import React, { useEffect, useRef } from 'react';
import Editor, { type Monaco } from '@monaco-editor/react';
import { registerMongoCompletionProvider, setModelMeta, clearModelMeta } from '../lib/monacoMongo';
import type { Surface } from '../lib/mongoCompletions';
import type { SchemaMap } from '../lib/useCollectionSchema';
import { useMonacoTheme } from '../lib/useMonacoTheme';
import { useThemeOptional } from '@/hooks/use-theme';
import { registerMqlensMonacoThemes, refreshMqlensMonacoTheme } from '../lib/monacoAppTheme';
import { cn } from '@/lib/utils';

let overflowNode: HTMLElement | null = null;
function getOverflowNode(): HTMLElement | undefined {
  if (typeof document === 'undefined') return undefined;
  if (!overflowNode) {
    overflowNode = document.createElement('div');
    overflowNode.className = 'monaco-editor';
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
  const monacoRef = useRef<Monaco | null>(null);
  const theme = useMonacoTheme();
  const themeCtx = useThemeOptional();
  const presetId = themeCtx?.config.presetId;

  useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco) return;
    refreshMqlensMonacoTheme(monaco);
    monaco.editor.setTheme(theme);
  }, [theme, presetId]);

  const editorHeight = height ?? (singleLine ? 22 : 120);

  const overflowWidgetsDomNode = getOverflowNode();

  const quickSuggestions = { other: true, comments: false, strings: true };

  const multiLineOptions = {
    minimap: { enabled: false }, lineNumbers: 'off' as const, folding: false,
    scrollBeyondLastLine: false, wordWrap: 'on' as const, fontSize: 12,
    scrollbar: { vertical: 'auto' as const, horizontal: 'auto' as const }, overviewRulerLanes: 0,
    renderLineHighlight: 'none' as const, tabSize: 2,
    fixedOverflowWidgets: true, overflowWidgetsDomNode,
    quickSuggestions,
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
    acceptSuggestionOnEnter: 'on' as const,
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
        monacoRef.current = monaco;
        registerMqlensMonacoThemes(monaco);
        monaco.editor.setTheme(theme);
        registerMongoCompletionProvider(monaco);

        // ⌘/Ctrl+Enter always runs; plain Enter is bound below for single-line fields.
        ed.onKeyDown((e) => {
          if (e.keyCode === monaco.KeyCode.Enter && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            e.stopPropagation();
            onRunRef.current?.();
          }
        });

        if (singleLine) {
          // Let Monaco accept suggestions on Enter when the widget is open; run only when closed.
          ed.addCommand(
            monaco.KeyCode.Enter,
            () => onRunRef.current?.(),
            '!suggestWidgetVisible && !renameInputVisible && !inSnippetMode',
          );
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
      <div
        className={cn(
          'flex h-7 min-w-0 flex-1 items-center bg-input',
          '[&_.monaco-editor]:bg-transparent [&_.monaco-editor-background]:bg-transparent',
          '[&_.margin]:bg-transparent [&_.monaco-scrollable-element]:bg-transparent',
          className
        )}
      >
        {editor}
      </div>
    );
  }

  return (
    <div className="w-full min-w-0 bg-background">
      {editor}
    </div>
  );
};
