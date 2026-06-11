import React, { useState, useMemo, useEffect, useContext } from 'react';
import { DocumentViewerContext } from './DocumentViewer';
import { List } from 'react-window';
import { Table, Braces, ChevronRight, ChevronDown, ListFilter, Copy, Check, Edit, Trash2, Plus, Table2, BarChart3 } from 'lucide-react';
import { ChartView } from './ChartView';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { generateQueryCode, CODE_LANGUAGES, type CodeLanguage, type QueryCodeSpec } from '../lib/queryCodeGen';
import { EJSON, ObjectId, Long, Decimal128, Int32, Double, Binary, Timestamp } from 'bson';

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
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-sky-500">
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M3 9h18M3 15h18M9 3v18M15 3v18" />
  </svg>
);

const ResultIcon = () => (
  <div className="relative w-8 h-8 flex items-center justify-center bg-emerald-500/10 border border-emerald-500/20 rounded-lg">
    <GridIcon />
    <span className="absolute -bottom-1 -right-1 bg-emerald-500 text-white rounded-full flex items-center justify-center w-4 h-4 text-[8px] font-bold shadow border border-[var(--bg-panel)]">
      ✓
    </span>
  </div>
);

const ScanIcon = () => (
  <div className="relative w-8 h-8 flex items-center justify-center bg-blue-500/10 border border-blue-500/20 rounded-lg">
    <GridIcon />
    <span className="absolute -bottom-1 -right-1 bg-blue-500 text-white rounded-full flex items-center justify-center w-4 h-4 text-[8px] font-bold shadow border border-[var(--bg-panel)]">
      ↓
    </span>
  </div>
);

const IndexIcon = () => (
  <div className="relative w-8 h-8 flex items-center justify-center bg-purple-500/10 border border-purple-500/20 rounded-lg">
    <GridIcon />
    <span className="absolute -bottom-1 -right-1 bg-purple-500 text-white rounded-full flex items-center justify-center w-4 h-4 text-[8px] font-bold shadow border border-[var(--bg-panel)]">
      🔑
    </span>
  </div>
);

const CollectionIcon = () => (
  <div className="w-8 h-8 flex items-center justify-center bg-[var(--bg-item-hover)] border border-[var(--border-color)] rounded-lg">
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

const RenderTreeNode: React.FC<{ node: ExplainNode }> = ({ node }) => {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%' }}>
      {/* Node Box */}
      <div className={`mql-explain-node mql-explain-node-${node.type}`}>
        <div className="mql-explain-node-left">
          <div className="mql-explain-icon">
            {node.type === 'result' && <ResultIcon />}
            {node.type === 'stage' && <ScanIcon />}
            {node.type === 'collection' && <CollectionIcon />}
            {node.type === 'index' && <IndexIcon />}
          </div>
        </div>
        
        <div className="mql-explain-node-body">
          <div className="mql-explain-node-title">
            <span className="mql-explain-name">{node.name}</span>
          </div>
          {node.type === 'stage' && node.detail && (
            <span className={`mql-stage-pill stage-pill-${node.detail.toLowerCase().split(' ')[0]}`}>
              {node.detail.split(' ')[0]}
            </span>
          )}
          {node.type !== 'stage' && node.detail && (
            <span className="mql-explain-detail">{node.detail}</span>
          )}
        </div>
      </div>
      
      {/* Connector and Children */}
      {node.children && node.children.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%' }}>
          <div className="mql-explain-connector">
            <div className="mql-explain-connector-line" />
            <div className="mql-explain-connector-arrow">
              <ChevronDown size={10} className="text-[var(--border-color)]" />
            </div>
          </div>
          
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, width: '100%', alignItems: 'center' }}>
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

const jsonPunct = (text: string) => <span className="text-[var(--text-dim)]">{text}</span>;
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
      className={`mql-jsonview-line${line.isDocRoot && line.docIndex > 0 ? ' mql-jsonview-doc-start' : ''}`}
      data-doc-even={line.docIndex % 2 === 0}
      onContextMenu={(e) => openCtxMenu(e, documents[line.docIndex], line.kind === 'scalar' ? line.keyName ?? undefined : undefined, line.value)}
    >
      <span className="mql-jsonview-num" data-num={line.num} aria-hidden="true" />
      <span className="mql-jsonview-fold">
        {line.foldId !== undefined && (
          <button
            type="button"
            onClick={() => toggleFold(line.foldId!)}
            className="mql-jsonview-fold-btn"
            data-testid="json-fold-btn"
            aria-label={folded ? 'Expand' : 'Collapse'}
          >
            {folded ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
          </button>
        )}
      </span>
      <span className="mql-jsonview-content" style={{ paddingLeft: line.depth * 18 }}>
        {renderContent(line)}
        {folded && (
          <span className="text-[var(--text-dim)]">
            {' … '}
            {line.closeChar}
            {line.hasComma ? ',' : ''}
          </span>
        )}
        {line.isDocRoot && hasRowActions && line.doc && (
          <span className="mql-jsonview-actions">
            <RowActions doc={line.doc} />
          </span>
        )}
      </span>
    </div>
  );
};

