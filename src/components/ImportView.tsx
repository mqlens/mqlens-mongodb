import React from 'react';
import { Upload, ListChecks } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

/** File formats the import view can read. */
export type ImportFormat = 'json' | 'ndjson' | 'csv' | 'bson';

/** Column type override for CSV field coercion. */
export type CsvColumnType = 'auto' | 'string' | 'number' | 'boolean' | 'date' | 'json';

/** CSV-specific import options. */
export interface CsvImportOptions {
  /** Single char; UI presets , ; \t plus a custom character. */
  delimiter: string;
  quote: string;
  skipLines: number;
  hasHeaders: boolean;
  /** Per-column type overrides, keyed by column name. Populated by a later task's preview. */
  columnTypes: Record<string, CsvColumnType>;
}

export const DEFAULT_CSV_IMPORT_OPTIONS: CsvImportOptions = {
  delimiter: ',',
  quote: '"',
  skipLines: 0,
  hasHeaders: true,
  columnTypes: {},
};

/** The chosen input: a file on disk or pasted text. */
export interface ImportSource {
  path?: string;
  text?: string;
}

/** Sample rows/columns from a preview run (produced by a later task). */
export interface ImportPreviewData {
  docs: string[];
  columns: string[];
  totalHint: number | null;
  error: string | null;
}

/** Pasted text over this size should be saved to a file and imported that way instead. */
export const PASTE_LIMIT = 2_000_000;

/** Map a file path's extension to an import format, case-insensitive. */
export function detectImportFormat(path: string): ImportFormat {
  const lower = path.toLowerCase();
  if (lower.endsWith('.bson')) return 'bson';
  if (lower.endsWith('.csv')) return 'csv';
  if (lower.endsWith('.jsonl') || lower.endsWith('.ndjson')) return 'ndjson';
  return 'json';
}

interface ImportViewProps {
  connectionName: string;
  databaseName: string;
  collectionName: string;
  onPickFile: () => Promise<string | null>;
  onPreview?: (
    source: ImportSource,
    format: ImportFormat,
    csvOptions: CsvImportOptions
  ) => Promise<ImportPreviewData>;
  onRunImport: (
    source: ImportSource,
    format: ImportFormat,
    csvOptions: CsvImportOptions,
    mode: 'skip' | 'update' | 'abort'
  ) => void;
  onOpenTasks?: () => void;
}

const IMPORT_FORMATS: { value: ImportFormat; label: string }[] = [
  { value: 'json', label: 'JSON array' },
  { value: 'ndjson', label: 'NDJSON' },
  { value: 'csv', label: 'CSV' },
  { value: 'bson', label: 'BSON' },
];

const selectClassName =
  'h-8 min-w-0 rounded-md border border-input bg-background px-2 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

const checkboxLabelClassName = 'flex cursor-pointer items-center gap-2 text-xs text-foreground';

const CSV_COLUMN_TYPES: CsvColumnType[] = ['auto', 'string', 'number', 'boolean', 'date', 'json'];

const PREVIEW_DEBOUNCE_MS = 300;

