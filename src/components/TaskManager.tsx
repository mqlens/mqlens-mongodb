import React from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Ban, CheckCircle2, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

export interface CopySummaryInfo {
  collectionsCopied: number;
  documentsCopied: number;
  documentsSkipped: number;
  indexesCreated: number;
  skipped: string[];
  failed: { collection: string; error: string }[];
}

export interface ExportTaskInfo {
  id: string;
  kind: string;
  label: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | string;
  processed: number;
  total?: number | null;
  message: string;
  path?: string | null;
  error?: string | null;
  createdAtMs: number;
  finishedAtMs?: number | null;
  subLabel?: string | null;
  itemsProcessed?: number | null;
  itemsTotal?: number | null;
  summary?: CopySummaryInfo | null;
}

interface TaskManagerProps {
  tasks: ExportTaskInfo[];
  onRefresh: () => void;
  onClearFinished: () => void;
  // Resolves false when the cancel request failed, so the button re-enables
  // for a retry. A void return (tests, simple callers) keeps the old behavior.
  onCancel?: (taskId: string) => Promise<boolean> | boolean | void;
  variant?: 'floating' | 'embedded';
}

const taskPercent = (task: ExportTaskInfo) => {
  if (!task.total || task.total <= 0) return null;
  return Math.min(100, Math.round((task.processed / task.total) * 100));
};

// Backend task statuses shown verbatim when unrecognized — the union type
// allows arbitrary strings, so only these four known values get a translation.
const STATUS_LABEL_KEYS: Record<string, string> = {
  running: 'taskManager.status.running',
  completed: 'taskManager.status.completed',
  failed: 'taskManager.status.failed',
  cancelled: 'taskManager.status.cancelled',
};

