import React from 'react';
import { Download, FileJson, FileSpreadsheet, Filter, ListChecks } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

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
  /** Match count from the last run, shown until the first live recount resolves. */
  matchCount?: number | null;
}

interface ExportViewProps {
  connectionName: string;
  databaseName: string;
  collectionName: string;
  currentResultCount: number;
  /** Seeds the editable Filtered card from the source tab's active query. */
  filtered?: FilteredExportSeed;
  onExport: (
    format: 'json' | 'csv',
    scope: 'current' | 'full' | 'filtered',
    query?: FilteredExportQuery
  ) => void;
  /** Live recount for the Filtered (find) card; resolves the match count for a filter. */
  onCountFilter?: (filter: string) => Promise<number>;
  /** Open the dedicated Tasks tab where background jobs (incl. full exports) appear. */
  onOpenTasks?: () => void;
}

const COUNT_DEBOUNCE_MS = 400;

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

const fieldBase = cn(
  'w-full rounded-md border bg-background px-2 py-1.5 font-mono text-xs shadow-sm transition-colors',
  'placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
);

export const ExportView: React.FC<ExportViewProps> = ({
  connectionName,
  databaseName,
  collectionName,
  currentResultCount,
  filtered,
  onExport,
  onCountFilter,
  onOpenTasks,
}) => {
  const hasCurrentResults = currentResultCount > 0;
  const mode: 'find' | 'aggregate' = filtered?.kind ?? 'find';

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

  // Live, debounced recount as the find filter is edited.
  React.useEffect(() => {
    if (mode !== 'find' || !onCountFilter) return;
    const check = checkJsonObject(filter);
    if (!check.ok) {
      setCountError(check.error ?? 'Invalid filter JSON');
      return;
    }
    setCountError(null);
    let cancelled = false;
    const handle = setTimeout(() => {
      setCounting(true);
      onCountFilter(filter)
        .then((n) => {
          if (!cancelled) setCount(n);
        })
        .catch(() => {
          if (!cancelled) setCountError('Count failed');
        })
        .finally(() => {
          if (!cancelled) setCounting(false);
        });
    }, COUNT_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [filter, mode, onCountFilter]);

  const countLabel = (() => {
    if (mode === 'aggregate') return 'Count determined when the export runs';
    if (!filterCheck.ok) return filterCheck.error ?? 'Invalid filter JSON';
    if (counting) return 'Counting…';
    if (countError) return countError;
    if (typeof count === 'number') {
      return `${count.toLocaleString()} matching document${count === 1 ? '' : 's'}`;
    }
    return 'Edit the filter to export matching documents';
  })();

  const buildQuery = (): FilteredExportQuery =>
    mode === 'aggregate'
      ? { kind: 'aggregate', pipeline }
      : { kind: 'find', filter, sort, projection };

  const fieldClass = (valid: boolean) =>
    cn(fieldBase, valid ? 'border-input' : 'border-destructive focus-visible:ring-destructive');

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
              : 'Edit the query, then export every matching document.'}{' '}
            <span data-testid="export-filtered-count" className="text-muted-foreground">
              {countLabel}
            </span>
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {mode === 'aggregate' ? (
            <div className="flex flex-col gap-1">
              <Label htmlFor="filtered-pipeline" className="text-xs">
                Pipeline
              </Label>
              <textarea
                id="filtered-pipeline"
                value={pipeline}
                onChange={(e) => setPipeline(e.target.value)}
                rows={6}
                spellCheck={false}
                className={fieldClass(pipelineCheck.ok)}
                placeholder='[ { "$match": { } } ]'
                data-testid="export-filtered-pipeline-input"
              />
              {!pipelineCheck.ok && (
                <span className="text-xs text-destructive">{pipelineCheck.error}</span>
              )}
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-1">
                <Label htmlFor="filtered-filter" className="text-xs">
                  Filter
                </Label>
                <textarea
                  id="filtered-filter"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  rows={3}
                  spellCheck={false}
                  className={fieldClass(filterCheck.ok)}
                  placeholder='{ "status": "active" }'
                  data-testid="export-filtered-filter-input"
                />
                {!filterCheck.ok && (
                  <span className="text-xs text-destructive">{filterCheck.error}</span>
                )}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1">
                  <Label htmlFor="filtered-sort" className="text-xs">
                    Sort
                  </Label>
                  <textarea
                    id="filtered-sort"
                    value={sort}
                    onChange={(e) => setSort(e.target.value)}
                    rows={2}
                    spellCheck={false}
                    className={fieldClass(sortCheck.ok)}
                    placeholder='{ "createdAt": -1 }'
                    data-testid="export-filtered-sort-input"
                  />
                  {!sortCheck.ok && (
                    <span className="text-xs text-destructive">{sortCheck.error}</span>
                  )}
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="filtered-projection" className="text-xs">
                    Projection
                  </Label>
                  <textarea
                    id="filtered-projection"
                    value={projection}
                    onChange={(e) => setProjection(e.target.value)}
                    rows={2}
                    spellCheck={false}
                    className={fieldClass(projectionCheck.ok)}
                    placeholder='{ "_id": 0, "name": 1 }'
                    data-testid="export-filtered-projection-input"
                  />
                  {!projectionCheck.ok && (
                    <span className="text-xs text-destructive">{projectionCheck.error}</span>
                  )}
                </div>
              </div>
            </>
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
