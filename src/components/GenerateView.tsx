import React, { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Wand2, Loader2, AlertCircle, RefreshCw, Plus, Trash2, Ban, CheckCircle2, AlertTriangle, ListChecks } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { QueryEditor } from './QueryEditor';
import { useDialogs } from './dialogs/DialogProvider';
import type { ExportTaskInfo } from './TaskManager';
import {
  GEN_KINDS,
  templateToRows,
  rowsToTemplate,
  newFieldRow,
  newObjectRow,
  newArrayRow,
  newRowId,
  defaultOptionsFor,
  type GenRow,
  type GenKind,
} from '@/lib/generateTemplate';

interface GenerateViewProps {
  connectionId: string;
  database: string;
  /** Absent when opened from a database-row entry — the user picks a target
   * collection before generating; this view then shows a starter template
   * and an editable "Target collection" field instead of calling
   * `infer_generate_template` (which needs a real collection to sample). */
  collection?: string;
  /** The running/finished task for this tab, matched by App via a
   * tabId→taskId map (App only knows the id after `start_generate_task`
   * resolves) — absent until a run has been started from this tab. */
  task?: ExportTaskInfo;
  /** Start a background generate run. `collection` is passed through when
   * this view resolved a target collection locally (the database-scoped,
   * no-`collection`-prop case) so App's handler can use it instead of the
   * tab's own (empty) collection field. */
  onRun: (template: string, count: number, seed: number | undefined, collection: string) => void;
  onOpenTasks: () => void;
  onCancel?: (taskId: string) => void;
}

const STARTER_TEMPLATE = JSON.stringify(
  {
    name: '$name',
    email: '$email',
    createdAt: { $date: { past_days: 365 } },
  },
  null,
  2,
);

const GEN_KIND_LABELS: Record<GenKind, string> = {
  name: 'Full name ($name)',
  firstName: 'First name ($firstName)',
  lastName: 'Last name ($lastName)',
  email: 'Email ($email)',
  objectId: 'ObjectId ($objectId)',
  uuid: 'UUID ($uuid)',
  bool: 'Boolean ($bool)',
  int: 'Integer ($int)',
  float: 'Float ($float)',
  date: 'Date ($date)',
  lorem: 'Lorem text ($lorem)',
  pick: 'Pick from list ($pick)',
  array: 'Array of… ($array)',
  literal: 'Literal value',
  object: 'Nested object',
};

const PREVIEW_DEBOUNCE_MS = 400;
const PREVIEW_COUNT = 3;
const DEFAULT_COUNT = 100;
const MAX_COUNT = 50000;
const TYPED_CONFIRM_THRESHOLD = 1000;

const numberInputClass =
  'h-7 w-20 rounded-md border border-input bg-background px-2 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/** Convert `row` to a new `kind`, discarding any options/children that don't
 * apply to the new kind and seeding sane defaults instead (never leaves a
 * row in a half-migrated, unrepresentable-by-construction state). */
function changeRowKind(row: GenRow, kind: GenKind): GenRow {
  const options = defaultOptionsFor(kind);
  if (kind === 'object') {
    return { ...row, kind, options, children: row.children && row.kind === 'object' ? row.children : [] };
  }
  if (kind === 'array') {
    return {
      ...row,
      kind,
      options,
      children:
        row.children && row.kind === 'array'
          ? row.children
          : [{ id: newRowId(), name: '', kind: 'lorem', options: { words: 2 } }],
    };
  }
  return { ...row, kind, options, children: undefined };
}

// ---------------------------------------------------------------------------
// Row list + row editor — recursive builder UI
// ---------------------------------------------------------------------------

interface RowsListProps {
  rows: GenRow[];
  onChange: (rows: GenRow[]) => void;
  parentKey: string;
}

