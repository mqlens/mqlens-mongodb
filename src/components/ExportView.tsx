import React from 'react';
import { Download, FileJson, FileSpreadsheet, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { TaskManager, type ExportTaskInfo } from './TaskManager';

interface ExportViewProps {
  connectionName: string;
  databaseName: string;
  collectionName: string;
  currentResultCount: number;
  tasks: ExportTaskInfo[];
  onExport: (format: 'json' | 'csv', scope: 'current' | 'full') => void;
  onRefreshTasks: () => void;
  onClearFinishedTasks: () => void;
}

export const ExportView: React.FC<ExportViewProps> = ({
  connectionName,
  databaseName,
  collectionName,
  currentResultCount,
  tasks,
  onExport,
  onRefreshTasks,
  onClearFinishedTasks,
}) => {
  const hasCurrentResults = currentResultCount > 0;

  return (
    <div className="flex h-full flex-col overflow-auto p-4" data-testid="export-view">
      <header className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Export</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {connectionName} / {databaseName}.{collectionName}
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={onRefreshTasks}>
          <RefreshCw size={12} />
          Refresh Tasks
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

      <TaskManager
        tasks={tasks}
        onRefresh={onRefreshTasks}
        onClearFinished={onClearFinishedTasks}
        variant="embedded"
      />
    </div>
  );
};
