import React from 'react';
import { Download, Filter, ListChecks, Hash, Copy, Eye } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { QueryEditor } from './QueryEditor';
import { FindQueryBar } from './FindQueryBar';
import { useCollectionSchema } from '../lib/useCollectionSchema';

/** File formats the export view can produce. */
export type ExportFormat = 'json' | 'ndjson' | 'bson' | 'csv' | 'xlsx';

/** CSV-specific export options. */
export interface CsvExportOptions {
  /** Single char; UI presets , ; \t plus a custom character. */
  delimiter: string;
  quote: string;
  recordSeparator: '\n' | '\r\n';
  includeHeaders: boolean;
  nullAsEmpty: boolean;
}

/** Excel (.xlsx) export options. */
export interface XlsxExportOptions {
  includeHeaders: boolean;
  boldHeaders: boolean;
  autoSize: boolean;
  alignment: 'left' | 'center' | 'right';
}

/** Per-format export options threaded through to the backend writer. */
export interface ExportOptions {
  fields?: string[];
  jsonMode: 'relaxed' | 'canonical';
  csv: CsvExportOptions;
  xlsx: XlsxExportOptions;
}

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  jsonMode: 'relaxed',
  csv: { delimiter: ',', quote: '"', recordSeparator: '\n', includeHeaders: true, nullAsEmpty: true },
  xlsx: { includeHeaders: true, boldHeaders: false, autoSize: false, alignment: 'left' },
};

/** The edited query the user chose to export from the Filtered card. */
export type FilteredExportQuery =
  | {
      kind: 'find';
      filter: string;
      sort: string;
      projection: string;
      /** 0 = unset, matching the query bar convention. */
      skip: number;
      /** 0 = unset, matching the query bar convention. */
      limit: number;
    }
  | { kind: 'aggregate'; pipeline: string };

/** Seed values for the Filtered card, taken from the source tab's last run. */
export interface FilteredExportSeed {
  /** A find query (filter/sort/projection) or an aggregation pipeline. */
  kind: 'find' | 'aggregate';
  filter?: string;
  sort?: string;
  projection?: string;
  pipeline?: string;
  /** Match count from the last run, shown until the user recounts. */
  matchCount?: number | null;
}

interface ExportViewProps {
  connectionId?: string;
  connectionName: string;
  databaseName: string;
  collectionName: string;
  currentResultCount: number;
  /** Field names for the query editors' autocomplete (same as the document viewer). */
  availableFields?: string[];
  /** Seeds the editable Filtered card from the source tab's active query. */
  filtered?: FilteredExportSeed;
  onExport: (
    format: ExportFormat,
    scope: 'current' | 'full' | 'filtered',
    options: ExportOptions,
    query?: FilteredExportQuery
  ) => void;
  /** Resolve the match count for a filter (run on demand via the Count button). */
  onCountFilter?: (filter: string) => Promise<number>;
  /** Open the dedicated Tasks tab where background jobs (incl. full exports) appear. */
  onOpenTasks?: () => void;
  /** Sample the source query/collection for field names, to power the field picker. */
  onScanFields?: (query?: FilteredExportQuery) => Promise<string[]>;
  /** Copy the current-results export output straight to the clipboard (text formats only). */
  onCopyCurrent?: (format: 'json' | 'ndjson' | 'csv', options: ExportOptions) => void;
  /** Render a sample of the export output without writing a file. */
  onPreview?: (
    format: ExportFormat,
    scope: 'current' | 'full' | 'filtered',
    options: ExportOptions,
    query?: FilteredExportQuery
  ) => Promise<string>;
}

/** Validate a JSON object string ('' and '{}' count as the empty object). */
function checkJsonObject(raw: string): { ok: boolean; error?: string } {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '{}') return { ok: true };
  try {
    const value = JSON.parse(trimmed);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: 'Must be a JSON object' };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: 'Invalid JSON' };
  }
}

/** Validate a JSON array string ('' and '[]' count as the empty pipeline). */
function checkJsonArray(raw: string): { ok: boolean; error?: string } {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '[]') return { ok: true };
  try {
    const value = JSON.parse(trimmed);
    if (!Array.isArray(value)) return { ok: false, error: 'Pipeline must be a JSON array of stages' };
    return { ok: true };
  } catch {
    return { ok: false, error: 'Invalid JSON' };
  }
}

