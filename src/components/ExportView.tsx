import React from 'react';
import { Download, FileJson, FileSpreadsheet, Filter, ListChecks } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/** The active query on the source tab, exportable in full (all matches, not just the page). */
export interface FilteredExportInfo {
  /** A find filter (filter/sort/projection) or an aggregation pipeline. */
  kind: 'find' | 'aggregate';
  /** Short human description of the active query, shown in the card. */
  summary: string;
  /** Estimated number of matching documents (find only); null/undefined when unknown. */
  matchCount?: number | null;
  /** True when matchCount is an estimate rather than an exact count. */
  estimated?: boolean;
}

interface ExportViewProps {
  connectionName: string;
  databaseName: string;
  collectionName: string;
  currentResultCount: number;
  /** Present when a find/aggregate query has run on the source tab. */
  filtered?: FilteredExportInfo;
  onExport: (format: 'json' | 'csv', scope: 'current' | 'full' | 'filtered') => void;
  /** Open the dedicated Tasks tab where background jobs (incl. full exports) appear. */
  onOpenTasks?: () => void;
}

export const ExportView: React.FC<ExportViewProps> = ({
  connectionName,
  databaseName,
  collectionName,
  currentResultCount,
  filtered,
  onExport,
  onOpenTasks,
}) => {
  const hasCurrentResults = currentResultCount > 0;
  const hasFiltered = !!filtered;
  const matchCountLabel =
    filtered && typeof filtered.matchCount === 'number'
      ? `${filtered.matchCount.toLocaleString()}${filtered.estimated ? '~' : ''} matching document${filtered.matchCount === 1 ? '' : 's'}`
      : filtered?.kind === 'aggregate'
        ? 'Count determined when the export runs'
        : 'Run a query to enable';

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

        <Card data-testid="export-filtered-card">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Filter size={14} />
              <span>Filtered Results</span>
            </CardTitle>
            <CardDescription>
              {hasFiltered ? (
                <>
                  <span className="block truncate" title={filtered.summary}>
                    {filtered.summary}
                  </span>
                  <span className="text-muted-foreground">{matchCountLabel}</span>
                </>
              ) : (
                'Run a find query or aggregation, then export every match.'
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              disabled={!hasFiltered}
              onClick={() => onExport('json', 'filtered')}
              data-testid="export-filtered-json-btn"
            >
              <FileJson size={13} />
              JSON
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!hasFiltered}
              onClick={() => onExport('csv', 'filtered')}
              data-testid="export-filtered-csv-btn"
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
