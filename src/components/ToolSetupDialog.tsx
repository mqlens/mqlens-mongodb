import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Download, Wrench } from 'lucide-react';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ManagedToolStatusUi {
  name: string;
  version: string;
  installed: boolean;
  path: string | null;
}

export interface InstallTaskUi {
  status: string;
  message: string;
  processed: number;
  total: number | null;
}

interface ToolSetupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  statuses: ManagedToolStatusUi[] | null; // null = loading
  installTask: InstallTaskUi | null; // live task, null = not running
  onInstall: (tools: string[], force: boolean) => void | Promise<void>;
  onCancel?: () => void;
  onDone?: () => void; // fired from the Done button; parent re-detects
}

// ─── Styling constants (ImportView idiom) ───────────────────────────────────

const checkboxLabelClassName = 'flex cursor-pointer items-center gap-2 text-sm text-foreground';

// Keys into shell:toolSetupDialog.toolLabels — translated at the call site
// (toolLabel takes `t` as a param since this is a module-level constant/helper
// and can't call the useTranslation hook itself).
const TOOL_LABEL_KEYS: Record<string, string> = {
  'database-tools': 'shell:toolSetupDialog.toolLabels.databaseTools',
  mongosh: 'shell:toolSetupDialog.toolLabels.mongosh',
};

function toolLabel(t: (key: string) => string, name: string): string {
  const key = TOOL_LABEL_KEYS[name];
  return key ? t(key) : name;
}

// ─── Component ───────────────────────────────────────────────────────────────