export const ImportView: React.FC<ImportViewProps> = ({
  connectionName,
  databaseName,
  collectionName,
  onPickFile,
  onPreview,
  onRunImport,
  onOpenTasks,
}) => {
  const [sourceKind, setSourceKind] = React.useState<'file' | 'paste'>('file');
  const [filePath, setFilePath] = React.useState<string | null>(null);
  const [text, setText] = React.useState('');
  const [format, setFormat] = React.useState<ImportFormat>('json');
  const [csvOptions, setCsvOptions] = React.useState<Omit<CsvImportOptions, 'delimiter'>>({
    quote: DEFAULT_CSV_IMPORT_OPTIONS.quote,
    skipLines: DEFAULT_CSV_IMPORT_OPTIONS.skipLines,
    hasHeaders: DEFAULT_CSV_IMPORT_OPTIONS.hasHeaders,
    columnTypes: DEFAULT_CSV_IMPORT_OPTIONS.columnTypes,
  });
  const [delimiterChoice, setDelimiterChoice] = React.useState<',' | ';' | '\t' | 'custom'>(',');
  const [customDelimiter, setCustomDelimiter] = React.useState('|');
  const [mode, setMode] = React.useState<'skip' | 'update' | 'abort'>('skip');
  const [preview, setPreview] = React.useState<ImportPreviewData | null>(null);

  const effectiveDelimiter = delimiterChoice === 'custom' ? customDelimiter : delimiterChoice;
  const delimiterValid =
    format !== 'csv' || (effectiveDelimiter.length === 1 && /^[\x00-\x7F]$/.test(effectiveDelimiter));
  const quoteValid = format !== 'csv' || csvOptions.quote.length === 1;

  const effectiveCsvOptions: CsvImportOptions = {
    ...csvOptions,
    delimiter: effectiveDelimiter,
  };

  const pasteOverCap = text.length > PASTE_LIMIT;

  const hasSource =
    sourceKind === 'file' ? filePath !== null : text.length > 0 && !pasteOverCap;

  const canRun = hasSource && delimiterValid && quoteValid && preview?.error == null;

  React.useEffect(() => {
    if (!hasSource || !onPreview) {
      setPreview(null);
      return;
    }
    const source: ImportSource = sourceKind === 'file' ? { path: filePath! } : { text };
    const timer = setTimeout(() => {
      onPreview(source, format, effectiveCsvOptions)
        .then(setPreview)
        .catch((err) => setPreview({ docs: [], columns: [], totalHint: null, error: String(err) }));
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // columnTypes changes intentionally excluded — they affect import, not the raw preview parse.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    sourceKind,
    filePath,
    text,
    format,
    delimiterChoice,
    customDelimiter,
    csvOptions.quote,
    csvOptions.skipLines,
    csvOptions.hasHeaders,
  ]);

  const setColumnType = (column: string, type: CsvColumnType) => {
    setCsvOptions((o) => {
      const columnTypes = { ...o.columnTypes };
      if (type === 'auto') {
        delete columnTypes[column];
      } else {
        columnTypes[column] = type;
      }
      return { ...o, columnTypes };
    });
  };

  const pickFile = async () => {
    const path = await onPickFile();
    if (!path) return;
    setFilePath(path);
    setFormat(detectImportFormat(path));
  };

  const selectSourceKind = (kind: 'file' | 'paste') => {
    setSourceKind(kind);
    if (kind === 'paste' && format === 'bson') setFormat('json');
  };

  const runImport = () => {
    if (!canRun) return;
    const source: ImportSource =
      sourceKind === 'file' ? { path: filePath! } : { text };
    onRunImport(source, format, effectiveCsvOptions, mode);
  };

  return (
    <div className="flex h-full flex-col overflow-auto" data-testid="import-view">
      <header className="flex items-center justify-between gap-4 border-b border-border bg-muted/30 px-3.5 py-2">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Import</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {connectionName} / {databaseName}.{collectionName}
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={onOpenTasks}>
          <ListChecks size={12} />
          View Tasks
        </Button>
      </header>

      <div className="divide-y divide-border">
        <section className="flex flex-col gap-2 px-3.5 py-3">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
              <Upload size={14} />
              <span>Source</span>
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Choose a file to import, or paste documents directly.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-4">
            <label className={checkboxLabelClassName}>
              <input
                type="radio"
                name="import-source-kind"
                data-testid="import-source-file"
                checked={sourceKind === 'file'}
                onChange={() => selectSourceKind('file')}
              />
              <span>File</span>
            </label>
            <label className={checkboxLabelClassName}>
              <input
                type="radio"
                name="import-source-kind"
                data-testid="import-source-paste"
                checked={sourceKind === 'paste'}
                onChange={() => selectSourceKind('paste')}
              />
              <span>Paste</span>
            </label>
          </div>

          {sourceKind === 'file' ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={pickFile}
                data-testid="import-pick-file-btn"
              >
                Choose file…
              </Button>
              {filePath && (
                <span
                  className="truncate text-xs text-muted-foreground"
                  data-testid="import-file-path"
                >
                  {filePath}
                </span>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                className="h-32 w-full rounded-md border border-input bg-background px-2 py-1.5 font-mono text-xs shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                data-testid="import-paste-textarea"
              />
              {pasteOverCap && (
                <span className="text-xs text-destructive" data-testid="import-paste-cap-note">
                  paste is limited to 2 MB — save it as a file and import that
                </span>
              )}
            </div>
          )}

          <div className="flex items-center gap-2">
            <Label className="text-xs text-muted-foreground">Format</Label>
            <select
              value={format}
              onChange={(e) => setFormat(e.target.value as ImportFormat)}
              className={cn(selectClassName, 'w-40')}
              data-testid="import-format-select"
            >
              {IMPORT_FORMATS.map((f) => (
                <option key={f.value} value={f.value} disabled={f.value === 'bson' && sourceKind === 'paste'}>
                  {f.label}
                </option>
              ))}
            </select>
          </div>
        </section>

        {format === 'csv' && (
          <section className="flex flex-wrap items-end gap-x-4 gap-y-2 px-3.5 py-3">
            <div className="flex flex-col gap-1">
              <Label className="text-xs">Delimiter</Label>
              <select
                value={delimiterChoice}
                onChange={(e) => setDelimiterChoice(e.target.value as ',' | ';' | '\t' | 'custom')}
                className={selectClassName}
                data-testid="import-csv-delimiter"
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
                  data-testid="import-csv-delimiter-custom"
                />
              </div>
            )}
            <div className="flex flex-col gap-1">
              <Label className="text-xs">Quote</Label>
              <Input
                value={csvOptions.quote}
                onChange={(e) => setCsvOptions((o) => ({ ...o, quote: e.target.value }))}
                className="h-8 w-16 text-xs"
                data-testid="import-csv-quote"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs">Skip lines</Label>
              <Input
                type="number"
                min={0}
                value={csvOptions.skipLines}
                onChange={(e) =>
                  setCsvOptions((o) => ({ ...o, skipLines: Number(e.target.value) || 0 }))
                }
                className="h-8 w-24 text-xs"
                data-testid="import-csv-skiplines"
              />
            </div>
            <div className="flex items-center gap-4 pb-2">
              <label className={checkboxLabelClassName}>
                <input
                  type="checkbox"
                  checked={csvOptions.hasHeaders}
                  onChange={() =>
                    setCsvOptions((o) => ({ ...o, hasHeaders: !o.hasHeaders }))
                  }
                  className="rounded border-input"
                  data-testid="import-csv-headers"
                />
                <span>First row is headers</span>
              </label>
            </div>
            {!delimiterValid && (
              <span className="w-full text-xs text-destructive">
                Delimiter must be a single ASCII character.
              </span>
            )}
            {!quoteValid && (
              <span className="w-full text-xs text-destructive">
                Quote must be a single character.
              </span>
            )}
          </section>
        )}

        <section className="flex flex-col gap-2 px-3.5 py-3" data-testid="import-preview-section">
          <div>
            <h3 className="text-sm font-medium text-foreground">Preview</h3>
            <p className="mt-0.5 text-xs text-muted-foreground" data-testid="import-preview-caption">
              {preview
                ? `Previewing first ${preview.docs.length} document(s)` +
                  (preview.totalHint !== null ? ` of ~${preview.totalHint}` : '')
                : 'Choose a source to preview'}
            </p>
          </div>
          {preview?.error && (
            <div data-testid="import-preview-error" className="text-xs text-destructive">
              {preview.error}
            </div>
          )}
          {preview && format === 'csv' && preview.columns.length > 0 && (
            <div className="max-h-64 overflow-auto">
              <table data-testid="import-preview-grid" className="w-full border-collapse text-xs">
                <thead>
                  <tr>
                    {preview.columns.map((col) => (
                      <th
                        key={col}
                        className="border border-border bg-muted/30 px-2 py-1 text-left align-top font-medium"
                      >
                        <div className="flex flex-col gap-1">
                          <span className="truncate">{col}</span>
                          <select
                            value={csvOptions.columnTypes[col] ?? 'auto'}
                            onChange={(e) => setColumnType(col, e.target.value as CsvColumnType)}
                            className={selectClassName}
                            data-testid={'import-coltype-' + col}
                          >
                            {CSV_COLUMN_TYPES.map((t) => (
                              <option key={t} value={t}>
                                {t}
                              </option>
                            ))}
                          </select>
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.docs.map((doc, i) => {
                    let parsed: Record<string, unknown> = {};
                    try {
                      parsed = JSON.parse(doc) as Record<string, unknown>;
                    } catch {
                      // leave the row empty if a preview doc is malformed
                    }
                    return (
                      <tr key={i}>
                        {preview.columns.map((col) => (
                          <td key={col} className="border border-border px-2 py-1">
                            {String(parsed[col] ?? '')}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {preview && (format !== 'csv' || preview.columns.length === 0) && preview.docs.length > 0 && (
            <pre
              data-testid="import-preview-docs"
              className="max-h-64 overflow-auto rounded-md border border-border bg-muted/30 p-2 text-xs"
            >
              {preview.docs
                .map((d) => {
                  try {
                    return JSON.stringify(JSON.parse(d), null, 2);
                  } catch {
                    return d;
                  }
                })
                .join('\n')}
            </pre>
          )}
        </section>

        <section className="flex flex-col gap-2 px-3.5 py-3">
          <div>
            <h3 className="text-sm font-medium text-foreground">Duplicate handling</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              How should existing documents with the same _id be handled?
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <label className={checkboxLabelClassName}>
              <input
                type="radio"
                name="import-mode"
                data-testid="import-mode-skip"
                checked={mode === 'skip'}
                onChange={() => setMode('skip')}
              />
              <span>Skip duplicates (insert new only)</span>
            </label>
            <label className={checkboxLabelClassName}>
              <input
                type="radio"
                name="import-mode"
                data-testid="import-mode-update"
                checked={mode === 'update'}
                onChange={() => setMode('update')}
              />
              <span>Update existing by _id</span>
            </label>
            <label className={checkboxLabelClassName}>
              <input
                type="radio"
                name="import-mode"
                data-testid="import-mode-abort"
                checked={mode === 'abort'}
                onChange={() => setMode('abort')}
              />
              <span>Abort if any _id already exists</span>
            </label>
          </div>
        </section>

        <section className="flex flex-wrap items-center justify-between gap-3 px-3.5 py-3">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
              <Upload size={14} />
              <span>Run</span>
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Runs in the background and reports progress in the Tasks tab.
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            disabled={!canRun}
            onClick={runImport}
            data-testid="import-run-btn"
          >
            <Upload size={13} />
            Import
          </Button>
        </section>
      </div>

      <p className="px-3.5 py-3 text-xs text-muted-foreground">
        Imports run in the background. Track their progress in the{' '}
        <button type="button" className="underline hover:text-foreground" onClick={onOpenTasks}>
          Tasks
        </button>{' '}
        tab.
      </p>
    </div>
  );
};