export const TaskManager: React.FC<TaskManagerProps> = ({
  tasks,
  onRefresh,
  onClearFinished,
  onCancel,
  variant = 'floating',
}) => {
  const { t } = useTranslation('shell');
  const running = tasks.filter((task) => task.status === 'running').length;
  // Ids whose Cancel was clicked — disables the button so a double-click
  // can't race the task's teardown and produce a spurious error.
  const [cancelling, setCancelling] = React.useState<ReadonlySet<string>>(new Set());
  const handleCancelClick = async (taskId: string) => {
    setCancelling((prev) => new Set(prev).add(taskId));
    const ok = await onCancel?.(taskId);
    // A failed cancel re-enables the button so the user can retry.
    if (ok === false) {
      setCancelling((prev) => {
        const next = new Set(prev);
        next.delete(taskId);
        return next;
      });
    }
  };
  // Prune ids whose task is no longer running (finished or gone) so the set
  // doesn't accumulate and a re-run of the same id gets a fresh Cancel button.
  React.useEffect(() => {
    setCancelling((prev) => {
      if (prev.size === 0) return prev;
      const stale = new Set(
        [...prev].filter((id) => !tasks.some((t) => t.id === id && t.status === 'running'))
      );
      if (stale.size === 0) return prev;
      return new Set([...prev].filter((id) => !stale.has(id)));
    });
  }, [tasks]);

  return (
    <Card
      className={cn(
        'flex flex-col overflow-hidden',
        variant === 'floating' && 'fixed bottom-4 right-4 z-40 w-80 shadow-lg',
        variant === 'embedded' && 'mt-4 border-0 shadow-none bg-transparent'
      )}
      data-testid="task-manager"
      aria-label={t('taskManager.ariaLabel')}
    >
      <CardHeader className="flex flex-row items-center justify-between space-y-0 border-b border-border py-2 px-3">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <span>{t('taskManager.header.title')}</span>
          {running > 0 && (
            <Badge variant="secondary" className="text-[10px]">
              {t('taskManager.header.runningBadge', { count: running })}
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
            title={t('taskManager.actions.refreshTasks')}
            aria-label={t('taskManager.actions.refreshTasks')}
          >
            <RefreshCw size={12} />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={onClearFinished}
            title={t('taskManager.actions.clearFinishedTasks')}
            aria-label={t('taskManager.actions.clearFinishedTasks')}
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
                {t('taskManager.empty.noTasks')}
              </div>
            )}
            {tasks.map((task) => {
              const percent = taskPercent(task);
              const isRunning = task.status === 'running';
              const isFailed = task.status === 'failed';
              const isCancelled = task.status === 'cancelled';
              // Copy, dump, and restore tasks support cancellation; exports cannot be cancelled.
              const isCancellable =
                task.kind === 'collection_copy' ||
                task.kind === 'database_copy' ||
                task.kind === 'dump' ||
                task.kind === 'restore';
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
                      isCancelled && 'text-muted-foreground',
                      !isRunning && !isFailed && !isCancelled && 'text-success'
                    )}
                    aria-hidden="true"
                  >
                    {isRunning ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : isFailed ? (
                      <AlertTriangle size={13} />
                    ) : isCancelled ? (
                      <Ban size={13} />
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
                        {percent === null
                          ? STATUS_LABEL_KEYS[task.status]
                            ? t(STATUS_LABEL_KEYS[task.status])
                            : task.status
                          : `${percent}%`}
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
                          isFailed ? 'bg-destructive' : isRunning ? 'bg-primary' : isCancelled ? 'bg-muted-foreground' : 'bg-success',
                          // Indeterminate: no real percent yet — pulse so it reads as
                          // "working", not as progress stuck at a fixed fraction.
                          isRunning && percent === null && 'animate-pulse'
                        )}
                        style={{ width: `${percent ?? (isRunning ? 18 : isCancelled ? 0 : 100)}%` }}
                      />
                    </div>
                    {task.path && (
                      <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground" title={task.path}>
                        {task.path}
                      </div>
                    )}
                    {task.subLabel && (
                      <div className="mt-0.5 truncate text-[10px] text-muted-foreground" title={task.subLabel}>
                        {task.subLabel}
                        {task.itemsTotal
                          ? t('taskManager.row.itemsProgressSuffix', {
                              processed: task.itemsProcessed ?? 0,
                              total: task.itemsTotal,
                            })
                          : ''}
                      </div>
                    )}
                    {task.summary && (
                      <div
                        className="mt-1 text-[10px] text-muted-foreground"
                        title={
                          [
                            ...(task.summary.failed.length > 0
                              ? task.summary.failed.map((f) => `${f.collection}: ${f.error}`)
                              : []),
                            ...(task.summary.skipped.length > 0
                              ? [
                                  t('taskManager.row.summary.skippedTitlePrefix', {
                                    list: task.summary.skipped.join(', '),
                                  }),
                                ]
                              : []),
                          ].join('\n') || undefined
                        }
                      >
                        {t('taskManager.row.summary.copied', { count: task.summary.documentsCopied })}
                        {task.summary.documentsSkipped > 0 &&
                          t('taskManager.row.summary.skippedSuffix', { count: task.summary.documentsSkipped })}
                        {task.summary.indexesCreated > 0 &&
                          t('taskManager.row.summary.indexesSuffix', { count: task.summary.indexesCreated })}
                        {task.summary.failed.length > 0 && (
                          <span className="text-destructive">
                            {t('taskManager.row.summary.failedSuffix', { count: task.summary.failed.length })}
                          </span>
                        )}
                      </div>
                    )}
                    {isRunning && isCancellable && onCancel && (
                      <button
                        type="button"
                        className="mt-1 text-[10px] text-destructive hover:underline disabled:opacity-50 disabled:no-underline"
                        onClick={() => handleCancelClick(task.id)}
                        disabled={cancelling.has(task.id)}
                      >
                        {cancelling.has(task.id)
                          ? t('taskManager.actions.cancelling')
                          : t('taskManager.actions.cancel')}
                      </button>
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
