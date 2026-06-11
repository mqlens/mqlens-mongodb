import React, { useState, useEffect } from 'react';
import { AIChatPanel } from './AIChatPanel';
import { QueryEditor } from './QueryEditor';
import { useCollectionSchema } from '../lib/useCollectionSchema';
import { collectionRef, type GeneratedQuery } from '../lib/mongoCommand';
import {
  loadCollectionQueries,
  saveQuery,
  deleteSavedQuery,
  setDefaultQuery,
  type SavedQuery,
  type HistoryEntry,
} from '../lib/queryStore';
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
  X
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

interface BuilderState {
  queryMode: 'find' | 'aggregate';
  filterQuery: string;
  sortQuery: string;
  projectionQuery: string;
  limit: string;
  skip: string;
  stages: { id: string; operator: string; content: string }[];
}

// Serialize the current builder state into a GeneratedQuery — the same value
// handleRun executes — so Save/Default capture exactly what would run.
// Invalid JSON degrades to {} (find) or a dropped stage (aggregate).
export function builderStateToQuery(state: BuilderState): GeneratedQuery {
  const parse = (s: string): unknown => {
    try {
      return s.trim() ? JSON.parse(s) : {};
    } catch {
      return {};
    }
  };
  if (state.queryMode === 'aggregate') {
    const pipeline = state.stages
      .filter((stage) => stage.content.trim())
      .map((stage) => ({ [stage.operator]: JSON.parse(stage.content) }));
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
    const query = JSON.parse(jsonStr);
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
    const query = JSON.parse(jsonStr);
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
    const query = JSON.parse(jsonStr);
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
  children
}) => {
  const { schema } = useCollectionSchema(connectionId, databaseName, collectionName);
  const [filterQuery, setFilterQuery] = useState('{}');
  const [projectionQuery, setProjectionQuery] = useState('{}');
  const [sortQuery, setSortQuery] = useState('{}');
  const [limit, setLimit] = useState('50');
  const [skip, setSkip] = useState('0');
  const [explainLoading, setExplainLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notification, setNotification] = useState<string | null>(null);
  const [savedQueries, setSavedQueries] = useState<SavedQuery[]>([]);
  const [queryHistory, setQueryHistory] = useState<HistoryEntry[]>([]);

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
  const [queryMode, setQueryMode] = useState<'find' | 'aggregate'>('find');
  
  // Aggregation stages state
  interface PipelineStage {
    id: string;
    operator: string;
    content: string;
  }
  const [stages, setStages] = useState<PipelineStage[]>([
    { id: 'stage-1', operator: '$match', content: '{\n  \n}' }
  ]);

  // AI chat assistant — open/close only; the panel owns its own chat state.
  const [isAIHelperOpen, setIsAIHelperOpen] = useState(false);

  const addStage = () => {
    const newStage = {
      id: `stage-${Math.random().toString(36).substr(2, 9)}`,
      operator: '$match',
      content: '{\n  \n}'
    };
    setStages(prev => [...prev, newStage]);
  };

  const removeStage = (id: string) => {
    setStages(prev => prev.filter(s => s.id !== id));
  };

  const updateStageOperator = (id: string, operator: string) => {
    setStages(prev => prev.map(s => s.id === id ? { ...s, operator } : s));
  };

  const updateStageContent = (id: string, content: string) => {
    setStages(prev => prev.map(s => s.id === id ? { ...s, content } : s));
  };

  const moveStageUp = (index: number) => {
    if (index === 0) return;
    setStages(prev => {
      const next = [...prev];
      const temp = next[index];
      next[index] = next[index - 1];
      next[index - 1] = temp;
      return next;
    });
  };

  const moveStageDown = (index: number) => {
    setStages(prev => {
      if (index === prev.length - 1) return prev;
      const next = [...prev];
      const temp = next[index];
      next[index] = next[index + 1];
      next[index + 1] = temp;
      return next;
    });
  };

  // Build pipeline stages ({id, operator, content}) from a MongoDB pipeline array.
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

  // Apply a generated query to the editor; auto-switch to aggregation mode for pipelines.
  const handleInsertQuery = (query: GeneratedQuery) => {
    if (query.queryType === 'aggregate') {
      const pipeline = query.pipeline && query.pipeline.length > 0 ? query.pipeline : [{ $match: {} }];
      setStages(stagesFromPipeline(pipeline));
      setQueryMode('aggregate');
      triggerNotification('Aggregation pipeline applied');
    } else {
      setFilterQuery(JSON.stringify(query.filter ?? {}, null, 2));
      setSortQuery(JSON.stringify(query.sort ?? {}, null, 2));
      if (query.projection !== undefined) {
        setProjectionQuery(JSON.stringify(query.projection ?? {}, null, 2));
      }
      setQueryMode('find');
      triggerNotification('Query applied to editor');
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

  const [queryBuilderWidth, setQueryBuilderWidth] = useState(340);
  const [isResizingQueryBuilder, setIsResizingQueryBuilder] = useState(false);

  const startResizingQueryBuilder = (mouseDownEvent: React.MouseEvent) => {
    mouseDownEvent.preventDefault();
    setIsResizingQueryBuilder(true);
  };

  useEffect(() => {
    const handleMouseMove = (mouseMoveEvent: MouseEvent) => {
      if (!isResizingQueryBuilder) return;
      const newWidth = window.innerWidth - mouseMoveEvent.clientX;
      if (newWidth >= 240 && newWidth <= 600) {
        setQueryBuilderWidth(newWidth);
      }
    };

    const handleMouseUp = () => {
      setIsResizingQueryBuilder(false);
    };

    if (isResizingQueryBuilder) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizingQueryBuilder]);

  const fields = availableFields.length > 0 ? availableFields : ['_id'];

  // Validation states
  const [isFilterValid, setIsFilterValid] = useState(true);
  const [isProjectionValid, setIsProjectionValid] = useState(true);
  const [isSortValid, setIsSortValid] = useState(true);

  // Dropdown states
  const [activeDropdown, setActiveDropdown] = useState<string | null>(null);

  useEffect(() => {
    try {
      if (filterQuery.trim()) {
        JSON.parse(filterQuery);
      }
      setIsFilterValid(true);
    } catch {
      setIsFilterValid(false);
    }
  }, [filterQuery]);

  useEffect(() => {
    try {
      if (projectionQuery.trim()) {
        JSON.parse(projectionQuery);
      }
      setIsProjectionValid(true);
    } catch {
      setIsProjectionValid(false);
    }
  }, [projectionQuery]);

  useEffect(() => {
    try {
      if (sortQuery.trim()) {
        JSON.parse(sortQuery);
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

  // Synchronize Filter/Query
  useEffect(() => {
    if (isQueryBuilderOpen && wasOpenRef.current) {
      if (!isQueryEnabled && filterQuery.trim() === '{}') {
        return;
      }
      try {
        const parsedCurrent = JSON.parse(filterQuery);
        const compiledCurrent = JSON.parse(compileRulesToQuery(rules, queryMatchType));
        if (JSON.stringify(parsedCurrent) !== JSON.stringify(compiledCurrent)) {
          const synced = syncRulesFromQuery(filterQuery);
          if (synced.rules.length > 0) {
            setRules(synced.rules);
            setQueryMatchType(synced.matchType);
            setIsQueryEnabled(true);
          } else if (filterQuery.trim() === '{}') {
            setRules([]);
            setIsQueryEnabled(false);
          }
        }
      } catch {
        // Ignore invalid JSON while user is typing
      }
    }
  }, [filterQuery, isQueryBuilderOpen, rules, queryMatchType, isQueryEnabled]);

  // Synchronize Projection
  useEffect(() => {
    if (isQueryBuilderOpen && wasOpenRef.current) {
      if (!isProjectionEnabled && projectionQuery.trim() === '{}') {
        return;
      }
      try {
        const parsedCurrent = JSON.parse(projectionQuery);
        const compiledCurrent = JSON.parse(compileProjectionRules(projectionRules));
        if (JSON.stringify(parsedCurrent) !== JSON.stringify(compiledCurrent)) {
          const synced = syncProjectionFromQuery(projectionQuery);
          if (synced.length > 0) {
            setProjectionRules(synced);
            setIsProjectionEnabled(true);
          } else if (projectionQuery.trim() === '{}') {
            setProjectionRules([]);
            setIsProjectionEnabled(false);
          }
        }
      } catch {
        // Ignore invalid JSON
      }
    }
  }, [projectionQuery, isQueryBuilderOpen, projectionRules, isProjectionEnabled]);

  // Synchronize Sort
  useEffect(() => {
    if (isQueryBuilderOpen && wasOpenRef.current) {
      if (!isSortEnabled && sortQuery.trim() === '{}') {
        return;
      }
      try {
        const parsedCurrent = JSON.parse(sortQuery);
        const compiledCurrent = JSON.parse(compileSortRules(sortRules));
        if (JSON.stringify(parsedCurrent) !== JSON.stringify(compiledCurrent)) {
          const synced = syncSortFromQuery(sortQuery);
          if (synced.length > 0) {
            setSortRules(synced);
            setIsSortEnabled(true);
          } else if (sortQuery.trim() === '{}') {
            setSortRules([]);
            setIsSortEnabled(false);
          }
        }
      } catch {
        // Ignore invalid JSON
      }
    }
  }, [sortQuery, isQueryBuilderOpen, sortRules, isSortEnabled]);

  // Update wasOpenRef at the end of the render/effects cycle
  useEffect(() => {
    wasOpenRef.current = isQueryBuilderOpen;
  }, [isQueryBuilderOpen]);

  // Query/Filter CRUD Handlers
  const addRule = () => {
    const newRule: VisualRule = {
      id: Math.random().toString(36).substr(2, 9),
      field: fields[0] || '_id',
      operator: '$eq',
      value: ''
    };
    const newRules = [...rules, newRule];
    setRules(newRules);
    setIsQueryEnabled(true);
    setFilterQuery(compileRulesToQuery(newRules, queryMatchType));
  };

  const updateRule = (id: string, updates: Partial<VisualRule>) => {
    const newRules = rules.map(r => {
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
    setRules(newRules);
    setIsQueryEnabled(true);
    setFilterQuery(compileRulesToQuery(newRules, queryMatchType));
  };

  const updateQueryMatchType = (newType: 'and' | 'or') => {
    setQueryMatchType(newType);
    setIsQueryEnabled(true);
    setFilterQuery(compileRulesToQuery(rules, newType));
  };

  const deleteRule = (id: string) => {
    const newRules = rules.filter(r => r.id !== id);
    setRules(newRules);
    setIsQueryEnabled(true);
    setFilterQuery(compileRulesToQuery(newRules, queryMatchType));
  };

  const clearAllRules = () => {
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
    const newRules = [...projectionRules, newRule];
    setProjectionRules(newRules);
    setIsProjectionEnabled(true);
    setProjectionQuery(compileProjectionRules(newRules));
  };

  const updateProjectionRule = (id: string, updates: Partial<ProjectionRule>) => {
    const newRules = projectionRules.map(r => {
      if (r.id === id) {
        const updated = { ...r, ...updates };
        if (updates.field === '__custom__') {
          updated.field = '';
        }
        return updated;
      }
      return r;
    });
    setProjectionRules(newRules);
    setIsProjectionEnabled(true);
    setProjectionQuery(compileProjectionRules(newRules));
  };

  const deleteProjectionRule = (id: string) => {
    const newRules = projectionRules.filter(r => r.id !== id);
    setProjectionRules(newRules);
    setIsProjectionEnabled(true);
    setProjectionQuery(compileProjectionRules(newRules));
  };

  const clearAllProjectionRules = () => {
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
    const newRules = [...sortRules, newRule];
    setSortRules(newRules);
    setIsSortEnabled(true);
    setSortQuery(compileSortRules(newRules));
  };

  const updateSortRule = (id: string, updates: Partial<SortRule>) => {
    const newRules = sortRules.map(r => {
      if (r.id === id) {
        const updated = { ...r, ...updates };
        if (updates.field === '__custom__') {
          updated.field = '';
        }
        return updated;
      }
      return r;
    });
    setSortRules(newRules);
    setIsSortEnabled(true);
    setSortQuery(compileSortRules(newRules));
  };

  const deleteSortRule = (id: string) => {
    const newRules = sortRules.filter(r => r.id !== id);
    setSortRules(newRules);
    setIsSortEnabled(true);
    setSortQuery(compileSortRules(newRules));
  };

  const clearAllSortRules = () => {
    setSortRules([]);
    setSortQuery('{}');
  };

  // Section Toggle Handlers
  const handleToggleQueryEnabled = (checked: boolean) => {
    setIsQueryEnabled(checked);
    if (checked) {
      setFilterQuery(compileRulesToQuery(rules, queryMatchType));
    } else {
      setFilterQuery('{}');
    }
  };

  const handleToggleProjectionEnabled = (checked: boolean) => {
    setIsProjectionEnabled(checked);
    if (checked) {
      setProjectionQuery(compileProjectionRules(projectionRules));
    } else {
      setProjectionQuery('{}');
    }
  };

  const handleToggleSortEnabled = (checked: boolean) => {
    setIsSortEnabled(checked);
    if (checked) {
      setSortQuery(compileSortRules(sortRules));
    } else {
      setSortQuery('{}');
    }
  };

  // Flash a notification toast
  const triggerNotification = (message: string) => {
    setNotification(message);
    setTimeout(() => {
      setNotification((prev) => (prev === message ? null : prev));
    }, 3000);
  };

  const currentBuilderQuery = (): GeneratedQuery =>
    builderStateToQuery({ queryMode, filterQuery, sortQuery, projectionQuery, limit, skip, stages });

  const handleSaveQuery = async () => {
    const name = window.prompt('Save query as:')?.trim();
    if (!name) return;
    try {
      await saveQuery(connectionName, databaseName, collectionName, name, currentBuilderQuery());
      await refreshStoredQueries();
      triggerNotification(`Saved "${name}"`);
    } catch (e: any) {
      triggerNotification(`Couldn't save query: ${e?.message || e}`);
    }
  };

  const handleLoadSaved = (saved: SavedQuery) => {
    handleInsertQuery(saved.query);
    setActiveDropdown(null);
  };

  const handleDeleteSaved = async (id: string) => {
    try {
      await deleteSavedQuery(connectionName, databaseName, collectionName, id);
      await refreshStoredQueries();
    } catch (e: any) {
      triggerNotification(`Couldn't delete query: ${e?.message || e}`);
    }
  };

  const handleSetDefault = async () => {
    try {
      await setDefaultQuery(connectionName, databaseName, collectionName, currentBuilderQuery());
      triggerNotification('Default query set');
    } catch (e: any) {
      triggerNotification(`Couldn't set default: ${e?.message || e}`);
    }
    setActiveDropdown(null);
  };

  const handleClearDefault = async () => {
    try {
      await setDefaultQuery(connectionName, databaseName, collectionName, null);
      triggerNotification('Default query cleared');
    } catch (e: any) {
      triggerNotification(`Couldn't clear default: ${e?.message || e}`);
    }
    setActiveDropdown(null);
  };

  const handleApplyHistory = (entry: HistoryEntry) => {
    handleInsertQuery(entry.query);
    setActiveDropdown(null);
  };

  // Build the aggregation pipeline array from the builder's non-empty stages.
  // Shared by Run and Explain so both act on the full pipeline.
  const buildAggregatePipeline = (): Record<string, unknown>[] =>
    stages
      .filter(stage => stage.content.trim())
      .map(stage => ({ [stage.operator]: JSON.parse(stage.content) }));

  const handleRun = () => {
    setError(null);
    try {
      if (queryMode === 'find') {
        const parsedFilter = filterQuery.trim() ? JSON.parse(filterQuery) : {};
        const parsedSort = sortQuery.trim() ? JSON.parse(sortQuery) : {};
        // Only send a projection when the user has enabled one.
        const parsedProjection =
          isProjectionEnabled && projectionQuery.trim() && projectionQuery.trim() !== '{}'
            ? JSON.parse(projectionQuery)
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
          if (!stage.content.trim()) return;
          const body = JSON.parse(stage.content);
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
        .filter((stage) => stage.content.trim())
        .map((stage) => {
          try {
            return { [stage.operator]: JSON.parse(stage.content) };
          } catch {
            return { [stage.operator]: stage.content };
          }
        });
      return `${dbRef}.aggregate(${JSON.stringify(pipeline.length ? pipeline : [{ $match: {} }], null, 2)})`;
    }

    let parsedFilter: unknown = {};
    let parsedProjection: unknown = {};
    let parsedSort: unknown = {};
    try { parsedFilter = filterQuery.trim() ? JSON.parse(filterQuery) : {}; } catch { parsedFilter = filterQuery; }
    try { parsedProjection = projectionQuery.trim() ? JSON.parse(projectionQuery) : {}; } catch { parsedProjection = projectionQuery; }
    try { parsedSort = sortQuery.trim() ? JSON.parse(sortQuery) : {}; } catch { parsedSort = sortQuery; }

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
        const parsedFilter = filterQuery.trim() ? JSON.parse(filterQuery) : {};
        await onExplain(JSON.stringify(parsedFilter));
      } else if (onExplainAggregate) {
        // Explain the FULL pipeline (M1), not just a collapsed $match.
        await onExplainAggregate(JSON.stringify(buildAggregatePipeline()));
      } else {
        // Fallback (no aggregate explainer wired): approximate with the $match stages.
        let compiledFilter = {};
        stages.forEach(stage => {
          if (stage.operator === '$match' && stage.content.trim()) {
            try {
              const body = JSON.parse(stage.content);
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
    triggerNotification(`Cleared ${field} parameters`);
  };

  const toggleDropdown = (dropdownName: string) => {
    setActiveDropdown((prev) => (prev === dropdownName ? null : dropdownName));
  };

  // Close active dropdowns on window click
  useEffect(() => {
    const handleOutsideClick = () => setActiveDropdown(null);
    window.addEventListener('click', handleOutsideClick);
    return () => window.removeEventListener('click', handleOutsideClick);
  }, []);

  return (
    <div className="flex-grow flex flex-col min-h-0 min-w-0 relative">
      
      {/* 1. Breadcrumbs Bar */}
      <div className="mql-breadcrumbs">
        <div className="mql-bc-group">
          <div
            className="mql-bc-item"
            style={{ color: connectionUser ? 'var(--accent-blue)' : 'var(--text-dim)' }}
          >
            <User size={12} className="flex-shrink-0" />
            <span
              className="truncate font-medium"
              style={{ fontWeight: 600, fontStyle: connectionUser ? 'normal' : 'italic' }}
              title={connectionUser ? `Authenticated as ${connectionUser}` : 'Connection has no authentication'}
            >
              {connectionUser || 'no auth'}
            </span>
          </div>
          <ChevronRight size={10} className="text-[var(--text-dim)] flex-shrink-0" />

          <div className="mql-bc-item">
            <Server size={12} className="text-[var(--accent-blue)] flex-shrink-0" />
            <span className="truncate font-mono font-medium" title={connectionName}>{connectionName}</span>
          </div>
          <ChevronRight size={10} className="text-[var(--text-dim)] flex-shrink-0" />

          <div className="mql-bc-item">
            <Database size={12} className="text-amber-500 flex-shrink-0" />
            <span className="truncate font-semibold" title={databaseName}>{databaseName}</span>
          </div>
          <ChevronRight size={10} className="text-[var(--text-dim)] flex-shrink-0" />

          <div className="mql-bc-item">
            <Layers size={12} className="text-[var(--accent-green)] flex-shrink-0" />
            <span className="truncate font-mono font-medium" title={collectionName}>{collectionName}</span>
          </div>
        </div>

        {notification && (
          <div className="mql-notif">
            {notification}
          </div>
        )}
      </div>

      {/* 2. Toolbar */}
      <div className="mql-toolbar">
        <div className="flex items-center gap-1.5 flex-wrap">
          
          {/* Run Button */}
          <div className="relative" onClick={(e) => e.stopPropagation()}>
            <div className="query-plane-btn-group">
              <button
                onClick={handleRun}
                disabled={loading || explainLoading}
                className="query-plane-btn query-plane-btn-primary"
                title="Execute query (Ctrl/⌘ + Enter)"
              >
                <Play size={11} fill="white" />
                <span>Run</span>
              </button>
              <button
                onClick={() => toggleDropdown('run')}
                disabled={loading || explainLoading}
                className="query-plane-btn-caret"
              >
                <ChevronDown size={10} />
              </button>
            </div>
            {activeDropdown === 'run' && (
              <div className="query-plane-dropdown min-w-[120px]">
                <div 
                  className="query-plane-dropdown-item"
                  onClick={() => {
                    handleRun();
                    setActiveDropdown(null);
                  }}
                >
                  <Play size={11} />
                  <span>Run Query</span>
                </div>
                <div 
                  className="query-plane-dropdown-item"
                  onClick={() => {
                    handleExplain();
                    setActiveDropdown(null);
                  }}
                >
                  <Cpu size={11} />
                  <span>Run Explain</span>
                </div>
              </div>
            )}
          </div>

          {/* Load Query */}
          <div className="relative" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => toggleDropdown('load')} className="query-plane-btn">
              <FolderOpen size={11} className="text-sky-500" />
              <span>Load query</span>
              <ChevronDown size={10} className="text-[var(--text-dim)]" />
            </button>
            {activeDropdown === 'load' && (
              <div className="query-plane-dropdown min-w-[200px]" data-testid="load-query-dropdown">
                {savedQueries.length === 0 ? (
                  <div className="query-plane-dropdown-item-disabled">No saved queries</div>
                ) : (
                  savedQueries.map((sq) => (
                    <div key={sq.id} className="query-plane-dropdown-item" data-testid={`saved-query-${sq.id}`}>
                      <span style={{ flexGrow: 1 }} onClick={() => handleLoadSaved(sq)}>
                        <FolderOpen size={11} /> {sq.name}
                      </span>
                      <button
                        className="query-plane-icon-btn text-rose-400"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteSaved(sq.id);
                        }}
                        data-testid={`delete-saved-${sq.id}`}
                        title="Delete saved query"
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>

          {/* Save Query */}
          <div className="relative" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => toggleDropdown('save')} className="query-plane-btn">
              <Save size={11} className="text-[var(--accent-blue)]" />
              <span>Save query</span>
              <ChevronDown size={10} className="text-[var(--text-dim)]" />
            </button>
            {activeDropdown === 'save' && (
              <div className="query-plane-dropdown min-w-[150px]">
                <div
                  className="query-plane-dropdown-item"
                  onClick={() => {
                    handleSaveQuery();
                    setActiveDropdown(null);
                  }}
                  data-testid="save-query-item"
                >
                  <Save size={11} />
                  <span>Save as new query...</span>
                </div>
              </div>
            )}
          </div>

          {/* Query History */}
          <div className="relative" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => toggleDropdown('history')} className="query-plane-btn" data-testid="history-btn">
              <History size={11} className="text-amber-500" />
              <span>Query history</span>
              <ChevronDown size={10} className="text-[var(--text-dim)]" />
            </button>
            {activeDropdown === 'history' && (
              <div className="query-plane-dropdown min-w-[260px]" data-testid="history-dropdown">
                {queryHistory.length === 0 ? (
                  <div className="query-plane-dropdown-item-disabled">No history yet</div>
                ) : (
                  queryHistory.map((h, i) => (
                    <div
                      key={i}
                      className="query-plane-dropdown-item"
                      data-testid={`history-item-${i}`}
                      onClick={() => handleApplyHistory(h)}
                    >
                      <History size={11} />
                      <span className="truncate">
                        {h.query.queryType === 'aggregate'
                          ? `aggregate · ${(h.query.pipeline ?? []).length} stage(s)`
                          : `find · ${JSON.stringify(h.query.filter ?? {})}`}
                      </span>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>

          {/* Set Default Query */}
          <div className="relative" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => toggleDropdown('default')} className="query-plane-btn">
              <Anchor size={11} className="text-purple-400" />
              <span>Set default query</span>
              <ChevronDown size={10} className="text-[var(--text-dim)]" />
            </button>
            {activeDropdown === 'default' && (
              <div className="query-plane-dropdown min-w-[200px]">
                <div
                  className="query-plane-dropdown-item"
                  onClick={handleSetDefault}
                  data-testid="set-default-item"
                >
                  <Check size={11} />
                  <span>Pin current query as default</span>
                </div>
                <div
                  className="query-plane-dropdown-item"
                  onClick={handleClearDefault}
                  data-testid="clear-default-item"
                >
                  <Trash2 size={11} />
                  <span>Clear default</span>
                </div>
              </div>
            )}
          </div>

          {/* Open Query in... */}
          <div className="relative" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => toggleDropdown('openin')} className="query-plane-btn">
              <ExternalLink size={11} className="text-[var(--text-muted)]" />
              <span>Open query in...</span>
              <ChevronDown size={10} className="text-[var(--text-dim)]" />
            </button>
            {activeDropdown === 'openin' && (
              <div className="query-plane-dropdown query-plane-dropdown-right min-w-[180px]">
                <div 
                  className="query-plane-dropdown-item"
                  onClick={() => {
                    const shellCommand = buildShellCommand();
                    if (onOpenShell) {
                      onOpenShell(shellCommand);
                      triggerNotification("Opened query in mongosh");
                    } else {
                      navigator.clipboard?.writeText(shellCommand);
                      triggerNotification("Copied mongosh command");
                    }
                    setActiveDropdown(null);
                  }}
                >
                  <ExternalLink size={11} />
                  <span>Open in mongosh</span>
                </div>
              </div>
            )}
          </div>

        </div>

        {/* AI Helper & Visual query builder */}
        <div className="flex items-center gap-1.5">
          {onOpenExport && (
            <button
              type="button"
              onClick={onOpenExport}
              className="query-plane-btn"
              data-testid="export-btn"
              title="Open export workspace"
            >
              <Download size={11} />
              <span>Export</span>
            </button>
          )}
          {onImport && (
            <button
              type="button"
              onClick={onImport}
              className="query-plane-btn"
              data-testid="import-btn"
              title="Import documents from a file"
            >
              <Upload size={11} />
              <span>Import</span>
            </button>
          )}
          <button
            onClick={() => {
              const newOpen = !isAIHelperOpen;
              setIsAIHelperOpen(newOpen);
              if (newOpen) {
                setIsQueryBuilderOpen(false);
              }
            }}
            className={`query-plane-btn ${isAIHelperOpen ? 'bg-[var(--bg-item-active)] border-[var(--accent-blue)] text-[var(--accent-blue)]' : ''}`}
            data-testid="toggle-ai-helper"
          >
            <Sparkles size={11} className="text-[var(--accent-blue)]" />
            <span className="font-semibold text-[var(--accent-blue)]">AI Helper</span>
          </button>
          
          <button 
            onClick={() => {
              const newOpen = !isQueryBuilderOpen;
              setIsQueryBuilderOpen(newOpen);
              if (newOpen) {
                setIsAIHelperOpen(false);
                const syncedQuery = syncRulesFromQuery(filterQuery);
                setRules(syncedQuery.rules.length > 0 ? syncedQuery.rules : [{
                  id: Math.random().toString(36).substr(2, 9),
                  field: fields[0] || '_id',
                  operator: '$eq',
                  value: ''
                }]);
                setQueryMatchType(syncedQuery.matchType);
                setIsQueryEnabled(true);

                const syncedProj = syncProjectionFromQuery(projectionQuery);
                setProjectionRules(syncedProj);
                setIsProjectionEnabled(true);

                const syncedSort = syncSortFromQuery(sortQuery);
                setSortRules(syncedSort);
                setIsSortEnabled(true);

                wasOpenRef.current = false;
              }
            }}
            className={`query-plane-btn ${isQueryBuilderOpen ? 'bg-[var(--bg-item-active)] border-[var(--accent-blue)] text-[var(--accent-blue)]' : ''}`}
            data-testid="toggle-query-builder"
          >
            <DatabaseZap size={11} className="text-emerald-500" />
            <span>Visual Query Builder</span>
          </button>
        </div>
      </div>

      {/* 3. Main Workspace Split Area */}
      <div className="flex-grow flex items-stretch min-h-0 min-w-0">
        
        {/* Left Side: Inputs Card and DataGrid children */}
        <div className="flex-1 flex flex-col min-h-0 min-w-0">
          {/* Query Mode Switcher */}
          <div className="mql-qmode">
            <button 
              className={`mql-qmode-tab ${queryMode === 'find' ? 'is-active' : ''}`}
              onClick={() => setQueryMode('find')}
            >
              Find
            </button>
            <button 
              className={`mql-qmode-tab ${queryMode === 'aggregate' ? 'is-active' : ''}`}
              onClick={() => setQueryMode('aggregate')}
              data-testid="mode-aggregate-tab"
            >
              Aggregation
            </button>
          </div>

          {queryMode === 'find' ? (
            <div className="query-plane-grid flex-shrink-0">
              <div className="mql-qcard">
                {/* Row 1: Query (Filter) */}
                <div className="mql-qrow">
                  <div className={`mql-qcol ${!isFilterValid ? 'is-invalid' : ''}`}>
                    <div className="mql-qbadge">Query</div>
                    <QueryEditor
                      singleLine
                      surface="filter"
                      onRun={handleRun}
                      value={filterQuery}
                      onChange={setFilterQuery}
                      fields={fields}
                      schema={schema}
                      className="mql-qinput"
                      data-testid="query-filter-input"
                    />
                    {!isFilterValid && (
                      <span className="mql-invalid-pill">
                        <AlertCircle size={10} /> Invalid JSON
                      </span>
                    )}
                    <button 
                      onClick={() => handleClearField('filter')}
                      className="query-plane-icon-btn mr-1"
                      title="Clear Filter"
                    >
                      <Eraser size={11} />
                    </button>
                  </div>
                </div>

                {/* Row 2: Projection & Sort */}
                <div className="mql-qrow">
                  {/* Projection */}
                  <div className={`mql-qcol ${!isProjectionValid ? 'is-invalid' : ''}`}>
                    <div className="mql-qbadge">Projection</div>
                    <QueryEditor
                      singleLine
                      surface="projection"
                      onRun={handleRun}
                      value={projectionQuery}
                      onChange={setProjectionQuery}
                      fields={fields}
                      schema={schema}
                      className="mql-qinput"
                      data-testid="projection-query-input"
                    />
                    {!isProjectionValid && (
                      <span className="mql-invalid-pill">
                        <AlertCircle size={10} /> Invalid JSON
                      </span>
                    )}
                    <button 
                      onClick={() => handleClearField('projection')}
                      className="query-plane-icon-btn mr-1"
                      title="Clear Projection"
                    >
                      <Eraser size={11} />
                    </button>
                  </div>

                  {/* Sort */}
                  <div className={`mql-qcol ${!isSortValid ? 'is-invalid' : ''}`}>
                    <div className="mql-qbadge">Sort</div>
                    <QueryEditor
                      singleLine
                      surface="sort"
                      onRun={handleRun}
                      value={sortQuery}
                      onChange={setSortQuery}
                      fields={fields}
                      schema={schema}
                      className="mql-qinput"
                      data-testid="sort-query-input"
                    />
                    {!isSortValid && (
                      <span className="mql-invalid-pill">
                        <AlertCircle size={10} /> Invalid JSON
                      </span>
                    )}
                    <button 
                      onClick={() => {
                        if (sortQuery === '{}') setSortQuery('{"_id": -1}');
                        else if (sortQuery === '{"_id": -1}') setSortQuery('{"_id": 1}');
                        else setSortQuery('{}');
                      }}
                      className="query-plane-icon-btn mr-0.5 text-amber-500"
                      title="Quick Sort Direction"
                    >
                      <ArrowUpDown size={11} />
                    </button>
                    <button 
                      onClick={() => handleClearField('sort')}
                      className="query-plane-icon-btn mr-1"
                      title="Clear Sort"
                    >
                      <Eraser size={11} />
                    </button>
                  </div>
                </div>

                {/* Row 3: Skip & Limit */}
                <div className="mql-qrow">
                  {/* Skip */}
                  <div className="mql-qcol">
                    <div className="mql-qbadge">Skip</div>
                    <input
                      type="number"
                      value={skip}
                      onChange={(e) => setSkip(e.target.value)}
                      placeholder="0"
                      min="0"
                      className="mql-qinput"
                    />
                    {skip !== '0' && skip !== '' && (
                      <button 
                        onClick={() => setSkip('0')}
                        className="query-plane-icon-btn mr-1"
                        title="Reset Skip"
                      >
                        <Eraser size={11} />
                      </button>
                    )}
                  </div>

                  {/* Limit */}
                  <div className="mql-qcol">
                    <div className="mql-qbadge">Limit</div>
                    <input
                      type="number"
                      value={limit}
                      onChange={(e) => setLimit(e.target.value)}
                      placeholder="50"
                      min="1"
                      className="mql-qinput"
                    />
                    {limit !== '50' && limit !== '' && (
                      <button 
                        onClick={() => setLimit('50')}
                        className="query-plane-icon-btn mr-1"
                        title="Reset Limit"
                      >
                        <Eraser size={11} />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            /* Aggregation Pipeline Mode */
            <div className="mql-pipeline flex-shrink-0" data-testid="aggregation-pipeline-editor">
              <header className="mql-pipeline-h">
                <span className="mql-pipeline-count">{stages.length} stage{stages.length !== 1 ? 's' : ''}</span>
                <button 
                  onClick={addStage}
                  className="query-plane-btn"
                  style={{ border: '1px solid var(--border-color)', padding: '2px 8px' }}
                >
                  <Plus size={11} />
                  <span>Add Stage</span>
                </button>
                <div style={{ flexGrow: 1 }} />
              </header>

              <div className="mql-pipeline-stages">
                {stages.map((stage, index) => {
                  const isValid = checkIsValidJson(stage.content);
                  return (
                    <React.Fragment key={stage.id}>
                      <div className={`mql-stage ${!isValid ? 'is-invalid' : ''}`} data-testid={`pipeline-stage-${index}`}>
                        <div className="mql-stage-h">
                          <span className="mql-stage-num">{index + 1}</span>
                          <div className="mql-stage-op-wrap">
                            <select
                              value={stage.operator}
                              onChange={(e) => updateStageOperator(stage.id, e.target.value)}
                              className="mql-stage-op"
                            >
                              {STAGE_OPERATORS.map(({ group, stages: groupStages }) => (
                                <optgroup key={group} label={group}>
                                  {groupStages.map(op => (
                                    <option key={op} value={op}>{op}</option>
                                  ))}
                                </optgroup>
                              ))}
                            </select>
                            <ChevronDown size={10} className="mql-stage-op-caret text-[var(--text-dim)]" />
                          </div>
                          <div style={{ flexGrow: 1 }} />
                          <button onClick={() => moveStageUp(index)} disabled={index === 0} className="query-plane-icon-btn">
                            <ChevronUp size={11} />
                          </button>
                          <button onClick={() => moveStageDown(index)} disabled={index === stages.length - 1} className="query-plane-icon-btn">
                            <ChevronDown size={11} />
                          </button>
                          <button onClick={() => removeStage(stage.id)} className="query-plane-icon-btn text-rose-400">
                            <Trash2 size={11} />
                          </button>
                        </div>
                        <QueryEditor
                          surface="aggStage"
                          onRun={handleRun}
                          value={stage.content}
                          onChange={(v) => updateStageContent(stage.id, v)}
                          fields={fields}
                          schema={schema}
                          height={120}
                        />
                      </div>
                      {index < stages.length - 1 && (
                        <div className="mql-pipeline-flow">
                          <ChevronDown size={12} />
                        </div>
                      )}
                    </React.Fragment>
                  );
                })}
              </div>
            </div>
          )}

          {/* Children results pane */}
          <DocumentViewerContext.Provider value={{ handleExplain, explainLoading }}>
            {children}
          </DocumentViewerContext.Provider>

          {/* Error Info or Explain Plan Panel */}
          {error && (
            <div className="bg-rose-950/20 border-t border-[var(--border-color)] p-2 px-3 text-rose-400 text-[11px] flex items-center gap-2 font-mono select-text flex-shrink-0">
              <AlertCircle size={13} className="flex-shrink-0 text-rose-400" />
              <span>{error}</span>
            </div>
          )}
        </div>

        {/* Right Side: Visual Query Builder Panel */}
        {isQueryBuilderOpen && (
          <>
            {/* Resize Handle */}
            <div
              className="query-builder-resizer"
              onMouseDown={startResizingQueryBuilder}
              data-testid="query-builder-resizer"
            />
            <div 
              className="query-builder-panel border-l border-b border-[var(--border-color)] bg-[var(--bg-panel)] flex flex-col flex-shrink-0"
              style={{ width: queryBuilderWidth }}
              data-testid="query-builder-panel"
            >
            {/* Header */}
            <div className="query-builder-header">
              <div className="flex items-center gap-1.5 text-[11px] font-semibold text-[var(--text-main)]">
                <DatabaseZap size={11} className="text-emerald-500" />
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
                    className="text-[10px] text-[var(--text-muted)] hover:text-rose-400 transition-colors"
                  >
                    Clear All
                  </button>
                )}
                <button 
                  onClick={() => setIsQueryBuilderOpen(false)}
                  className="p-0.5 rounded hover:bg-[var(--bg-item-active)] text-[var(--text-muted)] hover:text-[var(--text-main)] transition-all"
                  title="Close Panel"
                >
                  <X size={12} />
                </button>
              </div>
            </div>

            {/* Cards List container */}
            <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-2">
              
              {/* Card 1: Query (Filter) */}
              <div className="query-builder-card" data-testid="query-card">
                <div className="query-builder-card-header">
                  <label className="flex items-center gap-1.5 cursor-pointer font-semibold text-[11px]">
                    <input 
                      type="checkbox"
                      checked={isQueryEnabled}
                      onChange={(e) => handleToggleQueryEnabled(e.target.checked)}
                      className="query-builder-checkbox"
                      data-testid="query-enable-checkbox"
                    />
                    <span>Query</span>
                  </label>
                  {isQueryEnabled && rules.length > 0 && (
                    <select
                      value={queryMatchType}
                      onChange={(e) => updateQueryMatchType(e.target.value as 'and' | 'or')}
                      className="query-builder-select py-0 px-1 text-[10px] w-auto max-w-[130px]"
                      data-testid="query-match-type"
                    >
                      <option value="and">Match All ($and)</option>
                      <option value="or">Match Any ($or)</option>
                    </select>
                  )}
                </div>
                {isQueryEnabled && (
                  <div className="query-builder-card-body">
                    {rules.length === 0 ? (
                      <div 
                        onClick={addRule} 
                        className="query-builder-dropzone"
                        data-testid="query-dropzone"
                      >
                        <span>+ Click to add query rules</span>
                      </div>
                    ) : (
                      <div className="flex flex-col gap-2">
                        {rules.map((rule) => {
                          const isCustomField = rule.field === '__custom__' || !fields.includes(rule.field);
                          return (
                            <div key={rule.id} className="query-builder-rule-row" data-testid={`query-rule-${rule.id}`}>
                              {/* Field selector */}
                              {isCustomField ? (
                                <div className="flex items-center gap-1 flex-1 min-w-0">
                                  <input 
                                    type="text"
                                    value={rule.field === '__custom__' ? '' : rule.field}
                                    onChange={(e) => updateRule(rule.id, { field: e.target.value })}
                                    placeholder="field.path"
                                    className="query-builder-input"
                                    data-testid={`rule-field-custom-${rule.id}`}
                                  />
                                  {fields.length > 0 && (
                                    <button 
                                      onClick={() => updateRule(rule.id, { field: fields[0] })}
                                      className="text-[10px] text-[var(--accent-blue)] hover:underline flex-shrink-0"
                                    >
                                      List
                                    </button>
                                  )}
                                </div>
                              ) : (
                                <select
                                  value={rule.field}
                                  onChange={(e) => updateRule(rule.id, { field: e.target.value })}
                                  className="query-builder-select flex-1 min-w-0"
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
                                className="query-builder-select w-[65px] flex-shrink-0"
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
                                  className="query-builder-select w-[65px] flex-shrink-0"
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
                                  className="query-builder-input"
                                  data-testid={`rule-value-${rule.id}`}
                                />
                              )}

                              {/* Delete button */}
                              <button 
                                onClick={() => deleteRule(rule.id)}
                                className="p-1 rounded hover:bg-[var(--bg-item-active)] text-[var(--text-muted)] hover:text-rose-400 transition-colors"
                                title="Remove Rule"
                              >
                                <Trash2 size={11} />
                              </button>
                            </div>
                          );
                        })}
                        <button 
                          onClick={addRule} 
                          className="query-builder-add-btn"
                          data-testid="query-add-rule-btn"
                        >
                          <Plus size={11} />
                          <span>Add Rule</span>
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Card 2: Projection */}
              <div className="query-builder-card" data-testid="projection-card">
                <div className="query-builder-card-header">
                  <label className="flex items-center gap-1.5 cursor-pointer font-semibold text-[11px]">
                    <input 
                      type="checkbox"
                      checked={isProjectionEnabled}
                      onChange={(e) => handleToggleProjectionEnabled(e.target.checked)}
                      className="query-builder-checkbox"
                      data-testid="projection-enable-checkbox"
                    />
                    <span>Projection</span>
                  </label>
                </div>
                {isProjectionEnabled && (
                  <div className="query-builder-card-body">
                    {projectionRules.length === 0 ? (
                      <div 
                        onClick={addProjectionRule} 
                        className="query-builder-dropzone"
                        data-testid="projection-dropzone"
                      >
                        <span>+ Click to add projection criteria</span>
                      </div>
                    ) : (
                      <div className="flex flex-col gap-2">
                        {projectionRules.map((rule) => {
                          const isCustomField = rule.field === '__custom__' || !fields.includes(rule.field);
                          return (
                            <div key={rule.id} className="query-builder-rule-row" data-testid={`projection-rule-${rule.id}`}>
                              {/* Field selector */}
                              {isCustomField ? (
                                <div className="flex items-center gap-1 flex-1 min-w-0">
                                  <input 
                                    type="text"
                                    value={rule.field === '__custom__' ? '' : rule.field}
                                    onChange={(e) => updateProjectionRule(rule.id, { field: e.target.value })}
                                    placeholder="field.path"
                                    className="query-builder-input"
                                    data-testid={`projection-field-custom-${rule.id}`}
                                  />
                                  {fields.length > 0 && (
                                    <button 
                                      onClick={() => updateProjectionRule(rule.id, { field: fields[0] })}
                                      className="text-[10px] text-[var(--accent-blue)] hover:underline flex-shrink-0"
                                    >
                                      List
                                    </button>
                                  )}
                                </div>
                              ) : (
                                <select
                                  value={rule.field}
                                  onChange={(e) => updateProjectionRule(rule.id, { field: e.target.value })}
                                  className="query-builder-select flex-1 min-w-0"
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
                                className="query-builder-select w-[100px] flex-shrink-0"
                                data-testid={`projection-include-${rule.id}`}
                              >
                                <option value="1">Include (1)</option>
                                <option value="0">Exclude (0)</option>
                              </select>

                              <div className="flex-grow" />

                              {/* Delete button */}
                              <button 
                                onClick={() => deleteProjectionRule(rule.id)}
                                className="p-1 rounded hover:bg-[var(--bg-item-active)] text-[var(--text-muted)] hover:text-rose-400 transition-colors"
                                title="Remove Rule"
                              >
                                <Trash2 size={11} />
                              </button>
                            </div>
                          );
                        })}
                        <button 
                          onClick={addProjectionRule} 
                          className="query-builder-add-btn"
                          data-testid="projection-add-rule-btn"
                        >
                          <Plus size={11} />
                          <span>Add Projection</span>
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Card 3: Sort */}
              <div className="query-builder-card" data-testid="sort-card">
                <div className="query-builder-card-header">
                  <label className="flex items-center gap-1.5 cursor-pointer font-semibold text-[11px]">
                    <input 
                      type="checkbox"
                      checked={isSortEnabled}
                      onChange={(e) => handleToggleSortEnabled(e.target.checked)}
                      className="query-builder-checkbox"
                      data-testid="sort-enable-checkbox"
                    />
                    <span>Sort</span>
                  </label>
                </div>
                {isSortEnabled && (
                  <div className="query-builder-card-body">
                    {sortRules.length === 0 ? (
                      <div 
                        onClick={addSortRule} 
                        className="query-builder-dropzone"
                        data-testid="sort-dropzone"
                      >
                        <span>+ Click to add sort criteria</span>
                      </div>
                    ) : (
                      <div className="flex flex-col gap-2">
                        {sortRules.map((rule) => {
                          const isCustomField = rule.field === '__custom__' || !fields.includes(rule.field);
                          return (
                            <div key={rule.id} className="query-builder-rule-row" data-testid={`sort-rule-${rule.id}`}>
                              {/* Field selector */}
                              {isCustomField ? (
                                <div className="flex items-center gap-1 flex-1 min-w-0">
                                  <input 
                                    type="text"
                                    value={rule.field === '__custom__' ? '' : rule.field}
                                    onChange={(e) => updateSortRule(rule.id, { field: e.target.value })}
                                    placeholder="field.path"
                                    className="query-builder-input"
                                    data-testid={`sort-field-custom-${rule.id}`}
                                  />
                                  {fields.length > 0 && (
                                    <button 
                                      onClick={() => updateSortRule(rule.id, { field: fields[0] })}
                                      className="text-[10px] text-[var(--accent-blue)] hover:underline flex-shrink-0"
                                    >
                                      List
                                    </button>
                                  )}
                                </div>
                              ) : (
                                <select
                                  value={rule.field}
                                  onChange={(e) => updateSortRule(rule.id, { field: e.target.value })}
                                  className="query-builder-select flex-1 min-w-0"
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
                                className="query-builder-select w-[75px] flex-shrink-0"
                                data-testid={`sort-direction-${rule.id}`}
                              >
                                <option value="1">Asc (1)</option>
                                <option value="-1">Desc (-1)</option>
                              </select>

                              <div className="flex-grow" />

                              {/* Delete button */}
                              <button 
                                onClick={() => deleteSortRule(rule.id)}
                                className="p-1 rounded hover:bg-[var(--bg-item-active)] text-[var(--text-muted)] hover:text-rose-400 transition-colors"
                                title="Remove Rule"
                              >
                                <Trash2 size={11} />
                              </button>
                            </div>
                          );
                        })}
                        <button 
                          onClick={addSortRule} 
                          className="query-builder-add-btn"
                          data-testid="sort-add-rule-btn"
                        >
                          <Plus size={11} />
                          <span>Add Sort Field</span>
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>

            </div>

            {/* Footer */}
            <div className="p-2 border-t border-[var(--border-color)] bg-[var(--bg-panel)] flex justify-end">
              <button 
                onClick={handleRun}
                disabled={loading}
                className="px-3 py-1 text-[11px] font-semibold text-white bg-[var(--accent-blue)] hover:bg-[var(--accent-blue-hover)] transition-colors rounded shadow-sm"
              >
                Apply
              </button>
            </div>
          </div>
        </>
      )}

      {/* Right Side: AI Helper Panel */}
      <AIChatPanel
        variant="editor"
        databaseName={databaseName}
        collectionName={collectionName}
        fields={availableFields}
        isOpen={isAIHelperOpen}
        onClose={() => setIsAIHelperOpen(false)}
        onInsertQuery={handleInsertQuery}
        onInsertAndRunQuery={handleInsertAndRunQuery}
      />
      </div>
    </div>
  );
};
