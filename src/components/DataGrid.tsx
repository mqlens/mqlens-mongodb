import React, { useState, useMemo, useEffect, useContext } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { DocumentViewerContext } from './DocumentViewer';
import { List } from 'react-window';
import { Table, Braces, ChevronRight, ChevronDown, ListFilter, Copy, Check, Edit, Trash2, Plus, Table2, BarChart3, Lightbulb, GitCompareArrows } from 'lucide-react';
import { ChartView } from './ChartView';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { DocumentDiffModal } from './DocumentDiffModal';
import Editor from '@monaco-editor/react';
import { generateQueryCode, CODE_LANGUAGES, CODE_LANGUAGE_MONACO_IDS, type CodeLanguage, type QueryCodeSpec } from '../lib/queryCodeGen';
import { suggestESRIndex, type IndexSuggestion } from '../lib/indexSuggestions';
import { useMonacoTheme, useMonacoFontSize } from '../lib/useMonacoTheme';
import { EJSON } from 'bson';
import { copyValueToText } from '../lib/copyValue';
import { ResultsFindBar } from './ResultsFindBar';
import { registerResultsFindTarget } from '../lib/resultsFindShortcut';
import { findMatches, isMatchAt, stepMatch, type FindCell } from '../lib/resultsFind';
import {
  bsonCallOf,
  bsonInstanceTypeLabel,
  bsonValueText,
  isBsonInstance,
  jsonStringLiteral,
  plainBsonShape,
  tableValueText,
} from '../lib/bsonDisplay';
import type { ListImperativeAPI } from 'react-window';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useThemeOptional } from '@/hooks/use-theme';
import { getScaledRowHeight } from '@/lib/themes/ui-scale';
import { cn } from '@/lib/utils';
import type { SpacingDensity } from '@/lib/themes/schema';

interface DataGridProps {
  documents: Array<Record<string, any>>;
  density?: 'roomy' | 'cozy' | 'compact';
  explainResult?: string | null;
  // The query that produced these results, rendered as runnable driver code
  // (per selected language) in the "Query Code" tab. Null before any run.
  querySpec?: QueryCodeSpec | null;
  onInsertDocument?: () => void;
  onEditDocument?: (doc: Record<string, any>) => void;
  onDuplicateDocument?: (doc: Record<string, any>) => void;
  onDeleteDocument?: (doc: Record<string, any>) => void;
  onAnalyzeSchema?: () => void;
  onUpdateMany?: () => void;
  onDeleteMany?: () => void;
  totalCount?: number;
  estimated?: boolean;
  countLoading?: boolean;
  skip?: number;
  limit?: number;
  onPageChange?: (newSkip: number) => void;
  onPageSizeChange?: (newLimit: number) => void;
  /** Results view mode, owned by the caller so it survives this grid being
   *  unmounted. The results pane renders `{loading ? <spinner/> : <DataGrid/>}`,
   *  so the grid remounts on EVERY run, and switching tabs unmounts the whole
   *  DocumentViewer subtree — local state reset to 'json' both times. Omit both
   *  props to keep the old self-managed behaviour (MongoShell does). */
  viewMode?: ViewMode;
  onViewModeChange?: (mode: ViewMode) => void;
  /**
   * Drop the control bar — the Results/Explain tabs, the view-mode switcher and
   * the row actions — and render the documents alone.
   *
   * For callers showing ONE document that did not come from a query: a change
   * event has no explain plan, no chart worth drawing and nothing to page
   * through, so offering those reads as broken rather than empty. The JSON
   * rendering itself is the part worth sharing.
   */
  chromeless?: boolean;
  // Fired when the user accepts the COLLSCAN suggestion banner's "Create Index" CTA.
  onCreateSuggestedIndex?: (suggestion: IndexSuggestion) => void;
  // The owning connection's write-safeguard mode (#188). 'read_only' disables
  // every write action in this grid (buttons + row actions + context-menu
  // items) with a tooltip, since the backend write_guard would otherwise just
  // bounce the request with a toast. 'confirm_destructive' is intentionally
  // NOT handled here — those writes stay enabled; the typed-name confirm
  // modal (Task 3) gates the actually-destructive ones. Undefined/'normal'
  // behaves exactly as before this feature existed.
  connectionMode?: 'normal' | 'read_only' | 'confirm_destructive';
}

export type ViewMode = 'table' | 'tree' | 'json' | 'chart';

interface ExplainNode {
  name: string;
  type: 'result' | 'stage' | 'collection' | 'index';
  detail?: string;
  children?: ExplainNode[];
}

const GridIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-primary">
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M3 9h18M3 15h18M9 3v18M15 3v18" />
  </svg>
);

const ResultIcon = () => (
  <div className="relative flex h-8 w-8 items-center justify-center rounded-lg border border-success/20 bg-success/10">
    <GridIcon />
    <span className="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full border border-card bg-success text-[8px] font-bold text-primary-foreground shadow">
      ✓
    </span>
  </div>
);

const ScanIcon = () => (
  <div className="relative flex h-8 w-8 items-center justify-center rounded-lg border border-primary/20 bg-primary/10">
    <GridIcon />
    <span className="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full border border-card bg-primary text-[8px] font-bold text-primary-foreground shadow">
      ↓
    </span>
  </div>
);

const IndexIcon = () => (
  <div className="relative flex h-8 w-8 items-center justify-center rounded-lg border border-chart-4/20 bg-chart-4/10">
    <GridIcon />
    <span className="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full border border-card bg-chart-4 text-[8px] font-bold text-primary-foreground shadow">
      🔑
    </span>
  </div>
);

const CollectionIcon = () => (
  <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-accent">
    <GridIcon />
  </div>
);

// getStageNameLabel / makeParseStage / getExplainTree are pure, module-scope
// functions (getExplainTree is exported and covered directly by a unit test
// that calls it with a single argument — see DataGrid.test.tsx), so they
// can't call the useTranslation hook. Instead they accept an optional `t`
// (defaulting to a no-i18next stand-in that just resolves each call's
// `defaultValue`, with the same {{var}} interpolation react-i18next does).
// The component passes its real `t` in; direct callers (like the test) fall
// back to the English defaults, so behavior is unchanged when `t` is omitted.
type ExplainTFunc = (key: string, options?: Record<string, any>) => string;

const interpolateDefault = (template: string, vars: Record<string, any>): string =>
  template.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in vars ? String(vars[k]) : `{{${k}}}`));

const defaultExplainT: ExplainTFunc = (key, options) => {
  const { defaultValue, ...vars } = options ?? {};
  return interpolateDefault(defaultValue ?? key, vars);
};

const getStageNameLabel = (stage: string, t: ExplainTFunc = defaultExplainT): string => {
  const s = stage.toUpperCase();
  if (s === 'COLLSCAN') return t('documents:dataGrid.explain.stage.collectionScan', { defaultValue: 'Collection scan' });
  if (s === 'IXSCAN') return t('documents:dataGrid.explain.stage.indexScan', { defaultValue: 'Index scan' });
  if (s === 'FETCH') return t('documents:dataGrid.explain.stage.fetchDocuments', { defaultValue: 'Fetch documents' });
  if (s === 'PROJECTION_SIMPLE' || s === 'PROJECTION') return t('documents:dataGrid.explain.stage.projection', { defaultValue: 'Projection' });
  if (s === 'SORT') return t('documents:dataGrid.explain.stage.sort', { defaultValue: 'Sort' });
  if (s === 'SKIP') return t('documents:dataGrid.explain.stage.skip', { defaultValue: 'Skip' });
  if (s === 'LIMIT') return t('documents:dataGrid.explain.stage.limit', { defaultValue: 'Limit' });
  if (s === 'OR') return t('documents:dataGrid.explain.stage.orMerge', { defaultValue: 'OR Merge' });
  if (s === 'AND_HASH' || s === 'AND_SORTED') return t('documents:dataGrid.explain.stage.indexIntersection', { defaultValue: 'Index Intersection' });
  return stage.charAt(0).toUpperCase() + stage.slice(1).toLowerCase();
};

// Build a parseStage bound to a namespace (the find winningPlan walker).
const makeParseStage = (namespace: string, t: ExplainTFunc = defaultExplainT) => {
  const parseStage = (stageObj: any): ExplainNode => {
    const stageName = stageObj?.stage || "STAGE";
    const name = getStageNameLabel(stageName, t);
    const children: ExplainNode[] = [];

    if (stageObj?.inputStage) {
      children.push(parseStage(stageObj.inputStage));
    }
    if (Array.isArray(stageObj?.inputStages)) {
      stageObj.inputStages.forEach((sub: any) => {
        if (sub) children.push(parseStage(sub));
      });
    }

    if (children.length === 0) {
      if (stageName === 'IXSCAN') {
        children.push({
          name: t('documents:dataGrid.explain.labels.indexNode', {
            indexName: stageObj.indexName || "category_1",
            defaultValue: 'Index: {{indexName}}',
          }),
          type: 'index',
          detail: stageObj.keyPattern ? JSON.stringify(stageObj.keyPattern) : undefined
        });
      } else {
        children.push({
          name: t('documents:dataGrid.explain.labels.collectionNode', {
            namespace,
            defaultValue: 'Collection\n{{namespace}}',
          }),
          type: 'collection',
          detail: namespace
        });
      }
    }

    return {
      name,
      type: 'stage',
      detail: stageName + (stageObj.indexName ? ` (${stageObj.indexName})` : ''),
      children: children.length > 0 ? children : undefined
    };
  };
  return parseStage;
};

