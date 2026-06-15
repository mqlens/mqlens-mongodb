import React, { useState, useMemo, useEffect, useContext } from 'react';
import { DocumentViewerContext } from './DocumentViewer';
import { List } from 'react-window';
import { Table, Braces, ChevronRight, ChevronDown, ListFilter, Copy, Check, Edit, Trash2, Plus, Table2, BarChart3 } from 'lucide-react';
import { ChartView } from './ChartView';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import Editor from '@monaco-editor/react';
import { generateQueryCode, CODE_LANGUAGES, CODE_LANGUAGE_MONACO_IDS, type CodeLanguage, type QueryCodeSpec } from '../lib/queryCodeGen';
import { useMonacoTheme } from '../lib/useMonacoTheme';
import { EJSON, ObjectId, Long, Decimal128, Int32, Double, Binary, Timestamp } from 'bson';
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
}

type ViewMode = 'table' | 'tree' | 'json' | 'chart';

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

const getStageNameLabel = (stage: string): string => {
  const s = stage.toUpperCase();
  if (s === 'COLLSCAN') return 'Collection scan';
  if (s === 'IXSCAN') return 'Index scan';
  if (s === 'FETCH') return 'Fetch documents';
  if (s === 'PROJECTION_SIMPLE' || s === 'PROJECTION') return 'Projection';
  if (s === 'SORT') return 'Sort';
  if (s === 'SKIP') return 'Skip';
  if (s === 'LIMIT') return 'Limit';
  if (s === 'OR') return 'OR Merge';
  if (s === 'AND_HASH' || s === 'AND_SORTED') return 'Index Intersection';
  return stage.charAt(0).toUpperCase() + stage.slice(1).toLowerCase();
};

