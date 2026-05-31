import React from 'react';
import { Download, FileJson, FileSpreadsheet, RefreshCw } from 'lucide-react';
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
    <div className="mql-export-view" data-testid="export-view">
      <header className="mql-export-header">
        <div>
          <div className="mql-export-title">Export</div>
          <div className="mql-export-subtitle">
            {connectionName} / {databaseName}.{collectionName}
          </div>
        </div>
        <button type="button" className="mql-btn mql-btn-outlined" onClick={onRefreshTasks}>
          <RefreshCw size={12} />
          Refresh Tasks
        </button>
      </header>

      <div className="mql-export-grid">
        <section className="mql-export-panel">
          <div className="mql-export-panel-h">
            <Download size={14} />
            <span>Current Results</span>
          </div>
          <div className="mql-export-panel-copy">
            {currentResultCount} loaded document{currentResultCount === 1 ? '' : 's'}
          </div>
          <div className="mql-export-actions">
            <button
              type="button"
              className="mql-btn mql-btn-outlined"
              disabled={!hasCurrentResults}
              onClick={() => onExport('json', 'current')}
              data-testid="export-current-json-btn"
            >
              <FileJson size={13} />
              JSON
            </button>
            <button
              type="button"
              className="mql-btn mql-btn-outlined"
              disabled={!hasCurrentResults}
              onClick={() => onExport('csv', 'current')}
              data-testid="export-current-csv-btn"
            >
              <FileSpreadsheet size={13} />
              CSV
            </button>
          </div>
        </section>

        <section className="mql-export-panel">
          <div className="mql-export-panel-h">
            <Download size={14} />
            <span>Full Collection</span>
          </div>
          <div className="mql-export-panel-copy">
            Runs in the background and writes directly to disk.
          </div>
          <div className="mql-export-actions">
            <button
              type="button"
              className="mql-btn mql-btn-primary"
              onClick={() => onExport('json', 'full')}
              data-testid="export-full-json-btn"
            >
              <FileJson size={13} />
              JSON
            </button>
            <button
              type="button"
              className="mql-btn mql-btn-primary"
              onClick={() => onExport('csv', 'full')}
              data-testid="export-full-csv-btn"
            >
              <FileSpreadsheet size={13} />
              CSV
            </button>
          </div>
        </section>
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
