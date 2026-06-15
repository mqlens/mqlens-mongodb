import React, { useState, useEffect, useRef, useMemo } from 'react';
import { AIChatPanel } from './AIChatPanel';
import { QueryEditor } from './QueryEditor';
import { useCollectionSchema } from '../lib/useCollectionSchema';
import { collectionRef, type GeneratedQuery } from '../lib/mongoCommand';
import { parseShellJson } from '../lib/shellDoc';
import {
  loadCollectionQueries,
  saveQuery,
  deleteSavedQuery,
  setDefaultQuery,
  type SavedQuery,
  type HistoryEntry,
} from '../lib/queryStore';
import {
  loadFavoriteItems,
  toggleFavoriteItem,
  isItemFavorited,
  FAVORITES_CHANGED_EVENT,
  type FavoriteItem,
} from '../lib/favoriteItems';
import { useDialogs } from './dialogs/DialogProvider';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from '@/components/ui/resizable';
import type { Layout } from 'react-resizable-panels';
import { cn } from '@/lib/utils';
import {
  Play, 
  AlertCircle,
  Cpu,
  User,
  Server,
  Database,
  ChevronRight,
  ChevronUp,
  FolderOpen,
  Layers,
  Save, 
  History, 
  Anchor, 
  ExternalLink, 
  Sparkles, 
  DatabaseZap, 
  Trash2,
  Eraser,
  ArrowUpDown,
  Check,
  ChevronDown,
  Plus,
  Download,
  Upload,
  X,
  Eye,
  EyeOff,
  GripVertical,
  Undo2,
  Redo2,
  Heart,
} from 'lucide-react';

interface VisualRule {
  id: string;
  field: string;
  operator: string;
  value: string;
}

interface ProjectionRule {
  id: string;
  field: string;
  include: boolean;
}

interface SortRule {
  id: string;
  field: string;
  direction: 1 | -1;
}

export interface PipelineStage {
  id: string;
  operator: string;
  content: string;
  disabled?: boolean;
  collapsed?: boolean;
}

export interface BuilderState {
  queryMode: 'find' | 'aggregate';
  filterQuery: string;
  sortQuery: string;
  projectionQuery: string;
  limit: string;
  skip: string;
  stages: PipelineStage[];
}

export const DEFAULT_BUILDER_STATE: BuilderState = {
  queryMode: 'find',
  filterQuery: '{}',
  sortQuery: '{}',
  projectionQuery: '{}',
  limit: '50',
  skip: '0',
  stages: [{ id: 'stage-1', operator: '$match', content: '{\n  \n}' }],
};

const stagesFromPipeline = (pipeline: unknown[]): PipelineStage[] =>
  pipeline.map((stage, i) => {
    const obj = (stage && typeof stage === 'object' ? stage : {}) as Record<string, unknown>;
    const operator = Object.keys(obj)[0] ?? '$match';
    return {
      id: `stage-${i + 1}`,
      operator,
      content: JSON.stringify(obj[operator] ?? {}, null, 2),
    };
  });

/** Derive editor state from a tab's last executed find or aggregate query. */
export function builderStateFromQueryTab(
  lastQuery?: { filter: string; sort: string; projection: string; limit: number; skip: number },
  lastAggregate?: Record<string, unknown>[]
): BuilderState {
  if (lastAggregate && lastAggregate.length > 0) {
    return {
      ...DEFAULT_BUILDER_STATE,
      queryMode: 'aggregate',
      stages: stagesFromPipeline(lastAggregate),
    };
  }
  if (lastQuery) {
    return {
      ...DEFAULT_BUILDER_STATE,
      queryMode: 'find',
      filterQuery: lastQuery.filter,
      sortQuery: lastQuery.sort,
      projectionQuery: lastQuery.projection,
      limit: String(lastQuery.limit),
      skip: String(lastQuery.skip),
    };
  }
  return DEFAULT_BUILDER_STATE;
}

// Serialize the current builder state into a GeneratedQuery — the same value
// handleRun executes — so Save/Default capture exactly what would run.
// Invalid JSON degrades to {} (find) or a dropped stage (aggregate).
export function builderStateToQuery(state: BuilderState): GeneratedQuery {
  const parse = (s: string): unknown => {
    try {
      return s.trim() ? parseShellJson(s) : {};
    } catch {
      return {};
    }
  };
  if (state.queryMode === 'aggregate') {
    const pipeline = state.stages
      .filter((stage) => !stage.disabled && stage.content.trim())
      .map((stage) => ({ [stage.operator]: parseShellJson(stage.content) }));
    return { queryType: 'aggregate', pipeline };
  }
  return {
    queryType: 'find',
    filter: parse(state.filterQuery),
    sort: parse(state.sortQuery),
    projection: parse(state.projectionQuery),
    limit: Number(state.limit) || 50,
    skip: Number(state.skip) || 0,
  };
}

interface DocumentViewerProps {
  connectionId?: string;
  connectionName: string;
  /** Auth username parsed from the connection URI; empty when the connection has no credentials. */
  connectionUser?: string;
  databaseName: string;
  collectionName: string;
  onExecute: (query: { filter: string; sort: string; projection: string; limit: number; skip: number }) => void;
  onExecuteAggregate?: (pipeline: Record<string, unknown>[]) => void;
  onExplain: (filter: string) => Promise<string>;
  // Explain a full aggregation pipeline (M1). Receives the pipeline as a JSON string.
  onExplainAggregate?: (pipeline: string) => Promise<string>;
  onOpenShell?: (command: string) => void;
  onOpenExport?: () => void;
  onImport?: () => void;
  loading: boolean;
  availableFields?: string[];
  /** Restored when remounting this tab's viewer (see App tab cache). */
  initialBuilderState?: BuilderState;
  onBuilderStateChange?: (state: BuilderState) => void;
  children?: React.ReactNode;
}

const OPERATORS = [
  { value: '$eq', label: '=' },
  { value: '$ne', label: '!=' },
  { value: '$gt', label: '>' },
  { value: '$gte', label: '>=' },
  { value: '$lt', label: '<' },
  { value: '$lte', label: '<=' },
  { value: '$in', label: 'in' },
  { value: '$nin', label: 'not in' },
  { value: '$regex', label: 'regex' },
  { value: '$exists', label: 'exists' },
];

// MongoDB aggregation pipeline stages, grouped for the stage-operator dropdown.
const STAGE_OPERATORS: { group: string; stages: string[] }[] = [
  {
    group: 'Filtering & shaping',
    stages: ['$match', '$project', '$addFields', '$set', '$unset', '$replaceRoot', '$replaceWith', '$redact'],
  },
  {
    group: 'Grouping & aggregation',
    stages: ['$group', '$bucket', '$bucketAuto', '$sortByCount', '$count', '$facet'],
  },
  {
    group: 'Ordering & limiting',
    stages: ['$sort', '$limit', '$skip', '$sample'],
  },
  {
    group: 'Arrays & joins',
    stages: ['$unwind', '$lookup', '$graphLookup', '$unionWith'],
  },
  {
    group: 'Windows & time series',
    stages: ['$setWindowFields', '$densify', '$fill'],
  },
  {
    group: 'Geospatial',
    stages: ['$geoNear'],
  },
  {
    group: 'Sources & output',
    stages: ['$documents', '$out', '$merge'],
  },
];

// Runnable starter body per stage operator, inserted when the user switches
// the operator on a stage whose body they haven't edited yet.
const STAGE_BODY_TEMPLATES: Record<string, string> = {
  '$match': '{\n  \n}',
  '$project': '{\n  \n}',
  '$addFields': '{\n  \n}',
  '$set': '{\n  \n}',
  '$unset': '"field"',
  '$replaceRoot': '{\n  "newRoot": "$field"\n}',
  '$replaceWith': '"$field"',
  '$redact': '{\n  \n}',
  '$group': '{\n  "_id": null\n}',
  '$bucket': '{\n  "groupBy": "$field",\n  "boundaries": [0, 10],\n  "default": "other"\n}',
  '$bucketAuto': '{\n  "groupBy": "$field",\n  "buckets": 5\n}',
  '$sortByCount': '"$field"',
  '$count': '"count"',
  '$facet': '{\n  \n}',
  '$sort': '{\n  \n}',
  '$limit': '10',
  '$skip': '0',
  '$sample': '{\n  "size": 10\n}',
  '$unwind': '"$field"',
  '$lookup': '{\n  "from": "collection",\n  "localField": "field",\n  "foreignField": "field",\n  "as": "joined"\n}',
  '$graphLookup': '{\n  "from": "collection",\n  "startWith": "$field",\n  "connectFromField": "field",\n  "connectToField": "field",\n  "as": "linked"\n}',
  '$unionWith': '"collection"',
  '$setWindowFields': '{\n  "sortBy": {},\n  "output": {}\n}',
  '$densify': '{\n  "field": "field",\n  "range": { "step": 1, "bounds": "full" }\n}',
  '$fill': '{\n  "output": {}\n}',
  '$geoNear': '{\n  "near": { "type": "Point", "coordinates": [0, 0] },\n  "distanceField": "distance"\n}',
  '$documents': '[\n  \n]',
  '$out': '"collection"',
  '$merge': '{\n  "into": "collection"\n}',
};

// A body the user hasn't meaningfully edited: empty, bare braces, or exactly
// one of the templates above (so switching operators keeps replacing it).
const isUntouchedStageBody = (content: string): boolean => {
  const flat = content.replace(/\s/g, '');
  if (flat === '' || flat === '{}') return true;
  return Object.values(STAGE_BODY_TEMPLATES).some((tpl) => tpl.replace(/\s/g, '') === flat);
};

const parseValue = (val: string): any => {
  const trimmed = val.trim();
  if (trimmed === '') return '';
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  
  try {
    return JSON.parse(trimmed);
  } catch {
    if (!isNaN(Number(trimmed))) {
      return Number(trimmed);
    }
    return val;
  }
};