export const getExplainTree = (explainStr: string, t: ExplainTFunc = defaultExplainT): ExplainNode => {
  try {
    const explainJson = JSON.parse(explainStr);

    // Aggregate explain (M1): a `stages` array in execution order. The `$cursor`
    // stage carries the real queryPlanner; the rest are pipeline stages. Build a
    // chain Result -> last stage -> ... -> $cursor -> winningPlan -> collection.
    if (Array.isArray(explainJson?.stages)) {
      const stages = explainJson.stages;
      const cursorStage = stages.find((s: any) => s && s.$cursor);
      const cursorQP = cursorStage?.$cursor?.queryPlanner;
      const namespace = cursorQP?.namespace || "collection";
      const parseStage = makeParseStage(namespace, t);
      const cursorChild: ExplainNode = cursorQP?.winningPlan
        ? parseStage(cursorQP.winningPlan)
        : {
            name: t('documents:dataGrid.explain.labels.collectionNode', { namespace, defaultValue: 'Collection\n{{namespace}}' }),
            type: 'collection',
            detail: namespace,
          };

      let current: ExplainNode | null = null;
      stages.forEach((stageObj: any) => {
        const key = stageObj && Object.keys(stageObj)[0];
        if (!key) return;
        if (key === '$cursor') {
          current = {
            name: '$cursor',
            type: 'stage',
            detail: t('documents:dataGrid.explain.labels.documentsFromCollection', { defaultValue: 'Documents from collection' }),
            children: [cursorChild],
          };
        } else {
          current = {
            name: key,
            type: 'stage',
            detail: key,
            children: current ? [current] : undefined,
          };
        }
      });
      return { name: t('documents:dataGrid.explain.stage.result', { defaultValue: 'Result' }), type: "result", children: current ? [current] : [] };
    }

    const queryPlanner = explainJson?.queryPlanner || {};
    const namespace = queryPlanner?.namespace || "collection";
    const winningPlan = queryPlanner?.winningPlan;

    if (!winningPlan) {
      return {
        name: t('documents:dataGrid.explain.stage.result', { defaultValue: 'Result' }),
        type: "result",
        children: [
          {
            name: t('documents:dataGrid.explain.stage.collectionScan', { defaultValue: 'Collection scan' }),
            type: "stage",
            detail: "COLLSCAN",
            children: [
              {
                name: t('documents:dataGrid.explain.labels.collectionNode', { namespace, defaultValue: 'Collection\n{{namespace}}' }),
                type: "collection",
                detail: namespace
              }
            ]
          }
        ]
      };
    }

    return {
      name: t('documents:dataGrid.explain.stage.result', { defaultValue: 'Result' }),
      type: "result",
      children: [makeParseStage(namespace, t)(winningPlan)]
    };

  } catch (e) {
    console.error("Failed to parse explain tree", e);
    return {
      name: t('documents:dataGrid.explain.stage.result', { defaultValue: 'Result' }),
      type: "result",
      children: [
        {
          name: t('documents:dataGrid.explain.stage.collectionScan', { defaultValue: 'Collection scan' }),
          type: "stage",
          detail: "COLLSCAN",
          children: [
            {
              name: t('documents:dataGrid.explain.labels.collectionFallback', { defaultValue: 'Collection' }),
              type: "collection",
              detail: "collection"
            }
          ]
        }
      ]
    };
  }
};

const explainNodeHover: Record<ExplainNode['type'], string> = {
  result: 'hover:border-success/40',
  stage: 'hover:border-primary/40',
  collection: 'hover:border-border',
  index: 'hover:border-warning/40',
};

