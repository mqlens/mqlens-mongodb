import React from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { Download, Filter, ListChecks, Hash, Copy, Eye } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { QueryEditor } from './QueryEditor';
import { FindQueryBar } from './FindQueryBar';
import { useCollectionSchema } from '../lib/useCollectionSchema';
import { parseQueryObject, parseShellJson, shellDocErrorKey, shellDocErrorParams } from '../lib/shellDoc';

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

// Pure, module-scope validators — they can't call the useTranslation hook, so
// the component passes its `t` in at each call site.
type TFunc = (key: string, opts?: Record<string, unknown>) => string;

/**
 * What a validator reports: whether it parsed, why not, and the value to send.
 *
 * Deliberately a union rather than a struct with an always-present `value`. A
 * failed check has NO value — an earlier version handed back `{}`/`[]` as a
 * fallback, which reads as harmless and is not: `{}` is a filter that matches
 * everything, so a malformed query silently became "the whole collection"
 * instead of an error (#316 review). Making the field absent on failure means
 * the type stops anyone reaching for it without checking `ok` first.
 */
type FieldCheck =
  | {
      ok: true;
      /** Normalized Extended JSON for the backend — NOT the text the user typed. */
      value: string;
      error?: never;
    }
  | { ok: false; value?: never; error: string };

/**
 * Does this text parse as strict JSON of the wanted shape?
 *
 * The parsed value is deliberately thrown away — only the answer is used, and
 * the caller forwards the ORIGINAL TEXT. That is the whole point: `JSON.parse`
 * is itself lossy for 64-bit integers, so round-tripping through it would
 * corrupt the very values this check exists to protect.
 *
 * Text that is already strict JSON is exactly what the backend read before the
 * fields learned mongosh syntax, so handing it over untouched keeps that path
 * lossless. Routing it through the JS shell parser instead would silently
 * round an unwrapped integer past 2^53 — `{"counter": 9007199254740993}`
 * becomes `…992` and matches a different document (#316 review). Values the
 * shell parser produces are unaffected: `NumberLong("…")` survives, because
 * shellDoc serializes canonically whenever a Long is present.
 */
function isStrictJson(text: string, shape: 'object' | 'array'): boolean {
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== 'object') return false;
    return shape === 'array' ? Array.isArray(value) : !Array.isArray(value);
  } catch {
    return false;
  }
}

/**
 * Turn a parse failure into a message, preferring our own translated codes.
 *
 * Mirrors what the document view does with shellDocErrorKey: errors we raise
 * ourselves carry a code with a catalog entry (in the `documents` namespace,
 * which is where the shared parser's messages live), while the underlying
 * parser's own errors are only available in English.
 */
function parseErrorMessage(e: unknown, t: TFunc): string {
  const key = shellDocErrorKey(e);
  if (key) return t(`documents:${key}`, shellDocErrorParams(e));
  const message = e instanceof Error ? e.message : String(e);
  return message || t('transfer:exportView.errors.invalidQuery');
}

/**
 * Validate a find field the way the main query bar does.
 *
 * These were JSON.parse'd, so the export view rejected the very syntax the
 * document view accepts — regex literals, ObjectId(…), unquoted keys, pasted
 * smart quotes — and a filter that had just run could not be carried into an
 * export (#314). Parsing with the shared shell parser closes that gap.
 *
 * The parsed result is returned as Extended JSON, because that is what has to
 * reach the backend: the raw text used to be forwarded verbatim, which is why
 * only strict JSON could work end to end. The backend already reads Extended
 * JSON here (build_source → serde_json → BSON), the same as the find path, so
 * this needs no change on that side.
 *
 * '' and '{}' both mean "no filter", matching the query bar's convention.
 */
function checkQueryObject(raw: string, t: TFunc): FieldCheck {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '{}') return { ok: true, value: '{}' };
  if (isStrictJson(trimmed, 'object')) return { ok: true, value: trimmed };
  try {
    return { ok: true, value: JSON.stringify(parseQueryObject(trimmed)) };
  } catch (e) {
    return { ok: false, error: parseErrorMessage(e, t) };
  }
}

/**
 * Same, for the aggregation pipeline, which must be an array of stages.
 *
 * parseQueryObject is deliberately not reused: it rejects anything that is not
 * a plain object, which is right for a filter and wrong for a pipeline.
 */