const compileRulesToQuery = (rules: VisualRule[], matchType: 'and' | 'or'): string => {
  if (rules.length === 0) return '{}';
  
  const ruleObjects = rules.map(rule => {
    if (!rule.field || rule.field === '__custom__') return null;
    let parsedValue = parseValue(rule.value);
    
    const ruleObj: Record<string, any> = {};
    if (rule.operator === '$eq') {
      ruleObj[rule.field] = parsedValue;
    } else if (rule.operator === '$exists') {
      ruleObj[rule.field] = { $exists: rule.value.trim() === 'true' };
    } else {
      ruleObj[rule.field] = { [rule.operator]: parsedValue };
    }
    return ruleObj;
  }).filter(Boolean) as Record<string, any>[];
  
  if (ruleObjects.length === 0) return '{}';
  
  if (matchType === 'or') {
    return JSON.stringify({ $or: ruleObjects }, null, 2);
  } else {
    const queryObj: Record<string, any> = {};
    ruleObjects.forEach(obj => {
      const [field] = Object.keys(obj);
      const val = obj[field];
      
      if (queryObj[field] !== undefined) {
        if (val && typeof val === 'object' && !Array.isArray(val) &&
            queryObj[field] && typeof queryObj[field] === 'object' && !Array.isArray(queryObj[field])) {
          queryObj[field] = { ...queryObj[field], ...val };
        } else {
          queryObj[field] = val;
        }
      } else {
        queryObj[field] = val;
      }
    });
    return JSON.stringify(queryObj, null, 2);
  }
};

const compileProjectionRules = (rules: ProjectionRule[]): string => {
  if (rules.length === 0) return '{}';
  const projObj: Record<string, number> = {};
  rules.forEach(r => {
    if (r.field && r.field !== '__custom__') {
      projObj[r.field] = r.include ? 1 : 0;
    }
  });
  return JSON.stringify(projObj, null, 2);
};

const compileSortRules = (rules: SortRule[]): string => {
  if (rules.length === 0) return '{}';
  const sortObj: Record<string, number> = {};
  rules.forEach(r => {
    if (r.field && r.field !== '__custom__') {
      sortObj[r.field] = r.direction;
    }
  });
  return JSON.stringify(sortObj, null, 2);
};

const parseFieldQuery = (field: string, value: any): VisualRule[] => {
  const rules: VisualRule[] = [];
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    const hasOperators = keys.every(k => k.startsWith('$'));
    
    if (hasOperators && keys.length > 0) {
      keys.forEach(op => {
        const opVal = value[op];
        rules.push({
          id: Math.random().toString(36).substr(2, 9),
          field,
          operator: op,
          value: typeof opVal === 'object' ? JSON.stringify(opVal) : String(opVal)
        });
      });
    } else {
      rules.push({
        id: Math.random().toString(36).substr(2, 9),
        field,
        operator: '$eq',
        value: JSON.stringify(value)
      });
    }
  } else {
    let stringVal = '';
    if (typeof value === 'string') {
      if (value === 'true' || value === 'false' || value === 'null' || !isNaN(Number(value))) {
        stringVal = JSON.stringify(value);
      } else {
        stringVal = value;
      }
    } else {
      stringVal = JSON.stringify(value);
    }
    rules.push({
      id: Math.random().toString(36).substr(2, 9),
      field,
      operator: '$eq',
      value: stringVal
    });
  }
  return rules;
};

const syncRulesFromQuery = (jsonStr: string): { rules: VisualRule[], matchType: 'and' | 'or' } => {
  try {
    const query = parseShellJson(jsonStr);
    if (!query || typeof query !== 'object' || Array.isArray(query)) {
      return { rules: [], matchType: 'and' };
    }
    
    if (query['$or'] && Array.isArray(query['$or'])) {
      const parsedRules: VisualRule[] = [];
      query['$or'].forEach((subQuery: any) => {
        if (subQuery && typeof subQuery === 'object') {
          Object.entries(subQuery).forEach(([field, value]) => {
            parsedRules.push(...parseFieldQuery(field, value));
          });
        }
      });
      return { rules: parsedRules, matchType: 'or' };
    }
    
    const parsedRules: VisualRule[] = [];
    Object.entries(query).forEach(([field, value]) => {
      parsedRules.push(...parseFieldQuery(field, value));
    });
    return { rules: parsedRules, matchType: 'and' };
  } catch {
    return { rules: [], matchType: 'and' };
  }
};

const syncProjectionFromQuery = (jsonStr: string): ProjectionRule[] => {
  try {
    const query = parseShellJson(jsonStr);
    if (!query || typeof query !== 'object' || Array.isArray(query)) {
      return [];
    }
    const rules: ProjectionRule[] = [];
    Object.entries(query).forEach(([field, val]) => {
      rules.push({
        id: Math.random().toString(36).substr(2, 9),
        field,
        include: val === 1 || val === true
      });
    });
    return rules;
  } catch {
    return [];
  }
};

const syncSortFromQuery = (jsonStr: string): SortRule[] => {
  try {
    const query = parseShellJson(jsonStr);
    if (!query || typeof query !== 'object' || Array.isArray(query)) {
      return [];
    }
    const rules: SortRule[] = [];
    Object.entries(query).forEach(([field, val]) => {
      rules.push({
        id: Math.random().toString(36).substr(2, 9),
        field,
        direction: val === -1 ? -1 : 1
      });
    });
    return rules;
  } catch {
    return [];
  }
};

export interface DocumentViewerContextType {
  handleExplain: () => void;
  explainLoading: boolean;
}

export const DocumentViewerContext = React.createContext<DocumentViewerContextType | null>(null);

