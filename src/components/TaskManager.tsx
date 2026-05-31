import React from 'react';
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, Trash2 } from 'lucide-react';

export interface ExportTaskInfo {
  id: string;
  kind: string;
  label: string;
  status: 'running' | 'completed' | 'failed' | string;
  processed: number;
  total?: number | null;
  message: string;
  path?: string | null;
  error?: string | null;
  createdAtMs: number;
  finishedAtMs?: number | null;
}

interface TaskManagerProps {
  tasks: ExportTaskInfo[];
  onRefresh: () => void;
  onClearFinished: () => void;
  variant?: 'floating' | 'embedded';
}

const taskPercent = (task: ExportTaskInfo) => {
  if (!task.total || task.total <= 0) return null;
  return Math.min(100, Math.round((task.processed / task.total) * 100));
};

export const TaskManager: React.FC<TaskManagerProps> = ({
  tasks,
  onRefresh,
  onClearFinished,
  variant = 'floating',
}) => {
  const running = tasks.filter((task) => task.status === 'running').length;

  return (
    <section className={`mql-task-manager is-${variant}`} data-testid="task-manager" aria-label="Task manager">
      <div className="mql-task-manager-h">
        <div className="mql-task-title">
          <span>Tasks</span>
          {running > 0 && <span className="mql-task-count">{running} running</span>}
        </div>
        <div className="mql-task-actions">
          <button type="button" className="mql-icon-btn" onClick={onRefresh} title="Refresh tasks" aria-label="Refresh tasks">
            <RefreshCw size={12} />
          </button>
          <button type="button" className="mql-icon-btn" onClick={onClearFinished} title="Clear finished tasks" aria-label="Clear finished tasks">
            <Trash2 size={12} />
          </button>
        </div>
      </div>

      <div className="mql-task-list">
        {tasks.length === 0 && (
          <div className="mql-task-empty" data-testid="task-empty">
            No export tasks yet.
          </div>
        )}
        {tasks.map((task) => {
          const percent = taskPercent(task);
          const isRunning = task.status === 'running';
          const isFailed = task.status === 'failed';
          return (
            <div key={task.id} className={`mql-task-row is-${task.status}`} data-testid="task-row">
              <div className="mql-task-icon" aria-hidden="true">
                {isRunning ? (
                  <Loader2 size={13} className="mql-task-spin" />
                ) : isFailed ? (
                  <AlertTriangle size={13} />
                ) : (
                  <CheckCircle2 size={13} />
                )}
              </div>
              <div className="mql-task-body">
                <div className="mql-task-line">
                  <span className="mql-task-label" title={task.label}>{task.label}</span>
                  <span className="mql-task-status">{percent === null ? task.status : `${percent}%`}</span>
                </div>
                <div className="mql-task-meta">
                  {task.error || task.message}
                  {task.total !== null && task.total !== undefined && (
                    <span className="mql-task-docs">
                      {task.processed}/{task.total}
                    </span>
                  )}
                </div>
                <div className="mql-progress" aria-hidden="true">
                  <div
                    className="mql-progress-fill"
                    style={{ width: `${percent ?? (isRunning ? 18 : 100)}%` }}
                  />
                </div>
                {task.path && <div className="mql-task-path" title={task.path}>{task.path}</div>}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
};
