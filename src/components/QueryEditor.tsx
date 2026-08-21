import React, { useCallback, useEffect, useRef, useState } from 'react';
import Editor, { type Monaco, type OnMount } from '@monaco-editor/react';
import { registerMongoCompletionProvider, setModelMeta, clearModelMeta } from '../lib/monacoMongo';
import type { Surface } from '../lib/mongoCompletions';
import type { SchemaMap } from '../lib/useCollectionSchema';
import { useMonacoTheme, useMonacoFontSize, useMonacoScale } from '../lib/useMonacoTheme';
import { useThemeOptional } from '@/hooks/use-theme';
import { registerMqlensMonacoThemes, refreshMqlensMonacoTheme } from '../lib/monacoAppTheme';
import { cn } from '@/lib/utils';
import {
  clampQueryBarHeight,
  EDITOR_FONT_BASELINE_PX,
  growQueryBarHeight,
  QUERY_BAR_HEIGHT_DEFAULT,
  QUERY_BAR_OPTION_HEIGHT,
} from '@/lib/themes/ui-scale';

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
  /** Emit mongosh-style completions (bare keys + ISODate()/ObjectId()) instead
   *  of EJSON. Set by the main query bar, which parses shell syntax. */
  shellSyntax?: boolean;
  /** Roomier single-line field (taller row, larger font) for the primary query
   *  input, which carries almost all of the typing. */
  large?: boolean;
  /** Wrap and grow this field with its content independently of visual size. */
  growWithContent?: boolean;
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
  shellSyntax,
  large = false,
  growWithContent = false,
  'data-testid': testid,
}) => {
  const fieldsRef = useRef(fields); fieldsRef.current = fields;
  const schemaRef = useRef(schema); schemaRef.current = schema;
  const onRunRef = useRef(onRun); onRunRef.current = onRun;
  const stageOperatorRef = useRef(stageOperator); stageOperatorRef.current = stageOperator;
  const shellSyntaxRef = useRef(shellSyntax); shellSyntaxRef.current = shellSyntax;
  const uriRef = useRef<string | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const theme = useMonacoTheme();
  // Monaco can't read the CSS vars the UI scales with — derive its size so the
  // editor grows/shrinks with the interface font-size setting and zoom.
  const uiScale = useMonacoScale();
  const multiLineFontSize = useMonacoFontSize(12);
  const themeCtx = useThemeOptional();
  const presetId = themeCtx?.config.presetId;

  useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco) return;
    refreshMqlensMonacoTheme(monaco);
    monaco.editor.setTheme(theme);
  }, [theme, presetId]);

  // Row height is user-configurable (Settings → Appearance) and shared by the
  // query, projection and sort rows so the bar stays symmetric. It's stored as
  // design px against the 13px baseline; the wrapper uses rem so it tracks the
  // interface scale, and Monaco's px height is scaled to match — otherwise the
  // editor becomes a short band inside a taller row (off-centre text + a seam).
  // Only the primary query field is user-sizable. The small option fields keep a
  // compact fixed height, so raising the setting doesn't inflate the whole bar —
  // Compass likewise grows only its document editor, never the small inputs.
  const configuredHeight = clampQueryBarHeight(
    themeCtx?.config.queryBarHeight ?? QUERY_BAR_HEIGHT_DEFAULT
  );
  const rowDesignPx = large ? configuredHeight : QUERY_BAR_OPTION_HEIGHT;
  const singleLineRowRem = rowDesignPx / EDITOR_FONT_BASELINE_PX;
  const singleLineRowPx = Math.round(rowDesignPx * uiScale);
  // The text scales with the row: a taller bar should read bigger, not leave a
  // small line floating in a large box. The ratio is whatever it is at the
  // default height, so the stock bar looks exactly as before.
  const singleLineFontDesignPx = large
    ? (13 * configuredHeight) / QUERY_BAR_HEIGHT_DEFAULT
    : 11.5;
  const singleLineFontSize = useMonacoFontSize(singleLineFontDesignPx);
  const singleLineLineHeight = Math.round(singleLineFontSize * 1.4);
  // Centre the single line within the full-height box.
  const singleLinePadTop = Math.max(0, Math.round((singleLineRowPx - singleLineLineHeight) / 2));
  // Only the primary Query field grows: it carries almost all of the typing,
  // and the compact option rows beside it should not move when it does.
  const growable = singleLine && (large || growWithContent);
  const [grownHeight, setGrownHeight] = useState<number | null>(null);
  const growthEditorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const growthMetricsRef = useRef({
    growable,
    lineHeight: singleLineLineHeight,
    minHeight: singleLineRowPx,
    contentPadding: singleLinePadTop,
  });
  growthMetricsRef.current = {
    growable,
    lineHeight: singleLineLineHeight,
    minHeight: singleLineRowPx,
    contentPadding: singleLinePadTop,
  };
  const followGrowableContent = useCallback(() => {
    const metrics = growthMetricsRef.current;
    const ed = growthEditorRef.current;
    if (!metrics.growable || !ed) {
      setGrownHeight(null);
      return;
    }
    setGrownHeight(
      growQueryBarHeight(
        ed.getContentHeight(),
        metrics.lineHeight,
        metrics.minHeight,
        metrics.contentPadding
      )
    );
  }, []);

  // Appearance changes do not necessarily produce a Monaco content-size event.
  // Recompute explicitly so a mounted editor follows query height, zoom and font
  // scale changes using the current metrics rather than its mount-time values.
  useEffect(() => {
    followGrowableContent();
  }, [followGrowableContent, growable, singleLineLineHeight, singleLinePadTop, singleLineRowPx]);

  const editorHeight =
    height ?? (singleLine ? (growable ? (grownHeight ?? singleLineRowPx) : singleLineRowPx) : 120);

  const overflowWidgetsDomNode = getOverflowNode();

  const quickSuggestions = { other: true, comments: false, strings: true };

  const multiLineOptions = {
    minimap: { enabled: false }, lineNumbers: 'off' as const, folding: false,
    scrollBeyondLastLine: false, wordWrap: 'on' as const, fontSize: multiLineFontSize,
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
    // The Query field wraps; the compact option rows stay on one line. Without
    // this a long filter ran off the right edge with the horizontal scrollbar
    // hidden, so the only way to read the rest of it was to move the caret.
    wordWrap: (growable ? 'on' : 'off') as 'on' | 'off',
    scrollbar: {
      // Once it has grown as far as it may, it has to be scrollable — a hidden
      // scrollbar and a fixed height is what made the query unreachable.
      vertical: (growable ? 'auto' : 'hidden') as 'auto' | 'hidden',
      horizontal: 'hidden' as const,
      handleMouseWheel: growable,
      verticalScrollbarSize: growable ? 8 : 0,
      horizontalScrollbarSize: 0,
    },
    overviewRulerLanes: 0,
    renderLineHighlight: 'none' as const,
    scrollBeyondLastLine: false,
    fontSize: singleLineFontSize,
    lineHeight: singleLineLineHeight,
    padding: { top: singleLinePadTop, bottom: 0 },
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
      defaultLanguage="javascript"
      language="javascript"
      theme={theme}
      value={value}
      onChange={(v) => onChange(v ?? '')}
      wrapperProps={testid ? { 'data-testid': testid } : undefined}
      beforeMount={(monaco: Monaco) => {
        // Query text is mongosh-style, not strict JSON: unquoted keys, single
        // quotes, ObjectId(…)/ISODate(…), and braceless field lists are all
        // valid input (see parseShellJson). Turn off Monaco's built-in language
        // diagnostics so it stops red-squiggling that valid input — the app's
        // own parseShellJson validation drives the real error state. This MUST
        // run in beforeMount (not onMount): by the time onMount fires the JS
        // worker has already validated the model, and updating the options then
        // doesn't clear the markers.
        monaco.languages?.typescript?.javascriptDefaults?.setDiagnosticsOptions({
          noSemanticValidation: true,
          noSyntaxValidation: true,
          noSuggestionDiagnostics: true,
        });
        monaco.languages?.json?.jsonDefaults?.setDiagnosticsOptions({ validate: false });
      }}
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

        // `automaticLayout` handles width; height is ours, because the row it
        // sits in has to grow with wrapped content. The callback reads refs so
        // settings changed after mount cannot leave it using stale metrics.
        growthEditorRef.current = ed;
        const contentSizeSubscription = ed.onDidContentSizeChange(followGrowableContent);
        followGrowableContent();

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
            getShellSyntax: () => shellSyntaxRef.current,
          });
        }
        ed.onDidDispose(() => {
          contentSizeSubscription.dispose();
          if (growthEditorRef.current === ed) growthEditorRef.current = null;
          if (uriRef.current) clearModelMeta(uriRef.current);
        });
      }}
      options={singleLine ? singleLineOptions : multiLineOptions}
    />
  );

  if (singleLine) {
    return (
      <div
        className={cn(
          // No background of its own: the row (FindQueryBar's queryColClass)
          // paints it, and draws the focus ring as `ring-inset` — a box-shadow
          // rendered UNDER child content. An opaque background here covered
          // that ring everywhere except the semi-transparent label badge, so
          // focusing the field outlined the badge instead of the whole box.
          'flex min-w-0 flex-1 items-center pl-2',
          '[&_.monaco-editor]:bg-transparent [&_.monaco-editor-background]:bg-transparent',
          '[&_.margin]:bg-transparent [&_.monaco-scrollable-element]:bg-transparent',
          // Monaco paints a shadow over the top edge once the line scrolls
          // sideways; in a one-line field that reads as a stray gradient band.
          '[&_.scroll-decoration]:shadow-none [&_.overflow-guard]:bg-transparent',
          className
        )}
        style={{
          height: growable
            ? (typeof editorHeight === 'number' ? `${editorHeight}px` : editorHeight)
            : `${singleLineRowRem}rem`,
        }}
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