// Build a parseStage bound to a namespace (the find winningPlan walker).
const makeParseStage = (namespace: string) => {
  const parseStage = (stageObj: any): ExplainNode => {
    const stageName = stageObj?.stage || "STAGE";
    const name = getStageNameLabel(stageName);
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
          name: `Index: ${stageObj.indexName || "category_1"}`,
          type: 'index',
          detail: stageObj.keyPattern ? JSON.stringify(stageObj.keyPattern) : undefined
        });
      } else {
        children.push({
          name: `Collection\n${namespace}`,
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

export const getExplainTree = (explainStr: string): ExplainNode => {
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
      const parseStage = makeParseStage(namespace);
      const cursorChild: ExplainNode = cursorQP?.winningPlan
        ? parseStage(cursorQP.winningPlan)
        : { name: `Collection\n${namespace}`, type: 'collection', detail: namespace };

      let current: ExplainNode | null = null;
      stages.forEach((stageObj: any) => {
        const key = stageObj && Object.keys(stageObj)[0];
        if (!key) return;
        if (key === '$cursor') {
          current = { name: '$cursor', type: 'stage', detail: 'Documents from collection', children: [cursorChild] };
        } else {
          current = {
            name: key,
            type: 'stage',
            detail: key,
            children: current ? [current] : undefined,
          };
        }
      });
      return { name: "Result", type: "result", children: current ? [current] : [] };
    }

    const queryPlanner = explainJson?.queryPlanner || {};
    const namespace = queryPlanner?.namespace || "collection";
    const winningPlan = queryPlanner?.winningPlan;

    if (!winningPlan) {
      return {
        name: "Result",
        type: "result",
        children: [
          {
            name: "Collection scan",
            type: "stage",
            detail: "COLLSCAN",
            children: [
              {
                name: `Collection\n${namespace}`,
                type: "collection",
                detail: namespace
              }
            ]
          }
        ]
      };
    }

    return {
      name: "Result",
      type: "result",
      children: [makeParseStage(namespace)(winningPlan)]
    };

  } catch (e) {
    console.error("Failed to parse explain tree", e);
    return {
      name: "Result",
      type: "result",
      children: [
        {
          name: "Collection scan",
          type: "stage",
          detail: "COLLSCAN",
          children: [
            {
              name: "Collection",
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
const printableJsonString = (value: string): string => JSON.stringify(value);

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
  toggleFold,
  documents,
  openCtxMenu,
  renderContent,
  hasRowActions,
  RowActions,
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
        line.isDocRoot && line.docIndex > 0 && 'border-t border-border'
      )}
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
            aria-label={folded ? 'Expand' : 'Collapse'}
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
}) => {
  const themeCtx = useThemeOptional();
  const density: SpacingDensity =
    densityProp ?? themeCtx?.config.spacingDensity ?? 'cozy';

  // Right-click context menu shared by all result views (Table / Tree / JSON).
  const [ctxMenu, setCtxMenu] = useState<
    { x: number; y: number; doc: Record<string, any>; field?: string; value?: any } | null
  >(null);

  const writeClipboard = (text: string) => {
    try { navigator.clipboard?.writeText(text); } catch { /* clipboard unavailable */ }
  };
  const valueToText = (v: any): string => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') {
      try { return EJSON.stringify(v); } catch { return JSON.stringify(v); }
    }
    return String(v);
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
    if (onEditDocument) items.push({ label: 'Edit document', icon: <Edit size={13} />, onClick: () => onEditDocument(m.doc) });
    if (onDuplicateDocument) items.push({ label: 'Duplicate document', icon: <Plus size={13} />, onClick: () => onDuplicateDocument(m.doc) });
    items.push({ label: 'Copy document (JSON)', icon: <Copy size={13} />, onClick: () => writeClipboard(JSON.stringify(m.doc, null, 2)) });
    if (m.field) {
      items.push({ label: 'Copy value', icon: <Copy size={13} />, separatorBefore: true, onClick: () => writeClipboard(valueToText(m.value)) });
      items.push({ label: 'Copy field name', icon: <Copy size={13} />, onClick: () => writeClipboard(m.field!) });
    }
    if (onDeleteDocument) items.push({ label: 'Delete document', icon: <Trash2 size={13} />, danger: true, separatorBefore: true, onClick: () => onDeleteDocument(m.doc) });
    return items;
  };
  const docViewerContext = useContext(DocumentViewerContext);
  const [viewMode, setViewMode] = useState<ViewMode>('json');
  const [activeTab, setActiveTab] = useState<'results' | 'explain' | 'query'>('results');

  // Column resize: table view keeps per-column widths (session-scoped — the
  // column set changes per collection); the tree view's key column persists.
  const [colWidths, setColWidths] = useState<Record<string, number>>({});
  const colWidth = (col: string) => colWidths[col] ?? 180;
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
      aria-label={`Resize ${label} column`}
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

  const isBsonObject = (val: any): boolean => {
    if (val === null || val === undefined) return false;
    return (
      val instanceof ObjectId ||
      val instanceof Date ||
      val instanceof Long ||
      val instanceof Decimal128 ||
      val instanceof Int32 ||
      val instanceof Double ||
      val instanceof Binary ||
      val instanceof Timestamp
    );
  };

  const renderBsonValueNode = (val: any): React.ReactNode => {
    if (val === null) return <span className="text-syntax-null">null</span>;
    if (typeof val === 'boolean') return <span className="text-syntax-boolean font-bold">{val ? 'true' : 'false'}</span>;
    if (typeof val === 'number') return <span className="text-syntax-number">{val}</span>;
    if (typeof val === 'string') {
      return <span className="text-syntax-string">{printableJsonString(val)}</span>;
    }

    if (val instanceof ObjectId) {
      return (
        <>
          <span className="text-syntax-boolean">ObjectId</span>(
          <span className="text-syntax-string">{JSON.stringify(val.toString())}</span>)
        </>
      );
    }
    if (val instanceof Date) {
      return (
        <>
          <span className="text-syntax-boolean">ISODate</span>(
          <span className="text-syntax-string">{JSON.stringify(val.toISOString())}</span>)
        </>
      );
    }
    if (val instanceof Long) {
      return (
        <>
          <span className="text-syntax-boolean">NumberLong</span>(
          <span className="text-syntax-number">{val.toString()}</span>)
        </>
      );
    }
    if (val instanceof Decimal128) {
      return (
        <>
          <span className="text-syntax-boolean">NumberDecimal</span>(
          <span className="text-syntax-string">{JSON.stringify(val.toString())}</span>)
        </>
      );
    }
    if (val instanceof Int32) {
      return (
        <>
          <span className="text-syntax-boolean">NumberInt</span>(
          <span className="text-syntax-number">{val.toString()}</span>)
        </>
      );
    }
    if (val instanceof Double) {
      return (
        <>
          <span className="text-syntax-boolean">Double</span>(
          <span className="text-syntax-number">{val.toString()}</span>)
        </>
      );
    }
    if (val instanceof Binary) {
      return (
        <>
          <span className="text-syntax-boolean">BinData</span>(
          <span className="text-syntax-number">{val.sub_type}</span>, 
          <span className="text-syntax-string">{JSON.stringify(val.toString('base64'))}</span>)
        </>
      );
    }
    if (val instanceof Timestamp) {
      return (
        <>
          <span className="text-syntax-boolean">Timestamp</span>(
          <span className="text-syntax-number">{val.toString()}</span>)
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
      if (isBsonObject(val)) return renderBsonValueNode(val);
      if (typeof val.$oid === 'string') return <span className="text-syntax-string">{val.$oid}</span>;
      if (val.$date !== undefined) {
        const s =
          typeof val.$date === 'string'
            ? val.$date
            : val.$date?.$numberLong
              ? new Date(Number(val.$date.$numberLong)).toISOString()
              : JSON.stringify(val.$date);
        return <span className="text-syntax-string">{s}</span>;
      }
      if (val.$numberLong !== undefined) return <span className="text-syntax-number">{String(val.$numberLong)}</span>;
      if (val.$numberDecimal !== undefined) return <span className="text-syntax-number">{String(val.$numberDecimal)}</span>;
      if (val.$numberInt !== undefined) return <span className="text-syntax-number">{String(val.$numberInt)}</span>;
      if (val.$numberDouble !== undefined) return <span className="text-syntax-number">{String(val.$numberDouble)}</span>;
      return <span className="text-muted-foreground">{JSON.stringify(val)}</span>;
    }
    return <span>{String(val)}</span>;
  };

  // Flatten all documents into an editor-style list of lines with fold metadata,
  // so the JSON view can render a continuous, line-numbered, collapsible panel.
  // Approximate rendered character count of a scalar value (for horizontal width).
  const valueLen = (v: any): number => {
    if (v === null) return 4;
    if (typeof v === 'boolean') return v ? 4 : 5;
    if (typeof v === 'number') return String(v).length;
    if (typeof v === 'string') return printableJsonString(v).length;
    if (v instanceof ObjectId) return 40;
    if (v instanceof Date) return 36;
    if (v instanceof Binary) return 64;
    if (isBsonObject(v)) return String((v as any).toString?.() ?? '').length + 16;
    return 12;
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

  const toggleFold = (id: number) => {
    setCollapsedFolds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // ── Tree-table view (Key | Value | Type) ──────────────────────────────────
  const bsonTypeLabel = (v: any): string => {
    if (v === null) return 'Null';
    if (v instanceof ObjectId) return 'ObjectId';
    if (v instanceof Date) return 'Date';
    if (v instanceof Decimal128) return 'Decimal128';
    if (v instanceof Long) return 'Int64';
    if (v instanceof Int32) return 'Int32';
    if (v instanceof Double) return 'Double';
    if (v instanceof Binary) return 'Binary';
    if (v instanceof Timestamp) return 'Timestamp';
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
      return <span className="text-muted-foreground">{`[ ${row.childCount} ${row.childCount === 1 ? 'element' : 'elements'} ]`}</span>;
    return <span className="text-muted-foreground">{`{ ${row.childCount} ${row.childCount === 1 ? 'field' : 'fields'} }`}</span>;
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
        title={copied ? 'Copied' : 'Copy document (JSON)'}
        aria-label={copied ? 'Copied' : 'Copy document'}
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
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-primary"
            title="Edit document"
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
            className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            title="Delete document"
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
        <div className="flex h-full w-12 shrink-0 select-none items-center justify-center border-r border-border text-[10px] text-muted-foreground">
          {index + 1}
        </div>
        {columns.map((col) => (
          <div
            key={col}
            className="flex h-full items-center truncate border-r border-border px-3 text-foreground"
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
          row.isDocRoot && row.docIndex > 0 && 'border-t border-border'
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
              aria-label={collapsed ? 'Expand' : 'Collapse'}
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
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background">
      {/* Control Bar */}
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
            Results
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
            Explain Plan
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
              Query Code
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
              className="h-7 gap-1.5 text-[11px]"
              title="Insert a new document"
              data-testid="insert-doc-btn"
            >
              <Plus size={12} />
              Insert
            </Button>
          )}
          {activeTab === 'results' && onAnalyzeSchema && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onAnalyzeSchema}
              className="h-7 gap-1.5 text-[11px]"
              title="Analyze the collection's field schema"
              data-testid="analyze-schema-btn"
            >
              <Table2 size={12} />
              Schema
            </Button>
          )}
          {activeTab === 'results' && onUpdateMany && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onUpdateMany}
              className="h-7 gap-1.5 text-[11px]"
              title="Update all documents matching the current filter"
              data-testid="update-many-btn"
            >
              <Edit size={12} />
              Update Many
            </Button>
          )}
          {activeTab === 'results' && onDeleteMany && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onDeleteMany}
              className="h-7 gap-1.5 border-destructive/30 bg-destructive/10 text-[11px] text-destructive hover:bg-destructive/20"
              title="Delete all documents matching the current filter"
              data-testid="delete-many-btn"
            >
              <Trash2 size={12} />
              Delete Many
            </Button>
          )}
          {activeTab === 'results' ? (
            <div className="flex items-center rounded-md border border-border bg-background p-0.5">
              <button
                role="button"
                aria-label="Table"
                onClick={() => setViewMode('table')}
                className={cn(
                  'flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium transition-all',
                  viewMode === 'table' ? 'bg-accent text-primary' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <Table size={12} />
                <span>Table</span>
              </button>

              <button
                role="button"
                aria-label="Tree"
                onClick={() => setViewMode('tree')}
                className={cn(
                  'flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium transition-all',
                  viewMode === 'tree' ? 'bg-accent text-primary' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <ChevronRight size={12} />
                <span>Tree</span>
              </button>

              <button
                role="button"
                aria-label="JSON"
                onClick={() => setViewMode('json')}
                className={cn(
                  'flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium transition-all',
                  viewMode === 'json' ? 'bg-accent text-primary' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <Braces size={12} />
                <span>JSON</span>
              </button>

              <button
                role="button"
                aria-label="Chart"
                onClick={() => setViewMode('chart')}
                className={cn(
                  'flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium transition-all',
                  viewMode === 'chart' ? 'bg-accent text-primary' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <BarChart3 size={12} />
                <span>Chart</span>
              </button>
            </div>
          ) : activeTab === 'explain' ? (
            explainResult && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleCopy}
                className="h-7 gap-1.5 text-[11px] font-semibold"
                title="Copy Explain Plan"
              >
                {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
                <span>{copied ? 'Copied!' : 'Copy Plan'}</span>
              </Button>
            )
          ) : (
            queryCode && (
              <>
                <select
                  value={codeLang}
                  onChange={(e) => setCodeLang(e.target.value as CodeLanguage)}
                  className="h-7 rounded-md border border-border bg-background px-2 text-[11px] text-foreground"
                  aria-label="Code language"
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
                  title="Copy query code"
                  data-testid="copy-query-code-btn"
                >
                  {queryCopied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
                  <span>{queryCopied ? 'Copied!' : 'Copy'}</span>
                </Button>
              </>
            )
          )}
        </div>
      </div>

      {activeTab === 'results' ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {!documents || documents.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center p-8 text-muted-foreground">
            <ListFilter size={24} className="mb-2 text-muted-foreground" />
            <div>No documents found matching the criteria.</div>
          </div>
        ) : viewMode === 'json' ? (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background font-mono text-xs leading-relaxed" data-testid="json-view">
            <div className="min-h-0 flex-1 min-w-0 overflow-auto">
              <List<JsonRowExtra>
                rowCount={visibleJsonLines.length}
                rowHeight={getRowHeight()}
                rowComponent={JsonRow}
                rowProps={{
                  lines: visibleJsonLines,
                  collapsedFolds,
                  toggleFold,
                  documents,
                  openCtxMenu,
                  renderContent: renderJsonLineContent,
                  hasRowActions,
                  RowActions,
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
                Key
                {renderColResizer('key', treeKeyWidth, setTreeKeyWidth, 140)}
              </div>
              <div className="flex-1 border-r border-border px-3">Value</div>
              <div className="w-28 shrink-0 px-3">Type</div>
            </div>
            <div className="min-h-0 flex-1 min-w-0 overflow-hidden">
              <List<{}>
                rowCount={visibleTreeRows.length}
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
              <div className="flex h-6 shrink-0 select-none items-center border-b border-border bg-sidebar text-ui-2xs font-bold uppercase tracking-wider text-muted-foreground">
                <div className="flex items-center justify-center border-r border-border w-12 flex-shrink-0">
                  #
                </div>
                {columns.map((col) => (
                  <div
                    key={col}
                    className="px-3 border-r border-border flex items-center truncate relative"
                    style={{ width: `${colWidth(col)}px`, flexShrink: 0 }}
                  >
                    {col}
                    {renderColResizer(col, colWidth(col), (w) => setColWidths((p) => ({ ...p, [col]: w })))}
                  </div>
                ))}
                {hasRowActions && (
                  <div className="px-2 flex items-center justify-center" style={{ width: '72px', flexShrink: 0 }}>
                    Actions
                  </div>
                )}
              </div>
            )}

            {/* Virtualized list */}
            <div className="min-h-0 flex-1 min-w-0 overflow-auto">
              <List<{}>
                rowCount={documents.length}
                rowHeight={getRowHeight()}
                rowComponent={Row}
                rowProps={{}}
                style={{ height: '100%', width: '100%', minWidth: viewMode === 'table' ? `${columns.reduce((s, c) => s + colWidth(c), 0) + 48 + (hasRowActions ? 72 : 0)}px` : '100%' }}
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
                <span className="text-xs">Generating query plan...</span>
              </div>
            </div>
          ) : explainResult ? (
            <>
              <div className="flex h-8 shrink-0 select-none items-center justify-between border-b border-border bg-sidebar px-3">
                <div className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success"></span>
                  <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Query Plan Generated</span>
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
                    <span>Visual Tree</span>
                  </button>

                  <button
                    onClick={() => setExplainView('json')}
                    className={cn(
                      'flex cursor-pointer items-center gap-1.5 rounded px-2 py-0.5 text-[10px] font-semibold transition-all',
                      explainView === 'json' ? 'bg-accent text-primary' : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    <Braces size={11} />
                    <span>Raw JSON</span>
                  </button>
                </div>
              </div>

              {explainView === 'visual' ? (
                <div
                  className="flex flex-1 flex-col items-center gap-5 overflow-auto bg-background px-8 py-6"
                  style={{
                    backgroundImage: 'radial-gradient(hsl(var(--border)) 1.2px, transparent 0)',
                    backgroundSize: '16px 16px',
                  }}
                >
                  <div className="flex w-full max-w-[640px] flex-col items-center">
                    <RenderTreeNode node={getExplainTree(explainResult)} />
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
              <span className="mb-2 text-xs italic text-muted-foreground">No explain plan generated yet.</span>
              <span className="max-w-sm text-center text-[11px] leading-relaxed text-muted-foreground">
                To generate one, open the <strong>Run</strong> dropdown split menu in the query editor toolbar and select <strong>Run Explain</strong>.
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
                  fontSize: 12,
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
              <span className="text-xs italic text-muted-foreground">No query has run yet.</span>
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
              <span>showing {from}{documents.length ? `–${to}` : ''}</span>
              <span className="font-semibold text-foreground" data-testid="pager-page">
                Page {page}{totalPages !== undefined ? ` / ${totalPages}` : ''}
              </span>
              <span data-testid="pager-total">
                {countLoading ? '…' : typeof totalCount === 'number' ? `${estimated ? '~' : ''}${totalCount} docs` : '…'}
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
                  <option key={s} value={s}>{s} / page</option>
                ))}
              </select>
              <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-[11px]" data-testid="pager-prev" disabled={prevDisabled} onClick={() => onPageChange(Math.max(0, sk - lim))}>
                &lsaquo; Prev
              </Button>
              <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-[11px]" data-testid="pager-next" disabled={nextDisabled} onClick={() => onPageChange(sk + lim)}>
                Next &rsaquo;
              </Button>
            </div>
          </div>
        );
      })()}
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
