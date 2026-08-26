import { ListChecks, ScrollText } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatShortcut, shortcutById } from "@/lib/shortcuts";

interface StatusBarProps {
  cpu?: string;
  memory?: string;
  mongoVersion?: string;
  appVersion?: string;
  /** User UI zoom (75–150); hidden at 100%. */
  zoomPercent?: number;
  onZoomReset?: () => void;
  /** Open the dedicated Tasks tab. */
  onOpenTasks?: () => void;
  /** Open the Activity audit log tab. */
  onOpenActivity?: () => void;
  /** Number of currently-running background tasks, shown as a badge. */
  runningTasks?: number;
  className?: string;
}

export function StatusBar({
  cpu,
  memory,
  mongoVersion,
  appVersion,
  zoomPercent,
  onZoomReset,
  onOpenTasks,
  onOpenActivity,
  runningTasks = 0,
  className,
}: StatusBarProps) {
  const showQuickLinks = onOpenTasks || onOpenActivity;
  const { t } = useTranslation('shell');
  const showZoom = zoomPercent != null && zoomPercent !== 100;

  return (
    <footer
      data-testid="bottom-bar"
      className={cn(
        "flex h-6 shrink-0 items-center gap-4 border-t border-border bg-sidebar/80 px-3 text-ui-xs text-muted-foreground mql-chrome",
        className
      )}
    >
      <span className="text-success">{t('statusBar.engineOnline')}</span>
      {cpu && <span>{t('statusBar.cpu', { value: cpu })}</span>}
      {memory && <span>{t('statusBar.ram', { value: memory })}</span>}
      {mongoVersion && <span>{t('statusBar.mongodb', { value: mongoVersion })}</span>}
      {showZoom && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              data-testid="status-bar-zoom"
              className="font-mono tabular-nums transition-colors hover:text-foreground"
              onClick={onZoomReset}
            >
              {zoomPercent}%
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">
            {t('statusBar.resetZoom', { shortcut: formatShortcut(shortcutById('zoom-reset')!) })}
          </TooltipContent>
        </Tooltip>
      )}
      {showQuickLinks && (
        <div className="ml-auto flex items-center gap-3">
          {onOpenActivity && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  data-testid="status-bar-activity"
                  className="flex items-center gap-1 transition-colors hover:text-foreground"
                  onClick={onOpenActivity}
                >
                  <ScrollText size={12} />
                  <span>{t('statusBar.activity')}</span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">{t('statusBar.openActivity')}</TooltipContent>
            </Tooltip>
          )}
          {onOpenTasks && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  data-testid="status-bar-tasks"
                  className="flex items-center gap-1 transition-colors hover:text-foreground"
                  onClick={onOpenTasks}
                >
                  <ListChecks size={12} />
                  <span>{t('statusBar.tasks')}</span>
                  {runningTasks > 0 && (
                    <span className="rounded-full bg-primary px-1.5 text-[10px] font-medium tabular-nums text-primary-foreground">
                      {runningTasks}
                    </span>
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                {runningTasks > 0
                  ? t('statusBar.runningTasks', { count: runningTasks })
                  : t('statusBar.backgroundTasks')}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      )}
      <span className={showQuickLinks ? "" : "ml-auto"}>{t('statusBar.appVersion', { version: appVersion ?? '' })}</span>
    </footer>
  );
}