const RowsList: React.FC<RowsListProps> = ({ rows, onChange, parentKey }) => {
  const updateAt = (index: number, updated: GenRow) => {
    const next = [...rows];
    next[index] = updated;
    onChange(next);
  };
  const removeAt = (index: number) => {
    onChange(rows.filter((_, i) => i !== index));
  };
  const nextFieldName = () => `field${rows.length + 1}`;

  return (
    <div className="flex flex-col gap-2">
      {rows.map((row, i) => (
        <RowEditor key={row.id} row={row} onChange={(updated) => updateAt(i, updated)} onRemove={() => removeAt(i)} />
      ))}
      <div className="flex flex-wrap gap-1.5">
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid={`generate-add-field-${parentKey}`}
          onClick={() => onChange([...rows, newFieldRow(nextFieldName())])}
        >
          <Plus size={12} />
          Add field
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid={`generate-add-object-${parentKey}`}
          onClick={() => onChange([...rows, newObjectRow(nextFieldName())])}
        >
          <Plus size={12} />
          Add nested object
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid={`generate-add-array-${parentKey}`}
          onClick={() => onChange([...rows, newArrayRow(nextFieldName())])}
        >
          <Plus size={12} />
          Add array
        </Button>
      </div>
    </div>
  );
};

interface RowEditorProps {
  row: GenRow;
  onChange: (row: GenRow) => void;
  onRemove?: () => void;
  isArrayItem?: boolean;
}