export const ToolSetupDialog: React.FC<ToolSetupDialogProps> = ({
  open,
  onOpenChange,
  statuses,
  installTask,
  onInstall,
  onCancel,
  onDone,
}) => {
  const { t } = useTranslation('shell');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lastSubmitted, setLastSubmitted] = useState<{ tools: string[]; force: boolean } | null>(
    null
  );
  // True while the start-install call is in flight, so a double-click can't
  // fire a second install before the first one registers a task.
  const [starting, setStarting] = useState(false);
  // Once the install task reaches a terminal state, keep a local snapshot so
  // losing the store entry (e.g. "Clear finished" in the Task Manager) doesn't
  // silently reset the dialog to the checklist with stale statuses.
  const [taskSnapshot, setTaskSnapshot] = useState<InstallTaskUi | null>(null);
  useEffect(() => {
    if (installTask && installTask.status !== 'running') {
      setTaskSnapshot(installTask);
    }
  }, [installTask]);
  useEffect(() => {
    if (!open) setTaskSnapshot(null);
  }, [open]);
  const task = installTask ?? taskSnapshot;

  // Default selection: every NOT-installed tool, re-derived whenever the dialog
  // opens or fresh statuses arrive.
  useEffect(() => {
    if (open && statuses) {
      setSelected(new Set(statuses.filter((s) => !s.installed).map((s) => s.name)));
    }
  }, [open, statuses]);

  const toggle = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  };

  const selectedInstalledTools = (statuses ?? []).filter(
    (s) => selected.has(s.name) && s.installed
  );
  const willReinstall = selectedInstalledTools.length > 0;

  // Only holds the button in a "Starting…" state when onInstall is actually
  // async (the app's start_tool_install_task invoke); a sync handler resolves
  // immediately and never disables anything.
  const submitInstall = (tools: string[], force: boolean) => {
    if (starting) return;
    const result = onInstall(tools, force);
    if (result && typeof result.then === 'function') {
      setStarting(true);
      void result.finally(() => setStarting(false));
    }
  };

  const handleInstall = () => {
    const tools = Array.from(selected);
    if (tools.length === 0) return;
    const force = willReinstall;
    setLastSubmitted({ tools, force });
    submitInstall(tools, force);
  };

  const handleRetry = () => {
    if (lastSubmitted) {
      submitInstall(lastSubmitted.tools, lastSubmitted.force);
    }
  };

  const isRunning = task?.status === 'running';
  const isFailed = task?.status === 'failed';
  const isCancelled = task?.status === 'cancelled';
  const isCompleted = task?.status === 'completed';
  const showChecklist = task === null;

  const percent =
    isRunning && task && task.total !== null && task.total > 0
      ? Math.min(100, Math.round((task.processed / task.total) * 100))
      : null;
  const indeterminate = isRunning && percent === null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]" data-testid="toolsetup-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wrench className="h-4 w-4" />
            {t('toolSetupDialog.title')}
          </DialogTitle>
        </DialogHeader>

        {showChecklist && statuses === null && (
          <div className="flex flex-col gap-2 py-6 text-center text-sm text-muted-foreground">
            {t('toolSetupDialog.checkingTools')}
          </div>
        )}

        {showChecklist && statuses !== null && (
          <div className="flex flex-col gap-4 py-2">
            <p className="text-xs text-muted-foreground">
              {t('toolSetupDialog.intro')}
            </p>

            <div className="divide-y divide-border rounded-md border border-border">
              {statuses.map((tool) => (
                <section key={tool.name} className="flex flex-col gap-1.5 px-3.5 py-3">
                  <label className={checkboxLabelClassName}>
                    <input
                      type="checkbox"
                      checked={selected.has(tool.name)}
                      onChange={() => toggle(tool.name)}
                      data-testid={`toolsetup-check-${tool.name}`}
                    />
                    <span className="font-medium">{toolLabel(t, tool.name)}</span>
                    {tool.installed && (
                      <span className="text-xs text-muted-foreground">{t('toolSetupDialog.installedBadge')}</span>
                    )}
                  </label>
                  <p
                    className="ml-6 text-xs text-muted-foreground"
                    data-testid={`toolsetup-version-${tool.name}`}
                  >
                    v{tool.version}
                    {tool.path ? t('toolSetupDialog.pathSuffix', { path: tool.path }) : ''}
                  </p>
                </section>
              ))}
            </div>

            {willReinstall && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                {t('toolSetupDialog.reinstallWarning')}
              </p>
            )}

            <p className="text-xs text-muted-foreground" data-testid="toolsetup-size-note">
              {t('toolSetupDialog.sizeNote')}
            </p>
            <p className="text-xs text-muted-foreground" data-testid="toolsetup-license-note">
              {t('toolSetupDialog.licenseNote')}
            </p>
          </div>
        )}

        {isRunning && task && (
          <div className="flex flex-col gap-3 py-2">
            <p className="text-sm text-foreground" data-testid="toolsetup-stage">
              {task.message}
            </p>
            <div
              role="progressbar"
              data-testid="toolsetup-progress"
              data-indeterminate={indeterminate ? 'true' : 'false'}
              aria-valuenow={percent !== null ? percent : undefined}
              aria-valuemin={0}
              aria-valuemax={100}
              className="h-2 w-full overflow-hidden rounded-full bg-muted"
            >
              <div
                className={cn(
                  'h-full rounded-full bg-primary transition-all',
                  indeterminate && 'w-1/3 animate-pulse'
                )}
                style={percent !== null ? { width: `${percent}%` } : undefined}
              />
            </div>
          </div>
        )}

        {isFailed && task && (
          <div className="flex flex-col gap-3 py-2">
            <p className="text-sm text-destructive" data-testid="toolsetup-error">
              {task.message}
            </p>
          </div>
        )}

        {isCancelled && task && (
          <div className="flex flex-col gap-3 py-2">
            <p className="text-sm font-medium text-foreground" data-testid="toolsetup-cancelled-heading">
              {t('toolSetupDialog.cancelled')}
            </p>
            <p className="text-sm text-muted-foreground" data-testid="toolsetup-error">
              {task.message}
            </p>
          </div>
        )}

        {isCompleted && task && (
          <div className="flex flex-col gap-3 py-2">
            <p className="text-sm text-foreground">{task.message}</p>
          </div>
        )}

        <DialogFooter>
          {showChecklist && statuses !== null && (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t('common:cancel')}
              </Button>
              <Button
                onClick={handleInstall}
                disabled={selected.size === 0 || starting}
                data-testid="toolsetup-install-btn"
              >
                <Download className="mr-2 h-4 w-4" />
                {starting ? t('toolSetupDialog.actions.starting') : t('toolSetupDialog.actions.install')}
              </Button>
            </>
          )}
          {isRunning && (
            <Button
              variant="outline"
              onClick={() => onCancel?.()}
              data-testid="toolsetup-cancel-btn"
            >
              {t('common:cancel')}
            </Button>
          )}
          {isFailed && (
            <Button onClick={handleRetry} disabled={starting} data-testid="toolsetup-retry-btn">
              {t('toolSetupDialog.actions.retry')}
            </Button>
          )}
          {isCancelled && (
            <>
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                data-testid="toolsetup-dismiss-btn"
              >
                {t('toolSetupDialog.actions.dismiss')}
              </Button>
              <Button onClick={handleRetry} disabled={starting} data-testid="toolsetup-retry-btn">
                {t('toolSetupDialog.actions.retry')}
              </Button>
            </>
          )}
          {isCompleted && (
            <Button onClick={() => onDone?.()} data-testid="toolsetup-done-btn">
              {t('toolSetupDialog.actions.done')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