const RenderTreeNode: React.FC<{ node: ExplainNode }> = ({ node }) => {
  return (
    <div className="flex w-full flex-col items-center">
      <div
        className={cn(
          'relative flex w-full shrink-0 items-stretch gap-3.5 rounded-[10px] border border-border bg-card px-4 py-3.5 shadow-sm transition-all hover:-translate-y-px hover:shadow-md',
          explainNodeHover[node.type]
        )}
      >
        <div className="flex items-start pt-0.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-border">
            {node.type === 'result' && <ResultIcon />}
            {node.type === 'stage' && <ScanIcon />}
            {node.type === 'collection' && <CollectionIcon />}
            {node.type === 'index' && <IndexIcon />}
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-foreground">{node.name}</span>
          </div>
          {node.type === 'stage' && node.detail && (
            <Badge variant="secondary" className="w-fit font-mono text-[10px]">
              {node.detail.split(' ')[0]}
            </Badge>
          )}
          {node.type !== 'stage' && node.detail && (
            <span className="font-mono text-[11px] text-muted-foreground">{node.detail}</span>
          )}
        </div>
      </div>

      {node.children && node.children.length > 0 && (
        <div className="flex w-full flex-col items-center">
          <div className="flex flex-col items-center py-1">
            <div className="h-4 w-px bg-border" />
            <ChevronDown size={10} className="text-border" />
          </div>

          <div className="flex w-full flex-col items-center gap-4">
            {node.children.map((child, idx) => (
              <RenderTreeNode key={idx} node={child} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

// Lightweight, data-only descriptor for one rendered JSON line (no React nodes,
// so building thousands of them stays cheap; content is rendered lazily per row).
interface JsonLine {
  num: number;
  depth: number;
  kind: 'scalar' | 'open' | 'close' | 'empty';
  keyName: string | null;
  value?: any;
  bracket?: string; // open/close bracket char
  brackets?: string; // empty '{}' / '[]'
  hasComma: boolean;
  ancestors: number[];
  docIndex: number;
  foldId?: number;
  closeChar?: string;
  isDocRoot?: boolean;
  doc?: Record<string, any>;
}

const jsonPunct = (text: string) => <span className="text-muted-foreground">{text}</span>;
const jsonKeyNode = (k: string) => (
  <>
    <span className="text-syntax-key">"{k}"</span>
    {jsonPunct(' : ')}
  </>
);
const printableJsonString = jsonStringLiteral;

// Row index for the table's header band. It is on screen and its field names are
// searchable, but it is not a row in the virtualized list, so it addresses no
// index there — stepping to it scrolls horizontally only.
const TABLE_HEADER_ROW_INDEX = -1;

// Width of the table's row-number gutter, ahead of the first data column.
// Shared by the header, the rows, the body's minWidth and find's horizontal
// scrolling, all of which have to agree on where a column starts.
const TABLE_ROW_NUMBER_WIDTH_PX = 48;

// One row of the tree-table view (Key | Value | Type), data-only for cheap virtualization.
interface TreeRow {
  num: number;
  depth: number;
  keyName: string;
  kind: 'scalar' | 'object' | 'array';
  value?: any; // scalar value
  childCount: number; // for object/array containers
  type: string; // BSON type label
  ancestors: number[];
  docIndex: number;
  foldId?: number; // present when expandable
  isDocRoot?: boolean;
  doc?: Record<string, any>;
}

// Extra (per-render) data handed to the JSON view's virtualized rows.
interface JsonRowExtra {
  lines: JsonLine[];
  collapsedFolds: Set<number>;
  /** Highlight class for a matched line, or undefined. Module-scope row, so
   *  the lookup is passed in rather than closed over. */
  findHighlightClass: (rowId: number) => string | undefined;
  toggleFold: (id: number) => void;
  documents: Array<Record<string, any>>;
  openCtxMenu: (
    e: React.MouseEvent,
    doc: Record<string, any> | undefined,
    field?: string,
    value?: any,
  ) => void;
  renderContent: (line: JsonLine) => React.ReactNode;
  hasRowActions: boolean;
  RowActions: React.ComponentType<{ doc: Record<string, any> }>;
  t: (key: string) => string;
}

// Virtualized row for the JSON view (one descriptor per row).
//
// Defined at module scope on purpose: react-window remounts every row whenever
// the `rowComponent` reference changes, and a remount replaces the row's DOM —
// which silently wipes out any active text selection. When this lived inline in
// DataGrid it was a brand-new function on each render, so any unrelated
// re-render dropped the user's selection mid-copy. A stable identity lets
// re-renders reconcile in place, so the selection survives. Per-render data is
// passed through `rowProps` instead of closures.
const JsonRow = ({
  index,
  style,
  lines,
  collapsedFolds,
  findHighlightClass,
  toggleFold,
  documents,
  openCtxMenu,
  renderContent,
  hasRowActions,
  RowActions,
  t,
}: { index: number; style: React.CSSProperties } & JsonRowExtra) => {
  const line = lines[index];
  if (!line) return null;
  const folded = line.foldId !== undefined && collapsedFolds.has(line.foldId);
  return (
    <div
      style={style}
      className={cn(
        'flex items-center whitespace-pre hover:bg-accent',
        line.docIndex % 2 === 0 ? 'bg-background' : 'bg-card',
        line.isDocRoot && line.docIndex > 0 && 'border-t border-border',
        findHighlightClass(line.num)
      )}
      // Lets a copy reconstruct the selected range from the line data even
      // after virtualization has unmounted the rows it started on (#311).
      data-json-line={index}
      data-doc-even={line.docIndex % 2 === 0}
      onContextMenu={(e) => openCtxMenu(e, documents[line.docIndex], line.kind === 'scalar' ? line.keyName ?? undefined : undefined, line.value)}
    >
      <span
        className="json-view-gutter sticky left-0 w-[52px] shrink-0 select-none bg-inherit pr-3 text-right text-[10px] text-muted-foreground before:content-[attr(data-num)]"
        data-num={line.num}
        aria-hidden="true"
      />
      <span className="sticky left-[52px] flex w-4 shrink-0 items-center justify-center bg-inherit text-muted-foreground">
        {line.foldId !== undefined && (
          <button
            type="button"
            onClick={() => toggleFold(line.foldId!)}
            className="flex cursor-pointer items-center justify-center rounded-sm hover:bg-accent hover:text-foreground"
            data-testid="json-fold-btn"
            aria-label={folded ? t('documents:dataGrid.tooltips.expand') : t('documents:dataGrid.tooltips.collapse')}
          >
            {folded ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
          </button>
        )}
      </span>
      <span
        className="flex-1 whitespace-pre pr-4 text-foreground select-text [&_*]:select-text"
        style={{ paddingLeft: line.depth * 18 }}
      >
        {renderContent(line)}
        {folded && (
          <span className="text-muted-foreground">
            {' … '}
            {line.closeChar}
            {line.hasComma ? ',' : ''}
          </span>
        )}
        {line.isDocRoot && hasRowActions && line.doc && (
          <span className="ml-2.5 inline-flex align-middle opacity-0 group-hover:opacity-100 [.flex:hover>&]:opacity-100">
            <RowActions doc={line.doc} />
          </span>
        )}
      </span>
    </div>
  );
};

export const DataGrid: React.FC<DataGridProps> = ({
  documents,
  density: densityProp,
  explainResult = null,
  querySpec = null,
  onInsertDocument,
  onEditDocument,
  onDuplicateDocument,
  onDeleteDocument,
  onAnalyzeSchema,
  onUpdateMany,
  onDeleteMany,
  totalCount,
  estimated,
  countLoading,
  skip,
  limit,
  onPageChange,
  onPageSizeChange,
  viewMode: controlledViewMode,
  onViewModeChange,
  onCreateSuggestedIndex,
  connectionMode,
  chromeless = false,
}) => {
  const { t } = useTranslation('documents');
  const themeCtx = useThemeOptional();
  const density: SpacingDensity =
    densityProp ?? themeCtx?.config.spacingDensity ?? 'cozy';

  // #188: read_only disables writes in this grid; confirm_destructive does
  // NOT (see the connectionMode doc comment on DataGridProps above).
  const isReadOnly = connectionMode === 'read_only';

  // ESR-rule suggestion derived from the current explain plan (null unless it's a COLLSCAN).
  const indexSuggestion = useMemo(
    () => (explainResult ? suggestESRIndex(explainResult) : null),
    [explainResult]
  );

  // Right-click context menu shared by all result views (Table / Tree / JSON).
  const [ctxMenu, setCtxMenu] = useState<
    { x: number; y: number; doc: Record<string, any>; field?: string; value?: any } | null
  >(null);

  // Two-step "Compare with…" flow: the first pick is held here as the armed
  // source; the second pick (a different document) opens the diff modal.
  const [pendingCompare, setPendingCompare] = useState<Record<string, any> | null>(null);
  const [diffPair, setDiffPair] = useState<{ a: Record<string, any>; b: Record<string, any> } | null>(null);

  // A new result set invalidates any armed compare source: the armed doc may
  // no longer exist (or may differ) in the fresh documents array, and matching
  // is by reference — silently diffing a stale doc would mislead. An OPEN diff
  // modal is deliberately left alone: it deep-copied its two docs and stays
  // valid regardless of what the grid refreshes to underneath it.
  useEffect(() => {
    setPendingCompare(null);
  }, [documents]);

  const writeClipboard = (text: string) => {
    try { navigator.clipboard?.writeText(text); } catch { /* clipboard unavailable */ }
  };
  const openCtxMenu = (
    e: React.MouseEvent,
    doc: Record<string, any> | undefined,
    field?: string,
    value?: any,
  ) => {
    if (!doc) return;
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY, doc, field, value });
  };
  const buildCtxItems = (m: NonNullable<typeof ctxMenu>): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [];
    if (onEditDocument) items.push({ label: t('dataGrid.actions.editDocument'), icon: <Edit size={13} />, onClick: () => onEditDocument(m.doc), disabled: isReadOnly, title: isReadOnly ? t('dataGrid.tooltips.readOnly') : undefined });
    if (onDuplicateDocument) items.push({ label: t('dataGrid.actions.duplicateDocument'), icon: <Plus size={13} />, onClick: () => onDuplicateDocument(m.doc), disabled: isReadOnly, title: isReadOnly ? t('dataGrid.tooltips.readOnly') : undefined });
    items.push({ label: t('dataGrid.actions.copyDocumentJson'), icon: <Copy size={13} />, onClick: () => writeClipboard(JSON.stringify(m.doc, null, 2)) });
    if (!pendingCompare) {
      items.push({
        label: t('dataGrid.actions.compareWith'),
        icon: <GitCompareArrows size={13} />,
        separatorBefore: true,
        onClick: () => setPendingCompare(m.doc),
      });
    } else if (pendingCompare === m.doc) {
      items.push({
        label: t('dataGrid.actions.cancelCompareSelection'),
        icon: <GitCompareArrows size={13} />,
        separatorBefore: true,
        onClick: () => setPendingCompare(null),
      });
    } else {
      items.push({
        label: t('dataGrid.actions.compareWithSelected'),
        icon: <GitCompareArrows size={13} />,
        separatorBefore: true,
        onClick: () => {
          setDiffPair({ a: pendingCompare, b: m.doc });
          setPendingCompare(null);
        },
      });
      items.push({
        label: t('dataGrid.actions.compareWithReplaceSelection'),
        icon: <GitCompareArrows size={13} />,
        onClick: () => setPendingCompare(m.doc),
      });
    }
    if (m.field) {
      items.push({ label: t('dataGrid.actions.copyValue'), icon: <Copy size={13} />, separatorBefore: true, onClick: () => writeClipboard(copyValueToText(m.value)) });
      items.push({ label: t('dataGrid.actions.copyFieldName'), icon: <Copy size={13} />, onClick: () => writeClipboard(m.field!) });
    }
    if (onDeleteDocument) items.push({ label: t('dataGrid.actions.deleteDocument'), icon: <Trash2 size={13} />, danger: true, separatorBefore: true, onClick: () => onDeleteDocument(m.doc), disabled: isReadOnly, title: isReadOnly ? t('dataGrid.tooltips.readOnly') : undefined });
    return items;
  };
  const docViewerContext = useContext(DocumentViewerContext);
  const [uncontrolledViewMode, setUncontrolledViewMode] = useState<ViewMode>('json');
  // Chromeless has no switcher, so JSON is the only mode reachable — and the
  // right one for a single document nobody queried for.
  const viewMode = chromeless ? 'json' : (controlledViewMode ?? uncontrolledViewMode);
  const setViewMode = (mode: ViewMode) => {
    setUncontrolledViewMode(mode);
    onViewModeChange?.(mode);
  };
  const [activeTab, setActiveTab] = useState<'results' | 'explain' | 'query'>('results');
  // Chromeless callers have no tabs to switch and no explain plan to show.
  const effectiveTab = chromeless ? 'results' : activeTab;

  // Column resize: table view keeps per-column widths (session-scoped — the
  // column set changes per collection); the tree view's key column persists.
  const [colWidths, setColWidths] = useState<Record<string, number>>({});
  const colWidth = (col: string) => colWidths[col] ?? 180;
  // The table header and the virtualized body are separate boxes: only the body
  // scrolls. Once resized columns overflow the viewport the header would stay
  // put and its cells would sit at a different x-offset than the rows, so mirror
  // the body's horizontal scroll onto the header.
  const tableHeaderRef = React.useRef<HTMLDivElement>(null);
  const tableBodyRef = React.useRef<HTMLDivElement>(null);
  useEffect(() => {
    const body = tableBodyRef.current;
    if (!body) return;
    // Scroll events don't bubble, but they DO propagate during the capture
    // phase — and the virtualized List renders its own overflow:auto scroller,
    // so the element that actually scrolls sideways may be this wrapper or that
    // inner div. Listening in capture catches either. Only the box that can
    // actually scroll horizontally drives the header, so the vertical scroller
    // doesn't reset it to 0.
    const onScroll = (e: Event) => {
      const target = e.target as HTMLElement | null;
      const header = tableHeaderRef.current;
      if (!header || !target || !(target instanceof HTMLElement)) return;
      if (target.scrollWidth > target.clientWidth) header.scrollLeft = target.scrollLeft;
    };
    body.addEventListener('scroll', onScroll, true);
    return () => body.removeEventListener('scroll', onScroll, true);
  }, [viewMode]);
  const [treeKeyWidth, setTreeKeyWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem('mqlens-treekey-width'));
    return saved >= 140 && saved <= 800 ? saved : 320;
  });
  useEffect(() => { localStorage.setItem('mqlens-treekey-width', String(treeKeyWidth)); }, [treeKeyWidth]);

  const clampCol = (w: number, min = 80, max = 800) => Math.min(max, Math.max(min, w));
  const startColResize = (e: React.MouseEvent, startWidth: number, apply: (w: number) => void, min = 80) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const move = (ev: MouseEvent) => apply(clampCol(startWidth + ev.clientX - startX, min));
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  // Shared handle: drag or focus + arrow keys. A render helper (not a nested
  // component) so re-renders update the same DOM node instead of remounting.
  const renderColResizer = (label: string, width: number, apply: (w: number) => void, min = 80) => (
    <div
      className="absolute right-[-4px] top-0 z-[2] h-full w-2 cursor-col-resize hover:bg-primary/45 focus-visible:bg-primary/45 focus-visible:outline-none"
      role="separator"
      aria-orientation="vertical"
      aria-label={t('dataGrid.tooltips.resizeColumn', { label })}
      tabIndex={0}
      onMouseDown={(e) => startColResize(e, width, apply, min)}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        apply(clampCol(width + (e.key === 'ArrowRight' ? 16 : -16), min));
      }}
    />
  );
  const [copied, setCopied] = useState(false);
  const [queryCopied, setQueryCopied] = useState(false);

  // Query Code tab: generate runnable driver code in the selected language.
  const monacoTheme = useMonacoTheme();
  const monacoFontSize = useMonacoFontSize(12);
  const [codeLang, setCodeLang] = useState<CodeLanguage>(() => {
    const saved = localStorage.getItem('mqlens-codegen-lang') as CodeLanguage | null;
    return saved && (CODE_LANGUAGES as readonly string[]).includes(saved) ? saved : 'mongosh';
  });
  useEffect(() => { localStorage.setItem('mqlens-codegen-lang', codeLang); }, [codeLang]);
  const queryCode = useMemo(
    () => (querySpec ? generateQueryCode(codeLang, querySpec) : null),
    [querySpec, codeLang],
  );

  const handleCopyQueryCode = () => {
    if (!queryCode) return;
    navigator.clipboard.writeText(queryCode);
    setQueryCopied(true);
    setTimeout(() => setQueryCopied(false), 1500);
  };
  const [explainView, setExplainView] = useState<'visual' | 'json'>('visual');
  // Collapsed fold blocks in the JSON view, keyed by their generated fold id.
  const [collapsedFolds, setCollapsedFolds] = useState<Set<number>>(new Set());

  // ── Local find over the loaded results (#279) ────────────────────────────
  // Searches what is already on screen; the query filter above re-queries the
  // server and is a different job.
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [activeMatch, setActiveMatch] = useState(-1);
  // Bumped on every shortcut press so the bar refocuses even when already open.
  const [findFocusToken, setFindFocusToken] = useState(0);
  // The whole pane, toolbar included. Clicking a pane's view-mode or tab
  // controls is how a user selects it before searching, so those controls have
  // to be inside the element that routing tests against — a root starting at the
  // results body would leave such a click pointing at no pane at all.
  const paneRootRef = React.useRef<HTMLDivElement>(null);
  const jsonListRef = React.useRef<ListImperativeAPI | null>(null);
  const treeListRef = React.useRef<ListImperativeAPI | null>(null);
  const tableListRef = React.useRef<ListImperativeAPI | null>(null);

  // Several results panes can be mounted at once, so the shortcut is routed
  // rather than bound per instance — see resultsFindShortcut.
  //
  // Registered only while the results are actually showing: the find bar lives
  // in the results tab, so claiming the key from the explain or code tab would
  // swallow it and open a bar the user cannot see.
  useEffect(() => {
    if (effectiveTab !== 'results') return;
    return registerResultsFindTarget({
      element: () => paneRootRef.current,
      open: () => {
        setFindOpen(true);
        setFindFocusToken((token) => token + 1);
      },
    });
  }, [effectiveTab]);

  const closeFind = React.useCallback(() => {
    setFindOpen(false);
    setFindQuery('');
    setActiveMatch(-1);
  }, []);

  // Leaving the results tab unmounts the bar, so drop the state with it rather
  // than coming back to a query the user can no longer see being applied.
  useEffect(() => {
    if (effectiveTab !== 'results') closeFind();
  }, [effectiveTab, closeFind]);
  // Collapsed rows in the tree-table view (separate id space from JSON folds).
  const [treeCollapsed, setTreeCollapsed] = useState<Set<number>>(new Set());

  // Reset JSON fold state whenever the result set changes (fold ids are positional).
  useEffect(() => {
    setCollapsedFolds(new Set());
  }, [documents]);

  // Automatically switch to explain tab when a new explain result is received
  useEffect(() => {
    if (explainResult) {
      setActiveTab('explain');
    }
  }, [explainResult]);

  // Automatically switch to results tab when new query results (documents) are loaded (skipping mount)
  const isFirstRender = React.useRef(true);
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    setActiveTab('results');
  }, [documents]);

  const handleCopy = () => {
    if (!explainResult) return;
    navigator.clipboard.writeText(explainResult);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Parse documents as rich BSON-typed objects once
  const parsedDocs = useMemo(() => {
    return documents.map(doc => {
      try {
        return EJSON.parse(JSON.stringify(doc));
      } catch (err) {
        console.error("Failed to parse extended JSON", err);
        return doc;
      }
    });
  }, [documents]);

  // Extract all unique columns present in documents
  const columns = useMemo(() => {
    if (!documents || documents.length === 0) return [];
    const keys = new Set<string>();
    documents.forEach((doc) => {
      Object.keys(doc).forEach((k) => keys.add(k));
    });
    return Array.from(keys);
  }, [documents]);

  // A value the grid gives a constructor call to. Delegates so this list cannot
  // fall behind bsonDisplay's.
  const isBsonObject = (val: any): boolean => isBsonInstance(val);

  // Paints the shared display descriptor. Only the colours live here; what the
  // text *is* comes from bsonDisplay, which local find reads too, so the two
  // cannot disagree about what is on screen.
  const renderBsonValueNode = (val: any): React.ReactNode => {
    if (val === null) return <span className="text-syntax-null">null</span>;
    if (typeof val === 'boolean') return <span className="text-syntax-boolean font-bold">{val ? 'true' : 'false'}</span>;
    if (typeof val === 'number') return <span className="text-syntax-number">{val}</span>;
    if (typeof val === 'string') {
      return <span className="text-syntax-string">{printableJsonString(val)}</span>;
    }

    const call = bsonCallOf(val);
    if (call) {
      return (
        <>
          <span className="text-syntax-boolean">{call.ctor}</span>(
          {call.args.map((arg, i) => (
            <React.Fragment key={i}>
              {i > 0 && ', '}
              <span className={arg.kind === 'number' ? 'text-syntax-number' : 'text-syntax-string'}>
                {arg.text}
              </span>
            </React.Fragment>
          ))}
          )
        </>
      );
    }
    return <span>{String(val)}</span>;
  };

  // Colored Table cell — same syntax palette as the Tree/JSON views (strings,
  // numbers, booleans, BSON types) so the Table is visually consistent.
  const renderColoredCell = (val: any): React.ReactNode => {
    if (val === null || val === undefined) return '';
    if (typeof val === 'string') return <span className="text-syntax-string">{val}</span>;
    if (typeof val === 'number') return <span className="text-syntax-number">{String(val)}</span>;
    if (typeof val === 'boolean') return <span className="text-syntax-boolean font-bold">{val ? 'true' : 'false'}</span>;
    if (typeof val === 'object') {
      if (isBsonInstance(val)) return renderBsonValueNode(val);
      const plain = plainBsonShape(val);
      if (plain) {
        return (
          <span
            className={plain.kind === 'number' ? 'text-syntax-number' : 'text-syntax-string'}
          >
            {plain.text}
          </span>
        );
      }
      return <span className="text-muted-foreground">{JSON.stringify(val)}</span>;
    }
    return <span>{String(val)}</span>;
  };

  // Flatten all documents into an editor-style list of lines with fold metadata,
  // so the JSON view can render a continuous, line-numbered, collapsible panel.
  // Approximate rendered character count of a scalar value (for horizontal width).
  const valueLen = (v: any): number => {
    // Containers get lines of their own, so only their bracket is on this one.
    if (v !== null && typeof v === 'object' && !isBsonObject(v)) return 12;
    // Exact rather than estimated: the displayed text is now available, so the
    // per-type guesses (40 for an ObjectId, 64 for any Binary) are gone.
    return bsonValueText(v).length;
  };

  const { jsonLines, jsonMaxWidthPx } = useMemo<{ jsonLines: JsonLine[]; jsonMaxWidthPx: number }>(() => {
    const lines: JsonLine[] = [];
    let foldCounter = 0;
    let maxChars = 0;

    const track = (depth: number, chars: number) => {
      const total = depth * 2 + chars;
      if (total > maxChars) maxChars = total;
    };

    const walk = (
      value: any,
      keyName: string | null,
      depth: number,
      trailingComma: boolean,
      ancestors: number[],
      docIndex: number,
      isDocRoot: boolean,
      rawDoc?: Record<string, any>
    ) => {
      const keyChars = keyName !== null ? keyName.length + 5 : 0;
      const isArr = Array.isArray(value);
      const isObj = value !== null && typeof value === 'object' && !isBsonObject(value) && !isArr;

      if (!isObj && !isArr) {
        track(depth, keyChars + valueLen(value) + (trailingComma ? 1 : 0));
        lines.push({ num: lines.length + 1, depth, kind: 'scalar', keyName, value, hasComma: trailingComma, ancestors, docIndex });
        return;
      }

      const open = isArr ? '[' : '{';
      const close = isArr ? ']' : '}';
      const entries: [string, any][] = isArr
        ? (value as any[]).map((v, i) => [String(i), v])
        : Object.keys(value).map((k) => [k, value[k]]);

      if (entries.length === 0) {
        track(depth, keyChars + 2 + (trailingComma ? 1 : 0));
        lines.push({ num: lines.length + 1, depth, kind: 'empty', keyName, brackets: open + close, hasComma: trailingComma, ancestors, docIndex });
        return;
      }

      const foldId = foldCounter++;
      track(depth, keyChars + 1);
      lines.push({
        num: lines.length + 1,
        depth,
        kind: 'open',
        keyName,
        bracket: open,
        hasComma: trailingComma,
        ancestors,
        docIndex,
        foldId,
        closeChar: close,
        isDocRoot,
        doc: rawDoc,
      });

      const childAncestors = [...ancestors, foldId];
      entries.forEach(([k, v], idx) => {
        const last = idx === entries.length - 1;
        walk(v, isArr ? null : k, depth + 1, !last, childAncestors, docIndex, false);
      });

      track(depth, 2);
      lines.push({ num: lines.length + 1, depth, kind: 'close', keyName: null, bracket: close, hasComma: trailingComma, ancestors: childAncestors, docIndex });
    };

    parsedDocs.forEach((doc, di) => {
      walk(doc, null, 0, false, [], di, true, documents[di]);
    });
    // Gutter (~68px) + monospace char width (~7.2px); min keeps a sensible floor.
    const maxWidthPx = Math.max(320, 68 + Math.ceil(maxChars * 7.2));
    return { jsonLines: lines, jsonMaxWidthPx: maxWidthPx };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsedDocs, documents]);

  // Only the lines not hidden inside a collapsed fold are rendered/virtualized.
  const visibleJsonLines = useMemo(
    () => jsonLines.filter((line) => !line.ancestors.some((a) => collapsedFolds.has(a))),
    [jsonLines, collapsedFolds]
  );

  // Render the syntax-highlighted content for one line (lazily, per visible row).
  const renderJsonLineContent = (line: JsonLine): React.ReactNode => {
    const key = line.keyName !== null ? jsonKeyNode(line.keyName) : null;
    const comma = line.hasComma ? jsonPunct(',') : null;
    switch (line.kind) {
      case 'scalar':
        return (
          <>
            {key}
            {renderBsonValueNode(line.value)}
            {comma}
          </>
        );
      case 'open':
        return (
          <>
            {key}
            {jsonPunct(line.bracket || '{')}
          </>
        );
      case 'empty':
        return (
          <>
            {key}
            {jsonPunct(line.brackets || '{}')}
            {comma}
          </>
        );
      case 'close':
        return (
          <>
            {jsonPunct(line.bracket || '}')}
            {comma}
          </>
        );
    }
  };

  // The text of one JSON line, mirroring renderJsonLineContent above: the quoted
  // key, the separator, the value or bracket, and the trailing comma. Find
  // searches exactly what that renderer paints, so a visible `ObjectId(`, a
  // quote, or an escaped `\n` is matchable.
  const jsonLineText = (line: JsonLine): string => {
    const key = line.keyName !== null ? `"${line.keyName}" : ` : '';
    const comma = line.hasComma ? ',' : '';
    switch (line.kind) {
      case 'scalar':
        return `${key}${bsonValueText(line.value)}${comma}`;
      case 'open':
        return `${key}${line.bracket || '{'}`;
      case 'empty':
        return `${key}${line.brackets || '{}'}${comma}`;
      case 'close':
        return `${line.bracket || '}'}${comma}`;
    }
  };

  // ── Copying a selection that scrolled (#311) ──────────────────────────────
  //
  // The JSON view is virtualized, so dragging a selection downwards unmounts
  // the rows it started on. The browser's selection lives in the DOM, so those
  // rows are simply gone by the time Cmd+C runs and only the last screenful is
  // copied — silently, which is the worst part: the paste looks like a
  // successful copy of the wrong thing.
  //
  // The extent is therefore recorded as the drag happens, while both ends are
  // still mounted, and the copy is rebuilt from the line data rather than from
  // the DOM.
  const jsonViewRef = React.useRef<HTMLDivElement | null>(null);
  // The two ends of the selection, each remembered independently at the last
  // row it was seen on. Modelling the ends rather than a min/max span is what
  // lets the range CONTRACT: during a drag the anchor is fixed and only the
  // focus moves, so a span that could only grow kept lines the user had dragged
  // back over and deselected, and then copied them (#319 review).
  const jsonSelectionRef = React.useRef<{ anchor: number | null; focus: number | null }>({
    anchor: null,
    focus: null,
  });

  const jsonLineIndexOf = (node: Node | null): number | null => {
    const el = node instanceof Element ? node : (node?.parentElement ?? null);
    const attr = el?.closest('[data-json-line]')?.getAttribute('data-json-line');
    if (attr == null) return null;
    const index = Number(attr);
    return Number.isInteger(index) ? index : null;
  };

  /**
   * The row each end of the live selection sits on, or null where it cannot be
   * resolved.
   *
   * Each end is resolved on its own, which is the crux of this mechanism rather
   * than defensive coding. Once the drag passes the first window, the row
   * holding the anchor is exactly what react-window unmounts — so requiring
   * both ends to resolve threw away every update from the moment tracking
   * started to matter, freezing the range at the first screenful (#319 review).
   *
   * An end the browser has relocated to a surviving ancestor resolves to no row
   * and is reported as null rather than guessed at; the caller keeps the last
   * row that end was actually seen on.
   */
  const selectedJsonEnds = (): { anchor: number | null; focus: number | null } | null => {
    const selection = document.getSelection();
    const container = jsonViewRef.current;
    if (!selection || selection.isCollapsed || !container) return null;
    const rowOf = (node: Node | null) =>
      node && container.contains(node) ? jsonLineIndexOf(node) : null;
    return { anchor: rowOf(selection.anchorNode), focus: rowOf(selection.focusNode) };
  };

  const jsonRangeOf = (ends: { anchor: number | null; focus: number | null }) => {
    const rows = [ends.anchor, ends.focus].filter((row): row is number => row !== null);
    return rows.length ? { min: Math.min(...rows), max: Math.max(...rows) } : null;
  };

  useEffect(() => {
    if (viewMode !== 'json') return;
    // Each end keeps the last row it was seen on, so an end that scrolls out of
    // the DOM is remembered while the other stays free to move in either
    // direction — extending the selection or pulling it back.
    const onSelectionChange = () => {
      const ends = selectedJsonEnds();
      if (!ends) return;
      const seen = jsonSelectionRef.current;
      jsonSelectionRef.current = {
        anchor: ends.anchor ?? seen.anchor,
        focus: ends.focus ?? seen.focus,
      };
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () => document.removeEventListener('selectionchange', onSelectionChange);
  }, [viewMode]);

  const handleJsonCopy = (e: React.ClipboardEvent<HTMLDivElement>) => {
    const tracked = jsonRangeOf(jsonSelectionRef.current);
    if (!tracked) return;
    const ends = selectedJsonEnds();
    const live = ends && jsonRangeOf(ends);
    // Step in only when rows really were lost. While everything the user
    // selected is still mounted, the browser's own copy is better than ours:
    // it honours a partial line at either end, which whole-line rebuilding
    // cannot.
    if (live && live.min <= tracked.min && live.max >= tracked.max) return;
    const text = visibleJsonLines
      .slice(tracked.min, tracked.max + 1)
      .map((line) => {
        const folded = line.foldId !== undefined && collapsedFolds.has(line.foldId);
        const suffix = folded ? ` … ${line.closeChar ?? ''}${line.hasComma ? ',' : ''}` : '';
        return '  '.repeat(line.depth) + jsonLineText(line) + suffix;
      })
      .join('\n');
    if (!text) return;
    e.clipboardData.setData('text/plain', text);
    e.preventDefault();
  };

  const toggleFold = (id: number) => {
    setCollapsedFolds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // ── Tree-table view (Key | Value | Type) ──────────────────────────────────
  // The Type column. BSON instances are labelled from bsonDisplay's ordered
  // table — the same table that decides the value's constructor call — so the
  // two columns of one row cannot contradict each other. The rest is
  // JavaScript-level and belongs here.
  const bsonTypeLabel = (v: any): string => {
    if (v === null) return 'Null';
    const bson = bsonInstanceTypeLabel(v);
    if (bson) return bson;
    if (Array.isArray(v)) return 'Array';
    if (typeof v === 'object') return 'Object';
    if (typeof v === 'boolean') return 'Boolean';
    if (typeof v === 'number') return Number.isInteger(v) ? 'Int32' : 'Double';
    if (typeof v === 'string') return 'String';
    return 'Mixed';
  };

  const { treeRows, treeDefaultCollapsed } = useMemo(() => {
    const rows: TreeRow[] = [];
    const defaultCollapsed = new Set<number>();
    let foldCounter = 0;

    const walk = (
      value: any,
      keyName: string,
      depth: number,
      ancestors: number[],
      docIndex: number,
      isDocRoot: boolean,
      rawDoc?: Record<string, any>
    ) => {
      const isArr = Array.isArray(value);
      const isObj = value !== null && typeof value === 'object' && !isBsonObject(value) && !isArr;

      if (!isObj && !isArr) {
        rows.push({
          num: rows.length + 1,
          depth,
          keyName,
          kind: 'scalar',
          value,
          childCount: 0,
          type: bsonTypeLabel(value),
          ancestors,
          docIndex,
        });
        return;
      }

      const entries: [string, any][] = isArr
        ? (value as any[]).map((v, i) => [String(i), v])
        : Object.keys(value).map((k) => [k, value[k]]);
      const foldId = foldCounter++;
      // Default: keep documents + their top-level fields open, collapse deeper nesting.
      if (depth >= 2) defaultCollapsed.add(foldId);

      rows.push({
        num: rows.length + 1,
        depth,
        keyName,
        kind: isArr ? 'array' : 'object',
        childCount: entries.length,
        type: isArr ? 'Array' : 'Object',
        ancestors,
        docIndex,
        foldId,
        isDocRoot,
        doc: rawDoc,
      });

      const childAncestors = [...ancestors, foldId];
      entries.forEach(([k, v]) => walk(v, k, depth + 1, childAncestors, docIndex, false));
    };

    parsedDocs.forEach((doc, di) => {
      walk(doc, String(di + 1), 0, [], di, true, documents[di]);
    });
    return { treeRows: rows, treeDefaultCollapsed: defaultCollapsed };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsedDocs, documents]);

  // Apply the default collapse set whenever the result set (and thus rows) changes.
  useEffect(() => {
    setTreeCollapsed(new Set(treeDefaultCollapsed));
  }, [treeDefaultCollapsed]);

  // The text of one tree row: all three columns, since all three are on screen.
  // Container rows show their child count, so that label is searchable too.
  const treeRowText = (row: TreeRow): string => {
    const value =
      row.kind === 'scalar'
        ? bsonValueText(row.value)
        : row.kind === 'array'
          ? t('dataGrid.labels.elements', { count: row.childCount })
          : t('dataGrid.labels.fields', { count: row.childCount });
    return `${row.keyName} ${value} ${row.type}`;
  };

  // Flatten the active view into searchable cells. Built from the *full* row
  // lists, not the visible ones: every view is virtualized and folds can hide a
  // row, so a match must be findable before it is rendered.
  const findCells = useMemo<FindCell[]>(() => {
    if (!findOpen) return [];
    if (viewMode === 'json') {
      // Every line, brackets included: they are rendered, so they are findable.
      return jsonLines.map((line) => ({
        rowIndex: line.num,
        text: jsonLineText(line),
        ancestors: line.ancestors,
      }));
    }
    if (viewMode === 'tree') {
      return treeRows.map((row) => ({
        rowIndex: row.num,
        text: treeRowText(row),
        ancestors: row.ancestors,
      }));
    }
    if (viewMode === 'table') {
      // Each column header once, then the cell values. A field name shown only
      // in the header has to be findable, but adding it to every cell's text
      // would report a match per row for text that appears a single time — so it
      // is indexed as the one thing it is, ahead of the rows it labels.
      //
      // The tree view's "Key"/"Value"/"Type" headings are deliberately not
      // indexed: those are fixed chrome, whereas a table heading is a field name
      // from the documents themselves.
      const headers: FindCell[] = columns.map((col) => ({
        rowIndex: TABLE_HEADER_ROW_INDEX,
        columnKey: col,
        text: col,
      }));
      return headers.concat(
        documents.flatMap((doc, index) =>
          columns.map((col) => ({
            rowIndex: index,
            columnKey: col,
            text: tableValueText((doc as Record<string, unknown>)?.[col]),
          }))
        )
      );
    }
    // Chart has no text to search.
    return [];
    // jsonLineText/treeRowText are recreated each render but read only the rows
    // and the translator, both of which are already dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findOpen, viewMode, jsonLines, treeRows, documents, columns, t]);

  const findMatchList = useMemo(() => findMatches(findCells, findQuery), [findCells, findQuery]);

  // A new match list starts from its first match. Done during render, not in an
  // effect: an effect resets one render too late, and in that render the reveal
  // effect below would take the *old* index into the *new* list and expand the
  // folds around a match that is not the selected one. Nothing collapses those
  // again, so they stayed open for the rest of the session.
  //
  // This is React's documented "adjusting state when props change" pattern — the
  // render output is discarded and immediately retried, so no effect ever
  // observes the stale index. Editing the query is the common way in, but a view
  // switch or a new result set changes the list the same way.
  const [matchListOfActive, setMatchListOfActive] = useState(findMatchList);
  if (matchListOfActive !== findMatchList) {
    setMatchListOfActive(findMatchList);
    setActiveMatch(findMatchList.length > 0 ? 0 : -1);
  }

  const activeFindMatch = activeMatch >= 0 ? findMatchList[activeMatch] : undefined;

  // Open whatever folds hide the active match. The two views keep separate
  // collapse state, so each is updated on its own.
  useEffect(() => {
    if (!activeFindMatch || activeFindMatch.ancestors.length === 0) return;
    const reveal = (prev: Set<number>) => {
      if (!activeFindMatch.ancestors.some((a) => prev.has(a))) return prev;
      const next = new Set(prev);
      for (const ancestor of activeFindMatch.ancestors) next.delete(ancestor);
      return next;
    };
    if (viewMode === 'json') setCollapsedFolds(reveal);
    else if (viewMode === 'tree') setTreeCollapsed(reveal);
  }, [activeFindMatch, viewMode]);

  const visibleTreeRows = useMemo(
    () => treeRows.filter((r) => !r.ancestors.some((a) => treeCollapsed.has(a))),
    [treeRows, treeCollapsed]
  );

  const toggleTreeFold = (id: number) => {
    setTreeCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Render the Value cell for a tree-table row.
  const renderTreeValue = (row: TreeRow): React.ReactNode => {
    if (row.kind === 'scalar') return renderBsonValueNode(row.value);
    if (row.kind === 'array')
      return <span className="text-muted-foreground">{t('dataGrid.labels.elements', { count: row.childCount })}</span>;
    return <span className="text-muted-foreground">{t('dataGrid.labels.fields', { count: row.childCount })}</span>;
  };

  // Every document now carries at least a copy control, so the actions
  // area is always present; edit/delete remain gated on their handlers.
  const hasRowActions = true;

  // One-click "Copy JSON" for a single document, with a brief "Copied"
  // confirmation. Copies the pretty-printed (2-space) document, matching the
  // "Copy document (JSON)" context-menu action.
  const CopyDocButton = ({ doc }: { doc: Record<string, any> }) => {
    const [copied, setCopied] = useState(false);
    const handleCopy = (e: React.MouseEvent) => {
      e.stopPropagation();
      writeClipboard(JSON.stringify(doc, null, 2));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    };
    return (
      <button
        onClick={handleCopy}
        className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-primary"
        title={copied ? t('dataGrid.tooltips.copied') : t('dataGrid.actions.copyDocumentJson')}
        aria-label={copied ? t('dataGrid.tooltips.copied') : t('dataGrid.tooltips.copyDocument')}
        data-testid="copy-doc-btn"
      >
        {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
      </button>
    );
  };

  // Per-row copy/edit/delete controls, shared across all view modes.
  const RowActions = ({ doc }: { doc: Record<string, any> }) => {
    return (
      <div className="flex items-center gap-1 flex-shrink-0">
        <CopyDocButton doc={doc} />
        {onEditDocument && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onEditDocument(doc);
            }}
            disabled={isReadOnly}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-primary disabled:pointer-events-none disabled:opacity-50"
            title={isReadOnly ? t('dataGrid.tooltips.readOnly') : t('dataGrid.tooltips.editDocument')}
            data-testid="edit-doc-btn"
          >
            <Edit size={12} />
          </button>
        )}
        {onDeleteDocument && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDeleteDocument(doc);
            }}
            disabled={isReadOnly}
            className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:pointer-events-none disabled:opacity-50"
            title={isReadOnly ? t('dataGrid.tooltips.readOnly') : t('dataGrid.tooltips.deleteDocument')}
            data-testid="delete-doc-btn"
          >
            <Trash2 size={12} />
          </button>
        )}
      </div>
    );
  };

  // Row Renderer for Virtualized List (table mode only; JSON & tree have their own).
  const Row = ({ index, style }: { index: number; style: React.CSSProperties }) => {
    const rawDoc = documents[index];
    if (!rawDoc) return null;

    // Table mode
    return (
      <div
        style={style}
        className="flex items-center border-b border-border font-mono text-xs hover:bg-accent"
        onContextMenu={(e) => openCtxMenu(e, rawDoc)}
      >
        <div
          className="flex h-full shrink-0 select-none items-center justify-center border-r border-border text-[10px] text-muted-foreground"
          style={{ width: `${TABLE_ROW_NUMBER_WIDTH_PX}px` }}
        >
          {index + 1}
        </div>
        {columns.map((col) => (
          <div
            key={col}
            className={cn(
              'flex h-full items-center truncate border-r border-border px-3 text-foreground',
              findHighlightClass(index, col)
            )}
            style={{ width: `${colWidth(col)}px`, flexShrink: 0 }}
            onContextMenu={(e) => openCtxMenu(e, rawDoc, col, rawDoc[col])}
          >
            {renderColoredCell(rawDoc[col])}
          </div>
        ))}
        {hasRowActions && (
          <div className="flex h-full w-[72px] shrink-0 items-center justify-center px-2">
            <RowActions doc={rawDoc} />
          </div>
        )}
      </div>
    );
  };


  // Bring the matched column into view as well as the matched row. The table
  // scrolls in both directions once resized columns overflow, so a vertical jump
  // alone can leave the highlighted cell off the side of the viewport while the
  // counter says it is active.
  //
  // Which box actually scrolls sideways is not fixed — it is this wrapper or the
  // virtualized List's own scroller, depending on overflow — so the one that can
  // is found rather than assumed, the same way the header-sync listener does it.
  const scrollTableColumnIntoView = React.useCallback(
    (columnKey: string) => {
      const wrapper = tableBodyRef.current;
      if (!wrapper) return;
      const candidates = [wrapper, ...Array.from(wrapper.querySelectorAll<HTMLElement>('*'))];
      const scroller = candidates.find((el) => el.scrollWidth > el.clientWidth);
      if (!scroller) return;

      const columnIndex = columns.indexOf(columnKey);
      if (columnIndex < 0) return;
      // The row-number gutter is `w-12`, ahead of the first column.
      const left =
        TABLE_ROW_NUMBER_WIDTH_PX +
        columns.slice(0, columnIndex).reduce((sum, col) => sum + colWidth(col), 0);
      const right = left + colWidth(columnKey);

      // Only move when the cell is actually outside the visible band, so
      // stepping between matches in already-visible columns doesn't jiggle.
      if (left < scroller.scrollLeft) scroller.scrollLeft = left;
      else if (right > scroller.scrollLeft + scroller.clientWidth) {
        scroller.scrollLeft = right - scroller.clientWidth;
      }
    },
    [columns, colWidths]
  );

  // Scroll after the visible lists recompute, so revealing a fold and jumping to
  // the row happen in the right order. `scrollToRow` throws on an out-of-range
  // index, so the row is looked up rather than assumed present.
  useEffect(() => {
    if (!activeFindMatch) return;
    if (viewMode === 'table') {
      if (
        activeFindMatch.rowIndex >= 0 &&
        activeFindMatch.rowIndex < documents.length
      ) {
        tableListRef.current?.scrollToRow({ index: activeFindMatch.rowIndex, align: 'smart' });
      }
      if (activeFindMatch.columnKey) scrollTableColumnIntoView(activeFindMatch.columnKey);
      return;
    }
    const rows = viewMode === 'json' ? visibleJsonLines : viewMode === 'tree' ? visibleTreeRows : [];
    const index = rows.findIndex((row) => row.num === activeFindMatch.rowIndex);
    if (index < 0) return;
    const list = viewMode === 'json' ? jsonListRef : treeListRef;
    list.current?.scrollToRow({ index, align: 'smart' });
  }, [
    activeFindMatch,
    viewMode,
    visibleJsonLines,
    visibleTreeRows,
    documents.length,
    scrollTableColumnIntoView,
  ]);

  // Row-level highlighting: every view renders its values through its own
  // coloured spans, so marking the containing row or cell keeps one mechanism
  // across all three instead of threading a text range through each renderer.
  const findMatchedRows = useMemo(
    () => new Set(findMatchList.filter((m) => !m.columnKey).map((m) => m.rowIndex)),
    [findMatchList]
  );
  const findMatchedCells = useMemo(
    () =>
      new Set(
        findMatchList.filter((m) => m.columnKey).map((m) => `${m.rowIndex}:${m.columnKey}`)
      ),
    [findMatchList]
  );
  const findHighlightClass = (rowId: number, columnKey?: string): string | undefined => {
    if (!findOpen || findQuery.trim() === '') return undefined;
    const matched = columnKey
      ? findMatchedCells.has(`${rowId}:${columnKey}`)
      : findMatchedRows.has(rowId);
    if (!matched) return undefined;
    return isMatchAt(activeFindMatch, rowId, columnKey)
      ? 'bg-warning/40 ring-1 ring-inset ring-warning'
      : 'bg-warning/15';
  };

  // Row height depends on viewMode and density
  const getRowHeight = () => {
    if (viewMode === 'json') {
      if (density === 'roomy') return getScaledRowHeight(24, density);
      if (density === 'compact') return getScaledRowHeight(17, density);
      return getScaledRowHeight(20, density);
    }
    if (viewMode === 'tree') {
      if (density === 'roomy') return getScaledRowHeight(28, density);
      if (density === 'compact') return getScaledRowHeight(20, density);
      return getScaledRowHeight(24, density);
    }
    if (density === 'roomy') return getScaledRowHeight(32, density);
    if (density === 'compact') return getScaledRowHeight(20, density);
    return getScaledRowHeight(24, density);
  };

  // Virtualized row for the tree-table view (Key | Value | Type).
  const TreeRowComponent = ({ index, style }: { index: number; style: React.CSSProperties }) => {
    const row = visibleTreeRows[index];
    if (!row) return null;
    const collapsed = row.foldId !== undefined && treeCollapsed.has(row.foldId);
    return (
      <div
        style={style}
        className={cn(
          'flex items-center border-b border-border font-mono text-[11.5px] hover:bg-accent',
          row.docIndex % 2 === 0 ? 'bg-background' : 'bg-card',
          row.isDocRoot && row.docIndex > 0 && 'border-t border-border',
          findHighlightClass(row.num)
        )}
        data-doc-even={row.docIndex % 2 === 0}
        onContextMenu={(e) => openCtxMenu(e, documents[row.docIndex], row.kind === 'scalar' ? row.keyName : undefined, row.value)}
      >
        <div className="flex min-w-0 items-center border-r border-border" style={{ width: treeKeyWidth, paddingLeft: 6 + row.depth * 14 }}>
          {row.foldId !== undefined ? (
            <button
              type="button"
              onClick={() => toggleTreeFold(row.foldId!)}
              className="mr-1 flex shrink-0 items-center text-muted-foreground hover:text-foreground"
              data-testid="tree-fold-btn"
              aria-label={collapsed ? t('documents:dataGrid.tooltips.expand') : t('documents:dataGrid.tooltips.collapse')}
            >
              {collapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
            </button>
          ) : (
            <span className="mr-1 inline-block w-[11px] shrink-0" />
          )}
          <span className="truncate text-syntax-key" title={row.keyName}>{row.keyName}</span>
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-2 border-r border-border px-3">
          <span className="truncate">{renderTreeValue(row)}</span>
          {row.isDocRoot && hasRowActions && row.doc && (
            <span className="ml-auto inline-flex opacity-0 group-hover:opacity-100 [.flex:hover>&]:opacity-100">
              <RowActions doc={row.doc} />
            </span>
          )}
        </div>
        <div className="w-28 shrink-0 px-3 text-muted-foreground">{row.type}</div>
      </div>
    );
  };
  return (
    <div
      ref={paneRootRef}
      className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background"
    >
      {/* Control Bar — omitted for a chromeless render, where none of these
          controls have anything to act on. */}
      {!chromeless && (
      <div
        className="relative z-30 flex h-9 select-none items-center justify-between overflow-visible border-b border-border bg-sidebar px-3"
      >

        <div className="flex items-center gap-0.5 rounded-lg bg-muted/50 p-0.5">
          <button
            onClick={() => setActiveTab('results')}
            className={cn(
              'rounded-md px-2.5 py-1 text-xs font-medium transition-all',
              activeTab === 'results' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {t('dataGrid.tabs.results')}
          </button>
          <button
            onClick={() => {
              setActiveTab('explain');
              if (docViewerContext && !docViewerContext.explainLoading) {
                docViewerContext.handleExplain();
              }
            }}
            className={cn(
              'rounded-md px-2.5 py-1 text-xs font-medium transition-all',
              activeTab === 'explain' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
            )}
            data-testid="explain-plan-tab"
          >
            {t('dataGrid.tabs.explainPlan')}
          </button>
          {queryCode && (
            <button
              onClick={() => setActiveTab('query')}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs font-medium transition-all',
                activeTab === 'query' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
              )}
              data-testid="query-code-tab"
            >
              {t('dataGrid.tabs.queryCode')}
            </button>
          )}
        </div>

        {/* Right Side Controls */}
        <div className="flex items-center gap-2">
          {activeTab === 'results' && onInsertDocument && (
            <Button
              variant="outline"
              size="sm"
              onClick={onInsertDocument}
              disabled={isReadOnly}
              className="h-7 gap-1.5 text-[11px]"
              title={isReadOnly ? t('dataGrid.tooltips.readOnly') : t('dataGrid.tooltips.insert')}
              data-testid="insert-doc-btn"
            >
              <Plus size={12} />
              {t('dataGrid.actions.insert')}
            </Button>
          )}
          {activeTab === 'results' && onAnalyzeSchema && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onAnalyzeSchema}
              className="h-7 gap-1.5 text-[11px]"
              title={t('dataGrid.tooltips.analyzeSchema')}
              data-testid="analyze-schema-btn"
            >
              <Table2 size={12} />
              {t('dataGrid.actions.schema')}
            </Button>
          )}
          {activeTab === 'results' && onUpdateMany && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onUpdateMany}
              disabled={isReadOnly}
              className="h-7 gap-1.5 text-[11px]"
              title={isReadOnly ? t('dataGrid.tooltips.readOnly') : t('dataGrid.tooltips.updateMany')}
              data-testid="update-many-btn"
            >
              <Edit size={12} />
              {t('dataGrid.actions.updateMany')}
            </Button>
          )}
          {activeTab === 'results' && onDeleteMany && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onDeleteMany}
              disabled={isReadOnly}
              className="h-7 gap-1.5 border-destructive/30 bg-destructive/10 text-[11px] text-destructive hover:bg-destructive/20"
              title={isReadOnly ? t('dataGrid.tooltips.readOnly') : t('dataGrid.tooltips.deleteMany')}
              data-testid="delete-many-btn"
            >
              <Trash2 size={12} />
              {t('dataGrid.actions.deleteMany')}
            </Button>
          )}
          {activeTab === 'results' ? (
            <div className="flex items-center rounded-md border border-border bg-background p-0.5">
              <button
                role="button"
                aria-label={t('dataGrid.viewModes.table')}
                onClick={() => setViewMode('table')}
                className={cn(
                  'flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium transition-all',
                  viewMode === 'table' ? 'bg-accent text-primary' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <Table size={12} />
                <span>{t('dataGrid.viewModes.table')}</span>
              </button>

              <button
                role="button"
                aria-label={t('dataGrid.viewModes.tree')}
                onClick={() => setViewMode('tree')}
                className={cn(
                  'flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium transition-all',
                  viewMode === 'tree' ? 'bg-accent text-primary' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <ChevronRight size={12} />
                <span>{t('dataGrid.viewModes.tree')}</span>
              </button>

              <button
                role="button"
                aria-label={t('dataGrid.viewModes.json')}
                onClick={() => setViewMode('json')}
                className={cn(
                  'flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium transition-all',
                  viewMode === 'json' ? 'bg-accent text-primary' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <Braces size={12} />
                <span>{t('dataGrid.viewModes.json')}</span>
              </button>

              <button
                role="button"
                aria-label={t('dataGrid.viewModes.chart')}
                onClick={() => setViewMode('chart')}
                className={cn(
                  'flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium transition-all',
                  viewMode === 'chart' ? 'bg-accent text-primary' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <BarChart3 size={12} />
                <span>{t('dataGrid.viewModes.chart')}</span>
              </button>
            </div>
          ) : activeTab === 'explain' ? (
            explainResult && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleCopy}
                className="h-7 gap-1.5 text-[11px] font-semibold"
                title={t('dataGrid.tooltips.copyExplainPlan')}
              >
                {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
                <span>{copied ? t('dataGrid.actions.copied') : t('dataGrid.actions.copyPlan')}</span>
              </Button>
            )
          ) : (
            queryCode && (
              <>
                <select
                  value={codeLang}
                  onChange={(e) => setCodeLang(e.target.value as CodeLanguage)}
                  className="h-7 rounded-md border border-border bg-background px-2 text-[11px] text-foreground"
                  aria-label={t('dataGrid.tooltips.codeLanguage')}
                  data-testid="query-code-lang"
                >
                  {CODE_LANGUAGES.map((lang) => (
                    <option key={lang} value={lang}>{lang}</option>
                  ))}
                </select>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCopyQueryCode}
                  className="h-7 gap-1.5 text-[11px] font-semibold"
                  title={t('dataGrid.tooltips.copyQueryCode')}
                  data-testid="copy-query-code-btn"
                >
                  {queryCopied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
                  <span>{queryCopied ? t('dataGrid.actions.copied') : t('dataGrid.actions.copy')}</span>
                </Button>
              </>
            )
          )}
        </div>
      </div>
      )}

      {effectiveTab === 'results' ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {findOpen && (
          <ResultsFindBar
            query={findQuery}
            onQueryChange={setFindQuery}
            matchCount={findMatchList.length}
            activeIndex={activeMatch}
            onNext={() => setActiveMatch((i) => stepMatch(findMatchList.length, i, 1))}
            onPrevious={() => setActiveMatch((i) => stepMatch(findMatchList.length, i, -1))}
            onClose={closeFind}
            focusToken={findFocusToken}
          />
        )}
        {!documents || documents.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center p-8 text-muted-foreground">
            <ListFilter size={24} className="mb-2 text-muted-foreground" />
            <div>{t('dataGrid.empty.noDocuments')}</div>
          </div>
        ) : viewMode === 'json' ? (
          <div
            ref={jsonViewRef}
            // A fresh drag starts fresh tracking. Primary button only: a
            // right-click opens a menu over an existing selection rather than
            // replacing it, so resetting there threw away the recorded range
            // just before the copy that needed it (#319 review).
            onMouseDown={(e) => {
              if (e.button === 0) jsonSelectionRef.current = { anchor: null, focus: null };
            }}
            onCopy={handleJsonCopy}
            className="flex min-h-0 min-w-0 flex-1 flex-col bg-background font-mono text-xs leading-relaxed"
            data-testid="json-view"
          >
            <div className="min-h-0 flex-1 min-w-0 overflow-auto">
              <List<JsonRowExtra>
                rowCount={visibleJsonLines.length}
                listRef={jsonListRef}
                rowHeight={getRowHeight()}
                rowComponent={JsonRow}
                rowProps={{
                  lines: visibleJsonLines,
                  collapsedFolds,
                  findHighlightClass,
                  toggleFold,
                  documents,
                  openCtxMenu,
                  renderContent: renderJsonLineContent,
                  hasRowActions,
                  RowActions,
                  t,
                }}
                style={{ height: '100%', width: `${jsonMaxWidthPx}px`, minWidth: '100%' }}
              />
            </div>
          </div>
        ) : viewMode === 'tree' ? (
          <div
            className="flex min-h-0 min-w-0 flex-1 flex-col bg-background font-mono text-[11.5px]"
            data-testid="tree-view"
            style={{ '--treetable-keyw': `${treeKeyWidth}px` } as React.CSSProperties}
          >
            <div className="flex h-6 shrink-0 select-none items-center border-b border-border bg-sidebar text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
              <div className="relative border-r border-border" style={{ width: treeKeyWidth, paddingLeft: 6 }}>
                {t('dataGrid.labels.key')}
                {renderColResizer('key', treeKeyWidth, setTreeKeyWidth, 140)}
              </div>
              <div className="flex-1 border-r border-border px-3">{t('dataGrid.labels.value')}</div>
              <div className="w-28 shrink-0 px-3">{t('dataGrid.labels.type')}</div>
            </div>
            <div className="min-h-0 flex-1 min-w-0 overflow-hidden">
              <List<{}>
                rowCount={visibleTreeRows.length}
                listRef={treeListRef}
                rowHeight={getRowHeight()}
                rowComponent={TreeRowComponent}
                rowProps={{}}
                style={{ height: '100%', width: '100%' }}
              />
            </div>
          </div>
        ) : viewMode === 'chart' ? (
          <ChartView documents={parsedDocs} columns={columns} density={density} />
        ) : (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            {viewMode === 'table' && (
              /* Table Headers */
              <div
                ref={tableHeaderRef}
                data-testid="table-header"
                // overflow-hidden makes this a scroll container so its scrollLeft
                // can be driven by the body; scrollbar-gutter keeps its usable
                // width equal to the body's, so the two stay aligned at the far
                // right too (where the body's vertical scrollbar eats space).
                className="flex h-6 shrink-0 select-none items-center overflow-hidden border-b border-border bg-sidebar text-ui-2xs font-bold uppercase tracking-wider text-muted-foreground"
                style={{ scrollbarGutter: 'stable' }}
              >
                <div
                  className="flex items-center justify-center border-r border-border flex-shrink-0"
                  style={{ width: `${TABLE_ROW_NUMBER_WIDTH_PX}px` }}
                >
                  #
                </div>
                {columns.map((col) => (
                  <div
                    key={col}
                    className={cn(
                      'px-3 border-r border-border flex items-center truncate relative',
                      findHighlightClass(TABLE_HEADER_ROW_INDEX, col)
                    )}
                    style={{ width: `${colWidth(col)}px`, flexShrink: 0 }}
                  >
                    {col}
                    {renderColResizer(col, colWidth(col), (w) => setColWidths((p) => ({ ...p, [col]: w })))}
                  </div>
                ))}
                {hasRowActions && (
                  <div className="px-2 flex items-center justify-center" style={{ width: '72px', flexShrink: 0 }}>
                    {t('dataGrid.labels.actions')}
                  </div>
                )}
              </div>
            )}

            {/* Virtualized list */}
            <div
              ref={tableBodyRef}
              data-testid="table-body-scroll"
              className="min-h-0 flex-1 min-w-0 overflow-auto"
              style={{ scrollbarGutter: 'stable' }}
            >
              <List<{}>
                rowCount={documents.length}
                listRef={tableListRef}
                rowHeight={getRowHeight()}
                rowComponent={Row}
                rowProps={{}}
                style={{ height: '100%', width: '100%', minWidth: viewMode === 'table' ? `${columns.reduce((s, c) => s + colWidth(c), 0) + TABLE_ROW_NUMBER_WIDTH_PX + (hasRowActions ? 72 : 0)}px` : '100%' }}
              />
            </div>
          </div>
        )}
        </div>
      ) : activeTab === 'explain' ? (
        /* Explain Plan Workspace */
        <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden" data-testid="explain-panel">
          {docViewerContext?.explainLoading ? (
            <div className="flex flex-1 flex-col items-center justify-center bg-background p-6 text-muted-foreground select-none" data-testid="explain-loading">
              <div className="flex flex-col items-center gap-2 select-none">
                <div className="h-5 w-5 animate-spin rounded-full border-b-2 border-primary"></div>
                <span className="text-xs">{t('dataGrid.labels.generatingQueryPlan')}</span>
              </div>
            </div>
          ) : explainResult ? (
            <>
              <div className="flex h-8 shrink-0 select-none items-center justify-between border-b border-border bg-sidebar px-3">
                <div className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success"></span>
                  <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{t('dataGrid.labels.queryPlanGenerated')}</span>
                </div>

                <div className="flex items-center rounded-md border border-border bg-background p-0.5">
                  <button
                    onClick={() => setExplainView('visual')}
                    className={cn(
                      'flex cursor-pointer items-center gap-1.5 rounded px-2 py-0.5 text-[10px] font-semibold transition-all',
                      explainView === 'visual' ? 'bg-accent text-primary' : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    <Table size={11} />
                    <span>{t('dataGrid.viewModes.visualTree')}</span>
                  </button>

                  <button
                    onClick={() => setExplainView('json')}
                    className={cn(
                      'flex cursor-pointer items-center gap-1.5 rounded px-2 py-0.5 text-[10px] font-semibold transition-all',
                      explainView === 'json' ? 'bg-accent text-primary' : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    <Braces size={11} />
                    <span>{t('dataGrid.viewModes.rawJson')}</span>
                  </button>
                </div>
              </div>

              {indexSuggestion && (
                <div
                  className="mx-3 mt-3 flex shrink-0 items-start gap-2.5 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5"
                  data-testid="index-suggestion-banner"
                >
                  <Lightbulb size={16} className="mt-0.5 shrink-0 text-warning" />
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <p className="text-xs leading-relaxed text-foreground">{indexSuggestion.reason}</p>
                    <code className="w-fit rounded bg-background/60 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                      {JSON.stringify(indexSuggestion.keys)}
                    </code>
                  </div>
                  <Button
                    size="sm"
                    className="h-7 shrink-0 gap-1.5 text-[11px] font-semibold"
                    onClick={() => onCreateSuggestedIndex?.(indexSuggestion)}
                    disabled={isReadOnly}
                    title={isReadOnly ? t('dataGrid.tooltips.readOnly') : undefined}
                    data-testid="create-suggested-index-btn"
                  >
                    {t('dataGrid.actions.createIndex')}
                  </Button>
                </div>
              )}

              {explainView === 'visual' ? (
                <div
                  className="flex flex-1 flex-col items-center gap-5 overflow-auto bg-background px-8 py-6"
                  style={{
                    backgroundImage: 'radial-gradient(hsl(var(--border)) 1.2px, transparent 0)',
                    backgroundSize: '16px 16px',
                  }}
                >
                  <div className="flex w-full max-w-[640px] flex-col items-center">
                    <RenderTreeNode node={getExplainTree(explainResult, t)} />
                  </div>
                </div>
              ) : (
                <div className="flex-1 overflow-auto bg-background p-4 select-text">
                  <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-syntax-key select-text">
                    {explainResult}
                  </pre>
                </div>
              )}
            </>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center bg-background p-6 text-muted-foreground select-none">
              <span className="mb-2 text-xs italic text-muted-foreground">{t('dataGrid.empty.noExplainPlan')}</span>
              <span className="max-w-sm text-center text-[11px] leading-relaxed text-muted-foreground">
                <Trans i18nKey="dataGrid.empty.explainHint" t={t}>
                  To generate one, open the <strong>Run</strong> dropdown split menu in the query editor toolbar and select <strong>Run Explain</strong>.
                </Trans>
              </span>
            </div>
          )}
        </div>
      ) : (
        /* Query Code Workspace */
        <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden" data-testid="query-code-panel">
          {queryCode ? (
            <div className="min-h-0 flex-1 bg-background">
              <Editor
                height="100%"
                language={CODE_LANGUAGE_MONACO_IDS[codeLang]}
                value={queryCode}
                theme={monacoTheme}
                wrapperProps={{ 'data-testid': 'query-code-content' }}
                options={{
                  readOnly: true,
                  domReadOnly: true,
                  minimap: { enabled: false },
                  lineNumbers: 'on',
                  lineNumbersMinChars: 3,
                  scrollBeyondLastLine: false,
                  wordWrap: 'on',
                  fontSize: monacoFontSize,
                  fontFamily: 'JetBrains Mono, SF Mono, Consolas, monospace',
                  renderLineHighlight: 'none',
                  automaticLayout: true,
                  contextmenu: false,
                  padding: { top: 10 },
                }}
              />
            </div>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center bg-background p-6 text-muted-foreground select-none">
              <span className="text-xs italic text-muted-foreground">{t('dataGrid.empty.noQueryRun')}</span>
            </div>
          )}
        </div>
      )}
      {onPageChange && onPageSizeChange && typeof limit === 'number' && (() => {
        const lim = limit || 50;
        const sk = skip || 0;
        const page = Math.floor(sk / lim) + 1;
        const totalPages = typeof totalCount === 'number' ? Math.max(1, Math.ceil(totalCount / lim)) : undefined;
        const from = documents.length === 0 ? 0 : sk + 1;
        const to = sk + documents.length;
        const prevDisabled = page <= 1;
        const nextDisabled = totalPages !== undefined ? page >= totalPages : documents.length < lim;
        return (
          <div className="flex shrink-0 select-none items-center justify-between border-t border-border bg-sidebar px-3 py-1.5 text-[11px] text-muted-foreground" data-testid="pager">
            <div className="flex items-center gap-3">
              <span>
                {documents.length
                  ? t('dataGrid.labels.showingRange', { from, to })
                  : t('dataGrid.labels.showingEmpty', { from })}
              </span>
              <span className="font-semibold text-foreground" data-testid="pager-page">
                {totalPages !== undefined
                  ? t('dataGrid.labels.pageOf', { page, totalPages })
                  : t('dataGrid.labels.page', { page })}
              </span>
              <span data-testid="pager-total">
                {countLoading
                  ? '…'
                  : typeof totalCount === 'number'
                    ? estimated
                      ? t('dataGrid.labels.docsCountEstimated', { count: totalCount })
                      : t('dataGrid.labels.docsCountExact', { count: totalCount })
                    : '…'}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <select
                data-testid="pager-size"
                value={lim}
                onChange={(e) => onPageSizeChange(Number(e.target.value))}
                className="h-7 rounded-md border border-border bg-background px-2 text-[11px] text-foreground"
              >
                {[25, 50, 100, 200].map((s) => (
                  <option key={s} value={s}>{t('dataGrid.labels.perPageOption', { size: s })}</option>
                ))}
              </select>
              <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-[11px]" data-testid="pager-prev" disabled={prevDisabled} onClick={() => onPageChange(Math.max(0, sk - lim))}>
                &lsaquo; {t('dataGrid.actions.prev')}
              </Button>
              <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-[11px]" data-testid="pager-next" disabled={nextDisabled} onClick={() => onPageChange(sk + lim)}>
                {t('dataGrid.actions.next')} &rsaquo;
              </Button>
            </div>
          </div>
        );
      })()}
      {diffPair && (
        <DocumentDiffModal
          isOpen
          left={diffPair.a}
          right={diffPair.b}
          onClose={() => setDiffPair(null)}
        />
      )}
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={buildCtxItems(ctxMenu)}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  );
};