const RowEditor: React.FC<RowEditorProps> = ({ row, onChange, onRemove, isArrayItem = false }) => {
  const setOptions = (options: Record<string, unknown>) => onChange({ ...row, options: { ...row.options, ...options } });

  return (
    <div
      className="flex flex-col gap-1.5 rounded-md border border-border bg-muted/20 p-2"
      data-testid={`generate-row-${row.id}`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        {isArrayItem ? (
          <span className="text-xs italic text-muted-foreground">Array item</span>
        ) : (
          <Input
            className="h-7 w-36 text-xs"
            value={row.name}
            placeholder="field name"
            aria-label="Field name"
            data-testid={`generate-row-name-${row.id}`}
            onChange={(e) => onChange({ ...row, name: e.target.value })}
          />
        )}
        <Select
          value={row.kind}
          onValueChange={(kind) => onChange(changeRowKind(row, kind as GenKind))}
        >
          <SelectTrigger className="h-7 w-48 text-xs" data-testid={`generate-row-kind-${row.id}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {GEN_KINDS.map((k) => (
              <SelectItem key={k} value={k}>
                {GEN_KIND_LABELS[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {!isArrayItem && onRemove && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-destructive"
            aria-label="Remove field"
            data-testid={`generate-row-remove-${row.id}`}
            onClick={onRemove}
          >
            <Trash2 size={12} />
          </Button>
        )}
      </div>

      {row.kind === 'int' && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span>min</span>
          <input
            type="number"
            className={numberInputClass}
            value={String(row.options.min ?? 0)}
            aria-label="Minimum"
            onChange={(e) => setOptions({ min: Number(e.target.value) })}
          />
          <span>max</span>
          <input
            type="number"
            className={numberInputClass}
            value={String(row.options.max ?? 1000)}
            aria-label="Maximum"
            onChange={(e) => setOptions({ max: Number(e.target.value) })}
          />
        </div>
      )}

      {row.kind === 'float' && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span>min</span>
          <input
            type="number"
            className={numberInputClass}
            value={String(row.options.min ?? 0)}
            aria-label="Minimum"
            onChange={(e) => setOptions({ min: Number(e.target.value) })}
          />
          <span>max</span>
          <input
            type="number"
            className={numberInputClass}
            value={String(row.options.max ?? 1000)}
            aria-label="Maximum"
            onChange={(e) => setOptions({ max: Number(e.target.value) })}
          />
          <span>decimals</span>
          <input
            type="number"
            className={numberInputClass}
            value={String(row.options.decimals ?? 2)}
            aria-label="Decimals"
            onChange={(e) => setOptions({ decimals: Number(e.target.value) })}
          />
        </div>
      )}

      {row.kind === 'lorem' && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span>words</span>
          <input
            type="number"
            className={numberInputClass}
            value={String(row.options.words ?? 2)}
            aria-label="Words"
            onChange={(e) => setOptions({ words: Number(e.target.value) })}
          />
        </div>
      )}

      {row.kind === 'date' && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <Select
            value={(row.options.mode as string) ?? 'past_days'}
            onValueChange={(mode) =>
              setOptions(
                mode === 'range'
                  ? { mode: 'range', from: row.options.from ?? '', to: row.options.to ?? '' }
                  : { mode: 'past_days', pastDays: row.options.pastDays ?? 365 },
              )
            }
          >
            <SelectTrigger className="h-7 w-32 text-xs" aria-label="Date mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="past_days">Past N days</SelectItem>
              <SelectItem value="range">From / to</SelectItem>
            </SelectContent>
          </Select>
          {row.options.mode === 'range' ? (
            <>
              <input
                type="text"
                className={cn(numberInputClass, 'w-44')}
                placeholder="from (ISO)"
                aria-label="From"
                value={String(row.options.from ?? '')}
                onChange={(e) => setOptions({ from: e.target.value })}
              />
              <input
                type="text"
                className={cn(numberInputClass, 'w-44')}
                placeholder="to (ISO)"
                aria-label="To"
                value={String(row.options.to ?? '')}
                onChange={(e) => setOptions({ to: e.target.value })}
              />
            </>
          ) : (
            <>
              <span>past</span>
              <input
                type="number"
                className={numberInputClass}
                aria-label="Past days"
                value={String(row.options.pastDays ?? 365)}
                onChange={(e) => setOptions({ pastDays: Number(e.target.value) })}
              />
              <span>days</span>
            </>
          )}
        </div>
      )}

      {row.kind === 'pick' && (
        <PickValuesEditor
          values={Array.isArray(row.options.values) ? (row.options.values as unknown[]) : []}
          onChange={(values) => setOptions({ values })}
        />
      )}

      {row.kind === 'literal' && (
        <LiteralValueEditor value={row.options.value} onChange={(value) => setOptions({ value })} />
      )}

      {row.kind === 'array' && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>min</span>
            <input
              type="number"
              className={numberInputClass}
              aria-label="Array minimum length"
              value={String(row.options.min ?? 1)}
              onChange={(e) => setOptions({ min: Number(e.target.value) })}
            />
            <span>max</span>
            <input
              type="number"
              className={numberInputClass}
              aria-label="Array maximum length"
              value={String(row.options.max ?? 3)}
              onChange={(e) => setOptions({ max: Number(e.target.value) })}
            />
          </div>
          {row.children?.[0] && (
            <RowEditor
              row={row.children[0]}
              isArrayItem
              onChange={(child) => onChange({ ...row, children: [child] })}
            />
          )}
        </div>
      )}

      {row.kind === 'object' && (
        <div className="ml-2 border-l border-border/60 pl-2">
          <RowsList
            rows={row.children ?? []}
            parentKey={row.id}
            onChange={(children) => onChange({ ...row, children })}
          />
        </div>
      )}
    </div>
  );
};

const PickValuesEditor: React.FC<{ values: unknown[]; onChange: (values: unknown[]) => void }> = ({
  values,
  onChange,
}) => {
  const parseEntry = (raw: string): unknown => {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'string' || typeof parsed === 'number' || typeof parsed === 'boolean' || parsed === null) {
        return parsed;
      }
    } catch {
      /* not JSON — treat as a plain string below */
    }
    return raw;
  };
  return (
    <div className="flex flex-col gap-1">
      {values.map((v, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <Input
            className="h-7 w-40 text-xs"
            aria-label={`Pick value ${i + 1}`}
            value={typeof v === 'string' ? v : JSON.stringify(v)}
            onChange={(e) => {
              const next = [...values];
              next[i] = parseEntry(e.target.value);
              onChange(next);
            }}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-destructive"
            aria-label={`Remove pick value ${i + 1}`}
            onClick={() => onChange(values.filter((_, idx) => idx !== i))}
          >
            <Trash2 size={12} />
          </Button>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" className="w-fit" onClick={() => onChange([...values, ''])}>
        <Plus size={12} />
        Add value
      </Button>
    </div>
  );
};

const LiteralValueEditor: React.FC<{ value: unknown; onChange: (value: unknown) => void }> = ({ value, onChange }) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return (
    <Input
      className="h-7 w-64 text-xs font-mono"
      aria-label="Literal value"
      value={text}
      onChange={(e) => {
        const raw = e.target.value;
        try {
          onChange(JSON.parse(raw));
        } catch {
          onChange(raw);
        }
      }}
    />
  );
};

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

const TaskProgress: React.FC<{ task: ExportTaskInfo; onCancel?: (taskId: string) => void; onOpenTasks: () => void }> = ({
  task,
  onCancel,
  onOpenTasks,
}) => {
  const isRunning = task.status === 'running';
  const isFailed = task.status === 'failed';
  const isCancelled = task.status === 'cancelled';
  const percent = task.total && task.total > 0 ? Math.min(100, Math.round((task.processed / task.total) * 100)) : null;

  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border p-3" data-testid="generate-progress">
      <div className="flex items-center justify-between gap-2">
        <div
          className={cn(
            'flex items-center gap-2 text-xs font-medium',
            isRunning && 'text-primary',
            isFailed && 'text-destructive',
            isCancelled && 'text-muted-foreground',
            !isRunning && !isFailed && !isCancelled && 'text-success',
          )}
        >
          {isRunning ? (
            <Loader2 size={13} className="animate-spin" />
          ) : isFailed ? (
            <AlertTriangle size={13} />
          ) : isCancelled ? (
            <Ban size={13} />
          ) : (
            <CheckCircle2 size={13} />
          )}
          <span data-testid="generate-task-message">{task.error || task.message}</span>
        </div>
        {percent !== null && (
          <span className="text-[10px] tabular-nums text-muted-foreground">
            {task.processed}/{task.total} ({percent}%)
          </span>
        )}
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
        <div
          className={cn(
            'h-full rounded-full transition-all',
            isFailed ? 'bg-destructive' : isRunning ? 'bg-primary' : isCancelled ? 'bg-muted-foreground' : 'bg-success',
            isRunning && percent === null && 'animate-pulse',
          )}
          style={{ width: `${percent ?? (isRunning ? 18 : isCancelled ? 0 : 100)}%` }}
          data-testid="generate-progress-bar"
        />
      </div>
      <div className="flex items-center gap-2">
        {isRunning && onCancel && (
          <Button type="button" variant="outline" size="sm" data-testid="generate-cancel-btn" onClick={() => onCancel(task.id)}>
            Cancel
          </Button>
        )}
        <Button type="button" variant="ghost" size="sm" data-testid="generate-view-tasks-btn" onClick={onOpenTasks}>
          <ListChecks size={12} />
          View in Tasks
        </Button>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// GenerateView
// ---------------------------------------------------------------------------

export const GenerateView: React.FC<GenerateViewProps> = ({
  connectionId,
  database,
  collection,
  task,
  onRun,
  onOpenTasks,
  onCancel,
}) => {
  const { confirm, prompt, toast } = useDialogs();

  const [targetCollection, setTargetCollection] = useState('');
  const [templateText, setTemplateText] = useState<string>(collection ? '' : STARTER_TEMPLATE);
  const [rows, setRows] = useState<GenRow[] | null>(collection ? null : templateToRows(JSON.parse(STARTER_TEMPLATE)));
  const [customTemplate, setCustomTemplate] = useState(false);
  const [mode, setMode] = useState<'builder' | 'raw'>('builder');
  const [loading, setLoading] = useState<boolean>(Boolean(collection));
  const [loadError, setLoadError] = useState<string | null>(null);

  const [previewDocs, setPreviewDocs] = useState<string[]>([]);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const previewGen = useRef(0);

  const [countText, setCountText] = useState(String(DEFAULT_COUNT));
  const [seedText, setSeedText] = useState('');
  const [running, setRunning] = useState(false);

  // Load the starting template: schema-seeded when opened on a specific
  // collection, the starter example otherwise.
  useEffect(() => {
    if (!collection) {
      setTemplateText(STARTER_TEMPLATE);
      const starterRows = templateToRows(JSON.parse(STARTER_TEMPLATE));
      setRows(starterRows);
      setCustomTemplate(starterRows === null);
      setLoading(false);
      setLoadError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    (async () => {
      try {
        const result = await invoke<string>('infer_generate_template', {
          id: connectionId,
          database,
          collection,
        });
        if (cancelled) return;
        setTemplateText(result);
        let parsedRows: GenRow[] | null = null;
        try {
          parsedRows = templateToRows(JSON.parse(result));
        } catch {
          parsedRows = null;
        }
        setRows(parsedRows);
        setCustomTemplate(parsedRows === null);
      } catch (err: any) {
        if (!cancelled) setLoadError(String(err?.message || err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connectionId, database, collection]);

  const effectiveCollection = collection || targetCollection.trim();

  // ---- builder ⇄ raw sync -------------------------------------------------

  const handleRowsChange = (nextRows: GenRow[]) => {
    setRows(nextRows);
    setCustomTemplate(false);
    setTemplateText(JSON.stringify(rowsToTemplate(nextRows), null, 2));
  };

  const handleRawChange = (text: string) => {
    setTemplateText(text);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setCustomTemplate(true);
      return;
    }
    const nextRows = templateToRows(parsed);
    if (nextRows === null) {
      setCustomTemplate(true);
    } else {
      setRows(nextRows);
      setCustomTemplate(false);
    }
  };

  const switchToBuilder = () => {
    if (customTemplate) return; // toggle is disabled in this state
    setMode('builder');
  };

  // ---- preview -------------------------------------------------------------

  const seedNum = seedText.trim() === '' ? undefined : Number(seedText);

  const runPreview = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(templateText);
    } catch (e: any) {
      previewGen.current += 1;
      setPreviewError(`Invalid JSON: ${e?.message || 'syntax error'}`);
      setPreviewDocs([]);
      return;
    }
    void parsed;
    const gen = (previewGen.current += 1);
    setPreviewLoading(true);
    try {
      const docs = await invoke<string[]>('preview_generated_documents', {
        template: templateText,
        count: PREVIEW_COUNT,
        seed: seedNum,
      });
      if (gen === previewGen.current) {
        setPreviewDocs(docs);
        setPreviewError(null);
      }
    } catch (err: any) {
      if (gen === previewGen.current) {
        setPreviewError(String(err?.message || err));
        setPreviewDocs([]);
      }
    } finally {
      if (gen === previewGen.current) setPreviewLoading(false);
    }
  };

  useEffect(() => {
    if (loading) return;
    const timer = setTimeout(() => {
      void runPreview();
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateText, seedText, loading]);

  // ---- footer / run ----------------------------------------------------

  const count = Number(countText);
  const countError =
    countText.trim() === ''
      ? 'Count is required'
      : !Number.isFinite(count) || !Number.isInteger(count)
        ? 'Count must be a whole number'
        : count < 1 || count > MAX_COUNT
          ? `Count must be between 1 and ${MAX_COUNT}`
          : null;

  const seedError = seedText.trim() !== '' && (!Number.isFinite(Number(seedText)) || seedText.trim().includes('.'))
    ? 'Seed must be a whole number'
    : null;

  const canGenerate = !countError && !seedError && !!effectiveCollection && !running;

  const handleGenerate = async () => {
    if (!canGenerate) return;
    setRunning(true);
    try {
      let existing: number | undefined;
      try {
        existing = await invoke<number>('count_documents', {
          id: connectionId,
          database,
          collection: effectiveCollection,
          filter: '{}',
        });
      } catch {
        existing = undefined; // unknown — omit the "adds to existing" clause
      }

      const message =
        `Insert ${count} documents into ${database}.${effectiveCollection}.` +
        (existing && existing > 0 ? ` This adds to the existing ${existing} documents.` : '');

      const confirmed = await confirm({
        title: 'Generate documents',
        message,
        confirmLabel: 'Generate',
        destructive: true,
      });
      if (!confirmed) return;

      if (count > TYPED_CONFIRM_THRESHOLD) {
        const typed = await prompt({
          title: 'Confirm count',
          message: 'Type the exact number of documents to insert.',
          validate: (v) => (v.trim() === String(count) ? null : 'Type the exact count to confirm'),
        });
        if (typed === null) return;
      }

      onRun(templateText, count, seedNum, effectiveCollection);
    } catch (err: any) {
      toast(`Could not start generate: ${err?.message || err}`, 'error');
    } finally {
      setRunning(false);
    }
  };

  const toggleBtnClass = (active: boolean) =>
    cn(
      'rounded-md px-2 py-1 text-xs font-medium transition-colors',
      active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent',
    );

  return (
    <div className="flex h-full flex-col overflow-auto" data-testid="generate-view">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Wand2 size={14} className="text-primary" />
          <span>Generate Data: {collection ? `${database}.${collection}` : database}</span>
        </div>
        <div className="flex items-center gap-1 rounded-md border border-border p-0.5" data-testid="generate-mode-toggle">
          <button
            type="button"
            className={toggleBtnClass(mode === 'builder')}
            disabled={customTemplate}
            data-testid="generate-mode-builder"
            onClick={switchToBuilder}
          >
            Builder
          </button>
          <button
            type="button"
            className={toggleBtnClass(mode === 'raw')}
            data-testid="generate-mode-raw"
            onClick={() => setMode('raw')}
          >
            Raw
          </button>
        </div>
      </div>

      {loading && (
        <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground" data-testid="generate-loading">
          <Loader2 size={12} className="animate-spin" />
          <span>Loading template…</span>
        </div>
      )}
      {loadError && (
        <div className="flex items-center gap-2 p-4 text-xs text-destructive" data-testid="generate-error">
          <AlertCircle size={12} />
          <span>{loadError}</span>
        </div>
      )}

      {!loading && !loadError && (
        <div className="flex flex-1 gap-3 overflow-hidden p-3">
          <div className="flex w-1/2 flex-col gap-2 overflow-auto">
            {!collection && (
              <div className="flex items-center gap-2">
                <Label className="text-xs text-muted-foreground">Target collection</Label>
                <Input
                  className="h-7 w-48 text-xs"
                  value={targetCollection}
                  placeholder="collection name"
                  data-testid="generate-target-collection-input"
                  onChange={(e) => setTargetCollection(e.target.value)}
                />
              </div>
            )}

            {customTemplate && (
              <div
                className="flex items-center gap-2 rounded-md border border-dashed border-amber-500/50 bg-amber-500/10 p-2 text-xs text-amber-600 dark:text-amber-400"
                data-testid="generate-custom-notice"
              >
                <AlertCircle size={12} className="flex-shrink-0" />
                <span>Custom template — editing as raw JSON. Fix or simplify it to switch back to the builder.</span>
              </div>
            )}

            {mode === 'builder' && rows !== null ? (
              <RowsList rows={rows} parentKey="root" onChange={handleRowsChange} />
            ) : (
              <QueryEditor
                surface="filter"
                value={templateText}
                onChange={handleRawChange}
                fields={[]}
                height={360}
                data-testid="generate-raw-editor"
              />
            )}
          </div>

          <div className="flex w-1/2 flex-col gap-2 overflow-auto">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-medium text-foreground">Preview ({PREVIEW_COUNT} docs)</h3>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="generate-preview-refresh-btn"
                onClick={() => void runPreview()}
                disabled={previewLoading}
              >
                <RefreshCw size={12} className={cn(previewLoading && 'animate-spin')} />
                Refresh
              </Button>
            </div>
            {previewError && (
              <div className="flex items-center gap-2 text-xs text-destructive" data-testid="generate-preview-error">
                <AlertCircle size={12} className="flex-shrink-0" />
                <span>{previewError}</span>
              </div>
            )}
            <div className="flex flex-col gap-2">
              {previewDocs.map((doc, i) => (
                <pre
                  key={i}
                  className="overflow-x-auto rounded-sm border border-border bg-muted/30 p-2 font-mono text-xs"
                  data-testid="generate-preview-doc"
                >
                  {doc}
                </pre>
              ))}
            </div>
          </div>
        </div>
      )}

      {!loading && !loadError && (
        <div className="flex flex-col gap-2 border-t border-border px-4 py-3">
          {task && <TaskProgress task={task} onCancel={onCancel} onOpenTasks={onOpenTasks} />}

          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <Label className="text-xs text-muted-foreground">Count</Label>
              <input
                type="number"
                className={cn(numberInputClass, 'w-24')}
                value={countText}
                min={1}
                max={MAX_COUNT}
                data-testid="generate-count-input"
                onChange={(e) => setCountText(e.target.value)}
              />
              {countError && (
                <span className="text-[10px] text-destructive" data-testid="generate-count-error">
                  {countError}
                </span>
              )}
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs text-muted-foreground">Seed (optional)</Label>
              <input
                type="text"
                className={cn(numberInputClass, 'w-24')}
                value={seedText}
                placeholder="random"
                data-testid="generate-seed-input"
                onChange={(e) => setSeedText(e.target.value)}
              />
              {seedError && (
                <span className="text-[10px] text-destructive" data-testid="generate-seed-error">
                  {seedError}
                </span>
              )}
            </div>
            {!collection && !effectiveCollection && (
              <span className="text-[10px] text-destructive">Choose a target collection first.</span>
            )}
            <Button
              type="button"
              data-testid="generate-run-btn"
              disabled={!canGenerate}
              onClick={() => void handleGenerate()}
            >
              <Wand2 size={13} />
              {running ? 'Starting…' : 'Generate'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};
