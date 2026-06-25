import React from 'react';
import { Download, FileJson, FileSpreadsheet, Filter, ListChecks, Hash } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { QueryEditor } from './QueryEditor';
import { FindQueryBar } from './FindQueryBar';
import { useCollectionSchema } from '../lib/useCollectionSchema';

/** The edited query the user chose to export from the Filtered card. */
export type FilteredExportQuery =
  | { kind: 'find'; filter: string; sort: string; projection: string }
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
    format: 'json' | 'csv',
    scope: 'current' | 'full' | 'filtered',
    query?: FilteredExportQuery
  ) => void;
  /** Resolve the match count for a filter (run on demand via the Count button). */
  onCountFilter?: (filter: string) => Promise<number>;
  /** Open the dedicated Tasks tab where background jobs (incl. full exports) appear. */
  onOpenTasks?: () => void;
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

  const filterCheck = checkJsonObject(filter);
  const sortCheck = checkJsonObject(sort);
  const projectionCheck = checkJsonObject(projection);
  const pipelineCheck = checkJsonArray(pipeline);
  const canExportFiltered =
    mode === 'aggregate'
      ? pipelineCheck.ok
      : filterCheck.ok && sortCheck.ok && projectionCheck.ok;

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
      : { kind: 'find', filter, sort, projection };

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
              disabled={!hasCurrentResults}
              onClick={() => onExport('json', 'current')}
              data-testid="export-current-json-btn"
            >
              <FileJson size={13} />
              JSON
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!hasCurrentResults}
              onClick={() => onExport('csv', 'current')}
              data-testid="export-current-csv-btn"
            >
              <FileSpreadsheet size={13} />
              CSV
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
              onClick={() => onExport('json', 'full')}
              data-testid="export-full-json-btn"
            >
              <FileJson size={13} />
              JSON
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => onExport('csv', 'full')}
              data-testid="export-full-csv-btn"
            >
              <FileSpreadsheet size={13} />
              CSV
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
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              disabled={!canExportFiltered}
              onClick={() => onExport('json', 'filtered', buildQuery())}
              data-testid="export-filtered-json-btn"
            >
              <FileJson size={13} />
              JSON
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!canExportFiltered}
              onClick={() => onExport('csv', 'filtered', buildQuery())}
              data-testid="export-filtered-csv-btn"
            >
              <FileSpreadsheet size={13} />
              CSV
            </Button>
          </div>
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