export const DataGrid: React.FC<DataGridProps> = ({
  documents,
  density = 'cozy',
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
      className="mql-col-resizer"
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
      return <span className="text-[var(--text-dim)]">{JSON.stringify(val)}</span>;
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
      return <span className="text-[var(--text-dim)]">{`[ ${row.childCount} ${row.childCount === 1 ? 'element' : 'elements'} ]`}</span>;
    return <span className="text-[var(--text-dim)]">{`{ ${row.childCount} ${row.childCount === 1 ? 'field' : 'fields'} }`}</span>;
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
        className="p-1 rounded text-[var(--text-dim)] hover:text-[var(--accent-blue)] hover:bg-[var(--bg-item-active)] cursor-pointer"
        title={copied ? 'Copied' : 'Copy document (JSON)'}
        aria-label={copied ? 'Copied' : 'Copy document'}
        data-testid="copy-doc-btn"
      >
        {copied ? <Check size={12} className="text-[var(--accent-green)]" /> : <Copy size={12} />}
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
            className="p-1 rounded text-[var(--text-dim)] hover:text-[var(--accent-blue)] hover:bg-[var(--bg-item-active)] cursor-pointer"
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
            className="p-1 rounded text-[var(--text-dim)] hover:text-rose-400 hover:bg-rose-950/20 cursor-pointer"
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
        className="border-b border-[var(--border-color)] flex items-center hover:bg-[var(--bg-item-hover)] font-mono text-xs"
        onContextMenu={(e) => openCtxMenu(e, rawDoc)}
      >
        <div className="flex items-center h-full border-r border-[var(--border-color)] justify-center select-none text-[var(--text-dim)] text-[10px] w-12 flex-shrink-0">
          {index + 1}
        </div>
        {columns.map((col) => (
          <div
            key={col}
            className="px-3 border-r border-[var(--border-color)] h-full flex items-center truncate text-[var(--text-main)]"
            style={{ width: `${colWidth(col)}px`, flexShrink: 0 }}
            onContextMenu={(e) => openCtxMenu(e, rawDoc, col, rawDoc[col])}
          >
            {renderColoredCell(rawDoc[col])}
          </div>
        ))}
        {hasRowActions && (
          <div className="px-2 h-full flex items-center justify-center" style={{ width: '72px', flexShrink: 0 }}>
            <RowActions doc={rawDoc} />
          </div>
        )}
      </div>
    );
  };


  // Row height depends on viewMode and density
  const getRowHeight = () => {
    // JSON view rows are single lines (one entry per row).
    if (viewMode === 'json') {
      if (density === 'roomy') return 24;
      if (density === 'compact') return 17;
      return 20; // cozy
    }
    // Tree-table rows are single entries (one field per row).
    if (viewMode === 'tree') {
      if (density === 'roomy') return 28;
      if (density === 'compact') return 20;
      return 24; // cozy
    }
    // Table mode
    if (density === 'roomy') return 32;
    if (density === 'compact') return 20;
    return 24; // cozy
  };

  // Virtualized row for the tree-table view (Key | Value | Type).
  const TreeRowComponent = ({ index, style }: { index: number; style: React.CSSProperties }) => {
    const row = visibleTreeRows[index];
    if (!row) return null;
    const collapsed = row.foldId !== undefined && treeCollapsed.has(row.foldId);
    return (
      <div
        style={style}
        className={`mql-treetable-row${row.isDocRoot && row.docIndex > 0 ? ' mql-treetable-doc-start' : ''}`}
        data-doc-even={row.docIndex % 2 === 0}
        onContextMenu={(e) => openCtxMenu(e, documents[row.docIndex], row.kind === 'scalar' ? row.keyName : undefined, row.value)}
      >
        <div className="mql-treetable-key" style={{ paddingLeft: 6 + row.depth * 14 }}>
          {row.foldId !== undefined ? (
            <button
              type="button"
              onClick={() => toggleTreeFold(row.foldId!)}
              className="mql-treetable-fold-btn"
              data-testid="tree-fold-btn"
              aria-label={collapsed ? 'Expand' : 'Collapse'}
            >
              {collapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
            </button>
          ) : (
            <span className="mql-treetable-fold-spacer" />
          )}
          <span className="text-syntax-key truncate" title={row.keyName}>{row.keyName}</span>
        </div>
        <div className="mql-treetable-value">
          <span className="truncate">{renderTreeValue(row)}</span>
          {row.isDocRoot && hasRowActions && row.doc && (
            <span className="mql-jsonview-actions">
              <RowActions doc={row.doc} />
            </span>
          )}
        </div>
        <div className="mql-treetable-type">{row.type}</div>
      </div>
    );
  };
  return (
    <div className="mql-datagrid flex-1 flex flex-col h-full overflow-hidden bg-[var(--bg-base)]">
      {/* Control Bar */}
      <div
        className="h-9 border-b border-[var(--border-color)] flex items-center justify-between px-3 bg-[var(--bg-sidebar)] select-none"
        style={{ position: 'relative', zIndex: 30, overflow: 'visible' }}
      >
        
        {/* Left Side: Results and Explain Tabs */}
        <div className="mql-pane-tabs">
          <button
            onClick={() => setActiveTab('results')}
            className={`mql-pane-tab ${activeTab === 'results' ? 'is-active' : ''}`}
          >
            <span>Results</span>
          </button>
          
          <button
            onClick={() => {
              setActiveTab('explain');
              if (docViewerContext && !docViewerContext.explainLoading) {
                docViewerContext.handleExplain();
              }
            }}
            className={`mql-pane-tab ${activeTab === 'explain' ? 'is-active' : ''}`}
            data-testid="explain-plan-tab"
          >
            <span>Explain Plan</span>
          </button>

          {queryCode && (
            <button
              onClick={() => setActiveTab('query')}
              className={`mql-pane-tab ${activeTab === 'query' ? 'is-active' : ''}`}
              data-testid="query-code-tab"
            >
              <span>Query Code</span>
            </button>
          )}
        </div>

        {/* Right Side Controls */}
        <div className="flex items-center gap-2">
          {activeTab === 'results' && onInsertDocument && (
            <button
              onClick={onInsertDocument}
              className="flex items-center gap-1.5 px-2 py-1 rounded text-[11px] font-medium border border-[var(--border-color)] text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--bg-item-hover)] cursor-pointer transition-all"
              title="Insert a new document"
              data-testid="insert-doc-btn"
            >
              <Plus size={12} />
              <span>Insert</span>
            </button>
          )}
          {activeTab === 'results' && onAnalyzeSchema && (
            <button
              type="button"
              onClick={onAnalyzeSchema}
              className="flex items-center gap-1.5 px-2 py-1 rounded text-[11px] font-medium border border-[var(--border-color)] text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--bg-item-hover)] cursor-pointer transition-all"
              title="Analyze the collection's field schema"
              data-testid="analyze-schema-btn"
            >
              <Table2 size={12} />
              <span>Schema</span>
            </button>
          )}
          {activeTab === 'results' && onUpdateMany && (
            <button
              type="button"
              onClick={onUpdateMany}
              className="flex items-center gap-1.5 px-2 py-1 rounded text-[11px] font-medium border border-[var(--border-color)] text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--bg-item-hover)] cursor-pointer transition-all"
              title="Update all documents matching the current filter"
              data-testid="update-many-btn"
            >
              <Edit size={12} />
              <span>Update Many</span>
            </button>
          )}
          {activeTab === 'results' && onDeleteMany && (
            <button
              type="button"
              onClick={onDeleteMany}
              className="flex items-center gap-1.5 px-2 py-1 rounded text-[11px] font-medium border border-rose-900/30 bg-rose-950/10 text-rose-400 hover:bg-rose-950/20 cursor-pointer transition-all"
              title="Delete all documents matching the current filter"
              data-testid="delete-many-btn"
            >
              <Trash2 size={12} />
              <span>Delete Many</span>
            </button>
          )}
          {activeTab === 'results' ? (
            /* Toggle selectors */
            <div className="flex items-center bg-[var(--bg-base)] border border-[var(--border-color)] rounded-md p-0.5">
              <button 
                role="button"
                aria-label="Table"
                onClick={() => setViewMode('table')}
                className={`px-2 py-1 rounded flex items-center gap-1.5 text-[11px] font-medium transition-all cursor-pointer ${viewMode === 'table' ? 'bg-[var(--bg-item-active)] text-[var(--accent-blue)]' : 'text-[var(--text-muted)] hover:text-[var(--text-main)]'}`}
              >
                <Table size={12} />
                <span>Table</span>
              </button>
              
              <button 
                role="button"
                aria-label="Tree"
                onClick={() => setViewMode('tree')}
                className={`px-2 py-1 rounded flex items-center gap-1.5 text-[11px] font-medium transition-all cursor-pointer ${viewMode === 'tree' ? 'bg-[var(--bg-item-active)] text-[var(--accent-blue)]' : 'text-[var(--text-muted)] hover:text-[var(--text-main)]'}`}
              >
                <ChevronRight size={12} />
                <span>Tree</span>
              </button>

              <button 
                role="button"
                aria-label="JSON"
                onClick={() => setViewMode('json')}
                className={`px-2 py-1 rounded flex items-center gap-1.5 text-[11px] font-medium transition-all cursor-pointer ${viewMode === 'json' ? 'bg-[var(--bg-item-active)] text-[var(--accent-blue)]' : 'text-[var(--text-muted)] hover:text-[var(--text-main)]'}`}
              >
                <Braces size={12} />
                <span>JSON</span>
              </button>

              <button
                role="button"
                aria-label="Chart"
                onClick={() => setViewMode('chart')}
                className={`px-2 py-1 rounded flex items-center gap-1.5 text-[11px] font-medium transition-all cursor-pointer ${viewMode === 'chart' ? 'bg-[var(--bg-item-active)] text-[var(--accent-blue)]' : 'text-[var(--text-muted)] hover:text-[var(--text-main)]'}`}
              >
                <BarChart3 size={12} />
                <span>Chart</span>
              </button>
            </div>
          ) : activeTab === 'explain' ? (
            /* Explain Tools */
            explainResult && (
              <button
                onClick={handleCopy}
                className="px-2.5 py-1 rounded bg-[var(--bg-item-active)] hover:bg-[var(--bg-item-hover)] text-[var(--text-muted)] hover:text-[var(--text-main)] border border-[var(--border-color)] flex items-center gap-1.5 text-[11px] font-semibold transition-all cursor-pointer"
                title="Copy Explain Plan"
              >
                {copied ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
                <span>{copied ? 'Copied!' : 'Copy Plan'}</span>
              </button>
            )
          ) : (
            /* Query Code Tools */
            queryCode && (
              <>
                <select
                  value={codeLang}
                  onChange={(e) => setCodeLang(e.target.value as CodeLanguage)}
                  className="px-2 py-1 rounded bg-[var(--bg-base)] text-[var(--text-main)] border border-[var(--border-color)] text-[11px] font-medium cursor-pointer"
                  aria-label="Code language"
                  data-testid="query-code-lang"
                >
                  {CODE_LANGUAGES.map((lang) => (
                    <option key={lang} value={lang}>{lang}</option>
                  ))}
                </select>
                <button
                  onClick={handleCopyQueryCode}
                  className="px-2.5 py-1 rounded bg-[var(--bg-item-active)] hover:bg-[var(--bg-item-hover)] text-[var(--text-muted)] hover:text-[var(--text-main)] border border-[var(--border-color)] flex items-center gap-1.5 text-[11px] font-semibold transition-all cursor-pointer"
                  title="Copy query code"
                  data-testid="copy-query-code-btn"
                >
                  {queryCopied ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
                  <span>{queryCopied ? 'Copied!' : 'Copy'}</span>
                </button>
              </>
            )
          )}
        </div>
      </div>

      {activeTab === 'results' ? (
        !documents || documents.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center text-[var(--text-dim)] p-8">
            <ListFilter size={24} className="mb-2 text-[var(--text-dim)]" />
            <div>No documents found matching the criteria.</div>
          </div>
        ) : viewMode === 'json' ? (
          /* Virtualized, line-numbered, collapsible JSON code panel */
          <div className="mql-jsonview flex-1 flex flex-col min-h-0 min-w-0" data-testid="json-view">
            <div className="flex-1 min-w-0 overflow-auto">
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
          /* Virtualized tree-table: Key | Value | Type */
          <div
            className="mql-treetable flex-1 flex flex-col min-h-0 min-w-0"
            data-testid="tree-view"
            style={{ '--treetable-keyw': `${treeKeyWidth}px` } as React.CSSProperties}
          >
            <div className="mql-treetable-head">
              <div className="mql-treetable-key relative">
                Key
                {renderColResizer('key', treeKeyWidth, setTreeKeyWidth, 140)}
              </div>
              <div className="mql-treetable-value">Value</div>
              <div className="mql-treetable-type">Type</div>
            </div>
            <div className="flex-1 min-w-0">
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
          <div className="flex-1 overflow-auto flex flex-col min-w-0">
            {viewMode === 'table' && (
              /* Table Headers */
              <div className="flex bg-[var(--bg-sidebar)] border-b border-[var(--border-color)] h-6 flex-shrink-0 text-[10px] font-bold text-[var(--text-muted)] uppercase tracking-wider select-none">
                <div className="flex items-center justify-center border-r border-[var(--border-color)] w-12 flex-shrink-0">
                  #
                </div>
                {columns.map((col) => (
                  <div
                    key={col}
                    className="px-3 border-r border-[var(--border-color)] flex items-center truncate relative"
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
            <div className="flex-1 min-w-0">
              <List<{}>
                rowCount={documents.length}
                rowHeight={getRowHeight()}
                rowComponent={Row}
                rowProps={{}}
                style={{ height: '100%', width: '100%', minWidth: viewMode === 'table' ? `${columns.reduce((s, c) => s + colWidth(c), 0) + 48 + (hasRowActions ? 72 : 0)}px` : '100%' }}
              />
            </div>
          </div>
        )
      ) : activeTab === 'explain' ? (
        /* Explain Plan Workspace */
        <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden" data-testid="explain-panel">
          {docViewerContext?.explainLoading ? (
            <div className="flex-1 flex flex-col items-center justify-center text-[var(--text-muted)] select-none p-6 bg-[var(--bg-base)]" data-testid="explain-loading">
              <div className="flex flex-col items-center gap-2 select-none">
                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-[var(--accent-blue)]"></div>
                <span className="text-xs">Generating query plan...</span>
              </div>
            </div>
          ) : explainResult ? (
            <>
              {/* Sub-header with toggles */}
              <div className="h-8 border-b border-[var(--border-color)] flex items-center justify-between px-3 bg-[var(--bg-sidebar)] select-none flex-shrink-0">
                <div className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
                  <span className="text-[10px] font-bold text-[var(--text-muted)] uppercase tracking-wider">Query Plan Generated</span>
                </div>
                
                <div className="flex items-center bg-[var(--bg-base)] border border-[var(--border-color)] rounded-md p-0.5">
                  <button
                    onClick={() => setExplainView('visual')}
                    className={`px-2 py-0.5 rounded flex items-center gap-1.5 text-[10px] font-semibold transition-all cursor-pointer ${explainView === 'visual' ? 'bg-[var(--bg-item-active)] text-[var(--accent-blue)]' : 'text-[var(--text-muted)] hover:text-[var(--text-main)]'}`}
                  >
                    <Table size={11} />
                    <span>Visual Tree</span>
                  </button>
                  
                  <button
                    onClick={() => setExplainView('json')}
                    className={`px-2 py-0.5 rounded flex items-center gap-1.5 text-[10px] font-semibold transition-all cursor-pointer ${explainView === 'json' ? 'bg-[var(--bg-item-active)] text-[var(--accent-blue)]' : 'text-[var(--text-muted)] hover:text-[var(--text-main)]'}`}
                  >
                    <Braces size={11} />
                    <span>Raw JSON</span>
                  </button>
                </div>
              </div>
              
              {/* Explain plan content */}
              {explainView === 'visual' ? (
                <div className="mql-explain-canvas">
                  <div className="mql-explain-card">
                    <RenderTreeNode node={getExplainTree(explainResult)} />
                  </div>
                </div>
              ) : (
                <div className="flex-1 overflow-auto bg-[var(--bg-base)] p-4 select-text">
                  <pre className="text-[11px] text-[var(--syntax-key)] font-mono select-text leading-relaxed whitespace-pre-wrap">
                    {explainResult}
                  </pre>
                </div>
              )}
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-[var(--text-muted)] select-none p-6 bg-[var(--bg-base)]">
              <span className="text-xs italic mb-2 text-[var(--text-dim)]">No explain plan generated yet.</span>
              <span className="text-[11px] text-[var(--text-dim)] max-w-sm text-center leading-relaxed">
                To generate one, open the <strong>Run</strong> dropdown split menu in the query editor toolbar and select <strong>Run Explain</strong>.
              </span>
            </div>
          )}
        </div>
      ) : (
        /* Query Code Workspace */
        <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden" data-testid="query-code-panel">
          {queryCode ? (
            <div className="flex-1 overflow-auto bg-[var(--bg-base)] p-4 select-text">
              <pre
                className="text-[11px] text-[var(--syntax-key)] font-mono select-text leading-relaxed whitespace-pre-wrap"
                data-testid="query-code-content"
              >
                {queryCode}
              </pre>
            </div>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-[var(--text-muted)] select-none p-6 bg-[var(--bg-base)]">
              <span className="text-xs italic text-[var(--text-dim)]">No query has run yet.</span>
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
          <div className="mql-pager" data-testid="pager">
            <div className="mql-pager-info">
              <span>showing {from}{documents.length ? `–${to}` : ''}</span>
              <span className="mql-pager-page" data-testid="pager-page">
                Page {page}{totalPages !== undefined ? ` / ${totalPages}` : ''}
              </span>
              <span className="mql-pager-total" data-testid="pager-total">
                {countLoading ? '…' : typeof totalCount === 'number' ? `${estimated ? '~' : ''}${totalCount} docs` : '…'}
              </span>
            </div>
            <div className="mql-pager-controls">
              <select
                data-testid="pager-size"
                value={lim}
                onChange={(e) => onPageSizeChange(Number(e.target.value))}
              >
                {[25, 50, 100, 200].map((s) => (
                  <option key={s} value={s}>{s} / page</option>
                ))}
              </select>
              <button type="button" data-testid="pager-prev" disabled={prevDisabled} onClick={() => onPageChange(Math.max(0, sk - lim))}>
                &lsaquo; Prev
              </button>
              <button type="button" data-testid="pager-next" disabled={nextDisabled} onClick={() => onPageChange(sk + lim)}>
                Next &rsaquo;
              </button>
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