export const DocumentViewer: React.FC<DocumentViewerProps> = ({
  connectionId,
  connectionName,
  connectionUser,
  databaseName,
  collectionName,
  onExecute,
  onExecuteAggregate,
  onExplain,
  onExplainAggregate,
  onOpenShell,
  onOpenExport,
  onImport,
  loading,
  availableFields = [],
  initialBuilderState = DEFAULT_BUILDER_STATE,
  onBuilderStateChange,
  children
}) => {
  const { prompt, toast } = useDialogs();
  const { schema } = useCollectionSchema(connectionId, databaseName, collectionName);
  const [filterQuery, setFilterQuery] = useState(initialBuilderState.filterQuery);
  const [projectionQuery, setProjectionQuery] = useState(initialBuilderState.projectionQuery);
  const [sortQuery, setSortQuery] = useState(initialBuilderState.sortQuery);
  const [limit, setLimit] = useState(initialBuilderState.limit);
  const [skip, setSkip] = useState(initialBuilderState.skip);
  const [explainLoading, setExplainLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedQueries, setSavedQueries] = useState<SavedQuery[]>([]);
  const [queryHistory, setQueryHistory] = useState<HistoryEntry[]>([]);
  const [favoriteItems, setFavoriteItems] = useState<FavoriteItem[]>(() => loadFavoriteItems());

  useEffect(() => {
    const onFavorites = () => setFavoriteItems(loadFavoriteItems());
    window.addEventListener(FAVORITES_CHANGED_EVENT, onFavorites);
    return () => window.removeEventListener(FAVORITES_CHANGED_EVENT, onFavorites);
  }, []);

  const queryFavoriteEntry = (sq: SavedQuery): FavoriteItem => ({
    kind: 'query',
    connectionName,
    db: databaseName,
    collection: collectionName,
    queryId: sq.id,
    label: sq.name,
  });

  const isQueryFavorited = (sq: SavedQuery): boolean =>
    isItemFavorited(favoriteItems, queryFavoriteEntry(sq));

  const refreshStoredQueries = React.useCallback(async () => {
    try {
      const cq = await loadCollectionQueries(connectionName, databaseName, collectionName);
      setSavedQueries(cq.saved ?? []);
      setQueryHistory(cq.history ?? []);
    } catch {
      // Best-effort: leave the lists as-is on failure.
    }
  }, [connectionName, databaseName, collectionName]);

  useEffect(() => {
    refreshStoredQueries();
  }, [refreshStoredQueries]);

  // Query mode: traditional find vs aggregate pipeline
  const [queryMode, setQueryMode] = useState<'find' | 'aggregate'>(initialBuilderState.queryMode);
  const [stages, setStages] = useState<PipelineStage[]>(initialBuilderState.stages);

  useEffect(() => {
    onBuilderStateChange?.({
      queryMode,
      filterQuery,
      sortQuery,
      projectionQuery,
      limit,
      skip,
      stages,
    });
  }, [queryMode, filterQuery, sortQuery, projectionQuery, limit, skip, stages, onBuilderStateChange]);

  // AI chat assistant — open/close only; the panel owns its own chat state.
  const [isAIHelperOpen, setIsAIHelperOpen] = useState(false);

  // Pipeline undo/redo: every stage mutation goes through commitStages, which
  // snapshots the previous list. Keystroke-level content edits coalesce via a
  // key so undo steps back over whole edits, not single characters.
  const stagesPast = useRef<PipelineStage[][]>([]);
  const stagesFuture = useRef<PipelineStage[][]>([]);
  const lastStageEditRef = useRef<string | null>(null);
  const commitStages = (next: PipelineStage[], coalesceKey?: string) => {
    if (!coalesceKey || lastStageEditRef.current !== coalesceKey) {
      stagesPast.current = [...stagesPast.current.slice(-99), stages];
      stagesFuture.current = [];
    }
    lastStageEditRef.current = coalesceKey ?? null;
    setStages(next);
  };
  const undoStages = () => {
    const prev = stagesPast.current.pop();
    if (!prev) return;
    stagesFuture.current.push(stages);
    lastStageEditRef.current = null;
    setStages(prev);
  };
  const redoStages = () => {
    const next = stagesFuture.current.pop();
    if (!next) return;
    stagesPast.current.push(stages);
    lastStageEditRef.current = null;
    setStages(next);
  };

  const addStage = () => {
    const newStage = {
      id: `stage-${Math.random().toString(36).substr(2, 9)}`,
      operator: '$match',
      content: '{\n  \n}'
    };
    commitStages([...stages, newStage]);
  };

  const removeStage = (id: string) => {
    commitStages(stages.filter(s => s.id !== id));
  };

  const updateStageOperator = (id: string, operator: string) => {
    commitStages(stages.map(s => s.id === id
      ? {
          ...s,
          operator,
          // Seed the new operator's starter body unless the user already wrote one.
          content: isUntouchedStageBody(s.content) ? (STAGE_BODY_TEMPLATES[operator] ?? '{\n  \n}') : s.content,
        }
      : s));
  };

  const updateStageContent = (id: string, content: string) => {
    commitStages(stages.map(s => s.id === id ? { ...s, content } : s), `content:${id}`);
  };

  const toggleStageDisabled = (id: string) => {
    commitStages(stages.map(s => s.id === id ? { ...s, disabled: !s.disabled } : s));
  };

  // Collapse is visual only — collapsed stages still run.
  const toggleStageCollapsed = (id: string) => {
    commitStages(stages.map(s => s.id === id ? { ...s, collapsed: !s.collapsed } : s));
  };

  // $lookup form helper: read/write the four common parameters directly in the
  // stage body so the user doesn't have to hand-edit the JSON.
  const lookupFieldValue = (stage: PipelineStage, key: string): string => {
    try {
      const body = parseShellJson(stage.content);
      return body && typeof body === 'object' && typeof (body as Record<string, unknown>)[key] === 'string'
        ? (body as Record<string, string>)[key]
        : '';
    } catch {
      return '';
    }
  };
  const updateLookupField = (id: string, key: string, value: string) => {
    const stage = stages.find(s => s.id === id);
    if (!stage) return;
    let body: Record<string, unknown> = {};
    try {
      const parsed = parseShellJson(stage.content);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch { /* unparseable body — rebuild from the form */ }
    body[key] = value;
    commitStages(
      stages.map(s => s.id === id ? { ...s, content: JSON.stringify(body, null, 2) } : s),
      `lookup:${id}:${key}`,
    );
  };

  // Drag-to-reorder: header is the drag handle; dropping on a stage moves the
  // dragged stage to that position.
  const [dragStageIndex, setDragStageIndex] = useState<number | null>(null);
  const dropStageAt = (target: number) => {
    if (dragStageIndex === null || dragStageIndex === target) { setDragStageIndex(null); return; }
    const next = [...stages];
    const [moved] = next.splice(dragStageIndex, 1);
    next.splice(target, 0, moved);
    commitStages(next);
    setDragStageIndex(null);
  };

  // Run the pipeline truncated after `index` (enabled stages only) — a quick
  // preview of what the data looks like at that point.
  const runToStage = (index: number) => {
    if (!onExecuteAggregate) return;
    setError(null);
    try {
      const pipeline = stages.slice(0, index + 1)
        .filter(s => !s.disabled && s.content.trim())
        .map(s => ({ [s.operator]: parseShellJson(s.content) }));
      onExecuteAggregate(pipeline);
    } catch (e: any) {
      setError(`Invalid JSON syntax: ${e.message}`);
    }
  };

  const moveStageUp = (index: number) => {
    if (index === 0) return;
    const next = [...stages];
    [next[index - 1], next[index]] = [next[index], next[index - 1]];
    commitStages(next);
  };

  const moveStageDown = (index: number) => {
    if (index === stages.length - 1) return;
    const next = [...stages];
    [next[index], next[index + 1]] = [next[index + 1], next[index]];
    commitStages(next);
  };

  // Apply a generated query to the editor; auto-switch to aggregation mode for pipelines.
  const handleInsertQuery = (query: GeneratedQuery) => {
    if (query.queryType === 'aggregate') {
      const pipeline = query.pipeline && query.pipeline.length > 0 ? query.pipeline : [{ $match: {} }];
      commitStages(stagesFromPipeline(pipeline));
      setQueryMode('aggregate');
      toast('Aggregation pipeline applied', 'success');
    } else {
      setFilterQuery(JSON.stringify(query.filter ?? {}, null, 2));
      setSortQuery(JSON.stringify(query.sort ?? {}, null, 2));
      if (query.projection !== undefined) {
        setProjectionQuery(JSON.stringify(query.projection ?? {}, null, 2));
      }
      setQueryMode('find');
      toast('Query applied to editor', 'success');
    }
  };

  // Insert the generated query into the editor, then execute it immediately.
  const handleInsertAndRunQuery = (query: GeneratedQuery) => {
    handleInsertQuery(query);
    if (query.queryType === 'aggregate') {
      const pipeline =
        query.pipeline && query.pipeline.length > 0
          ? (query.pipeline as Record<string, unknown>[])
          : [{ $match: {} }];
      if (onExecuteAggregate) onExecuteAggregate(pipeline);
    } else {
      onExecute({
        filter: JSON.stringify(query.filter ?? {}),
        sort: JSON.stringify(query.sort ?? {}),
        projection: JSON.stringify(query.projection ?? {}),
        limit: 50,
        skip: 0,
      });
    }
  };

  const checkIsValidJson = (text: string) => {
    try {
      if (!text.trim()) return true;
      JSON.parse(text);
      return true;
    } catch {
      return false;
    }
  };

  // Visual Query Builder State
  const [isQueryBuilderOpen, setIsQueryBuilderOpen] = useState(false);
  const [rules, setRules] = useState<VisualRule[]>([]);
  const [queryMatchType, setQueryMatchType] = useState<'and' | 'or'>('and');
  
  const [projectionRules, setProjectionRules] = useState<ProjectionRule[]>([]);
  const [sortRules, setSortRules] = useState<SortRule[]>([]);
  
  const [isQueryEnabled, setIsQueryEnabled] = useState(true);
  const [isProjectionEnabled, setIsProjectionEnabled] = useState(true);
  const [isSortEnabled, setIsSortEnabled] = useState(true);
  
  const wasOpenRef = React.useRef(false);
  const rulesRef = React.useRef(rules);
  const queryMatchTypeRef = React.useRef(queryMatchType);
  const projectionRulesRef = React.useRef(projectionRules);
  const sortRulesRef = React.useRef(sortRules);
  rulesRef.current = rules;
  queryMatchTypeRef.current = queryMatchType;
  projectionRulesRef.current = projectionRules;
  sortRulesRef.current = sortRules;

  const fields = availableFields.length > 0 ? availableFields : ['_id'];

  // Validation states
  const [isFilterValid, setIsFilterValid] = useState(true);
  const [isProjectionValid, setIsProjectionValid] = useState(true);
  const [isSortValid, setIsSortValid] = useState(true);

  useEffect(() => {
    try {
      if (filterQuery.trim()) {
        parseShellJson(filterQuery);
      }
      setIsFilterValid(true);
    } catch {
      setIsFilterValid(false);
    }
  }, [filterQuery]);

  useEffect(() => {
    try {
      if (projectionQuery.trim()) {
        parseShellJson(projectionQuery);
      }
      setIsProjectionValid(true);
    } catch {
      setIsProjectionValid(false);
    }
  }, [projectionQuery]);

  useEffect(() => {
    try {
      if (sortQuery.trim()) {
        parseShellJson(sortQuery);
      }
      setIsSortValid(true);
    } catch {
      setIsSortValid(false);
    }
  }, [sortQuery]);

  // Reset query builder on collection change
  useEffect(() => {
    setIsQueryBuilderOpen(false);
    setRules([]);
    setProjectionRules([]);
    setSortRules([]);
    setIsQueryEnabled(true);
    setIsProjectionEnabled(true);
    setIsSortEnabled(true);
    wasOpenRef.current = false;
  }, [collectionName]);

  const syncFilterRulesFromInput = (json: string) => {
    try {
      const synced = syncRulesFromQuery(json);
      if (synced.rules.length > 0) {
        rulesRef.current = synced.rules;
        queryMatchTypeRef.current = synced.matchType;
        setRules(synced.rules);
        setQueryMatchType(synced.matchType);
        setIsQueryEnabled(true);
      } else if (json.trim() === '{}') {
        rulesRef.current = [];
        setRules([]);
        setIsQueryEnabled(false);
      }
    } catch {
      // Ignore invalid JSON while user is typing
    }
  };

  const syncProjectionRulesFromInput = (json: string) => {
    try {
      const synced = syncProjectionFromQuery(json);
      if (synced.length > 0) {
        projectionRulesRef.current = synced;
        setProjectionRules(synced);
        setIsProjectionEnabled(true);
      } else if (json.trim() === '{}') {
        projectionRulesRef.current = [];
        setProjectionRules([]);
        setIsProjectionEnabled(false);
      }
    } catch {
      // Ignore invalid JSON while user is typing
    }
  };

  const syncSortRulesFromInput = (json: string) => {
    try {
      const synced = syncSortFromQuery(json);
      if (synced.length > 0) {
        sortRulesRef.current = synced;
        setSortRules(synced);
        setIsSortEnabled(true);
      } else if (json.trim() === '{}') {
        sortRulesRef.current = [];
        setSortRules([]);
        setIsSortEnabled(false);
      }
    } catch {
      // Ignore invalid JSON while user is typing
    }
  };

  // Enable bidirectional sync after the open-render manual sync completes.
  useEffect(() => {
    if (isQueryBuilderOpen) {
      wasOpenRef.current = true;
    }
  }, [isQueryBuilderOpen]);

  // Query/Filter CRUD Handlers
  const addRule = () => {
    const newRule: VisualRule = {
      id: Math.random().toString(36).substr(2, 9),
      field: fields[0] || '_id',
      operator: '$eq',
      value: ''
    };
    const newRules = [...rulesRef.current, newRule];
    rulesRef.current = newRules;
    setRules(newRules);
    setIsQueryEnabled(true);
    setFilterQuery(compileRulesToQuery(newRules, queryMatchTypeRef.current));
  };

  const updateRule = (id: string, updates: Partial<VisualRule>) => {
    const newRules = rulesRef.current.map(r => {
      if (r.id === id) {
        const updated = { ...r, ...updates };
        if (updates.field === '__custom__') {
          updated.field = '';
        }
        if (updates.operator === '$exists' && updated.value !== 'true' && updated.value !== 'false') {
          updated.value = 'true';
        }
        return updated;
      }
      return r;
    });
    rulesRef.current = newRules;
    setRules(newRules);
    setIsQueryEnabled(true);
    setFilterQuery(compileRulesToQuery(newRules, queryMatchTypeRef.current));
  };

  const updateQueryMatchType = (newType: 'and' | 'or') => {
    queryMatchTypeRef.current = newType;
    setQueryMatchType(newType);
    setIsQueryEnabled(true);
    setFilterQuery(compileRulesToQuery(rulesRef.current, newType));
  };

  const deleteRule = (id: string) => {
    const newRules = rulesRef.current.filter(r => r.id !== id);
    rulesRef.current = newRules;
    setRules(newRules);
    setIsQueryEnabled(true);
    setFilterQuery(compileRulesToQuery(newRules, queryMatchTypeRef.current));
  };

  const clearAllRules = () => {
    rulesRef.current = [];
    setRules([]);
    setFilterQuery('{}');
  };

  // Projection CRUD Handlers
  const addProjectionRule = () => {
    const newRule: ProjectionRule = {
      id: Math.random().toString(36).substr(2, 9),
      field: fields[0] || '_id',
      include: true
    };
    const newRules = [...projectionRulesRef.current, newRule];
    projectionRulesRef.current = newRules;
    setProjectionRules(newRules);
    setIsProjectionEnabled(true);
    setProjectionQuery(compileProjectionRules(newRules));
  };

  const updateProjectionRule = (id: string, updates: Partial<ProjectionRule>) => {
    const newRules = projectionRulesRef.current.map(r => {
      if (r.id === id) {
        const updated = { ...r, ...updates };
        if (updates.field === '__custom__') {
          updated.field = '';
        }
        return updated;
      }
      return r;
    });
    projectionRulesRef.current = newRules;
    setProjectionRules(newRules);
    setIsProjectionEnabled(true);
    setProjectionQuery(compileProjectionRules(newRules));
  };

  const deleteProjectionRule = (id: string) => {
    const newRules = projectionRulesRef.current.filter(r => r.id !== id);
    projectionRulesRef.current = newRules;
    setProjectionRules(newRules);
    setIsProjectionEnabled(true);
    setProjectionQuery(compileProjectionRules(newRules));
  };

  const clearAllProjectionRules = () => {
    projectionRulesRef.current = [];
    setProjectionRules([]);
    setProjectionQuery('{}');
  };

  // Sort CRUD Handlers
  const addSortRule = () => {
    const newRule: SortRule = {
      id: Math.random().toString(36).substr(2, 9),
      field: fields[0] || '_id',
      direction: 1
    };
    const newRules = [...sortRulesRef.current, newRule];
    sortRulesRef.current = newRules;
    setSortRules(newRules);
    setIsSortEnabled(true);
    setSortQuery(compileSortRules(newRules));
  };

  const updateSortRule = (id: string, updates: Partial<SortRule>) => {
    const newRules = sortRulesRef.current.map(r => {
      if (r.id === id) {
        const updated = { ...r, ...updates };
        if (updates.field === '__custom__') {
          updated.field = '';
        }
        return updated;
      }
      return r;
    });
    sortRulesRef.current = newRules;
    setSortRules(newRules);
    setIsSortEnabled(true);
    setSortQuery(compileSortRules(newRules));
  };

  const deleteSortRule = (id: string) => {
    const newRules = sortRulesRef.current.filter(r => r.id !== id);
    sortRulesRef.current = newRules;
    setSortRules(newRules);
    setIsSortEnabled(true);
    setSortQuery(compileSortRules(newRules));
  };

  const clearAllSortRules = () => {
    sortRulesRef.current = [];
    setSortRules([]);
    setSortQuery('{}');
  };

  // Section Toggle Handlers
  const handleToggleQueryEnabled = (checked: boolean) => {
    if (checked) {
      setIsQueryEnabled(true);
      setFilterQuery(compileRulesToQuery(rulesRef.current, queryMatchTypeRef.current));
    } else {
      setFilterQuery('{}');
      setIsQueryEnabled(false);
    }
  };

  const handleToggleProjectionEnabled = (checked: boolean) => {
    if (checked) {
      setIsProjectionEnabled(true);
      setProjectionQuery(compileProjectionRules(projectionRulesRef.current));
    } else {
      setProjectionQuery('{}');
      setIsProjectionEnabled(false);
    }
  };

  const handleToggleSortEnabled = (checked: boolean) => {
    if (checked) {
      setIsSortEnabled(true);
      setSortQuery(compileSortRules(sortRulesRef.current));
    } else {
      setSortQuery('{}');
      setIsSortEnabled(false);
    }
  };

  // Flash a notification via the global toast stack
  const notify = (message: string, kind: 'success' | 'error' | 'info' = 'success') => {
    toast(message, kind);
  };

  const currentBuilderQuery = (): GeneratedQuery =>
    builderStateToQuery({ queryMode, filterQuery, sortQuery, projectionQuery, limit, skip, stages });

  const handleSaveQuery = async (alsoFavorite = false) => {
    const name = await prompt({
      title: 'Save query',
      message: 'Enter a name for this query:',
      placeholder: 'Query name',
      validate: (v) => (v.trim() ? null : 'Name is required'),
    });
    if (!name?.trim()) return;
    try {
      await saveQuery(connectionName, databaseName, collectionName, name.trim(), currentBuilderQuery());
      await refreshStoredQueries();
      if (alsoFavorite) {
        const cq = await loadCollectionQueries(connectionName, databaseName, collectionName);
        const saved = (cq.saved ?? []).find((s) => s.name === name.trim());
        if (saved) {
          toggleFavoriteItem(favoriteItems, queryFavoriteEntry(saved));
          setFavoriteItems(loadFavoriteItems());
        }
      }
      notify(alsoFavorite ? `Saved and favorited "${name.trim()}"` : `Saved "${name.trim()}"`);
    } catch (e: any) {
      notify(`Couldn't save query: ${e?.message || e}`, 'error');
    }
  };

  const handleToggleQueryFavorite = (sq: SavedQuery) => {
    setFavoriteItems((prev) => toggleFavoriteItem(prev, queryFavoriteEntry(sq)));
  };

  const handleLoadSaved = (saved: SavedQuery) => {
    handleInsertQuery(saved.query);
  };

  const handleDeleteSaved = async (id: string) => {
    try {
      await deleteSavedQuery(connectionName, databaseName, collectionName, id);
      await refreshStoredQueries();
      notify('Saved query deleted', 'success');
    } catch (e: any) {
      notify(`Couldn't delete query: ${e?.message || e}`, 'error');
    }
  };

  const handleSetDefault = async () => {
    try {
      await setDefaultQuery(connectionName, databaseName, collectionName, currentBuilderQuery());
      notify('Default query set');
    } catch (e: any) {
      notify(`Couldn't set default: ${e?.message || e}`, 'error');
    }
  };

  const handleClearDefault = async () => {
    try {
      await setDefaultQuery(connectionName, databaseName, collectionName, null);
      notify('Default query cleared');
    } catch (e: any) {
      notify(`Couldn't clear default: ${e?.message || e}`, 'error');
    }
  };

  const handleApplyHistory = (entry: HistoryEntry) => {
    handleInsertQuery(entry.query);
  };

  // Build the aggregation pipeline array from the builder's non-empty stages.
  // Shared by Run and Explain so both act on the full pipeline.
  const buildAggregatePipeline = (): Record<string, unknown>[] =>
    stages
      .filter(stage => !stage.disabled && stage.content.trim())
      .map(stage => ({ [stage.operator]: parseShellJson(stage.content) }));

  const handleRun = () => {
    setError(null);
    try {
      if (queryMode === 'find') {
        const parsedFilter = filterQuery.trim() ? parseShellJson(filterQuery) : {};
        const parsedSort = sortQuery.trim() ? parseShellJson(sortQuery) : {};
        // Only send a projection when the user has enabled one.
        const parsedProjection =
          isProjectionEnabled && projectionQuery.trim() && projectionQuery.trim() !== '{}'
            ? parseShellJson(projectionQuery)
            : {};

        onExecute({
          filter: JSON.stringify(parsedFilter),
          sort: JSON.stringify(parsedSort),
          projection: JSON.stringify(parsedProjection),
          limit: Number(limit) || 50,
          skip: Number(skip) || 0
        });
      } else if (onExecuteAggregate) {
        // Run the real pipeline so every stage ($group, $count, $unwind, …) executes,
        // rather than collapsing it down to a find().
        onExecuteAggregate(buildAggregatePipeline());
      } else {
        // Fallback (no aggregate executor wired): approximate with a find() using the
        // find-compatible stages only. Other stages are not applied.
        let compiledFilter = {};
        let compiledSort = {};
        let compiledLimit = 50;
        let compiledSkip = 0;

        stages.forEach(stage => {
          if (stage.disabled || !stage.content.trim()) return;
          const body = parseShellJson(stage.content);
          if (stage.operator === '$match') {
            compiledFilter = { ...compiledFilter, ...body };
          } else if (stage.operator === '$sort') {
            compiledSort = { ...compiledSort, ...body };
          } else if (stage.operator === '$limit') {
            compiledLimit = Number(body) || compiledLimit;
          } else if (stage.operator === '$skip') {
            compiledSkip = Number(body) || compiledSkip;
          }
        });

        onExecute({
          filter: JSON.stringify(compiledFilter),
          sort: JSON.stringify(compiledSort),
          projection: '{}',
          limit: compiledLimit,
          skip: compiledSkip
        });
      }
    } catch (e: any) {
      setError(`Invalid JSON syntax: ${e.message}`);
    }
  };

  const buildShellCommand = () => {
    const dbRef = `db.${collectionRef(collectionName)}`;

    if (queryMode === 'aggregate') {
      const pipeline = stages
        .filter((stage) => !stage.disabled && stage.content.trim())
        .map((stage) => {
          try {
            return { [stage.operator]: parseShellJson(stage.content) };
          } catch {
            return { [stage.operator]: stage.content };
          }
        });
      return `${dbRef}.aggregate(${JSON.stringify(pipeline.length ? pipeline : [{ $match: {} }], null, 2)})`;
    }

    let parsedFilter: unknown = {};
    let parsedProjection: unknown = {};
    let parsedSort: unknown = {};
    try { parsedFilter = filterQuery.trim() ? parseShellJson(filterQuery) : {}; } catch { parsedFilter = filterQuery; }
    try { parsedProjection = projectionQuery.trim() ? parseShellJson(projectionQuery) : {}; } catch { parsedProjection = projectionQuery; }
    try { parsedSort = sortQuery.trim() ? parseShellJson(sortQuery) : {}; } catch { parsedSort = sortQuery; }

    const projectionPart =
      parsedProjection && typeof parsedProjection === 'object' && Object.keys(parsedProjection as Record<string, unknown>).length > 0
        ? `, ${JSON.stringify(parsedProjection)}`
        : '';
    const sortPart =
      parsedSort && typeof parsedSort === 'object' && Object.keys(parsedSort as Record<string, unknown>).length > 0
        ? `.sort(${JSON.stringify(parsedSort)})`
        : '';

    return `${dbRef}.find(${JSON.stringify(parsedFilter)}${projectionPart})${sortPart}.skip(${Number(skip) || 0}).limit(${Number(limit) || 50})`;
  };

  const handleExplain = async () => {
    setError(null);
    setExplainLoading(true);
    try {
      if (queryMode === 'find') {
        const parsedFilter = filterQuery.trim() ? parseShellJson(filterQuery) : {};
        await onExplain(JSON.stringify(parsedFilter));
      } else if (onExplainAggregate) {
        // Explain the FULL pipeline (M1), not just a collapsed $match.
        await onExplainAggregate(JSON.stringify(buildAggregatePipeline()));
      } else {
        // Fallback (no aggregate explainer wired): approximate with the $match stages.
        let compiledFilter = {};
        stages.forEach(stage => {
          if (!stage.disabled && stage.operator === '$match' && stage.content.trim()) {
            try {
              const body = parseShellJson(stage.content);
              compiledFilter = { ...compiledFilter, ...body };
            } catch {
              // Ignore invalid JSON inside match stage during explain preview
            }
          }
        });
        await onExplain(JSON.stringify(compiledFilter));
      }
    } catch (e: any) {
      setError(e.message || String(e));
    } finally {
      setExplainLoading(false);
    }
  };

  const handleClearField = (field: 'filter' | 'projection' | 'sort') => {
    if (field === 'filter') setFilterQuery('{}');
    if (field === 'projection') setProjectionQuery('{}');
    if (field === 'sort') setSortQuery('{}');
    notify(`Cleared ${field} parameters`);
  };

  const queryColClass = (invalid: boolean) =>
    cn(
      'flex min-w-0 flex-1 items-center border-r border-border bg-input/80 transition-colors last:border-r-0',
      'focus-within:z-[1] focus-within:bg-input focus-within:ring-1 focus-within:ring-inset',
      invalid ? 'focus-within:ring-destructive' : 'focus-within:ring-primary'
    );

  const fieldBadgeClass = (invalid: boolean) =>
    cn(
      'flex h-7 min-w-[90px] shrink-0 select-none items-center justify-end border-r border-border px-2.5 text-[9.5px] font-bold uppercase tracking-wider',
      invalid ? 'bg-destructive/5 text-destructive' : 'bg-muted/40 text-muted-foreground'
    );

  const workspaceRightPanel = isQueryBuilderOpen
    ? 'query-builder'
    : isAIHelperOpen
      ? 'ai-helper'
      : 'none';

  const workspaceDefaultLayout = useMemo((): Layout => {
    if (workspaceRightPanel === 'query-builder') {
      return { 'document-main': 70, 'query-builder': 30 };
    }
    if (workspaceRightPanel === 'ai-helper') {
      return { 'document-main': 70, 'ai-helper': 30 };
    }
    return { 'document-main': 100 };
  }, [workspaceRightPanel]);

  return (
    <div className="relative flex h-full min-h-0 flex-col min-w-0">
      
      {/* 1. Breadcrumbs Bar */}
      <div className="flex select-none items-center justify-between border-b border-border bg-muted/30 px-3.5 py-1.5 text-xs text-muted-foreground">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <div className={cn('inline-flex items-center gap-1', connectionUser ? 'text-primary' : 'text-muted-foreground')}>
            <User size={12} className="shrink-0" />
            <span
              className={cn('truncate font-semibold', !connectionUser && 'italic')}
              title={connectionUser ? `Authenticated as ${connectionUser}` : 'Connection has no authentication'}
            >
              {connectionUser || 'no auth'}
            </span>
          </div>
          <ChevronRight size={10} className="shrink-0 text-muted-foreground" />

          <div className="inline-flex items-center gap-1 text-foreground">
            <Server size={12} className="shrink-0 text-primary" />
            <span className="truncate font-mono font-medium" title={connectionName}>{connectionName}</span>
          </div>
          <ChevronRight size={10} className="shrink-0 text-muted-foreground" />

          <div className="inline-flex items-center gap-1 text-foreground">
            <Database size={12} className="shrink-0 text-warning" />
            <span className="truncate font-semibold" title={databaseName}>{databaseName}</span>
          </div>
          <ChevronRight size={10} className="shrink-0 text-muted-foreground" />

          <div className="inline-flex items-center gap-1 text-foreground">
            <Layers size={12} className="shrink-0 text-success" />
            <span className="truncate font-mono font-medium" title={collectionName}>{collectionName}</span>
          </div>
        </div>
      </div>

      {/* 2. Toolbar */}
      <div className="flex select-none flex-wrap items-center justify-between gap-2 border-b border-border bg-card/50 px-3.5 py-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <div className="flex overflow-hidden rounded-md shadow-sm">
            <Button
              onClick={handleRun}
              disabled={loading || explainLoading}
              size="sm"
              className="h-7 rounded-r-none px-2.5 text-[11px]"
              title="Execute query (Ctrl/⌘ + Enter)"
            >
              <Play size={11} fill="currentColor" />
              Run
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  disabled={loading || explainLoading}
                  size="sm"
                  variant="default"
                  className="h-7 rounded-l-none border-l border-primary-foreground/20 px-1.5"
                >
                  <ChevronDown size={10} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-[120px]">
                <DropdownMenuItem onClick={handleRun}>
                  <Play size={11} />
                  Run Query
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleExplain}>
                  <Cpu size={11} />
                  Run Explain
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-7 gap-1.5 text-[11px]">
                <FolderOpen size={11} className="text-primary" />
                Load query
                <ChevronDown size={10} className="text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-[200px]" data-testid="load-query-dropdown">
              {savedQueries.length === 0 ? (
                <DropdownMenuItem disabled>No saved queries</DropdownMenuItem>
              ) : (
                savedQueries.map((sq) => (
                  <DropdownMenuItem
                    key={sq.id}
                    className="justify-between"
                    data-testid={`saved-query-${sq.id}`}
                    onSelect={(e) => {
                      e.preventDefault();
                      handleLoadSaved(sq);
                    }}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <FolderOpen size={11} className="shrink-0" />{' '}
                      <span className="truncate">{sq.name}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-0.5">
                      <Button
                        variant="ghost"
                        size="icon"
                        className={cn(
                          'h-6 w-6',
                          isQueryFavorited(sq) ? 'text-rose-500 hover:text-rose-500' : 'text-muted-foreground',
                        )}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleToggleQueryFavorite(sq);
                        }}
                        data-testid={`favorite-saved-${sq.id}`}
                        title={isQueryFavorited(sq) ? 'Remove from favorites' : 'Add to favorites'}
                      >
                        <Heart size={11} className={isQueryFavorited(sq) ? 'fill-current' : ''} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-destructive hover:text-destructive"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteSaved(sq.id);
                        }}
                        data-testid={`delete-saved-${sq.id}`}
                        title="Delete saved query"
                      >
                        <Trash2 size={11} />
                      </Button>
                    </span>
                  </DropdownMenuItem>
                ))
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-7 gap-1.5 text-[11px]">
                <Save size={11} className="text-primary" />
                Save query
                <ChevronDown size={10} className="text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-[150px]">
              <DropdownMenuItem onClick={() => void handleSaveQuery(false)} data-testid="save-query-item">
                <Save size={11} />
                Save as new query...
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => void handleSaveQuery(true)}
                data-testid="save-favorite-query-item"
              >
                <Heart size={11} />
                Save and add to favorites
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-7 gap-1.5 text-[11px]" data-testid="history-btn">
                <History size={11} className="text-warning" />
                Query history
                <ChevronDown size={10} className="text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-[260px]" data-testid="history-dropdown">
              {queryHistory.length === 0 ? (
                <DropdownMenuItem disabled>No history yet</DropdownMenuItem>
              ) : (
                queryHistory.map((h, i) => (
                  <DropdownMenuItem
                    key={i}
                    data-testid={`history-item-${i}`}
                    onClick={() => handleApplyHistory(h)}
                  >
                    <History size={11} />
                    <span className="truncate">
                      {h.query.queryType === 'aggregate'
                        ? `aggregate · ${(h.query.pipeline ?? []).length} stage(s)`
                        : `find · ${JSON.stringify(h.query.filter ?? {})}`}
                    </span>
                  </DropdownMenuItem>
                ))
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-7 gap-1.5 text-[11px]">
                <Anchor size={11} className="text-chart-4" />
                Set default query
                <ChevronDown size={10} className="text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-[200px]">
              <DropdownMenuItem onClick={handleSetDefault} data-testid="set-default-item">
                <Check size={11} />
                Pin current query as default
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleClearDefault} data-testid="clear-default-item">
                <Trash2 size={11} />
                Clear default
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-7 gap-1.5 text-[11px]">
                <ExternalLink size={11} className="text-muted-foreground" />
                Open query in...
                <ChevronDown size={10} className="text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[180px]">
              <DropdownMenuItem
                onClick={() => {
                  const shellCommand = buildShellCommand();
                  if (onOpenShell) {
                    onOpenShell(shellCommand);
                    notify('Opened query in mongosh', 'info');
                  } else {
                    navigator.clipboard?.writeText(shellCommand);
                    notify('Copied mongosh command', 'success');
                  }
                }}
              >
                <ExternalLink size={11} />
                Open in mongosh
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="flex items-center gap-1.5">
          {onOpenExport && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onOpenExport}
              className="h-7 gap-1.5 text-[11px]"
              data-testid="export-btn"
              title="Open export workspace"
            >
              <Download size={11} />
              Export
            </Button>
          )}
          {onImport && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onImport}
              className="h-7 gap-1.5 text-[11px]"
              data-testid="import-btn"
              title="Import documents from a file"
            >
              <Upload size={11} />
              Import
            </Button>
          )}
          <Button
            variant={isAIHelperOpen ? 'secondary' : 'outline'}
            size="sm"
            onClick={() => {
              const newOpen = !isAIHelperOpen;
              setIsAIHelperOpen(newOpen);
              if (newOpen) setIsQueryBuilderOpen(false);
            }}
            className={cn('h-7 gap-1.5 text-[11px]', isAIHelperOpen && 'border-primary text-primary')}
            data-testid="toggle-ai-helper"
          >
            <Sparkles size={11} className="text-primary" />
            <span className="font-semibold text-primary">AI Helper</span>
          </Button>

          <Button
            variant={isQueryBuilderOpen ? 'secondary' : 'outline'}
            size="sm"
            onClick={() => {
              const newOpen = !isQueryBuilderOpen;
              setIsQueryBuilderOpen(newOpen);
              if (newOpen) {
                setIsAIHelperOpen(false);
                const syncedQuery = syncRulesFromQuery(filterQuery);
                const initialRules = syncedQuery.rules.length > 0 ? syncedQuery.rules : [{
                  id: Math.random().toString(36).substr(2, 9),
                  field: fields[0] || '_id',
                  operator: '$eq',
                  value: ''
                }];
                rulesRef.current = initialRules;
                queryMatchTypeRef.current = syncedQuery.matchType;
                setRules(initialRules);
                setQueryMatchType(syncedQuery.matchType);
                setIsQueryEnabled(true);
                const syncedProj = syncProjectionFromQuery(projectionQuery);
                projectionRulesRef.current = syncedProj;
                setProjectionRules(syncedProj);
                setIsProjectionEnabled(true);
                const syncedSort = syncSortFromQuery(sortQuery);
                sortRulesRef.current = syncedSort;
                setSortRules(syncedSort);
                setIsSortEnabled(true);
                wasOpenRef.current = false;
              } else {
                wasOpenRef.current = false;
              }
            }}
            className={cn('h-7 gap-1.5 text-[11px]', isQueryBuilderOpen && 'border-primary text-primary')}
            data-testid="toggle-query-builder"
          >
            <DatabaseZap size={11} className="text-success" />
            Visual Query Builder
          </Button>
        </div>
      </div>

      {/* 3. Main Workspace Split Area */}
      <ResizablePanelGroup
        id="document-viewer-workspace"
        orientation="horizontal"
        defaultLayout={workspaceDefaultLayout}
        className="min-h-0 min-w-0 flex-1"
      >
        <ResizablePanel id="document-main" minSize="30%" className="flex min-h-0 flex-col">
        <div className="flex h-full min-h-0 min-w-0 flex-col">
            <div className="shrink-0">
            <div className="flex gap-0.5 border-b border-border bg-muted/20 px-3.5 pt-1.5">
              <button
                type="button"
                onClick={() => setQueryMode('find')}
                className={cn(
                  'border-b-2 px-3 py-1.5 text-[11.5px] font-semibold transition-colors',
                  queryMode === 'find' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
                )}
              >
                Find
              </button>
              <button
                type="button"
                data-testid="mode-aggregate-tab"
                onClick={() => setQueryMode('aggregate')}
                className={cn(
                  'border-b-2 px-3 py-1.5 text-[11.5px] font-semibold transition-colors',
                  queryMode === 'aggregate' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
                )}
              >
                Aggregation
              </button>
            </div>

          {queryMode === 'find' ? (
            <div className="shrink-0">
            <div className="flex flex-col border-b border-border bg-muted/20">
                <div className="flex w-full border-b border-border">
                  <div className={queryColClass(!isFilterValid)}>
                    <span className={fieldBadgeClass(!isFilterValid)}>Query</span>
                    <QueryEditor
                      singleLine
                      surface="filter"
                      onRun={handleRun}
                      value={filterQuery}
                      onChange={(v) => {
                        setFilterQuery(v);
                        if (isQueryBuilderOpen) {
                          syncFilterRulesFromInput(v);
                        }
                      }}
                      fields={fields}
                      schema={schema}
                      data-testid="query-filter-input"
                    />
                    {!isFilterValid && (
                      <span className="inline-flex shrink-0 items-center gap-1 pr-1.5 font-mono text-[10px] text-destructive whitespace-nowrap">
                        <AlertCircle size={10} /> Invalid JSON
                      </span>
                    )}
                    <Button variant="ghost" size="icon" className="mr-1 h-6 w-6 shrink-0" onClick={() => handleClearField('filter')} title="Clear Filter">
                      <Eraser size={11} />
                    </Button>
                  </div>
                </div>

                <div className="flex w-full border-b border-border">
                  <div className={queryColClass(!isProjectionValid)}>
                    <span className={fieldBadgeClass(!isProjectionValid)}>Projection</span>
                    <QueryEditor
                      singleLine
                      surface="projection"
                      onRun={handleRun}
                      value={projectionQuery}
                      onChange={(v) => {
                        setProjectionQuery(v);
                        if (isQueryBuilderOpen) {
                          syncProjectionRulesFromInput(v);
                        }
                      }}
                      fields={fields}
                      schema={schema}
                      data-testid="projection-query-input"
                    />
                    {!isProjectionValid && (
                      <span className="inline-flex shrink-0 items-center gap-1 pr-1.5 font-mono text-[10px] text-destructive whitespace-nowrap">
                        <AlertCircle size={10} /> Invalid JSON
                      </span>
                    )}
                    <Button variant="ghost" size="icon" className="mr-1 h-6 w-6 shrink-0" onClick={() => handleClearField('projection')} title="Clear Projection">
                      <Eraser size={11} />
                    </Button>
                  </div>

                  <div className={queryColClass(!isSortValid)}>
                    <span className={fieldBadgeClass(!isSortValid)}>Sort</span>
                    <QueryEditor
                      singleLine
                      surface="sort"
                      onRun={handleRun}
                      value={sortQuery}
                      onChange={(v) => {
                        setSortQuery(v);
                        if (isQueryBuilderOpen) {
                          syncSortRulesFromInput(v);
                        }
                      }}
                      fields={fields}
                      schema={schema}
                      data-testid="sort-query-input"
                    />
                    {!isSortValid && (
                      <span className="inline-flex shrink-0 items-center gap-1 pr-1.5 font-mono text-[10px] text-destructive whitespace-nowrap">
                        <AlertCircle size={10} /> Invalid JSON
                      </span>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="mr-0.5 h-6 w-6 shrink-0 text-warning"
                      onClick={() => {
                        if (sortQuery === '{}') setSortQuery('{"_id": -1}');
                        else if (sortQuery === '{"_id": -1}') setSortQuery('{"_id": 1}');
                        else setSortQuery('{}');
                      }}
                      title="Quick Sort Direction"
                    >
                      <ArrowUpDown size={11} />
                    </Button>
                    <Button variant="ghost" size="icon" className="mr-1 h-6 w-6 shrink-0" onClick={() => handleClearField('sort')} title="Clear Sort">
                      <Eraser size={11} />
                    </Button>
                  </div>
                </div>

                <div className="flex w-full">
                  <div className={queryColClass(false)}>
                    <span className={fieldBadgeClass(false)}>Skip</span>
                    <Input
                      type="number"
                      value={skip}
                      onChange={(e) => setSkip(e.target.value)}
                      placeholder="0"
                      min="0"
                      className="h-7 flex-1 min-w-0 border-0 bg-transparent px-2.5 font-mono text-[11.5px] shadow-none focus-visible:ring-0"
                    />
                    {skip !== '0' && skip !== '' && (
                      <Button variant="ghost" size="icon" className="mr-1 h-6 w-6 shrink-0" onClick={() => setSkip('0')} title="Reset Skip">
                        <Eraser size={11} />
                      </Button>
                    )}
                  </div>

                  <div className={queryColClass(false)}>
                    <span className={fieldBadgeClass(false)}>Limit</span>
                    <Input
                      type="number"
                      value={limit}
                      onChange={(e) => setLimit(e.target.value)}
                      placeholder="50"
                      min="1"
                      className="h-7 flex-1 min-w-0 border-0 bg-transparent px-2.5 font-mono text-[11.5px] shadow-none focus-visible:ring-0"
                    />
                    {limit !== '50' && limit !== '' && (
                      <Button variant="ghost" size="icon" className="mr-1 h-6 w-6 shrink-0" onClick={() => setLimit('50')} title="Reset Limit">
                        <Eraser size={11} />
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ) : (
          <div className="shrink-0" data-testid="aggregation-pipeline-editor">
            <div className="flex max-h-[min(380px,42vh)] flex-col overflow-hidden border-b border-border bg-muted/20">
              <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
                <Badge variant="outline" className="font-mono text-[10px]">
                  {stages.length} stage{stages.length !== 1 ? 's' : ''}
                </Badge>
                <Button variant="outline" size="sm" onClick={addStage} className="h-7 gap-1 text-[11px]">
                  <Plus size={11} />
                  Add Stage
                </Button>
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={undoStages} disabled={stagesPast.current.length === 0} aria-label="Undo pipeline change" title="Undo pipeline change">
                  <Undo2 size={11} />
                </Button>
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={redoStages} disabled={stagesFuture.current.length === 0} aria-label="Redo pipeline change" title="Redo pipeline change">
                  <Redo2 size={11} />
                </Button>
                <div className="flex-grow" />
              </header>

            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
              <div className="flex flex-col gap-0 p-3 [&>*]:shrink-0">
                {stages.map((stage, index) => {
                  const isValid = checkIsValidJson(stage.content);
                  return (
                    // Keyed by position, NOT stage.id: with id keys a reorder makes
                    // React move the mounted Monaco editor's DOM subtree, which
                    // crashes Monaco's scheduled renders ("this.domNode.domNode").
                    // With index keys a reorder is just a value-prop update.
                    <React.Fragment key={index}>
                      <div
                        className={cn(
                          'overflow-hidden rounded-md border border-border bg-background transition-colors',
                          !isValid && 'border-destructive ring-1 ring-destructive',
                          stage.disabled && 'is-disabled opacity-55',
                          'focus-within:border-primary focus-within:ring-1 focus-within:ring-primary'
                        )}
                        data-testid={`pipeline-stage-${index}`}
                        onDragOver={(e) => {
                          if (dragStageIndex === null) return;
                          e.preventDefault();
                          e.dataTransfer.dropEffect = 'move';
                        }}
                        onDrop={(e) => { e.preventDefault(); dropStageAt(index); }}
                      >
                        <div
                          className="flex cursor-grab items-center gap-1.5 border-b border-border bg-muted/30 px-2 py-1.5 active:cursor-grabbing"
                          draggable
                          onDragStart={(e) => {
                            e.dataTransfer.setData('text/plain', String(index));
                            e.dataTransfer.effectAllowed = 'move';
                            setDragStageIndex(index);
                          }}
                          onDragEnd={() => setDragStageIndex(null)}
                        >
                          <GripVertical size={11} className="shrink-0 text-muted-foreground" aria-hidden="true" />
                          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => toggleStageCollapsed(stage.id)} aria-label={stage.collapsed ? `Expand stage ${index + 1}` : `Collapse stage ${index + 1}`} title={stage.collapsed ? `Expand stage ${index + 1}` : `Collapse stage ${index + 1}`}>
                            {stage.collapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
                          </Button>
                          <span className="inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded bg-accent text-[10px] text-muted-foreground">{index + 1}</span>
                          <div className="relative inline-flex items-center">
                            <select
                              value={stage.operator}
                              onChange={(e) => updateStageOperator(stage.id, e.target.value)}
                              className="cursor-pointer appearance-none border-0 bg-transparent py-0.5 pl-1 pr-4 font-mono text-xs font-semibold text-chart-4 outline-none"
                            >
                              {STAGE_OPERATORS.map(({ group, stages: groupStages }) => (
                                <optgroup key={group} label={group}>
                                  {groupStages.map(op => (
                                    <option key={op} value={op}>{op}</option>
                                  ))}
                                </optgroup>
                              ))}
                            </select>
                            <ChevronDown size={10} className="pointer-events-none absolute right-0.5 text-muted-foreground" />
                          </div>
                          <div className="flex-grow" />
                          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => runToStage(index)} disabled={loading || stage.disabled} title={`Run pipeline to stage ${index + 1}`} aria-label={`Run pipeline to stage ${index + 1}`}>
                            <Play size={11} />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => toggleStageDisabled(stage.id)} title={stage.disabled ? `Enable stage ${index + 1}` : `Disable stage ${index + 1}`} aria-label={stage.disabled ? `Enable stage ${index + 1}` : `Disable stage ${index + 1}`}>
                            {stage.disabled ? <EyeOff size={11} /> : <Eye size={11} />}
                          </Button>
                          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => moveStageUp(index)} disabled={index === 0} aria-label={`Move stage ${index + 1} up`}>
                            <ChevronUp size={11} />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => moveStageDown(index)} disabled={index === stages.length - 1} aria-label={`Move stage ${index + 1} down`}>
                            <ChevronDown size={11} />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive hover:text-destructive" onClick={() => removeStage(stage.id)} aria-label={`Remove stage ${index + 1}`}>
                            <Trash2 size={11} />
                          </Button>
                        </div>
                        {stage.operator === '$lookup' && !stage.collapsed && (
                          <div className="grid grid-cols-4 gap-1.5 border-b border-border bg-muted/20 p-2" data-testid={`lookup-form-${index}`}>
                            {(['from', 'localField', 'foreignField', 'as'] as const).map((key) => (
                              <label key={key} className="flex min-w-0 flex-col gap-0.5">
                                <span className="text-[9px] font-bold uppercase tracking-wide text-muted-foreground">{key}</span>
                                <Input
                                  value={lookupFieldValue(stage, key)}
                                  onChange={(e) => updateLookupField(stage.id, key, e.target.value)}
                                  aria-label={`$lookup ${key}`}
                                  className="h-[22px] font-mono text-[11px]"
                                />
                              </label>
                            ))}
                          </div>
                        )}
                        {!stage.collapsed && (
                          <QueryEditor
                            surface="aggStage"
                            stageOperator={stage.operator}
                            onRun={handleRun}
                            value={stage.content}
                            onChange={(v) => updateStageContent(stage.id, v)}
                            fields={fields}
                            schema={schema}
                            height={120}
                          />
                        )}
                      </div>
                      {index < stages.length - 1 && (
                        <div className="flex justify-center py-0.5 text-muted-foreground">
                          <ChevronDown size={12} />
                        </div>
                      )}
                    </React.Fragment>
                  );
                })}
              </div>
            </div>
            </div>
          </div>
          )}

            </div>

          <DocumentViewerContext.Provider value={{ handleExplain, explainLoading }}>
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              {children}
            </div>
          </DocumentViewerContext.Provider>

          {error && (
            <div className="flex shrink-0 select-text items-center gap-2 border-t border-border bg-destructive/10 px-3 py-2 font-mono text-ui-xs text-destructive">
              <AlertCircle size={13} className="shrink-0 text-destructive" />
              <span>{error}</span>
            </div>
          )}
        </div>
        </ResizablePanel>

        {isQueryBuilderOpen && (
          <>
            <ResizableHandle withHandle data-testid="query-builder-resizer" />
            <ResizablePanel id="query-builder" minSize="18%" maxSize="50%" className="flex min-h-0 flex-col">
            <div className="flex h-full min-h-0 w-full flex-col border-l border-border bg-card" data-testid="query-builder-panel">
            <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2">
              <div className="flex items-center gap-1.5 text-[11px] font-semibold text-foreground">
                <DatabaseZap size={11} className="text-success" />
                <span>Visual Query Builder</span>
              </div>
              <div className="flex items-center gap-2">
                {(rules.length > 0 || projectionRules.length > 0 || sortRules.length > 0) && (
                  <button
                    onClick={() => {
                      clearAllRules();
                      clearAllProjectionRules();
                      clearAllSortRules();
                    }}
                    className="text-[10px] text-muted-foreground transition-colors hover:text-destructive"
                  >
                    Clear All
                  </button>
                )}
                <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setIsQueryBuilderOpen(false)} title="Close Panel">
                  <X size={12} />
                </Button>
              </div>
            </div>

            <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-2 p-3">
              
              {/* Card 1: Query (Filter) */}
              <div className="rounded-md border border-border bg-background" data-testid="query-card">
                <div className="flex items-center justify-between border-b border-border px-2 py-2">
                  <label className="flex cursor-pointer items-center gap-1.5 text-[11px] font-semibold">
                    <input
                      type="checkbox"
                      checked={isQueryEnabled}
                      onChange={() => handleToggleQueryEnabled(!isQueryEnabled)}
                      className="h-3.5 w-3.5 rounded border-border accent-primary"
                      data-testid="query-enable-checkbox"
                    />
                    <span>Query</span>
                  </label>
                  {isQueryEnabled && rules.length > 0 && (
                    <select
                      value={queryMatchType}
                      onChange={(e) => updateQueryMatchType(e.target.value as 'and' | 'or')}
                      className="h-7 max-w-[130px] rounded-md border border-border bg-background px-1 text-[10px]"
                      data-testid="query-match-type"
                    >
                      <option value="and">Match All ($and)</option>
                      <option value="or">Match Any ($or)</option>
                    </select>
                  )}
                </div>
                {isQueryEnabled && (
                  <div className="p-2">
                    {rules.length === 0 ? (
                      <div
                        onClick={addRule}
                        className="cursor-pointer rounded-md border border-dashed border-border px-3 py-4 text-center text-[11px] text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
                        data-testid="query-dropzone"
                      >
                        <span>+ Click to add query rules</span>
                      </div>
                    ) : (
                      <div className="flex flex-col gap-2">
                        {rules.map((rule) => {
                          const isCustomField = rule.field === '__custom__' || !fields.includes(rule.field);
                          return (
                            <div key={rule.id} className="flex items-center gap-1.5 rounded-md border border-border bg-muted/20 p-1.5" data-testid={`query-rule-${rule.id}`}>
                              {/* Field selector */}
                              {isCustomField ? (
                                <div className="flex items-center gap-1 flex-1 min-w-0">
                                  <input 
                                    type="text"
                                    value={rule.field === '__custom__' ? '' : rule.field}
                                    onChange={(e) => updateRule(rule.id, { field: e.target.value })}
                                    placeholder="field.path"
                                    className="h-7 min-w-0 flex-1 font-mono text-[11px]"
                                    data-testid={`rule-field-custom-${rule.id}`}
                                  />
                                  {fields.length > 0 && (
                                    <button 
                                      onClick={() => updateRule(rule.id, { field: fields[0] })}
                                      className="shrink-0 text-[10px] text-primary hover:underline"
                                    >
                                      List
                                    </button>
                                  )}
                                </div>
                              ) : (
                                <select
                                  value={rule.field}
                                  onChange={(e) => updateRule(rule.id, { field: e.target.value })}
                                  className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-[11px]"
                                  data-testid={`rule-field-${rule.id}`}
                                >
                                  {fields.map(f => (
                                    <option key={f} value={f}>{f}</option>
                                  ))}
                                  <option value="__custom__">Custom field...</option>
                                </select>
                              )}

                              {/* Operator selector */}
                              <select
                                value={rule.operator}
                                onChange={(e) => updateRule(rule.id, { operator: e.target.value })}
                                className="h-7 w-[65px] shrink-0 rounded-md border border-border bg-background px-2 text-[11px]"
                                data-testid={`rule-operator-${rule.id}`}
                              >
                                {OPERATORS.map(op => (
                                  <option key={op.value} value={op.value}>{op.label}</option>
                                ))}
                              </select>

                              {/* Value input */}
                              {rule.operator === '$exists' ? (
                                <select
                                  value={rule.value}
                                  onChange={(e) => updateRule(rule.id, { value: e.target.value })}
                                  className="h-7 w-[65px] shrink-0 rounded-md border border-border bg-background px-2 text-[11px]"
                                  data-testid={`rule-value-exists-${rule.id}`}
                                >
                                  <option value="true">true</option>
                                  <option value="false">false</option>
                                </select>
                              ) : (
                                <input 
                                  type="text"
                                  value={rule.value}
                                  onChange={(e) => updateRule(rule.id, { value: e.target.value })}
                                  placeholder="value"
                                  className="h-7 min-w-0 flex-1 font-mono text-[11px]"
                                  data-testid={`rule-value-${rule.id}`}
                                />
                              )}

                              {/* Delete button */}
                              <button 
                                onClick={() => deleteRule(rule.id)}
                                className="p-1 rounded text-muted-foreground transition-colors hover:bg-accent hover:text-destructive"
                                title="Remove Rule"
                              >
                                <Trash2 size={11} />
                              </button>
                            </div>
                          );
                        })}
                        <Button variant="outline" size="sm" onClick={addRule} className="h-7 w-full gap-1 text-[11px]" data-testid="query-add-rule-btn">
                          <Plus size={11} />
                          <span>Add Rule</span>
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Card 2: Projection */}
              <div className="rounded-md border border-border bg-background" data-testid="projection-card">
                <div className="flex items-center justify-between border-b border-border px-2 py-2">
                  <label className="flex cursor-pointer items-center gap-1.5 text-[11px] font-semibold">
                    <input
                      type="checkbox"
                      checked={isProjectionEnabled}
                      onChange={() => handleToggleProjectionEnabled(!isProjectionEnabled)}
                      className="h-3.5 w-3.5 rounded border-border accent-primary"
                      data-testid="projection-enable-checkbox"
                    />
                    <span>Projection</span>
                  </label>
                </div>
                {isProjectionEnabled && (
                  <div className="p-2">
                    {projectionRules.length === 0 ? (
                      <div
                        onClick={addProjectionRule}
                        className="cursor-pointer rounded-md border border-dashed border-border px-3 py-4 text-center text-[11px] text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
                        data-testid="projection-dropzone"
                      >
                        <span>+ Click to add projection criteria</span>
                      </div>
                    ) : (
                      <div className="flex flex-col gap-2">
                        {projectionRules.map((rule) => {
                          const isCustomField = rule.field === '__custom__' || !fields.includes(rule.field);
                          return (
                            <div key={rule.id} className="flex items-center gap-1.5 rounded-md border border-border bg-muted/20 p-1.5" data-testid={`projection-rule-${rule.id}`}>
                              {/* Field selector */}
                              {isCustomField ? (
                                <div className="flex items-center gap-1 flex-1 min-w-0">
                                  <input 
                                    type="text"
                                    value={rule.field === '__custom__' ? '' : rule.field}
                                    onChange={(e) => updateProjectionRule(rule.id, { field: e.target.value })}
                                    placeholder="field.path"
                                    className="h-7 min-w-0 flex-1 font-mono text-[11px]"
                                    data-testid={`projection-field-custom-${rule.id}`}
                                  />
                                  {fields.length > 0 && (
                                    <button 
                                      onClick={() => updateProjectionRule(rule.id, { field: fields[0] })}
                                      className="shrink-0 text-[10px] text-primary hover:underline"
                                    >
                                      List
                                    </button>
                                  )}
                                </div>
                              ) : (
                                <select
                                  value={rule.field}
                                  onChange={(e) => updateProjectionRule(rule.id, { field: e.target.value })}
                                  className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-[11px]"
                                  data-testid={`projection-field-${rule.id}`}
                                >
                                  {fields.map(f => (
                                    <option key={f} value={f}>{f}</option>
                                  ))}
                                  <option value="__custom__">Custom field...</option>
                                </select>
                              )}

                              {/* Inclusion/Exclusion toggle */}
                              <select
                                value={rule.include ? '1' : '0'}
                                onChange={(e) => updateProjectionRule(rule.id, { include: e.target.value === '1' })}
                                className="h-7 w-[100px] shrink-0 rounded-md border border-border bg-background px-2 text-[11px]"
                                data-testid={`projection-include-${rule.id}`}
                              >
                                <option value="1">Include (1)</option>
                                <option value="0">Exclude (0)</option>
                              </select>

                              <div className="flex-grow" />

                              {/* Delete button */}
                              <button 
                                onClick={() => deleteProjectionRule(rule.id)}
                                className="p-1 rounded text-muted-foreground transition-colors hover:bg-accent hover:text-destructive"
                                title="Remove Rule"
                              >
                                <Trash2 size={11} />
                              </button>
                            </div>
                          );
                        })}
                        <Button variant="outline" size="sm" onClick={addProjectionRule} className="h-7 w-full gap-1 text-[11px]" data-testid="projection-add-rule-btn">
                          <Plus size={11} />
                          <span>Add Projection</span>
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Card 3: Sort */}
              <div className="rounded-md border border-border bg-background" data-testid="sort-card">
                <div className="flex items-center justify-between border-b border-border px-2 py-2">
                  <label className="flex cursor-pointer items-center gap-1.5 text-[11px] font-semibold">
                    <input
                      type="checkbox"
                      checked={isSortEnabled}
                      onChange={() => handleToggleSortEnabled(!isSortEnabled)}
                      className="h-3.5 w-3.5 rounded border-border accent-primary"
                      data-testid="sort-enable-checkbox"
                    />
                    <span>Sort</span>
                  </label>
                </div>
                {isSortEnabled && (
                  <div className="p-2">
                    {sortRules.length === 0 ? (
                      <div
                        onClick={addSortRule}
                        className="cursor-pointer rounded-md border border-dashed border-border px-3 py-4 text-center text-[11px] text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
                        data-testid="sort-dropzone"
                      >
                        <span>+ Click to add sort criteria</span>
                      </div>
                    ) : (
                      <div className="flex flex-col gap-2">
                        {sortRules.map((rule) => {
                          const isCustomField = rule.field === '__custom__' || !fields.includes(rule.field);
                          return (
                            <div key={rule.id} className="flex items-center gap-1.5 rounded-md border border-border bg-muted/20 p-1.5" data-testid={`sort-rule-${rule.id}`}>
                              {/* Field selector */}
                              {isCustomField ? (
                                <div className="flex items-center gap-1 flex-1 min-w-0">
                                  <input 
                                    type="text"
                                    value={rule.field === '__custom__' ? '' : rule.field}
                                    onChange={(e) => updateSortRule(rule.id, { field: e.target.value })}
                                    placeholder="field.path"
                                    className="h-7 min-w-0 flex-1 font-mono text-[11px]"
                                    data-testid={`sort-field-custom-${rule.id}`}
                                  />
                                  {fields.length > 0 && (
                                    <button 
                                      onClick={() => updateSortRule(rule.id, { field: fields[0] })}
                                      className="shrink-0 text-[10px] text-primary hover:underline"
                                    >
                                      List
                                    </button>
                                  )}
                                </div>
                              ) : (
                                <select
                                  value={rule.field}
                                  onChange={(e) => updateSortRule(rule.id, { field: e.target.value })}
                                  className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-[11px]"
                                  data-testid={`sort-field-${rule.id}`}
                                >
                                  {fields.map(f => (
                                    <option key={f} value={f}>{f}</option>
                                  ))}
                                  <option value="__custom__">Custom field...</option>
                                </select>
                              )}

                              {/* Direction selector */}
                              <select
                                value={rule.direction}
                                onChange={(e) => updateSortRule(rule.id, { direction: Number(e.target.value) as 1 | -1 })}
                                className="h-7 w-[75px] shrink-0 rounded-md border border-border bg-background px-2 text-[11px]"
                                data-testid={`sort-direction-${rule.id}`}
                              >
                                <option value="1">Asc (1)</option>
                                <option value="-1">Desc (-1)</option>
                              </select>

                              <div className="flex-grow" />

                              {/* Delete button */}
                              <button 
                                onClick={() => deleteSortRule(rule.id)}
                                className="p-1 rounded text-muted-foreground transition-colors hover:bg-accent hover:text-destructive"
                                title="Remove Rule"
                              >
                                <Trash2 size={11} />
                              </button>
                            </div>
                          );
                        })}
                        <Button variant="outline" size="sm" onClick={addSortRule} className="h-7 w-full gap-1 text-[11px]" data-testid="sort-add-rule-btn">
                          <Plus size={11} />
                          <span>Add Sort Field</span>
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </div>

            </div>
            </ScrollArea>

            <div className="flex shrink-0 justify-end border-t border-border bg-card p-2">
              <Button onClick={handleRun} disabled={loading} size="sm" className="h-7 text-[11px]">
                Apply
              </Button>
            </div>
            </div>
            </ResizablePanel>
          </>
        )}

        {isAIHelperOpen && (
          <>
            <ResizableHandle withHandle data-testid="ai-helper-resizer" />
            <ResizablePanel id="ai-helper" minSize="18%" maxSize="50%" className="flex min-h-0 flex-col">
              <AIChatPanel
                variant="editor"
                embedded
                databaseName={databaseName}
                collectionName={collectionName}
                fields={availableFields}
                isOpen={isAIHelperOpen}
                onClose={() => setIsAIHelperOpen(false)}
                onInsertQuery={handleInsertQuery}
                onInsertAndRunQuery={handleInsertAndRunQuery}
              />
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
    </div>
  );
};