const editorShell = (valid: boolean) =>
  cn(
    'rounded-md border bg-background px-1.5 py-1 shadow-sm focus-within:ring-2 focus-within:ring-ring',
    valid ? 'border-input' : 'border-destructive focus-within:ring-destructive'
  );

/** The five file formats every export scope can produce. */
const EXPORT_FORMATS: { value: ExportFormat; label: string }[] = [
  { value: 'json', label: 'JSON' },
  { value: 'ndjson', label: 'NDJSON' },
  { value: 'bson', label: 'BSON' },
  { value: 'csv', label: 'CSV' },
  { value: 'xlsx', label: 'Excel' },
];

const selectClassName =
  'h-8 min-w-0 rounded-md border border-input bg-background px-2 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

const checkboxLabelClassName = 'flex cursor-pointer items-center gap-2 text-xs text-foreground';

export const ExportView: React.FC<ExportViewProps> = ({
  connectionId,
  connectionName,
  databaseName,
  collectionName,
  currentResultCount,
  availableFields,
  filtered,
  onExport,
  onCountFilter,
  onOpenTasks,
  onScanFields,
  onCopyCurrent,
  onPreview,
}) => {
  const hasCurrentResults = currentResultCount > 0;
  const mode: 'find' | 'aggregate' = filtered?.kind ?? 'find';

  const { schema } = useCollectionSchema(connectionId, databaseName, collectionName);
  const fields = availableFields && availableFields.length > 0 ? availableFields : ['_id'];

  const [filter, setFilter] = React.useState(filtered?.filter ?? '{}');
  const [sort, setSort] = React.useState(filtered?.sort ?? '{}');
  const [projection, setProjection] = React.useState(filtered?.projection ?? '{}');
  const [pipeline, setPipeline] = React.useState(filtered?.pipeline ?? '[]');
  const [count, setCount] = React.useState<number | null | undefined>(filtered?.matchCount);
  const [counting, setCounting] = React.useState(false);
  const [countError, setCountError] = React.useState<string | null>(null);
  const [format, setFormat] = React.useState<ExportFormat>('json');
  const [options, setOptions] = React.useState<ExportOptions>(DEFAULT_EXPORT_OPTIONS);
  const [customDelimiter, setCustomDelimiter] = React.useState('|');
  const [delimiterChoice, setDelimiterChoice] = React.useState<',' | ';' | '\t' | 'custom'>(',');
  const [skip, setSkip] = React.useState(0);
  const [limit, setLimit] = React.useState(0);

  // Field picker: sampled field paths from onScanFields, and the subset selected for export.
  const [scannedFields, setScannedFields] = React.useState<string[]>([]);
  const [selectedFields, setSelectedFields] = React.useState<Set<string>>(new Set());
  const [fieldFilterText, setFieldFilterText] = React.useState('');
  const [scanning, setScanning] = React.useState(false);
  const [hasScanned, setHasScanned] = React.useState(false);

  // Output preview panel.
  const [previewOutput, setPreviewOutput] = React.useState<string | null>(null);
  const [previewError, setPreviewError] = React.useState<string | null>(null);
  const [previewing, setPreviewing] = React.useState(false);

  const filterCheck = checkJsonObject(filter);
  const sortCheck = checkJsonObject(sort);
  const projectionCheck = checkJsonObject(projection);
  const pipelineCheck = checkJsonArray(pipeline);
  const canExportFiltered =
    mode === 'aggregate'
      ? pipelineCheck.ok
      : filterCheck.ok && sortCheck.ok && projectionCheck.ok;

  const effectiveDelimiter = delimiterChoice === 'custom' ? customDelimiter : delimiterChoice;
  const delimiterValid =
    format !== 'csv' || (effectiveDelimiter.length === 1 && /^[\x00-\x7F]$/.test(effectiveDelimiter));

  // A partial (not full, not empty) field selection restricts the exported output.
  const fieldSelectionActive = scannedFields.length > 0 && selectedFields.size < scannedFields.length;
  const noFieldsSelected = scannedFields.length > 0 && selectedFields.size === 0;
  const visibleScannedFields = scannedFields.filter((f) =>
    f.toLowerCase().includes(fieldFilterText.toLowerCase())
  );

  const effectiveOptions: ExportOptions = {
    ...options,
    csv: { ...options.csv, delimiter: effectiveDelimiter },
    ...(fieldSelectionActive
      ? { fields: scannedFields.filter((f) => selectedFields.has(f)) }
      : {}),
  };

  // Count only on demand — never automatically — so it stays stable while editing.
  const runCount = () => {
    if (!onCountFilter || !filterCheck.ok) return;
    setCounting(true);
    setCountError(null);
    onCountFilter(filter)
      .then((n) => setCount(n))
      .catch(() => setCountError('Count failed'))
      .finally(() => setCounting(false));
  };

  const countLabel = (() => {
    if (counting) return 'Counting…';
    if (countError) return countError;
    if (typeof count === 'number') {
      return `${count.toLocaleString()} matching document${count === 1 ? '' : 's'}`;
    }
    return 'Count not run yet';
  })();

  const buildQuery = (): FilteredExportQuery =>
    mode === 'aggregate'
      ? { kind: 'aggregate', pipeline }
      : {
          kind: 'find',
          filter,
          sort,
          // A field selection replaces the projection editor entirely.
          projection: fieldSelectionActive ? '{}' : projection,
          skip,
          limit,
        };

  const toggleField = (field: string) => {
    setSelectedFields((prev) => {
      const next = new Set(prev);
      if (next.has(field)) next.delete(field);
      else next.add(field);
      return next;
    });
  };

  const runScanFields = () => {
    if (!onScanFields) return;
    setScanning(true);
    onScanFields(mode === 'find' || mode === 'aggregate' ? buildQuery() : undefined)
      .then((fs) => {
        setScannedFields(fs);
        setSelectedFields(new Set(fs));
        setHasScanned(true);
      })
      .catch(() => {
        setScannedFields([]);
        setSelectedFields(new Set());
        setHasScanned(true);
      })
      .finally(() => setScanning(false));
  };

  const runPreview = () => {
    if (!onPreview) return;
    setPreviewing(true);
    setPreviewError(null);
    const scope: 'current' | 'full' | 'filtered' = filtered ? 'filtered' : 'full';
    onPreview(format, scope, effectiveOptions, scope === 'filtered' ? buildQuery() : undefined)
      .then((out) => setPreviewOutput(out))
      .catch((err) => setPreviewError(err instanceof Error ? err.message : String(err)))
      .finally(() => setPreviewing(false));
  };

  return (
    <div className="flex h-full flex-col overflow-auto p-4" data-testid="export-view">
      <header className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Export</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {connectionName} / {databaseName}.{collectionName}
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={onOpenTasks}>
          <ListChecks size={12} />
          View Tasks
        </Button>
      </header>

      <div className="mb-4 flex items-center gap-2" data-testid="export-format-picker">
        <Label className="text-xs text-muted-foreground">Format</Label>
        <div className="inline-flex rounded-md border border-border p-0.5">
          {EXPORT_FORMATS.map((f) => (
            <Button
              key={f.value}
              type="button"
              size="sm"
              variant={format === f.value ? 'default' : 'ghost'}
              aria-pressed={format === f.value}
              className="h-7 px-2.5"
              onClick={() => setFormat(f.value)}
              data-testid={`export-format-${f.value}`}
            >
              {f.label}
            </Button>
          ))}
        </div>
      </div>

      {format !== 'bson' && (
        <div className="mb-4 rounded-md border border-border p-3" data-testid="export-options-panel">
          {(format === 'json' || format === 'ndjson') && (
            <div className="flex flex-col gap-2" data-testid="export-options-json-mode">
              <Label className="text-xs">JSON mode</Label>
              <label className={checkboxLabelClassName}>
                <input
                  type="radio"
                  name="export-json-mode"
                  value="relaxed"
                  checked={options.jsonMode === 'relaxed'}
                  onChange={() => setOptions((o) => ({ ...o, jsonMode: 'relaxed' }))}
                />
                <span>
                  Relaxed <span className="text-muted-foreground">— Human-readable</span>
                </span>
              </label>
              <label className={checkboxLabelClassName}>
                <input
                  type="radio"
                  name="export-json-mode"
                  value="canonical"
                  checked={options.jsonMode === 'canonical'}
                  onChange={() => setOptions((o) => ({ ...o, jsonMode: 'canonical' }))}
                />
                <span>
                  Canonical{' '}
                  <span className="text-muted-foreground">
                    — mongoexport-compatible, lossless types
                  </span>
                </span>
              </label>
            </div>
          )}

          {format === 'csv' && (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-end gap-3">
                <div className="flex flex-col gap-1">
                  <Label className="text-xs">Delimiter</Label>
                  <select
                    value={delimiterChoice}
                    onChange={(e) =>
                      setDelimiterChoice(e.target.value as ',' | ';' | '\t' | 'custom')
                    }
                    className={selectClassName}
                    data-testid="export-options-csv-delimiter"
                  >
                    <option value=",">Comma (,)</option>
                    <option value=";">Semicolon (;)</option>
                    <option value={'\t'}>Tab</option>
                    <option value="custom">Custom…</option>
                  </select>
                </div>
                {delimiterChoice === 'custom' && (
                  <div className="flex flex-col gap-1">
                    <Label className="text-xs">Custom delimiter</Label>
                    <Input
                      value={customDelimiter}
                      onChange={(e) => setCustomDelimiter(e.target.value)}
                      className="h-8 w-20 text-xs"
                      data-testid="export-options-csv-delimiter-custom"
                    />
                  </div>
                )}
                <div className="flex flex-col gap-1">
                  <Label className="text-xs">Quote</Label>
                  <Input
                    value={options.csv.quote}
                    onChange={(e) =>
                      setOptions((o) => ({ ...o, csv: { ...o.csv, quote: e.target.value } }))
                    }
                    className="h-8 w-16 text-xs"
                    data-testid="export-options-csv-quote"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label className="text-xs">Record separator</Label>
                  <select
                    value={options.csv.recordSeparator}
                    onChange={(e) =>
                      setOptions((o) => ({
                        ...o,
                        csv: { ...o.csv, recordSeparator: e.target.value as '\n' | '\r\n' },
                      }))
                    }
                    className={selectClassName}
                    data-testid="export-options-csv-recordsep"
                  >
                    <option value={'\n'}>LF (\n)</option>
                    <option value={'\r\n'}>CRLF (\r\n)</option>
                  </select>
                </div>
              </div>
              {!delimiterValid && (
                <span className="text-xs text-destructive">
                  Delimiter must be a single ASCII character.
                </span>
              )}
              <div className="flex flex-wrap gap-4">
                <label className={checkboxLabelClassName}>
                  <input
                    type="checkbox"
                    checked={options.csv.includeHeaders}
                    onChange={() =>
                      setOptions((o) => ({
                        ...o,
                        csv: { ...o.csv, includeHeaders: !o.csv.includeHeaders },
                      }))
                    }
                    className="rounded border-input"
                    data-testid="export-options-csv-headers"
                  />
                  <span>Include column headers</span>
                </label>
                <label className={checkboxLabelClassName}>
                  <input
                    type="checkbox"
                    checked={options.csv.nullAsEmpty}
                    onChange={() =>
                      setOptions((o) => ({
                        ...o,
                        csv: { ...o.csv, nullAsEmpty: !o.csv.nullAsEmpty },
                      }))
                    }
                    className="rounded border-input"
                    data-testid="export-options-csv-nullempty"
                  />
                  <span>Leave null fields empty</span>
                </label>
              </div>
            </div>
          )}

          {format === 'xlsx' && (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap gap-4">
                <label className={checkboxLabelClassName}>
                  <input
                    type="checkbox"
                    checked={options.xlsx.includeHeaders}
                    onChange={() =>
                      setOptions((o) => ({
                        ...o,
                        xlsx: { ...o.xlsx, includeHeaders: !o.xlsx.includeHeaders },
                      }))
                    }
                    className="rounded border-input"
                    data-testid="export-options-xlsx-headers"
                  />
                  <span>Include column headers</span>
                </label>
                <label className={checkboxLabelClassName}>
                  <input
                    type="checkbox"
                    checked={options.xlsx.boldHeaders}
                    onChange={() =>
                      setOptions((o) => ({
                        ...o,
                        xlsx: { ...o.xlsx, boldHeaders: !o.xlsx.boldHeaders },
                      }))
                    }
                    className="rounded border-input"
                    data-testid="export-options-xlsx-bold"
                  />
                  <span>Bold header row</span>
                </label>
                <label className={checkboxLabelClassName}>
                  <input
                    type="checkbox"
                    checked={options.xlsx.autoSize}
                    onChange={() =>
                      setOptions((o) => ({
                        ...o,
                        xlsx: { ...o.xlsx, autoSize: !o.xlsx.autoSize },
                      }))
                    }
                    className="rounded border-input"
                    data-testid="export-options-xlsx-autosize"
                  />
                  <span>Auto-size columns</span>
                </label>
              </div>
              <div className="flex flex-col gap-1">
                <Label className="text-xs">Alignment</Label>
                <select
                  value={options.xlsx.alignment}
                  onChange={(e) =>
                    setOptions((o) => ({
                      ...o,
                      xlsx: { ...o.xlsx, alignment: e.target.value as 'left' | 'center' | 'right' },
                    }))
                  }
                  className={cn(selectClassName, 'w-32')}
                  data-testid="export-options-xlsx-align"
                >
                  <option value="left">Left</option>
                  <option value="center">Center</option>
                  <option value="right">Right</option>
                </select>
              </div>
            </div>
          )}
        </div>
      )}

      <Card className="mb-4" data-testid="export-field-picker">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <ListChecks size={14} />
            <span>Fields</span>
          </CardTitle>
          <CardDescription>
            Scan a sample of documents to choose which fields to export.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!onScanFields || scanning}
              onClick={runScanFields}
              data-testid="export-scan-fields-btn"
            >
              {scanning ? 'Scanning…' : 'Scan fields'}
            </Button>
            {scannedFields.length > 0 && (
              <>
                <Input
                  value={fieldFilterText}
                  onChange={(e) => setFieldFilterText(e.target.value)}
                  placeholder="Filter fields"
                  className="h-8 w-40 text-xs"
                  data-testid="export-field-filter-input"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelectedFields(new Set(scannedFields))}
                  data-testid="export-field-select-all"
                >
                  Select all
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelectedFields(new Set())}
                  data-testid="export-field-deselect-all"
                >
                  Deselect all
                </Button>
              </>
            )}
          </div>

          {hasScanned && scannedFields.length === 0 ? (
            <span className="text-xs text-muted-foreground" data-testid="export-field-caption">
              No documents to scan — exporting all fields.
            </span>
          ) : scannedFields.length > 0 ? (
            <>
              <span className="text-xs text-muted-foreground" data-testid="export-field-caption">
                {selectedFields.size} of {scannedFields.length} selected
              </span>
              <div className="grid max-h-40 grid-cols-2 gap-x-4 gap-y-1 overflow-auto sm:grid-cols-3">
                {visibleScannedFields.map((f) => (
                  <label key={f} className={checkboxLabelClassName}>
                    <input
                      type="checkbox"
                      checked={selectedFields.has(f)}
                      onChange={() => toggleField(f)}
                      className="rounded border-input"
                      data-testid={`export-field-${f}`}
                    />
                    <span className="truncate">{f}</span>
                  </label>
                ))}
              </div>
            </>
          ) : null}

          {fieldSelectionActive && mode === 'find' && (
            <span
              className="text-xs text-muted-foreground"
              data-testid="export-field-selection-hint"
            >
              Projection disabled — using field selection
            </span>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Download size={14} />
              <span>Current Results</span>
            </CardTitle>
            <CardDescription>
              {currentResultCount} loaded document{currentResultCount === 1 ? '' : 's'}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!hasCurrentResults || !delimiterValid || noFieldsSelected}
              onClick={() => onExport(format, 'current', effectiveOptions, undefined)}
              data-testid="export-current-btn"
            >
              <Download size={13} />
              Export {format.toUpperCase()}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!hasCurrentResults || format === 'bson' || format === 'xlsx'}
              onClick={() => onCopyCurrent?.(format as 'json' | 'ndjson' | 'csv', effectiveOptions)}
              data-testid="export-copy-current-btn"
            >
              <Copy size={13} />
              Copy to clipboard
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Download size={14} />
              <span>Full Collection</span>
            </CardTitle>
            <CardDescription>Runs in the background and writes directly to disk.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              disabled={!delimiterValid || noFieldsSelected}
              onClick={() => onExport(format, 'full', effectiveOptions, undefined)}
              data-testid="export-full-btn"
            >
              <Download size={13} />
              Export {format.toUpperCase()}
            </Button>
          </CardContent>
        </Card>
      </div>

      <Card className="mt-4" data-testid="export-filtered-card">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Filter size={14} />
            <span>Filtered Results</span>
          </CardTitle>
          <CardDescription>
            {mode === 'aggregate'
              ? 'Edit the aggregation pipeline, then export every resulting document.'
              : 'Edit the query (reused from the document view), then export every match.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {mode === 'aggregate' ? (
            <div className="flex flex-col gap-1">
              <Label className="text-xs">Pipeline</Label>
              <div className={editorShell(pipelineCheck.ok)}>
                <QueryEditor
                  surface="aggStage"
                  value={pipeline}
                  onChange={setPipeline}
                  fields={fields}
                  schema={schema}
                  height={140}
                  data-testid="export-filtered-pipeline-input"
                />
              </div>
              {!pipelineCheck.ok && (
                <span className="text-xs text-destructive">{pipelineCheck.error}</span>
              )}
            </div>
          ) : (
            <div className="overflow-hidden rounded-md border border-border">
              <FindQueryBar
                filter={filter}
                projection={projection}
                sort={sort}
                onFilterChange={setFilter}
                onProjectionChange={setProjection}
                onSortChange={setSort}
                filterInvalid={!filterCheck.ok}
                projectionInvalid={!projectionCheck.ok}
                sortInvalid={!sortCheck.ok}
                fields={fields}
                schema={schema}
              />
            </div>
          )}

          {mode === 'find' && (
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!onCountFilter || !filterCheck.ok || counting}
                  onClick={runCount}
                  data-testid="export-filtered-count-btn"
                >
                  <Hash size={12} />
                  Count
                </Button>
                <span data-testid="export-filtered-count" className="text-xs text-muted-foreground">
                  {countLabel}
                </span>
              </div>
              <div className="flex flex-col gap-1">
                <Label className="text-xs">Skip</Label>
                <Input
                  type="number"
                  min={0}
                  value={skip}
                  onChange={(e) => setSkip(Number(e.target.value) || 0)}
                  className="h-8 w-24 text-xs"
                  data-testid="export-filtered-skip"
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label className="text-xs">Limit</Label>
                <Input
                  type="number"
                  min={0}
                  value={limit}
                  onChange={(e) => setLimit(Number(e.target.value) || 0)}
                  className="h-8 w-24 text-xs"
                  data-testid="export-filtered-limit"
                />
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              disabled={!canExportFiltered || !delimiterValid || noFieldsSelected}
              onClick={() => onExport(format, 'filtered', effectiveOptions, buildQuery())}
              data-testid="export-filtered-btn"
            >
              <Download size={13} />
              Export {format.toUpperCase()}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="mt-4" data-testid="export-preview-card">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Eye size={14} />
            <span>Preview</span>
          </CardTitle>
          <CardDescription>See a sample of the exported output before running.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!onPreview || format === 'bson' || format === 'xlsx' || previewing}
              onClick={runPreview}
              data-testid="export-preview-btn"
            >
              <Eye size={13} />
              {previewing ? 'Previewing…' : 'Preview'}
            </Button>
          </div>
          {(previewOutput !== null || previewError) && (
            <pre
              data-testid="export-preview-output"
              className="max-h-48 overflow-auto rounded-md border border-border bg-muted/30 p-2 text-xs"
            >
              {previewError ? `Preview failed: ${previewError}` : previewOutput}
            </pre>
          )}
        </CardContent>
      </Card>

      <p className="mt-4 text-xs text-muted-foreground">
        Filtered and full-collection exports run in the background. Track their progress in the{' '}
        <button type="button" className="underline hover:text-foreground" onClick={onOpenTasks}>
          Tasks
        </button>{' '}
        tab.
      </p>
    </div>
  );
};
