import { ListChecks } from "lucide-react";
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
  runningTasks = 0,
  className,
}: StatusBarProps) {
  const showZoom = zoomPercent != null && zoomPercent !== 100;

  return (
    <footer
      data-testid="bottom-bar"
      className={cn(
        "flex h-6 shrink-0 items-center gap-4 border-t border-border bg-sidebar/80 px-3 text-ui-xs text-muted-foreground mql-chrome",
        className
      )}
    >
      <span className="text-success">MQLens Engine Online</span>
      {cpu && <span>CPU {cpu}</span>}
      {memory && <span>RAM {memory}</span>}
      {mongoVersion && <span>MongoDB {mongoVersion}</span>}
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
            Reset zoom ({formatShortcut(shortcutById('zoom-reset')!)})
          </TooltipContent>
        </Tooltip>
      )}
      {onOpenTasks && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              data-testid="status-bar-tasks"
              className="ml-auto flex items-center gap-1 transition-colors hover:text-foreground"
              onClick={onOpenTasks}
            >
              <ListChecks size={12} />
              <span>Tasks</span>
              {runningTasks > 0 && (
                <span className="rounded-full bg-primary px-1.5 text-[10px] font-medium tabular-nums text-primary-foreground">
                  {runningTasks}
                </span>
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">
            {runningTasks > 0 ? `${runningTasks} running task(s)` : "Background tasks"}
          </TooltipContent>
        </Tooltip>
      )}
      <span className={onOpenTasks ? "" : "ml-auto"}>MQLens {appVersion ?? ""}</span>
    </footer>
  );
}
