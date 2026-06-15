import React from 'react';
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

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
    <Card
      className={cn(
        'flex flex-col overflow-hidden',
        variant === 'floating' && 'fixed bottom-4 right-4 z-40 w-80 shadow-lg',
        variant === 'embedded' && 'mt-4 border-0 shadow-none bg-transparent'
      )}
      data-testid="task-manager"
      aria-label="Task manager"
    >
      <CardHeader className="flex flex-row items-center justify-between space-y-0 border-b border-border py-2 px-3">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <span>Tasks</span>
          {running > 0 && (
            <Badge variant="secondary" className="text-[10px]">
              {running} running
            </Badge>
          )}
        </CardTitle>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={onRefresh}
            title="Refresh tasks"
            aria-label="Refresh tasks"
          >
            <RefreshCw size={12} />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={onClearFinished}
            title="Clear finished tasks"
            aria-label="Clear finished tasks"
          >
            <Trash2 size={12} />
          </Button>
        </div>
      </CardHeader>

      <CardContent className="p-0">
        <ScrollArea className={cn(variant === 'floating' ? 'h-56' : 'max-h-64')}>
          <div className="flex flex-col">
            {tasks.length === 0 && (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground" data-testid="task-empty">
                No export tasks yet.
              </div>
            )}
            {tasks.map((task) => {
              const percent = taskPercent(task);
              const isRunning = task.status === 'running';
              const isFailed = task.status === 'failed';
              return (
                <div
                  key={task.id}
                  className="flex gap-2 border-b border-border px-3 py-2 last:border-b-0"
                  data-testid="task-row"
                >
                  <div
                    className={cn(
                      'mt-0.5 flex-shrink-0',
                      isRunning && 'text-primary',
                      isFailed && 'text-destructive',
                      !isRunning && !isFailed && 'text-success'
                    )}
                    aria-hidden="true"
                  >
                    {isRunning ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : isFailed ? (
                      <AlertTriangle size={13} />
                    ) : (
                      <CheckCircle2 size={13} />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-xs font-medium text-foreground" title={task.label}>
                        {task.label}
                      </span>
                      <span className="flex-shrink-0 text-[10px] uppercase text-muted-foreground">
                        {percent === null ? task.status : `${percent}%`}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                      <span className="truncate">{task.error || task.message}</span>
                      {task.total !== null && task.total !== undefined && (
                        <span className="flex-shrink-0 tabular-nums">
                          {task.processed}/{task.total}
                        </span>
                      )}
                    </div>
                    <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                      <div
                        className={cn(
                          'h-full rounded-full transition-all',
                          isFailed ? 'bg-destructive' : isRunning ? 'bg-primary' : 'bg-success'
                        )}
                        style={{ width: `${percent ?? (isRunning ? 18 : 100)}%` }}
                      />
                    </div>
                    {task.path && (
                      <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground" title={task.path}>
                        {task.path}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
};