function checkPipeline(raw: string, t: TFunc): FieldCheck {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '[]') return { ok: true, value: '[]' };
  if (isStrictJson(trimmed, 'array')) return { ok: true, value: trimmed };
  try {
    const value = parseShellJson(trimmed);
    if (!Array.isArray(value)) {
      return { ok: false, error: t('transfer:exportView.errors.pipelineMustBeArray') };
    }
    return { ok: true, value: JSON.stringify(value) };
  } catch (e) {
    return { ok: false, error: parseErrorMessage(e, t) };
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
  const { t } = useTranslation('transfer');
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

  const filterCheck = checkQueryObject(filter, t);
  const sortCheck = checkQueryObject(sort, t);
  const projectionCheck = checkQueryObject(projection, t);
  const pipelineCheck = checkPipeline(pipeline, t);
  // Gates every action that runs the filtered query — export, preview and
  // field scan alike. Preview and scan used to ignore it, so a malformed
  // query silently ran against the whole collection (#316 review).
  const filteredQueryValid =
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
    onCountFilter(filterCheck.value)
      .then((n) => setCount(n))
      .catch(() => setCountError(t('exportView.filtered.countFailed')))
      .finally(() => setCounting(false));
  };

  const countLabel = (() => {
    if (counting) return t('exportView.actions.counting');
    if (countError) return countError;
    if (typeof count === 'number') {
      return t('exportView.filtered.matchCount', { count, formatted: count.toLocaleString() });
    }
    return t('exportView.filtered.countNotRun');
  })();

  // Ship the PARSED value, not the text in the editor. The backend reads
  // Extended JSON, so forwarding raw text is what limited these fields to
  // strict JSON (#314) — `{name: /a/i}` is a valid query but not valid JSON.
  //
  // Returns undefined when the query does not parse, so a caller cannot get a
  // runnable query out of unrunnable input. Every caller is already gated on
  // `filteredQueryValid`; this is the backstop that makes a missed gate fail
  // closed instead of quietly running against the whole collection.
  const buildQuery = (): FilteredExportQuery | undefined => {
    if (mode === 'aggregate') {
      return pipelineCheck.ok ? { kind: 'aggregate', pipeline: pipelineCheck.value } : undefined;
    }
    if (!filterCheck.ok || !sortCheck.ok || !projectionCheck.ok) return undefined;
    return {
      kind: 'find',
      filter: filterCheck.value,
      sort: sortCheck.value,
      // A field selection replaces the projection editor entirely.
      projection: fieldSelectionActive ? '{}' : projectionCheck.value,
      skip,
      limit,
    };
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
    // `mode` is always find or aggregate, so this always sends a query. Bail
    // rather than fall back to undefined, which the scan reads as "sample the
    // whole collection" — the opposite of what a malformed filter should do.
    const query = buildQuery();
    if (!query) return;
    setScanning(true);
    onScanFields(query)
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
    const scope: 'current' | 'full' | 'filtered' = filtered ? 'filtered' : 'full';
    // A filtered preview without a parseable query would fall back to the
    // whole collection, which is exactly the wrong answer to show someone.
    // A 'full' preview has no query and is unaffected.
    const query = scope === 'filtered' ? buildQuery() : undefined;
    if (scope === 'filtered' && !query) return;
    setPreviewing(true);
    setPreviewError(null);
    onPreview(format, scope, effectiveOptions, query)
      .then((out) => setPreviewOutput(out))
      .catch((err) => setPreviewError(err instanceof Error ? err.message : String(err)))
      .finally(() => setPreviewing(false));
  };

  return (
    <div className="flex h-full flex-col overflow-auto" data-testid="export-view">
      <header className="flex items-center justify-between gap-4 border-b border-border bg-muted/30 px-3.5 py-2">
        <div>
          <h2 className="text-sm font-semibold text-foreground">{t('exportView.title')}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {connectionName} / {databaseName}.{collectionName}
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={onOpenTasks}>
          <ListChecks size={12} />
          {t('exportView.actions.viewTasks')}
        </Button>
      </header>

      {/* Full-bleed sections, document-viewer style: the tab itself is the box. */}
      <div className="divide-y divide-border">
      <section className="flex flex-wrap items-center gap-x-6 gap-y-2 px-3.5 py-2.5">
        <div className="flex flex-wrap items-center gap-3" data-testid="export-format-picker">
          <h3 className="text-sm font-medium text-foreground">{t('exportView.labels.format')}</h3>
          <div className="inline-flex rounded-md border border-border bg-background p-0.5">
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
        <div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-2" data-testid="export-options-panel">
          {(format === 'json' || format === 'ndjson') && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1" data-testid="export-options-json-mode">
              <Label className="text-xs text-muted-foreground">{t('exportView.labels.jsonMode')}</Label>
              <label className={checkboxLabelClassName}>
                <input
                  type="radio"
                  name="export-json-mode"
                  value="relaxed"
                  checked={options.jsonMode === 'relaxed'}
                  onChange={() => setOptions((o) => ({ ...o, jsonMode: 'relaxed' }))}
                />
                <span>
                  {t('exportView.labels.relaxed')}{' '}
                  <span className="text-muted-foreground">— {t('exportView.labels.relaxedHint')}</span>
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
                  {t('exportView.labels.canonical')}{' '}
                  <span className="text-muted-foreground">
                    — {t('exportView.labels.canonicalHint')}
                  </span>
                </span>
              </label>
            </div>
          )}

          {format === 'csv' && (
            <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
                <div className="flex flex-col gap-1">
                  <Label className="text-xs">{t('exportView.labels.delimiter')}</Label>
                  <select
                    value={delimiterChoice}
                    onChange={(e) =>
                      setDelimiterChoice(e.target.value as ',' | ';' | '\t' | 'custom')
                    }
                    className={selectClassName}
                    data-testid="export-options-csv-delimiter"
                  >
                    <option value=",">{t('exportView.labels.comma')}</option>
                    <option value=";">{t('exportView.labels.semicolon')}</option>
                    <option value={'\t'}>{t('exportView.labels.tab')}</option>
                    <option value="custom">{t('exportView.labels.custom')}</option>
                  </select>
                </div>
                {delimiterChoice === 'custom' && (
                  <div className="flex flex-col gap-1">
                    <Label className="text-xs">{t('exportView.labels.customDelimiter')}</Label>
                    <Input
                      value={customDelimiter}
                      onChange={(e) => setCustomDelimiter(e.target.value)}
                      className="h-8 w-20 text-xs"
                      data-testid="export-options-csv-delimiter-custom"
                    />
                  </div>
                )}
                <div className="flex flex-col gap-1">
                  <Label className="text-xs">{t('exportView.labels.quote')}</Label>
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
                  <Label className="text-xs">{t('exportView.labels.recordSeparator')}</Label>
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
                    <option value={'\n'}>{t('exportView.labels.lf')}</option>
                    <option value={'\r\n'}>{t('exportView.labels.crlf')}</option>
                  </select>
                </div>
              <div className="flex flex-wrap items-center gap-4 pb-2">
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
                  <span>{t('exportView.labels.includeHeaders')}</span>
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
                  <span>{t('exportView.labels.leaveNullEmpty')}</span>
                </label>
              </div>
              {!delimiterValid && (
                <span className="w-full text-xs text-destructive">
                  {t('transfer:exportView.errors.delimiterAscii')}
                </span>
              )}
            </div>
          )}

          {format === 'xlsx' && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
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
                  <span>{t('exportView.labels.includeHeaders')}</span>
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
                  <span>{t('exportView.labels.boldHeaderRow')}</span>
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
                  <span>{t('exportView.labels.autoSizeColumns')}</span>
                </label>
              <div className="flex items-center gap-2">
                <Label className="text-xs text-muted-foreground">{t('exportView.labels.alignment')}</Label>
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
                  <option value="left">{t('exportView.labels.left')}</option>
                  <option value="center">{t('exportView.labels.center')}</option>
                  <option value="right">{t('exportView.labels.right')}</option>
                </select>
              </div>
            </div>
          )}
        </div>
      )}
      </section>

      <section className="flex flex-col gap-2 px-3.5 py-3" data-testid="export-field-picker">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
            <ListChecks size={14} />
            <span>{t('exportView.fields.title')}</span>
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t('exportView.fields.hint')}
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!onScanFields || scanning || !filteredQueryValid}
              onClick={runScanFields}
              data-testid="export-scan-fields-btn"
            >
              {scanning ? t('exportView.actions.scanning') : t('exportView.actions.scanFields')}
            </Button>
            {scannedFields.length > 0 && (
              <>
                <Input
                  value={fieldFilterText}
                  onChange={(e) => setFieldFilterText(e.target.value)}
                  placeholder={t('exportView.fields.filterPlaceholder')}
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
                  {t('exportView.actions.selectAll')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelectedFields(new Set())}
                  data-testid="export-field-deselect-all"
                >
                  {t('exportView.actions.deselectAll')}
                </Button>
              </>
            )}
          </div>

          {hasScanned && scannedFields.length === 0 ? (
            <span className="text-xs text-muted-foreground" data-testid="export-field-caption">
              {t('exportView.fields.noneToScan')}
            </span>
          ) : scannedFields.length > 0 ? (
            <>
              <span className="text-xs text-muted-foreground" data-testid="export-field-caption">
                {t('exportView.fields.selectedCount', { selected: selectedFields.size, total: scannedFields.length })}
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
              {t('exportView.fields.projectionDisabled')}
            </span>
          )}
        </div>
      </section>

      <section className="flex flex-wrap items-center justify-between gap-3 px-3.5 py-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Download size={14} />
            <span>{t('exportView.current.title')}</span>
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t('exportView.current.loadedCount', { count: currentResultCount })}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!hasCurrentResults || !delimiterValid || noFieldsSelected}
            onClick={() => onExport(format, 'current', effectiveOptions, undefined)}
            data-testid="export-current-btn"
          >
            <Download size={13} />
            {t('exportView.actions.exportFormat', { format: format.toUpperCase() })}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!hasCurrentResults || format === 'bson' || format === 'xlsx' || noFieldsSelected}
            onClick={() => onCopyCurrent?.(format as 'json' | 'ndjson' | 'csv', effectiveOptions)}
            data-testid="export-copy-current-btn"
          >
            <Copy size={13} />
            {t('exportView.actions.copyToClipboard')}
          </Button>
        </div>
      </section>

      <section className="flex flex-wrap items-center justify-between gap-3 px-3.5 py-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Download size={14} />
            <span>{t('exportView.full.title')}</span>
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t('exportView.full.hint')}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          disabled={!delimiterValid || noFieldsSelected}
          onClick={() => onExport(format, 'full', effectiveOptions, undefined)}
          data-testid="export-full-btn"
        >
          <Download size={13} />
          {t('exportView.actions.exportFormat', { format: format.toUpperCase() })}
        </Button>
      </section>

      <section className="flex flex-col gap-3 px-3.5 py-3" data-testid="export-filtered-card">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Filter size={14} />
            <span>{t('exportView.filtered.title')}</span>
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {mode === 'aggregate'
              ? t('exportView.filtered.hintAggregate')
              : t('exportView.filtered.hintFind')}
          </p>
        </div>
        <div className="flex flex-col gap-3">
          {mode === 'aggregate' ? (
            <div className="flex flex-col gap-1">
              <Label className="text-xs">{t('exportView.filtered.pipeline')}</Label>
              <div className={editorShell(pipelineCheck.ok)}>
                <QueryEditor
                  surface="aggStage"
                  shellSyntax
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
                filterError={filterCheck.error}
                projectionInvalid={!projectionCheck.ok}
                sortInvalid={!sortCheck.ok}
                fields={fields}
                schema={schema}
                // These fields parse mongosh syntax now, so the completions
                // must offer it too — bare keys and ObjectId()/ISODate()
                // rather than EJSON wrappers, matching the document view.
                shellSyntax
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
                  {t('exportView.actions.count')}
                </Button>
                <span data-testid="export-filtered-count" className="text-xs text-muted-foreground">
                  {countLabel}
                </span>
              </div>
              <div className="flex flex-col gap-1">
                <Label className="text-xs">{t('exportView.labels.skip')}</Label>
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
                <Label className="text-xs">{t('exportView.labels.limit')}</Label>
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
              disabled={!filteredQueryValid || !delimiterValid || noFieldsSelected}
              onClick={() => onExport(format, 'filtered', effectiveOptions, buildQuery())}
              data-testid="export-filtered-btn"
            >
              <Download size={13} />
              {t('exportView.actions.exportFormat', { format: format.toUpperCase() })}
            </Button>
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-2 px-3.5 py-3" data-testid="export-preview-card">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
              <Eye size={14} />
              <span>{t('exportView.preview.title')}</span>
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('exportView.preview.hint')}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!onPreview || format === 'bson' || format === 'xlsx' || previewing || (!!filtered && !filteredQueryValid)}
            onClick={runPreview}
            data-testid="export-preview-btn"
          >
            <Eye size={13} />
            {previewing ? t('exportView.actions.previewing') : t('exportView.actions.preview')}
          </Button>
        </div>
        {(previewOutput !== null || previewError) && (
          <pre
            data-testid="export-preview-output"
            className="max-h-48 overflow-auto rounded-md border border-border bg-muted/30 p-2 text-xs"
          >
            {previewError ? t('exportView.preview.failed', { error: previewError }) : previewOutput}
          </pre>
        )}
      </section>
      </div>

      <p className="px-3.5 py-3 text-xs text-muted-foreground">
        <Trans i18nKey="exportView.footer.backgroundNote" t={t}>
          Filtered and full-collection exports run in the background. Track their progress in the{' '}
          <button type="button" className="underline hover:text-foreground" onClick={onOpenTasks}>
            Tasks
          </button>{' '}
          tab.
        </Trans>
      </p>
    </div>
  );
};
